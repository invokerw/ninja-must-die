#!/usr/bin/env node
/* Pure Node.js PNG -> layered PSD pipeline and review server.
 * The active recursive workflow re-analyzes the currently repaired plate on
 * every loop so newly exposed layers receive fresh bbox/description context.
 * Foreground extraction normally comes from GPT Image 2.5 Flare max. Gemini's per-bbox
 * route can send a fully visible source crop directly to FeyNobg and skip
 * image generation when conventional matting is sufficient.
 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const { normalizeRetryPolicy, createJobRetryController, withJobRetryPolicy, hasJobRetryPolicy, retryJobOperation } = require("./job_retry.js");
const sharp = require("sharp");
const { placeModelRgba, preserveModelAspect } = require("./bbox_model_rgba.js");
const { detectTextAtlasRegions } = require("./bbox_text_atlas.js");
const { visualAtlasColumns, inspectVisualCrops, assertVisualCrops } = require("./bbox_visual_atlas.js");
const OpenAI = require("openai");
const {loadConfig,getRoute,modelFor,qualityFor,normalizeBase,publicConfig}=require("./model_config.js");
const { writePsdBuffer } = require("ag-psd");
const { jsonrepair } = require("jsonrepair");
const { applyStepUpdate, finishRunTiming, timingSnapshot } = require("../web/run-timing.js");

// Keep local development credentials in .env.local while making the review
// server work regardless of whether it was launched from cmd, PowerShell, or
// the web shortcut.
// model_config.js owns local config and compatibility environment loading.
loadConfig();

const ROOT = path.resolve(
  process.env.LAYER_REVIEW_ROOT || path.join(__dirname, "..", "..", ".."),
);
const WEB_ROOT = path.join(__dirname, "..", "web");
const IMAGE_SUFFIXES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
]);
// Legacy runs may still contain these files. Keep them out of the web report
// so the UI no longer advertises the removed soft-fusion/original-input path.
const HIDDEN_BACKGROUND_ARTIFACTS = new Set([
  "background_soft_mask.png",
  "background_mask_alpha.png",
  "background_mask_work.png",
]);
function isHiddenBackgroundArtifact(file) {
  return HIDDEN_BACKGROUND_ARTIFACTS.has(
    path.basename(String(file || "")).toLowerCase(),
  );
}
const ALLOWED = new Set([
  "background",
  "panel",
  "card",
  "button",
  "text",
  "icon",
  "badge",
  "line",
  "character",
  "illustration",
  "decoration",
  "other",
]);
const SVG_KIND_ALIASES = new Map([
  ["container", "panel"],
  ["surface", "panel"],
  ["row", "card"],
  ["slot", "card"],
  ["tab", "button"],
  ["control", "button"],
  ["foreground", "illustration"],
]);
const FOREGROUND = new Set(
  [...ALLOWED].filter((x) => !["background", "text"].includes(x)),
);
const BBOX_CONTROLLER_MODELS = new Set(publicConfig().controller_models);
const DEFAULT_BBOX_CONTROLLER_MODEL = modelFor('controller');
const GPT_IMAGE_25_FLARE_MODEL = modelFor('segmentation');
const GPT_IMAGE_25_SUNBURST_MODEL = modelFor('background');
const DEFAULT_IMAGE_MODEL = modelFor('foreground');
const IMAGE_GENERATION_QUALITY = qualityFor('image');
const FOREGROUND_ATLAS_QUALITY = qualityFor('foreground');
const TEXT_REPAIR_QUALITY = qualityFor('background');
const BACKGROUND_REPAIR_QUALITY = qualityFor('background');
const BBOX_VISION_MAX_SIDE = Math.max(
  512,
  Math.min(1536, Number(process.env.BBOX_VISION_MAX_SIDE) || 768),
);
const BBOX_VISION_JPEG_QUALITY = 84;
const BBOX_BATCH_CONCURRENCY = 7;
const BBOX_SINGLE_MAX_COMPLETION_TOKENS = Math.max(
  4096,
  Number(process.env.BBOX_SINGLE_MAX_COMPLETION_TOKENS) || 8192,
);
const BBOX_BATCH_MAX_COMPLETION_TOKENS = Math.max(
  4096,
  Number(process.env.BBOX_BATCH_MAX_COMPLETION_TOKENS) || 8192,
);
const JOBS = new Map();
const RESTARTING_OUTPUTS = new Set();

// Workspace isolation is deliberately explicit and stateless.  The browser
// sends the account name on every API request; the server never creates a
// cookie or a session.  Account names are only used as safe directory keys.
const DEFAULT_WORKSPACE_ACCOUNT = "default";
function normalizeWorkspaceAccount(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_WORKSPACE_ACCOUNT;
  const safe = value
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+$/, "")
    .slice(0, 64);
  return safe || DEFAULT_WORKSPACE_ACCOUNT;
}
function requestWorkspaceAccount(req) {
  return normalizeWorkspaceAccount(req.headers["x-workspace-account"]);
}
function accountRunsRoot(account) {
  return path.join(ROOT, "web_runs", "accounts", normalizeWorkspaceAccount(account));
}
function accountSourcesRoot(account) {
  return path.join(ROOT, "workspace_sources", normalizeWorkspaceAccount(account));
}
function assertSourceAccess(file, account) {
  const sourcesRoot = path.join(ROOT, "workspace_sources");
  if (isInside(file, sourcesRoot) && !isInside(file, accountSourcesRoot(account)))
    throw new Error("source not found");
}
function isInside(child, parent) {
  const childPath = path.resolve(child);
  const parentPath = path.resolve(parent);
  return childPath === parentPath || childPath.startsWith(parentPath + path.sep);
}
function assertProjectAccess(dir, account) {
  const requested = path.resolve(dir);
  const runsRoot = path.join(ROOT, "web_runs");
  const accountRoot = accountRunsRoot(account);
  if (isInside(requested, runsRoot) && isInside(requested, path.join(runsRoot, "accounts"))) {
    if (!isInside(requested, accountRoot)) throw new Error("project not found");
    return;
  }
  if (!isInside(requested, runsRoot)) return;
  const planPath = path.join(requested, "recursive_layer_plan.json");
  if (!fs.existsSync(planPath)) throw new Error("project not found");
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const owner = plan.workspace_account
      ? normalizeWorkspaceAccount(plan.workspace_account)
      : DEFAULT_WORKSPACE_ACCOUNT;
    if (owner !== normalizeWorkspaceAccount(account))
      throw new Error("project not found");
  } catch (error) {
    if (error?.message === "project not found") throw error;
    throw new Error("project not found");
  }
}

const BBOX_CANDIDATE_PROMPT = `Draw thin, bright red, axis-aligned rectangles around every visible visual element that could become an independent image layer in a layered PSD. Include panels, cards, button or navigation-row background surfaces, every visible icon even when it is printed inside a button or navigation row, badges, characters, item illustrations, decorations, and every visible text region. For a navigation item, draw separate rectangles for (1) the complete button/row background surface, (2) its icon, and (3) its text. Each rectangle must cover the complete visible object, including its full outline, glow, cast shadow, feathers, spikes, soft edges, and decorative strokes, with a modest 8-12 pixel safety margin when it does not touch a neighboring object. Do not clip an object to its visible core. Preserve the original screenshot exactly underneath the red annotations. Do not crop, resize, recompose, remove, or redraw any content. Return only the annotated screenshot.`;
const BBOX_COMPACT_FORMAT_GUIDANCE = `Return only JSON using this compact wire format to reduce output tokens. Do not use verbose keys such as canvas, boxes, bbox, parent_id, or z_index. Top-level keys: c=[width,height], s=scene summary, r=[background_repair_mode,reason], b=boxes, f=front_to_back ids, q=root ids. Each b item MUST use the short keys i=id, k=category, b=[x,y,width,height], p=nearest parent id or null, z=z_index, m=element_repair_mode, r=role, and a=remove_by_matte (1 or 0). Optional keys are l=actual visible label/text content (not a generic description), o=occludes ids, u=occluded_by ids, g=geometry hints, t=short reason, h=short matte-routing reason, v=1 visible, c=confidence. For k=text, also return tx=exact OCR text, fs=estimated font size in original image pixels, fc=[r,g,b] fill color sampled from glyph interiors, fn=font family/style suggestion (use a font available on the target Photoshop machine; for Chinese Han text prefer SimSun or SimHei, for Japanese prefer MS-Gothic, and use ArialMT only for Latin text), bd=1 when bold, it=1 when italic, and al=left|center|right. These text properties are estimates and must be conservative. The backend fills omitted optional fields and expands this wire format into the full editor schema. A geometry hint in g is [bbox_norm,[positive_points_norm],[negative_points_norm]]. Keep labels and reasons under four words except tx, which must preserve the complete readable text.`;
const BBOX_COMPACT_SCHEMA = `{"c":[IMAGE_WIDTH,IMAGE_HEIGHT],"s":"short scene","r":["scene|surface|none","short evidence"],"b":[{"i":"id","k":"panel|card|button|text|icon|badge|character|illustration|decoration|other","b":[x,y,width,height],"p":null,"z":0,"m":"image|surface|none","r":"container|surface|button|foreground|decoration|text","a":0,"h":"short matte reason","tx":"visible text when k=text","fs":24,"fc":[255,255,255],"fn":"ArialMT","bd":0,"it":0,"al":"left"}],"f":["id"],"q":["id"]}`;
const MATTE_ROUTING_GUIDANCE = `For every bbox set a=1 only when a conventional foreground matting model can remove the surrounding pixels from the original bbox crop without inventing or reconstructing any part of the target. Good a=1 candidates are fully visible characters, item illustrations, icons, badges, or decorations with a complete, visually separable silhouette. Set a=0 for any panel, card, slot, row, button or other UI surface; text; translucent glow, light, ring, smoke or soft effect; a target whose wanted pixels merge with its background; or any object that is partially hidden, cut off, or overlapped and therefore needs image-model reconstruction. The decision is about direct source-crop matting, not semantic importance. Put a short reason in h.`;
const COMPACT_DIRECT_BBOX_PROMPT = `Analyze the attached game UI screenshot directly and return every visible independently useful image/UI element as a compact bbox map. The attached image is the only pixel ground truth.
Rules: one physical panel, dialog, card, slot, row, button, icon, badge, character or illustration is one bbox; never fragment a parent into exposed strips. Trace each visible outer boundary from the pixels instead of inferring a generic grid rectangle. Parent surfaces cover their complete visible outer contour and may be slightly loose with a 4-8 px safety margin on this analysis image (roughly 8-16 px on the original), never clipped and never expanded into an adjacent blank gutter. Repeated instances are separate. A navigation/button surface, its visible icon, and its text are separate objects; text boxes enclose glyphs only, while a bounded counter/badge backplate is a separate badge box. Do not emit the full-screen background, gaps, shadows, or duplicate composites. Set p to the nearest direct material parent, z back-to-front, and choose m=image for textured/gradient/glowing materials, m=surface for flat materials, or m=none for topmost objects. Include ordinary text as k=text metadata; it is never a PSD image layer. Include f front-to-back ids for non-text elements and q root ids. Do not return markdown.
${MATTE_ROUTING_GUIDANCE}
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const BBOX_ANALYSIS_PROMPT = `The first attached image is the original screenshot and is the only pixel-level ground truth. The second image is an image-model red-box proposal; it may be wrong, incomplete, duplicated, or shifted. Correct it by inspecting the original. Return every visible, independently useful image/UI element as an axis-aligned bbox in original pixel coordinates.
Boxes must cover the complete visible object, not just its solid center: include the full outline, glow, cast shadow, feathers, spikes, soft antialiased edges, and decorative strokes. Leave a modest 8-12 pixel safety margin around an object when that margin does not swallow a neighboring object or unrelated UI surface. A box may be slightly loose; never clip a visible part to make it tight.
Return ONLY this JSON object. IMAGE_WIDTH and IMAGE_HEIGHT mean the exact attached analysis-image dimensions stated after this prompt.
${MATTE_ROUTING_GUIDANCE}
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
// This block is the LLM planning section from the referenced article. It is
// kept verbatim in English so future prompt edits cannot silently change the
// article's material/repair semantics. The final paragraph is the one
// project-specific override requested for this PSD.
const ARTICLE_LAYER_PLANNER_GUIDANCE = `Analyze a game UI and return a compact executable layer plan.
Two images are provided in this order: (1) the original image, (2) an OCR-cleaned working image.
OCR regions are listed with stable ids below. First classify their rendering mode:
- ordinary readable UI copy (labels, values, hints, button captions) remains editable text;
- a logo, wordmark or decorative display lettering whose irregular shape, multicolor fill, thick
  custom outline, embedded mascot/icon or hand-drawn geometry is part of its identity must remain
  a raster image asset. Put only those OCR ids in raster_text_ids.
Do not classify text as raster merely because it is bold, outlined or placed on a button. A normal
font that can be acceptably recreated as text must stay editable. This is a rendering decision, not
an OCR-confidence decision.

The cleaned image initially has all OCR glyphs removed. For each raster_text_id, also emit exactly
one non-text query (prefer kind=logo, role=foreground) using its location in the original image.
The pipeline will restore that artwork before segmentation. Never emit ordinary text as a query.

Find all visible non-text assets that should be independently editable:
- large panels, boards, frames and dialogs whose exposed material/boundary is visible;
- every repeated card, slot, tab or row surface as a separate geometry hint;
- complete action/navigation buttons as one object, including any integrated icon shape;
- independent icons, item artwork, portraits, silhouettes and framed illustrations;
- badges, ribbons, locks, counters and grouped status markers with their own visible shape.

Do not emit the full-screen background, ordinary text, shadows, gaps, separators, speculative objects,
duplicate composite descriptions, or people/props inside one framed illustration. A parent surface
and its foreground child must be separate only when both are real editable assets. Repeated instances
share one query but each instance needs its own hint.

Every hint is passed directly to segmentation:
- bbox_norm=[x0,y0,x1,y1] tightly encloses exactly one instance, normalized to 0..1;
- positive_points_norm has 1-3 points on solid target pixels, not edges, holes or background;
- negative_points_norm is empty unless a real competing object is near/inside the box; when used,
  put 1-2 points on that competitor, never on an overlaid child of an underlying surface;
- inspect each repeated instance separately. Do not mechanically copy relative point positions.
- z_order is back-to-front. Parent surfaces must have a lower z_order than their children.
- parent_query_id is required for every element visually carried by another exported element.
  Use the nearest direct material parent, not merely the largest outer panel: artwork, silhouette,
  badge or label inside a card belongs to that card; the card belongs to its panel. Leave it null
  only for true root elements. This parent chain is exported and also controls occlusion repair.

For every query choose one element_repair_mode:
- "image" for a textured, patterned, illustrated, translucent or gradient-bearing parent material
  whose child elements must later be removed and reconstructed by the image model;
- "surface" only for a nearly uniform flat-colour material that can be reconstructed from measured
  neighbouring pixels;
- "none" for a topmost foreground object or an object with no meaningful material behind its children.
This is a material decision. A panel/card/frame with artwork, glow or visible texture is "image".

Choose one background_repair.mode for the pixels hidden by the extracted UI:
- "scene": the hidden area is a real textured/illustrated scene and should be reconstructed from
  the visible scene boundary. The repair image will contain only a black diagnostic hole plus a
  very narrow softened edge; do not rely on a generated prefill.
- "surface": the hidden area is visually close to a uniform or translucent colour/material. Use
  measured boundary colour/low-frequency continuation only; do not invent scenery or texture.
- "none": do not synthesize hidden pixels; preserve the current cleaned background.
Select from the image evidence, not from the number of detected layers.

Project-specific override for this PSD: a navigation/button background, its visible icon, and its
text are separate editable objects. Emit the complete background as category=button, each icon as
category=icon with parent_id set to that button, and text as category=text.`;
const DIRECT_BBOX_ANALYSIS_PROMPT = `Analyze this game UI screenshot and return a compact executable layer plan. The attached original image is the only pixel-level ground truth.

${ARTICLE_LAYER_PLANNER_GUIDANCE}

Find all visible assets that should be independently editable:
- large panels, boards, frames and dialogs whose exposed material or outer boundary is visible;
- every repeated card, slot, tab or row surface as a separate instance;
- each complete action or navigation button background as one object, with its visible icon as a separate child;
- independent icons, item artwork, portraits, silhouettes and framed illustrations;
- badges, ribbons, locks, counters and grouped status markers with their own visible shape;
- ordinary readable UI text as category=text so it can be removed later. Text is metadata only and never becomes a PSD image layer.

Element identity and bbox rules:
1. One physical UI element produces exactly one bbox. Do not fragment a panel, dialog, card or button into its exposed strips, rows, corners or visible patches.
2. A structural parent surface must use one bbox covering its complete visible outer contour and full design footprint, even when children, text, icons, another panel or a character overlap it. Occlusion changes relationships, not the parent's bbox.
3. For example, a large framed information panel containing several rows is one panel bbox around the entire outer frame; its icons, buttons and text may be separate children. Never emit each exposed band of that panel as a different panel.
4. A parent surface and a foreground child are separate only when both are real editable assets. Use parent_id for the nearest direct material parent: artwork or a badge inside a card belongs to that card; the card belongs to its panel.
5. Repeated cards, slots and buttons are separate boxes for each instance. Do not merge neighboring instances.
6. Split a button or navigation item into independent editable objects: return one complete category=button bbox for its background surface, plus a separate category=icon bbox for every visible icon printed inside it. Set the icon parent_id to the button. Text remains a separate category=text bbox. Do not include icon or glyph pixels when deciding the button surface boundary; the button bbox still follows the complete visible outer contour of its background.
7. Each bbox is [x,y,width,height] in attached analysis-image pixels. Trace the actual visible boundary and cover the full outline, frame, glow, soft antialiased edge, cast shadow and pointed decoration. Add only a modest 4-8 px analysis-image safety margin where it does not swallow a neighboring element or blank gutter. Slightly loose is acceptable; clipping a visible edge is not.
8. z_index is back-to-front: parent surfaces have a lower z_index than their children. Use parent_id and front_to_back as the primary occlusion plan. Only fill occludes/occluded_by for direct, visually certain overlaps; do not emit redundant transitive relationships. The backend will complete the direct parent-child relationship.
9. Keep independently editable overlapping objects in separate bboxes. Determine their front_to_back order from visible occlusion boundaries, continuous edges and translucent overlays in THIS image. Add only direct overlap relationships supported by those pixels. Never combine a foreground object with an independently visible deeper object into an enclosing composite bbox, and never assign depth from a fixed object type or screen position.
10. Text is always separate from the image surface behind it. A category=text bbox tightly encloses glyph pixels only with a 1-2 px antialiasing margin. If the text is printed on a bounded badge, pill or counter chip, also emit that complete backplate as category=badge and set the text parent_id to the badge.

Do not emit the full-screen background, standalone shadows, gaps, separators, speculative hidden objects, duplicate composite descriptions, or people/props inside one framed illustration. Do not infer an element from layout alone when no material or boundary is visible.

Choose element_repair_mode by material: image for textured, patterned, illustrated, translucent, gradient or glowing parent material; surface only for a nearly uniform flat-colour surface; none for a topmost foreground object or an object with no meaningful material behind its children.

Return ONLY this JSON object and no markdown. IMAGE_WIDTH and IMAGE_HEIGHT mean the exact attached analysis-image dimensions stated after this prompt:
${MATTE_ROUTING_GUIDANCE}
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const INITIAL_TEXT_BBOX_PROMPT = `Analyze the attached game UI screenshot only for ordinary removable UI text glyphs. Return every ordinary label, title, caption, number, quantity, currency value, button caption, navigation label, and short description as a separate category=text bbox. The text bbox must enclose the actual visible glyph pixels with a modest 2-4 pixel margin on the attached analysis image; use the top-left x/y of the ink, not a typographic baseline, line center, or guessed text-cell position. Measure the box against the pixels in this image and include the complete line through its final glyph, including descenders and antialiased edges. Do not place a description box on the row above or below the glyphs. Do not include the button, card, panel, slot, badge, pill, circle, glow, icon, or background behind the glyphs. A multi-character phrase on one line is one bbox. A number in a card's lower-right corner is one bbox for the digits only.

Art-lettering exclusion: lettering is NOT ordinary text when it is fused with an illustration, emblem, logo, crest or icon and the graphic crosses through, surrounds, replaces part of, or materially overlaps the glyphs. A crossed-out A/S emblem inside a circular badge is one image object, not text. Likewise keep a decorative wordmark as image artwork when removing the letters would destroy the identity or silhouette of the graphic. Emit no text bbox for such fused artistic lettering; the later visual pass must receive the entire artwork as one icon, badge or illustration. Outlines, shadows or a decorative font alone do not make an otherwise independent UI label into artwork.

Do not return any non-text object, backplate or full-screen region. Text is never sent to FeyNobg, so set a=0 for every returned text bbox. Return only compact JSON and no markdown.
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const TOP_LAYER_BBOX_PROMPT = `Analyze the attached current working image for the next recursive extraction pass. All ordinary removable UI text has already been removed before this image was attached. Any remaining lettering fused with an emblem, logo, crest, badge or illustration is image artwork: keep the complete combined graphic as one icon, badge or illustration, including all of its lettering. Report independently editable frontmost objects for extraction and any independently visible objects directly behind them as depth references. Mark the deeper objects with occluded_by pointing to their foreground blockers; the backend extracts only unoccluded objects in this pass.
Frontmost-layer rule: if an image object lies on top of a card, panel, button, row, or other material, return the foreground object only for this pass. Also report an independently visible object immediately behind it with occluded_by set to the foreground id; the backend defers that object to the next pass. Never merge the two into a composite target. If several unrelated objects are equally frontmost, return each one separately. Include only the foreground object's OWN visible outline, antialiased edge, attached glow, soft shadow and pointed decoration with a modest 8-16 pixel margin on the original canvas. A separately bounded light effect, ring, artwork or backplate that continues visibly outside or behind the object is independent even when their pixels overlap; give it its own bbox and direct depth relationship. For a small corner badge, status marker, counter chip, or upgrade arrow, the bbox must contain only that marker's own backplate and glyph; exclude other independent objects visible behind or beside it, even when they touch or overlap. Infer front_to_back from visible occlusion boundaries and translucent overlays. Keep independent components separate; do not infer a fixed depth order from labels or location.
Mandatory eligibility test: a surface whose bbox contains or is visibly covered by another independent icon, item artwork, badge, character, or control is a deferred depth reference, never a current extraction target. Report it separately with occluded_by set to the covering object. On an inventory screen, extract item artworks, equipment illustrations, lock, status markers, currency icons, independent controls and characters before their slot/card backgrounds, sidebar row backgrounds, dropdown background, detail panel or inventory panel. A card or slot carrying a visible item is NEVER in the same frontmost pass as that item. A sidebar icon is the current foreground object; its row/button background waits for a later pass. Do not label a whole item slot as foreground merely because its border is visible around the item.
Control decomposition audit: inspect EVERY visible control, including top resource bars, side controls and bottom navigation. A resource bar with a separate plus control, currency/energy emblem and bar surface has three distinct bboxes; add any other independently bounded parts separately. Each button tile has a bbox for its icon/artwork and a different bbox for its backplate, even when the icon is centered inside it. A badge or lock overlapping that tile is another object. Repeat this for every instance, not just the first example. An icon bbox follows its own silhouette and must not enclose the entire button or bar. A backplate bbox follows its complete surface, not merely its exposed strips; set its u to the foreground icon ids and each icon's p to the backplate id. Never substitute a single whole-control bbox for these objects. Before returning JSON, check that every visible icon, plus mark, currency emblem and button backplate has its own entry.
Same-pass geometry audit: independently extracted foreground bboxes must not overlap each other. If two complete object bboxes intersect because one object covers another, keep both complete and put the rear object in u/occluded_by of the front object so they are extracted in different passes. Do not crop the rear object's bbox to remove the overlap, and do not add margin across a neighboring object. Use f/front_to_back in actual visual order; never claim that overlapping front and rear objects are both current foreground roots.
Scene-only termination rule: when the current image is now a continuous full-canvas illustrated scene/background and no independent HUD, UI control, character, or item remains, return b=[] and set r=["scene","scene-only terminal background"]. Environmental parts of that same scene are background material, not editable foreground layers, even when visually bounded. Never return terrain, cave walls, altar, pedestal, platform, rocks, plants, grass, mushrooms, flowers, water, sky, lighting, landscape ornaments, or other scenery in this terminal state.
For each object use category=icon, badge, button, character, illustration, decoration, card, panel, or other; use role=foreground only for uncovered objects and role=surface for deferred backplates. Set a=0 for button/panel/card surfaces and a=1 only for fully separable foreground silhouettes. Keep labels and reasons under four words. Return only compact JSON and no markdown.
${MATTE_ROUTING_GUIDANCE}
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const BOTTOM_UP_BBOX_PROMPT = `Analyze the attached current cleaned UI image and return a compact executable layer map for a bottom-up repair pass. Text has already been removed. Return all visible non-text visual objects that are useful as independent image layers, including panels, cards, slots, buttons, icons, badges, characters, illustrations and decorations. Do not return ordinary text, the full-screen background, gaps, shadows or duplicate composites.
The purpose of this pass is to find the deepest object that is currently covered by another visible object. Preserve one physical object per bbox and trace its complete visible outer footprint with a modest 8-16 pixel original-canvas safety margin. Repeated instances are separate. Set occluded_by to the ids of objects visibly in front of this object, and set z_index back-to-front (larger means farther behind). Set parent_id to the nearest direct material parent. If an object is not covered, leave occluded_by empty. Include a short human-readable label l and a short reason t for each object; these descriptions will be given to GPT Image 2 when reconstructing the deepest objects. Return only compact JSON and no markdown.
${MATTE_ROUTING_GUIDANCE}
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const BOTTOM_UP_REVIEW_PROMPT = `Review the attached current cleaned UI image for a bottom-up repair pass. Text has already been removed. The first-pass candidates below are the only objects under review; this is not a discovery pass. Return exactly one item for every candidate, preserving its id, category, label, z-index and occlusion relationships. Do not add, remove, merge, split or rename objects. Correct a candidate bbox only when the pixels clearly show that it clips the same complete object or includes a neighboring object. Keep a modest 8-16 pixel original-canvas safety margin and never shrink to the solid core. Return only compact JSON and no markdown.
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const BOTTOM_UP_COMPLETE_PROMPT = `Image repair task, phase A. Black holes mark the deepest occluded image elements. Target tuples are [id,bbox,description,occluded_by]. Reconstruct only those targets in place using visible fragments, nearby material, symmetry and repeated UI patterns. Preserve every non-hole pixel and all overlapping foreground objects exactly. Do not change canvas size, scale, layout or unrelated colors. Do not add text or new UI. Return one image at the input dimensions.`;
const BOTTOM_UP_REMOVE_PROMPT = `Image repair task, phase B. Black holes are where completed layer A was removed. Reconstruct only the material behind those holes from nearby pixels. Preserve every non-hole pixel and remaining foreground UI exactly. Do not recreate the removed targets, add text or add new UI. Return one image at the input dimensions.`;
const BBOX_BATCH_SCHEMA = `${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;
const BBOX_BATCH_SYSTEM_PROMPT =
  "You are a pixel-accurate game-UI bbox annotator. Return compact JSON only and preserve whole-element identity.";
const BBOX_BATCH_OVERVIEW_PROMPT = `Analyze the complete attached UI preview for large structural layers only.
${ARTICLE_LAYER_PLANNER_GUIDANCE}
Return at most 12 boxes: large panels, boards, dialogs, frames, major standalone characters or illustrations, and large controls whose complete outer contour is visible. Include a parent surface as one complete bbox even when children overlap it. Exclude ordinary text, repeated cards or slots, small icons, badges, separators, shadows, and the full-screen background. Do not fragment a large panel into exposed strips.
Each bbox must include the complete visible outline, glow, shadow, and decoration with a modest safety margin. Use attached-image pixel coordinates. Keep reason under eight words.
Return only this JSON shape with the numeric canvas dimensions given below:
${BBOX_BATCH_SCHEMA}`;
const BBOX_BATCH_DETAIL_PROMPT = `Analyze the complete attached UI preview for detailed IMAGE elements inside the ownership ROI specified below.
${ARTICLE_LAYER_PLANNER_GUIDANCE}
Return every visible element whose bbox center lies inside the ownership ROI, up to 18 boxes. The entire image remains visible so objects crossing the ROI boundary must still use their complete visible outer contour. Neighboring ROIs intentionally overlap; duplicate detections will be merged by the backend.
Include each repeated card, slot, tab, row surface, complete button background, visible icon, item artwork, non-text badge surface, counter backplate, and grouped status marker separately. One physical element produces one bbox. Do not merge neighboring instances. A button or navigation item and the icon printed inside it are TWO editable image objects: emit the complete button/row background as category=button and emit every visible icon inside it as a separate category=icon whose parent_id points to that button. This applies especially to sidebar navigation icons such as flask, sword, leaf, scroll, grid, backpack, filter, plus, and close icons. Do NOT emit category=text in this pass; a dedicated text audit handles glyphs and their backplates. Exclude the full-screen background, standalone shadows, separators, and large structural parent surfaces; the overview batch handles large parents.
Use full attached-image pixel coordinates. Include full outlines, glows, shadows, soft edges, and a modest 8-12 pixel safety margin without swallowing neighbors. Keep reason under eight words.
Return only this JSON shape with the numeric canvas dimensions given below:
${BBOX_BATCH_SCHEMA}`;
const BBOX_BATCH_TEXT_PROMPT = `Analyze the complete attached UI preview only for visible TEXT and text-bearing BACKPLATES inside the ownership ROI specified below.
Return every readable text region whose bbox center lies inside the ownership ROI. This includes navigation labels, titles, captions, numbers, currency values, item counts, button labels, and short descriptions. Do not omit text merely because it is printed inside a button, card, row, panel, or badge.

Critical separation rules:
1. A category=text bbox encloses glyph pixels only. Keep it tight to the visible letters/digits with only a 1-2 pixel antialiasing margin. Never include the button, card, row, pill, plaque, circle, rounded rectangle, or coloured/grey background behind the glyphs.
2. When text sits on a visibly bounded badge, count pill, counter chip, plaque, or other small backplate, emit TWO boxes: one category=badge role=surface bbox for the complete backplate shape, and one category=text role=text bbox for only the glyphs. Set the text parent_id to that badge id.
3. Ordinary text printed directly over a larger button/card/panel still gets its own category=text bbox. Do not duplicate the larger button/card/panel in this audit; the image-element pass handles it.
4. A multi-character phrase on one line is one text bbox. Spatially separate labels or counters are separate boxes. Do not combine adjacent icon pixels with text.
5. Return no icons, illustrations, characters, decorations, large panels, cards, or buttons. The only allowed output categories in this audit are text and badge.
6. Exclude artistic lettering fused with an illustration, emblem, logo, crest or icon. If graphic strokes cross through or materially overlap the glyphs, such as a crossed-out A/S circular emblem, emit no text bbox; the complete combined artwork belongs to the image-element pass.

Use full attached-image pixel coordinates. Keep reason under eight words. Return only this JSON shape with the numeric canvas dimensions given below:
${BBOX_BATCH_SCHEMA}`;
const TEXT_REMOVAL_PROMPT =
  "Fill the black missing regions in this image so the surrounding UI continues naturally. The black regions are text-removal holes: reconstruct only the underlying local panel, card, border, divider, gradient, texture or decoration from the immediately surrounding pixels. Keep all visible characters, icons and objects unchanged, and naturally continue anything that reaches into a black region. Do not restore or add any text, letters, digits, labels, logos, pseudo-text, new UI, icons, objects or unrelated decorations. Return one complete image at exactly the same size.";
const BACKGROUND_PROMPT =
  "Perform a masked inpaint, not a redraw. Image 1 is the only image to edit. Its solid-black regions are deletion placeholders for only the selected frontmost objects being removed; black is never content to preserve. The mask is the only edit boundary: transparent mask pixels are editable and opaque mask pixels are protected. Replace every black placeholder inside the editable mask with the most conservative continuation of the immediately surrounding pixels. Match the exact nearby colors, gradients, textures, borders, materials, lighting and blur. If a lower-layer icon, item, character, border or other object is visibly supported by pixels around a hole, continue that same object without changing its identity, UI element type, style, geometry or function. Otherwise fill the hole only with the local panel surface or scene background. Never turn one existing UI element into another type. Never restore, redraw or invent any selected blacked-out foreground object. Never remove or redesign any lower object that remains visible. Do not create any new UI element, panel, card, slot, button, icon, character, object, text, number, logo, badge, decoration, shadow or lighting effect. Outside the editable mask, preserve every pixel exactly. Return one complete PNG at exactly the input dimensions.";
const BACKGROUND_GUIDE_PROMPT =
  "Flat semantic segmentation of the remaining visible scene. Image 1 has solid black deletion holes; Image 2 has the same holes at alpha=0. Mark ONLY these exact holes pure BLACK. Every opaque pixel outside these holes belongs to the retained scene, even if it touches or overlaps a removed target. Mark ALL distinct retained semantic elements pure WHITE using their visible silhouettes, including partially visible components, surfaces, borders, scenery and effects throughout the ENTIRE canvas. Fill each complete visible element solid white, including all of its internal colors, markings, borders and shadows: no line art, dark internal grooves, grayscale, textures, shading or translucent white. Do not omit small elements or flat interface surfaces in favor of large scenery. Do not use bboxes as silhouettes or merge adjacent objects into the removed target. Leave only the continuous distant backdrop and unrelated empty pixels transparent. Preserve positions and scale. A deletion hole's outline is removed geometry, never evidence of an underlying element with that same shape. Output an aligned black/white/transparent PNG at the requested canvas dimensions, without labels, gradients or other colors. Do not reconstruct removed objects in this segmentation.";
const BACKGROUND_TRANSPARENT_HOLE_PROMPT =
  "Complete only the transparent holes of Image 2. Image 1 is the original current-loop scene and provides alignment; selected foreground visible there must stay removed. Image 2 is the authoritative remaining scene: preserve every opaque pixel, marking, border and overlap junction. Image 3 is an ordinary binary semantic reference, never an API mask. White identifies retained components, not their exact outlines, material, depth or edit permission. Its generated contours can be inaccurate: do NOT trace them or redraw entire white components. Use the visible RGB contours in Image 2 as the shape reference. Continue each interrupted contour through the hole with the same center, proportions, orientation, curvature and stroke thickness; preserve the observed shape instead of stretching, tilting or reshaping it. Regular closed contours must remain geometrically regular. Infer front/behind order only from visible overlaps in Image 2, preserving the same edge visibility and translucent compositing through missing regions. Fill unsupported gaps conservatively with the nearest visible surface. Never infer a container, outline, fill, bevel or shadow from the silhouette of a deletion hole; those shapes belong to the removed object. Never restore any selected foreground or any of its subparts. Do not redraw any visible portion, invent a component, change the overlap order, or copy black/white guide colors. Return a complete fully opaque PNG aligned with the original scene, at the requested canvas dimensions with uniform scale.";
const BACKGROUND_SEMANTIC_MODEL =
  modelFor('semantic');
const BACKGROUND_PRESERVATION_PROMPT =
  "Image 1 is the authoritative RGB scene with removed foreground transparent. Image 2 is an incomplete binary guide; black can contain surviving components. Image 3 is a grid of enlarged deletion-hole neighborhoods, numbered left-to-right, top-to-bottom. Return exactly one holes entry for EACH cell, including cells with no independently visible retained component. For each cell, name every distinct visible object, small artwork, border, surface, glow or overlap that touches or continues behind the transparent hole. Inspect the last cell as carefully as the first. A surviving small icon remains a separate object from its button and glow. Describe actual visible colors and shapes. If no retained component can be seen, use an empty preserve array. Never infer content from a hole silhouette or restore removed foreground. No coordinates, evidence points, geometry measurements or deletion instructions. Return JSON only: {\"holes\":[{\"cell\":1,\"preserve\":[\"visible retained component\"]}]}.";
const BACKGROUND_SEMANTIC_PROMPT = `Describe only the remaining visible scene for transparent-hole completion. The deleted foreground is already absent from ALL images. Image 1 is the residual scene with holes painted black; Image 2 has the same holes transparent; Image 3 is a binary semantic reference, where white marks remaining elements. Image 4 is a fixed-cell atlas of enlarged residual neighborhoods for THIS batch; its source-to-cell mapping is supplied below. A hole's silhouette belongs to a deleted object; it is never proof of an underlying container with that shape. The complete removal list is authoritative, including targets assigned to other batches.
Inspect every assigned neighborhood in Image 4 and return retained_components supported by visible pixels there, using the full scene for context. Each component must have an independent id, a concrete description of its actual visible colors/material/shape, a tight full-canvas bbox [x,y,width,height], and 3 to 6 evidence_points [x,y] located ON ITS OWN ACTUALLY VISIBLE OPAQUE PIXELS in Image 2. Use ONLY coordinate_space="normalized_1000": x and y are normalized independently to the width and height of the WHOLE Image 2, from 0 to 1000. Bbox width and height use that same normalized full-image frame. Do not return source pixel coordinates, resized-image pixels, atlas pixels or cell-local coordinates. The software converts this single declared frame to source pixels. For each evidence point also return its observed approximate RGB [r,g,b] in the matching evidence_rgb array. Choose well-inside visible material, not edges or shadows: actual pixel colors are checked, so blue backdrop pixels cannot support a differently colored object. Points inside transparent holes will fail validation. Never use a deleted target id as a retained component id or describe a deleted target's outline, fill or subparts as a surviving container. Do not infer existence from deletion-placeholder colors, guide whites or bbox geometry. Include partially visible lower components, surfaces/borders, scenery and effects supported by opaque pixels. Every independently visible artwork, surface and overlay needs a SEPARATE component with evidence on its own material; do not combine child artwork or effects into a parent's description or use parent-surface pixels as their evidence. The number of components follows the scene. A narrow or partly covered visible component still must be preserved and completed; it is not part of the deletion target.
For each assigned hole return only references to this retained component table: continue_component_ids describes supported components to extend into the missing region; keep_component_ids describes adjacent components to preserve. Do not add free-form reconstruction instructions or deletion descriptions. Empty continuation references mean conservative continuation of the nearest visible surface. For each supported overlap, depth_relations identifies front_id, behind_id and visible crossing/translucency evidence. Every referenced id must exist in retained_components and represent a surviving component. No fixed number of depths. Return an empty depth_relations array when no overlap is visible. Preserve the observed order and existing visible details.
Assign mask_role="element" to each separate visible object, bounded surface, interface container, nearby scenery and effect; these require white segmentation. Use mask_role="backdrop" ONLY for the continuous distant background field, which stays transparent in the segmentation but is still preserved in the RGB image. Never classify a bounded container or a small surviving component as backdrop. Separate nearby elements from the distant field. A binary reference, if supplied, may be incomplete: identify ALL components from Image 2 and the neighborhood atlas, never infer that an element is absent because it is black in the guide.
Return JSON only: {"coordinate_space":"normalized_1000","scene":"short residual layout description","retained_components":[{"id":"unique retained id","description":"visible content and material","mask_role":"element","bbox":[0,0,1000,1000],"evidence_points":[[100,200],[200,200],[300,200]],"evidence_rgb":[[20,60,100],[20,60,100],[20,60,100]]}],"holes":[{"id":"assigned target id","continue_component_ids":["retained id"],"keep_component_ids":["retained id"],"depth_relations":[{"front_id":"retained id","behind_id":"retained id","evidence":"visible crossing or translucency"}]}]}. Use English. Cover every assigned target id, without describing deleted foreground as content to preserve.`;
const BACKGROUND_GEOMETRY_PROMPT = `This is a geometry-only analysis of an already verified retained-component table. Image 1 is the residual scene with deletion holes black, Image 2 is the authoritative residual scene with the same holes transparent, and Image 3 is an enlarged residual-context atlas with source-to-cell mapping supplied below. Measure shapes from the RGB scene and zooms. Do not use the deletion silhouettes as shape evidence. Do not add, remove, merge, rename or redescribe any component or change its depth. Return geometry for every assigned component id only.
For a regular visible contour use kind=circle, ellipse, rectangle, rounded_rectangle or line, center=[x,y], axes=[width,height], rotation_degrees, and 3 to 6 contour_points on ACTUALLY VISIBLE OPAQUE outline pixels in Image 2. All coordinates are ORIGINAL full-canvas pixels. Each contour point must be integer and inside the component's bbox using x <= point_x < x+width and y <= point_y < y+height. Do not choose a theoretical bbox corner outside the visible shape or a point under a transparent hole. If some arc is occluded, use other surviving arcs to infer its unchanged center and full dimensions. For circle, both axes must be equal and rotation_degrees=0; preserve its radius and circular curvature. For a freeform contour, return only {"kind":"freeform"}. Do not discard supported regular geometry merely because a sampled point is wrong: correct that point using its visible contour. Do not invent regular geometry for scenery or complex artwork. Return concise JSON only: {"geometries":[{"id":"assigned component id","geometry":{"kind":"freeform"}}]}.`;
const BACKGROUND_REPAIR_MODEL = GPT_IMAGE_25_SUNBURST_MODEL;
const TEXT_REPAIR_MODEL = GPT_IMAGE_25_SUNBURST_MODEL;
function resolveBackgroundWorkflow(options = {}) {
  const bottomUpRepair = options.bottomUpRepair === true;
  const requestedSvg = options.svgGuideEnabled === true;
  const flatSegmentBackground = typeof options.flatSegmentBackground === "boolean"
    ? options.flatSegmentBackground
    : !requestedSvg && !bottomUpRepair;
  if (flatSegmentBackground && bottomUpRepair)
    throw new Error("FLAT_SEGMENT_BOTTOM_UP_UNSUPPORTED: 三图平涂分区流程使用从上往下拆层，请关闭从下往上补图");
  return { flatSegmentBackground, svgGuideEnabled: !flatSegmentBackground && requestedSvg };
}
const FOREGROUND_EXTRACTION_PROMPT = `Extract only the target from the attached images. Image 1 is the full pixel-reference canvas; image 2 is a transparent guide marking the target bbox.
Target bbox=[X,Y,WIDTH,HEIGHT]; target=DESCRIPTION; category=CATEGORY; pass=LOOP. Keep the target at its exact original position, scale, orientation and proportions. Output a transparent PNG with the same dimensions as image 1 and alpha=0 outside this bbox.
Exclude every neighboring or parent panel/card/button, text, icon, badge, shadow, glow and background. For overlaps, keep only pixels belonging to this target; other objects stay transparent. Preserve antialiased/soft target edges, but do not redraw, beautify, move, resize, crop, merge or invent anything. Return PNG only.`;

function apiKey(kind = "image") {
  return getRoute(kind).api_key || '';
}
function normalizeControllerModel(value) {
  const model = String(value || "").trim();
  return BBOX_CONTROLLER_MODELS.has(model)
    ? model
    : DEFAULT_BBOX_CONTROLLER_MODEL;
}
function isReasoningControllerModel(model) {
  return model === "gpt-6-astra" || model === "gpt-5.6-sol";
}
function conciseError(error) {
  const raw = String(error?.message || error || "Unknown error");
  if (/504|gateway time-?out/i.test(raw))
    return "上游模型请求超时（504 Gateway Time-out），请重新执行。";
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
function isGptImageModel(model) {
  return /^gpt-image-2(?:\.5)?(?:-|$)/i.test(String(model || ""));
}
function openaiClient(kind = "image") {
  const route=getRoute(kind);
  if (!route.api_key) throw new Error('Missing API key for model route '+route.role+'; configure config.json or its documented environment variable');
  const client=new OpenAI({apiKey:route.api_key,baseURL:normalizeBase(route.base_url),maxRetries:hasJobRetryPolicy() ? 0 : route.max_retries,timeout:route.timeout_ms});
  return require('./controller_client.js').adaptController(client,route);
}

function isVolcengineImageProvider(model) {
  // GPT Image 2/2.5 always use the OpenAI-compatible image endpoint, even when
  // a legacy Ark provider variable is still present in .env.local.
  if (isGptImageModel(model)) return false;
  if (model === modelFor('ark_image') || /^doubao-seedream-/i.test(String(model || ''))) return true;
  return String(getRoute('image').provider || '').toLowerCase() === 'volcengine';
}

function volcengineImageEndpoint() {
  let base = String(
    getRoute('ark_image').base_url,
  ).replace(/\/$/, "");
  if (/\/images\/generations$/i.test(base)) return base;
  if (!/\/api\/v3$/i.test(base)) base += "/api/v3";
  return `${base}/images/generations`;
}

function volcengineImageSize(size) {
  const value = String(size || "").toLowerCase();
  // Seedream 5.0 Pro accepts tier names rather than OpenAI's WxH values.
  // 1K is sufficient for the compact atlas; all other app requests use 2K.
  if (value === "1k" || value === "1024x1024") return "1K";
  return "2K";
}

async function volcengineImageEdit(imagePaths, prompt, model, signal, options = {}) {
  const key = getRoute('ark_image').api_key;
  if (!key) throw new Error("Missing LAYERFORGE_IMAGE_API_KEY or LAYERFORGE_API_KEY");
  const timeoutMs = options.timeoutMs || getRoute('ark_image').timeout_ms;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortOuter = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortOuter, { once: true });
  }
  const body = {
    model,
    prompt,
    size: volcengineImageSize(options.size),
    output_format: "png",
    response_format: "b64_json",
    watermark: false,
  };
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (paths.length) body.image = paths.map((file) => dataUrl(file));
  // Keep the caller-provided edit mask in Ark's separate mask field for the
  // legacy Seedream/Ark paths. The GPT Image 2 background path is routed
  // through imageEdit's OpenAI multipart mask branch instead.
  if (options.mask && fs.existsSync(options.mask))
    body.mask = dataUrl(options.mask);
  try {
    const response = await fetch(volcengineImageEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.error?.message || parsed?.message || raw;
      throw new Error(`Volcano Ark image request failed (${response.status}): ${String(detail).slice(0, 500)}`);
    }
    if (!parsed?.data?.length && !parsed?.output?.length)
      throw new Error("Volcano Ark image response did not contain image data");
    return parsed;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortOuter);
  }
}

function feynobgUnavailable(reason) {
  const error = new Error(`FeyNobg unavailable: ${reason}`);
  error.code = "FEYNOBG_UNAVAILABLE";
  error.feynobgUnavailable = true;
  return error;
}

// Seedream returns PNG/JPEG pixels but does not expose OpenAI's
// `background=transparent` option. When FeyNobg is requested, it is a hard
// dependency for the alpha stage: a missing/failed local service must stop the
// job instead of silently replacing the matte with an image-model fallback.
async function requestLocalMatteImage(input, signal) {
  const endpoint = String(process.env.FEYNOBG_ENDPOINT || "").trim();
  if (!endpoint)
    throw feynobgUnavailable("FEYNOBG_ENDPOINT is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const abortOuter = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortOuter, { once: true });
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: input,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      throw feynobgUnavailable(
        `HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
      );
    }
    const result = Buffer.from(await response.arrayBuffer());
    if (!result.length) throw feynobgUnavailable("empty response body");
    return result;
  } catch (error) {
    if (error?.feynobgUnavailable || signal?.aborted) throw error;
    throw feynobgUnavailable(error?.message || String(error));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortOuter);
  }
}

async function localMatteToBox(source, box, output, signal) {
  const [x, y, width, height] = box.bbox;
  const crop = await sharp(source)
    .extract({ left: x, top: y, width, height })
    .png()
    .toBuffer();
  const matte = await requestLocalMatteImage(crop, signal);
  if (!matte) throw feynobgUnavailable("empty matte response");
  const matteMeta = await sharp(matte).metadata();
  if (!matteMeta.width || !matteMeta.height || !matteMeta.hasAlpha)
    throw feynobgUnavailable("response image has no alpha channel");
  const aligned = await sharp(matte)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const sourceMeta = await sharp(source).metadata();
  await sharp({
    create: {
      width: sourceMeta.width,
      height: sourceMeta.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: aligned, left: x, top: y }])
    .png()
    .toFile(output);
  return true;
}
function safePath(raw, mustExist = true) {
  const value = String(raw || "").replaceAll("\\", "/");
  const candidate = path.resolve(ROOT, value);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep))
    throw new Error("path outside workspace");
  if (mustExist && !fs.existsSync(candidate))
    throw new Error(`file not found: ${value}`);
  return candidate;
}
function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}
function mediaUrl(file) {
  return `/media?path=${encodeURIComponent(rel(file)).replaceAll("%2F", "/")}`;
}
function asset(file, label, role) {
  const item = {
    name: label || path.parse(file).name,
    file: path.basename(file),
    path: rel(file),
    url: mediaUrl(file),
    download_url: `/download?path=${encodeURIComponent(rel(file)).replaceAll("%2F", "/")}`,
    role,
  };
  try {
    item.bytes = fs.statSync(file).size;
  } catch {
    item.bytes = 0;
  }
  return item;
}
function dataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".webp"
      ? "image/webp"
      : ext === ".svg"
        ? "image/svg+xml"
        : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

async function makeCoordinateReferenceImage(source, output, width, height) {
  const grid = [];
  for (let normalized = 0; normalized <= 1000; normalized += 100) {
    const x = Math.round((normalized * width) / 1000);
    grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#00ffff" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="8 8"/>`);
    grid.push(`<text x="${Math.min(x + 4, Math.max(4, width - 72))}" y="22" fill="#001a2a" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-size="16" font-family="monospace">xN=${normalized}</text>`);
  }
  for (let normalized = 0; normalized <= 1000; normalized += 100) {
    const y = Math.round((normalized * height) / 1000);
    grid.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#00ffff" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="8 8"/>`);
    grid.push(`<text x="4" y="${Math.min(y + 20, Math.max(20, height - 4))}" fill="#001a2a" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-size="16" font-family="monospace">yN=${normalized}</text>`);
  }
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g>${grid.join("")}</g></svg>`,
  );
  await sharp(source)
    .composite([{ input: overlay, blend: "over" }])
    .png()
    .toFile(output);
  return output;
}

const SVG_GUIDE_MAX_COMPLETION_TOKENS = Math.max(
  16000,
  Math.min(65536, Number(process.env.LAYERFORGE_SVG_MAX_COMPLETION_TOKENS) || 32768),
);
const LOOP_SHARED_COMPONENT_RULES = `Use ONE component inventory and ONE granularity policy for both outputs.
Build the inventory in this explicit order before drawing any SVG:
PHASE A — semantic/interactive COMPONENTS first. Identify every independently usable or meaningful UI
component: close buttons, filter buttons, dropdown/select controls and their arrows, plus/add buttons,
checkboxes/toggles, locks, tabs, sidebar navigation buttons, row buttons, sort controls, pagination,
currency/detail rows, item cards, characters, icons, item artwork, notification dots, equipment-class
badges, upgrade arrows and other status markers. A visible control is a component even when it is small,
borderless, partially transparent, or printed on a larger surface.
PHASE B — supporting surfaces and containers. Identify the panel, card, slot, row, button backplate and
other material surface that carries each Phase-A component.
PHASE C — all remaining scene/background/decorative parts.
The SVG must contain one annotated group for every inventory entry. Mark Phase-A groups
data-component="1" and Phase-B/Phase-C groups data-component="0". Enumerate and audit Phase-A components
before Phase-B/Phase-C; never let a supporting panel replace an interactive child. analysis.b is then
obtained only by filtering that same inventory to entries marked current-top; do not run a separate bbox
interpretation or simplify either side. Current-top selection is independent of inventory phase: when
foreground children have already been removed, an empty supporting panel, slot, row, or sidebar may be
marked data-top="1" even though its data-component is "0". Never force a current top surface to
data-component="1".

Shared component granularity:
- one complete panel, slot/card background, row/button background, icon, item illustration, character,
  decoration or badge is one component;
- a carrying surface and every visible object printed/placed on it are separate components;
- repeated slots/cards/rows/buttons are individual components, never one merged grid;
- every small corner/status marker is an independent badge component. This explicitly includes equipment
  type/class markers at a slot's top-left (sword/helmet/armor/shirt/shield/ring silhouettes), green upgrade
  arrows at a slot's top-right, red notification dots, locks, quantity/count chips, rarity markers and status pips;
- one equipment cell may therefore contain four separate components: slot background, item artwork,
  top-left type badge and top-right upgrade badge. Never merge any badge into its item or slot;
- do not omit a marker because it is small, monochrome, decorative, repeated, or partially overlaps its parent.`;

// Both the initial text pass and every recursive visual pass must draw the
// same complete scene inventory. Only the definition of the current top-layer
// subset changes between those passes. Keeping these requirements in one
// shared fragment prevents the initial text/SVG request from silently asking
// for a lower-detail structural preview.
const SYNCHRONIZED_SVG_COMPLETENESS_RULES = `
The SVG is a complete component inventory of the entire attached screenshot,
not a rough guide and not a text-only preview. Audit the image from top-left to
bottom-right before finishing. Include the full background, every panel,
dialog, card, slot, row, tab, button, control, icon, item artwork, badge,
character, illustration and decoration that is visibly present. The first
annotated group is exactly the full-canvas scene_background. Every other
visible component has its own annotated group with a unique lowercase snake_case
id, data-kind, data-label, data-component, data-top, integer data-z and separate
data-x/data-y/data-width/data-height attributes in normalized 0..1000 space.

Every data-kind MUST be exactly one of: background, panel, card, button, text,
icon, badge, line, character, illustration, decoration, other. Words that
describe a role are not valid kinds: map container/surface to panel, row/slot
to card, tab/control to button, and foreground to illustration. Put the more
specific role in data-label.

Granularity is physical, not semantic: a carrying surface and every object
printed on or placed over it are separate groups. Every repeated slot, card,
row, tab, button and cell is a separate group; never replace a grid with one
inventory_slots_grid group or merge neighboring instances. A small close,
filter, dropdown/select arrow, plus, checkbox/toggle, lock, notification dot,
equipment-class marker, upgrade arrow, quantity chip or status pip is still an
independent component. A component's vector primitives must be inside its own
group, and a shared/removable group must remain a leaf with no nested annotated
group. Keep parent surfaces and lower scene components outside their children.

The SVG root is exactly <svg xmlns="http://www.w3.org/2000/svg" width="IMAGE_WIDTH" height="IMAGE_HEIGHT" viewBox="0 0 1000 1000" preserveAspectRatio="none" data-coordinate-space="gemini_xywh_1000">. Use compact editable vector primitives only: no raster <image>, data URLs, foreignObject, scripts, external resources, XML comments, Markdown or prose. data-width and data-height are sizes, never right/bottom coordinates. Do not omit a visible lower surface merely because a foreground child covers part of it. When the scene is terminal background-only, keep scenery as direct primitives inside scene_background and do not create id-bearing scenery subgroups.`;

const LOOP_VISUAL_CATEGORY_ENUM =
  "panel|card|button|icon|badge|character|illustration|decoration|other";
const LOOP_TOP_LAYER_ANALYSIS_BLOCK = `The analysis object must contain ONLY the visual objects that are currently frontmost and can be
removed in this loop. Every analysis.b item MUST use one of these categories only:
${LOOP_VISUAL_CATEGORY_ENUM}. The category "text" is forbidden in this pass. Ordinary
readable text, rank numbers, labels and captions are metadata handled by the initial text
cleanup pass; do not return them as bbox items or as data-top="1" SVG components here.
Use the following top-layer eligibility rules:
${TOP_LAYER_BBOX_PROMPT
  .replace(BBOX_COMPACT_FORMAT_GUIDANCE, "")
  .replace(BBOX_COMPACT_SCHEMA, "")
  .replaceAll("Return only compact JSON and no markdown.", "")}`;

const TEXT_TOP_LAYER_ANALYSIS_BLOCK = `The analysis object must contain ONLY ordinary removable UI text glyphs that are currently
frontmost over the visual data-top="0" layers. This is the same top-layer selection step as the recursive
loop; the only difference is that this first pass removes ordinary text. Include every ordinary label,
title, caption, number, quantity, currency value, button caption, navigation label and short description
as a separate category=text bbox with a modest 2-4 pixel visual margin. A phrase on one line is one bbox.
At a canvas edge, reduce that margin so xN+widthN and yN+heightN never exceed 1000.
Every item in analysis.b MUST use k="text"; do not place a panel, card, button, icon, badge, character,
illustration or decoration in analysis.b during this pass. The shared SVG schema permits those kinds only
because the same template is used by later visual loops.
The complete SVG must also contain a separate text group for every ordinary text target, marked
data-kind="text" and data-top="1", alongside all non-text data-top="0" components. The SVG is therefore
the full pre-removal scene inventory, not a text-only drawing.

Mandatory art-lettering exclusion: lettering fused with an illustration, emblem, logo, crest, badge,
mascot, icon or decorative graphic is NOT ordinary text. If graphic strokes cross through, surround,
replace, overlap or materially define the letters, keep the complete combined artwork as one non-text
icon/badge/illustration component with data-top="0". Never emit a text bbox for it and never let text
removal erase it. This includes crossed-out emblems, decorative wordmarks and illustrated titles.`;

const LOOP_BBOX_SVG_PROMPT = `Two aligned images are attached. Image 1 is the CURRENT full screenshot and is the
only pixel ground truth. Image 2 is the same screenshot with a cyan normalized 0..1000 coordinate grid
and xN/yN labels; use it only to read exact positions, never as a different scene.

Analyze Image 1 and produce one synchronized bbox + SVG bundle. The screenshot is the only ground truth for both outputs.

${LOOP_SHARED_COMPONENT_RULES}

${SYNCHRONIZED_SVG_COMPLETENESS_RULES}

${LOOP_TOP_LAYER_ANALYSIS_BLOCK}

The svg field must contain a COMPLETE structural SVG analysis of the ENTIRE current screenshot,
including the background, all panels, all slots/cards, all visible foreground objects, controls,
decorations and their current hierarchy. It is not limited to the frontmost bbox list.
The first/backmost component MUST be exactly one full-canvas group with
  id="scene_background", data-kind="background", data-component="0", data-top="0", data-label="scene background",
  data-x="0", data-y="0", data-width="1000", data-height="1000", and data-z="0".
Put a full-canvas SVG primitive inside it.
Terminal-scene override: when no independent UI/character/item remains, return analysis.b=[], f=[], q=[]
and r=["scene","scene-only terminal background"]. In that case the SVG has exactly one annotated
component group: scene_background. Draw mountains, trees, foliage, sky, terrain and all other scenery
as direct primitives inside scene_background (or inside anonymous groups without id/data-* attributes).
Do not create id-bearing scenery subgroups such as trees_and_foliage; scenery is not a bbox/component.

Return exactly one JSON object with exactly this outer shape:
{"analysis":{"c":[1000,1000],"coord":"gemini_xywh_1000","s":"short scene","r":["scene|surface|none","short evidence"],"b":[{"i":"stable_snake_case_id","k":"${LOOP_VISUAL_CATEGORY_ENUM}","b":[xN,yN,widthN,heightN],"p":"nearest_svg_parent_id_or_null","z":0,"m":"image|surface|none","r":"container|surface|button|foreground|decoration","a":0,"h":"short matte reason"}],"f":["id"],"q":["id"]},"svg":"<svg ...>...</svg>"}

Synchronization is mandatory:
1. Use normalized XYWH coordinates from 0 through 1000 independently on each axis in
   BOTH outputs. xN/widthN scale against image width IMAGE_WIDTH; yN/heightN scale against image height
   IMAGE_HEIGHT. Do not emit pixel coordinates and do not emit x2/y2.
2. Every analysis.b item id MUST exactly equal one SVG <g id="...">. Use only lowercase ASCII,
   digits and underscores for those shared ids.
3. That SVG group MUST have data-kind exactly equal to analysis.k, data-label, data-component="1" or
   data-component="0", integer data-z,
   and separate data-x, data-y, data-width, data-height attributes that enclose the analysis bbox.
4. Every shared bbox group must contain the vector primitives that visually represent that object;
   do not emit an empty group or a debug rectangle.
5. Additional SVG groups are required for all other visible lower/background components. Their ids
   must be unique and must not collide with the shared bbox ids.
6. A shared bbox group is a removable component leaf: it MUST NOT contain another annotated/component
   <g> with an id or any data-* metadata. It may contain anonymous geometry-only <g> wrappers (for
   example a transform or opacity wrapper) as long as those wrappers have no id/data-* attributes.
   Put lower layers, parents and unrelated components outside that removable group.
7. analysis.b[].p is the id of the nearest visible supporting SVG component, even when that parent is
   not itself in analysis.b. If an item/icon/badge is carried by a slot, card, button, row or panel,
   p MUST name that exact SVG group; use null for a true root object or for an object physically outside
   the candidate parent. The referenced group must exist and the child bbox center must lie inside its
   rectangle (a small overlay badge may extend beyond it). Never assign a semantic parent merely because
   two objects belong to the same feature; for example, a header icon above a sidebar is not inside the
   sidebar panel and must use p=null.
8. Every SVG component group MUST have data-top="1" or data-top="0". Use data-top="1" exactly when
   that inventory component belongs in the current analysis.b top-layer output. analysis.b ids MUST equal
   the complete set of SVG data-top="1" ids: no missing badges, no extra bbox and no independently chosen subset.
Full-scene completeness is more important than icon detail. Audit the screenshot cell by cell before
finishing the response. Every visible repeated slot/card/cell/button/row BACKGROUND is its own SVG group
with its own visible primitive, including cells partly covered by an item. For an inventory grid, use
stable ids such as slot_r1_c1, slot_r1_c2, etc.; NEVER replace the individual cells with one
inventory_slots_grid or one flat panel. Each top-layer item inside a cell is a separate removable leaf
whose analysis.p points to that cell group. Likewise keep sidebar row/button surfaces separate from their
icons and keep currency/detail rows separate. Simplify an icon to one primitive if necessary, but never
omit or merge its lower supporting surface.

The SVG root MUST be exactly:
<svg xmlns="http://www.w3.org/2000/svg" width="IMAGE_WIDTH" height="IMAGE_HEIGHT"
viewBox="0 0 1000 1000" preserveAspectRatio="none" data-coordinate-space="gemini_xywh_1000">.
This explicit viewBox maps the model's native square coordinate space onto the original canvas.
Every component <g> MUST use four separate numeric attributes: data-x, data-y, data-width and
data-height. Do not use data-bbox. data-width/data-height are sizes, never right/bottom coordinates.
All values are within 0..1000, sizes are positive, data-x+data-width <= 1000, and
data-y+data-height <= 1000. Every SVG primitive inside a component uses the same normalized coordinate
space. Example: an object covering the centered 10% x 10% region uses analysis.b=[450,450,100,100]
and data-x="450" data-y="450" data-width="100" data-height="100".
Use compact editable vector shapes, gradients and short paths. Do not use raster <image>, data URLs,
foreignObject, scripts, external resources, XML comments, Markdown fences or prose. Keep the SVG
compact enough to finish the JSON response. Escape the SVG correctly as a JSON string.`;

// The initial text pass intentionally reuses the exact recursive-loop bundle
// prompt, including its full-scene SVG and synchronization requirements. Only
// the top-layer analysis block is swapped: ordinary text is data-top="1";
// every image/UI component remains data-top="0".
const TEXT_BBOX_SVG_PROMPT = LOOP_BBOX_SVG_PROMPT
  .replace(LOOP_TOP_LAYER_ANALYSIS_BLOCK, TEXT_TOP_LAYER_ANALYSIS_BLOCK)
  .replace(`"k":"${LOOP_VISUAL_CATEGORY_ENUM}"`, '"k":"text"');

function svgAttr(attrs, name) {
  const match = String(attrs || "").match(
    new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match ? match[2] : null;
}

function decodeSvgText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return ""; }
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function svgStyleProperties(value) {
  const result = {};
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf(":");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const val = part.slice(index + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

function parseSvgColor(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "none" || raw.toLowerCase() === "transparent") return null;
  const hex = raw.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex))
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  if (/^[0-9a-f]{6}$/i.test(hex))
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  if (rgb)
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(rgb[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(rgb[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(rgb[3])))),
    };
  const named = {
    white: { r: 255, g: 255, b: 255 }, black: { r: 0, g: 0, b: 0 },
    red: { r: 255, g: 0, b: 0 }, green: { r: 0, g: 128, b: 0 },
    blue: { r: 0, g: 0, b: 255 }, yellow: { r: 255, g: 255, b: 0 },
    gray: { r: 128, g: 128, b: 128 }, grey: { r: 128, g: 128, b: 128 },
  };
  return named[raw.toLowerCase()] || null;
}

function extractSvgTextProperties(svg, node) {
  const body = svgGroupBody(svg, node?.id);
  if (!body) return null;
  const textMatch = /<text\b([^>]*)>([\s\S]*?)<\/text>/i.exec(body);
  if (!textMatch) return null;
  const groupStart = findSvgGroupStart(svg, node.id);
  const groupAttrs = groupStart?.text || "";
  const textAttrs = textMatch[1] || "";
  const tspanAttrs = /<tspan\b([^>]*)>/i.exec(textMatch[2])?.[1] || "";
  const groupStyle = svgStyleProperties(svgAttr(groupAttrs, "style"));
  const textStyle = svgStyleProperties(svgAttr(textAttrs, "style"));
  const tspanStyle = svgStyleProperties(svgAttr(tspanAttrs, "style"));
  const value = (name) => svgAttr(textAttrs, name) || textStyle[name] || svgAttr(tspanAttrs, name) || tspanStyle[name] || svgAttr(groupAttrs, name) || groupStyle[name] || null;
  const fontSizeRaw = value("font-size");
  const fontSize = fontSizeRaw === null ? null : Number.parseFloat(String(fontSizeRaw));
  const text = decodeSvgText(textMatch[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const family = String(value("font-family") || "").replace(/^['"]|['"]$/g, "").split(",")[0].trim();
  const weight = String(value("font-weight") || "").toLowerCase();
  const style = String(value("font-style") || "").toLowerCase();
  const anchor = String(value("text-anchor") || "").toLowerCase();
  return {
    text: text || null,
    fillColor: parseSvgColor(value("fill")),
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : null,
    fontFamily: family || null,
    bold: weight === "bold" || Number(weight) >= 600,
    italic: style === "italic" || style === "oblique",
    align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
  };
}

function duplicateSvgAttributes(attrs) {
  const seen = new Set();
  const duplicates = new Set();
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
  let match;
  while ((match = pattern.exec(String(attrs || "")))) {
    const name = String(match[1]).toLowerCase();
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

function validateSvgAttributeUniqueness(svg) {
  const tagPattern = /<([A-Za-z][\w:.-]*)(\s[^<>]*?)?\s*\/?>/g;
  let match;
  while ((match = tagPattern.exec(String(svg || "")))) {
    const duplicateAttributes = duplicateSvgAttributes(match[2] || "");
    if (duplicateAttributes.length) {
      const id = svgAttr(match[2] || "", "id");
      throw new Error(
        `SVG_GUIDE_DUPLICATE_ATTRIBUTE:${duplicateAttributes.join(",")}${id ? `:id=${id}` : `:tag=${match[1]}`}`,
      );
    }
  }
}

function parseSvgBbox(value, width, height) {
  const values = String(value || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length !== 4 || values.some((item) => !Number.isFinite(item)))
    return null;
  const [x, y, w, h] = values;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > width || y + h > height)
    return null;
  return [x, y, w, h];
}

function parseSvgGroupBbox(attrs, width, height) {
  const parts = ["data-x", "data-y", "data-width", "data-height"].map((name) =>
    svgAttr(attrs, name),
  );
  const hasSeparateCoordinates = parts.some((value) => value !== null);
  if (hasSeparateCoordinates) {
    if (parts.some((value) => value === null)) return { bbox: null, format: "incomplete_separate_xywh" };
    return {
      bbox: parseSvgBbox(parts.join(" "), width, height),
      format: "separate_xywh_attributes",
    };
  }
  return {
    bbox: parseSvgBbox(svgAttr(attrs, "data-bbox"), width, height),
    format: "legacy_data_bbox",
  };
}

function findSvgGroupStart(svg, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<g\\b[^>]*\\bid=["']${escaped}["'][^>]*>`,
    "i",
  ).exec(svg);
  return match ? { index: match.index, text: match[0] } : null;
}

function findSvgGroupEnd(svg, start) {
  const token = /<g\b[^>]*>|<\/g>/gi;
  token.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = token.exec(svg))) {
    if (/^<g\b/i.test(match[0])) {
      if (!/\/\s*>$/.test(match[0])) depth++;
    } else {
      depth--;
    }
    if (depth === 0) return token.lastIndex;
  }
  throw new Error("SVG_GUIDE_UNCLOSED_GROUP");
}

const SYNCHRONIZED_BOUNDARY_REPAIR_TOLERANCE = 8;

function replaceSvgGroupBboxAttributes(svg, id, bbox) {
  const start = findSvgGroupStart(svg, id);
  if (!start) return { svg, updated: false };
  const names = ["data-x", "data-y", "data-width", "data-height"];
  let tag = start.text;
  for (let index = 0; index < names.length; index++) {
    let found = false;
    const pattern = new RegExp(`(${names[index]}\\s*=\\s*)(["'])(.*?)\\2`, "i");
    tag = tag.replace(pattern, (_match, prefix, quote) => {
      found = true;
      return `${prefix}${quote}${bbox[index]}${quote}`;
    });
    if (!found) return { svg, updated: false };
  }
  return {
    svg: `${svg.slice(0, start.index)}${tag}${svg.slice(start.index + start.text.length)}`,
    updated: true,
  };
}

function repairSynchronizedNormalizedBounds(payload, tolerance = SYNCHRONIZED_BOUNDARY_REPAIR_TOLERANCE) {
  const value = JSON.parse(JSON.stringify(payload || {}));
  const boxes = value?.analysis?.b;
  if (!Array.isArray(boxes) || typeof value.svg !== "string")
    return { value, repairs: [] };
  const repairs = [];
  for (const item of boxes) {
    const before = Array.isArray(item?.b) ? item.b.map(Number) : null;
    if (
      !before ||
      before.length !== 4 ||
      before.some((coordinate) => !Number.isInteger(coordinate))
    ) continue;
    const [x, y, boxWidth, boxHeight] = before;
    const right = x + boxWidth;
    const bottom = y + boxHeight;
    if (x >= 0 && y >= 0 && boxWidth > 0 && boxHeight > 0 && right <= 1000 && bottom <= 1000)
      continue;
    const nearBoundary =
      boxWidth > 0 &&
      boxHeight > 0 &&
      x >= -tolerance &&
      y >= -tolerance &&
      x < 1000 &&
      y < 1000 &&
      right > 0 &&
      bottom > 0 &&
      right <= 1000 + tolerance &&
      bottom <= 1000 + tolerance;
    if (!nearBoundary) continue;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const after = [
      left,
      top,
      Math.min(1000, right) - left,
      Math.min(1000, bottom) - top,
    ];
    if (after[2] <= 0 || after[3] <= 0) continue;
    const rewritten = replaceSvgGroupBboxAttributes(value.svg, String(item?.i || ""), after);
    if (!rewritten.updated) continue;
    item.b = after;
    value.svg = rewritten.svg;
    repairs.push({
      id: String(item.i),
      before,
      after,
      reason: "clipped_small_normalized_bbox_overflow_to_canvas",
    });
  }
  return { value, repairs };
}

function normalizeSynchronizedSvgKinds(payload) {
  const value = JSON.parse(JSON.stringify(payload || {}));
  if (typeof value.svg !== "string") return { value, repairs: [] };

  const boxes = Array.isArray(value?.analysis?.b) ? value.analysis.b : [];
  const boxesById = new Map();
  for (const item of boxes) {
    const id = String(item?.i || "");
    if (!boxesById.has(id)) boxesById.set(id, []);
    boxesById.get(id).push(item);
  }

  const edits = [];
  const repairs = [];
  const repairedBoxIds = new Set();
  const groupPattern = /<g\b([^>]*)>/gi;
  let match;
  while ((match = groupPattern.exec(value.svg))) {
    const attrs = match[1] || "";
    const id = svgAttr(attrs, "id");
    const before = String(svgAttr(attrs, "data-kind") || "").toLowerCase();
    const after = SVG_KIND_ALIASES.get(before);
    if (!id || !after) continue;

    const tag = match[0].replace(
      /(data-kind\s*=\s*)(["'])(.*?)\2/i,
      (_whole, prefix, quote) => `${prefix}${quote}${after}${quote}`,
    );
    edits.push({ index: match.index, length: match[0].length, tag });

    const matchingBoxes = boxesById.get(String(id)) || [];
    const analysisBefore = matchingBoxes.map((item) => String(item?.k || "").toLowerCase());
    for (const item of matchingBoxes) item.k = after;
    if (matchingBoxes.length) repairedBoxIds.add(String(id));
    repairs.push({
      id: String(id),
      before,
      after,
      ...(analysisBefore.length
        ? { analysis_before: analysisBefore, analysis_after: after }
        : {}),
      reason: "normalized_known_svg_kind_alias",
    });
  }

  for (const edit of edits.sort((a, b) => b.index - a.index)) {
    value.svg = `${value.svg.slice(0, edit.index)}${edit.tag}${value.svg.slice(edit.index + edit.length)}`;
  }

  // A shared bbox can occasionally use an alias while its SVG node already
  // uses the canonical kind. Normalize that side independently; strict sync
  // validation below still rejects any remaining disagreement.
  for (const item of boxes) {
    const id = String(item?.i || "");
    if (repairedBoxIds.has(id)) continue;
    const before = String(item?.k || "").toLowerCase();
    const after = SVG_KIND_ALIASES.get(before);
    if (!after) continue;
    item.k = after;
    repairs.push({
      id,
      before,
      after,
      analysis_before: [before],
      analysis_after: after,
      reason: "normalized_known_analysis_kind_alias",
    });
  }

  return { value, repairs };
}

function mapSvgCoordinateBboxToPixels(bbox, width, height, coordinateWidth, coordinateHeight) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  if (Number(coordinateWidth) === Number(width) && Number(coordinateHeight) === Number(height))
    return [...bbox];
  const sx = Number(width) / Number(coordinateWidth);
  const sy = Number(height) / Number(coordinateHeight);
  const [rawX, rawY, rawWidth, rawHeight] = bbox.map(Number);
  const x = Math.max(0, Math.min(Math.round(rawX * sx), width - 1));
  const y = Math.max(0, Math.min(Math.round(rawY * sy), height - 1));
  const mappedWidth = Math.round(rawWidth * sx);
  const mappedHeight = Math.round(rawHeight * sy);
  return [
    x,
    y,
    Math.max(1, Math.min(mappedWidth, width - x)),
    Math.max(1, Math.min(mappedHeight, height - y)),
  ];
}

function mapSynchronizedAnalysisToPixels(analysis, width, height) {
  const mapped = JSON.parse(JSON.stringify(analysis || {}));
  if (!Array.isArray(mapped.b))
    throw new Error("LOOP_BBOX_SVG_ANALYSIS_MISSING");
  for (const item of mapped.b) {
    const bbox = mapSvgCoordinateBboxToPixels(item?.b, width, height, 1000, 1000);
    if (!bbox)
      throw new Error(`LOOP_BBOX_SVG_INVALID_NORMALIZED_BBOX:${String(item?.i || "missing")}`);
    item.b = bbox;
  }
  mapped.c = [width, height];
  mapped.coord = "xywh_pixels";
  return mapped;
}

function extractSvgGuideNodes(
  svg,
  width,
  height,
  coordinateWidth = width,
  coordinateHeight = height,
  options = {},
) {
  const nodes = [];
  const ids = new Set();
  const groupPattern = /<g\b([^>]*)>/gi;
  let match;
  while ((match = groupPattern.exec(svg))) {
    const attrs = match[1] || "";
    const duplicateAttributes = duplicateSvgAttributes(attrs);
    if (duplicateAttributes.length)
      throw new Error(`SVG_GUIDE_DUPLICATE_ATTRIBUTE:${duplicateAttributes.join(",")}`);
    const id = svgAttr(attrs, "id");
    if (!id) continue;
    if (ids.has(id)) throw new Error(`SVG_GUIDE_DUPLICATE_ID:${id}`);
    ids.add(id);
    const hasComponentMetadata = [
      "data-kind",
      "data-label",
      "data-z",
      "data-top",
      "data-component",
      "data-x",
      "data-y",
      "data-width",
      "data-height",
      "data-bbox",
    ].some((name) => svgAttr(attrs, name) !== null);
    // A controller may use an id-only group to organize geometry inside an annotated
    // component (for example bottom_lines inside scene_background). It has no
    // bbox/component metadata and therefore is not an editable scene node.
    // Ignore it in every pass; only groups carrying component metadata enter
    // synchronization and removal matching.
    if (!hasComponentMetadata)
      continue;
    const parsedBbox = parseSvgGroupBbox(attrs, coordinateWidth, coordinateHeight);
    const coordinateBbox = parsedBbox.bbox;
    if (!coordinateBbox) throw new Error(`SVG_GUIDE_INVALID_BBOX:${id}`);
    const bbox = mapSvgCoordinateBboxToPixels(
      coordinateBbox,
      width,
      height,
      coordinateWidth,
      coordinateHeight,
    );
    const kind = svgAttr(attrs, "data-kind");
    const label = svgAttr(attrs, "data-label");
    const zRaw = svgAttr(attrs, "data-z");
    const topRaw = svgAttr(attrs, "data-top");
    const componentRaw = svgAttr(attrs, "data-component");
    if (!kind || !label || zRaw === null || !Number.isInteger(Number(zRaw)))
      throw new Error(`SVG_GUIDE_MISSING_METADATA:${id}`);
    nodes.push({
      id,
      kind,
      label,
      bbox,
      coordinateBbox,
      bboxFormat: parsedBbox.format,
      z: Number(zRaw),
      top: topRaw === "1" ? true : topRaw === "0" ? false : null,
      topRaw,
      component: componentRaw === "1" ? true : componentRaw === "0" ? false : null,
      componentRaw,
      sourceNodeId: svgAttr(attrs, "data-source-node") || null,
      start: match.index,
    });
  }
  // A small scene may legitimately contain only a background plus a handful
  // of grouped components. Reject an empty/minimal placeholder, but do not
  // impose an arbitrary node count that would reject a complete compact UI.
  if (nodes.length < 1)
    throw new Error(`SVG_GUIDE_TOO_FEW_NODES:${nodes.length}`);
  if (!nodes.some((node) => node.kind === "background"))
    throw new Error("SVG_GUIDE_MISSING_BACKGROUND_NODE");
  return nodes;
}

async function validateSvgGuide(svg, width, height, options = {}) {
  const text = String(svg || "").trim();
  if (!/^<svg\b/i.test(text) || !/<\/svg>\s*$/i.test(text))
    throw new Error("SVG_GUIDE_NOT_COMPLETE_DOCUMENT");
  // Check XML attribute uniqueness before Sharp/libvips parses the document.
  // This gives the UI a precise model-response error instead of a generic
  // "Input buffer has corrupt header" message.
  validateSvgAttributeUniqueness(text);
  if (/<\/(?:script|foreignObject)\b|<(?:script|foreignObject|image)\b/i.test(text))
    throw new Error("SVG_GUIDE_UNSAFE_OR_RASTER_CONTENT");
  if (/(?:href|xlink:href)\s*=\s*["'](?:https?:|data:|file:|javascript:)/i.test(text) || /url\(\s*(?:https?:|data:|file:)/i.test(text))
    throw new Error("SVG_GUIDE_EXTERNAL_RESOURCE");
  const rendered = await sharp(Buffer.from(text)).metadata();
  if (Number(rendered.width) !== Number(width) || Number(rendered.height) !== Number(height))
    throw new Error(`SVG_GUIDE_CANVAS_MISMATCH:${rendered.width}x${rendered.height}`);
  const rootMatch = /^<svg\b([^>]*)>/i.exec(text);
  const rootAttrs = rootMatch?.[1] || "";
  const coordinateSpace = svgAttr(rootAttrs, "data-coordinate-space") || "xywh_pixels";
  let coordinateWidth = width;
  let coordinateHeight = height;
  if (coordinateSpace === "gemini_xywh_1000") {
    const viewBox = String(svgAttr(rootAttrs, "viewBox") || "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) ||
        viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] !== 1000 || viewBox[3] !== 1000)
      throw new Error("SVG_GUIDE_NORMALIZED_VIEWBOX_MISMATCH");
    if (String(svgAttr(rootAttrs, "preserveAspectRatio") || "") !== "none")
      throw new Error("SVG_GUIDE_NORMALIZED_ASPECT_RATIO_MISMATCH");
    coordinateWidth = 1000;
    coordinateHeight = 1000;
  }
  const nodes = extractSvgGuideNodes(
    text,
    width,
    height,
    coordinateWidth,
    coordinateHeight,
    options,
  );
  return {
    svg: text,
    nodes,
    width,
    height,
    coordinateSpace,
    coordinateCanvas: [coordinateWidth, coordinateHeight],
  };
}

function removeSvgGroups(svg, ids) {
  let result = String(svg || "");
  const ordered = [...new Set((ids || []).map(String))]
    .map((id) => ({ id, found: findSvgGroupStart(result, id) }))
    .filter((item) => item.found)
    .sort((a, b) => b.found.index - a.found.index);
  for (const item of ordered) {
    const end = findSvgGroupEnd(result, item.found.index);
    result = result.slice(0, item.found.index) + result.slice(end);
  }
  return result;
}

function bboxIntersection(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function svgBboxArea(box) {
  return Math.max(0, Number(box?.[2] || 0)) * Math.max(0, Number(box?.[3] || 0));
}

function scoreSvgNodeCandidate(node, bbox, category) {
  const layerArea = svgBboxArea(bbox);
  const nodeArea = svgBboxArea(node.bbox);
  const intersection = bboxIntersection(bbox, node.bbox);
  const union = layerArea + nodeArea - intersection;
  return {
    node,
    semantic: String(node.kind || "").toLowerCase() === String(category || "").toLowerCase() ? 1 : 0,
    coverage: intersection / Math.max(1, Math.min(layerArea, nodeArea)),
    iou: intersection / Math.max(1, union),
    areaRatio: Math.max(layerArea, nodeArea) / Math.max(1, Math.min(layerArea, nodeArea)),
  };
}

function sortSvgNodeCandidates(a, b) {
  return b.semantic - a.semantic ||
    b.coverage - a.coverage ||
    b.iou - a.iou ||
    a.areaRatio - b.areaRatio ||
    a.node.z - b.node.z;
}

function findSvgNodeCandidate(nodes, layer, hidden, used, options = {}) {
  const bbox = layer.source_bbox || layer.working_bbox || layer.bbox;
  const category = layer.category || layer.kind;
  const allowUsed = options.allowUsed === true;
  const allowBackground = options.allowBackground === true || String(category || "").toLowerCase() === "background";
  return (nodes || [])
    .filter((node) =>
      !hidden.has(node.id) &&
      (allowUsed || !used.has(node.id)) &&
      String(node.kind || "").toLowerCase() !== "text" &&
      (allowBackground || String(node.kind || "").toLowerCase() !== "background"),
    )
    .map((node) => scoreSvgNodeCandidate(node, bbox, category))
    .filter((item) => item.coverage >= 0.45 || item.iou >= 0.28)
    .sort(sortSvgNodeCandidates)[0] || null;
}

function matchLayersToSvgNodes(nodes, layers, hiddenIds, options = {}) {
  const hidden = hiddenIds || new Set();
  const used = new Set();
  const matches = [];
  for (const layer of layers || []) {
    const bbox = layer.source_bbox || layer.working_bbox || layer.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4)
      throw new Error(`SVG_GUIDE_LAYER_BBOX_MISSING:${layer.id || "unknown"}`);
    const expectedNodeId = layer.svg_node_id ? String(layer.svg_node_id) : null;
    if (expectedNodeId) {
      const node = (nodes || []).find((item) => String(item.id) === expectedNodeId);
      if (!node || hidden.has(node.id) || used.has(node.id))
        throw new Error(`LOOP_BBOX_SVG_NODE_MISSING:${expectedNodeId}`);
      const matchBbox = layer.svg_match_bbox || layer.model_bbox || bbox;
      if (!svgBoxEncloses(node.bbox, matchBbox))
        throw new Error(`LOOP_BBOX_SVG_BBOX_NOT_ENCLOSED:${expectedNodeId}`);
      if (String(node.kind || "").toLowerCase() !== String(layer.category || "").toLowerCase())
        throw new Error(`LOOP_BBOX_SVG_KIND_MISMATCH:${expectedNodeId}:${layer.category}:${node.kind}`);
      used.add(node.id);
      matches.push({
        layer_id: String(layer.id || ""),
        node_id: node.id,
        node_label: node.label,
        node_bbox: node.bbox,
        layer_bbox: matchBbox,
        coverage: 1,
        iou: Number((bboxIntersection(matchBbox, node.bbox) /
          Math.max(1, svgBboxArea(matchBbox) + svgBboxArea(node.bbox) - bboxIntersection(matchBbox, node.bbox))).toFixed(4)),
        semantic_match: true,
        source_node_id: null,
        match_mode: "paired_model_id",
      });
      continue;
    }
    if (options.strictIds)
      throw new Error(`LOOP_BBOX_SVG_LAYER_ID_MISSING:${layer.id || "unknown"}`);
    const best = findSvgNodeCandidate(nodes, layer, hidden, used);
    if (!best)
      throw new Error(`SVG_GUIDE_NODE_NOT_MATCHED:${layer.id || "unknown"}`);
    used.add(best.node.id);
    matches.push({
      layer_id: String(layer.id || ""),
      node_id: best.node.id,
      node_label: best.node.label,
      node_bbox: best.node.bbox,
      layer_bbox: bbox,
      coverage: Number(best.coverage.toFixed(4)),
      iou: Number(best.iou.toFixed(4)),
      semantic_match: best.semantic === 1,
      source_node_id: best.node.sourceNodeId || null,
      match_mode: best.node.sourceNodeId ? "explicit_bbox_node" : "native_svg_node",
    });
  }
  return matches;
}

function svgBoxEncloses(outer, inner) {
  return Array.isArray(outer) && Array.isArray(inner) &&
    outer.length === 4 && inner.length === 4 &&
    Number(outer[0]) <= Number(inner[0]) &&
    Number(outer[1]) <= Number(inner[1]) &&
    Number(outer[0]) + Number(outer[2]) >= Number(inner[0]) + Number(inner[2]) &&
    Number(outer[1]) + Number(outer[3]) >= Number(inner[1]) + Number(inner[3]);
}

function svgBoxContainsCenter(outer, inner) {
  if (!Array.isArray(outer) || !Array.isArray(inner) || outer.length !== 4 || inner.length !== 4)
    return false;
  const cx = Number(inner[0]) + Number(inner[2]) / 2;
  const cy = Number(inner[1]) + Number(inner[3]) / 2;
  return cx >= Number(outer[0]) && cx <= Number(outer[0]) + Number(outer[2]) &&
    cy >= Number(outer[1]) && cy <= Number(outer[1]) + Number(outer[3]);
}

function svgGroupBody(svg, id) {
  const start = findSvgGroupStart(svg, id);
  if (!start) return null;
  const end = findSvgGroupEnd(svg, start.index);
  return String(svg).slice(start.index + start.text.length, end - "</g>".length);
}

function hasAnnotatedNestedSvgGroup(body) {
  const groupPattern = /<g\b([^>]*)>/gi;
  let match;
  while ((match = groupPattern.exec(String(body || "")))) {
    const attrs = match[1] || "";
    // Anonymous geometry wrappers are valid inside a removable leaf. Any
    // id/data-* turns the nested group into a separately addressable scene
    // component, which would make removal ambiguous.
    if (/\bid\s*=|\bdata-[A-Za-z0-9_-]+\s*=/i.test(attrs)) return true;
  }
  return false;
}

function validateLoopBboxSvgSync(nodes, detection, svg = null) {
  const byId = new Map((nodes || []).map((node) => [String(node.id), node]));
  const matches = [];
  for (const box of detection?.boxes || []) {
    if (box.visible === false || ["text", "background"].includes(String(box.category || "").toLowerCase()))
      continue;
    const node = byId.get(String(box.id));
    if (!node) throw new Error(`LOOP_BBOX_SVG_NODE_MISSING:${box.id}`);
    if (String(node.kind || "").toLowerCase() !== String(box.category || "").toLowerCase())
      throw new Error(`LOOP_BBOX_SVG_KIND_MISMATCH:${box.id}:${box.category}:${node.kind}`);
    if (!svgBoxEncloses(node.bbox, box.bbox))
      throw new Error(`LOOP_BBOX_SVG_BBOX_NOT_ENCLOSED:${box.id}`);
    if (svg !== null) {
      const body = svgGroupBody(svg, node.id);
      if (!body || !/<(?:path|rect|circle|ellipse|polygon|polyline|line|text)\b/i.test(body))
        throw new Error(`LOOP_BBOX_SVG_NODE_HAS_NO_PRIMITIVE:${box.id}`);
      if (hasAnnotatedNestedSvgGroup(body))
        throw new Error(`LOOP_BBOX_SVG_REMOVABLE_NODE_NOT_LEAF:${box.id}`);
    }
    if (box.svg_parent_id) {
      const parent = byId.get(String(box.svg_parent_id));
      if (!parent) throw new Error(`LOOP_BBOX_SVG_PARENT_NODE_MISSING:${box.id}:${box.svg_parent_id}`);
      // A small overlay badge may legitimately extend a few pixels beyond
      // its button/slot. Its center must still land inside the named parent;
      // the directly paired SVG node above remains the strict bbox superset.
      if (!svgBoxContainsCenter(parent.bbox, box.bbox))
        throw new Error(`LOOP_BBOX_SVG_PARENT_CENTER_OUTSIDE:${box.id}:${box.svg_parent_id}`);
    }
    matches.push({
      bbox_id: String(box.id),
      svg_node_id: String(node.id),
      svg_parent_id: box.svg_parent_id || null,
      category: String(box.category || "other"),
      bbox: box.bbox,
      svg_bbox: node.bbox,
      enclosed: true,
    });
  }
  return {
    bbox_count: matches.length,
    svg_node_count: (nodes || []).length,
    synchronized_count: matches.length,
    all_bbox_nodes_present: true,
    all_bbox_nodes_enclose_bbox: true,
    matches,
  };
}

async function generateLoopBboxSvgBundle(source, loopDir, loopNumber, width, height, signal, model = DEFAULT_BBOX_CONTROLLER_MODEL) {
  const controllerModel = normalizeControllerModel(model);
  const requestPath = path.join(loopDir, "bbox_request.json");
  const rawPath = path.join(loopDir, "bbox_raw_response.txt");
  const responseMetaPath = path.join(loopDir, "bbox_response_meta.json");
  const repairedResponsePath = path.join(loopDir, "bbox_svg_repaired_response.json");
  const analysisPath = path.join(loopDir, "bbox_svg_analysis.json");
  const syncPath = path.join(loopDir, "bbox_svg_sync.json");
  const parentRepairPath = path.join(loopDir, "bbox_svg_parent_repairs.json");
  const coordinateRepairPath = path.join(loopDir, "bbox_svg_coordinate_repairs.json");
  const kindRepairPath = path.join(loopDir, "bbox_svg_kind_repairs.json");
  const svgPath = path.join(loopDir, "scene.svg");
  const previewPath = path.join(loopDir, "scene.png");
  const sceneJsonPath = path.join(loopDir, "scene.json");
  const coordinateReferencePath = path.join(loopDir, "coordinate_reference.png");
  await makeCoordinateReferenceImage(source, coordinateReferencePath, width, height);
  const prompt = LOOP_BBOX_SVG_PROMPT
    .replaceAll("IMAGE_WIDTH", String(width))
    .replaceAll("IMAGE_HEIGHT", String(height));
  const messages = [
    {
      role: "system",
      content: "You are a strict synchronized UI scene annotator. Image 1 is pixel truth; Image 2 is an aligned coordinate reference only. One response must contain a top-layer bbox subset and a complete full-scene SVG using identical shared ids and coordinates.",
    },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl(source), detail: "high" } },
        { type: "image_url", image_url: { url: dataUrl(coordinateReferencePath), detail: "high" } },
        { type: "text", text: prompt },
      ],
    },
  ];
  const request = {
    model: controllerModel,
    response_format: { type: "json_object" },
    max_completion_tokens: SVG_GUIDE_MAX_COMPLETION_TOKENS,
    ...(controllerModel === "gpt-6-astra" ? { reasoning_effort: "high" } : {}),
    messages,
  };
  await fsp.writeFile(
    requestPath,
    JSON.stringify({
      endpoint: "chat.completions.create",
      model: controllerModel,
      loop: loopNumber,
      source_image: path.resolve(source),
      canvas: [width, height],
      request: {
        ...request,
        messages: messages.map((message) => ({
          ...message,
          content: Array.isArray(message.content)
            ? (() => {
                let imageIndex = 0;
                return message.content.map((item) => item.type === "image_url"
                  ? { type: "image_url", image_url: { file: path.resolve(imageIndex++ === 0 ? source : coordinateReferencePath), detail: item.image_url.detail } }
                  : item);
              })()
            : message.content,
        })),
      },
    }, null, 2),
    "utf8",
  );
  const client = openaiClient("controller");
  let requestAttempts = 0;
  const response = await retry(
    () => {
      requestAttempts += 1;
      return client.chat.completions.create(request, signal ? { signal } : undefined);
    },
    `loop ${loopNumber} synchronized bbox+SVG`,
  );
  const content = String(response?.choices?.[0]?.message?.content || "").trim();
  const finishReason = response?.choices?.[0]?.finish_reason || null;
  await fsp.writeFile(rawPath, content, "utf8");
  await fsp.writeFile(
    responseMetaPath,
    JSON.stringify({
      finish_reason: finishReason,
      content_length: content.length,
      request_attempts: requestAttempts,
      extra_escape_layer_decoded: false,
      json_repaired: false,
      repair_reason: null,
      usage: response?.usage || null,
    }, null, 2),
    "utf8",
  );
  if (finishReason === "length") throw new Error("LOOP_BBOX_SVG_RESPONSE_TRUNCATED");
  let payload;
  let extraEscapeLayer = false;
  let jsonRepaired = false;
  let repairReason = null;
  try {
    const parsed = parseSynchronizedBundleJson(content);
    payload = parsed.value;
    extraEscapeLayer = parsed.extraEscapeLayer;
    jsonRepaired = parsed.repaired === true;
    repairReason = parsed.repairReason || null;
    if (parsed.repairedText) {
      await fsp.writeFile(
        repairedResponsePath,
        parsed.repairedText,
        "utf8",
      );
    }
  } catch (error) {
    await fsp.writeFile(
      responseMetaPath,
      JSON.stringify({
        finish_reason: finishReason,
        content_length: content.length,
        request_attempts: requestAttempts,
        usage: response?.usage || null,
        extra_escape_layer_decoded: false,
        json_repaired: false,
        parse_error: String(error?.message || error),
      }, null, 2),
      "utf8",
    );
    throw new Error(`LOOP_BBOX_SVG_INVALID_JSON:${String(error?.message || error)}`);
  }
  if (extraEscapeLayer || jsonRepaired) {
    await fsp.writeFile(
      responseMetaPath,
      JSON.stringify({
        finish_reason: finishReason,
        content_length: content.length,
        request_attempts: requestAttempts,
        usage: response?.usage || null,
        extra_escape_layer_decoded: extraEscapeLayer,
        json_repaired: jsonRepaired,
        repair_reason: repairReason,
      }, null, 2),
      "utf8",
    );
  }
  if (!payload?.analysis || typeof payload.analysis !== "object" || !Array.isArray(payload.analysis.b))
    throw new Error("LOOP_BBOX_SVG_ANALYSIS_MISSING");
  if (typeof payload.svg !== "string") throw new Error("LOOP_BBOX_SVG_DOCUMENT_MISSING");
  if (Object.keys(payload).length !== 2 || !("analysis" in payload) || !("svg" in payload))
    throw new Error("LOOP_BBOX_SVG_OUTER_SHAPE_MISMATCH");
  if (!Array.isArray(payload.analysis.c) || Number(payload.analysis.c[0]) !== 1000 || Number(payload.analysis.c[1]) !== 1000)
    throw new Error("LOOP_BBOX_SVG_ANALYSIS_CANVAS_MISMATCH");
  if (String(payload.analysis.coord || "") !== "gemini_xywh_1000")
    throw new Error("LOOP_BBOX_SVG_COORDINATE_FORMAT_MISMATCH");
  const kindRepair = normalizeSynchronizedSvgKinds(payload);
  payload = kindRepair.value;
  if (kindRepair.repairs.length) {
    await fsp.writeFile(
      kindRepairPath,
      JSON.stringify({ loop: loopNumber, repairs: kindRepair.repairs }, null, 2),
      "utf8",
    );
    const responseMeta = JSON.parse(await fsp.readFile(responseMetaPath, "utf8"));
    responseMeta.svg_kind_repairs = kindRepair.repairs;
    await fsp.writeFile(responseMetaPath, JSON.stringify(responseMeta, null, 2), "utf8");
  }
  const boundaryRepair = repairSynchronizedNormalizedBounds(payload);
  payload = boundaryRepair.value;
  if (boundaryRepair.repairs.length) {
    await fsp.writeFile(
      coordinateRepairPath,
      JSON.stringify({ loop: loopNumber, repairs: boundaryRepair.repairs }, null, 2),
      "utf8",
    );
    const responseMeta = JSON.parse(await fsp.readFile(responseMetaPath, "utf8"));
    responseMeta.coordinate_boundary_repairs = boundaryRepair.repairs;
    await fsp.writeFile(responseMetaPath, JSON.stringify(responseMeta, null, 2), "utf8");
  }
  const rawIds = new Set();
  const rawParents = new Map();
  for (const item of payload.analysis.b) {
    const id = String(item?.i || "");
    const category = String(item?.k || "").toLowerCase();
    const bbox = item?.b;
    if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`LOOP_BBOX_SVG_INVALID_SHARED_ID:${id || "missing"}`);
    if (rawIds.has(id)) throw new Error(`LOOP_BBOX_SVG_DUPLICATE_SHARED_ID:${id}`);
    rawIds.add(id);
    if (!FOREGROUND.has(category)) throw new Error(`LOOP_BBOX_SVG_INVALID_TOP_CATEGORY:${id}:${category}`);
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => !Number.isInteger(Number(value))))
      throw new Error(`LOOP_BBOX_SVG_INVALID_NORMALIZED_BBOX:${id}`);
    const [x, y, boxWidth, boxHeight] = bbox.map(Number);
    if (x < 0 || y < 0 || boxWidth <= 0 || boxHeight <= 0 || x + boxWidth > 1000 || y + boxHeight > 1000)
      throw new Error(`LOOP_BBOX_SVG_BBOX_OUT_OF_CANVAS:${id}`);
    if (item?.p !== null && item?.p !== undefined && String(item.p) !== "") {
      const parentId = String(item.p);
      if (!/^[a-z0-9_]+$/.test(parentId) || parentId === id)
        throw new Error(`LOOP_BBOX_SVG_INVALID_PARENT_ID:${id}:${parentId}`);
      rawParents.set(id, parentId);
    }
  }
  const compactRepairMode = Array.isArray(payload.analysis.r)
    ? payload.analysis.r[0]
    : payload.analysis.background_repair?.mode;
  const explicitSceneOnlyTerminal =
    payload.analysis.b.length === 0 &&
    String(compactRepairMode || "").toLowerCase() === "scene";
  const validated = await validateSvgGuide(payload.svg.trim(), width, height, {
    // Only the explicit empty-bbox terminal response gets this exception.
    // All non-terminal loops still reject missing SVG component metadata.
    allowUnannotatedDrawingGroups: explicitSceneOnlyTerminal,
  });
  if (validated.coordinateSpace !== "gemini_xywh_1000")
    throw new Error(`LOOP_BBOX_SVG_DOCUMENT_COORDINATE_FORMAT:${validated.coordinateSpace}`);
  const invalidKindNode = validated.nodes.find((node) => !ALLOWED.has(String(node.kind).toLowerCase()));
  if (invalidKindNode)
    throw new Error(`LOOP_BBOX_SVG_INVALID_NODE_KIND:${invalidKindNode.id}:${invalidKindNode.kind}`);
  const legacyCoordinateNode = validated.nodes.find(
    (node) => node.bboxFormat !== "separate_xywh_attributes",
  );
  if (legacyCoordinateNode)
    throw new Error(`LOOP_BBOX_SVG_NODE_COORDINATE_FORMAT:${legacyCoordinateNode.id}:${legacyCoordinateNode.bboxFormat}`);
  const missingTopFlagNode = validated.nodes.find((node) => node.top === null);
  if (missingTopFlagNode)
    throw new Error(`LOOP_BBOX_SVG_NODE_TOP_FLAG_MISSING:${missingTopFlagNode.id}`);
  const missingComponentFlagNode = validated.nodes.find((node) => node.component === null);
  if (missingComponentFlagNode)
    throw new Error(`LOOP_BBOX_SVG_NODE_COMPONENT_FLAG_MISSING:${missingComponentFlagNode.id}`);
  const svgTopIds = new Set(validated.nodes.filter((node) => node.top).map((node) => String(node.id)));
  // A top-layer bbox may legitimately be a supporting surface after its
  // foreground children have already been removed (for example an empty
  // sidebar, panel, or slot). `data-component` records inventory phase, while
  // `data-top` records the current extraction pass; the latter is authoritative
  // for synchronization and must not require component=1.
  const topMissingFromBbox = [...svgTopIds].filter((id) => !rawIds.has(id));
  const bboxNotMarkedTop = [...rawIds].filter((id) => !svgTopIds.has(id));
  if (topMissingFromBbox.length || bboxNotMarkedTop.length)
    throw new Error(
      `LOOP_BBOX_SVG_TOP_SET_MISMATCH:missing_bbox=${topMissingFromBbox.join(",") || "none"}:bbox_not_top=${bboxNotMarkedTop.join(",") || "none"}`,
    );
  // The synchronized response uses a 1000x1000 coordinate space even when
  // the source image is smaller. Convert before normalizeDetection clamps to
  // the source bounds; otherwise a lower/right coordinate such as y=954 on a
  // 933px image is truncated before it is scaled and no longer matches SVG.
  const detection = normalizeDetection(
    mapSynchronizedAnalysisToPixels(payload.analysis, width, height),
    width,
    height,
  );
  if (detection.boxes.length !== payload.analysis.b.length)
    throw new Error("LOOP_BBOX_SVG_NORMALIZATION_CHANGED_BBOX_COUNT");
  const svgNodeIds = new Set(validated.nodes.map((node) => String(node.id)));
  const parentRepairs = [];
  for (const box of detection.boxes) {
    box.svg_parent_id = rawParents.get(box.id) || null;
    if (box.svg_parent_id) {
      if (!svgNodeIds.has(box.svg_parent_id))
        throw new Error(`LOOP_BBOX_SVG_PARENT_NODE_MISSING:${box.id}:${box.svg_parent_id}`);
      const parent = validated.nodes.find((node) => String(node.id) === String(box.svg_parent_id));
      if (parent && !svgBoxContainsCenter(parent.bbox, box.bbox)) {
        parentRepairs.push({
          child_id: String(box.id),
          requested_parent_id: String(box.svg_parent_id),
          child_bbox: box.bbox,
          parent_bbox: parent.bbox,
          action: "cleared_parent_outside_child_center",
        });
        // A wrong parent relation must not invalidate an otherwise usable
        // bbox/SVG pair. The child remains a valid top-level extraction node;
        // only the impossible ownership edge is removed.
        box.svg_parent_id = null;
      }
    }
  }
  const sync = validateLoopBboxSvgSync(validated.nodes, detection, validated.svg);
  sync.parent_repairs = parentRepairs;
  sync.coordinate_boundary_repairs = boundaryRepair.repairs;
  sync.svg_kind_repairs = kindRepair.repairs;
  sync.svg_top_count = svgTopIds.size;
  sync.svg_component_count = validated.nodes.filter((node) => node.component === true).length;
  sync.scene_only_terminal = explicitSceneOnlyTerminal;
  sync.all_svg_top_nodes_in_bbox = true;
  sync.all_bbox_nodes_marked_top = true;
  detection.loop = loopNumber;
  detection.scene_only_terminal = explicitSceneOnlyTerminal;
  detection.source = path.resolve(source);
  detection.bbox_mode = "synchronized_bbox_svg";
  detection.bbox_strategy = "single_request_top_bbox_plus_full_scene_svg";
  detection.bbox_controller_model = controllerModel;
  detection.bbox_reasoning_effort = request.reasoning_effort || null;
  detection.coordinate_protocol = {
    model_space: "gemini_xywh_1000",
    model_canvas: [1000, 1000],
    pixel_canvas: [width, height],
    scale: { x: width / 1000, y: height / 1000 },
  };
  detection.model_response = {
    finish_reason: finishReason,
    synchronized_svg: true,
    request_count: 1,
    request_attempts: requestAttempts,
    json_repaired: jsonRepaired,
    repair_reason: repairReason,
  };
  detection.model_input = {
    source: path.resolve(source),
    coordinate_reference: coordinateReferencePath,
    canvas: { width, height },
    original_canvas: { width, height },
  };
  detection.svg_sync = sync;
  detection.parent_repairs = parentRepairs;
  detection.coordinate_boundary_repairs = boundaryRepair.repairs;
  detection.svg_kind_repairs = kindRepair.repairs;
  await fsp.writeFile(svgPath, validated.svg, "utf8");
  await sharp(Buffer.from(validated.svg)).png().toFile(previewPath);
  const topBboxReviewPath = path.join(loopDir, "scene_top_bbox_review.png");
  await drawReview(
    previewPath,
    {
      boxes: validated.nodes
        .filter((node) => node.top === true)
        .map((node) => ({
          id: node.id,
          label: node.label,
          category: node.kind,
          bbox: node.bbox,
          z_index: node.z,
        })),
    },
    topBboxReviewPath,
    { includeText: false, showLabels: true, colorByDepth: false },
  );
  await fsp.writeFile(analysisPath, JSON.stringify(detection, null, 2), "utf8");
  await fsp.writeFile(syncPath, JSON.stringify(sync, null, 2), "utf8");
  await fsp.writeFile(parentRepairPath, JSON.stringify({ loop: loopNumber, repairs: parentRepairs }, null, 2), "utf8");
  await fsp.writeFile(
    sceneJsonPath,
    JSON.stringify({ canvas: [width, height], nodes: validated.nodes, sync }, null, 2),
    "utf8",
  );
  return {
    detection,
    sync,
    svgGuide: {
      enabled: true,
      model: controllerModel,
      source: path.resolve(source),
      coordinateReferencePath,
      requestPath,
      rawPath,
      responseMetaPath,
      repairedResponsePath: jsonRepaired ? repairedResponsePath : null,
      analysisPath,
      syncPath,
      parentRepairPath,
      coordinateRepairPath: boundaryRepair.repairs.length ? coordinateRepairPath : null,
      kindRepairPath: kindRepair.repairs.length ? kindRepairPath : null,
      sceneJsonPath,
      svgPath,
      previewPath,
      topBboxReviewPath,
      svg: validated.svg,
      nodes: validated.nodes,
      hiddenIds: new Set(),
      loop: loopNumber,
    },
  };
}

async function generateTextBboxSvgBundle(source, textDir, width, height, signal, model = DEFAULT_BBOX_CONTROLLER_MODEL) {
  const controllerModel = normalizeControllerModel(model);
  const coordinateReferencePath = path.join(textDir, "text_coordinate_reference.png");
  const requestPath = path.join(textDir, "text_bbox_svg_request.json");
  const rawPath = path.join(textDir, "text_bbox_svg_raw_response.txt");
  const responseMetaPath = path.join(textDir, "text_bbox_svg_response_meta.json");
  const repairedResponsePath = path.join(textDir, "text_bbox_svg_repaired_response.json");
  const analysisPath = path.join(textDir, "detection.json");
  const syncPath = path.join(textDir, "text_bbox_svg_sync.json");
  const coordinateRepairPath = path.join(textDir, "text_bbox_svg_coordinate_repairs.json");
  const kindRepairPath = path.join(textDir, "text_bbox_svg_kind_repairs.json");
  const svgPath = path.join(textDir, "text_scene.svg");
  const previewPath = path.join(textDir, "text_scene.png");
  const sceneJsonPath = path.join(textDir, "text_scene.json");
  const reviewPath = path.join(textDir, "text_bbox_review.png");
  await makeCoordinateReferenceImage(source, coordinateReferencePath, width, height);
  const prompt = TEXT_BBOX_SVG_PROMPT
    .replaceAll("IMAGE_WIDTH", String(width))
    .replaceAll("IMAGE_HEIGHT", String(height));
  const messages = [
    {
      role: "system",
      // Keep the system instruction identical to the recursive loop. The only
      // pass-specific rule is in the user prompt: text is the current top
      // layer, while every non-text inventory component is data-top="0".
      content: "You are a strict synchronized UI scene annotator. Image 1 is pixel truth; Image 2 is an aligned coordinate reference only. One response must contain a top-layer bbox subset and a complete full-scene SVG using identical shared ids and coordinates.",
    },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl(source), detail: "high" } },
        { type: "image_url", image_url: { url: dataUrl(coordinateReferencePath), detail: "high" } },
        { type: "text", text: prompt },
      ],
    },
  ];
  const request = {
    model: controllerModel,
    response_format: { type: "json_object" },
    max_completion_tokens: SVG_GUIDE_MAX_COMPLETION_TOKENS,
    ...(controllerModel === "gpt-6-astra" ? { reasoning_effort: "high" } : {}),
    messages,
  };
  await fsp.writeFile(
    requestPath,
    JSON.stringify({
      endpoint: "chat.completions.create",
      model: controllerModel,
      prompt_variant: "synchronized_loop_full_scene_text_top_layer",
      prompt_policy: "same_full_scene_inventory_as_recursive_loop; only_data_top_subset_is_ordinary_text",
      source_image: path.resolve(source),
      canvas: [width, height],
      request: {
        ...request,
        messages: messages.map((message) => ({
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((item, index) => item.type === "image_url"
              ? {
                  type: "image_url",
                  image_url: {
                    file: path.resolve(index === 0 ? source : coordinateReferencePath),
                    detail: item.image_url.detail,
                  },
                }
              : item)
            : message.content,
        })),
      },
    }, null, 2),
    "utf8",
  );
  const client = openaiClient("controller");
  let requestAttempts = 0;
  const response = await retry(
    () => {
      requestAttempts += 1;
      return client.chat.completions.create(request, signal ? { signal } : undefined);
    },
    "synchronized text bbox+SVG",
  );
  const content = String(response?.choices?.[0]?.message?.content || "").trim();
  const finishReason = response?.choices?.[0]?.finish_reason || null;
  await fsp.writeFile(rawPath, content, "utf8");
  await fsp.writeFile(
    responseMetaPath,
    JSON.stringify({
      finish_reason: finishReason,
      content_length: content.length,
      request_attempts: requestAttempts,
      extra_escape_layer_decoded: false,
      json_repaired: false,
      repair_reason: null,
      usage: response?.usage || null,
    }, null, 2),
    "utf8",
  );
  if (finishReason === "length") throw new Error("TEXT_BBOX_SVG_RESPONSE_TRUNCATED");
  let payload;
  let parsedBundle;
  try {
    parsedBundle = parseSynchronizedBundleJson(content);
    payload = parsedBundle.value;
    if (parsedBundle.repairedText) {
      await fsp.writeFile(
        repairedResponsePath,
        parsedBundle.repairedText,
        "utf8",
      );
    }
  } catch (error) {
    await fsp.writeFile(
      responseMetaPath,
      JSON.stringify({
        finish_reason: finishReason,
        content_length: content.length,
        request_attempts: requestAttempts,
        usage: response?.usage || null,
        extra_escape_layer_decoded: false,
        json_repaired: false,
        parse_error: String(error?.message || error),
      }, null, 2),
      "utf8",
    );
    throw new Error(`TEXT_BBOX_SVG_INVALID_JSON:${String(error?.message || error)}`);
  }
  if (parsedBundle.extraEscapeLayer || parsedBundle.repaired) {
    await fsp.writeFile(
      responseMetaPath,
      JSON.stringify({
        finish_reason: finishReason,
        content_length: content.length,
        request_attempts: requestAttempts,
        usage: response?.usage || null,
        extra_escape_layer_decoded: parsedBundle.extraEscapeLayer,
        json_repaired: parsedBundle.repaired === true,
        repair_reason: parsedBundle.repairReason || null,
      }, null, 2),
      "utf8",
    );
  }
  if (!payload?.analysis || typeof payload.analysis !== "object" || !Array.isArray(payload.analysis.b))
    throw new Error("TEXT_BBOX_SVG_ANALYSIS_MISSING");
  if (typeof payload.svg !== "string") throw new Error("TEXT_BBOX_SVG_DOCUMENT_MISSING");
  if (Object.keys(payload).length !== 2 || !("analysis" in payload) || !("svg" in payload))
    throw new Error("TEXT_BBOX_SVG_OUTER_SHAPE_MISMATCH");
  if (!Array.isArray(payload.analysis.c) || Number(payload.analysis.c[0]) !== 1000 || Number(payload.analysis.c[1]) !== 1000)
    throw new Error("TEXT_BBOX_SVG_ANALYSIS_CANVAS_MISMATCH");
  if (String(payload.analysis.coord || "") !== "gemini_xywh_1000")
    throw new Error("TEXT_BBOX_SVG_COORDINATE_FORMAT_MISMATCH");
  const kindRepair = normalizeSynchronizedSvgKinds(payload);
  payload = kindRepair.value;
  if (kindRepair.repairs.length) {
    await fsp.writeFile(
      kindRepairPath,
      JSON.stringify({ loop: 0, repairs: kindRepair.repairs }, null, 2),
      "utf8",
    );
    const responseMeta = JSON.parse(await fsp.readFile(responseMetaPath, "utf8"));
    responseMeta.svg_kind_repairs = kindRepair.repairs;
    await fsp.writeFile(responseMetaPath, JSON.stringify(responseMeta, null, 2), "utf8");
  }
  const boundaryRepair = repairSynchronizedNormalizedBounds(payload);
  payload = boundaryRepair.value;
  if (boundaryRepair.repairs.length) {
    await fsp.writeFile(
      coordinateRepairPath,
      JSON.stringify({ loop: 0, repairs: boundaryRepair.repairs }, null, 2),
      "utf8",
    );
    const responseMeta = JSON.parse(await fsp.readFile(responseMetaPath, "utf8"));
    responseMeta.coordinate_boundary_repairs = boundaryRepair.repairs;
    await fsp.writeFile(responseMetaPath, JSON.stringify(responseMeta, null, 2), "utf8");
  }
  const rawIds = new Set();
  for (const item of payload.analysis.b) {
    const id = String(item?.i || "");
    const category = String(item?.k || "").toLowerCase();
    const bbox = item?.b;
    if (!/^[a-z0-9_]+$/.test(id))
      throw new Error(`TEXT_BBOX_SVG_INVALID_SHARED_ID:${id || "missing"}`);
    if (rawIds.has(id)) throw new Error(`TEXT_BBOX_SVG_DUPLICATE_SHARED_ID:${id}`);
    rawIds.add(id);
    if (category !== "text") throw new Error(`TEXT_BBOX_SVG_INVALID_CATEGORY:${id}:${category}`);
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => !Number.isInteger(Number(value))))
      throw new Error(`TEXT_BBOX_SVG_INVALID_NORMALIZED_BBOX:${id}`);
    const [x, y, boxWidth, boxHeight] = bbox.map(Number);
    if (x < 0 || y < 0 || boxWidth <= 0 || boxHeight <= 0 || x + boxWidth > 1000 || y + boxHeight > 1000)
      throw new Error(`TEXT_BBOX_SVG_BBOX_OUT_OF_CANVAS:${id}`);
  }
  const validated = await validateSvgGuide(payload.svg.trim(), width, height);
  if (validated.coordinateSpace !== "gemini_xywh_1000")
    throw new Error(`TEXT_BBOX_SVG_DOCUMENT_COORDINATE_FORMAT:${validated.coordinateSpace}`);
  const backgroundNode = validated.nodes.find((node) => String(node.id) === "scene_background");
  if (!backgroundNode || String(backgroundNode.kind).toLowerCase() !== "background")
    throw new Error("TEXT_BBOX_SVG_SCENE_BACKGROUND_MISSING");
  const invalidKindNode = validated.nodes.find((node) => !ALLOWED.has(String(node.kind).toLowerCase()));
  if (invalidKindNode)
    throw new Error(`TEXT_BBOX_SVG_INVALID_NODE_KIND:${invalidKindNode.id}:${invalidKindNode.kind}`);
  const missingTopFlagNode = validated.nodes.find((node) => node.top === null);
  if (missingTopFlagNode)
    throw new Error(`TEXT_BBOX_SVG_NODE_TOP_FLAG_MISSING:${missingTopFlagNode.id}`);
  const missingComponentFlagNode = validated.nodes.find((node) => node.component === null);
  if (missingComponentFlagNode)
    throw new Error(`TEXT_BBOX_SVG_NODE_COMPONENT_FLAG_MISSING:${missingComponentFlagNode.id}`);
  const svgTopIds = new Set(validated.nodes.filter((node) => node.top).map((node) => String(node.id)));
  const topMissingFromBbox = [...svgTopIds].filter((id) => !rawIds.has(id));
  const bboxNotMarkedTop = [...rawIds].filter((id) => !svgTopIds.has(id));
  if (topMissingFromBbox.length || bboxNotMarkedTop.length)
    throw new Error(
      `TEXT_BBOX_SVG_TOP_SET_MISMATCH:missing_bbox=${topMissingFromBbox.join(",") || "none"}:bbox_not_top=${bboxNotMarkedTop.join(",") || "none"}`,
    );
  const detection = normalizeDetection(
    mapSynchronizedAnalysisToPixels(payload.analysis, width, height),
    width,
    height,
  );
  if (detection.boxes.length !== payload.analysis.b.length)
    throw new Error("TEXT_BBOX_SVG_NORMALIZATION_CHANGED_BBOX_COUNT");
  const byId = new Map(validated.nodes.map((node) => [String(node.id), node]));
  const matches = [];
  for (const box of detection.boxes) {
    const node = byId.get(String(box.id));
    if (!node) throw new Error(`TEXT_BBOX_SVG_NODE_MISSING:${box.id}`);
    if (String(node.kind).toLowerCase() !== "text")
      throw new Error(`TEXT_BBOX_SVG_KIND_MISMATCH:${box.id}:${node.kind}`);
    if (!svgBoxEncloses(node.bbox, box.bbox))
      throw new Error(`TEXT_BBOX_SVG_BBOX_NOT_ENCLOSED:${box.id}`);
    const body = svgGroupBody(validated.svg, node.id);
    if (!body || !/<(?:path|rect|circle|ellipse|polygon|polyline|line|text)\b/i.test(body))
      throw new Error(`TEXT_BBOX_SVG_NODE_HAS_NO_PRIMITIVE:${box.id}`);
    if (hasAnnotatedNestedSvgGroup(body))
      throw new Error(`TEXT_BBOX_SVG_REMOVABLE_NODE_NOT_LEAF:${box.id}`);
    // The compact analysis carries the model's best OCR/style estimate, while
    // the SVG text primitive is the authoritative synchronized fallback. This
    // keeps PSD text editable even when the model omitted optional tx/fs/fc
    // fields from the compact bbox object.
    const svgText = extractSvgTextProperties(validated.svg, node);
    if (svgText) {
      if (svgText.text && (!box.text_content || box.text_content === box.label || box.text_content === box.id))
        box.text_content = svgText.text;
      if (svgText.fontFamily && (!box.text_font_family || box.text_font_family === "ArialMT"))
        box.text_font_family = svgText.fontFamily;
      if (!box.text_font_size && svgText.fontSize)
        box.text_font_size = svgText.fontSize * (Number(height) / 1000);
      if (!box.text_fill_color && svgText.fillColor) box.text_fill_color = svgText.fillColor;
      if (svgText.bold) box.text_bold = true;
      if (svgText.italic) box.text_italic = true;
      if (svgText.align && box.text_align === "left") box.text_align = svgText.align;
      box.text_svg = svgText;
    }
    matches.push({
      layer_id: String(box.id),
      node_id: node.id,
      node_label: node.label,
      node_bbox: node.bbox,
      layer_bbox: box.bbox,
      coverage: 1,
      semantic_match: true,
      source_node_id: null,
      match_mode: "paired_text_id",
    });
  }
  const sync = {
    bbox_count: matches.length,
    svg_node_count: validated.nodes.length,
    synchronized_count: matches.length,
    all_bbox_nodes_present: true,
    all_bbox_nodes_enclose_bbox: true,
    all_svg_top_nodes_in_bbox: true,
    all_bbox_nodes_marked_top: true,
    matches,
    coordinate_boundary_repairs: boundaryRepair.repairs,
    svg_kind_repairs: kindRepair.repairs,
  };
  detection.loop = 0;
  detection.source = path.resolve(source);
  detection.bbox_controller_model = controllerModel;
  detection.bbox_reasoning_effort = request.reasoning_effort || null;
  detection.bbox_method = "synchronized_text_bbox_svg";
  detection.model_response = {
    finish_reason: finishReason,
    synchronized_svg: true,
    request_count: 1,
    request_attempts: requestAttempts,
    json_repaired: parsedBundle.repaired === true,
    repair_reason: parsedBundle.repairReason || null,
  };
  detection.model_input = {
    source: path.resolve(source),
    coordinate_reference: coordinateReferencePath,
    canvas: { width, height },
  };
  detection.svg_sync = sync;
  detection.coordinate_boundary_repairs = boundaryRepair.repairs;
  detection.svg_kind_repairs = kindRepair.repairs;
  await fsp.writeFile(svgPath, validated.svg, "utf8");
  await sharp(Buffer.from(validated.svg)).png().toFile(previewPath);
  await drawReview(source, detection, reviewPath, {
    includeText: true,
    showLabels: true,
    colorByDepth: false,
  });
  await fsp.writeFile(analysisPath, JSON.stringify(detection, null, 2), "utf8");
  await fsp.writeFile(syncPath, JSON.stringify(sync, null, 2), "utf8");
  await fsp.writeFile(
    sceneJsonPath,
    JSON.stringify({ canvas: [width, height], nodes: validated.nodes, sync }, null, 2),
    "utf8",
  );
  const state = {
    svg: validated.svg,
    nodes: validated.nodes,
    svgPath,
    previewPath,
    hiddenIds: new Set(),
  };
  const residual = await renderRequiredResidualGuide(
    state,
    textDir,
    0,
    matches,
    width,
    height,
  );
  return {
    detection,
    sync,
    svgGuide: {
      ...residual,
      scenePath: svgPath,
      scenePreview: previewPath,
      coordinateReferencePath,
      requestPath,
      rawPath,
      responseMetaPath,
      coordinateRepairPath: boundaryRepair.repairs.length ? coordinateRepairPath : null,
      kindRepairPath: kindRepair.repairs.length ? kindRepairPath : null,
      repairedResponsePath: parsedBundle.repaired === true ? repairedResponsePath : null,
      sceneJsonPath,
      reviewPath,
    },
  };
}

async function generateTextBboxOnlyDetection(
  source,
  textDir,
  controllerModel,
  useOriginalGeminiImage,
  signal,
) {
  const modelInputPath = path.join(textDir, "text_bbox_model_source.jpg");
  const modelPreview = await prepareBboxVisionImage(source, modelInputPath, {
    compress: !useOriginalGeminiImage,
  });
  const requestPath = path.join(textDir, "text_bbox_request.json");
  const reviewPath = path.join(textDir, "text_bbox_review.png");
  const analysisPath = path.join(textDir, "detection.json");
  const detection = await analyzeBboxes(
    source,
    null,
    controllerModel,
    0,
    signal,
    {
      source: modelPreview.path,
      compactResponse: true,
      analysisPrompt: INITIAL_TEXT_BBOX_PROMPT,
      reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
      imageDetail: "high",
      maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 8192 : null,
      requestLog: requestPath,
    },
  );
  const invalid = detection.boxes.find(
    (box) => String(box.category || "").toLowerCase() !== "text",
  );
  if (invalid)
    throw new Error(`TEXT_BBOX_INVALID_CATEGORY:${invalid.id}:${invalid.category}`);
  detection.bbox_method = "text_bbox_only_no_svg";
  detection.svg_guide_enabled = false;
  detection.svg_guide = null;
  await drawReview(source, detection, reviewPath, {
    includeText: true,
    showLabels: true,
    colorByDepth: false,
  });
  await fsp.writeFile(analysisPath, JSON.stringify(detection, null, 2), "utf8");
  return {
    detection,
    modelInput: modelPreview.path,
    requestPath,
    reviewPath,
    analysisPath,
  };
}

async function renderRequiredResidualGuide(state, loopDir, loopNumber, matches, width, height) {
  const ids = [
    ...state.hiddenIds,
    ...matches.flatMap((item) => [item.node_id, item.source_node_id].filter(Boolean)),
  ];
  const svg = removeSvgGroups(state.svg, ids);
  const residualPath = path.join(loopDir, "svg_residual.svg");
  const previewPath = path.join(loopDir, "svg_residual.png");
  await validateSvgGuide(svg, width, height);
  await fsp.writeFile(residualPath, svg, "utf8");
  await sharp(Buffer.from(svg)).png().toFile(previewPath);
  for (const id of matches.flatMap((item) => [item.node_id, item.source_node_id].filter(Boolean)))
    state.hiddenIds.add(id);
  await fsp.writeFile(
    path.join(loopDir, "svg_match.json"),
    JSON.stringify({
      loop: loopNumber,
      hidden_ids: [...state.hiddenIds],
      removed_ids: [...new Set(ids)],
      matches,
      paired_model_nodes: matches.filter((item) => item.match_mode === "paired_model_id").length,
      native_source_nodes_removed: matches.filter((item) => item.source_node_id).length,
    }, null, 2),
    "utf8",
  );
  return {
    scenePath: state.svgPath,
    svgPath: residualPath,
    png: previewPath,
    hiddenIds: [...state.hiddenIds],
    matches,
  };
}
async function prepareBboxVisionImage(source, output, options = {}) {
  const sourceMeta = await sharp(source).metadata();
  const sourceWidth = Number(sourceMeta.width);
  const sourceHeight = Number(sourceMeta.height);
  if (!sourceWidth || !sourceHeight)
    throw new Error(`invalid bbox source image: ${source}`);
  // Gemini can accept the full-resolution screenshot in this deployment. When
  // requested, keep the exact source path/bytes so bbox coordinates are based
  // on the original canvas rather than a resized JPEG preview.
  if (options.compress === false || options.original === true) {
    const sourcePath = path.resolve(source);
    return {
      path: sourcePath,
      width: sourceWidth,
      height: sourceHeight,
      source_width: sourceWidth,
      source_height: sourceHeight,
      scale: 1,
      bytes: (await fsp.stat(sourcePath)).size,
      compressed: false,
    };
  }
  const scale = Math.min(
    1,
    BBOX_VISION_MAX_SIDE / Math.max(sourceWidth, sourceHeight),
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  await sharp(source)
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .jpeg({
      quality: BBOX_VISION_JPEG_QUALITY,
      chromaSubsampling: "4:4:4",
      mozjpeg: true,
    })
    .toFile(output);
  return {
    path: path.resolve(output),
    width,
    height,
    source_width: sourceWidth,
    source_height: sourceHeight,
    scale,
    bytes: (await fsp.stat(output)).size,
    compressed: true,
  };
}
function parseJsonDetailed(text) {
  let value = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  value = value.slice(start, end + 1);
  try {
    return { value: JSON.parse(value), repaired: false, repairedText: null };
  } catch (originalError) {
    try {
      const repairedText = jsonrepair(value);
      return {
        value: JSON.parse(repairedText),
        repaired: true,
        repairedText,
        originalError: String(originalError.message || originalError),
      };
    } catch (repairError) {
      throw new Error(
        `model returned invalid JSON and automatic repair failed: ${String(repairError.message || repairError)}`,
        { cause: originalError },
      );
    }
  }
}
function parseJson(text) {
  return parseJsonDetailed(text).value;
}
function normalizeBackgroundSemanticGuide(value, targets) {
  const guide = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const scene = String(guide?.scene || "").trim();
  const preserveVisible = Array.isArray(guide?.preserve_visible)
    ? guide.preserve_visible.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const holes = Array.isArray(guide?.holes) ? guide.holes : [];
  const byId = new Map();
  for (const item of holes) {
    const id = String(item?.id || "").trim();
    if (!id || byId.has(id)) continue;
    if (item.depth_relations != null && !Array.isArray(item.depth_relations))
      throw new Error(`BACKGROUND_SEMANTIC_DEPTH_RELATIONS_INVALID_${id}`);
    const depthRelations = Array.isArray(item.depth_relations) ? item.depth_relations.map((relation) => ({
      front: String(relation?.front || "").trim(),
      behind: String(relation?.behind || "").trim(),
      evidence: String(relation?.evidence || "").trim(),
      ...(relation?.front_id ? { front_id: String(relation.front_id) } : {}),
      ...(relation?.behind_id ? { behind_id: String(relation.behind_id) } : {}),
    })) : [];
    if (depthRelations.some(({ front, behind, evidence }) => !front || !behind || !evidence || front === behind))
      throw new Error(`BACKGROUND_SEMANTIC_DEPTH_RELATION_INVALID_${id}`);
    byId.set(id, {
      id,
      remove: String(item.remove || "").trim(),
      continue_behind: String(item.continue_behind || "").trim(),
      keep_edges: String(item.keep_edges || "").trim(),
      depth_relations: depthRelations,
      continue_component_ids: item.continue_component_ids || [],
      keep_component_ids: item.keep_component_ids || [],
    });
  }
  const expected = targets.map((target) => String(target.id));
  if (!scene || !preserveVisible.length || byId.size !== expected.length ||
    expected.some((id) => !byId.has(id) ||
      !byId.get(id).remove || !byId.get(id).continue_behind || !byId.get(id).keep_edges))
    throw new Error("BACKGROUND_SEMANTIC_GUIDE_INCOMPLETE");
  // The analyst can describe completion, but cannot add deletion targets.
  return { scene, preserve_visible: preserveVisible,
    retained_components: guide.retained_components || [],
    grounding: guide.grounding || null,
    holes: targets.map((target) => ({ ...byId.get(String(target.id)),
      remove: String(target.description || target.name || target.id).trim(),
    })) };
}
function backgroundSemanticPixelCoordinates(value, width, height) {
  if (value?.coordinate_space !== "normalized_1000")
    throw new Error('BACKGROUND_SEMANTIC_COORDINATE_SPACE: declare coordinate_space="normalized_1000"; do not mix original, resized or atlas pixels');
  if (!Array.isArray(value.retained_components))
    throw new Error("BACKGROUND_SEMANTIC_GROUNDING_FAILED: retained_components must be an array");
  const inRange = (items, size) => Array.isArray(items) && items.length === size &&
    items.every(n => Number.isFinite(n) && n >= 0 && n <= 1000);
  const errors = [];
  const components = value.retained_components.map(component => {
    const box = component.bbox;
    if (!inRange(box, 4) || box[2] <= 0 || box[3] <= 0 ||
        box[0] + box[2] > 1000 || box[1] + box[3] > 1000)
      errors.push(`Component ${component.id}: bbox must use whole-image normalized [x,y,width,height] within 0..1000`);
    if (!Array.isArray(component.evidence_points) || component.evidence_points.length < 2)
      errors.push(`Component ${component.id}: provide at least TWO distinct evidence_points and TWO matching evidence_rgb samples; one point is insufficient`);
    else if (component.evidence_points.some(point => !inRange(point, 2)))
      errors.push(`Component ${component.id}: evidence_points must use whole-image normalized x,y within 0..1000`);
    if (!Array.isArray(component.evidence_rgb) || component.evidence_rgb.length !== component.evidence_points?.length ||
        component.evidence_rgb.some(rgb => !Array.isArray(rgb) || rgb.length !== 3 ||
          rgb.some(n => !Number.isInteger(n) || n < 0 || n > 255)))
      errors.push(`Component ${component.id}: provide matching approximate RGB for every evidence point`);
    if (errors.some(error => error.startsWith(`Component ${component.id}:`))) return null;
    const left = Math.floor(box[0] * width / 1000), top = Math.floor(box[1] * height / 1000);
    const right = Math.min(width, Math.ceil((box[0] + box[2]) * width / 1000));
    const bottom = Math.min(height, Math.ceil((box[1] + box[3]) * height / 1000));
    return { ...component, bbox: [left, top, right - left, bottom - top],
      evidence_points: component.evidence_points.map(([x, y]) =>
        [Math.min(width - 1, Math.floor(x * width / 1000)), Math.min(height - 1, Math.floor(y * height / 1000))]),
      geometry: { kind: "freeform" } };
  });
  if (errors.length) throw new Error(`BACKGROUND_SEMANTIC_COORDINATE_SPACE: ${errors.join("; ")}`);
  return { ...value, coordinate_space: "source_pixels", retained_components: components };
}
function groundBackgroundSemanticGuide(value, targets, allTargets, residual, namespace = "") {
  const { width, height, channels } = residual.info;
  if (channels !== 4) throw new Error("BACKGROUND_SEMANTIC_GROUNDING_RGBA_REQUIRED");
  const removedIds = new Set(allTargets.map((target) => String(target.id)));
  const errors = [];
  const components = new Map();
  if (!Array.isArray(value?.retained_components) || !value.retained_components.length)
    throw new Error("BACKGROUND_SEMANTIC_GROUNDING_FAILED: retained_components is empty");
  for (const raw of value.retained_components) {
    const id = String(raw?.id || "").trim();
    const description = String(raw?.description || "").trim();
    const bbox = Array.isArray(raw?.bbox) ? raw.bbox.map(Number) : [];
    const points = Array.isArray(raw?.evidence_points) ? raw.evidence_points : [];
    if (!id || !description || components.has(id) || removedIds.has(id)) {
      errors.push(`Component ${id || "(missing id)"}: use a unique retained id and description; removed target ids are forbidden`);
      continue;
    }
    if (bbox.length !== 4 || !bbox.every(Number.isInteger) || bbox[0] < 0 || bbox[1] < 0 ||
        bbox[2] < 1 || bbox[3] < 1 || bbox[0] + bbox[2] > width || bbox[1] + bbox[3] > height) {
      errors.push(`Component ${id}: bbox must be integer [x,y,width,height] within [${width},${height}]`);
      continue;
    }
    if (points.length < 2) errors.push(`Component ${id}: provide at least two distinct visible evidence points`);
    const visiblePoints = [];
    const reportedColors = raw.evidence_rgb;
    const actualColors = [];
    if (reportedColors != null && (!Array.isArray(reportedColors) || reportedColors.length !== points.length))
      errors.push(`Component ${id}: evidence_rgb must match evidence_points`);
    for (const [pointIndex, point] of points.entries()) {
      const valid = Array.isArray(point) && point.length === 2 && point.every(Number.isInteger);
      const [x, y] = valid ? point : [-1, -1];
      if (!valid || x < bbox[0] || x >= bbox[0] + bbox[2] || y < bbox[1] || y >= bbox[1] + bbox[3]) {
        errors.push(`Component ${id}: point ${JSON.stringify(point)} must lie inside its bbox`);
      } else if (residual.data[(y * width + x) * 4 + 3] < 128) {
        errors.push(`Component ${id}: point [${x},${y}] is a deletion hole, not visible evidence; exclude unsupported components or choose their actual visible pixels`);
      } else {
        const actual = [...residual.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
        const reported = reportedColors?.[pointIndex];
        if (reportedColors != null && (!Array.isArray(reported) || reported.length !== 3 ||
            reported.some(n => !Number.isInteger(n) || n < 0 || n > 255)))
          errors.push(`Component ${id}: invalid evidence_rgb at [${x},${y}]`);
        else if (reported && reported.some((n, channel) => Math.abs(n - actual[channel]) > 64))
          errors.push(`Component ${id}: RGB evidence mismatch at [${x},${y}]: claimed ${JSON.stringify(reported)}, actual ${JSON.stringify(actual)}; correct the coordinate on this component's own visible material, not the backdrop`);
        visiblePoints.push([x, y]);
        actualColors.push(actual);
      }
    }
    if (new Set(visiblePoints.map((point) => point.join(","))).size < 2)
      errors.push(`Component ${id}: fewer than two distinct opaque evidence points`);
    let geometry = { kind: "freeform" };
    const proposed = raw.geometry;
    if (proposed && proposed.kind !== "freeform") {
      const kinds = ["circle", "ellipse", "rectangle", "rounded_rectangle", "line"];
      const center = proposed.center;
      const axes = proposed.axes;
      const contourPoints = proposed.contour_points;
      if (!kinds.includes(proposed.kind) || !Array.isArray(center) || center.length !== 2 ||
          !center.every(Number.isFinite) || !Array.isArray(axes) || axes.length !== 2 ||
          !axes.every((n) => Number.isFinite(n) && n > 0 && n <= Math.max(width, height) * 2) ||
          !Number.isFinite(proposed.rotation_degrees) || !Array.isArray(contourPoints) || contourPoints.length < 3) {
        errors.push(`Component ${id}: regular geometry needs a valid kind, center, positive axes, rotation and at least three visible contour points; otherwise use freeform`);
      } else {
        if (proposed.kind === "circle" && (Math.abs(axes[0] - axes[1]) > 0.5 || proposed.rotation_degrees !== 0))
          errors.push(`Component ${id}: a circle must have equal axes and zero rotation`);
        for (const point of contourPoints) {
          if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) ||
              point[0] < bbox[0] || point[0] >= bbox[0] + bbox[2] ||
              point[1] < bbox[1] || point[1] >= bbox[1] + bbox[3] ||
              residual.data[(point[1] * width + point[0]) * 4 + 3] < 128)
            errors.push(`Component ${id}: contour point ${JSON.stringify(point)} is outside its visible opaque pixels`);
        }
        if (new Set(contourPoints.map((point) => JSON.stringify(point))).size < 3)
          errors.push(`Component ${id}: regular geometry requires three distinct visible contour points`);
        geometry = { kind: proposed.kind, center, axes, rotation_degrees: proposed.rotation_degrees,
          contour_points: contourPoints };
      }
    }
    const maskRole = raw.mask_role || "element";
    if (!["element", "backdrop"].includes(maskRole)) errors.push(`Component ${id}: mask_role must be element or backdrop`);
    components.set(id, { id: `${namespace}${id}`, description, mask_role: maskRole,
      bbox, evidence_points: visiblePoints, evidence_rgb: actualColors, geometry });
  }
  const byHole = new Map();
  for (const hole of Array.isArray(value.holes) ? value.holes : []) {
    const id = String(hole?.id || "");
    if (byHole.has(id)) errors.push(`Duplicate hole ${id}`);
    byHole.set(id, hole);
  }
  const expectedIds = new Set(targets.map((target) => String(target.id)));
  for (const id of byHole.keys()) if (!expectedIds.has(id)) errors.push(`Unexpected hole ${id}`);
  const holes = targets.map((target) => {
    const raw = byHole.get(String(target.id));
    if (!raw) { errors.push(`Missing hole ${target.id}`); return null; }
    const resolveIds = (field) => {
      if (!Array.isArray(raw[field])) { errors.push(`Hole ${target.id}: ${field} must be an array`); return []; }
      return [...new Set(raw[field].map((id) => String(id)))].map((id) => {
        if (!components.has(id)) { errors.push(`Hole ${target.id}: ${field} references unknown/removed component ${id}`); return null; }
        return components.get(id);
      }).filter(Boolean);
    };
    const continuations = resolveIds("continue_component_ids");
    const keeps = resolveIds("keep_component_ids");
    const relations = Array.isArray(raw.depth_relations) ? raw.depth_relations : [];
    const depthRelations = relations.map((relation) => {
      const front = components.get(String(relation?.front_id));
      const behind = components.get(String(relation?.behind_id));
      const evidence = String(relation?.evidence || "").trim();
      if (!front || !behind || front.id === behind.id || !evidence) {
        errors.push(`Hole ${target.id}: each depth relation needs two distinct retained component ids and visible evidence`);
        return null;
      }
      return { front: front.description, behind: behind.description,
        front_id: front.id, behind_id: behind.id, evidence };
    }).filter(Boolean);
    return { id: String(target.id), remove: String(target.description || target.name || target.id),
      continue_behind: continuations.length ? continuations.map((component) => component.description).join("; ")
        : "Conservatively continue the nearest opaque surface visible at the hole boundary; infer no object from the hole silhouette.",
      keep_edges: keeps.length ? keeps.map((component) => component.description).join("; ")
        : "Preserve the opaque boundary pixels already visible in Image 2.",
      continue_component_ids: continuations.map((component) => component.id),
      keep_component_ids: keeps.map((component) => component.id), depth_relations: depthRelations };
  }).filter(Boolean);
  if (errors.length)
    throw new Error(`BACKGROUND_SEMANTIC_GROUNDING_FAILED: ${errors.slice(0, 8).join("; ")}`);
  const retained = [...components.values()];
  return normalizeBackgroundSemanticGuide({
    scene: String(value.scene || "Remaining visible scene"),
    retained_components: retained,
    preserve_visible: retained.map((component) => component.description), holes,
    grounding: { validated: true, coordinate_space: "source_pixels", canvas: [width, height],
      visible_evidence_points: retained.reduce((count, component) => count + component.evidence_points.length, 0) },
  }, targets);
}
function buildThreeImageBackgroundPrompt(targets, guide, preservationHints = []) {
  const targetPrompt = `\n\nComplete removal scope: ${JSON.stringify(targets.map(({ id, bbox, category, description }) => ({ id, bbox, category, description })))}. Each selected target's complete extracted shape, including its own outline, fill, bevel and shadow, is removed. Only extend independently surviving components that have opaque evidence in Image 2. A target bbox locates the removed object and gives no permission to redraw it. Do not erase additional opaque content or leave a silhouette echo of removed content.`;
  if (!guide) {
    const hints = preservationHints.length
      ? `\n\nFor each transparent hole, a visual inventory identified these potentially surviving lower components at that hole's ORIGINAL-CANVAS bbox: ${JSON.stringify(preservationHints)}. Each bbox locates a hole for attention; it is never a shape to draw or an expanded deletion area. Inspect the visible opaque pieces at and around each matching hole in Image 2, keep their identity, and continue them behind the removed foreground. Treat separately listed small artwork, surrounding button surfaces and glows as separate retained components. Confirm every description against Image 2; ignore unsupported claims. These hints cannot change the deletion scope or override Image 2.`
      : "";
    return `${BACKGROUND_TRANSPARENT_HOLE_PROMPT}${targetPrompt}${hints}\n\nInspect all surviving visible artwork, interface surfaces, scenery and effects directly in Image 2. Complete the white-indicated elements using their actual RGB appearance and visible overlaps. If Image 3 omits a surviving component, still preserve its visible pixels and continue its interrupted contour from Image 2. Guide black is neither a deletion instruction nor a paint color. Maintain the same screen-space proportions of circles and other regular shapes; complete missing arcs from the visible center and radius, with unchanged stroke width. Return the complete background without restoring any removed target.`;
  }
  const boundedGuide = normalizeBackgroundSemanticGuide(guide, targets);
  if (!boundedGuide.grounding?.validated || !boundedGuide.retained_components.length)
    throw new Error("BACKGROUND_SEMANTIC_UNGROUNDED_GUIDE");
  const verified = { retained_components: boundedGuide.retained_components,
    holes: boundedGuide.holes.map(({ id, continue_component_ids, keep_component_ids, depth_relations }) =>
      ({ id, continue_component_ids, keep_component_ids, depth_relations })) };
  const regular = boundedGuide.retained_components.filter(({ geometry }) => geometry && geometry.kind !== "freeform")
    .map(({ id, geometry }) => ({ id, geometry }));
  const geometryPrompt = regular.length
    ? `\n\nRegular-contour constraints: ${JSON.stringify(regular)}. These measurements are original-canvas estimates; exact visible RGB edges in Image 2 take priority. Complete each missing portion as part of the SAME regular primitive. For kind=circle, both screen-space diameters must be equal: maintain one center and constant radius around the entire circumference, with concentric inner/outer stroke boundaries. No ellipse, perspective tilt, flattened segment, bulge, wobble or variable stroke width. For other regular kinds preserve their measured axis ratio, orientation and straight/curved edge structure. Scale all coordinates uniformly to the output canvas. Preserve the existing colors and translucent overlap of each component.`
    : "";
  return `${BACKGROUND_TRANSPARENT_HOLE_PROMPT}${geometryPrompt}${targetPrompt}\n\nVerified remaining-component guide: ${JSON.stringify(verified)}. Every component's evidence_points lies on opaque retained pixels. Each hole references only those components for continuation and edge preservation. For an empty continuation list, continue the nearest supported surface without inventing a bounded object. Apply each depth_relations pair with the same edge visibility and transparency shown in Image 2. Complete underlying components before their surviving front components. The opaque pixels and overlap junctions of Image 2 remain authoritative. Check that every removed target stays absent, every opaque component remains visible and every supported crossing retains its front/behind order.`;
}
async function makeBackgroundPreservationAtlas(repairInput, targets, output) {
  const { width, height } = await sharp(repairInput).metadata();
  const columns = Math.max(1, Math.ceil(Math.sqrt(targets.length)));
  const rows = Math.ceil(targets.length / columns);
  const cell = Math.min(320, Math.floor(2048 / Math.max(columns, rows)));
  const overlays = [];
  for (let index = 0; index < targets.length; index++) {
    const [x, y, w, h] = targets[index].bbox;
    const margin = Math.max(60, Math.round(Math.max(w, h) * 0.7));
    const left = Math.max(0, Math.floor(x - margin));
    const top = Math.max(0, Math.floor(y - margin));
    const right = Math.min(width, Math.ceil(x + w + margin));
    const bottom = Math.min(height, Math.ceil(y + h + margin));
    if (right <= left || bottom <= top) continue;
    const image = await sharp(repairInput).extract({ left, top, width: right - left, height: bottom - top })
      .resize(cell - 8, cell - 8, { fit: "contain", background: { r: 50, g: 50, b: 50, alpha: 1 } })
      .png().toBuffer();
    overlays.push({ input: image, left: (index % columns) * cell + 4,
      top: Math.floor(index / columns) * cell + 4 });
  }
  await sharp({ create: { width: columns * cell, height: rows * cell, channels: 4,
    background: { r: 36, g: 36, b: 36, alpha: 1 } } }).composite(overlays).png().toFile(output);
  return output;
}
async function generateBackgroundPreservationHints(repairInput, binaryGuide, targets, loopDir, signal) {
  const requestPath = path.join(loopDir, "background_preservation_request.json");
  const responsePath = path.join(loopDir, "background_preservation_response.json");
  const atlasPath = await makeBackgroundPreservationAtlas(repairInput, targets,
    path.join(loopDir, "background_preservation_atlas.png"));
  const model = BACKGROUND_SEMANTIC_MODEL;
  const prompt = `${BACKGROUND_PRESERVATION_PROMPT} Image 3 has exactly ${targets.length} cells. Return cell entries numbered 1 through ${targets.length} in order.`;
  const request = { endpoint: "chat.completions.create", model, response_format: { type: "json_object" },
    max_completion_tokens: 4096, image_inputs: [repairInput, binaryGuide, atlasPath], prompt,
    cells: targets.map((target, index) => ({ cell: index + 1, target_id: target.id })),
    role: "additive preservation hints only; no coordinates, deletion decisions or coverage gate" };
  await fsp.writeFile(requestPath, JSON.stringify(request, null, 2));
  const started = Date.now();
  try {
    const response = await openaiClient("semantic").chat.completions.create({
      model, response_format: request.response_format, max_completion_tokens: request.max_completion_tokens,
      messages: [{ role: "system", content: "Inspect surviving visible pixels only. Return concise JSON." },
        { role: "user", content: [
          ...request.image_inputs.map(file => ({ type: "image_url", image_url: { url: dataUrl(file), detail: "high" } })),
          { type: "text", text: prompt },
        ] }],
    }, signal ? { signal } : undefined);
    const raw = String(response.choices?.[0]?.message?.content || "");
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed.holes) || parsed.holes.length !== targets.length ||
        parsed.holes.some((hole, index) => hole?.cell !== index + 1 || !Array.isArray(hole.preserve) ||
          hole.preserve.some(item => typeof item !== "string")))
      throw new Error("BACKGROUND_PRESERVATION_INCOMPLETE_CELLS");
    const hints = parsed.holes.flatMap((hole, index) =>
      [...new Set(hole.preserve.map(item => item.trim()).filter(Boolean))].slice(0, 8)
        .map(description => ({ target_id: targets[index].id, bbox: targets[index].bbox,
          description: description.slice(0, 240) })));
    const result = { status: "completed", model, elapsed_ms: Date.now() - started,
      request_count: 1, inspected_cells: parsed.holes.length, hints,
      usage: response.usage || null, raw };
    await fsp.writeFile(responsePath, JSON.stringify(result, null, 2));
    return { ...result, requestPath, responsePath };
  } catch (error) {
    if (signal?.aborted) throw error;
    const result = { status: "unavailable", model, elapsed_ms: Date.now() - started,
      request_count: 1, hints: [], error: String(error.message || error) };
    await fsp.writeFile(responsePath, JSON.stringify(result, null, 2));
    if (hasJobRetryPolicy()) throw error;
    return { ...result, requestPath, responsePath };
  }
}
async function makeBackgroundSemanticContextAtlas(residualInput, targets, output, options = {}) {
  const { width, height } = await sharp(residualInput).metadata();
  const cellSize = 512;
  const inset = 8;
  const columns = Math.min(3, targets.length);
  const rows = Math.ceil(targets.length / columns);
  const cells = [];
  const overlays = [];
  for (let index = 0; index < targets.length; index++) {
    const [x, y, w, h] = targets[index].bbox;
    const padX = Math.max(options.minPadding ?? 64, Math.round(w * (options.paddingScale ?? 0.75)));
    const padY = Math.max(options.minPadding ?? 64, Math.round(h * (options.paddingScale ?? 0.75)));
    const left = Math.max(0, Math.floor(x - padX));
    const top = Math.max(0, Math.floor(y - padY));
    const cropWidth = Math.min(width, Math.ceil(x + w + padX)) - left;
    const cropHeight = Math.min(height, Math.ceil(y + h + padY)) - top;
    const scale = (cellSize - inset * 2) / Math.max(cropWidth, cropHeight);
    const drawWidth = Math.max(1, Math.round(cropWidth * scale));
    const drawHeight = Math.max(1, Math.round(cropHeight * scale));
    const drawX = (index % columns) * cellSize + Math.floor((cellSize - drawWidth) / 2);
    const drawY = Math.floor(index / columns) * cellSize + Math.floor((cellSize - drawHeight) / 2);
    const input = await sharp(residualInput).extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(drawWidth, drawHeight).png().toBuffer();
    overlays.push({ input, left: drawX, top: drawY });
    const evidenceMarkers = [];
    if (options.markEvidence) {
      const marker = Buffer.alloc(9 * 9 * 4);
      for (let py = 0; py < 9; py++) for (let px = 0; px < 9; px++)
        if (Math.abs(px - 4) <= 1 || Math.abs(py - 4) <= 1)
          Buffer.from([255, 0, 255, 255]).copy(marker, (py * 9 + px) * 4);
      const markerPng = await sharp(marker, { raw: { width: 9, height: 9, channels: 4 } }).png().toBuffer();
      for (const [pointIndex, [px, py]] of (targets[index].evidence_points || []).entries()) {
        const ax = drawX + Math.round((px - left) * drawWidth / cropWidth);
        const ay = drawY + Math.round((py - top) * drawHeight / cropHeight);
        overlays.push({ input: markerPng, left: Math.max(0, Math.min(columns * cellSize - 9, ax - 4)),
          top: Math.max(0, Math.min(rows * cellSize - 9, ay - 4)) });
        evidenceMarkers.push({ point_index: pointIndex, source_point: [px, py], atlas_point: [ax, ay] });
      }
    }
    cells.push({ target_id: String(targets[index].id), source_bbox: [left, top, cropWidth, cropHeight],
      atlas_bbox: [drawX, drawY, drawWidth, drawHeight], ...(options.markEvidence ? { evidence_markers: evidenceMarkers } : {}) });
  }
  await sharp({ create: { width: columns * cellSize, height: rows * cellSize, channels: 4,
    background: { r: 36, g: 36, b: 36, alpha: 1 } } }).composite(overlays).png().toFile(output);
  return { image: output, canvas: [columns * cellSize, rows * cellSize], cells };
}
function backgroundOpaqueEvidenceHints(value, residual, errorMessage) {
  const { width, height } = residual.info;
  return (value?.retained_components || []).filter(component =>
    String(errorMessage).includes(`Component ${component.id}:`)).map(component => {
    const bbox = component.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isInteger)) return null;
    const [x, y, w, h] = bbox;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > width || y + h > height) return null;
    const samples = [];
    for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98])
      for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        const px = x + Math.min(w - 1, Math.floor(w * fx));
        const py = y + Math.min(h - 1, Math.floor(h * fy));
        const offset = (py * width + px) * 4;
        if (residual.data[offset + 3] < 128) continue;
        samples.push({ source_point: [px, py], normalized_point: [
          Number(((px + 0.5) * 1000 / width).toFixed(3)), Number(((py + 0.5) * 1000 / height).toFixed(3)),
        ], rgb: [...residual.data.subarray(offset, offset + 3)] });
      }
    return { id: component.id, bbox, opaque_rgb_samples: samples };
  }).filter(Boolean);
}
async function generateBackgroundSemanticGuide(source, repairInput, structureGuide, targets, loopDir, signal, options = {}) {
  let previousRequest = null;
  if (options.reuseResponsesFromDir) {
    previousRequest = JSON.parse(await fsp.readFile(path.join(options.reuseResponsesFromDir, "background_semantic_request.json"), "utf8"));
    if (previousRequest.model !== BACKGROUND_SEMANTIC_MODEL || !previousRequest.coordinate_space?.startsWith("normalized_1000") ||
        !(await fsp.readFile(previousRequest.image_inputs[1])).equals(await fsp.readFile(repairInput)))
      throw new Error("BACKGROUND_SEMANTIC_CACHE_INPUT_MISMATCH");
  }
  const residualInput = path.join(loopDir, "background_semantic_input.png");
  await makeBlackHolePlate(repairInput, repairInput, residualInput);
  const imagePaths = [residualInput, repairInput, ...(structureGuide ? [structureGuide] : [])];
  const contextImageIndex = imagePaths.length + 1;
  const semanticPrompt = (structureGuide ? BACKGROUND_SEMANTIC_PROMPT
    : BACKGROUND_SEMANTIC_PROMPT.replace(" Image 3 is a binary semantic reference, where white marks remaining elements.", ""))
    .replaceAll("Image 4", `Image ${contextImageIndex}`);
  const residual = await sharp(repairInput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = await sharp(source).metadata();
  const requestPath = path.join(loopDir, "background_semantic_request.json");
  const responsePath = path.join(loopDir, "background_semantic_response.json");
  const batches = [];
  for (let index = 0; index < targets.length; index += 7)
    batches.push(targets.slice(index, index + 7));
  const requests = await mapConcurrent(batches, 4, async (batch, index) => {
    const atlas = await makeBackgroundSemanticContextAtlas(residualInput, batch,
      path.join(loopDir, `background_semantic_context_${String(index + 1).padStart(2, "0")}.png`));
    return { index: index + 1, targets: batch, context_atlas: atlas,
      image_inputs: [...imagePaths, atlas.image],
      prompt: `${semanticPrompt}\n\nInput removal bboxes and atlas mappings below are SOURCE pixels for locating content only; your response bboxes and points MUST use normalized_1000 coordinates of the entire Image 2. Complete removal list for ALL batches: ${JSON.stringify(targets)}. Assigned hole ids for THIS batch: ${JSON.stringify(batch.map(({ id }) => id))}. Original image dimensions: [${width},${height}]. Image ${contextImageIndex} context-atlas mapping: ${JSON.stringify(atlas)}. Inspect all remaining appearances near each hole separately and preserve every one.`,
    };
  });
  const halfWidth = Math.floor(width / 2), halfHeight = Math.floor(height / 2);
  const inventoryTiles = [
    [0, 0, halfWidth, halfHeight], [halfWidth, 0, width - halfWidth, halfHeight],
    [0, halfHeight, halfWidth, height - halfHeight], [halfWidth, halfHeight, width - halfWidth, height - halfHeight],
  ].filter(bbox => bbox[2] > 0 && bbox[3] > 0).map((bbox, index) => ({ id: `scene_tile_${index + 1}`, bbox }));
  const inventoryAtlas = await makeBackgroundSemanticContextAtlas(residualInput, inventoryTiles,
    path.join(loopDir, "background_semantic_inventory.png"), { minPadding: 0, paddingScale: 0 });
  requests.unshift({ index: 0, targets: [], context_atlas: inventoryAtlas,
    image_inputs: [residualInput, repairInput, inventoryAtlas.image],
    prompt: `Complete-canvas inventory of the remaining RGB scene. Image 1 has deletion holes black, Image 2 has them transparent, and Image 3 tiles the entire canvas for inspection. Inventory ALL independent surviving elements across the whole scene, including areas far from deletion holes. Keep each bounded surface, foreground/midground landscape element, artwork and overlay separate. Do not merge several such elements into a continuous distant backdrop; only the distant field itself has mask_role=backdrop. Each other component has mask_role=element. Never infer absence from an earlier segmentation. Return JSON {"coordinate_space":"normalized_1000","scene":"residual scene","retained_components":[{"id":"unique retained id","description":"actual visible material and shape","mask_role":"element","bbox":[x,y,width,height],"evidence_points":[[x,y],[x,y],[x,y]],"evidence_rgb":[[r,g,b],[r,g,b],[r,g,b]]}],"holes":[]}. Use ONLY WHOLE Image 2 normalized coordinates: horizontal x,width and vertical y,height independently range 0..1000 across the FULL image. Never use original, resized, atlas or cell-local pixel coordinates; software converts the declared normalized frame to original [${width},${height}] pixels. Provide 3 to 6 evidence points on each component's OWN opaque RGB material well away from boundaries, avoiding all transparent holes and theoretical bbox corners. Include the approximate observed RGB [0..255] at EACH point in evidence_rgb; these colors are checked against the actual pixels, so differently colored background cannot count as evidence for an object. The atlas is recognition context only. Removed targets must remain absent (their bbox values are SOURCE pixels, not the response frame): ${JSON.stringify(targets)}. Atlas mapping (SOURCE pixels, not the response frame): ${JSON.stringify(inventoryAtlas)}.`,
  });
  await fsp.writeFile(requestPath, JSON.stringify({
    endpoint: "chat.completions.create",
    model: BACKGROUND_SEMANTIC_MODEL,
    image_inputs: imagePaths,
    coordinate_space: "normalized_1000 converted once to source pixels by software",
    reference_policy: "Analyze the residual scene only; original removed foreground is not shown. Retained components require opaque pixel evidence with matching RGB material and all continuation/edge/depth instructions reference those verified components.",
    batches: requests,
  }, null, 2));
  const parts = await mapConcurrent(requests, 4, async ({ index, targets: batch, prompt, image_inputs: batchImages }) => {
    const messages = [
      { role: "system", content: "You analyze only the remaining visible pixels for image repair. Every preserved component must have opaque pixel evidence. Return JSON only." },
      { role: "user", content: [
        ...batchImages.map((file) => ({ type: "image_url", image_url: { url: dataUrl(file), detail: "high" } })),
        { type: "text", text: prompt },
      ] },
    ];
    const validationErrors = [];
    const correction = rawContent => {
      let hints = [];
      try { hints = backgroundOpaqueEvidenceHints(backgroundSemanticPixelCoordinates(parseJson(rawContent), width, height), residual, validationErrors.at(-1)); } catch {}
      messages.push({ role: "assistant", content: rawContent }, { role: "user", content:
        `Your JSON failed the visible-pixel/reference checks: ${validationErrors.at(-1)}. Correct ALL listed problems in the entire JSON for the same assigned holes. EVERY retained component needs at least TWO DISTINCT visible evidence_points and matching evidence_rgb. Error locations are SOURCE pixels; your complete corrected JSON MUST still declare coordinate_space="normalized_1000" and use whole Image 2 normalized coordinates for EVERY bbox and evidence point, with matching observed evidence_rgb. Actual opaque RGB coordinate candidates in the failed component bboxes: ${JSON.stringify(hints)}. Candidates include both source_point and normalized_point; return normalized_point only. Choose evidence only where its RGB material belongs to that component; a candidate on a different visible component is not evidence for it. If the proposed bbox was at the wrong scale/location, relocate the bbox and points from Image 2 rather than changing claimed colors to fit the background. Do not discard a visibly surviving component merely because earlier points fell in holes or the wrong material. Delete unsupported component claims and references to them. Use only genuinely opaque visible evidence; never treat a deletion hole's shape as retained content.` });
    };
    let cached = null;
    if (previousRequest) {
      const previousBatch = previousRequest.batches.find(part => part.index === index);
      if (!previousBatch || JSON.stringify(previousBatch.targets) !== JSON.stringify(batch) ||
          !(await fsp.readFile(previousBatch.image_inputs.at(-1))).equals(await fsp.readFile(batchImages.at(-1))))
        throw new Error(`BACKGROUND_SEMANTIC_CACHE_BATCH_MISMATCH:${index}`);
      cached = path.join(options.reuseResponsesFromDir, `background_semantic_batch_${String(index).padStart(2, "0")}_raw.txt`);
      const rawContent = await fsp.readFile(cached, "utf8");
      try {
        const guide = groundBackgroundSemanticGuide(backgroundSemanticPixelCoordinates(parseJson(rawContent), width, height), batch, targets, residual, `b${index}_`);
        await fsp.writeFile(path.join(loopDir, `background_semantic_batch_${String(index).padStart(2, "0")}_raw.txt`), rawContent, "utf8");
        return { index, guide, usage: null, attempts: 0, validationErrors, reusedModelResponse: cached };
      } catch (error) {
        validationErrors.push(String(error.message || error));
        correction(rawContent);
      }
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await retry(() => openaiClient("semantic").chat.completions.create({
        model: BACKGROUND_SEMANTIC_MODEL,
        response_format: { type: "json_object" },
        max_completion_tokens: attempt === 1 ? 12288 : 24576,
        messages,
      }, signal ? { signal } : undefined), `background semantic guide batch ${index}`, 2);
      const rawContent = String(response?.choices?.[0]?.message?.content || "");
      await fsp.writeFile(path.join(loopDir, `background_semantic_batch_${String(index).padStart(2, "0")}_raw.txt`), rawContent, "utf8");
      await fsp.writeFile(path.join(loopDir, `background_semantic_batch_${String(index).padStart(2, "0")}_attempt_${attempt}_raw.txt`), rawContent, "utf8");
      try {
        if (response?.choices?.[0]?.finish_reason === "length")
          throw new Error(`BACKGROUND_SEMANTIC_GUIDE_TRUNCATED_BATCH_${index}: return concise complete JSON for every assigned hole`);
        const pixelGuide = backgroundSemanticPixelCoordinates(parseJson(rawContent), width, height);
        const guide = groundBackgroundSemanticGuide(pixelGuide, batch, targets, residual, `b${index}_`);
        return { index, guide, usage: response.usage || null, attempts: attempt, validationErrors, reusedModelResponse: cached };
      } catch (error) {
        validationErrors.push(String(error.message || error));
        if (attempt === 3) throw error;
        correction(rawContent);
      }
    }
  });
  const guide = {
    scene: parts.map(({ guide: part }) => part.scene).join("; "),
    preserve_visible: [...new Set(parts.flatMap(({ guide: part }) => part.preserve_visible))],
    holes: parts.flatMap(({ guide: part }) => part.holes),
    retained_components: parts.flatMap(({ guide: part }) => part.retained_components),
    grounding: { validated: true, coordinate_space: "source_pixels", analyst_coordinate_space: "normalized_1000",
      rgb_tolerance_per_channel: 64, input_image: repairInput, canvas: [width, height],
      visible_evidence_points: parts.reduce((count, part) => count + part.guide.grounding.visible_evidence_points, 0) },
  };
  const geometry = await refineBackgroundGeometryGuide(repairInput, targets, guide, loopDir, signal);
  const normalizedGuide = normalizeBackgroundSemanticGuide(geometry.guide, targets);
  await fsp.writeFile(responsePath, JSON.stringify({
    model: BACKGROUND_SEMANTIC_MODEL,
    guide: normalizedGuide,
    geometry_request: geometry.requestPath,
    geometry_response: geometry.responsePath,
    batches: parts.map(({ index, usage, attempts, validationErrors, reusedModelResponse }) =>
      ({ index, usage, attempts, validation_errors: validationErrors, reused_model_response: reusedModelResponse || null })),
  }, null, 2));
  return { guide: normalizedGuide, requestPath, responsePath };
}
async function refineBackgroundGeometryGuide(repairInput, targets, guide, loopDir, signal, options = {}) {
  const residualInput = path.join(loopDir, "background_semantic_input.png");
  await makeBlackHolePlate(repairInput, repairInput, residualInput);
  const residual = await sharp(repairInput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const componentMap = new Map(guide.retained_components.map((component) => [component.id, component]));
  const requests = [];
  const claimed = new Set();
  for (let offset = 0; offset < targets.length; offset += 7) {
    const batch = targets.slice(offset, offset + 7);
    const holes = guide.holes.filter((hole) => batch.some((target) => String(target.id) === hole.id));
    const componentIds = [...new Set(holes.flatMap((hole) => [
      ...hole.continue_component_ids, ...hole.keep_component_ids,
      ...hole.depth_relations.flatMap((relation) => [relation.front_id, relation.behind_id]),
    ]))].filter((id) => !claimed.has(id));
    for (const id of componentIds) claimed.add(id);
    if (!componentIds.length) continue;
    const index = Math.floor(offset / 7) + 1;
    const atlas = await makeBackgroundSemanticContextAtlas(residualInput, batch,
      path.join(loopDir, `background_geometry_context_${String(index).padStart(2, "0")}.png`));
    requests.push({ index, component_ids: componentIds,
      image_inputs: [residualInput, repairInput, atlas.image], context_atlas: atlas,
      prompt: `${BACKGROUND_GEOMETRY_PROMPT}\n\nOriginal canvas: [${residual.info.width},${residual.info.height}]. Atlas mapping: ${JSON.stringify(atlas)}. Assigned components: ${JSON.stringify(componentIds.map((id) => componentMap.get(id)))}.`,
    });
  }
  const requestPath = path.join(loopDir, "background_geometry_request.json");
  const responsePath = path.join(loopDir, "background_geometry_response.json");
  await fsp.writeFile(requestPath, JSON.stringify({ model: BACKGROUND_SEMANTIC_MODEL, batches: requests }, null, 2), "utf8");
  const parts = await mapConcurrent(requests, 4, async (request) => {
    const messages = [{ role: "system", content: "Measure only retained shapes. Return concise geometry JSON; never change component identity or depth." },
      { role: "user", content: [...request.image_inputs.map((file) => ({ type: "image_url",
        image_url: { url: dataUrl(file), detail: "high" } })), { type: "text", text: request.prompt }] }];
    const validationErrors = [];
    let cached = null;
    if (options.reuseResponsesFromDir) {
      const previousRequest = JSON.parse(await fsp.readFile(path.join(options.reuseResponsesFromDir, "background_geometry_request.json"), "utf8"));
      const previousBatch = previousRequest.batches.find((batch) => batch.index === request.index);
      if (!previousBatch || JSON.stringify(previousBatch.component_ids) !== JSON.stringify(request.component_ids) ||
          !(await fsp.readFile(previousBatch.image_inputs[1])).equals(await fsp.readFile(repairInput)))
        throw new Error("BACKGROUND_GEOMETRY_CACHE_INPUT_MISMATCH");
      for (let priorAttempt = 3; priorAttempt >= 1; priorAttempt--) {
        const file = path.join(options.reuseResponsesFromDir, `background_geometry_batch_${String(request.index).padStart(2, "0")}_attempt_${priorAttempt}_raw.txt`);
        if (fs.existsSync(file)) { cached = { content: await fsp.readFile(file, "utf8"), file }; break; }
      }
      if (!cached) throw new Error("BACKGROUND_GEOMETRY_CACHE_RESPONSE_MISSING");
    }
    for (let attempt = cached ? 3 : 1; attempt <= 3; attempt++) {
      const response = cached ? { choices: [{ finish_reason: "stop", message: { content: cached.content } }] }
        : await retry(() => openaiClient("semantic").chat.completions.create({
        model: BACKGROUND_SEMANTIC_MODEL, response_format: { type: "json_object" },
        max_completion_tokens: attempt === 1 ? 12288 : 24576, messages,
      }, signal ? { signal } : undefined), `background geometry batch ${request.index}`, 2);
      const raw = String(response?.choices?.[0]?.message?.content || "");
      await fsp.writeFile(path.join(loopDir, `background_geometry_batch_${String(request.index).padStart(2, "0")}_attempt_${attempt}_raw.txt`), raw, "utf8");
      try {
        if (response?.choices?.[0]?.finish_reason === "length") throw new Error("Geometry JSON was truncated; return concise complete geometries");
        const value = parseJson(raw);
        const byId = new Map();
        for (const item of value.geometries || []) {
          if (!request.component_ids.includes(item.id) || byId.has(item.id)) throw new Error(`Unexpected/duplicate geometry id ${item.id}`);
          byId.set(item.id, item.geometry);
        }
        if (request.component_ids.some((id) => !byId.has(id))) throw new Error("Missing assigned component geometries");
        const rejected = [];
        const candidateComponents = guide.retained_components.map((component) => ({ ...component,
          geometry: byId.get(component.id) || component.geometry || { kind: "freeform" } }));
        if (attempt === 3) {
          // Geometry advice is optional. An unsupported contour must not discard
          // the validated semantic component or another component's valid geometry.
          for (const component of candidateComponents.filter((item) => byId.has(item.id))) {
            try {
              groundBackgroundSemanticGuide({ ...guide, retained_components: guide.retained_components.map((item) => ({ ...item,
                geometry: item.id === component.id ? component.geometry : { kind: "freeform" } })) }, targets, targets, residual);
            } catch (error) {
              rejected.push({ id: component.id, error: String(error.message || error) });
              component.geometry = { kind: "freeform" };
            }
          }
        }
        const checked = groundBackgroundSemanticGuide({ ...guide, retained_components: candidateComponents }, targets, targets, residual);
        return { index: request.index, geometries: checked.retained_components.filter((component) => byId.has(component.id))
          .map(({ id, geometry }) => ({ id, geometry })), attempts: attempt, validation_errors: validationErrors,
          rejected_geometries: rejected, reused_model_response: cached?.file || null, usage: response.usage || null };
      } catch (error) {
        validationErrors.push(String(error.message || error));
        if (attempt === 3) throw error;
        messages.push({ role: "assistant", content: raw }, { role: "user", content:
          `Geometry validation failed: ${error.message}. Correct the full geometry JSON for exactly the same component ids. Preserve the existing shape classification when supported; choose new contour points on its visible opaque outline. Use freeform only for genuinely irregular or unsupported geometry.` });
      }
    }
  });
  const geometries = new Map(parts.flatMap((part) => part.geometries).map((item) => [item.id, item.geometry]));
  const refined = { ...guide, retained_components: guide.retained_components.map((component) => ({ ...component,
    geometry: geometries.get(component.id) || component.geometry || { kind: "freeform" } })) };
  await fsp.writeFile(responsePath, JSON.stringify({ model: BACKGROUND_SEMANTIC_MODEL, batches: parts,
    retained_components: refined.retained_components }, null, 2), "utf8");
  return { guide: refined, requestPath, responsePath };
}

// Some Gemini-compatible gateways occasionally return the complete JSON
// object with one extra serialization layer, but without wrapping that layer
// in outer quotes.  In that form the document starts with `\\n` instead of an
// actual newline and SVG attribute quotes are emitted as `\\\\\"`.  Decode
// exactly one escape layer before parsing; this is only a transport-format
// correction and does not relax any of the synchronized bundle validation.
function repairSynchronizedBundleTail(content) {
  const source = String(content || "");
  const svgEnd = source.lastIndexOf("</svg>");
  if (svgEnd < 0) return null;

  // The model occasionally emits a complete SVG string and then appends a
  // short natural-language fragment instead of the outer JSON closing brace.
  // Locate the JSON string terminator immediately after the final SVG tag;
  // never rewrite anything inside the SVG itself.
  const svgTagEnd = svgEnd + "</svg>".length;
  const quote = source.indexOf('"', svgTagEnd);
  if (quote < 0) return null;
  const suffix = source.slice(quote + 1);
  const leadingWhitespace = suffix.match(/^\s*/)?.[0] || "";
  const remainder = suffix.slice(leadingWhitespace.length);
  let repairedText;
  if (remainder.startsWith("}")) {
    repairedText = source.slice(0, quote + 1) + leadingWhitespace + "}";
  } else {
    repairedText = source.slice(0, quote + 1) + "}";
  }
  try {
    const value = JSON.parse(repairedText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.svg !== "string" || !value.svg.includes("</svg>")) return null;
    return {
      value,
      repairedText,
      repairReason: remainder.startsWith("}")
        ? "removed trailing non-json characters after the synchronized SVG object"
        : "removed trailing non-json characters and restored the synchronized SVG object brace",
    };
  } catch {
    return null;
  }
}

function parseSynchronizedBundleJson(text) {
  const content = String(text || "").trim();
  try {
    return { value: JSON.parse(content), extraEscapeLayer: false, repaired: false };
  } catch (directError) {
    const repaired = repairSynchronizedBundleTail(content);
    if (repaired) {
      return {
        ...repaired,
        extraEscapeLayer: false,
        repaired: true,
      };
    }
    // Only attempt the transport correction when the response visibly uses
    // escaped line breaks outside a JSON string.  A normal malformed response
    // continues to fail with the original JSON error.
    if (!/^\{\\(?:n|r|t)/.test(content)) throw directError;
    const decoded = content
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    try {
      return { value: JSON.parse(decoded), extraEscapeLayer: true, repaired: false };
    } catch (decodedError) {
      const decodedRepair = repairSynchronizedBundleTail(decoded);
      if (decodedRepair) {
        return {
          ...decodedRepair,
          extraEscapeLayer: true,
          repaired: true,
        };
      }
      throw directError;
    }
  }
}
async function parseControllerJsonResponse(response, logPrefix = null) {
  const message = response?.choices?.[0]?.message || {};
  const content = String(message.content || "");
  const finishReason = response?.choices?.[0]?.finish_reason || null;
  if (logPrefix)
    await fsp.writeFile(`${logPrefix}_raw_response.txt`, content, "utf8");
  if (finishReason === "length") {
    if (logPrefix)
      await fsp.writeFile(
        `${logPrefix}_response_meta.json`,
        JSON.stringify(
          {
            finish_reason: finishReason,
            content_length: content.length,
            json_repaired: false,
            error: "model output was truncated",
            usage: response?.usage || null,
          },
          null,
          2,
        ),
      );
    throw new Error(
      "bbox model output was truncated at the completion-token limit; enable ROI batching or reduce the requested schema",
    );
  }
  let parsed;
  let parseError = null;
  try {
    parsed = parseJsonDetailed(content);
  } catch (error) {
    parseError = error;
  }
  if (logPrefix) {
    if (parsed?.repairedText)
      await fsp.writeFile(
        `${logPrefix}_repaired_response.json`,
        parsed.repairedText,
        "utf8",
      );
    await fsp.writeFile(
      `${logPrefix}_response_meta.json`,
      JSON.stringify(
        {
          finish_reason: finishReason,
          content_length: content.length,
          json_repaired: parsed?.repaired === true,
          original_parse_error: parsed?.originalError || null,
          error: parseError ? String(parseError.message || parseError) : null,
          usage: response?.usage || null,
        },
        null,
        2,
      ),
    );
  }
  if (parseError) throw parseError;
  return parsed;
}
async function retry(fn, label, attempts = 3) {
  if (hasJobRetryPolicy()) return fn();
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const text = String(err.message || err).toLowerCase();
      const status = err.status || err.statusCode;
      if (
        i === attempts - 1 ||
        (![408, 409, 425, 429, 500, 502, 503, 504].includes(status) &&
          !/timeout|temporar|high demand|gateway/.test(text))
      )
        throw err;
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw last;
}
async function imageResponseBuffer(response) {
  const item = response?.data?.[0] || response?.output?.[0] || response;
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (typeof item?.url === "string")
    return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error("image response did not contain b64_json or url");
}
function imageRequestTimeoutMs(options = {}) {
  return Math.max(1, Number(options.timeoutMs) || getRoute(options.clientKind || 'image').timeout_ms);
}
async function normalizeImageEditResponse(buffer, width, height, options = {}) {
  if (options.resizeOutput === false) return sharp(buffer).png().toBuffer();
  const native = await sharp(buffer).metadata();
  const ratioError = Math.abs((native.width / native.height) / (width / height) - 1);
  if (options.preserveAspectRatio && ratioError > 0.01)
    throw new Error(`IMAGE_RESPONSE_ASPECT_MISMATCH: ${native.width}x${native.height} response for ${width}x${height} source; refusing anisotropic stretching`);
  return sharp(buffer).resize(width, height, {
    fit: options.preserveAspectRatio ? "contain" : "fill",
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  }).png().toBuffer();
}
async function imageEdit(source, output, prompt, model, mask, signal, options = {}) {
  const imagePaths = Array.isArray(options.imagePaths) && options.imagePaths.length
    ? options.imagePaths
    : [source];
  // Some deployments default all image traffic to Volcano Ark. A caller can
  // explicitly select the OpenAI image-edit endpoint for a single operation;
  // foreground extraction and background repair may select different clients.
  const useVolcengine =
    String(options.provider || "").toLowerCase() !== "openai" &&
    isVolcengineImageProvider(model);
  if (useVolcengine) {
    const response = await retry(
      () => volcengineImageEdit(imagePaths, prompt, model, signal, {
        ...options,
        mask,
      }),
      "Volcano Ark image edit",
      2,
    );
    await fsp.mkdir(path.dirname(output), { recursive: true });
    let result = await imageResponseBuffer(response);
    const meta = await sharp(source).metadata();
    result = options.resizeOutput === false
      ? await sharp(result).png().toBuffer()
      : await sharp(result)
        .resize(meta.width, meta.height, { fit: "fill" })
        .png()
        .toBuffer();
    await fsp.writeFile(output, result);
    return output;
  }
  const provider = String(options.provider || "").toLowerCase();
  model = model || modelFor(options.clientKind || "image");
  const client = openaiClient(
    options.clientKind || (provider === "openai" ? "openai-image" : "image"),
  );
  // Streams are single-use. Build the multipart request inside each retry so
  // a transient upstream failure never causes the next attempt to upload EOF.
  // OpenAI's multipart helper also supplies an explicit MIME type; a raw
  // fs.ReadStream is otherwise sent as application/octet-stream, which Azure
  // rejects for image edits.
  const uploadImage = async (file) => {
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
    return OpenAI.toFile(fs.createReadStream(file), path.basename(file), { type });
  };
  const makeRequest = async () => {
    const images = await Promise.all(imagePaths.map(uploadImage));
    const request = {
      model,
      image: images.length === 1 ? images[0] : images,
      prompt,
      output_format: "png",
      size: options.size || "auto",
    };
    if (mask) request.mask = await uploadImage(mask);
    if (options.background) request.background = options.background;
    // GPT Image 2/2.5 always process image inputs at high fidelity and the API
    // does not allow changing this with input_fidelity. Keep the option for
    // older image models, but omit it for GPT Image 2/2.5 requests.
    if (
      options.inputFidelity &&
      !/^gpt-image-2(?:\.5)?(?:-|$)/i.test(String(model || ""))
    )
      request.input_fidelity = options.inputFidelity;
    request.quality = options.quality || qualityFor(options.clientKind || 'image');
    return request;
  };
  const imageTimeout = imageRequestTimeoutMs(options);
  const requestOptions = { timeout: imageTimeout };
  if (signal) requestOptions.signal = signal;
  const response = await retry(
    () => makeRequest().then((request) => client.images.edit(request, requestOptions)),
    "image edit",
    options.maxAttempts ?? 2,
  );
  await fsp.mkdir(path.dirname(output), { recursive: true });
  let result = await imageResponseBuffer(response);
  const meta = await sharp(source).metadata();
  const nativeMeta = await sharp(result).metadata();
  if (options.nativeOutput) await fsp.writeFile(options.nativeOutput, result);
  if (options.responseMetadataPath) await fsp.writeFile(options.responseMetadataPath, JSON.stringify({
    model, quality: options.quality || null, requested_size: options.size || "auto",
    source_canvas: [meta.width, meta.height], response_canvas: [nativeMeta.width, nativeMeta.height],
    preserve_aspect_ratio: Boolean(options.preserveAspectRatio), native_output: options.nativeOutput || null,
    normalization: options.resizeOutput === false ? "native canvas" : options.preserveAspectRatio
      ? "uniform resize with aspect-ratio validation" : "resize to source canvas",
  }, null, 2), "utf8");
  result = await normalizeImageEditResponse(result, meta.width, meta.height, options);
  await fsp.writeFile(output, result);
  return output;
}

async function makeForegroundAtlasGuide(source, boxes, output) {
  const meta = await sharp(source).metadata();
  const rects = boxes
    .map((box) => {
      const [x, y, width, height] = box.bbox;
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white"/>`;
    })
    .join("");
  const mask = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`,
  );
  await sharp(source)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toFile(output);
  return output;
}

// One-request atlas mode used by the formal recursive top-layer loop. The
// returned atlas is treated as an alpha/matte provider; original RGB pixels
// are restored when the cells are split into layer records.
const ATLAS_MAX_SIZE = 256;
// GPT Image 2.5 Flare uses a compact fixed-cell atlas. Normal batches start from the
// 816px working canvas; the grid may grow to a maximum 2048px edge when
// long/large bboxes need it. Small bboxes are enlarged for the model and later
// reduced back to their controller dimensions. Every cell in one atlas has the
// same width and height, calculated from the largest processed bbox in that
// batch.
const GPT_IMAGE_ATLAS_SIZE = 816;
// GPT Image 2.5 Flare rejects custom responses above its current pixel budget. This
// is the hard ceiling for both dedicated oversized atlases and their response.
const GPT_IMAGE_ATLAS_MAX_SIZE = 2048;
// The image endpoint accepts rectangular canvases, but still enforces a
// minimum pixel budget and a maximum 3:1 aspect ratio. Keep these constraints
// explicit so a thin/wide native atlas does not have to become a mostly empty
// 2048x2048 square.
const GPT_IMAGE_ATLAS_MIN_PIXELS = 655360;
const GPT_IMAGE_ATLAS_MAX_ASPECT = 3;
// GPT Image 2.5 Flare rejects output sizes below its current minimum pixel budget. Keep
// the response dimensions equal to the compact input layout so coordinates are
// not remapped through a second intermediate canvas.
const GPT_IMAGE_ATLAS_RESPONSE_SIZE = 816;
const LEGACY_ATLAS_SIZE = 256;
const LEGACY_ATLAS_BATCH_SIZE = 4;
const GPT_IMAGE_ATLAS_BATCH_MODE = "fixed_cell_grid";
// LiteLLM may terminate a complex image edit upstream before the client's
// 400-second timeout. Keep atlas batches below a geometry-derived occupied
// area budget in addition to the explicit seven-item cap.
const GPT_ATLAS_MAX_UTILIZATION = Math.max(
  0.1,
  Math.min(
    1,
    Number(process.env.LAYERFORGE_GPT_ATLAS_MAX_UTILIZATION) || 1,
  ),
);
// Legacy atlas extraction generates a high-resolution matte and downsamples it
// to the logical ATLAS_MAX_SIZE canvas before splitting. GPT Image 2.5 Flare uses the
// separate compact fixed-cell path below, capped at 2048px per edge.
const ATLAS_MODEL_SIZE = 1024;
const ATLAS_MAX_BBOX_DIM = 128;
const ATLAS_CELL_PADDING = 4;
// Keep neighboring crops visually and semantically separated in the GPT Image 2.5 Flare
// input atlas. Cells are laid out from the top-left and always have a fixed
// 30px gap between them. The inner padding remains separate from that gap so
// each enlarged crop has a small breathing room inside its own cell.
const GPT_ATLAS_CELL_GAP = 30;
const GPT_ATLAS_CELL_PADDING = 10;
// Small icons are difficult for an image model to preserve when they occupy
// only a few dozen pixels in the atlas. Enlarge the shorter side to at least
// this size for the model request, then resize the returned crop back to the
// controller bbox dimensions before writing the layer.
const GPT_ATLAS_MIN_OBJECT_DIM = 120;

function seedreamAtlasTargetSize(box) {
  const nativeWidth = Math.max(1, Math.ceil(Number(box?.bbox?.[2]) || 1));
  const nativeHeight = Math.max(1, Math.ceil(Number(box?.bbox?.[3]) || 1));
  const inputScale = Math.max(
    1,
    GPT_ATLAS_MIN_OBJECT_DIM / Math.max(1, Math.min(nativeWidth, nativeHeight)),
  );
  return {
    native_width: nativeWidth,
    native_height: nativeHeight,
    input_scale: inputScale,
    width: Math.max(nativeWidth, Math.ceil(nativeWidth * inputScale)),
    height: Math.max(nativeHeight, Math.ceil(nativeHeight * inputScale)),
  };
}

function bboxIsTooLargeForAtlas(box) {
  const width = Number(box?.bbox?.[2] || 0);
  const height = Number(box?.bbox?.[3] || 0);
  return width > ATLAS_MAX_BBOX_DIM || height > ATLAS_MAX_BBOX_DIM;
}

function atlasSizeForImageModel(model, requestedSize = ATLAS_MAX_SIZE) {
  if (isGptImageModel(model)) return GPT_IMAGE_ATLAS_MAX_SIZE;
  if (isVolcengineImageProvider(model)) return LEGACY_ATLAS_SIZE;
  const value = Math.floor(Number(requestedSize) || ATLAS_MAX_SIZE);
  return Math.max(ATLAS_MAX_SIZE, value);
}

function gptImageAtlasCanvasDimensions(layoutWidth, layoutHeight, maxSide = GPT_IMAGE_ATLAS_MAX_SIZE) {
  const edgeLimit = Math.max(16, Math.floor(Number(maxSide) || GPT_IMAGE_ATLAS_MAX_SIZE));
  let width = Math.max(
    1,
    Math.ceil(Number(layoutWidth || GPT_IMAGE_ATLAS_RESPONSE_SIZE) || GPT_IMAGE_ATLAS_RESPONSE_SIZE),
  );
  let height = Math.max(
    1,
    Math.ceil(Number(layoutHeight || GPT_IMAGE_ATLAS_RESPONSE_SIZE) || GPT_IMAGE_ATLAS_RESPONSE_SIZE),
  );
  // GPT Image 2.5 Flare custom sizes use 16px edge multiples. For a native-single
  // atlas, preserve the layout aspect ratio and enlarge only the short edge
  // until the endpoint's pixel/aspect constraints are satisfied.
  width = Math.min(edgeLimit, Math.ceil(width / 16) * 16);
  height = Math.min(edgeLimit, Math.ceil(height / 16) * 16);
  const minHeightForPixels = Math.ceil((GPT_IMAGE_ATLAS_MIN_PIXELS / width) / 16) * 16;
  const minHeightForAspect = Math.ceil((width / GPT_IMAGE_ATLAS_MAX_ASPECT) / 16) * 16;
  height = Math.min(
    edgeLimit,
    Math.max(height, minHeightForPixels, minHeightForAspect),
  );
  const minWidthForPixels = Math.ceil((GPT_IMAGE_ATLAS_MIN_PIXELS / height) / 16) * 16;
  const minWidthForAspect = Math.ceil((height / GPT_IMAGE_ATLAS_MAX_ASPECT) / 16) * 16;
  width = Math.min(
    edgeLimit,
    Math.max(width, minWidthForPixels, minWidthForAspect),
  );
  return { width, height };
}

function gptImageAtlasResponseSize(layout) {
  const dimensions = gptImageAtlasCanvasDimensions(layout?.width, layout?.height);
  return `${dimensions.width}x${dimensions.height}`;
}

function atlasBatchSizeForImageModel(model, requestedSize = LEGACY_ATLAS_BATCH_SIZE) {
  // Keep GPT Image 2.5 Flare atlas requests small enough that the model preserves
  // object identity and does not turn a dense batch into a reordered collage.
  // The fixed-cell grid below makes the cell geometry deterministic; this is
  // the explicit item-count ceiling for that grid.
  if (isGptImageModel(model)) return 7;
  if (isVolcengineImageProvider(model)) return LEGACY_ATLAS_BATCH_SIZE;
  return Math.max(1, Math.min(64, Math.floor(Number(requestedSize) || LEGACY_ATLAS_BATCH_SIZE)));
}

function recordedAtlasSize(record) {
  const modelText = [record?.foreground_model, record?.extraction_model, record?.matting_model]
    .filter(Boolean)
    .join(" ");
  // Some plans store a combined value such as "gpt-image-2 + FeyNobg".
  if (/gpt-image-2/i.test(modelText)) return GPT_IMAGE_ATLAS_MAX_SIZE;
  const explicit = Number(record?.atlas_size);
  return Number.isFinite(explicit) && explicit > 0
    ? explicit
    : atlasSizeForImageModel(modelText);
}

function recordedAtlasBatchSize(record) {
  const modelText = [record?.foreground_model, record?.extraction_model, record?.matting_model]
    .filter(Boolean)
    .join(" ");
  // GPT Image 2.5 Flare uses the same explicit 7-item cap as the planner.
  if (/gpt-image-2/i.test(modelText)) return 7;
  const explicit = Number(record?.atlas_batch_size);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : LEGACY_ATLAS_BATCH_SIZE;
}

function recordedAtlasBatchMode(record) {
  const modelText = [record?.foreground_model, record?.extraction_model, record?.matting_model]
    .filter(Boolean)
    .join(" ");
  return /gpt-image-2/i.test(modelText) ? GPT_IMAGE_ATLAS_BATCH_MODE : null;
}

// Pack small targets into the smallest available shelf cells. The legacy
// output canvas stays 256x256, while each cell is only bbox-size plus a small
// margin; this avoids the large empty gaps of a fixed 2x2/3x3 grid.
function packAtlasLayout(boxes, atlasSize = ATLAS_MAX_SIZE) {
  const size = Math.min(
    ATLAS_MAX_SIZE,
    Math.max(ATLAS_MAX_SIZE, Math.floor(Number(atlasSize) || ATLAS_MAX_SIZE)),
  );
  const cells = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let row = 1;
  for (const box of boxes || []) {
    if (bboxIsTooLargeForAtlas(box))
      return { fits: false, reason: "bbox_over_128", box, width: size, height: size, cells };
    const bboxWidth = Math.max(1, Math.ceil(Number(box.bbox?.[2]) || 1));
    const bboxHeight = Math.max(1, Math.ceil(Number(box.bbox?.[3]) || 1));
    const cellWidth = Math.min(
      ATLAS_MAX_BBOX_DIM,
      bboxWidth + ATLAS_CELL_PADDING * 2,
    );
    const cellHeight = Math.min(
      ATLAS_MAX_BBOX_DIM,
      bboxHeight + ATLAS_CELL_PADDING * 2,
    );
    if (x > 0 && x + cellWidth > size) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
      row += 1;
    }
    if (y + cellHeight > size)
      return { fits: false, reason: "atlas_overflow", box, width: size, height: size, cells };
    cells.push({
      x,
      y,
      width: cellWidth,
      height: cellHeight,
      row,
      column: cells.filter((cell) => cell.row === row).length + 1,
    });
    x += cellWidth;
    rowHeight = Math.max(rowHeight, cellHeight);
  }
  return {
    fits: true,
    width: size,
    height: size,
    rows: row,
    columns: Math.max(1, ...cells.map((cell) => cell.column)),
    cells,
  };
}

function planAtlasBatches(boxes, batchSize = 4, atlasSize = ATLAS_MAX_SIZE) {
  const maxCount = Math.max(1, Math.min(64, Math.floor(Number(batchSize) || 4)));
  const batches = [];
  let pending = [];
  const flush = () => {
    if (pending.length) batches.push({ boxes: pending, mode: "atlas" });
    pending = [];
  };
  for (const box of boxes || []) {
    if (bboxIsTooLargeForAtlas(box)) {
      flush();
      batches.push({ boxes: [box], mode: "individual", reason: "bbox_over_128" });
      continue;
    }
    const candidate = [...pending, box];
    const layout = candidate.length <= maxCount
      ? packAtlasLayout(candidate, atlasSize)
      : { fits: false };
    if (!layout?.fits) {
      flush();
      pending = [box];
    } else {
      pending = candidate;
    }
  }
  flush();
  return batches;
}

async function generateForegroundAtlas(source, boxes, output, model, signal, options = {}) {
  if (!Array.isArray(boxes) || !boxes.length)
    throw new Error("atlas requires at least one bbox");
  const layout = options.layout || packAtlasLayout(boxes, options.width || ATLAS_MAX_SIZE);
  if (!layout?.fits)
    throw new Error(`atlas layout cannot fit: ${layout?.reason || "unknown"}`);
  const atlasWidth = layout.width;
  const atlasHeight = layout.height;
  const modelAtlasWidth = Math.max(
    ATLAS_MODEL_SIZE,
    Math.floor(Number(options.modelWidth) || ATLAS_MODEL_SIZE),
  );
  const modelAtlasHeight = Math.max(
    ATLAS_MODEL_SIZE,
    Math.floor(Number(options.modelHeight) || ATLAS_MODEL_SIZE),
  );
  const modelScaleX = modelAtlasWidth / atlasWidth;
  const modelScaleY = modelAtlasHeight / atlasHeight;
  const modelLayout = {
    ...layout,
    width: modelAtlasWidth,
    height: modelAtlasHeight,
    cells: layout.cells.map((cell) => ({
      ...cell,
      x: Math.round(cell.x * modelScaleX),
      y: Math.round(cell.y * modelScaleY),
      width: Math.max(1, Math.round(cell.width * modelScaleX)),
      height: Math.max(1, Math.round(cell.height * modelScaleY)),
    })),
  };
  const guide = options.guide || `${output}.guide.png`;
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await makeForegroundAtlasGuide(source, boxes, guide);
  const targets = boxes.map((box, index) => {
    const cell = layout.cells[index];
    const modelCell = modelLayout.cells[index];
    return {
      cell: index + 1,
      // cell_bbox is expressed in the high-resolution model response. The
      // logical atlas coordinates are retained for debugging/splitting.
      cell_bbox: [modelCell.x, modelCell.y, modelCell.width, modelCell.height],
      logical_cell_bbox: [cell.x, cell.y, cell.width, cell.height],
      bbox: box.bbox,
      id: box.id,
      description: extractionDescription(box),
    };
  });
  const prompt = `Image segmentation task. The first attached image is the complete current UI canvas. The second attached image is a transparent guide whose non-transparent rectangles identify exactly ${boxes.length} target objects, in the order listed below. Return ONE transparent PNG atlas, not the original canvas. The image service requires a high-resolution response, so the atlas must be exactly ${modelAtlasWidth}x${modelAtlasHeight} pixels. Pack each target tightly into its listed cell_bbox (coordinates are in this ${modelAtlasWidth}x${modelAtlasHeight} response); cells are dense rectangular regions and may have different sizes. Put target 1 in cell 1, target 2 in cell 2, and so on. Each cell contains ONLY its listed target, centered inside that cell without clipping and with transparent padding; do not include cards, panels, text, neighboring objects or any other target in that cell. Preserve each target's appearance, orientation and proportions; do not add labels, numbers, borders or backgrounds. Return PNG only.\nTargets: ${JSON.stringify(targets)}`;
  const requestPath = options.requestLog || `${output}.request.json`;
  const modelOutput = `${output}.model.png`;
  await fsp.writeFile(
    requestPath,
    JSON.stringify(
      {
        model: model || modelFor('foreground'),
        quality: FOREGROUND_ATLAS_QUALITY,
        method: isVolcengineImageProvider(
          model || modelFor('foreground'),
        )
          ? "images.generations (Volcano Ark image edit)"
          : "images.edit",
        background: "transparent",
        size: `${modelAtlasWidth}x${modelAtlasHeight}`,
        output_atlas_size: `${atlasWidth}x${atlasHeight}`,
        dense_layout: layout,
        model_dense_layout: modelLayout,
        cells: targets,
        input_images: [path.resolve(source), path.resolve(guide)],
        prompt,
      },
      null,
      2,
    ),
  );
  await imageEdit(
    source,
    modelOutput,
    prompt,
    model || modelFor('foreground'),
    undefined,
    signal,
    {
      imagePaths: [source, guide],
      provider: "openai",
      clientKind: "foreground-image",
      background: "transparent",
      inputFidelity: "high",
      size: `${modelAtlasWidth}x${modelAtlasHeight}`,
      resizeOutput: false,
      quality: FOREGROUND_ATLAS_QUALITY,
      layout: modelLayout,
    },
  );
  // Keep the stored/user-visible atlas compact even when the upstream model
  // has to render at a higher resolution. Alpha is the only information consumed from
  // this image; the split step restores RGB from the original source crop.
  await sharp(modelOutput)
    .resize(atlasWidth, atlasHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(output);
  await fsp.unlink(modelOutput).catch(() => {});
  return {
    atlas: output,
    guide,
    request: requestPath,
    layout,
    modelLayout,
    targets,
    model_output_size: `${modelAtlasWidth}x${modelAtlasHeight}`,
  };
}

// Split a generated atlas by cell alpha, then put that alpha on the original
// source RGB crop. This is the fidelity-preserving half of atlas mode: the
// image model supplies only the silhouette/matte, while the final cutout keeps
// original pixels, position and bbox dimensions.
async function splitForegroundAtlasAlpha(source, atlas, boxes, outputDir, options = {}) {
  if (!Array.isArray(boxes) || !boxes.length)
    throw new Error("atlas split requires at least one bbox");
  const atlasMeta = await sharp(atlas).metadata();
  const layout = options.layout || packAtlasLayout(boxes, options.width || ATLAS_MAX_SIZE);
  if (!layout?.fits)
    throw new Error(`atlas split layout cannot fit: ${layout?.reason || "unknown"}`);
  // Trust the actual returned PNG dimensions when splitting. Image APIs may
  // negotiate a supported size, so scale the requested dense cell layout to
  // the returned image instead of assuming an equal grid.
  const requestedWidth = Number(layout.width) || Number(options.width) || ATLAS_MAX_SIZE;
  const requestedHeight = Number(layout.height) || Number(options.height) || ATLAS_MAX_SIZE;
  const scaleX = (Number(atlasMeta.width) || requestedWidth) / requestedWidth;
  const scaleY = (Number(atlasMeta.height) || requestedHeight) / requestedHeight;
  await fsp.mkdir(outputDir, { recursive: true });
  const layers = [];
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const [targetX, targetY, targetW, targetH] = box.bbox;
    const requestedCell = layout.cells[index];
    const cellX = Math.max(0, Math.floor(requestedCell.x * scaleX));
    const cellY = Math.max(0, Math.floor(requestedCell.y * scaleY));
    const cellWidth = Math.max(1, Math.min(
      Number(atlasMeta.width) - cellX,
      Math.ceil(requestedCell.width * scaleX),
    ));
    const cellHeight = Math.max(1, Math.min(
      Number(atlasMeta.height) - cellY,
      Math.ceil(requestedCell.height * scaleY),
    ));
    const cell = await sharp(atlas)
      .extract({ left: cellX, top: cellY, width: cellWidth, height: cellHeight })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaOffset = cell.info.channels - 1;
    let minX = cell.info.width;
    let minY = cell.info.height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let y = 0; y < cell.info.height; y++) {
      for (let x = 0; x < cell.info.width; x++) {
        if (cell.data[(y * cell.info.width + x) * cell.info.channels + alphaOffset] <= 8)
          continue;
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!count)
      throw new Error(`atlas cell ${index + 1} returned an empty alpha matte for ${box.id}`);
    const alphaCrop = await sharp(atlas)
      .extract({ left: cellX + minX, top: cellY + minY, width: maxX + 1 - minX, height: maxY + 1 - minY })
      .ensureAlpha()
      .extractChannel(3)
      .resize(targetW, targetH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const modelCrop = await sharp(atlas)
      .extract({ left: cellX + minX, top: cellY + minY, width: maxX + 1 - minX, height: maxY + 1 - minY })
      .ensureAlpha()
      .resize(targetW, targetH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sourceCrop = await sharp(source)
      .extract({ left: targetX, top: targetY, width: targetW, height: targetH })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = Buffer.alloc(targetW * targetH * 4);
    for (let i = 0; i < targetW * targetH; i++) {
      const sourceOffset = i * sourceCrop.info.channels;
      const resultOffset = i * 4;
      const rgb = options.useModelRgb === true ? modelCrop.data : sourceCrop.data;
      const rgbChannels = options.useModelRgb === true ? modelCrop.info.channels : sourceCrop.info.channels;
      const rgbOffset = i * rgbChannels;
      result[resultOffset] = rgb[rgbOffset];
      result[resultOffset + 1] = rgb[rgbOffset + 1];
      result[resultOffset + 2] = rgb[rgbOffset + 2];
      result[resultOffset + 3] = alphaCrop.data[i];
    }
    const safeName = `${String(index + 1).padStart(3, "0")}_${box.id}`;
    const cutout = path.join(outputDir, `${safeName}.png`);
    const alphaPath = path.join(outputDir, `${safeName}_alpha.png`);
    const guide = path.join(outputDir, `${safeName}_bbox_guide.png`);
    await sharp(result, { raw: { width: targetW, height: targetH, channels: 4 } })
      .png()
      .toFile(cutout);
    await writeAlphaPreview(alphaCrop.data, targetW, targetH, alphaPath);
    await makeForegroundGuide(source, { bbox: box.bbox }, guide);
    layers.push({
      id: box.id,
      name: box.label,
      category: box.category,
      description: extractionDescription(box),
      source_bbox: [targetX, targetY, targetW, targetH],
      working_bbox: [targetX, targetY, targetW, targetH],
      bbox: [targetX, targetY, targetW, targetH],
      source: path.resolve(cutout),
      raw_source: path.resolve(source),
      bbox_guide: path.resolve(guide),
      generated_source: path.resolve(atlas),
      model_generated_source: path.resolve(atlas),
      atlas_alpha: path.resolve(alphaPath),
      atlas_cell: {
        index: index + 1,
        row: requestedCell.row,
        column: requestedCell.column,
        rect: [requestedCell.x, requestedCell.y, requestedCell.width, requestedCell.height],
        alpha_bbox: [minX, minY, maxX + 1 - minX, maxY + 1 - minY],
      },
      alpha_alignment: `atlas_cell_alpha_bbox_fit_to_controller_bbox_${options.useModelRgb === true ? "model_rgb" : "source_rgb"}`,
      parent_id: box.parent_id,
      occludes: box.occludes,
      occluded_by: box.occluded_by,
      confidence: box.confidence,
      extraction_model: options.model || DEFAULT_IMAGE_MODEL,
      foreground_model: options.model || DEFAULT_IMAGE_MODEL,
      matting_model: options.model || DEFAULT_IMAGE_MODEL,
      extraction_method: `${options.model || DEFAULT_IMAGE_MODEL}-atlas-alpha-${options.useModelRgb === true ? "model-rgb" : "source-rgb"}`,
      alpha_mode: `atlas_alpha_${options.useModelRgb === true ? "model_rgb" : "source_rgb"}`,
      use_model_output: options.useModelRgb === true,
      crop_mode: "preserve_bbox_canvas",
    });
  }
  return layers;
}

function atlasBatchPlan(batchSize, atlasSize = ATLAS_MAX_SIZE, columns = null) {
  const count = Math.max(1, Math.floor(Number(batchSize) || 4));
  const size = ATLAS_MAX_SIZE;
  const cols = Math.max(1, Math.floor(Number(columns) || Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / cols);
  return {
    batchSize: count,
    width: size,
    height: size,
    columns: cols,
    rows,
    cellWidth: Math.floor(size / cols),
    cellHeight: Math.floor(size / rows),
  };
}

// Run one atlas request for a formal recursive-loop batch. The atlas is only
// a matte provider: splitForegroundAtlasAlpha copies the current source RGB
// crop into each layer and applies the cell alpha at the original bbox.
async function extractForegroundAtlasBatch(
  source,
  boxes,
  loopDir,
  batchIndex,
  model,
  signal,
  options = {},
) {
  const layout = options.layout || packAtlasLayout(
    boxes,
    options.size || options.width || ATLAS_MAX_SIZE,
  );
  if (!layout?.fits)
    throw new Error(`atlas batch cannot be packed: ${layout?.reason || "unknown"}`);
  const batchDir = path.join(
    loopDir,
    "atlas",
    `batch_${String(batchIndex).padStart(2, "0")}`,
  );
  const atlas = path.join(batchDir, "atlas.png");
  const request = path.join(batchDir, "request.json");
  const generated = await generateForegroundAtlas(
    source,
    boxes,
    atlas,
    model,
    signal,
    {
      width: layout.width,
      height: layout.height,
      layout,
      quality: options.quality,
      requestLog: request,
    },
  );
  const layers = await splitForegroundAtlasAlpha(
    source,
    atlas,
    boxes,
    path.join(batchDir, "layers"),
    {
      width: layout.width,
      height: layout.height,
      layout,
      model,
      useModelRgb: options.useModelRgb === true,
      useFeynobg: options.useFeynobg !== false,
    },
  );
  layers.forEach((layer) => {
    layer.atlas_batch = batchIndex;
    layer.atlas_batch_size = boxes.length;
    layer.atlas_layout = {
      width: generated.layout.width,
      height: generated.layout.height,
      rows: generated.layout.rows,
      columns: generated.layout.columns,
      cells: generated.layout.cells,
    };
  });
  return {
    layers,
    atlas,
    guide: generated.guide,
    request,
    ...layout,
    layout,
  };
}

// Pack bbox crops into the model's atlas canvas using one fixed-size grid per
// batch. GPT Image 2 uses a compact rectangle capped at 2048px per edge;
// legacy Ark/non-GPT uses 256x256. Small targets are enlarged before packing,
// then centered in the common cell and reduced back to their native bbox after
// extraction. The number of items per GPT Image 2 atlas is capped at seven.
function atlasPermutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  for (let index = 0; index < items.length; index++) {
    const current = items[index];
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of atlasPermutations(rest)) result.push([current, ...tail]);
  }
  return result;
}

function atlasPackingOrders(items) {
  // Exhaustive permutations are excellent for tiny batches but become
  // factorial once the atlas is allowed to accept every rectangle that fits.
  // Try all orders only up to five items, then use several deterministic
  // MaxRects orderings whose runtime grows linearly with bbox count.
  if (items.length <= 5) return atlasPermutations(items);
  const orders = [];
  const seen = new Set();
  const add = (order) => {
    const key = order.map((item) => item.originalIndex).join(",");
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  };
  const sorted = (compare) => [...items].sort((a, b) => compare(a, b) || a.originalIndex - b.originalIndex);
  add([...items]);
  add(sorted((a, b) => b.width * b.height - a.width * a.height));
  add(sorted((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)));
  add(sorted((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height)));
  add(sorted((a, b) => b.width - a.width || b.height - a.height));
  add(sorted((a, b) => b.height - a.height || b.width - a.width));
  add(sorted((a, b) => (b.width + b.height) - (a.width + a.height)));
  // Rotating the strongest area ordering gives MaxRects additional chances
  // to place awkward wide/tall rectangles into holes without brute force.
  const areaOrder = sorted((a, b) => b.width * b.height - a.width * a.height);
  for (let offset = 1; offset < Math.min(areaOrder.length, 12); offset++)
    add([...areaOrder.slice(offset), ...areaOrder.slice(0, offset)]);
  return orders;
}

function pruneAtlasFreeRects(rects) {
  return rects.filter((rect, index) => !rects.some((other, otherIndex) =>
    index !== otherIndex &&
    rect.x >= other.x &&
    rect.y >= other.y &&
    rect.x + rect.width <= other.x + other.width &&
    rect.y + rect.height <= other.y + other.height &&
    (
      rect.x > other.x ||
      rect.y > other.y ||
      rect.width < other.width ||
      rect.height < other.height
    ),
  ));
}

function splitAtlasFreeRects(rects, used) {
  const next = [];
  const usedRight = used.x + used.width;
  const usedBottom = used.y + used.height;
  for (const free of rects) {
    const freeRight = free.x + free.width;
    const freeBottom = free.y + free.height;
    if (
      used.x >= freeRight || usedRight <= free.x ||
      used.y >= freeBottom || usedBottom <= free.y
    ) {
      next.push(free);
      continue;
    }
    if (used.x > free.x)
      next.push({ x: free.x, y: free.y, width: used.x - free.x, height: free.height });
    if (usedRight < freeRight)
      next.push({ x: usedRight, y: free.y, width: freeRight - usedRight, height: free.height });
    if (used.y > free.y)
      next.push({ x: free.x, y: free.y, width: free.width, height: used.y - free.y });
    if (usedBottom < freeBottom)
      next.push({ x: free.x, y: usedBottom, width: free.width, height: freeBottom - usedBottom });
  }
  return pruneAtlasFreeRects(next.filter((rect) => rect.width > 0 && rect.height > 0));
}

function packAtlasRectanglesInOrder(items, width, height, gap = 0) {
  let freeRects = [{ x: 0, y: 0, width, height }];
  const placed = [];
  for (const item of items) {
    const reservedWidth = item.width + gap * 2;
    const reservedHeight = item.height + gap * 2;
    const candidates = freeRects
      .filter((free) => reservedWidth <= free.width && reservedHeight <= free.height)
      .map((free) => ({
        free,
        shortFit: Math.min(free.width - reservedWidth, free.height - reservedHeight),
        longFit: Math.max(free.width - reservedWidth, free.height - reservedHeight),
      }))
      .sort((a, b) =>
        a.shortFit - b.shortFit ||
        a.longFit - b.longFit ||
        a.free.y - b.free.y ||
        a.free.x - b.free.x,
      );
    if (!candidates.length) return null;
    const free = candidates[0].free;
    const reserved = {
      originalIndex: item.originalIndex,
      x: free.x,
      y: free.y,
      width: reservedWidth,
      height: reservedHeight,
    };
    placed.push({
      originalIndex: item.originalIndex,
      x: free.x + gap,
      y: free.y + gap,
      width: item.width,
      height: item.height,
    });
    freeRects = splitAtlasFreeRects(freeRects, reserved);
  }
  const usedWidth = Math.max(0, ...placed.map((rect) => rect.x + rect.width));
  const usedHeight = Math.max(0, ...placed.map((rect) => rect.y + rect.height));
  return { placed, usedWidth, usedHeight };
}

function seedreamAtlasGrid(boxes, maxSide = GPT_IMAGE_ATLAS_SIZE) {
  const count = Array.isArray(boxes) ? boxes.length : 0;
  if (!count) return { fits: false, reason: "empty_atlas", cells: [] };
  const logicalMaxSide = Math.max(1, Math.floor(Number(maxSide) || GPT_IMAGE_ATLAS_SIZE));
  const items = boxes.map((box, originalIndex) => ({
    originalIndex,
    box,
    ...seedreamAtlasTargetSize(box),
  }));
  const oversized = items.filter((item) => item.width > logicalMaxSide || item.height > logicalMaxSide);
  if (oversized.length) {
    if (count !== 1)
      return { fits: false, reason: "bbox_over_atlas_requires_native_single", box: oversized[0].box, cells: [] };
    const item = oversized[0];
    // A single oversized target is still allowed to use a native atlas. Scale
    // it uniformly only when the processed crop itself exceeds the provider
    // edge limit, then expand the short edge for the endpoint pixel/aspect
    // constraints.
    const requestedWidth = Math.max(logicalMaxSide, item.width, item.height);
    const isGptAtlas = logicalMaxSide >= GPT_IMAGE_ATLAS_SIZE;
    const atlasScale = isGptAtlas
      ? Math.min(1, GPT_IMAGE_ATLAS_MAX_SIZE / requestedWidth)
      : 1;
    const cellWidth = Math.max(1, Math.floor(item.width * atlasScale));
    const cellHeight = Math.max(1, Math.floor(item.height * atlasScale));
    const nativeCanvas = isGptAtlas
      ? gptImageAtlasCanvasDimensions(cellWidth, cellHeight, GPT_IMAGE_ATLAS_MAX_SIZE)
      : { width: requestedWidth, height: requestedWidth };
    const width = nativeCanvas.width;
    const height = nativeCanvas.height;
    const x = Math.floor((width - cellWidth) / 2);
    const y = Math.floor((height - cellHeight) / 2);
    return {
      fits: true,
      width,
      height,
      columns: 1,
      rows: 1,
      packing: "fixed-cell-grid",
      native_single: true,
      cell_width: cellWidth,
      cell_height: cellHeight,
      cell_padding: 0,
      used_width: cellWidth,
      used_height: cellHeight,
      utilization: Number((cellWidth * cellHeight / (width * height)).toFixed(6)),
      cells: [{
        index: 1,
        row: 1,
        column: 1,
        x,
        y,
        width: cellWidth,
        height: cellHeight,
        crop_x: 0,
        crop_y: 0,
        crop_width: cellWidth,
        crop_height: cellHeight,
        native_width: item.native_width,
        native_height: item.native_height,
        input_scale: item.input_scale * atlasScale,
        pre_cap_input_scale: item.input_scale,
        atlas_scale: atlasScale,
        source_bbox: item.box.bbox,
      }],
    };
  }

  // All targets in one atlas share one cell size. The dimensions are derived
  // from the largest recognition-sized crop in this batch, with a reserved
  // inner margin so neighboring objects cannot touch. This deliberately
  // avoids variable rectangles: cell N is always the same grid slot in both
  // the request and the split operation.
  const cellPadding = Math.min(
    GPT_ATLAS_CELL_PADDING,
    Math.max(0, Math.floor((logicalMaxSide - Math.max(...items.map((item) => Math.max(item.width, item.height)))) / 2)),
  );
  const cellWidth = Math.max(...items.map((item) => item.width)) + cellPadding * 2;
  const cellHeight = Math.max(...items.map((item) => item.height)) + cellPadding * 2;
  const isGptAtlas = logicalMaxSide >= GPT_IMAGE_ATLAS_SIZE;
  const candidates = [];
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const gridWidth = columns * cellWidth + Math.max(0, columns - 1) * GPT_ATLAS_CELL_GAP;
    const gridHeight = rows * cellHeight + Math.max(0, rows - 1) * GPT_ATLAS_CELL_GAP;
    if (gridWidth > logicalMaxSide || gridHeight > logicalMaxSide) continue;
    const canvas = isGptAtlas
      ? gptImageAtlasCanvasDimensions(gridWidth, gridHeight, logicalMaxSide)
      : { width: logicalMaxSide, height: logicalMaxSide };
    if (canvas.width > logicalMaxSide || canvas.height > logicalMaxSide) continue;
    const emptyCells = columns * rows - count;
    const gridArea = gridWidth * gridHeight;
    const canvasArea = canvas.width * canvas.height;
    const aspectPenalty = Math.abs(Math.log(Math.max(1, canvas.width) / Math.max(1, canvas.height)));
    // Prefer the fewest empty cells, then the best occupied canvas area, then
    // the least extreme aspect ratio. This keeps seven targets compact while
    // still avoiding a very thin strip when the objects are large.
    candidates.push({
      columns,
      rows,
      gridWidth,
      gridHeight,
      canvas,
      emptyCells,
      gridFill: gridArea / Math.max(1, canvasArea),
      aspectPenalty,
    });
  }
  if (!candidates.length)
    return {
      fits: false,
      reason: "fixed_cell_grid_does_not_fit_atlas",
      width: logicalMaxSide,
      height: logicalMaxSide,
      cell_width: cellWidth,
      cell_height: cellHeight,
      cells: [],
    };
  candidates.sort((a, b) =>
    // A tall one-column grid is unstable with GPT Image 2: when the
    // provider enlarges the canvas to satisfy its minimum pixel budget, the
    // model reflows those rows across the full response height. Prefer a
    // compact multi-column grid for that case while retaining the explicit
    // target order inside every cell.
    (Number(a.columns === 1 && a.rows > 1) - Number(b.columns === 1 && b.rows > 1)) ||
    a.emptyCells - b.emptyCells ||
    b.gridFill - a.gridFill ||
    a.aspectPenalty - b.aspectPenalty ||
    a.canvas.width * a.canvas.height - b.canvas.width * b.canvas.height ||
    a.columns - b.columns,
  );
  const best = candidates[0];
  // The requested atlas always starts at the top-left. If the provider
  // enlarges one edge to satisfy its minimum pixel budget, the remaining
  // space is intentionally left after the grid rather than shifting cells.
  const offsetX = 0;
  const offsetY = 0;
  const cells = items.map((item, index) => {
    const row = Math.floor(index / best.columns);
    const column = index % best.columns;
    return {
      index: index + 1,
      row: row + 1,
      column: column + 1,
      x: offsetX + column * (cellWidth + GPT_ATLAS_CELL_GAP),
      y: offsetY + row * (cellHeight + GPT_ATLAS_CELL_GAP),
      width: cellWidth,
      height: cellHeight,
      crop_x: Math.floor((cellWidth - item.width) / 2),
      crop_y: Math.floor((cellHeight - item.height) / 2),
      crop_width: item.width,
      crop_height: item.height,
      native_width: item.native_width,
      native_height: item.native_height,
      input_scale: item.input_scale,
      source_bbox: item.box.bbox,
    };
  });
  const usedArea = count * cellWidth * cellHeight;
  return {
    fits: true,
    width: best.canvas.width,
    height: best.canvas.height,
    columns: best.columns,
    rows: best.rows,
    packing: "fixed-cell-grid",
    cell_gap: GPT_ATLAS_CELL_GAP,
    cell_padding: cellPadding,
    cell_width: cellWidth,
    cell_height: cellHeight,
    grid_width: best.gridWidth,
    grid_height: best.gridHeight,
    grid_offset: [offsetX, offsetY],
    empty_cells: best.emptyCells,
    native_single: false,
    used_width: best.gridWidth,
    used_height: best.gridHeight,
    utilization: Number((usedArea / (best.canvas.width * best.canvas.height)).toFixed(6)),
    cells,
  };
}

function planSeedreamAtlasBatches(boxes, batchSize = 7, atlasSize = GPT_IMAGE_ATLAS_MAX_SIZE) {
  const requestedLimit = Number(batchSize);
  // This path is specifically the GPT Image 2 atlas path. Enforce the seven
  // item ceiling here as well as at request planning/UI boundaries so a stale
  // or manually supplied larger value cannot create an oversized atlas.
  const maxCount = Math.max(
    1,
    Math.min(7, Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : 7),
  );
  const indexed = (boxes || []).map((box, originalIndex) => ({
    box,
    originalIndex,
    ...seedreamAtlasTargetSize(box),
  }));
  const oversized = indexed.filter((item) => item.width > atlasSize || item.height > atlasSize);
  // Preserve the controller's bbox order. A packing heuristic must never
  // silently reorder targets because the image model is already free to
  // reflow returned artwork; keeping the request order stable makes every
  // cell/target mapping auditable.
  const normal = indexed
    .filter((item) => item.width <= atlasSize && item.height <= atlasSize);
  const bins = [];
  for (const item of normal) {
    let best = null;
    for (let index = 0; index < bins.length; index++) {
      const bin = bins[index];
      if (bin.items.length >= maxCount) continue;
      const candidateItems = [...bin.items, item];
      const layout = seedreamAtlasGrid(candidateItems.map((entry) => entry.box), atlasSize);
      if (!layout?.fits) continue;
      // A single native crop is always allowed, even when it occupies most
      // of the canvas. For a multi-crop atlas, keep the occupied native area
      // under the configured geometry budget so one slow request does not
      // hit the LiteLLM upstream timeout.
      if (candidateItems.length > 1 && layout.utilization > GPT_ATLAS_MAX_UTILIZATION)
        continue;
      const score = (layout.used_width || atlasSize) * (layout.used_height || atlasSize);
      if (!best || score < best.score) best = { index, layout, score };
    }
    if (best) bins[best.index].items.push(item);
    else bins.push({ items: [item] });
  }
  const batches = [
    ...bins.map((bin) => ({
      boxes: bin.items.map((item) => item.box),
      mode: "seedream_atlas",
      originalIndex: Math.min(...bin.items.map((item) => item.originalIndex)),
    })),
    ...oversized.map((item) => ({
      boxes: [item.box],
      mode: "seedream_atlas",
      reason: "bbox_over_atlas_single_atlas",
      native_single: true,
      originalIndex: item.originalIndex,
    })),
  ];
  return batches
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map(({ originalIndex, ...batch }) => batch);
}

async function makeSeedreamAtlasInput(source, boxes, layout, output) {
  const overlays = [];
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const cell = layout.cells[index];
    const [x, y, width, height] = box.bbox;
    const nativeCrop = await sharp(source)
      .extract({ left: x, top: y, width, height })
      .png()
      .toBuffer();
    const cropWidth = Math.max(1, Math.round(Number(cell.crop_width) || width));
    const cropHeight = Math.max(1, Math.round(Number(cell.crop_height) || height));
    // Small targets are enlarged uniformly before being handed to GPT Image 2.
    // The detector and extraction path use the returned cell dimensions and
    // resize the model crop back to the original bbox below.
    const crop = cropWidth === width && cropHeight === height
      ? nativeCrop
      : await sharp(nativeCrop)
        .resize(cropWidth, cropHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer();
    overlays.push({ input: crop, left: cell.x + cell.crop_x, top: cell.y + cell.crop_y });
  }
  await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(overlays)
    .png()
    .toFile(output);
  return output;
}

function atlasSpatialRows(items, boundsFor) {
  const pending = items.map((item, index) => {
    const [left, top, width, height] = boundsFor(item);
    return {
      index,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2,
    };
  }).sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX);
  const rows = [];
  for (const item of pending) {
    let bestRow = null;
    let bestOverlap = 0;
    for (const row of rows) {
      const overlap = Math.max(0, Math.min(item.bottom, row.bottom) - Math.max(item.top, row.top));
      const overlapRatio = overlap / Math.max(1, Math.min(item.height, row.meanHeight));
      if (overlapRatio >= 0.35 && overlapRatio > bestOverlap) {
        bestRow = row;
        bestOverlap = overlapRatio;
      }
    }
    if (!bestRow) {
      rows.push({
        items: [item],
        top: item.top,
        bottom: item.bottom,
        meanHeight: item.height,
        meanCenterY: item.centerY,
      });
      continue;
    }
    bestRow.items.push(item);
    bestRow.top = Math.min(bestRow.top, item.top);
    bestRow.bottom = Math.max(bestRow.bottom, item.bottom);
    bestRow.meanHeight = bestRow.items.reduce((sum, entry) => sum + entry.height, 0) / bestRow.items.length;
    bestRow.meanCenterY = bestRow.items.reduce((sum, entry) => sum + entry.centerY, 0) / bestRow.items.length;
  }
  return rows
    .sort((a, b) => a.meanCenterY - b.meanCenterY)
    .map((row) => row.items.sort((a, b) => a.centerX - b.centerX));
}

function atlasReadingOrderAssignment(targetFeatures, componentFeatures) {
  if (!targetFeatures.length || targetFeatures.length !== componentFeatures.length) return null;
  const targetRows = atlasSpatialRows(targetFeatures, (target) => [
    target.cell.x,
    target.cell.y,
    target.cell.width,
    target.cell.height,
  ]);
  const componentRows = atlasSpatialRows(componentFeatures, (component) => component.bbox);
  const targetSignature = targetRows.map((row) => row.length);
  const componentSignature = componentRows.map((row) => row.length);
  if (targetSignature.length !== componentSignature.length ||
      targetSignature.some((length, index) => length !== componentSignature[index])) return null;
  const assignment = new Array(targetFeatures.length).fill(-1);
  for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < targetRows[rowIndex].length; columnIndex++) {
      assignment[targetRows[rowIndex][columnIndex].index] = componentRows[rowIndex][columnIndex].index;
    }
  }
  return {
    assignment,
    target_row_signature: targetSignature,
    component_row_signature: componentSignature,
  };
}

// GPT Image 2 is asked to preserve atlas coordinates, but image editing models
// can still enlarge/reflow the returned objects. The user-visible atlas is
// never changed. This helper only isolates layer crops by the fixed cell order:
// returned Alpha components are grouped by response row and cell column, and
// disconnected components in one cell are unioned into that target.
async function detectGptAtlasRegions(modelOutput, boxes, layout) {
  const cells = Array.isArray(layout?.cells) ? layout.cells : [];
  const targetCount = Math.min(boxes?.length || 0, cells.length);
  if (!targetCount) return { method: "no_targets", component_count: 0, regions: [] };
  const meta = await sharp(modelOutput).metadata();
  const generatedWidth = Number(meta.width) || 0;
  const generatedHeight = Number(meta.height) || 0;
  if (!generatedWidth || !generatedHeight)
    return { method: "scaled_input_rect_fallback", reason: "missing_output_dimensions", component_count: 0, regions: [] };
  const raw = await sharp(modelOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = raw.info.width;
  const height = raw.info.height;
  const channels = raw.info.channels;
  const alphaChannel = Math.max(0, channels - 1);
  const pixels = width * height;
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  const components = [];
  const alphaThreshold = 16;
  const neighbors = [-1, 0, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (visited[start] || raw.data[start * channels + alphaChannel] <= alphaThreshold) continue;
      visited[start] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      while (head < tail) {
        const index = queue[head++];
        const pointX = index % width;
        const pointY = Math.floor(index / width);
        area++;
        minX = Math.min(minX, pointX);
        maxX = Math.max(maxX, pointX);
        minY = Math.min(minY, pointY);
        maxY = Math.max(maxY, pointY);
        sumX += pointX;
        sumY += pointY;
        for (const dy of neighbors) {
          const nextY = pointY + dy;
          if (nextY < 0 || nextY >= height) continue;
          for (const dx of neighbors) {
            if (!dx && !dy) continue;
            const nextX = pointX + dx;
            if (nextX < 0 || nextX >= width) continue;
            const next = nextY * width + nextX;
            if (visited[next] || raw.data[next * channels + alphaChannel] <= alphaThreshold) continue;
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
      components.push({
        seed: start,
        bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1],
        area,
        center: [sumX / area, sumY / area],
      });
    }
  }
  const minimumArea = Math.max(16, Math.floor(pixels * 0.00005));
  const significant = components
    .filter((component) => component.area >= minimumArea)
    .sort((a, b) => b.area - a.area);
  const fallbackRegions = (reason) => ({
    method: "scaled_input_rect_fallback",
    reason,
    component_count: significant.length,
    response_size: [width, height],
    regions: cells.slice(0, targetCount).map((cell, index) => {
      const left = Math.max(0, Math.min(width - 1, Math.round(cell.x * width / layout.width)));
      const top = Math.max(0, Math.min(height - 1, Math.round(cell.y * height / layout.height)));
      return {
        target_index: index,
        rect: {
          left,
          top,
          width: Math.max(1, Math.min(width - left, Math.round(cell.width * width / layout.width))),
          height: Math.max(1, Math.min(height - top, Math.round(cell.height * height / layout.height))),
        },
        component_index: null,
      };
    }),
  });
  if (significant.length < targetCount)
    return fallbackRegions("fewer_alpha_components_than_targets");
  // A fully opaque response usually means the provider dropped transparency;
  // there is no reliable component split in that case.
  if (significant.length === 1 && significant[0].area >= pixels * 0.98)
    return fallbackRegions("response_is_effectively_opaque");
  // One target can have many disconnected details. Do not cap components by
  // target count, and never enumerate target permutations.
  const candidates = significant;
  const targetAreaTotal = cells.slice(0, targetCount).reduce((sum, cell) => sum + cell.width * cell.height, 0) || 1;
  const componentAreaTotal = candidates.reduce((sum, component) => sum + component.area, 0) || 1;
  const targetFeatures = cells.slice(0, targetCount).map((cell) => ({
    center: [
      (cell.x + cell.width / 2) / Math.max(1, layout.width),
      (cell.y + cell.height / 2) / Math.max(1, layout.height),
    ],
    // When the model respects the immutable native cell, the returned
    // component center should remain inside that cell. Prefer that hard
    // spatial contract whenever at least one candidate is present there;
    // otherwise retain the geometry-based recovery for genuinely reflowed
    // responses.
    cell,
    aspect: cell.width / Math.max(1, cell.height),
    areaRatio: (cell.width * cell.height) / targetAreaTotal,
  }));
  const componentFeatures = candidates.map((component) => ({
    ...component,
    aspect: component.bbox[2] / Math.max(1, component.bbox[3]),
    normalizedCenter: [component.center[0] / width, component.center[1] / height],
    areaRatio: component.area / componentAreaTotal,
  }));

  // Keep the requested cell order authoritative. A single visual object can
  // contain several disconnected alpha components (for example a speaker
  // cone plus two sound-wave marks), so selecting one component per target
  // drops real pixels. Fit returned row/column groups in reading order and
  // union their complete bounds. Input coordinates cannot locate a model's
  // translated/enlarged grid. No semantic/Hungarian reassignment is used.
  const fixedCellGroups = Array.from({ length: targetCount }, () => []);
  const targetRows = atlasSpatialRows(targetFeatures, (target) => [
    target.cell.x,
    target.cell.y,
    target.cell.width,
    target.cell.height,
  ]);
  const componentRows = visualAtlasColumns(
    componentFeatures.map((_, index) => ({ index })), componentFeatures, targetRows.length, 1,
  ) || [];
  // Component rows are ordered by the model response, not by the input
  // canvas coordinates. When the endpoint adds a tall minimum-size canvas it
  // can shift every returned row, so map rows by rank first and columns by
  // horizontal position inside each row.
  if (componentRows.length >= targetRows.length) {
    for (let componentRowIndex = 0; componentRowIndex < componentRows.length; componentRowIndex++) {
      const mappedRowIndex = targetRows.length === componentRows.length
        ? componentRowIndex
        : Math.min(
            targetRows.length - 1,
            Math.round(componentRowIndex * (targetRows.length - 1) / Math.max(1, componentRows.length - 1)),
          );
      const rowTargets = targetRows[mappedRowIndex];
      const columnGroups = visualAtlasColumns(componentRows[componentRowIndex], componentFeatures, rowTargets.length);
      if (columnGroups) columnGroups.forEach((group, column) => {
        for (const entry of group) fixedCellGroups[rowTargets[column].index].push(entry.index);
      });
    }
  }
  // If a target has no alpha at all, its object was dropped by the model; a
  // fixed inner-cell crop is the only honest result for that target. Do not
  // steal another target's pixels to manufacture a match.
  if (fixedCellGroups.some((group) => !group.length))
    return fallbackRegions("fixed_cell_alpha_group_missing_target");
  const fixedCellPadding = Math.max(2, Math.round(Math.min(width, height) * 0.002));
  const fixedCellRegions = fixedCellGroups.map((group, targetIndex) => {
    const assigned = group.map((componentIndex) => componentFeatures[componentIndex]);
    const left = Math.min(...assigned.map((component) => component.bbox[0]));
    const top = Math.min(...assigned.map((component) => component.bbox[1]));
    const right = Math.max(...assigned.map((component) => component.bbox[0] + component.bbox[2]));
    const bottom = Math.max(...assigned.map((component) => component.bbox[1] + component.bbox[3]));
    const paddedLeft = Math.max(0, left - fixedCellPadding);
    const paddedTop = Math.max(0, top - fixedCellPadding);
    const paddedRight = Math.min(width, right + fixedCellPadding);
    const paddedBottom = Math.min(height, bottom + fixedCellPadding);
    const primary = assigned.slice().sort((a, b) => b.area - a.area)[0];
    return {
      target_index: targetIndex,
      rect: {
        left: paddedLeft,
        top: paddedTop,
        width: Math.max(1, paddedRight - paddedLeft),
        height: Math.max(1, paddedBottom - paddedTop),
      },
      component_bbox: [left, top, right - left, bottom - top],
      component_index: componentFeatures.indexOf(primary),
      component_indices: group.slice(),
      component_seeds: assigned.map((component) => component.seed),
      component_area: assigned.reduce((sum, component) => sum + component.area, 0),
      component_center: [
        assigned.reduce((sum, component) => sum + component.center[0] * component.area, 0) /
          Math.max(1, assigned.reduce((sum, component) => sum + component.area, 0)),
        assigned.reduce((sum, component) => sum + component.center[1] * component.area, 0) /
          Math.max(1, assigned.reduce((sum, component) => sum + component.area, 0)),
      ],
    };
  });
  return {
    method: "alpha_connected_components_fixed_cell_grouping",
    reason: "grouped_complete_components_by_returned_row_and_column_order",
    matching_strategy: "fixed_cell_alpha_grouping",
    target_row_signature: null,
    component_row_signature: null,
    component_count: significant.length,
    response_size: [width, height],
    regions: fixedCellRegions,
  };

}

function fixedAtlasCellCropRect(cell, layout, modelWidth, modelHeight) {
  const sourceLeft = Number(cell.x) + Number(cell.crop_x || 0);
  const sourceTop = Number(cell.y) + Number(cell.crop_y || 0);
  const sourceRight = sourceLeft + Number(cell.crop_width || cell.width);
  const sourceBottom = sourceTop + Number(cell.crop_height || cell.height);
  const left = Math.max(0, Math.min(modelWidth - 1, Math.round(sourceLeft * modelWidth / layout.width)));
  const top = Math.max(0, Math.min(modelHeight - 1, Math.round(sourceTop * modelHeight / layout.height)));
  const right = Math.max(left + 1, Math.min(modelWidth, Math.round(sourceRight * modelWidth / layout.width)));
  const bottom = Math.max(top + 1, Math.min(modelHeight, Math.round(sourceBottom * modelHeight / layout.height)));
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function seedreamWhiteCellAlpha(rgb, width, height, channels) {
  const corners = [];
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const offset = (y * width + x) * channels;
    corners.push([rgb[offset], rgb[offset + 1], rgb[offset + 2]]);
  }
  const background = [0, 1, 2].map((channel) =>
    Math.round(corners.reduce((sum, pixel) => sum + pixel[channel], 0) / corners.length),
  );
  const threshold = 18;
  const isForeground = (index) => {
    const offset = index * channels;
    const distance = Math.max(
      Math.abs(rgb[offset] - background[0]),
      Math.abs(rgb[offset + 1] - background[1]),
      Math.abs(rgb[offset + 2] - background[2]),
    );
    return distance > threshold;
  };
  const visited = new Uint8Array(width * height);
  const queue = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
      const index = y * width + x;
      if (visited[index] || isForeground(index)) continue;
      visited[index] = 1;
      queue.push(index);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbors = [];
    if (x > 0) neighbors.push(index - 1);
    if (x + 1 < width) neighbors.push(index + 1);
    if (y > 0) neighbors.push(index - width);
    if (y + 1 < height) neighbors.push(index + width);
    for (const next of neighbors) {
      if (visited[next] || isForeground(next)) continue;
      visited[next] = 1;
      queue.push(next);
    }
  }
  const alpha = Buffer.alloc(width * height, 0);
  for (let index = 0; index < alpha.length; index++) {
    if (visited[index]) continue;
    const offset = index * channels;
    const distance = Math.max(
      Math.abs(rgb[offset] - background[0]),
      Math.abs(rgb[offset + 1] - background[1]),
      Math.abs(rgb[offset + 2] - background[2]),
    );
    alpha[index] = Math.max(180, Math.min(255, Math.round((distance - 2) * 24)));
  }
  return alpha;
}

function isCircularRingBox(box) {
  // Temporarily disabled at the user's request. Keep the detector and the
  // metadata path in place so the depth-aware annulus experiment can be
  // re-enabled later without changing the atlas pipeline again.
  return false;
  /*
  const text = `${box?.id || ""} ${box?.label || ""} ${box?.description || ""}`.toLowerCase();
  // Do not confuse a normal ring-shaped item, ring badge, or circular button
  // with the cyan glowing ring decoration used by the depth test. The annulus
  // constraint is only valid for an explicit glow/effect decoration; applying
  // it to an item removes the item's center and produces the crescent alphas
  // seen in batch 2 cell 8/9.
  const category = String(box?.category || "").toLowerCase();
  const explicitGlow = /(glow|halo|circular\s*(?:glow|effect)|cyan\s*(?:glow|ring))/i.test(text);
  if (!explicitGlow) return false;
  if (category && !["decoration", "effect", "other"].includes(category)) return false;
  const width = Number(box?.bbox?.[2]) || 0;
  const height = Number(box?.bbox?.[3]) || 0;
  return width > 0 && height > 0 && width / height >= 0.72 && width / height <= 1.4;
  */
}

// Seedream's white-background alpha inference is intentionally generic. For
// a circular glow it can classify a map/card visible through the ring as part
// of the same foreground cell. Keep only the annulus around the bbox center;
// the interior is owned by the deeper layer and must remain transparent. A
// narrow feather preserves the glow without producing a hard cut edge.
function constrainSeedreamRingAlpha(alpha, width, height, options = {}) {
  const inner = Number.isFinite(Number(options.inner)) ? Number(options.inner) : 0.78;
  const outer = Number.isFinite(Number(options.outer)) ? Number(options.outer) : 1.06;
  const feather = Number.isFinite(Number(options.feather)) ? Number(options.feather) : 0.035;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const radiusX = Math.max(1, width / 2);
  const radiusY = Math.max(1, height / 2);
  const constrained = Buffer.alloc(alpha.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      let keep = 1;
      if (radius < inner - feather || radius > outer + feather) keep = 0;
      else if (radius < inner) keep = (radius - (inner - feather)) / feather;
      else if (radius > outer) keep = ((outer + feather) - radius) / feather;
      const sourceAlpha = alpha[y * width + x];
      constrained[y * width + x] = Math.round(sourceAlpha * Math.max(0, Math.min(1, keep)));
    }
  }
  return constrained;
}

async function seedreamAtlasAlpha(modelOutput, layout, output) {
  const normalized = await sharp(modelOutput)
    .resize(layout.width, layout.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  const meta = await sharp(normalized).metadata();
  const raw = await sharp(normalized).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAtlas = Buffer.alloc(layout.width * layout.height * 3, 0);
  for (const cell of layout.cells) {
    const cellRgb = Buffer.alloc(cell.width * cell.height * 3);
    for (let y = 0; y < cell.height; y++) {
      for (let x = 0; x < cell.width; x++) {
        const sourceOffset = ((cell.y + y) * raw.info.width + cell.x + x) * raw.info.channels;
        const targetOffset = (y * cell.width + x) * 3;
        cellRgb[targetOffset] = raw.data[sourceOffset];
        cellRgb[targetOffset + 1] = raw.data[sourceOffset + 1];
        cellRgb[targetOffset + 2] = raw.data[sourceOffset + 2];
      }
    }
    const cellAlpha = meta.hasAlpha
      ? (() => {
          const result = Buffer.alloc(cell.width * cell.height);
          for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
            result[y * cell.width + x] = raw.data[((cell.y + y) * raw.info.width + cell.x + x) * raw.info.channels + 3];
          }
          return result;
        })()
      : seedreamWhiteCellAlpha(cellRgb, cell.width, cell.height, 3);
    for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
      const value = cellAlpha[y * cell.width + x];
      const offset = ((cell.y + y) * layout.width + cell.x + x) * 3;
      alphaAtlas[offset] = value;
      alphaAtlas[offset + 1] = value;
      alphaAtlas[offset + 2] = value;
    }
  }
  await sharp(alphaAtlas, { raw: { width: layout.width, height: layout.height, channels: 3 } }).png().toFile(output);
  return { normalized, hasAlpha: meta.hasAlpha };
}

// Seedream occasionally returns the right objects in reading order but moves
// one of them into a neighboring atlas cell. Blind fixed-coordinate slicing
// then assigns every shifted RGB/alpha crop to the wrong bbox. Verify that the
// generated foreground still resembles the source pixels at the same cell
// coordinates. This is deliberately conservative: an uncertain model cell is
// safer to fall back to the source crop than to export a different object.
async function seedreamCellAlignment(sourceCropInput, modelCropInput) {
  const source = await sharp(sourceCropInput)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const model = await sharp(modelCropInput)
    .resize(source.info.width, source.info.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = source.info.width;
  const height = source.info.height;
  const total = width * height;
  const corners = [
    0,
    width - 1,
    (height - 1) * width,
    height * width - 1,
  ].map((pixel) => {
    const offset = pixel * model.info.channels;
    return [model.data[offset], model.data[offset + 1], model.data[offset + 2]];
  });
  const background = [0, 1, 2].map((channel) =>
    Math.round(corners.reduce((sum, pixel) => sum + pixel[channel], 0) / corners.length),
  );
  let hasUsefulAlpha = false;
  for (let pixel = 0; pixel < total; pixel++) {
    if (model.data[pixel * model.info.channels + 3] < 250) {
      hasUsefulAlpha = true;
      break;
    }
  }
  let foregroundPixels = 0;
  let differenceTotal = 0;
  let closePixels = 0;
  for (let pixel = 0; pixel < total; pixel++) {
    const modelOffset = pixel * model.info.channels;
    const sourceOffset = pixel * source.info.channels;
    const backgroundDistance = Math.max(
      Math.abs(model.data[modelOffset] - background[0]),
      Math.abs(model.data[modelOffset + 1] - background[1]),
      Math.abs(model.data[modelOffset + 2] - background[2]),
    );
    const foreground = hasUsefulAlpha
      ? model.data[modelOffset + 3] > 32
      : backgroundDistance > 18;
    if (!foreground) continue;
    foregroundPixels += 1;
    const difference = (
      Math.abs(model.data[modelOffset] - source.data[sourceOffset])
      + Math.abs(model.data[modelOffset + 1] - source.data[sourceOffset + 1])
      + Math.abs(model.data[modelOffset + 2] - source.data[sourceOffset + 2])
    ) / 3;
    differenceTotal += difference;
    if (difference < 45) closePixels += 1;
  }
  const coverage = foregroundPixels / Math.max(1, total);
  const meanDifference = foregroundPixels
    ? differenceTotal / foregroundPixels
    : Number.POSITIVE_INFINITY;
  const closeRatio = foregroundPixels
    ? closePixels / foregroundPixels
    : 0;
  const valid = foregroundPixels >= Math.max(4, Math.ceil(total * 0.003))
    && (meanDifference <= 55 || closeRatio >= 0.68);
  return {
    valid,
    reason: valid
      ? "same_cell_content_verified"
      : foregroundPixels < Math.max(4, Math.ceil(total * 0.003))
        ? "model_cell_empty"
        : "model_cell_content_mismatch",
    coverage: Number(coverage.toFixed(4)),
    mean_rgb_difference: Number.isFinite(meanDifference)
      ? Number(meanDifference.toFixed(2))
      : null,
    close_pixel_ratio: Number(closeRatio.toFixed(4)),
  };
}

function positiveForegroundDescription(box) {
  // Occlusion relations are supplied separately as negative instructions;
  // keeping them out of the positive sentence prevents the model from
  // interpreting “covers=…” as permission to copy the covered object.
  return extractionDescription({
    ...box,
    occludes: [],
    occluded_by: [],
  });
}

function compactPromptText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function compactForegroundDescription(box) {
  if (box?.category === "badge") return "status badge/marker";
  return compactPromptText(
    [
      box?.label || box?.id,
      box?.category,
      box?.role && `role:${box.role}`,
    ]
      .filter(Boolean)
      .join("/"),
    120,
  ) || "foreground object";
}

function compactExcludedObject(item) {
  return compactPromptText(
    [item?.label || item?.id, item?.category].filter(Boolean).join("/"),
    60,
  ) || "lower object";
}

function compactAtlasTarget(box, index, cell) {
  const lower = Array.isArray(box?.atlas_negative_boxes)
    ? box.atlas_negative_boxes.map(compactExcludedObject).filter(Boolean)
    : [];
  // Tuple format is deliberately smaller than repeating verbose JSON keys:
  // [cell_number, [x,y,w,h] input cell, target description, exclusions?].
  return lower.length
    ? [index + 1, [cell.x, cell.y, cell.width, cell.height], compactForegroundDescription(box), lower]
    : [index + 1, [cell.x, cell.y, cell.width, cell.height], compactForegroundDescription(box)];
}

function lowerOcclusionPromptBoxes(box, allBoxes) {
  const byId = new Map((allBoxes || []).map((item) => [String(item.id), item]));
  const queue = Array.isArray(box?.occludes) ? box.occludes.map(String) : [];
  const seen = new Set();
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || id === String(box?.id)) continue;
    seen.add(id);
    const lower = byId.get(id);
    if (!lower || lower.visible === false) continue;
    result.push({
      id: lower.id,
      bbox: lower.bbox,
      label: lower.label,
      category: lower.category,
      description: positiveForegroundDescription(lower),
    });
    for (const next of Array.isArray(lower.occludes) ? lower.occludes : []) {
      if (!seen.has(String(next))) queue.push(String(next));
    }
  }
  return result;
}

function seedreamTargetPromptData(box, index) {
  const lower = Array.isArray(box?.atlas_negative_boxes)
    ? box.atlas_negative_boxes
    : [];
  const compactExclusions = lower.map(compactExcludedObject).filter(Boolean);
  return {
    cell: index + 1,
    id: box.id,
    bbox: box.bbox,
    positive_description: compactForegroundDescription(box),
    negative_description: compactExclusions.length
      ? `Exclude lower objects; keep transparent: ${compactExclusions.join(", ")}.`
      : "",
    lower_bboxes: lower.map((item) => ({
      id: item.id,
      label: item.label,
      category: item.category,
    })),
  };
}

async function extractSeedreamAtlasBatch(source, boxes, loopDir, batchIndex, model, signal, options = {}) {
  if (!boxes.length) throw new Error("GPT Image 2 atlas batch requires boxes");
  // The model atlas is the foreground result. Keep its RGB and alpha together
  // instead of applying the model alpha to RGB copied from the source image.
  const useModelRgb = true;
  // Gemini already decided that these boxes need image-model extraction.
  // Never add a FeyNobg/white-background post-pass to this branch.
  const useFeynobg = false;
  const batchDir = path.join(loopDir, "seedream_atlas", `batch_${String(batchIndex).padStart(2, "0")}`);
  await fsp.mkdir(batchDir, { recursive: true });
  const layout = seedreamAtlasGrid(
    boxes,
    options.atlasSize || options.maxSide || atlasSizeForImageModel(model),
  );
  if (!layout?.fits)
    throw new Error(`GPT Image 2 atlas batch cannot be packed: ${layout?.reason || "bbox_over_gpt_atlas_cell"}`);
  const input = path.join(batchDir, "input.png");
  const generated = path.join(batchDir, "model.png");
  const atlas = path.join(batchDir, "atlas.png");
  await makeSeedreamAtlasInput(source, boxes, layout, input);
  const targetInstructions = boxes.map((box, index) =>
    compactAtlasTarget(box, index, layout.cells[index]),
  );
  const prompt = `Extract ${boxes.length} foreground objects from this ${layout.width}x${layout.height} atlas. Target tuples are [cell,rect,description,exclude?], where rect=[x,y,w,h] is the fixed-size input cell and exclude lists lower objects that must stay transparent. Every target cell in this atlas has exactly the same width and height; the target crop is centered inside its numbered cell. Some small objects were uniformly enlarged inside their input cell for recognition; preserve that cell position and return the corresponding object only. Keep only the described object in each rect; make all other pixels transparent. Preserve appearance, orientation and proportions. Do not move, resize, reflow, reorder, crop, merge, or bleed across cell boundaries. Put target 1 back in cell 1, target 2 in cell 2, and so on. Remove neighboring UI/background. Return one transparent PNG at the model response size, mapping positions uniformly from this input atlas. Targets:${JSON.stringify(targetInstructions)}`;
  // The atlas request follows the configured native packing canvas. Ordinary
  // single-image extraction calls continue to use imageEditSizeFor().
  const outputSize = isGptImageModel(model)
    ? gptImageAtlasResponseSize(layout)
    : "1K";
  await fsp.writeFile(
    path.join(batchDir, "request.json"),
    JSON.stringify(
      {
        model,
        quality: FOREGROUND_ATLAS_QUALITY,
        method: isGptImageModel(model) ? "images.edit (GPT Image 2/2.5)" : "images.generations (Volcano Ark image edit)",
        input,
        layout,
        input_atlas_size: `${layout.width}x${layout.height}`,
        model_response_size: outputSize,
        final_atlas_mode: "model_response_unmodified_fixed_cell_grid",
        atlas_packing: layout.packing,
        fixed_cell_size: [layout.cell_width, layout.cell_height],
        grid: {
          columns: layout.columns,
          rows: layout.rows,
          empty_cells: layout.empty_cells || 0,
          offset: layout.grid_offset || [0, 0],
        },
        target_instructions: targetInstructions,
        target_instructions_format: "[cell,[x,y,w,h],description,exclude?]",
        use_model_output: useModelRgb,
        use_feynobg: useFeynobg,
        prompt,
      },
      null,
      2,
    ),
  );
  const requestId = options.requestId || `loop_${path.basename(loopDir)}_atlas_${batchIndex}`;
  const timeoutMs = imageRequestTimeoutMs({...options, clientKind: "foreground"});
  if (typeof options.onRequestReady === "function") {
    await options.onRequestReady({
      request_id: requestId,
      attempt: Math.max(1, Number(options.attempt) || 1),
      input,
      request: path.join(batchDir, "request.json"),
      batch_dir: batchDir,
      batch: batchIndex,
      timeout_ms: timeoutMs,
      started_at: new Date().toISOString(),
      box_ids: boxes.map((box) => String(box.id)),
      layout,
    });
  }
  await imageEdit(input, generated, prompt, model, undefined, signal, {
    imagePaths: [input],
    provider: "openai",
    clientKind: "foreground-image",
    background: "transparent",
    inputFidelity: "high",
    size: outputSize,
    resizeOutput: false,
    quality: FOREGROUND_ATLAS_QUALITY,
    timeoutMs,
  });
  return splitSeedreamAtlasModel({ source, boxes, modelOutput: generated, batchDir, layout, model, batchIndex });
}

// Also used to repair saved Atlas results without another image request.
async function splitSeedreamAtlasModel({ source, boxes, modelOutput, batchDir, layout, model, batchIndex, preserveAspectRatio = false, preserveSourceBounds = false }) {
  const generated = modelOutput;
  const input = path.join(batchDir, "input.png");
  const atlas = path.join(batchDir, "atlas.png");
  const generatedMeta = await sharp(generated).metadata();
  if (!generatedMeta.width || !generatedMeta.height)
    throw new Error("GPT Image 2 atlas response has no dimensions");
  if (!generatedMeta.hasAlpha)
    throw new Error("GPT Image 2 atlas response has no alpha channel; final atlas is not post-processed");
  // The final atlas is intentionally a byte-for-byte copy of GPT Image 2's
  // response. Alpha validation, source-RGB replacement and atlas rebuilding
  // are deliberately not applied to this user-visible artifact.
  await fsp.copyFile(generated, atlas);
  // Keep the requested target order authoritative, but allow the model to
  // enlarge an object beyond the small recognition crop inside its cell. Use
  // the tight bounds of the Alpha components grouped by fixed cell order. No
  // semantic matching or Hungarian reassignment is used: cell N maps to target
  // N, and disconnected Alpha pieces in that cell are unioned together.
  const textAtlas = boxes.length > 0 && boxes.every(box => box.category === 'text');
  const returnedRegions = textAtlas
    ? await detectTextAtlasRegions(generated, boxes, layout)
    : await detectGptAtlasRegions(generated, boxes, layout);
  const useReturnedFixedCell = (textAtlas || returnedRegions.matching_strategy === "fixed_cell_alpha_grouping") &&
    returnedRegions.regions.length === boxes.length;
  const splitRegions = useReturnedFixedCell
    ? {
        ...returnedRegions,
        method: textAtlas ? "complete_text_components" : "fixed_cell_order_alpha_crop",
        reason: "direct_model_rgba_split_by_fixed_target_order_and_returned_alpha_bounds",
        matching_strategy: "fixed_cell_order_alpha_grouping",
      }
    : { ...returnedRegions, method: "visual_atlas_ownership_unresolved",
        crop_integrity: { status: "failed", reason: returnedRegions.reason || "missing_returned_target_ownership" } };
  const splitRegionsPath = path.join(batchDir, "split_regions.json");
  if (!textAtlas && useReturnedFixedCell)
    splitRegions.crop_integrity = await inspectVisualCrops(generated, splitRegions.regions);
  await fsp.writeFile(splitRegionsPath, JSON.stringify(splitRegions, null, 2));
  if (splitRegions.crop_integrity) assertVisualCrops(splitRegions.crop_integrity);
  const canvas = await sharp(source).metadata();
  const layers = [];
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const cell = layout.cells[index];
    const [x, y, width, height] = box.bbox;
    const preserveSilhouetteAspect = preserveAspectRatio && preserveModelAspect(box);
    const safeName = `${String(index + 1).padStart(3, "0")}_${box.id}`;
    const sourceCropPath = path.join(batchDir, "layers", `${safeName}_source_crop.png`);
    const modelCropPath = path.join(batchDir, "layers", `${safeName}_model_crop.png`);
    await fsp.mkdir(path.dirname(sourceCropPath), { recursive: true });
    await sharp(source)
      .extract({ left: x, top: y, width, height })
      .png()
      .toFile(sourceCropPath);
    const splitRegion = splitRegions.regions[index];
    const modelRect = splitRegion.rect;
    let targetBounds=box.bbox,sourceGeometryGrounded=false;
    if(preserveSourceBounds && box.source_bbox) {
      const [sx,sy,sw,sh]=box.source_bbox;
      if(sx>=x && sy>=y && sx+sw<=x+width && sy+sh<=y+height){targetBounds=box.source_bbox;sourceGeometryGrounded=true;}
    }
    const rendered=await placeModelRgba(generated,modelRect,box.bbox,targetBounds,
      preserveAspectRatio && (!sourceGeometryGrounded || preserveSilhouetteAspect));
    const modelCellBuffer = rendered.buffer;
    const [, , layerWidth, layerHeight] = rendered.bbox;
    await fsp.writeFile(modelCropPath, modelCellBuffer);
    const modelCrop = await sharp(modelCellBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaCrop = Buffer.alloc(layerWidth * layerHeight);
    for (let pixel = 0; pixel < alphaCrop.length; pixel++)
      alphaCrop[pixel] = modelCrop.data[pixel * modelCrop.info.channels + 3];
    const cutout = path.join(batchDir, "layers", `${safeName}.png`);
    const alphaPath = path.join(batchDir, "layers", `${safeName}_alpha.png`);
    const guide = path.join(batchDir, "layers", `${safeName}_bbox_guide.png`);
    await fsp.mkdir(path.dirname(cutout), { recursive: true });
    // Keep model RGB and alpha together, including pixels outside the original
    // bbox. That bbox still locates the source target; rendered.bbox places the
    // expanded PNG in the composite and PSD.
    await fsp.copyFile(modelCropPath, cutout);
    await writeAlphaPreview(alphaCrop, layerWidth, layerHeight, alphaPath);
    await makeForegroundGuide(source, { bbox: box.bbox }, guide);
    layers.push({
      id: box.id,
      name: box.label,
      category: box.category,
      description: extractionDescription(box),
      source_bbox: box.bbox,
      working_bbox: rendered.bbox,
      bbox: rendered.bbox,
      source: path.resolve(cutout),
      raw_source: path.resolve(source),
      source_crop: path.resolve(sourceCropPath),
      model_crop: path.resolve(modelCropPath),
      bbox_guide: path.resolve(guide),
      generated_source: path.resolve(generated),
      model_generated_source: path.resolve(generated),
      atlas_alpha: path.resolve(alphaPath),
      atlas_cell: {
        index: index + 1,
        rect: [cell.x, cell.y, cell.width, cell.height],
        native_rect: [
          cell.x,
          cell.y,
          Number(cell.native_width) || width,
          Number(cell.native_height) || height,
        ],
        input_scale: Number(cell.input_scale) || 1,
        pre_cap_input_scale: Number(cell.pre_cap_input_scale) || Number(cell.input_scale) || 1,
        atlas_scale: Number(cell.atlas_scale) || 1,
        model_rect: [modelRect.left, modelRect.top, modelRect.width, modelRect.height],
        recovered_alpha_pixels: splitRegion.recovered_alpha_pixels || 0,
        component_bbox: splitRegion.component_bbox || null,
        component_index: splitRegion.component_index ?? null,
      },
      atlas_split_method: splitRegions.method,
      atlas_aspect_preserved: Boolean(preserveAspectRatio && (!sourceGeometryGrounded || preserveSilhouetteAspect)),
      atlas_original_geometry_preserved: sourceGeometryGrounded && !preserveSilhouetteAspect,
      atlas_original_geometry_bbox: sourceGeometryGrounded ? targetBounds : null,
      atlas_source_bounds_preserved: Boolean(preserveSourceBounds),
      atlas_source_bounds_fit: preserveSourceBounds ? (!sourceGeometryGrounded || preserveSilhouetteAspect ? 'uniform_contain_downscale_only' : 'original_bbox_ratio_downscale_only') : null,
      atlas_resize_scale: rendered.placement.scale,
      model_placement: rendered.placement,
      semantic_bbox: preserveSourceBounds ? box.source_bbox || box.bbox : null,
      atlas_component_count: splitRegions.component_count,
      atlas_split_debug: path.resolve(splitRegionsPath),
      alpha_alignment: useReturnedFixedCell
        ? "gpt_image_2_returned_alpha_bounds_direct"
        : "gpt_image_2_expanded_fixed_cell_alpha_direct",
      parent_id: box.parent_id,
      occludes: box.occludes,
      occluded_by: box.occluded_by,
      confidence: box.confidence,
      extraction_model: model,
      foreground_model: model,
      matting_model: model,
      extraction_method: `${model}-batch-atlas-component-split-model-rgb-direct`,
      alpha_mode: useReturnedFixedCell
        ? "gpt_image_2_raw_returned_alpha_direct_model_crop"
        : "gpt_image_2_raw_fixed_cell_alpha_direct_model_crop",
      feynobg_used: false,
      use_model_output_requested: true,
      use_model_output: true,
      model_output_fallback: null,
      feynobg_alpha: null,
      crop_mode: useReturnedFixedCell ? "preserve_bbox_canvas" : "preserve_model_overflow_canvas",
      atlas_batch: batchIndex,
      atlas_batch_size: boxes.length,
      atlas_native_single: layout.native_single === true,
      atlas_input_size: [layout.width, layout.height],
    });
  }
  await fsp.writeFile(path.join(batchDir, "layers.json"), JSON.stringify(layers, null, 2));
  return {
    layers,
    atlas,
    input,
    generated,
    inferredAlpha: null,
    alpha: null,
    request: path.join(batchDir, "request.json"),
    response_width: generatedMeta.width,
    response_height: generatedMeta.height,
    final_atlas_mode: "model_response_unmodified",
    split_regions: splitRegionsPath,
    atlas_split_method: splitRegions.method,
    atlas_component_count: splitRegions.component_count,
    ...layout,
  };
}

// A box that cannot share the compact atlas still uses a one-cell GPT Image 2
// atlas. This keeps the image input bounded to the model-specific atlas canvas
// (816x816 for GPT Image 2, 256x256 for legacy Ark) whenever possible and
// preserves native pixels for a bbox larger than that by making a dedicated
// native-size atlas. The returned layer is marked as an individual route.
async function extractGptSingleAtlasBox(source, box, loopDir, batchIndex, model, signal, options = {}) {
  const result = await extractSeedreamAtlasBatch(
    source,
    [box],
    loopDir,
    batchIndex,
    model,
    signal,
    { ...options, useFeynobg: false, atlasSize: atlasSizeForImageModel(model) },
  );
  const layer = result.layers?.[0];
  if (!layer) throw new Error(`GPT Image 2 single atlas did not return ${box.id}`);
  for (const key of ["atlas_batch", "atlas_batch_size", "atlas_layout", "atlas_cell"]) delete layer[key];
  layer.extraction_method = String(layer.extraction_method || "").replace("-batch-atlas-", "-single-atlas-");
  layer.atlas_bypassed = true;
  layer.atlas_bypass_reason = options.reason || "single_bbox_atlas";
  layer.atlas_native_single = result.native_single === true;
  layer.atlas_input_size = [Number(result.width) || atlasSizeForImageModel(model), Number(result.height) || atlasSizeForImageModel(model)];
  return layer;
}

function imageEditSizeFor(sourceWidth, sourceHeight) {
  if (!sourceWidth || !sourceHeight) return "auto";
  if (sourceWidth === sourceHeight) return "1024x1024";
  return sourceWidth > sourceHeight ? "1536x1024" : "1024x1536";
}
function normalizeBox(raw, width, height) {
  const arr = Array.isArray(raw)
    ? raw
    : [raw?.x, raw?.y, raw?.width, raw?.height];
  if (arr.length !== 4 || arr.some((v) => !Number.isFinite(Number(v))))
    return null;
  let [x, y, w, h] = arr.map(Number);
  if (
    Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h)) <= 1 &&
    Math.max(width, height) > 4
  ) {
    x *= width;
    y *= height;
    w *= width;
    h *= height;
  }
  x = Math.max(0, Math.min(Math.round(x), width - 1));
  y = Math.max(0, Math.min(Math.round(y), height - 1));
  w = Math.max(1, Math.min(Math.round(w), width - x));
  h = Math.max(1, Math.min(Math.round(h), height - y));
  return [x, y, w, h];
}

function clampBboxPadding(value, fallback = 3) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.min(64, Math.round(numeric)))
    : fallback;
}

function expandBboxForExtraction(box, padding, width, height) {
  const amount = clampBboxPadding(padding, 0);
  if (!box?.bbox || !amount || !width || !height) return box;
  const [x, y, w, h] = box.bbox;
  const right = Math.min(width, x + w + amount);
  const bottom = Math.min(height, y + h + amount);
  const next = {
    ...box,
    bbox: [
      Math.max(0, x - amount),
      Math.max(0, y - amount),
      Math.max(1, right - Math.max(0, x - amount)),
      Math.max(1, bottom - Math.max(0, y - amount)),
    ],
    bbox_padding_px: amount,
    model_bbox: box.model_bbox || [...box.bbox],
  };
  return next;
}

function safeId(value, fallback) {
  const id = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return id || fallback;
}
function expandCompactDetection(data) {
  if (!data || typeof data !== "object") return data;
  const compactBoxes = Array.isArray(data.b) ? data.b : null;
  const raw = compactBoxes || (Array.isArray(data.boxes) ? data.boxes : data.regions);
  const hasCompactTop = compactBoxes || Array.isArray(data.c) || data.s !== undefined;
  if (!hasCompactTop && !raw) return data;
  const expandHint = (hint) => {
    if (!Array.isArray(hint)) return hint;
    return {
      bbox_norm: hint[0],
      positive_points_norm: hint[1] || [],
      negative_points_norm: hint[2] || [],
    };
  };
  const expandBox = (item) => {
    if (Array.isArray(item)) {
      const [i, l, k, role, mode, bbox, parent, z, confidence, occludes, occludedBy, hints, reason, visible, removeByMatte, matteReason] = item;
      return {
        id: i,
        label: l,
        category: k,
        role,
        element_repair_mode: mode,
        bbox,
        parent_id: parent,
        z_index: z,
        confidence,
        occludes,
        occluded_by: occludedBy,
        geometry_hints: Array.isArray(hints) ? hints.map(expandHint) : [],
        reason,
        visible: visible !== 0 && visible !== false,
        remove_by_matte: removeByMatte,
        matte_reason: matteReason,
      };
    }
    if (!item || typeof item !== "object") return item;
    const hints = item.geometry_hints ?? item.g;
    return {
      ...item,
      id: item.id ?? item.i,
      label: item.label ?? item.l,
      category: item.category ?? item.k,
      role: item.role ?? item.r,
      element_repair_mode: item.element_repair_mode ?? item.m,
      bbox: item.bbox ?? item.b,
      parent_id: item.parent_id ?? item.p,
      z_index: item.z_index ?? item.z,
      confidence: item.confidence ?? item.c,
      occludes: item.occludes ?? item.o,
      occluded_by: item.occluded_by ?? item.u,
      geometry_hints: Array.isArray(hints) ? hints.map(expandHint) : hints,
      reason: item.reason ?? item.t,
      visible: item.visible ?? item.v ?? true,
      remove_by_matte: item.remove_by_matte ?? item.remove_by_matt ?? item.a ?? false,
      matte_reason: item.matte_reason ?? item.h ?? "",
    };
  };
  const repair = data.background_repair || (Array.isArray(data.r)
    ? { mode: data.r[0], reason: data.r[1] }
    : null);
  const canvas = data.canvas || (Array.isArray(data.c)
    ? { width: data.c[0], height: data.c[1] }
    : null);
  return {
    ...data,
    canvas: canvas || data.canvas,
    scene_summary: data.scene_summary ?? data.s,
    background_repair: repair || data.background_repair,
    boxes: raw ? raw.map(expandBox) : data.boxes,
    occlusion_tree: data.occlusion_tree || {
      front_to_back: Array.isArray(data.f) ? data.f : [],
      roots: Array.isArray(data.q) ? data.q : [],
    },
  };
}
// Gemini occasionally returns pixel-looking bboxes in its 0-1000 image
// coordinate convention even after the prompt explicitly names the attached
// canvas dimensions. Detect that signature and convert it before the normal
// canvas normalization step. The raw response file remains untouched.
function repairGeminiNormalizedCoordinates(data, model, width, height) {
  if (model !== "gemini-3.8-flash")
    return { value: data, mode: null };
  const declaredCanvas = data?.canvas || (Array.isArray(data?.c)
    ? { width: data.c[0], height: data.c[1] }
    : null);
  const declaredWidth = Number(declaredCanvas?.width) || width;
  const declaredHeight = Number(declaredCanvas?.height) || height;
  const raw = Array.isArray(data?.b)
    ? data.b
    : Array.isArray(data?.boxes)
      ? data.boxes
      : Array.isArray(data?.regions)
        ? data.regions
        : [];
  if (!raw.length) return { value: data, mode: null };
  const boxes = raw.map((item) => {
    if (Array.isArray(item)) return item[5];
    return item?.bbox ?? item?.b;
  });
  if (boxes.some((box) => !Array.isArray(box) || box.length !== 4 || box.some((v) => !Number.isFinite(Number(v)))))
    return { value: data, mode: null };
  const coordinateFormat = String(
    data?.coord || data?.coordinate_format || data?.coordinateFormat || "",
  ).toLowerCase();
  const nativeYxyx =
    /gemini.*yxyx.*1000|ymin.*xmin.*ymax.*xmax/.test(coordinateFormat) ||
    (declaredWidth === 1000 && declaredHeight === 1000);
  if (nativeYxyx) {
    const fixed = JSON.parse(JSON.stringify(data));
    const fixedBoxes = Array.isArray(fixed.b)
      ? fixed.b
      : Array.isArray(fixed.boxes)
        ? fixed.boxes
        : fixed.regions;
    for (const item of fixedBoxes) {
      const box = Array.isArray(item) ? item[5] : item.bbox ?? item.b;
      const [yMin, xMin, yMax, xMax] = box.map(Number);
      const scaled = [
        Math.round((xMin * width) / 1000),
        Math.round((yMin * height) / 1000),
        Math.max(1, Math.round(((xMax - xMin) * width) / 1000)),
        Math.max(1, Math.round(((yMax - yMin) * height) / 1000)),
      ];
      if (Array.isArray(item)) item[5] = scaled;
      else if (Array.isArray(item.bbox)) item.bbox = scaled;
      else item.b = scaled;
    }
    if (Array.isArray(fixed.c)) fixed.c = [width, height];
    if (fixed.canvas && typeof fixed.canvas === "object")
      fixed.canvas = { ...fixed.canvas, width, height };
    fixed.coordinate_scale_mode = "gemini_yxyx_1000_to_attached_canvas";
    fixed.coordinate_scale = { x: width / 1000, y: height / 1000 };
    return { value: fixed, mode: fixed.coordinate_scale_mode };
  }
  if (raw.length < 4) return { value: data, mode: null };
  let maxRight = 0;
  let maxBottom = 0;
  for (const box of boxes) {
    const [x, y, w, h] = box.map(Number);
    maxRight = Math.max(maxRight, x + w);
    maxBottom = Math.max(maxBottom, y + h);
  }
  // Require both axes to look like a populated 0-1000 canvas. This avoids
  // scaling a legitimate original-coordinate response whose objects happen
  // to occupy only the left/top portion of a large screenshot.
  const looksNormalized =
    maxRight <= 1024 &&
    maxBottom <= 1024 &&
    maxRight >= 850 &&
    maxBottom >= 750 &&
    ((declaredWidth >= 1200 && maxRight / declaredWidth < 0.75) ||
      maxRight > declaredWidth * 1.15 ||
      maxBottom > declaredHeight * 1.15);
  if (!looksNormalized) return { value: data, mode: null };
  const fixed = JSON.parse(JSON.stringify(data));
  const fixedBoxes = Array.isArray(fixed.b)
    ? fixed.b
    : Array.isArray(fixed.boxes)
      ? fixed.boxes
      : fixed.regions;
  for (const item of fixedBoxes) {
    const box = Array.isArray(item) ? item[5] : item.bbox ?? item.b;
    const [x, y, w, h] = box.map(Number);
    const scaled = [
      Math.round((x * width) / 1000),
      Math.round((y * height) / 1000),
      Math.round((w * width) / 1000),
      Math.round((h * height) / 1000),
    ];
    if (Array.isArray(item)) item[5] = scaled;
    else if (Array.isArray(item.bbox)) item.bbox = scaled;
    else item.b = scaled;
  }
  fixed.coordinate_scale_mode = "gemini_0_1000_to_attached_canvas";
  fixed.coordinate_scale = { x: width / 1000, y: height / 1000 };
  return { value: fixed, mode: fixed.coordinate_scale_mode };
}

function normalizeDetection(data, width, height) {
  data = expandCompactDetection(data) || {};
  const raw = Array.isArray(data?.boxes)
    ? data.boxes
    : Array.isArray(data?.regions)
      ? data.regions
      : [];
  const boxes = [];
  const idMap = new Map();
  const reported = data?.canvas || data?.image_size || {};
  const rw = Number(reported.width) || width;
  const rh = Number(reported.height) || height;
  const sx = width / rw,
    sy = height / rh;
  const normalizeTextColor = (value) => {
    if (Array.isArray(value) && value.length >= 3) {
      const channels = value.slice(0, 3).map((item) => Math.max(0, Math.min(255, Math.round(Number(item) || 0))));
      return { r: channels[0], g: channels[1], b: channels[2] };
    }
    if (value && typeof value === "object" && ["r", "g", "b"].every((key) => value[key] !== undefined))
      return {
        r: Math.max(0, Math.min(255, Math.round(Number(value.r) || 0))),
        g: Math.max(0, Math.min(255, Math.round(Number(value.g) || 0))),
        b: Math.max(0, Math.min(255, Math.round(Number(value.b) || 0))),
      };
    const hex = String(value || "").trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(hex))
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    return null;
  };
  const boolFlag = (value) => value === true || value === 1 || String(value || "").toLowerCase() === "true";
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const firstHint = Array.isArray(item.geometry_hints)
      ? item.geometry_hints.find((hint) => Array.isArray(hint?.bbox_norm))
      : null;
    const b = normalizeBox(item.bbox || firstHint?.bbox_norm || item, width, height);
    if (!b) return;
    if (sx !== 1 || sy !== 1) {
      b[0] = Math.round(b[0] * sx);
      b[1] = Math.round(b[1] * sy);
      b[2] = Math.round(b[2] * sx);
      b[3] = Math.round(b[3] * sy);
    }
    b[0] = Math.max(0, Math.min(b[0], width - 1));
    b[1] = Math.max(0, Math.min(b[1], height - 1));
    b[2] = Math.max(1, Math.min(b[2], width - b[0]));
    b[3] = Math.max(1, Math.min(b[3], height - b[1]));
    const rawId = String(item.id || `box_${index + 1}`);
    let id = safeId(rawId, `box_${index + 1}`);
    if (boxes.some((x) => x.id === id)) id += `_${index + 1}`;
    const cat = ALLOWED.has(String(item.category || "").toLowerCase())
      ? String(item.category).toLowerCase()
      : "other";
    idMap.set(rawId, id);
    idMap.set(safeId(rawId, rawId), id);
    const textContent = String(item.text_content ?? item.textContent ?? item.tx ?? (cat === "text" ? item.label || "" : ""));
    const textFontSize = Number(item.font_size ?? item.fontSize ?? item.fs);
    const textColor = normalizeTextColor(item.fill_color ?? item.fillColor ?? item.text_color ?? item.textColor ?? item.fc);
    boxes.push({
      id,
      label: String(item.label || id),
      category: cat,
      role: String(item.role || ""),
      element_repair_mode: ["image", "surface", "none"].includes(
        String(item.element_repair_mode || "").toLowerCase(),
      )
        ? String(item.element_repair_mode).toLowerCase()
        : "none",
      bbox: b,
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      visible: item.visible !== false,
      parent_id: item.parent_id || null,
      occludes: Array.isArray(item.occludes) ? item.occludes.map(String) : [],
      occluded_by: Array.isArray(item.occluded_by)
        ? item.occluded_by.map(String)
        : [],
      z_index: Number(item.z_index) || 0,
      reason: String(item.reason || ""),
      remove_by_matte:
        item.remove_by_matte === true ||
        item.remove_by_matte === 1 ||
        String(item.remove_by_matte || "").toLowerCase() === "true",
      matte_reason: String(item.matte_reason || ""),
      text_content: cat === "text" ? textContent : "",
      text_font_family: cat === "text" ? String(item.font_family ?? item.fontFamily ?? item.fn ?? "ArialMT") : "",
      text_font_size: cat === "text" && Number.isFinite(textFontSize) && textFontSize > 0 ? textFontSize : null,
      text_fill_color: cat === "text" ? textColor : null,
      text_bold: cat === "text" ? boolFlag(item.bold ?? item.bd) : false,
      text_italic: cat === "text" ? boolFlag(item.italic ?? item.it) : false,
      text_align: cat === "text" && ["left", "center", "right"].includes(String(item.align ?? item.al).toLowerCase())
        ? String(item.align ?? item.al).toLowerCase()
        : "left",
      geometry_hints: Array.isArray(item.geometry_hints)
        ? item.geometry_hints
            .filter((hint) => hint && Array.isArray(hint.bbox_norm))
            .map((hint) => ({
              bbox_norm: hint.bbox_norm.slice(0, 4).map(Number),
              positive_points_norm: Array.isArray(hint.positive_points_norm)
                ? hint.positive_points_norm
                : [],
              negative_points_norm: Array.isArray(hint.negative_points_norm)
                ? hint.negative_points_norm
                : [],
            }))
        : [],
    });
  });
  const ids = new Set(boxes.map((b) => b.id));
  const resolve = (v) =>
    idMap.get(v) || idMap.get(safeId(v, v)) || (ids.has(v) ? v : null);
  for (const box of boxes) {
    box.occludes = [
      ...new Set(box.occludes.map(resolve).filter((x) => x && x !== box.id)),
    ];
    box.occluded_by = [
      ...new Set(box.occluded_by.map(resolve).filter((x) => x && x !== box.id)),
    ];
    box.parent_id = box.parent_id ? resolve(box.parent_id) : null;
  }
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
  // The article's planner treats parent_id as the nearest material parent.
  // Make that chain usable by the recursive depth pass even when the model
  // omits verbose transitive occludes/occluded_by arrays.
  boxes.forEach((child) => {
    const parent = child.parent_id ? byId[child.parent_id] : null;
    if (!parent || parent.id === child.id) return;
    child.occluded_by = child.occluded_by.filter((id) => id !== parent.id);
    parent.occludes = parent.occludes.filter((id) => id !== child.id);
    if (!child.occludes.includes(parent.id)) child.occludes.push(parent.id);
    if (!parent.occluded_by.includes(child.id)) parent.occluded_by.push(child.id);
  });
  boxes.forEach((b) =>
    b.occludes.forEach((target) => {
      if (byId[target] && !byId[target].occluded_by.includes(b.id))
        byId[target].occluded_by.push(b.id);
    }),
  );
  boxes.forEach((b) =>
    b.occluded_by.forEach((front) => {
      if (byId[front] && !byId[front].occludes.includes(b.id))
        byId[front].occludes.push(b.id);
    }),
  );
  const front = [];
  const requested = data?.occlusion_tree?.front_to_back;
  if (Array.isArray(requested))
    requested
      .map(resolve)
      .filter((x) => x && !front.includes(x))
      .forEach((x) => front.push(x));
  boxes
    .filter((b) => b.visible && b.occluded_by.length === 0)
    .forEach((b) => {
      if (!front.includes(b.id)) front.push(b.id);
    });
  boxes.forEach((b) => {
    if (!front.includes(b.id)) front.push(b.id);
  });
  return {
    canvas: { width, height },
    scene_summary: String(data?.scene_summary || ""),
    background_repair:
      data?.background_repair &&
      ["scene", "surface", "none"].includes(
        String(data.background_repair.mode || "").toLowerCase(),
      )
        ? {
            mode: String(data.background_repair.mode).toLowerCase(),
            reason: String(data.background_repair.reason || ""),
          }
        : { mode: "none", reason: "" },
    reported_canvas: { width: rw, height: rh },
    coordinate_scale: { x: sx, y: sy },
    boxes,
    occlusion_tree: {
      front_to_back: front,
      roots: boxes
        .filter((b) => b.visible && !b.occluded_by.length)
        .map((b) => b.id),
    },
  };
}
async function generateCandidate(source, output, model, signal) {
  return imageEdit(source, output, BBOX_CANDIDATE_PROMPT, model, undefined, signal, {
    provider: "openai",
    clientKind: "background-image",
  });
}
async function analyzeBboxes(
  source,
  candidate,
  model,
  loop = 1,
  signal,
  modelInputs = {},
) {
  const size = await sharp(source).metadata();
  const client = openaiClient("controller");
  const direct = !candidate;
  // A full-image response can contain hundreds of boxes and also spends
  // completion budget on hidden reasoning. Keep ROI batches compact, but
  // give the opt-in single-image path enough room to finish its JSON.
  const maxCompletionTokens = Number(
    modelInputs.maxCompletionTokens ||
      (model === "gemini-3.8-flash"
        ? BBOX_SINGLE_MAX_COMPLETION_TOKENS * 2
        : BBOX_SINGLE_MAX_COMPLETION_TOKENS),
  );
  const reasoningEffort = isReasoningControllerModel(model)
    ? Object.prototype.hasOwnProperty.call(modelInputs, "reasoningEffort")
      ? (modelInputs.reasoningEffort
        ? String(modelInputs.reasoningEffort)
        : null)
      : "high"
    : null;
  const sourceInput = modelInputs.source || source;
  const candidateInput = modelInputs.candidate || candidate;
  // When an img2 proposal is available, callers may provide a single
  // original-plus-red-strokes reference image. It preserves the hint while
  // keeping the controller request to one image input.
  const referenceInput = modelInputs.reference || null;
  const attachedInput = referenceInput || sourceInput;
  const inputSize = await sharp(attachedInput).metadata();
  const images = [
    {
      type: "image_url",
      image_url: {
        url: dataUrl(attachedInput),
        detail: modelInputs.imageDetail || "high",
      },
    },
  ];
  if (!direct && !referenceInput)
    images.push({
      type: "image_url",
      // The candidate is only a visual hint. Keeping it low-detail avoids
      // doubling the image-token budget while the original remains high
      // detail for coordinate accuracy.
      image_url: { url: dataUrl(candidateInput), detail: "low" },
    });
  const coordinateInstruction = model === "gemini-3.8-flash"
    ? `Gemini coordinate-format override: use Gemini's native normalized box convention for every b value. ` +
      `Each b MUST be [y_min, x_min, y_max, x_max], with every coordinate independently normalized to integers from 0 through 1000 against the full attached image. ` +
      `This overrides every earlier [x,y,width,height] statement in the generic schema. Never put width or height in b. ` +
      `Set the top-level c to [1000,1000] and add the exact top-level field "coord":"gemini_yxyx_1000". ` +
      `The attached image is ${inputSize.width} x ${inputSize.height} pixels and the backend will convert the native Gemini boxes to that canvas. ` +
      `Example: a box spanning left=10%, top=20%, right=30%, bottom=40% is b=[200,100,400,300].`
    : `The attached analysis image canvas is exactly ${inputSize.width} x ${inputSize.height} pixels. ` +
      `Return canvas as ${inputSize.width} x ${inputSize.height} and express every bbox in those attached-image pixel coordinates. ` +
      `The original production canvas is ${size.width} x ${size.height}; the backend will map your attached-image coordinates back to it. ` +
      "Do not calculate or return original-production-canvas coordinates.";
  const analysisPrompt = modelInputs.analysisPrompt || (direct && modelInputs.compactResponse
    ? COMPACT_DIRECT_BBOX_PROMPT
    : direct
      ? DIRECT_BBOX_ANALYSIS_PROMPT
      : referenceInput
        ? BBOX_ANALYSIS_PROMPT.replace(
            "The first attached image is the original screenshot and is the only pixel-level ground truth. The second image is an image-model red-box proposal; it may be wrong, incomplete, duplicated, or shifted. Correct it by inspecting the original.",
            "The single attached image is the original screenshot with an image-model red-box proposal overlaid. The original pixels are the only ground truth; the red strokes may be wrong, incomplete, duplicated, or shifted. Correct them by inspecting the underlying screenshot.",
          )
        : BBOX_ANALYSIS_PROMPT
  )
    .replaceAll("IMAGE_WIDTH", String(inputSize.width))
    .replaceAll("IMAGE_HEIGHT", String(inputSize.height));
  const messages = [
    {
      role: "system",
      content:
        "You are a senior game-UI asset planner and pixel-accurate bbox/occlusion-tree annotator. Preserve whole-element identity under occlusion.",
    },
    {
      role: "user",
      content: [
        ...images,
        {
          type: "text",
          text: referenceInput
            ? `${analysisPrompt}\n${coordinateInstruction} The single attached image contains the current working image with optional red proposal strokes. Treat underlying non-red pixels as ground truth and correct the proposal.`
            : direct
              ? `${analysisPrompt}\n${coordinateInstruction} Analyze the first attached image directly; there is no proposal image.`
              : `${analysisPrompt}\n${coordinateInstruction} Correct the second attached red-box proposal for shared recursive pass ${loop}.`,
        },
      ],
    },
  ];
  const makeRequest = (
    requestMessages = messages,
    requestReasoningEffort = reasoningEffort,
  ) => ({
    model,
    response_format: { type: "json_object" },
    ...(requestReasoningEffort
      ? { reasoning_effort: requestReasoningEffort }
      : {}),
    max_completion_tokens: maxCompletionTokens,
    messages: requestMessages,
  });
  const request = makeRequest();
  const loggedMessagesFor = (sourceMessages) =>
    sourceMessages.map((message) => {
      let imageIndex = 0;
      return {
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((item) => {
              if (item.type !== "image_url") return item;
              const file = imageIndex++ === 0
                ? attachedInput
                : candidateInput;
              return {
                type: "image_url",
                image_url: { file: path.resolve(file), detail: item.image_url.detail },
              };
            })
          : message.content,
      };
    });
  if (modelInputs.requestLog) {
    await fsp.writeFile(
      modelInputs.requestLog,
      JSON.stringify(
        {
          endpoint: "chat.completions.create",
          request: { ...request, messages: loggedMessagesFor(messages) },
          original_canvas: { width: size.width, height: size.height },
          analysis_canvas: { width: inputSize.width, height: inputSize.height },
          note: "Image data URLs are represented by their exact local files; API key is omitted.",
        },
        null,
        2,
      ),
    );
  }
  const responseLogPrefix = modelInputs.requestLog
    ? modelInputs.requestLog
        .replace(/_request\.json$/i, "")
        .replace(/\.json$/i, "")
    : null;
  const adaptiveSingleGpt =
    direct && modelInputs.compactResponse && isReasoningControllerModel(model);
  // Keep the compact non-ROI GPT route deterministic.  Some upstream Azure
  // nodes reject reasoning_effort=none, while an omitted value can spend the
  // whole request budget on hidden reasoning.  Callers for recursive passes
  // therefore use the supported low setting; only a truncated response gets
  // one omitted-parameter fallback.
  const reasoningAttempts = adaptiveSingleGpt
    ? [reasoningEffort || "low", null]
    : [reasoningEffort];
  const controllerAttempts = [];
  let response = null;
  let effectiveReasoningEffort = reasoningEffort;
  let lastAdaptiveError = null;
  const unsupportedReasoningEffort = (error) => {
    const value = String(error?.message || error || "");
    return /reasoning[_ -]?effort/i.test(value) &&
      /unsupported|not support|invalid|allowed|permitted/i.test(value);
  };
  const truncatedResponse = (value) =>
    value?.choices?.[0]?.finish_reason === "length";
  const writeAttemptRequest = async (
    requestValue,
    requestMessages,
    index,
    effort,
  ) => {
    if (!modelInputs.requestLog || index === 0) return;
    await fsp.writeFile(
      `${responseLogPrefix}_attempt_${index + 1}_request.json`,
      JSON.stringify(
        {
          endpoint: "chat.completions.create",
          request: {
            ...requestValue,
            messages: loggedMessagesFor(requestMessages),
          },
          reasoning_effort: effort || "omitted",
          note: "Automatic compact GPT fallback attempt; API key is omitted.",
        },
        null,
        2,
      ),
    );
  };
  const runRequest = async (effort, index) => {
    const requestValue = makeRequest(messages, effort);
    await writeAttemptRequest(requestValue, messages, index, effort);
    try {
      return await retry(
        () => client.chat.completions.create(
          requestValue,
          signal ? { signal } : undefined,
        ),
        index === 0 ? "bbox analysis" : `bbox analysis fallback ${index + 1}`,
        // The compact recursive GPT path gets one request and then a single
        // deliberately smaller gateway fallback below. Repeating the same
        // high-detail request three times only multiplies a 504 wait.
        adaptiveSingleGpt ? 1 : 3,
      );
    } catch (error) {
      const errorText = String(error?.message || error || "");
      const gatewayTimeout =
        /504|gateway time-?out|upstream.*timeout|request timed out|\btimeout\b/i.test(
          errorText,
        );
      if (adaptiveSingleGpt && index === 0 && gatewayTimeout) {
        const fallbackMessages = messages.map((message) => ({
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((item) =>
                item.type === "image_url"
                  ? {
                      ...item,
                      image_url: { ...item.image_url, detail: "low" },
                    }
                  : item,
              )
            : message.content,
        }));
        const fallbackRequest = {
          ...makeRequest(fallbackMessages, effort || "low"),
          max_completion_tokens: Math.min(maxCompletionTokens, 3072),
        };
        if (modelInputs.requestLog)
          await fsp.writeFile(
            `${responseLogPrefix}_gateway_fallback_request.json`,
            JSON.stringify(
              {
                endpoint: "chat.completions.create",
                request: {
                  ...fallbackRequest,
                  messages: loggedMessagesFor(fallbackMessages),
                },
                note: "Gateway-timeout fallback: low-detail image and 3072 completion tokens.",
              },
              null,
              2,
            ),
          );
        return retry(
          () =>
            client.chat.completions.create(
              fallbackRequest,
              signal ? { signal } : undefined,
            ),
          "bbox analysis gateway fallback",
          1,
        );
      }
      // A deployment may enforce a smaller context window than advertised.
      // Low detail keeps the coordinate canvas unchanged.
      if (!/context window|input exceeds|too many tokens|maximum context/i.test(String(error?.message || error)))
        throw error;
      const lowMessages = messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((item) =>
              item.type === "image_url"
                ? { ...item, image_url: { ...item.image_url, detail: "low" } }
                : item,
            )
          : message.content,
      }));
      const lowRequest = makeRequest(lowMessages, effort);
      if (modelInputs.requestLog)
        await fsp.writeFile(
          `${responseLogPrefix}_attempt_${index + 1}_context_fallback_request.json`,
          JSON.stringify(
            {
              request: {
                ...lowRequest,
                messages: loggedMessagesFor(lowMessages),
              },
              note: "Context-window fallback: all image inputs use detail=low.",
            },
            null,
            2,
          ),
        );
      return retry(
        () => client.chat.completions.create(
          lowRequest,
          signal ? { signal } : undefined,
        ),
        "bbox analysis low-detail fallback",
      );
    }
  };
  for (let index = 0; index < reasoningAttempts.length; index++) {
    const effort = reasoningAttempts[index];
    try {
      response = await runRequest(effort, index);
      effectiveReasoningEffort = effort;
      controllerAttempts.push({
        attempt: index + 1,
        reasoning_effort: effort || "omitted",
        finish_reason: response?.choices?.[0]?.finish_reason || null,
        content_length: String(response?.choices?.[0]?.message?.content || "").length,
        reasoning_tokens:
          response?.usage?.completion_tokens_details?.reasoning_tokens || 0,
      });
      if (!adaptiveSingleGpt || !truncatedResponse(response)) break;
      if (responseLogPrefix) {
        try {
          await parseControllerJsonResponse(
            response,
            `${responseLogPrefix}_attempt_${index + 1}`,
          );
        } catch {
          // Retain the raw truncated attempt, then continue automatically.
        }
      }
    } catch (error) {
      lastAdaptiveError = error;
      controllerAttempts.push({
        attempt: index + 1,
        reasoning_effort: effort || "omitted",
        error: String(error?.message || error),
      });
      if (!(adaptiveSingleGpt && unsupportedReasoningEffort(error)))
        throw error;
      if (responseLogPrefix)
        await fsp.writeFile(
          `${responseLogPrefix}_attempt_${index + 1}_error.json`,
          JSON.stringify(controllerAttempts.at(-1), null, 2),
        );
    }
  }
  if (!response)
    throw lastAdaptiveError || new Error("bbox model returned no response");
  const parsedResponse = await parseControllerJsonResponse(
    response,
    responseLogPrefix,
  );
  const coordinateRepair = repairGeminiNormalizedCoordinates(
    parsedResponse.value,
    model,
    inputSize.width,
    inputSize.height,
  );
  const detection = normalizeDetection(
    coordinateRepair.value,
    size.width,
    size.height,
  );
  detection.loop = loop;
  detection.source = path.resolve(source);
  detection.bbox_mode = direct ? "gpt_direct" : "img2_assisted";
  detection.bbox_strategy = direct
    ? "full_image_single_request"
    : "candidate_full_image_single_request";
  detection.bbox_controller_model = model;
  detection.bbox_reasoning_effort = isReasoningControllerModel(model)
    ? effectiveReasoningEffort || "default"
    : null;
  if (coordinateRepair.mode) {
    detection.coordinate_repair = coordinateRepair.mode;
    detection.model_coordinate_scale = {
      x: inputSize.width / 1000,
      y: inputSize.height / 1000,
    };
  }
  detection.model_response = {
    finish_reason: response?.choices?.[0]?.finish_reason || null,
    json_repaired: parsedResponse.repaired,
    attempts: controllerAttempts,
  };
  detection.candidate = candidate ? path.resolve(candidate) : null;
  detection.model_input = {
    source: path.resolve(attachedInput),
    candidate: candidateInput ? path.resolve(candidateInput) : null,
    reference: referenceInput ? path.resolve(referenceInput) : null,
    canvas: { width: inputSize.width, height: inputSize.height },
    original_canvas: { width: size.width, height: size.height },
  };
  return detection;
}
function bboxArea(box) {
  return Math.max(0, box.bbox[2]) * Math.max(0, box.bbox[3]);
}
function bboxOverlap(a, b) {
  const left = Math.max(a.bbox[0], b.bbox[0]);
  const top = Math.max(a.bbox[1], b.bbox[1]);
  const right = Math.min(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]);
  const bottom = Math.min(a.bbox[1] + a.bbox[3], b.bbox[1] + b.bbox[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = bboxArea(a);
  const areaB = bboxArea(b);
  const union = areaA + areaB - intersection;
  return {
    iou: union > 0 ? intersection / union : 0,
    containment: Math.min(areaA, areaB) > 0
      ? intersection / Math.min(areaA, areaB)
      : 0,
    areaRatio: Math.max(areaA, areaB) > 0
      ? Math.min(areaA, areaB) / Math.max(areaA, areaB)
      : 0,
  };
}

// Compact recursive controller responses often provide a meaningful
// front-to-back list (`f`) but omit the verbose `occludes` /
// `occluded_by` arrays.  When two boxes materially overlap, that order is
// enough to recover the missing depth edge: the earlier box is in front and
// the later box must wait for a subsequent loop.  This is deliberately
// conservative so neighbouring, non-overlapping UI elements remain in the
// same atlas batch.
function inferOcclusionFromFrontOrder(detection) {
  if (!detection || !Array.isArray(detection.boxes)) return detection;
  const boxes = detection.boxes.map((box) => ({
    ...box,
    occludes: Array.isArray(box.occludes) ? [...box.occludes] : [],
    occluded_by: Array.isArray(box.occluded_by) ? [...box.occluded_by] : [],
  }));
  const byId = new Map(boxes.map((box) => [String(box.id), box]));
  const listed = Array.isArray(detection.occlusion_tree?.front_to_back)
    ? detection.occlusion_tree.front_to_back.map(String).filter((id) => byId.has(id))
    : [];
  const order = listed.length
    ? [...listed, ...boxes.map((box) => String(box.id)).filter((id) => !listed.includes(id))]
    : boxes
        .slice()
        .sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0))
        .map((box) => String(box.id));
  for (let i = 0; i < order.length; i++) {
    const front = byId.get(order[i]);
    if (!front || front.visible === false) continue;
    for (let j = i + 1; j < order.length; j++) {
      const back = byId.get(order[j]);
      if (!back || back.visible === false) continue;
      const overlap = bboxOverlap(front, back);
      // A narrow but real overlap can still be an occlusion (for example, a
      // shield over the end of a bar). Ignore only thin padding collisions.
      if (overlap.iou < 0.1 && overlap.containment < 0.05) continue;
      const overlapWidth = Math.min(front.bbox[0] + front.bbox[2], back.bbox[0] + back.bbox[2]) - Math.max(front.bbox[0], back.bbox[0]);
      const overlapHeight = Math.min(front.bbox[1] + front.bbox[3], back.bbox[1] + back.bbox[3]) - Math.max(front.bbox[1], back.bbox[1]);
      if (overlapWidth < 0.06 * Math.min(front.bbox[2], back.bbox[2]) ||
          overlapHeight < 0.06 * Math.min(front.bbox[3], back.bbox[3])) continue;
      if (front.occluded_by.includes(back.id) || back.occludes.includes(front.id)) continue;
      if (!front.occludes.includes(back.id)) front.occludes.push(back.id);
      if (!back.occluded_by.includes(front.id)) back.occluded_by.push(front.id);
    }
  }
  const tree = detection.occlusion_tree || {};
  return {
    ...detection,
    boxes,
    occlusion_tree: {
      ...tree,
      front_to_back: order,
      roots: boxes
        .filter((box) => box.visible !== false && box.occluded_by.length === 0)
        .map((box) => box.id),
    },
  };
}

// Recursive extraction stops once the working image has become one coherent
// full-canvas scene.  The controller can still outline visually bounded
// scenery (rocks, flowers, a pedestal, and so on) as `decoration`; those are
// environmental pixels, not remaining editable HUD layers.  Keep this
// deterministic guard behind the controller's `scene` classification and
// require every returned candidate to look environmental so an isolated glow,
// ring, or other true foreground decoration is not discarded accidentally.
const SCENE_ENVIRONMENT_PATTERN = /(?:\b(?:backgrounds?|scenes?|environments?|terrains?|landscapes?|caves?|caverns?|altars?|pedestals?|platforms?|dais|rocks?|stones?|grass|plants?|flowers?|mushrooms?|water|sky|mountains?|trees?|bush(?:es)?|grounds?|floors?|walls?|ruins?|lighting|scenery)\b|背景|场景|环境|地形|洞穴|祭坛|基座|平台|岩石|石头|草地|植物|花|蘑菇|水面|天空|山|树|灌木|地面|墙|废墟)/i;

function isSceneOnlyTerminalDetection(detection) {
  if (
    String(detection?.background_repair?.mode || "").toLowerCase() !== "scene"
  )
    return false;
  const boxes = Array.isArray(detection?.boxes)
    ? detection.boxes.filter(
        (box) =>
          box?.visible !== false &&
          !["text", "background"].includes(
            String(box?.category || "").toLowerCase(),
          ),
      )
    : [];
  if (!boxes.length) return true;
  const summary = [
    detection?.scene_summary,
    detection?.background_repair?.reason,
  ].join(" ");
  if (!SCENE_ENVIRONMENT_PATTERN.test(summary)) return false;
  return boxes.every((box) => {
    const category = String(box.category || "").toLowerCase();
    if (!["decoration", "other"].includes(category)) return false;
    return SCENE_ENVIRONMENT_PATTERN.test(
      [box.id, box.label, box.reason].filter(Boolean).join(" "),
    );
  });
}

function areDuplicateBboxes(a, b) {
  const overlap = bboxOverlap(a, b);
  if (a.category === b.category)
    return (
      overlap.iou >= 0.58 ||
      (overlap.containment >= 0.9 && overlap.areaRatio >= 0.68)
    );
  const surface = new Set(["panel", "card", "button", "other"]);
  return (
    surface.has(a.category) &&
    surface.has(b.category) &&
    overlap.iou >= 0.82 &&
    overlap.areaRatio >= 0.68
  );
}
function resolveAlias(aliases, id) {
  let current = id;
  const seen = new Set();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current);
  }
  return current;
}
function dedupeBatchedBoxes(boxes) {
  const ordered = [...boxes].sort((a, b) => {
    const overview = Number(b.batch_id === "overview") - Number(a.batch_id === "overview");
    return overview || bboxArea(b) - bboxArea(a);
  });
  const kept = [];
  const aliases = new Map();
  for (const box of ordered) {
    const duplicate = kept.find((candidate) => areDuplicateBboxes(candidate, box));
    if (!duplicate) {
      kept.push({ ...box });
      continue;
    }
    aliases.set(box.id, duplicate.id);
    if (bboxArea(box) > bboxArea(duplicate)) duplicate.bbox = [...box.bbox];
    duplicate.confidence = Math.max(duplicate.confidence, box.confidence);
    if (box.label.length > duplicate.label.length) duplicate.label = box.label;
    if (!duplicate.parent_id && box.parent_id) duplicate.parent_id = box.parent_id;
    duplicate.occludes = [...new Set([...duplicate.occludes, ...box.occludes])];
    duplicate.occluded_by = [
      ...new Set([...duplicate.occluded_by, ...box.occluded_by]),
    ];
    duplicate.source_batches = [
      ...new Set([...(duplicate.source_batches || [duplicate.batch_id]), box.batch_id]),
    ];
  }
  const ids = new Set(kept.map((box) => box.id));
  for (const box of kept) {
    const remap = (id) => resolveAlias(aliases, id);
    box.parent_id = box.parent_id ? remap(box.parent_id) : null;
    if (!ids.has(box.parent_id) || box.parent_id === box.id) box.parent_id = null;
    box.occludes = [...new Set(box.occludes.map(remap))].filter(
      (id) => ids.has(id) && id !== box.id,
    );
    box.occluded_by = [...new Set(box.occluded_by.map(remap))].filter(
      (id) => ids.has(id) && id !== box.id,
    );
  }
  return { boxes: kept, removed: boxes.length - kept.length };
}
function inferBatchParents(boxes) {
  const parentCategories = new Set(["panel", "card", "button", "badge"]);
  const byId = Object.fromEntries(boxes.map((box) => [box.id, box]));
  for (const child of boxes) {
    if (child.parent_id && byId[child.parent_id]) continue;
    const childArea = bboxArea(child);
    const candidates = boxes
      .filter((parent) => {
        if (parent.id === child.id || !parentCategories.has(parent.category))
          return false;
        if (bboxArea(parent) < childArea * 1.22) return false;
        const overlap = bboxOverlap(parent, child);
        return overlap.containment >= 0.9;
      })
      .sort((a, b) => bboxArea(a) - bboxArea(b));
    child.parent_id = candidates[0]?.id || null;
  }
  const depthOf = (box, seen = new Set()) => {
    if (!box?.parent_id || seen.has(box.id)) return 0;
    const parent = byId[box.parent_id];
    if (!parent) return 0;
    const next = new Set(seen);
    next.add(box.id);
    return depthOf(parent, next) + 1;
  };
  for (const box of boxes) box.z_index = depthOf(box);
  return boxes;
}
function pruneIntegratedButtonIcons(boxes) {
  // Button and navigation-row backgrounds, their icons, and their text are
  // deliberately separate editable objects. Keep nested icon boxes; the
  // parent_id relationship records that the icon visually belongs to the
  // button without flattening both assets into one PSD layer.
  return { boxes, removed: 0 };
}
function reviewBoxOverlap(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = Math.max(1, a[2] * a[3]);
  const areaB = Math.max(1, b[2] * b[3]);
  return intersection / Math.max(1, areaA + areaB - intersection);
}
function reviewBoxCenterDistance(a, b) {
  const ax = a[0] + a[2] / 2;
  const ay = a[1] + a[3] / 2;
  const bx = b[0] + b[2] / 2;
  const by = b[1] + b[3] / 2;
  return Math.hypot(ax - bx, ay - by);
}
function stabilizeTopLayerReview(proposals, reviewed, width, height) {
  // A review pass must not silently become a second detector. Match each
  // reviewed item back to one proposal, preserve proposal ids, and never let
  // the review shrink away the safety margin that the matting pass relies on.
  const used = new Set();
  const match = (proposal, index) => {
    const exact = reviewed.findIndex(
      (item, itemIndex) => !used.has(itemIndex) && item.id === proposal.id,
    );
    if (exact >= 0) return exact;
    let best = -1;
    let bestScore = -Infinity;
    reviewed.forEach((item, itemIndex) => {
      if (used.has(itemIndex) || !item?.bbox) return;
      const sameCategory = item.category === proposal.category ? 0.35 : 0;
      const overlap = reviewBoxOverlap(proposal.bbox, item.bbox);
      const distance = reviewBoxCenterDistance(proposal.bbox, item.bbox);
      const limit = Math.max(18, Math.max(proposal.bbox[2], proposal.bbox[3]) * 1.5);
      if (distance > limit && overlap < 0.12) return;
      const score = overlap + sameCategory - distance / Math.max(1, limit);
      if (score > bestScore) {
        bestScore = score;
        best = itemIndex;
      }
    });
    return best;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  return proposals.map((proposal, index) => {
    const reviewedIndex = match(proposal, index);
    if (reviewedIndex < 0) {
      return { ...proposal, review_status: "proposal_preserved" };
    }
    used.add(reviewedIndex);
    const reviewedBox = reviewed[reviewedIndex];
    const [px, py, pw, ph] = proposal.bbox;
    const [rx, ry, rw, rh] = reviewedBox.bbox;
    // Use the union of the two boxes. This keeps a review from clipping a
    // glow, shadow, pointed edge, or a small counter that the first pass saw.
    // It also makes the correction monotonic: review can add missing pixels,
    // but cannot turn a safe proposal into an overly tight crop.
    const left = Math.max(0, Math.min(px, rx));
    const top = Math.max(0, Math.min(py, ry));
    const right = Math.min(width, Math.max(px + pw, rx + rw));
    const bottom = Math.min(height, Math.max(py + ph, ry + rh));
    const bbox = [
      left,
      top,
      Math.max(1, right - left),
      Math.max(1, bottom - top),
    ];
    return {
      ...proposal,
      bbox,
      // Keep the first pass's semantic identity. The reviewed record is
      // retained for audit/debugging without affecting PSD layer naming.
      review_status: "reviewed_union",
      review_id: reviewedBox.id,
      review_bbox: reviewedBox.bbox,
      review_category: reviewedBox.category,
      review_confidence: reviewedBox.confidence,
    };
  });
}
async function drawBboxRoiPreview(sourceInput, output, roi, label) {
  const meta = await sharp(sourceInput).metadata();
  const [x, y, width, height] = roi;
  const safeLabel = String(label || "ROI").replace(/[<>&]/g, "");
  const svg = `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#19c463" stroke-width="4"/><rect x="${x}" y="${Math.max(0, y - 24)}" width="${Math.max(92, safeLabel.length * 8 + 16)}" height="24" fill="#087a3a"/><text x="${x + 8}" y="${Math.max(17, y - 7)}" fill="white" font-size="14" font-family="Arial">${safeLabel}</text></svg>`;
  await sharp(sourceInput)
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(output);
  return output;
}
async function buildBboxBatchSpecs(sourceInput, batchDir) {
  await fsp.mkdir(batchDir, { recursive: true });
  const meta = await sharp(sourceInput).metadata();
  const width = meta.width;
  const height = meta.height;
  const specs = [
    {
      id: "overview",
      label: "global structure",
      file: sourceInput,
      preview_file: sourceInput,
      offset: [0, 0],
      core: [0, 0, width, height],
      overview: true,
    },
  ];
  const columns = 3;
  const rows = 3;
  const ownershipOverlap = Math.max(
    8,
    Math.round(Math.min(width / columns, height / rows) * 0.06),
  );
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const baseLeft = Math.floor((column * width) / columns);
      const baseTop = Math.floor((row * height) / rows);
      const baseRight = Math.floor(((column + 1) * width) / columns);
      const baseBottom = Math.floor(((row + 1) * height) / rows);
      const coreLeft = Math.max(0, baseLeft - ownershipOverlap);
      const coreTop = Math.max(0, baseTop - ownershipOverlap);
      const coreRight = Math.min(width, baseRight + ownershipOverlap);
      const coreBottom = Math.min(height, baseBottom + ownershipOverlap);
      const id = `tile_r${row + 1}_c${column + 1}`;
      const previewFile = path.join(batchDir, `${id}_roi.jpg`);
      const core = [
        coreLeft,
        coreTop,
        coreRight - coreLeft,
        coreBottom - coreTop,
      ];
      await drawBboxRoiPreview(sourceInput, previewFile, core, id);
      specs.push({
        id,
        label: `detail ${row + 1},${column + 1}`,
        file: sourceInput,
        preview_file: previewFile,
        offset: [0, 0],
        core,
        overview: false,
      });
    }
  }
  return { specs, width, height, ownershipOverlap };
}
async function splitSaturatedBatchSpec(
  sourceInput,
  batchDir,
  spec,
  canvasWidth,
  canvasHeight,
  ownershipOverlap,
) {
  const globalCore = [...spec.core];
  const splitHorizontally = globalCore[2] < globalCore[3];
  const firstSize = Math.floor(globalCore[splitHorizontally ? 3 : 2] / 2);
  const cores = splitHorizontally
    ? [
        [
          globalCore[0],
          globalCore[1],
          globalCore[2],
          Math.min(globalCore[3], firstSize + ownershipOverlap),
        ],
        [
          globalCore[0],
          Math.max(globalCore[1], globalCore[1] + firstSize - ownershipOverlap),
          globalCore[2],
          globalCore[3] - firstSize + ownershipOverlap,
        ],
      ]
    : [
        [
          globalCore[0],
          globalCore[1],
          Math.min(globalCore[2], firstSize + ownershipOverlap),
          globalCore[3],
        ],
        [
          Math.max(globalCore[0], globalCore[0] + firstSize - ownershipOverlap),
          globalCore[1],
          globalCore[2] - firstSize + ownershipOverlap,
          globalCore[3],
        ],
      ];
  const children = [];
  for (let index = 0; index < cores.length; index++) {
    const [coreLeft, coreTop, rawWidth, rawHeight] = cores[index];
    const coreWidth = Math.min(rawWidth, canvasWidth - coreLeft);
    const coreHeight = Math.min(rawHeight, canvasHeight - coreTop);
    const id = `${spec.id}_${index === 0 ? "a" : "b"}`;
    const previewFile = path.join(batchDir, `${id}_roi.jpg`);
    const core = [coreLeft, coreTop, coreWidth, coreHeight];
    await drawBboxRoiPreview(sourceInput, previewFile, core, id);
    children.push({
      id,
      label: `${spec.label} refinement ${index + 1}`,
      file: sourceInput,
      preview_file: previewFile,
      offset: [0, 0],
      core,
      overview: false,
      refinement_of: spec.id,
    });
  }
  return children;
}
async function requestBboxBatch(
  client,
  spec,
  model,
  signal,
  batchDir,
  candidateFile = null,
) {
  const meta = await sharp(spec.file).metadata();
  const schemaPrompt = (spec.audit === "text_overlay"
    ? BBOX_BATCH_TEXT_PROMPT
    : spec.overview
      ? BBOX_BATCH_OVERVIEW_PROMPT
      : BBOX_BATCH_DETAIL_PROMPT
  )
    .replaceAll("IMAGE_WIDTH", String(meta.width))
    .replaceAll("IMAGE_HEIGHT", String(meta.height));
  const ownership = spec.overview
    ? `The attached complete preview is exactly ${meta.width} x ${meta.height} pixels.`
    : `The attached complete preview is exactly ${meta.width} x ${meta.height} pixels. The ownership ROI is [${spec.core.join(",")}] as [x,y,width,height] in full-image pixels. Return complete full-image bboxes only for ${spec.audit === "text_overlay" ? "text glyphs and their small backplates" : "image elements"} whose bbox center lies in this ROI.`;
  const candidateInstruction = candidateFile
    ? " Two images are attached in this order: (1) the original screenshot, which is the only pixel ground truth; (2) a Seedream red-box proposal, which is only a fallible hint. Correct or ignore every proposal box by inspecting image 1. Never treat the red annotation strokes themselves as UI elements."
    : " Inspect the attached original screenshot directly; it is the only pixel ground truth.";
  const batchInputInstruction =
    " This is the batched backend adaptation of the article planner: the backend consumes pixel bboxes in the attached analysis canvas, while geometry_hints and repair modes retain the article's planning semantics. In the image-element pass do not output ordinary text; the dedicated text audit handles it.";
  const messageContent = [
    {
      type: "image_url",
      image_url: { url: dataUrl(spec.file), detail: "high" },
    },
  ];
  if (candidateFile)
    messageContent.push({
      type: "image_url",
      image_url: { url: dataUrl(candidateFile), detail: "low" },
    });
  messageContent.push({
    type: "text",
    text: `${schemaPrompt}\n${ownership}${candidateInstruction}${batchInputInstruction}`,
  });
  const messages = [
    { role: "system", content: BBOX_BATCH_SYSTEM_PROMPT },
    {
      role: "user",
      content: messageContent,
    },
  ];
  const makeRequest = (requestMessages = messages) => ({
    model,
    response_format: { type: "json_object" },
    ...(isReasoningControllerModel(model) ? { reasoning_effort: "high" } : {}),
    max_completion_tokens: BBOX_BATCH_MAX_COMPLETION_TOKENS,
    messages: requestMessages,
  });
  const request = makeRequest();
  const requestForLog = (requestMessages) => ({
    ...makeRequest(requestMessages),
    messages: requestMessages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((item) => {
            if (item.type !== "image_url") return item;
            const file = item.image_url.url === dataUrl(spec.file)
              ? spec.file
              : candidateFile;
            return {
              ...item,
              image_url: { file: path.resolve(file), detail: item.image_url.detail },
            };
          })
        : message.content,
    })),
  });
  await fsp.writeFile(
    path.join(batchDir, `${spec.id}_request.json`),
    JSON.stringify(
      {
        request: requestForLog(messages),
        batch: spec,
        note: "The API key and image data URL are omitted.",
      },
      null,
      2,
    ),
  );
  let response;
  try {
    response = await retry(
      () => client.chat.completions.create(request, signal ? { signal } : undefined),
      `bbox batch ${spec.id}`,
    );
  } catch (error) {
    // Some LiteLLM routes account for image tokens more aggressively than
    // OpenAI's standard tokenizer. On a context-window rejection, resend the
    // same ROI with low-detail image inputs; coordinates remain in the same
    // 768px canvas, while the request is substantially smaller.
    if (!/context window|input exceeds|too many tokens|maximum context/i.test(String(error?.message || error)))
      throw error;
    const lowMessages = messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((item) =>
            item.type === "image_url"
              ? { ...item, image_url: { ...item.image_url, detail: "low" } }
              : item,
          )
        : message.content,
    }));
    await fsp.writeFile(
      path.join(batchDir, `${spec.id}_context_fallback_request.json`),
      JSON.stringify(
        { request: requestForLog(lowMessages), note: "Context-window fallback: all image inputs use detail=low." },
        null,
        2,
      ),
    );
    response = await retry(
      () => client.chat.completions.create(makeRequest(lowMessages), signal ? { signal } : undefined),
      `bbox batch ${spec.id} low-detail fallback`,
    );
  }
  const parsedResponse = await parseControllerJsonResponse(
    response,
    path.join(batchDir, spec.id),
  );
  const parsed = parsedResponse.value;
  await fsp.writeFile(
    path.join(batchDir, `${spec.id}_response.json`),
    JSON.stringify(parsed, null, 2),
  );
  const local = normalizeDetection(parsed, meta.width, meta.height);
  const prefix = `${spec.id}_`;
  const ids = new Map(local.boxes.map((box) => [box.id, `${prefix}${box.id}`]));
  const inOwnershipCore = (box) => {
    if (spec.overview) return true;
    const centerX = box.bbox[0] + box.bbox[2] / 2;
    const centerY = box.bbox[1] + box.bbox[3] / 2;
    return (
      centerX >= spec.core[0] &&
      centerX < spec.core[0] + spec.core[2] &&
      centerY >= spec.core[1] &&
      centerY < spec.core[1] + spec.core[3]
    );
  };
  const remap = (id) => ids.get(id) || `${prefix}${safeId(id, id)}`;
  const boxes = local.boxes.filter(inOwnershipCore).map((box) => ({
    ...box,
    id: ids.get(box.id),
    bbox: [...box.bbox],
    parent_id: box.parent_id ? remap(box.parent_id) : null,
    occludes: box.occludes.map(remap),
    occluded_by: box.occluded_by.map(remap),
    batch_id: spec.id,
    source_batches: [spec.id],
  }));
  return {
    spec,
    boxes,
    raw_count: local.boxes.length,
    owned_count: boxes.length,
    json_repaired: parsedResponse.repaired,
    scene_summary: local.scene_summary,
    background_repair: local.background_repair,
  };
}
async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
async function analyzeBboxesBatched(
  source,
  model,
  loop = 1,
  signal,
  options = {},
) {
  const original = await sharp(source).metadata();
  const sourceInput = options.sourceInput || source;
  const candidateInput = options.candidateInput || null;
  const candidateSource = options.candidateSource || candidateInput;
  const bboxMode = options.bboxMode || (candidateInput ? "img2_assisted" : "gpt_direct");
  const batchDir = options.batchDir || path.join(path.dirname(sourceInput), "bbox_batches");
  const client = openaiClient("controller");
  const built = await buildBboxBatchSpecs(sourceInput, batchDir);
  const overviewSpec = built.specs[0];
  const visualSpecs = built.specs.slice(1);
  const textAuditSpecs = visualSpecs.map((spec) => ({
    ...spec,
    id: `text_${spec.id}`,
    label: `text/backplate audit ${spec.label.replace(/^detail\s*/i, "")}`,
    audit: "text_overlay",
  }));
  built.specs.push(...textAuditSpecs);
  const assets = [
    ...new Set(built.specs.map((spec) => spec.preview_file || spec.file)),
  ];
  let completed = 0;
  const report = (spec, status) =>
    options.onProgress?.({
      current: completed,
      total: built.specs.length,
      spec,
      status,
      assets,
    });
  report(overviewSpec, "running");
  const overview = await requestBboxBatch(
    client,
    overviewSpec,
    model,
    signal,
    batchDir,
    candidateInput,
  );
  completed++;
  report(overviewSpec, "completed");
  const baseDetailsAndTextAudits = await mapConcurrent(
    [...visualSpecs, ...textAuditSpecs],
    BBOX_BATCH_CONCURRENCY,
    async (spec) => {
      report(spec, "running");
      const result = await requestBboxBatch(
        client,
        spec,
        model,
        signal,
        batchDir,
        spec.audit === "text_overlay" ? null : candidateInput,
      );
      completed++;
      report(spec, "completed");
      return result;
    },
  );
  const details = baseDetailsAndTextAudits.filter(
    (batch) => batch.spec.audit !== "text_overlay",
  );
  const textAudits = baseDetailsAndTextAudits.filter(
    (batch) => batch.spec.audit === "text_overlay",
  );
  let saturated = details.filter((batch) => batch.raw_count >= 18);
  for (let refinementDepth = 0; refinementDepth < 2 && saturated.length; refinementDepth++) {
    const childSpecs = (
      await Promise.all(
        saturated.map((batch) =>
          splitSaturatedBatchSpec(
            sourceInput,
            batchDir,
            batch.spec,
            built.width,
            built.height,
            built.ownershipOverlap,
          ),
        ),
      )
    ).flat();
    built.specs.push(...childSpecs);
    assets.push(...childSpecs.map((spec) => spec.preview_file || spec.file));
    const refinements = await mapConcurrent(
      childSpecs,
      BBOX_BATCH_CONCURRENCY,
      async (spec) => {
      report(spec, "running");
      const result = await requestBboxBatch(
        client,
        spec,
        model,
        signal,
        batchDir,
        candidateInput,
      );
      completed++;
      report(spec, "completed");
      return result;
      },
    );
    details.push(...refinements);
    saturated = refinements.filter(
      (batch) =>
        batch.raw_count >= 18 &&
        batch.spec.core[2] >= 96 &&
        batch.spec.core[3] >= 96,
    );
  }
  const batches = [overview, ...details, ...textAudits];
  // General visual passes intentionally do not own text. The dedicated audit
  // replaces any accidental broad text detections with tight glyph boxes and
  // adds the small badge/pill surface underneath counters as a separate box.
  const visualBoxes = [overview, ...details].flatMap((batch) =>
    batch.boxes.filter((box) => box.category !== "text"),
  );
  const textOverlayBoxes = textAudits.flatMap((batch) =>
    batch.boxes.filter((box) => ["text", "badge"].includes(box.category)),
  );
  const rawBoxes = [...visualBoxes, ...textOverlayBoxes];
  const deduped = dedupeBatchedBoxes(rawBoxes);
  inferBatchParents(deduped.boxes);
  const integratedIconPrune = pruneIntegratedButtonIcons(deduped.boxes);
  deduped.boxes = integratedIconPrune.boxes;
  const previewPlan = {
    canvas: { width: built.width, height: built.height },
    scene_summary: overview.scene_summary,
    background_repair: overview.background_repair,
    boxes: deduped.boxes,
    occlusion_tree: {
      front_to_back: [...deduped.boxes]
        .sort((a, b) => b.z_index - a.z_index || bboxArea(a) - bboxArea(b))
        .map((box) => box.id),
      roots: deduped.boxes.filter((box) => !box.parent_id).map((box) => box.id),
    },
  };
  const detection = normalizeDetection(previewPlan, original.width, original.height);
  detection.loop = loop;
  detection.source = path.resolve(source);
  detection.bbox_mode = bboxMode;
  detection.bbox_strategy = `${bboxMode === "img2_assisted" ? "candidate_" : ""}full_image_overview_roi_3x3_plus_text_backplate_audit`;
  detection.bbox_controller_model = model;
  detection.bbox_reasoning_effort = isReasoningControllerModel(model) ? "high" : null;
  detection.model_response = {
    json_repaired: batches.some((batch) => batch.json_repaired),
    repaired_batches: batches
      .filter((batch) => batch.json_repaired)
      .map((batch) => batch.spec.id),
  };
  detection.candidate = candidateSource ? path.resolve(candidateSource) : null;
  detection.model_input = {
    source: path.resolve(sourceInput),
    candidate: candidateInput ? path.resolve(candidateInput) : null,
    candidate_source: candidateSource ? path.resolve(candidateSource) : null,
    canvas: { width: built.width, height: built.height },
    original_canvas: { width: original.width, height: original.height },
    batches: built.specs.map((spec) => ({
      id: spec.id,
      file: path.resolve(spec.file),
      preview_file: path.resolve(spec.preview_file || spec.file),
      offset: spec.offset,
      core: spec.core,
      audit: spec.audit || "image_element",
    })),
  };
  detection.batch_summary = {
    total_batches: batches.length,
    raw_boxes: rawBoxes.length,
    deduplicated_boxes: detection.boxes.length,
    duplicates_removed: deduped.removed,
    integrated_button_icons_removed: integratedIconPrune.removed,
    json_repaired_batches: batches.filter((batch) => batch.json_repaired).length,
    batches: batches.map((batch) => ({
      id: batch.spec.id,
      raw_count: batch.raw_count,
      owned_count: batch.owned_count,
      roi: batch.spec.core,
      audit: batch.spec.audit || "image_element",
    })),
  };
  if (options.requestLog)
    await fsp.writeFile(
      options.requestLog,
      JSON.stringify(
        {
          strategy: detection.bbox_strategy,
          model,
          reasoning_effort: detection.bbox_reasoning_effort,
          max_completion_tokens: BBOX_BATCH_MAX_COMPLETION_TOKENS,
          source: path.resolve(sourceInput),
          batch_directory: path.resolve(batchDir),
          batch_summary: detection.batch_summary,
        },
        null,
        2,
      ),
    );
  return detection;
}
function svgOverlay(width, height, boxes, options = {}) {
  const includeText = options.includeText !== false;
  const showLabels = options.showLabels !== false;
  const colorByDepth = options.colorByDepth === true;
  const colors = { text: "#f5aa14", background: "#2878e8" };
  const depthColors = [
    "#ff3b30",
    "#ff8a00",
    "#ffd60a",
    "#34c759",
    "#00c7be",
    "#0a84ff",
    "#5856d6",
    "#af52de",
  ];
  const body = boxes
    .filter((b) => includeText || b.category !== "text")
    .map((b, i) => {
      const [x, y, w, h] = b.bbox;
      const c = colorByDepth
        ? depthColors[Math.max(0, Number(b.z_index) || 0) % depthColors.length]
        : colors[b.category] || "#eb372d";
      const label = `${i + 1} ${b.category}:${b.label}`.replace(/[<&>]/g, "");
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="${Math.max(3, Math.round(width / 600))}"/>${showLabels ? `<text x="${x + 3}" y="${Math.max(16, y - 4)}" fill="white" font-size="14" font-family="Arial" stroke="${c}" stroke-width="4" paint-order="stroke">${label}</text>` : ""}`;
    })
    .join("");
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}
async function drawReview(source, detection, output, options = {}) {
  const meta = await sharp(source).metadata();
  return sharp(source)
    .composite([
      {
        input: Buffer.from(
          svgOverlay(meta.width, meta.height, detection.boxes, options),
        ),
      },
    ])
    .png()
    .toFile(output);
}
async function maskForBoxes(width, height, boxes, output) {
  const raw = Buffer.alloc(width * height * 4, 255);
  for (const [x, y, w, h] of boxes) {
    const left = Math.max(0, x),
      top = Math.max(0, y);
    const right = Math.min(width, x + w),
      bottom = Math.min(height, y + h);
    for (let py = top; py < bottom; py++) {
      for (let px = left; px < right; px++) raw[(py * width + px) * 4 + 3] = 0;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}
async function writeAlphaPreview(alpha, width, height, output) {
  const source = Buffer.isBuffer(alpha) ? alpha : Buffer.from(alpha || []);
  if (source.length !== width * height)
    throw new Error(`alpha preview size mismatch: ${source.length} != ${width * height}`);
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    // Preserve the model-provided alpha byte exactly; this is a visual
    // preview and is not thresholded or split into connected components.
    rgba[offset + 3] = source[pixel];
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}
async function maskForCutouts(width, height, layers, output, padding = 6) {
  const raw = Buffer.alloc(width * height * 4, 255);
  for (const layer of layers) {
    if (!layer?.source || !fs.existsSync(layer.source)) continue;
    const [left, top] = layer.bbox || [0, 0];
    const alphaResult = await sharp(layer.source)
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = alphaResult.data;
    const layerWidth = alphaResult.info.width;
    const layerHeight = alphaResult.info.height;
    for (let py = 0; py < layerHeight; py++) {
      for (let px = 0; px < layerWidth; px++) {
        if (alpha[py * layerWidth + px] <= 8) continue;
        const minY = Math.max(0, top + py - padding);
        const maxY = Math.min(height - 1, top + py + padding);
        const minX = Math.max(0, left + px - padding);
        const maxX = Math.min(width - 1, left + px + padding);
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) raw[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  }
  await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}
async function makeBlackWhiteEditMask(alphaMask, output) {
  const alphaResult = await sharp(alphaMask)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = alphaResult.info;
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    // The internal contour mask uses alpha=0 for editable pixels. Convert it
    // to an opaque binary image for the operator-facing hard mask:
    // white=edit, black=preserve.
    const value = alphaResult.data[pixel] < 128 ? 255 : 0;
    const offset = pixel * 3;
    rgb[offset] = value;
    rgb[offset + 1] = value;
    rgb[offset + 2] = value;
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(output);
  return output;
}
async function makeOpenAiInpaintMask(alphaMask, output) {
  const alphaResult = await sharp(alphaMask)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = alphaResult.info;
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const editable = alphaResult.data[pixel] < 128;
    const offset = pixel * 4;
    // Keep the RGB channels strictly black/white for easy inspection, while
    // using the alpha channel required by GPT Image editing: transparent
    // pixels are the editable region and opaque pixels are protected.
    const value = editable ? 255 : 0;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = editable ? 0 : 255;
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}
async function makeBlackHolePlate(source, mask, output) {
  const meta = await sharp(source).metadata();
  const maskAlpha = await sharp(mask)
    .ensureAlpha()
    .extractChannel(3)
    .negate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const black = Buffer.alloc(meta.width * meta.height * 4);
  for (let i = 0; i < black.length; i += 4) {
    black[i] = 0;
    black[i + 1] = 0;
    black[i + 2] = 0;
    black[i + 3] = maskAlpha.data[i / 4];
  }
  return sharp(source)
    .composite([
      {
        input: await sharp(black, {
          raw: { width: meta.width, height: meta.height, channels: 4 },
        })
          .png()
          .toBuffer(),
      },
    ])
    .png()
    .toFile(output);
}
async function applyGeneratedRegion(source, generated, mask, output, blur = 0) {
  const meta = await sharp(source).metadata();
  const overlay = await sharp(generated)
    .resize(meta.width, meta.height, { fit: "fill" })
    .removeAlpha()
    .png()
    .toBuffer();
  const alphaPipeline = sharp(mask)
    .ensureAlpha()
    .extractChannel(3)
    .negate();
  if (blur > 0) alphaPipeline.blur(blur);
  const alphaResult = await alphaPipeline
    .raw()
    .toBuffer({ resolveWithObject: true });
  const masked = await sharp(overlay)
    .joinChannel(alphaResult.data, {
      raw: {
        width: alphaResult.info.width,
        height: alphaResult.info.height,
        channels: 1,
      },
    })
    .png()
    .toBuffer();
  return sharp(source)
    .composite([{ input: masked }])
    .png()
    .toFile(output);
}

// The space between fixed cells belongs to the nearest row/column. Read that
// entire area when soft alpha connects several objects: connected-component
// detection cannot separate them, but the original inner recognition crop is
// too small to contain the model's complete rendering.
function atlasCellOwnershipRect(cell, layout, modelWidth, modelHeight) {
  const columns = Number(layout.columns) || 1;
  const rows = Number(layout.rows) || 1;
  const column = Number(cell.column) - 1 || 0;
  const row = Number(cell.row) - 1 || 0;
  const gap = Number(layout.cell_gap) || 0;
  const left = column > 0 ? cell.x - gap / 2 : 0;
  const top = row > 0 ? cell.y - gap / 2 : 0;
  const right = column < columns - 1 ? cell.x + cell.width + gap / 2 : layout.width;
  const bottom = row < rows - 1 ? cell.y + cell.height + gap / 2 : layout.height;
  const x0 = Math.max(0, Math.round(left * modelWidth / layout.width));
  const y0 = Math.max(0, Math.round(top * modelHeight / layout.height));
  const x1 = Math.min(modelWidth, Math.round(right * modelWidth / layout.width));
  const y1 = Math.min(modelHeight, Math.round(bottom * modelHeight / layout.height));
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

async function recoverFixedAtlasCellRegions(modelOutput, boxes, layout) {
  const raw = await sharp(modelOutput).toColourspace("srgb").ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  const regions = layout.cells.slice(0, boxes.length).map((cell, index) => {
    const ownership = atlasCellOwnershipRect(cell, layout, width, height);
    const inner = fixedAtlasCellCropRect(cell, layout, width, height);
    let left = inner.left, top = inner.top;
    let right = inner.left + inner.width, bottom = inner.top + inner.height;
    let recoveredPixels = 0;
    for (let y = ownership.top; y < ownership.top + ownership.height; y++) {
      for (let x = ownership.left; x < ownership.left + ownership.width; x++) {
        // This threshold only locates the crop, exactly as in the component
        // detector. The returned RGB and alpha values are never thresholded.
        if (raw.data[(y * width + x) * channels + channels - 1] <= 16) continue;
        left = Math.min(left, x - 2); top = Math.min(top, y - 2);
        right = Math.max(right, x + 3); bottom = Math.max(bottom, y + 3);
        if (x < inner.left || x >= inner.left + inner.width ||
            y < inner.top || y >= inner.top + inner.height) recoveredPixels++;
      }
    }
    left = Math.max(ownership.left, left); top = Math.max(ownership.top, top);
    right = Math.min(ownership.left + ownership.width, right);
    bottom = Math.min(ownership.top + ownership.height, bottom);
    return { target_index: index, rect: { left, top, width: right - left, height: bottom - top },
      ownership_rect: ownership, source_cell_rect: [cell.x, cell.y, cell.width, cell.height],
      source_crop_rect: [cell.x + Number(cell.crop_x || 0), cell.y + Number(cell.crop_y || 0),
        Number(cell.crop_width || cell.width), Number(cell.crop_height || cell.height)],
      recovered_alpha_pixels: recoveredPixels };
  });
  return { method: "fixed_cell_order_expanded_crop", matching_strategy: "fixed_cell_order",
    reason: "retain_model_alpha_outside_inner_crop_without_changing_scale_or_position",
    response_size: [width, height], regions };
}

async function renderExpandedAtlasCell(modelOutput, region, cell, layout, sourceBbox, canvas) {
  const meta = await sharp(modelOutput).metadata();
  const rect = region.rect;
  const sx = sourceBbox[2] / (Number(cell.crop_width || cell.width) * meta.width / layout.width);
  const sy = sourceBbox[3] / (Number(cell.crop_height || cell.height) * meta.height / layout.height);
  const originX = (cell.x + Number(cell.crop_x || 0)) * meta.width / layout.width;
  const originY = (cell.y + Number(cell.crop_y || 0)) * meta.height / layout.height;
  // Map the original crop and its overflow with the same transform. Stretching
  // a larger crop back into the old bbox would shrink/distort the icon.
  const left = Math.round(sourceBbox[0] + (rect.left - originX) * sx);
  const top = Math.round(sourceBbox[1] + (rect.top - originY) * sy);
  const right = Math.round(sourceBbox[0] + (rect.left + rect.width - originX) * sx);
  const bottom = Math.round(sourceBbox[1] + (rect.top + rect.height - originY) * sy);
  const resized = await sharp(modelOutput).extract(rect)
    .resize(Math.max(1, right - left), Math.max(1, bottom - top),
      { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
  const x = Math.max(0, left), y = Math.max(0, top);
  const w = Math.min(canvas.width, right) - x, h = Math.min(canvas.height, bottom) - y;
  if (w <= 0 || h <= 0) throw new Error("ATLAS_LAYER_OUTSIDE_SOURCE_CANVAS");
  const buffer = x === left && y === top && w === right - left && h === bottom - top
    ? resized
    : await sharp(resized).extract({ left: x - left, top: y - top, width: w, height: h }).png().toBuffer();
  return { buffer, bbox: [x, y, w, h] };
}
function backgroundResponseSize(width, height) {
  // Choose a proportional canvas before applying the endpoint's size limits.
  // Independent width/height clamps would distort a large source canvas.
  if (Math.max(width / height, height / width) > GPT_IMAGE_ATLAS_MAX_ASPECT) return "auto";
  const scale = Math.min(GPT_IMAGE_ATLAS_MAX_SIZE / Math.max(width, height),
    Math.max(1, Math.sqrt(GPT_IMAGE_ATLAS_MIN_PIXELS / (width * height))));
  const aspect = width / height;
  const desiredPixels = width * height * scale * scale;
  let best = null;
  for (let w = 16; w <= GPT_IMAGE_ATLAS_MAX_SIZE; w += 16) {
    for (const h of new Set([Math.floor(w / aspect / 16) * 16, Math.ceil(w / aspect / 16) * 16])) {
      const error = Math.abs((w / h) / aspect - 1);
      if (h < 16 || h > GPT_IMAGE_ATLAS_MAX_SIZE || w * h < GPT_IMAGE_ATLAS_MIN_PIXELS ||
          Math.max(w / h, h / w) > GPT_IMAGE_ATLAS_MAX_ASPECT || error > 0.005) continue;
      const score = error * 10 + Math.abs(Math.log(w * h / desiredPixels));
      if (!best || score < best.score) best = { w, h, score };
    }
  }
  return best ? `${best.w}x${best.h}` : "auto";
}
async function makeTransparentHolePlate(source, mask, output) {
  const sourceImage = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const maskAlpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = sourceImage.info;
  if (maskAlpha.info.width !== width || maskAlpha.info.height !== height)
    throw new Error("TRANSPARENT_HOLE_MASK_DIMENSIONS_MISMATCH");
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    if (maskAlpha.data[pixel] < 128) {
      sourceImage.data[offset] = 255;
      sourceImage.data[offset + 1] = 255;
      sourceImage.data[offset + 2] = 255;
      sourceImage.data[offset + 3] = 0;
    } else {
      sourceImage.data[offset + 3] = 255;
    }
  }
  return sharp(sourceImage.data, { raw: { width, height, channels: 4 } }).png().toFile(output);
}
async function normalizeBackgroundStructureGuide(modelRaw, deletionMask, whiteOnly, binary, segmentOutput, options = {}) {
  const mask = await sharp(deletionMask).ensureAlpha().extractChannel(3)
    .raw().toBuffer({ resolveWithObject: true });
  const { width, height } = mask.info;
  const generated = await sharp(modelRaw).toColourspace("srgb").ensureAlpha()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  const rgb = Buffer.alloc(width * height * 3);
  const segment = segmentOutput ? Buffer.alloc(width * height * 4) : null;
  let whitePixels = 0;
  let blackPixelsRemoved = 0;
  let deletionPixels = 0;
  let survivingBlackPixelsRestored = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    const opaque = generated[offset + 3] >= 128;
    const black = opaque && Math.max(generated[offset], generated[offset + 1], generated[offset + 2]) <= 64;
    const deleted = mask.data[pixel] < 128;
    if (deleted) {
      deletionPixels++;
      if (black) blackPixelsRemoved++;
      if (segment) segment[offset + 3] = 255;
    }
    // Alpha is checked before RGB so white stored under transparency stays black.
    // Opaque black shapes outside the actual holes are surviving elements.
    const white = !deleted && opaque &&
      (black || Math.min(generated[offset], generated[offset + 1], generated[offset + 2]) >= 192);
    if (!white) continue;
    if (black) survivingBlackPixelsRestored++;
    rgba.fill(255, offset, offset + 4);
    rgb.fill(255, pixel * 3, pixel * 3 + 3);
    if (segment) segment.fill(255, offset, offset + 4);
    whitePixels++;
  }
  if (!whitePixels && !options.allowEmpty) throw new Error("BACKGROUND_STRUCTURE_GUIDE_EMPTY");
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(whiteOnly);
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(binary);
  if (segment) await sharp(segment, { raw: { width, height, channels: 4 } }).png().toFile(segmentOutput);
  return { whitePixels, blackPixelsRemoved, deletionPixels, survivingBlackPixelsRestored,
    canvas: [width, height] };
}
async function validateBackgroundStructureCoverage(binary, repairInput, semanticGuide) {
  if (!semanticGuide?.grounding?.validated || !Array.isArray(semanticGuide.retained_components))
    throw new Error("BACKGROUND_STRUCTURE_COVERAGE_REQUIRES_VERIFIED_COMPONENTS");
  const residual = await sharp(repairInput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const guide = await sharp(binary).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = residual.info;
  if (guide.info.width !== width || guide.info.height !== height)
    throw new Error("BACKGROUND_STRUCTURE_COVERAGE_DIMENSIONS_MISMATCH");
  const radius = Math.max(1, Math.min(3, Math.round(Math.max(width, height) / 1024)));
  const minPointWhiteFraction = 0.5;
  const checks = semanticGuide.retained_components.map(component => {
      const points = component.evidence_points.map(([x, y]) => {
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height ||
            residual.data[(y * width + x) * 4 + 3] < 128)
          throw new Error(`BACKGROUND_STRUCTURE_COVERAGE_INVALID_EVIDENCE:${component.id}`);
        let visible = 0, white = 0;
        for (let py = Math.max(0, y - radius); py <= Math.min(height - 1, y + radius); py++)
          for (let px = Math.max(0, x - radius); px <= Math.min(width - 1, x + radius); px++) {
            const pixel = py * width + px;
            if (residual.data[pixel * 4 + 3] < 128) continue;
            visible++;
            if (guide.data[pixel] === 255) white++;
          }
        return { point: [x, y], white_fraction: white / Math.max(1, visible), covered: white >= visible * minPointWhiteFraction };
      });
      const covered = points.filter(point => point.covered).length;
      const required = Math.max(2, Math.ceil(points.length * 2 / 3));
      const backdrop = component.mask_role === "backdrop";
      let visibleArea = 0, whiteArea = 0;
      if (!backdrop) {
        const [x, y, w, h] = component.bbox;
        for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
          const pixel = py * width + px;
          if (residual.data[pixel * 4 + 3] < 128) continue;
          visibleArea++;
          if (guide.data[pixel] === 255) whiteArea++;
        }
      }
      const regionFraction = whiteArea / Math.max(1, visibleArea);
      // Generated boundary points may be slightly outside the actual surface.
      // Require at least one real white evidence sample plus substantial visible
      // coverage before accepting this alternative; an entirely omitted element
      // cannot pass merely because another shape intersects its bbox.
      const regionCovered = covered >= 1 && regionFraction >= 0.25;
      const fieldPoints = backdrop ? points.filter(({ point: [x, y] }) =>
        !semanticGuide.retained_components.some(other => other.mask_role !== "backdrop" &&
          x >= other.bbox[0] && y >= other.bbox[1] && x < other.bbox[0] + other.bbox[2] && y < other.bbox[1] + other.bbox[3])) : [];
      return { id: component.id, description: component.description, mask_role: component.mask_role || "element", bbox: component.bbox,
        evidence_points: component.evidence_points, covered_points: covered, required_points: required,
        visible_region_white_fraction: regionFraction,
        validation_method: backdrop ? "distant-field-points" : covered >= required ? "evidence-points" : "evidence-and-visible-region",
        validated: backdrop ? fieldPoints.filter(point => point.covered).length <= Math.floor(fieldPoints.length / 3)
          : covered >= required || regionCovered, points };
    });
  const components = checks.filter(component => component.mask_role !== "backdrop");
  const backdrops = checks.filter(component => component.mask_role === "backdrop");
  return { validated: checks.every(component => component.validated), canvas: [width, height],
    sample_radius: radius, point_white_fraction_threshold: minPointWhiteFraction,
    components, backdrops, missing_components: components.filter(component => !component.validated),
    unexpected_white_backdrops: backdrops.filter(component => !component.validated) };
}
async function recheckBackgroundStructureEvidence(repairInput, semanticGuide, targets, coverage, loopDir, attempt, signal) {
  const suspects = [...coverage.missing_components, ...coverage.unexpected_white_backdrops];
  const batches = [];
  for (let i = 0; i < suspects.length; i += 7) batches.push(suspects.slice(i, i + 7));
  const residual = await sharp(repairInput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = residual.info;
  const parts = await mapConcurrent(batches, 4, async (batch, index) => {
    const prefix = path.join(loopDir, `background_evidence_attempt_${attempt}_batch_${String(index + 1).padStart(2, "0")}`);
    const atlas = await makeBackgroundSemanticContextAtlas(repairInput, batch, `${prefix}.png`, { markEvidence: true });
    const assigned = batch.map(item => semanticGuide.retained_components.find(component => component.id === item.id));
    const prompt = `Recheck retained-component evidence coordinates against the RGB scene. Image 1 is the authoritative full residual scene; Image 2 enlarges the assigned component regions with MAGENTA CROSS markers at their currently claimed evidence locations. The crosses are software annotations, not scene elements. The segmentation coverage check failed at these points, but that alone does NOT mean the component is absent or should be deleted. Decide whether the markers actually lie on each named component's OWN visible material. A marker on surrounding backdrop, a neighboring component or a transparent hole is wrong even when it is opaque and has a similar color. Do not change colors to make a misplaced point pass. Do not copy generated mask contours: the segmentation image is deliberately not provided.\nFor EACH assigned id return decision="keep_evidence" if its current points are correctly located, regardless of segmentation coverage. If misplaced, return decision="relocate_evidence", corrected tight bbox [x,y,width,height], 3 to 6 evidence_points on well-inside visible material and their observed evidence_rgb [0..255]. Corrected coordinates MUST use normalized_1000 of the ENTIRE Image 1, never atlas/cell-local or source pixels. All component identities, descriptions, mask_role and layer order are fixed; do not drop, add, merge or reclassify components. If its extent crosses the crop boundary, use the full scene to measure it. Return concise JSON {"coordinate_space":"normalized_1000","retained_components":[{"id":"assigned id","decision":"keep_evidence"}]}. All input bbox/point/mapping metadata uses SOURCE pixels of [${width},${height}]; normalize any corrected response. Assigned components: ${JSON.stringify(assigned)}. Marker atlas mapping: ${JSON.stringify(atlas)}.`;
    const messages = [{ role: "system", content: "Audit the actual location of pixel evidence on the named material. Preserve every component. Return JSON only." },
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl(repairInput), detail: "high" } },
        { type: "image_url", image_url: { url: dataUrl(atlas.image), detail: "high" } }, { type: "text", text: prompt }] }];
    await fsp.writeFile(`${prefix}_request.json`, JSON.stringify({ model: BACKGROUND_SEMANTIC_MODEL,
      image_inputs: [repairInput, atlas.image], context_atlas: atlas, components: assigned, prompt }, null, 2));
    const errors = [];
    for (let correctionAttempt = 1; correctionAttempt <= 2; correctionAttempt++) {
      const response = await retry(() => openaiClient("semantic").chat.completions.create({
        model: BACKGROUND_SEMANTIC_MODEL, response_format: { type: "json_object" }, max_completion_tokens: 16384, messages,
      }, signal ? { signal } : undefined), `background evidence recheck ${attempt}/${index + 1}`, 2);
      const raw = String(response?.choices?.[0]?.message?.content || "");
      await fsp.writeFile(`${prefix}_correction_${correctionAttempt}_raw.txt`, raw, "utf8");
      try {
        if (response?.choices?.[0]?.finish_reason === "length") throw new Error("Evidence recheck JSON was truncated");
        const value = parseJson(raw);
        if (value.coordinate_space !== "normalized_1000") throw new Error("Declare normalized_1000 for corrected coordinates");
        const byId = new Map();
        for (const item of value.retained_components || []) {
          if (!assigned.some(component => component.id === item.id) || byId.has(item.id) ||
              !["keep_evidence", "relocate_evidence"].includes(item.decision))
            throw new Error(`Invalid evidence decision/id: ${item.id}`);
          byId.set(item.id, item);
        }
        if (assigned.some(component => !byId.has(component.id))) throw new Error("Missing assigned evidence decisions");
        const corrected = assigned.map(component => {
          const update = byId.get(component.id);
          if (update.decision === "keep_evidence") return component;
          return backgroundSemanticPixelCoordinates({ coordinate_space: "normalized_1000", retained_components: [{
            ...component, bbox: update.bbox, evidence_points: update.evidence_points, evidence_rgb: update.evidence_rgb,
          }] }, width, height).retained_components[0];
        });
        const checked = groundBackgroundSemanticGuide({ ...semanticGuide, retained_components: corrected, holes: [] }, [], targets, residual);
        const result = { index: index + 1, atlas: atlas.image, corrections: checked.retained_components, decisions: [...byId.values()],
          attempts: correctionAttempt, validation_errors: errors, usage: response.usage || null };
        await fsp.writeFile(`${prefix}_response.json`, JSON.stringify(result, null, 2));
        return result;
      } catch (error) {
        errors.push(String(error.message || error));
        if (correctionAttempt === 2) throw error;
        messages.push({ role: "assistant", content: raw }, { role: "user", content:
          `Coordinate/color validation failed: ${error.message}. Correct ALL assigned decisions. Each relocated component needs at least TWO distinct opaque points on its OWN material with matching observed RGB and whole-scene normalized_1000 coordinates.` });
      }
    }
  });
  const updates = new Map(parts.flatMap(part => part.corrections).map(component => [component.id, component]));
  const checked = groundBackgroundSemanticGuide({ ...semanticGuide,
    retained_components: semanticGuide.retained_components.map(component => updates.get(component.id) || component),
  }, targets, targets, residual);
  Object.assign(semanticGuide, checked, { grounding: { ...semanticGuide.grounding, ...checked.grounding,
    evidence_rechecked: true } });
  const semanticPath = path.join(loopDir, "background_semantic_response.json");
  if (fs.existsSync(semanticPath)) {
    const saved = JSON.parse(await fsp.readFile(semanticPath, "utf8"));
    const originalPath = path.join(loopDir, "background_semantic_initial_response.json");
    if (!fs.existsSync(originalPath)) await fsp.copyFile(semanticPath, originalPath);
    saved.guide = semanticGuide;
    saved.evidence_rechecks = [...(saved.evidence_rechecks || []), { segmentation_attempt: attempt, batches: parts }];
    await fsp.writeFile(semanticPath, JSON.stringify(saved, null, 2));
  }
  return { segmentation_attempt: attempt, batches: parts };
}
function backgroundEvidenceAssets(loopDir) {
  return fs.readdirSync(loopDir).sort().filter(name => /^background_evidence_attempt_\d+_batch_\d+\.png$/.test(name))
    .map(name => [path.join(loopDir, name), "Gemini 证据点位置复核（粉色十字）", "background-semantic-context"]);
}
async function generateBackgroundStructureGuide(source, repairInput, deletionMask, targets, loopDir, signal, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw new Error("BACKGROUND_STRUCTURE_INVALID_ATTEMPT_LIMIT");
  const blackHoleInput = path.join(loopDir, "background_guide_input.png");
  const modelRaw = path.join(loopDir, "background_guide_model_raw.png");
  const segment = path.join(loopDir, "background_guide_segment.png");
  const whiteOnly = path.join(loopDir, "background_guide_white.png");
  const binary = path.join(loopDir, "background_guide_binary.png");
  const requestPath = path.join(loopDir, "background_guide_request.json");
  const validationPath = path.join(loopDir, "background_guide_validation.json");
  await makeBlackHolePlate(source, deletionMask, blackHoleInput);
  let expected = options.semanticGuide?.retained_components.filter(component => component.mask_role !== "backdrop");
  const componentBatches = [];
  for (let index = 0; index < (expected?.length || 0); index += 7) componentBatches.push(expected.slice(index, index + 7));
  const contexts = await mapConcurrent(componentBatches, 4, (batch, index) =>
    makeBackgroundSemanticContextAtlas(blackHoleInput, batch,
      path.join(loopDir, `background_guide_context_${String(index + 1).padStart(2, "0")}.png`)));
  const imagePaths = [blackHoleInput, repairInput, ...contexts.map(context => context.image)];
  let reusedCandidate = null;
  if (options.reuseFirstAttemptFromDir) {
    const previousRequestPath = path.join(options.reuseFirstAttemptFromDir, "background_guide_attempt_1_request.json");
    const previous = JSON.parse(await fsp.readFile(previousRequestPath, "utf8"));
    if (previous.model !== BACKGROUND_REPAIR_MODEL || previous.quality !== BACKGROUND_REPAIR_QUALITY ||
        JSON.stringify(previous.bbox_targets) !== JSON.stringify(targets) ||
        !(await fsp.readFile(previous.image_inputs[0])).equals(await fsp.readFile(imagePaths[0])) ||
        !(await fsp.readFile(previous.image_inputs[1])).equals(await fsp.readFile(imagePaths[1])))
      throw new Error("BACKGROUND_STRUCTURE_CANDIDATE_INPUT_MISMATCH");
    reusedCandidate = { image: path.join(options.reuseFirstAttemptFromDir, "background_guide_attempt_1_model_raw.png"),
      request: previousRequestPath };
  }
  const componentPrompt = expected ? `\n\nVerified retained elements that MUST ALL be white: ${JSON.stringify(expected)}. Verified continuous distant fields to leave transparent: ${JSON.stringify(options.semanticGuide.retained_components.filter(component => component.mask_role === "backdrop"))}. Their evidence_points are real surviving pixels in Image 2; omission of elements or whitening the distant field will fail software validation. Images 3 onward are enlarged residual component atlases for recognition only. Return the FULL-CANVAS segmentation, never the atlas layout. Source-to-atlas mappings: ${JSON.stringify(contexts)}.` : "";
  const deferred = (options.referenceBoxes || []).map((box) => ({
    id: box.id, bbox: box.bbox, covered_by: box.occluded_by || [],
  }));
  let basePrompt = `${BACKGROUND_GUIDE_PROMPT}${componentPrompt}\n\nExtracted foreground to exclude: ${JSON.stringify(targets)}.${deferred.length ? `\nVisible deeper objects to retain as white wherever their pixels remain: ${JSON.stringify(deferred)}.` : ""}`;
  const { width, height } = await sharp(source).metadata();
  const outputSize = backgroundResponseSize(width, height);
  const attempts = [];
  let feedback = "";
  let automaticAttempt = 0;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error("JOB_STOPPED");
    automaticAttempt++;
    const attemptRaw = path.join(loopDir, `background_guide_attempt_${attempt}_model_raw.png`);
    const attemptWhite = path.join(loopDir, `background_guide_attempt_${attempt}_white.png`);
    const attemptBinary = path.join(loopDir, `background_guide_attempt_${attempt}_binary.png`);
    const attemptSegment = path.join(loopDir, `background_guide_attempt_${attempt}_segment.png`);
    const prompt = `${basePrompt}${feedback ? `\n\nPrevious segmentation failed validation: ${feedback}. Regenerate the entire aligned segmentation, preserving ALL previously included elements and adding every omitted visible element. Use actual RGB silhouettes, not filled bbox rectangles.${feedback === "BACKGROUND_STRUCTURE_GUIDE_EMPTY" ? " The previous guide contained no valid retained elements outside the deletion holes. Paint the visible surviving elements opaque WHITE with alpha=255, the deletion holes opaque BLACK, and only the distant backdrop transparent. Do not return an entirely transparent image." : ""}` : ""}`;
    const request = { model: BACKGROUND_REPAIR_MODEL, quality: BACKGROUND_REPAIR_QUALITY,
      method: expected ? "verified residual components + full scene + local atlases -> coverage-validated flat segmentation"
        : "black-hole plate + transparent-hole plate -> full-canvas flat segmentation; no controller analysis",
      controller_analysis: options.semanticGuide ? "supplied semantic guide" : "none",
      image_inputs: imagePaths, output_size: outputSize, mask_api_input: null, background: "transparent",
      model_raw: attemptRaw, deletion_bounded_segment: segment, white_only: whiteOnly, binary_guide: binary,
      candidate_white: attemptWhite, candidate_binary: attemptBinary, candidate_segment: attemptSegment,
      verified_components: expected || null, context_atlases: contexts, bbox_targets: targets, attempt,
      reused_model_response: attempt === 1 ? reusedCandidate : null, prompt };
    await fsp.writeFile(requestPath, JSON.stringify(request, null, 2));
    await fsp.writeFile(path.join(loopDir, `background_guide_attempt_${attempt}_request.json`), JSON.stringify(request, null, 2));
    const activeRequest = {
      request_id: `loop_${options.loopNumber || path.basename(loopDir)}_background_structure`,
      kind: "background_structure",
      label: "黑白透明分割图",
      retry_label: "重试此步骤",
      attempt,
      status: "running",
      input: blackHoleInput,
      request: requestPath,
      timeout_ms: getRoute('background').timeout_ms,
      started_at: new Date().toISOString(),
    };
    options.onProgress?.({ current: 0, total: targets.length, stage: "structure", attempt,
      guide_context_count: contexts.length, active_request: activeRequest });
    const record = { attempt, status: "running", model_raw: attemptRaw, binary: attemptBinary,
      started_at: activeRequest.started_at };
    attempts.push(record);
    try {
      if (attempt === 1 && reusedCandidate) {
        await fsp.copyFile(reusedCandidate.image, attemptRaw);
        record.reused_model_response = reusedCandidate;
      } else await imageEdit(repairInput, attemptRaw, prompt, BACKGROUND_REPAIR_MODEL, null, signal, {
        provider: "openai", clientKind: "background-repair", imagePaths,
        quality: BACKGROUND_REPAIR_QUALITY, background: "transparent", size: outputSize,
        resizeOutput: false, timeoutMs:getRoute('background').timeout_ms,
      });
      const generated = await sharp(attemptRaw).metadata();
      if (Math.abs((generated.width / generated.height) / (width / height) - 1) > 0.01)
        throw new Error("BACKGROUND_STRUCTURE_GUIDE_ASPECT_MISMATCH");
      const stats = await normalizeBackgroundStructureGuide(attemptRaw, deletionMask, attemptWhite, attemptBinary, attemptSegment,
        { allowEmpty: expected?.length === 0 });
      let coverage = options.semanticGuide
        ? await validateBackgroundStructureCoverage(attemptBinary, repairInput, options.semanticGuide) : null;
      if (coverage && !coverage.validated) {
        record.initial_coverage = coverage;
        options.onProgress?.({ current: 0, total: targets.length, stage: "evidence", attempt });
        try {
          record.evidence_recheck = await recheckBackgroundStructureEvidence(repairInput, options.semanticGuide,
            targets, coverage, loopDir, attempt, signal);
          options.onProgress?.({ current: 0, total: targets.length, stage: "evidence", attempt,
            evidence_atlases: record.evidence_recheck.batches.map(batch => batch.atlas) });
          expected = options.semanticGuide.retained_components.filter(component => component.mask_role !== "backdrop");
          basePrompt = `${BACKGROUND_GUIDE_PROMPT}\n\nVerified retained elements that MUST ALL be white (coordinates rechecked against RGB): ${JSON.stringify(expected)}. Continuous distant fields to leave transparent: ${JSON.stringify(options.semanticGuide.retained_components.filter(component => component.mask_role === "backdrop"))}. Images 3 onward are recognition atlases only; the full residual Image 2 and this updated source-pixel table take priority. Return a full-canvas segmentation, never atlas layout. Extracted foreground to exclude: ${JSON.stringify(targets)}.`;
          coverage = await validateBackgroundStructureCoverage(attemptBinary, repairInput, options.semanticGuide);
        } catch (error) {
          if (signal?.aborted || error.message === "JOB_STOPPED") throw error;
          record.evidence_recheck_error = String(error.message || error);
        }
      }
      record.coverage = coverage;
      if (coverage && !coverage.validated)
        throw new Error(`BACKGROUND_STRUCTURE_GUIDE_INCOMPLETE:${JSON.stringify({
          missing_white_elements: coverage.missing_components.map(({ id, description, bbox, evidence_points }) => ({ id, description, bbox, evidence_points })),
          fields_that_must_be_transparent: coverage.unexpected_white_backdrops.map(({ id, description, evidence_points }) => ({ id, description, evidence_points })),
        })}`);
      record.status = "validated";
      record.ended_at = new Date().toISOString();
      await fsp.copyFile(attemptRaw, modelRaw);
      await fsp.copyFile(attemptWhite, whiteOnly);
      await fsp.copyFile(attemptBinary, binary);
      await fsp.copyFile(attemptSegment, segment);
      await fsp.writeFile(validationPath, JSON.stringify({ validated: true,
        semantic_coverage_checked: Boolean(coverage), validation_scope: coverage
          ? "semantic coverage and image format" : "image geometry and nonempty guide", attempts }, null, 2));
      await fsp.writeFile(path.join(loopDir, "background_guide_manifest.json"), JSON.stringify({
        ...stats, model_raw: modelRaw, deletion_bounded_segment: segment, white_only: whiteOnly, binary_guide: binary,
        coverage, attempts, validation: validationPath, context_atlases: contexts,
        controller_analysis: options.semanticGuide ? "supplied semantic guide" : "none",
        conversion: "black is restricted to actual deletion holes; opaque black shapes outside holes become white surviving elements; retain model contours without smoothing or expansion; send binary as an ordinary image",
        transport: "ordinary third image; no API mask",
      }, null, 2));
      options.onProgress?.({ current: targets.length, total: targets.length, stage: "structure",
        attempt, active_request: null });
      return { modelRaw, segment, whiteOnly, binary, requestPath, validationPath, coverage, ...stats };
    } catch (error) {
      record.status = "failed";
      record.error = String(error.message || error);
      record.ended_at = new Date().toISOString();
      feedback = record.error.startsWith("BACKGROUND_STRUCTURE_GUIDE_") ? record.error : "";
      await fsp.writeFile(validationPath, JSON.stringify({ validated: false, attempts }, null, 2));
      if (signal?.aborted || error.message === "JOB_STOPPED") throw error;
      if (automaticAttempt < maxAttempts) continue;
      if (!options.waitForAtlasRetry) throw error;
      const failedRequest = { ...activeRequest, status: "failed", retryable: true,
        reason: conciseError(error), ended_at: record.ended_at };
      options.onProgress?.({ current: 0, total: targets.length, stage: "structure", attempt,
        status: "waiting_retry", active_request: failedRequest });
      await options.waitForAtlasRetry(failedRequest);
      if (signal?.aborted) throw new Error("JOB_STOPPED");
      automaticAttempt = 0;
      options.onProgress?.({ current: 0, total: targets.length, stage: "structure",
        status: "running", active_request: null });
    }
  }
}
async function applyGeneratedRegionSeamless(source, generated, mask, output) {
  const original = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = original.info;
  const repaired = await sharp(generated).resize(width, height, { fit: "fill" })
    .removeAlpha().raw().toBuffer();
  const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer();
  const count = width * height;
  const difference = new Float32Array(count * 3);
  const editable = [];
  for (let pixel = 0; pixel < count; pixel++) {
    const sourceOffset = pixel * 4;
    const repairOffset = pixel * 3;
    if (alpha[pixel] < 128) {
      editable.push(pixel);
    } else {
      for (let channel = 0; channel < 3; channel++)
        difference[repairOffset + channel] = original.data[sourceOffset + channel] - repaired[repairOffset + channel];
    }
  }
  // Continue the original-to-model color difference into the edit region.
  // This removes a visible silhouette seam while retaining the model's detail.
  for (let iteration = 0; iteration < 240 && editable.length; iteration++) {
    let maxChange = 0;
    for (const pixel of editable) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighborCount = (x > 0) + (x < width - 1) + (y > 0) + (y < height - 1);
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        if (x > 0) sum += difference[(pixel - 1) * 3 + channel];
        if (x < width - 1) sum += difference[(pixel + 1) * 3 + channel];
        if (y > 0) sum += difference[(pixel - width) * 3 + channel];
        if (y < height - 1) sum += difference[(pixel + width) * 3 + channel];
        const offset = pixel * 3 + channel;
        const change = 1.86 * (sum / neighborCount - difference[offset]);
        difference[offset] += change;
        maxChange = Math.max(maxChange, Math.abs(change));
      }
    }
    if (maxChange < 0.01) break;
  }
  const result = Buffer.from(original.data);
  for (const pixel of editable) {
    for (let channel = 0; channel < 3; channel++) {
      const value = repaired[pixel * 3 + channel] + difference[pixel * 3 + channel];
      result[pixel * 4 + channel] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  await sharp(result, { raw: { width, height, channels: 4 } }).png().toFile(output);
  return output;
}
async function removeText(
  source,
  textBoxes,
  loopDir,
  model,
  signal,
  options = {},
) {
  const output = path.join(loopDir, "text_clean.png");
  if (!textBoxes.length) {
    await fsp.copyFile(source, output);
    return output;
  }
  const meta = await sharp(source).metadata();
  const mask = await maskForBoxes(
    meta.width,
    meta.height,
    textBoxes.map((x) => x.bbox),
    path.join(loopDir, "text_mask.png"),
  );
  const apiMask = await makeOpenAiInpaintMask(
    mask,
    path.join(loopDir, "text_mask_openai.png"),
  );
  const repairInput = path.join(loopDir, "text_inpaint_input.png");
  await makeBlackHolePlate(source, mask, repairInput);
  const generated = path.join(loopDir, "text_clean_generated.png");
  const imageInputs = [repairInput];
  const svgGuideEnabled = options.svgGuide !== null && options.svgGuide !== undefined;
  if (svgGuideEnabled) {
    if (!options.svgGuide?.png || !fs.existsSync(options.svgGuide.png))
      throw new Error("TEXT_SVG_GUIDE_INPUT_MISSING");
    imageInputs.push(options.svgGuide.png);
  }
  const prompt = svgGuideEnabled
    ? `${TEXT_REMOVAL_PROMPT}\n\nImage 2 is the aligned residual structural SVG preview after all ordinary text nodes were removed. It is mandatory structural guidance for the text-free result. Use its layout, component boundaries and local surfaces to reconstruct what belongs under each black text hole. Preserve all non-text image artwork, including lettering fused with an emblem, logo, crest, badge or illustration. Never copy the residual SVG's simplified vector colors; Image 1 and the native edit mask remain pixel truth.`
    : `${TEXT_REMOVAL_PROMPT}\n\nOnly one image is attached. Reconstruct the pixels under each black text hole from the surrounding image context. Preserve every non-text image element, including lettering fused with an emblem, logo, crest, badge or illustration. The native edit mask is the only edit boundary.`;
  await fsp.writeFile(
    path.join(loopDir, "text_cleanup_request.json"),
    JSON.stringify({
      model: TEXT_REPAIR_MODEL,
      quality: TEXT_REPAIR_QUALITY,
      method: svgGuideEnabled
        ? "black-hole text plate + residual SVG -> images.edit (OpenAI GPT Image 2.5 Sunburst)"
        : "black-hole text plate only -> images.edit (OpenAI GPT Image 2.5 Sunburst)",
      ordinary_text_ids: textBoxes.map((box) => String(box.id)),
      input_image: repairInput,
      image_inputs: imageInputs,
      mask: apiMask,
      svg_guide_enabled: svgGuideEnabled,
      svg_guide: svgGuideEnabled
        ? {
            scene: options.svgGuide.scenePath || null,
            residual: options.svgGuide.svgPath || null,
            preview: options.svgGuide.png,
            hidden_ids: options.svgGuide.hiddenIds || [],
            matches: options.svgGuide.matches || [],
          }
        : null,
      reference_policy: svgGuideEnabled
        ? "Image 1 is the black-hole plate; Image 2 is the required residual SVG preview; the native multipart mask controls the edit boundary"
        : "single black-hole plate only; no SVG document or SVG preview is generated or transmitted; the native multipart mask controls the edit boundary",
      prompt,
    }, null, 2),
    "utf8",
  );
  // Use the same dedicated Sunburst background-repair route and multi-image
  // transport as recursive loop repair. The foreground model argument remains
  // deliberately ignored for this one-time full-plate edit.
  const textEditOptions = {
    provider: "openai",
    clientKind: "background-repair",
    imagePaths: imageInputs,
    quality: TEXT_REPAIR_QUALITY,
    timeoutMs:getRoute('background').timeout_ms,
  };
  await imageEdit(
    repairInput,
    generated,
    prompt,
    TEXT_REPAIR_MODEL,
    apiMask,
    signal,
    textEditOptions,
  );
  const generatedStats = await sharp(generated).stats();
  const generatedRgbMean = generatedStats.channels
    .slice(0, 3)
    .reduce((sum, channel) => sum + Number(channel.mean || 0), 0) / 3;
  if (generatedRgbMean < 2)
    throw new Error("text cleanup image response was blank/black");
  // Match the recursive background workflow: the model sees explicit black
  // holes plus an edit mask, and its complete repaired plate becomes the
  // next-stage source. Avoid local splicing, which produces edge seams.
  if (options.returnGenerated) return generated;
  await fsp.copyFile(generated, output);
  return output;
}
function immediateDeferredReferenceBoxes(detection, selectedBoxes) {
  if (!detection || !Array.isArray(detection.boxes)) return [];
  const selectedIds = new Set(
    (selectedBoxes || []).map((box) => String(box.id)),
  );
  if (!selectedIds.size) return [];
  return detection.boxes.filter((box) => {
    const id = String(box.id);
    if (
      selectedIds.has(id) ||
      box.visible === false ||
      ["text", "background"].includes(box.category)
    )
      return false;
    const blockers = Array.isArray(box.occluded_by)
      ? box.occluded_by.map(String)
      : [];
    // A reference is useful only when this loop removes at least one of its
    // blockers. Keep just the immediately revealed depth: a still-present
    // blocker postpones that reference until the
    // next loop instead of leaking every deeper object into the current edit.
    return (
      blockers.some((id) => selectedIds.has(id)) &&
      blockers.every((id) => selectedIds.has(id))
    );
  });
}

async function makeBackgroundReferenceCrops(source, boxes, loopDir) {
  if (!Array.isArray(boxes) || !boxes.length) return [];
  const meta = await sharp(source).metadata();
  const outputDir = path.join(loopDir, "background_references");
  await fsp.mkdir(outputDir, { recursive: true });
  const references = [];
  const seen = new Set();
  for (const [index, box] of boxes.slice(0, 8).entries()) {
    const id = String(box.id || `box_${index + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const bbox = normalizeBox(box.bbox, meta.width, meta.height);
    if (!bbox) continue;
    const [left, top, width, height] = bbox;
    const file = path.join(
      outputDir,
      `${String(references.length + 1).padStart(2, "0")}_${safeId(id, `box_${index + 1}`)}.png`,
    );
    await sharp(source)
      .extract({ left, top, width, height })
      .png()
      .toFile(file);
    references.push({
      id,
      label: String(box.label || box.description || id),
      category: box.category || "other",
      bbox,
      file,
      image_index: references.length + 2,
    });
  }
  return references;
}

function flatSegmentAtlasGrid(boxes, maxSide = GPT_IMAGE_ATLAS_MAX_SIZE) {
  const layout = seedreamAtlasGrid(boxes, maxSide);
  if (!layout.fits) return layout;
  // The endpoint can add hundreds of pixels to satisfy its minimum area.
  // Spread the cells across that actual canvas, retaining each crop's scale.
  // Otherwise the model reflows a short grid into the large blank footer.
  const columns = layout.columns, rows = layout.rows;
  const gap = Number(layout.cell_gap) || 0;
  const cellWidth = Math.floor((layout.width - gap * (columns - 1)) / columns);
  const cellHeight = Math.floor((layout.height - gap * (rows - 1)) / rows);
  return { ...layout, packing: "flat-segment-full-canvas-grid", grid_offset: [0, 0],
    grid_width: layout.width, grid_height: layout.height,
    used_width: layout.width, used_height: layout.height,
    cell_width: cellWidth, cell_height: cellHeight,
    cells: layout.cells.map((cell, index) => {
      const column = index % columns, row = Math.floor(index / columns);
      const x = column * (cellWidth + gap), y = row * (cellHeight + gap);
      const width = column === columns - 1 ? layout.width - x : cellWidth;
      const height = row === rows - 1 ? layout.height - y : cellHeight;
      return { ...cell, x, y, width, height,
        crop_x: Math.floor((width - cell.crop_width) / 2),
        crop_y: Math.floor((height - cell.crop_height) / 2) };
    }) };
}

async function readFlatSegmentAtlasMasks(modelRaw, batch, layout) {
  const meta = await sharp(modelRaw).metadata();
  const responseWidth = Number(meta.width), responseHeight = Number(meta.height);
  if (!responseWidth || !responseHeight ||
      Math.abs((responseWidth / responseHeight) / (layout.width / layout.height) - 1) > 0.01)
    throw new Error("FLAT_SEGMENT_ATLAS_ASPECT_MISMATCH");
  const scaleX = responseWidth / layout.width, scaleY = responseHeight / layout.height;
  const masks = [];
  const missing = [];
  for (const [index, box] of batch.entries()) {
    const cell = layout.cells[index];
    const targetX = cell.x + Number(cell.crop_x || 0), targetY = cell.y + Number(cell.crop_y || 0);
    const targetW = Number(cell.crop_width || cell.width), targetH = Number(cell.crop_height || cell.height);
    const left = Math.max(0, Math.min(responseWidth - 1, Math.floor(targetX * scaleX)));
    const top = Math.max(0, Math.min(responseHeight - 1, Math.floor(targetY * scaleY)));
    const cropWidth = Math.max(1, Math.min(responseWidth - left, Math.ceil(targetW * scaleX)));
    const cropHeight = Math.max(1, Math.min(responseHeight - top, Math.ceil(targetH * scaleY)));
    const crop = await sharp(modelRaw).extract({ left, top, width: cropWidth, height: cropHeight })
      .flatten({ background: "#000000" }).toColourspace("srgb")
      .resize(box.bbox[2], box.bbox[3], { fit: "fill", kernel: sharp.kernel.nearest })
      .removeAlpha().raw().toBuffer();
    const local = Buffer.alloc(box.bbox[2] * box.bbox[3]);
    let selectedPixels = 0;
    for (let pixel = 0; pixel < local.length; pixel++) {
      const offset = pixel * 3, red = crop[offset], green = crop[offset + 1], blue = crop[offset + 2];
      if (red < 128 || red <= green * 1.4 || red <= blue * 1.4) continue;
      local[pixel] = 255;
      selectedPixels++;
    }
    if (!selectedPixels) missing.push(box.id);
    masks.push({ local, selectedPixels, targetCrop: [targetX, targetY, targetW, targetH] });
  }
  // Validate the whole response before committing any of its pixels. A retry
  // must never leave the earlier invalid response in the final union mask.
  if (missing.length) throw new Error(`FLAT_SEGMENT_EMPTY_BBOX:${missing.join(",")}`);
  return { masks, responseWidth, responseHeight };
}

async function makeFlatSegmentDeletionMaskAtlas(source, boxes, layers, loopDir, signal, onProgress = () => {}, referenceBoxes = [], options = {}) {
  const { width, height } = await sharp(source).metadata();
  if (!width || !height || !boxes.length) throw new Error("flat segment requires a canvas and selected bboxes");
  const bboxes = boxes.map((box) => ({
    id: box.id,
    label: box.label || box.name || box.id,
    bbox: normalizeBox(box.bbox || box.source_bbox || box.working_bbox, width, height),
  }));
  if (bboxes.some((box) => !box.bbox)) throw new Error("flat segment contains an invalid bbox");
  const guide = await maskForBoxes(width, height, bboxes.map((box) => box.bbox),
    path.join(loopDir, "flat_segment_bbox_guide_alpha.png"));
  const guideVisible = await makeBlackWhiteEditMask(guide,
    path.join(loopDir, "flat_segment_bbox_guide.png"));
  const selected = Buffer.alloc(width * height);
  const selectedByBox = new Array(bboxes.length);
  const counts = Array(bboxes.length).fill(0);
  const results = new Array(bboxes.length);
  const atlasBatches = [];
  const batchSize = Math.max(1, Math.min(7,
    Math.floor(Number(process.env.LAYERFORGE_FLAT_SEGMENT_ATLAS_BATCH_SIZE) || 7)));
  const plans = planSeedreamAtlasBatches(
    bboxes,
    batchSize,
    GPT_IMAGE_ATLAS_MAX_SIZE,
  );
  let completed = 0;
  const atlasRoot = path.join(loopDir, "flat_segment_atlas");
  await fsp.mkdir(atlasRoot, { recursive: true });

  const writeAtlasMaskPreview = async (rawPath, outputPath) => {
    const raw = await sharp(rawPath).flatten({ background: "#000000" })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = raw.info.width * raw.info.height;
    const rgb = Buffer.alloc(pixels * 3);
    for (let pixel = 0; pixel < pixels; pixel++) {
      const offset = pixel * raw.info.channels;
      const red = raw.data[offset];
      const green = raw.data[offset + 1];
      const blue = raw.data[offset + 2];
      const selectedPixel = red >= 128 && red > green * 1.4 && red > blue * 1.4;
      if (selectedPixel) rgb[pixel * 3] = 255;
    }
    await sharp(rgb, {
      raw: { width: raw.info.width, height: raw.info.height, channels: 3 },
    }).png().toFile(outputPath);
  };

  const batchErrors = new Map();
  const concurrency = 4;
  const runBatch = async (plan, planIndex) => {
    let batchRecord;
    try {
      if (signal?.aborted) throw new Error("JOB_STOPPED");
      const batch = plan.boxes || [];
      if (!batch.length) return;
      const batchNumber = planIndex + 1;
      const batchDir = path.join(atlasRoot, `batch_${String(batchNumber).padStart(2, "0")}`);
      await fsp.mkdir(batchDir, { recursive: true });
      const layout = flatSegmentAtlasGrid(batch, GPT_IMAGE_ATLAS_MAX_SIZE);
      if (!layout?.fits)
        throw new Error(`flat segment atlas cannot be packed: ${layout?.reason || "unknown"}`);
      const input = path.join(batchDir, "input.png");
      const modelRaw = path.join(batchDir, "model_raw.png");
      const normalizedAtlas = path.join(batchDir, "normalized.png");
      const request = path.join(batchDir, "request.json");
      await makeSeedreamAtlasInput(source, batch, layout, input);
      const targets = batch.map((box, index) => {
        const cell = layout.cells[index];
        const originalId = String(box.id).replace(/^l\d+_/, "");
        return {
          cell: index + 1,
          id: box.id,
          label: box.label,
          source_bbox: box.bbox,
          cell_bbox: [cell.x, cell.y, cell.width, cell.height],
          target_crop: [
            cell.x + Number(cell.crop_x || 0),
            cell.y + Number(cell.crop_y || 0),
            Number(cell.crop_width || cell.width),
            Number(cell.crop_height || cell.height),
          ],
          deeper_objects_to_preserve: referenceBoxes
            .filter((ref) => (ref.occluded_by || []).map(String).includes(originalId))
            .map((ref) => ({ id: ref.id, bbox: ref.bbox })),
        };
      });
      const prompt = `Flat segmentation atlas. The attached image has ${layout.columns} columns and ${layout.rows} rows spanning the ENTIRE ${layout.width}x${layout.height} canvas, with ${batch.length} target crops. Each target is listed as [cell,id,source_bbox,cell_bbox,target_crop,deeper_objects_to_preserve]. For every target cell, paint ONLY the listed foreground object's visible silhouette pure RED (#ff0000), including its own border, attached glow, shadow and protruding edges. Independently visible objects behind or beside it, especially deeper_objects_to_preserve, must remain BLACK even inside the target crop. Only genuine cut-through holes remain black inside the target. Paint all other pixels pure BLACK (#000000). Keep every silhouette at its exact input position and scale INSIDE its stated target_crop; that rectangle is the exact crop later read by software. Do not enlarge the artwork to fill its cell, shift rows, redistribute spacing, reflow, merge, or bleed across cells. Return ONE opaque two-color PNG at exactly ${layout.width}x${layout.height}. Preserve the numbered cell order and empty cells. No labels, gradients or transparency. Targets: ${JSON.stringify(targets)}`;
      const outputSize = gptImageAtlasResponseSize(layout);
      await fsp.writeFile(request, JSON.stringify({
        endpoint: "images.edit",
        model: GPT_IMAGE_25_FLARE_MODEL,
        quality: qualityFor('segmentation'),
        method: "flat_segment_fixed_cell_atlas",
        input,
        output_size: outputSize,
        layout,
        targets,
        prompt,
      }, null, 2));
      batchRecord = atlasBatches.find((record) => record.batch === batchNumber) || {
        batch: batchNumber,
        input,
        model_raw: modelRaw,
        normalized: normalizedAtlas,
        request,
        box_ids: batch.map((box) => String(box.id)),
        layout,
        status: "running",
        attempts: [],
      };
      batchRecord.status = "running";
      delete batchRecord.error;
      if (!atlasBatches.includes(batchRecord)) atlasBatches.push(batchRecord);
      atlasBatches.sort((a, b) => a.batch - b.batch);
      onProgress({
        current: completed,
        total: bboxes.length,
        stage: "atlas",
        batch: batchNumber,
        batches: plans.length,
        atlas_batches: atlasBatches.slice(),
        results: results.filter(Boolean),
      });
      let decoded;
      let lastError = batchRecord.attempts.at(-1)?.error
        ? new Error(batchRecord.attempts.at(-1).error) : null;
      for (let automaticAttempt = 1; automaticAttempt <= (hasJobRetryPolicy() ? 1 : 3); automaticAttempt++) {
        if (signal?.aborted) throw new Error("JOB_STOPPED");
        const attempt = batchRecord.attempts.length + 1;
        const attemptRaw = path.join(batchDir, `attempt_${attempt}_model_raw.png`);
        const attemptPrompt = /^FLAT_SEGMENT_(ATLAS_ASPECT_MISMATCH|EMPTY_BBOX)/.test(lastError?.message || "")
          ? `${prompt}\n\nThe previous response failed coordinate validation: ${lastError.message}. Correct the same atlas. All targets must have red silhouette pixels INSIDE their stated target_crop rectangles; keep the crop positions and object sizes exactly as in the attached input.`
          : prompt;
        const attemptRecord = { attempt, status: "running", model_raw: attemptRaw, prompt: attemptPrompt };
        batchRecord.attempts.push(attemptRecord);
        onProgress({ current: completed, total: bboxes.length, stage: "atlas", batch: batchNumber,
          batches: plans.length, attempt, automatic_attempt: automaticAttempt,
          atlas_batches: atlasBatches.slice(), results: results.filter(Boolean) });
        try {
          await imageEdit(input, modelRaw, attemptPrompt, GPT_IMAGE_25_FLARE_MODEL, null, signal, {
            provider: "openai",
            clientKind: "segmentation",
            imagePaths: [input],
            quality: qualityFor('segmentation'),
            background: "opaque",
            size: outputSize,
            resizeOutput: false,
            timeoutMs:getRoute('segmentation').timeout_ms,
          });
          await fsp.copyFile(modelRaw, attemptRaw);
          await writeAtlasMaskPreview(modelRaw, normalizedAtlas);
          decoded = await readFlatSegmentAtlasMasks(modelRaw, batch, layout);
          attemptRecord.status = "validated";
          attemptRecord.selected_pixels = decoded.masks.map(({ selectedPixels }) => selectedPixels);
        } catch (error) {
          lastError = error;
          attemptRecord.status = "failed";
          attemptRecord.error = String(error.message || error);
          if (signal?.aborted || error.message === "JOB_STOPPED") throw error;
        } finally {
          await fsp.writeFile(path.join(batchDir, "attempts.json"), JSON.stringify(batchRecord.attempts, null, 2));
        }
        if (decoded) break;
      }
      if (!decoded) throw lastError;
      const { responseWidth, responseHeight } = decoded;
      for (let index = 0; index < batch.length; index++) {
        const box = batch[index];
        const globalIndex = bboxes.findIndex((candidate) => candidate.id === box.id);
        const cell = layout.cells[index];
        const { local, selectedPixels, targetCrop } = decoded.masks[index];
        selectedByBox[globalIndex] = local;
        counts[globalIndex] = selectedPixels;
        results[globalIndex] = {
          ...box,
          source: null,
          model_raw: null,
          normalized: null,
          selected_pixels: selectedPixels,
          crop_bbox: [...box.bbox],
          atlas_batch: batchNumber,
          atlas_cell: {
            index: index + 1,
            rect: [cell.x, cell.y, cell.width, cell.height],
            target_crop: targetCrop,
          },
        };
      }
      batchRecord.status = "completed";
      batchRecord.response_size = [responseWidth, responseHeight];
      batchRecord.selected_pixels = batch.map((box) => results[bboxes.findIndex((candidate) => candidate.id === box.id)].selected_pixels);
      completed += batch.length;
      onProgress({
        current: completed,
        total: bboxes.length,
        stage: "atlas",
        batch: batchNumber,
        batches: plans.length,
        atlas_batches: atlasBatches.slice(),
        results: results.filter(Boolean),
      });
    } catch (error) {
      if (batchRecord) {
        batchRecord.status = "failed";
        batchRecord.error = String(error.message || error);
      }
      batchErrors.set(planIndex, error);
      onProgress({ current: completed, total: bboxes.length, stage: "atlas", batch: planIndex + 1,
        batches: plans.length, atlas_batches: atlasBatches.slice(), results: results.filter(Boolean) });
    }
  };
  await mapConcurrent(plans, concurrency, runBatch);
  // Finish concurrent work before waiting: the Web job has one pending retry
  // slot, and completed batches must not be lost or overwrite its failed state.
  while (batchErrors.size) {
    if (signal?.aborted) throw new Error("JOB_STOPPED");
    await fsp.writeFile(path.join(loopDir, "flat_segment_failure.json"), JSON.stringify({
      errors: [...batchErrors.values()].map((error) => String(error.message || error)), atlas_batches: atlasBatches,
    }, null, 2));
    const planIndex = Math.min(...batchErrors.keys());
    const error = batchErrors.get(planIndex);
    const batchRecord = atlasBatches.find((record) => record.batch === planIndex + 1);
    if (!options.waitForAtlasRetry || !batchRecord) throw error;
    const request = {
      request_id: `loop_${options.loopNumber || path.basename(loopDir)}_flat_segment_atlas_${batchRecord.batch}`,
      kind: "flat_segment_atlas",
      status: "failed",
      batch: batchRecord.batch,
      attempt: batchRecord.attempts.length,
      input: batchRecord.input,
      request: batchRecord.request,
      batch_dir: path.dirname(batchRecord.request),
      box_ids: batchRecord.box_ids,
      timeout_ms: getRoute('segmentation').timeout_ms,
      reason: conciseError(error),
      retryable: true,
    };
    const retryProgress = {
      current: completed, total: bboxes.length, stage: "atlas", batch: batchRecord.batch,
      batches: plans.length, atlas_batches: atlasBatches.slice(), results: results.filter(Boolean),
    };
    onProgress({ ...retryProgress, status: "waiting_retry", active_request: request });
    await options.waitForAtlasRetry(request);
    if (signal?.aborted) throw new Error("JOB_STOPPED");
    onProgress({ ...retryProgress, status: "running", active_request: null });
    batchErrors.delete(planIndex);
    await runBatch(plans[planIndex], planIndex);
  }
  await fsp.rm(path.join(loopDir, "flat_segment_failure.json"), { force: true });
  const missing = bboxes.filter((_, index) => counts[index] === 0).map((box) => box.id);
  if (missing.length) throw new Error(`FLAT_SEGMENT_EMPTY_BBOX:${missing.join(",")}`);
  const deferredOccluders = new Set(referenceBoxes.flatMap((box) => box.occluded_by || []).map(String));
  const protectedByLayer = {};
  const recoveredLayers = {};
  for (const [index, box] of bboxes.entries()) {
    const local = selectedByBox[index];
    const originalId = String(box.id).replace(/^l\d+_/, "");
    const layer = layers.find((item) => item.id === box.id);
    const hasDeferredObject = deferredOccluders.has(originalId);
    if (hasDeferredObject && (!layer?.source || !fs.existsSync(layer.source)))
      throw new Error(`FLAT_SEGMENT_DEFERRED_OCCLUDER_ALPHA_MISSING:${box.id}`);
    if (layer?.source && fs.existsSync(layer.source)) {
      const [lx, ly, lw, lh] = layer.bbox;
      const layerMeta = await sharp(layer.source).metadata();
      if (hasDeferredObject && (!layerMeta.hasAlpha || layerMeta.width !== lw || layerMeta.height !== lh))
        throw new Error(`FLAT_SEGMENT_DEFERRED_OCCLUDER_ALPHA_INVALID:${box.id}`);
      if (layerMeta.hasAlpha && layerMeta.width === lw && layerMeta.height === lh) {
        const alpha = await sharp(layer.source).extractChannel(3).raw().toBuffer();
        let pixels = 0;
        for (const value of alpha) if (value >= 32) pixels++;
        const sparseLargeCutout = box.bbox[2] * box.bbox[3] >= width * height * 0.02 &&
          pixels < box.bbox[2] * box.bbox[3] * 0.65;
        let selectedPixels = 0;
        const aligned = Buffer.alloc(local.length);
        for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
            const px = lx + x, py = ly + y;
            if (px < box.bbox[0] || px >= box.bbox[0] + box.bbox[2] ||
                py < box.bbox[1] || py >= box.bbox[1] + box.bbox[3] || alpha[y * lw + x] < 32) continue;
            aligned[(py - box.bbox[1]) * box.bbox[2] + px - box.bbox[0]] = 255;
            selectedPixels++;
        }
        if (!selectedPixels && pixels) {
          let left = lw, top = lh, right = -1, bottom = -1;
          for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
            if (alpha[y * lw + x] < 32) continue;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
          const [bx, by, bw, bh] = box.bbox;
          const recoveredAlpha = await sharp(layer.source)
            .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
            .extractChannel(3).resize(bw, bh, { fit: "fill" }).raw().toBuffer();
          const recovered = await sharp(source).extract({ left: bx, top: by, width: bw, height: bh })
            .ensureAlpha().raw().toBuffer();
          for (let pixel = 0; pixel < recoveredAlpha.length; pixel++)
            recovered[pixel * 4 + 3] = recoveredAlpha[pixel];
          const recoveredDir = path.join(loopDir, "flat_segment_atlas", "recovered_layers");
          await fsp.mkdir(recoveredDir, { recursive: true });
          const recoveredPath = path.join(recoveredDir, `${safeId(box.id, `target_${index + 1}`)}.png`);
          await sharp(recovered, { raw: { width: bw, height: bh, channels: 4 } }).png().toFile(recoveredPath);
          const originalSource = layer.source;
          layer.source = path.resolve(recoveredPath);
          layer.bbox = [...box.bbox];
          layer.working_bbox = [...box.bbox];
          layer.model_output_fallback = "misaligned_atlas_alpha_recentered_on_source_bbox";
          layer.misaligned_model_source = originalSource;
          layer.use_model_output = false;
          recoveredLayers[box.id] = {
            reason: "alpha_outside_source_bbox", original_source: originalSource,
            recovered_source: layer.source, original_bbox: [lx, ly, lw, lh],
            source_bbox: [...box.bbox], original_alpha_pixels: pixels,
          };
          selectedPixels = 0;
          for (let pixel = 0; pixel < recoveredAlpha.length; pixel++) {
            if (recoveredAlpha[pixel] < 32) continue;
            aligned[pixel] = 255;
            selectedPixels++;
          }
        }
        if ((hasDeferredObject || sparseLargeCutout) && selectedPixels) {
          aligned.copy(local);
          counts[index] = selectedPixels;
          results[index].selected_pixels = selectedPixels;
          protectedByLayer[box.id] = { pixels: selectedPixels,
            reason: recoveredLayers[box.id] ? "recovered_misaligned_layer"
              : hasDeferredObject ? "deferred_object" : "sparse_large_cutout" };
        } else if (hasDeferredObject && !selectedPixels) {
          protectedByLayer[box.id] = { pixels: counts[index], reason: "flat_segment_alpha_fallback" };
        }
      }
    }
    for (let y = 0; y < box.bbox[3]; y++) for (let x = 0; x < box.bbox[2]; x++)
      if (local[y * box.bbox[2] + x])
        selected[(box.bbox[1] + y) * width + box.bbox[0] + x] = 255;
  }
  const binary = path.join(loopDir, "flat_segment_binary_mask.png");
  await sharp(selected, { raw: { width, height, channels: 1 } }).png().toFile(binary);
  const normalized = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < selected.length; pixel++) normalized[pixel * 3] = selected[pixel];
  await sharp(normalized, { raw: { width, height, channels: 3 } }).png()
    .toFile(path.join(loopDir, "flat_segment_normalized.png"));
  const deleteSelected = Buffer.from(selected);
  const atlasAdded = {};
  for (const box of bboxes) {
    const layer = layers.find((item) => item.id === box.id);
    if (!layer?.source || !fs.existsSync(layer.source)) continue;
    const [lx, ly, lw, lh] = layer.bbox;
    const atlasAlpha = await sharp(layer.source).ensureAlpha().extractChannel(3)
      .resize(lw, lh, { fit: "fill" }).raw().toBuffer();
    let added = 0;
    const [bx, by, bw, bh] = box.bbox;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        if (atlasAlpha[y * lw + x] < 32) continue;
        const px = lx + x, py = ly + y;
        if (px < bx || px >= bx + bw || py < by || py >= by + bh ||
            px < 0 || px >= width || py < 0 || py >= height) continue;
        const pixel = py * width + px;
        if (!deleteSelected[pixel]) added++;
        deleteSelected[pixel] = 255;
      }
    }
    atlasAdded[box.id] = added;
  }
  const atlasUnionMask = path.join(loopDir, "flat_segment_union_mask.png");
  await sharp(deleteSelected, { raw: { width, height, channels: 1 } })
    .png().toFile(atlasUnionMask);
  const expanded = Buffer.from(deleteSelected);
  const edgePadding = {};
  for (const box of bboxes) {
    const [bx, by, bw, bh] = box.bbox;
    const radius = protectedByLayer[box.id] ? 2
      : Math.max(2, Math.min(6, Math.round(Math.min(bw, bh) * 0.06)));
    edgePadding[box.id] = radius;
    const left = Math.max(0, Math.round(bx));
    const top = Math.max(0, Math.round(by));
    const right = Math.min(width, Math.round(bx + bw));
    const bottom = Math.min(height, Math.round(by + bh));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (!deleteSelected[y * width + x]) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const py = y + dy;
          if (py < 0 || py >= height) continue;
          const span = Math.floor(Math.sqrt(radius * radius - dy * dy));
          for (let px = Math.max(0, x - span); px <= Math.min(width - 1, x + span); px++)
            expanded[py * width + px] = 255;
        }
      }
    }
  }
  const deleteMask = path.join(loopDir, "flat_segment_delete_mask.png");
  await sharp(expanded, { raw: { width, height, channels: 1 } })
    .png().toFile(deleteMask);
  const alpha = Buffer.alloc(width * height * 4, 255);
  for (let pixel = 0; pixel < expanded.length; pixel++)
    if (expanded[pixel]) alpha[pixel * 4 + 3] = 0;
  const editMask = path.join(loopDir, ".background_work", "flat_segment_edit_mask.png");
  await fsp.mkdir(path.dirname(editMask), { recursive: true });
  await sharp(alpha, { raw: { width, height, channels: 4 } }).png().toFile(editMask);
  await fsp.writeFile(path.join(loopDir, "flat_segment_manifest.json"), JSON.stringify({
    bbox_guide: guideVisible,
    flat_segment_binary_mask: binary,
    atlas_union_mask: atlasUnionMask,
    actual_delete_mask: deleteMask,
    source_canvas: [width, height],
    atlas_mode: "fixed_cell_atlas",
    atlas_model: GPT_IMAGE_25_FLARE_MODEL,
    atlas_batch_size: batchSize,
    atlas_concurrency: concurrency,
    automatic_validation_attempts: 3,
    atlas_batches: atlasBatches,
    targets: results,
    selected_pixels_per_bbox: counts,
    atlas_alpha_added_pixels: atlasAdded,
    deferred_occluders_using_layer_alpha: protectedByLayer,
    recovered_misaligned_layers: recoveredLayers,
    edge_padding_pixels: edgePadding,
    conversion: "full-canvas fixed-cell atlas -> validate every target crop; use extracted layer alpha for occluders of deferred objects; union other targets with model Atlas alpha; expand deletion edges",
  }, null, 2));
  return editMask;
}

async function makeFlatSegmentDeletionMask(source, boxes, layers, loopDir, signal, onProgress = () => {}, referenceBoxes = [], options = {}) {
  if (String(process.env.LAYERFORGE_FLAT_SEGMENT_ATLAS || "1") !== "0" || referenceBoxes.length)
    return makeFlatSegmentDeletionMaskAtlas(source, boxes, layers, loopDir, signal, onProgress, referenceBoxes, options);
  const { width, height } = await sharp(source).metadata();
  if (!width || !height || !boxes.length) throw new Error("flat segment requires a canvas and selected bboxes");
  const bboxes = boxes.map((box) => ({
    id: box.id,
    label: box.label || box.name || box.id,
    bbox: box.bbox || box.source_bbox || box.working_bbox,
  }));
  const guide = await maskForBoxes(width, height, bboxes.map((box) => box.bbox),
    path.join(loopDir, "flat_segment_bbox_guide_alpha.png"));
  const guideVisible = await makeBlackWhiteEditMask(guide,
    path.join(loopDir, "flat_segment_bbox_guide.png"));
  const selected = Buffer.alloc(width * height);
  const counts = Array(bboxes.length).fill(0);
  const results = new Array(bboxes.length);
  let nextIndex = 0;
  const makeOne = async () => {
    while (nextIndex < bboxes.length) {
      if (signal?.aborted) throw new Error("JOB_STOPPED");
      const index = nextIndex++;
      const box = bboxes[index];
      const [bx, by, bw, bh] = box.bbox;
      const left = Math.max(0, Math.round(bx));
      const top = Math.max(0, Math.round(by));
      const right = Math.min(width, Math.round(bx + bw));
      const bottom = Math.min(height, Math.round(by + bh));
      if (right <= left || bottom <= top) throw new Error(`invalid flat segment bbox: ${box.id}`);
      const cropWidth = right - left, cropHeight = bottom - top;
      const stem = `flat_segment_${String(index + 1).padStart(3, "0")}`;
      const crop = path.join(loopDir, `${stem}_source.png`);
      const raw = path.join(loopDir, `${stem}_model_raw.png`);
      const normalized = path.join(loopDir, `${stem}_normalized.png`);
      const prompt = `Flat segmentation of this exact image crop. The crop is one target bbox from a larger UI scene and contains the object "${box.label}". Paint the COMPLETE visible silhouette of that object pure RED (#ff0000) in its CURRENT crop position. Include every outer rim, border, glow, cast shadow and protruding edge belonging to the object; for a coin, include its entire outer gold ring, not only the central disc or emblem. Paint all other pixels pure BLACK (#000000), including true interior holes and background. Keep the object's scale and placement relative to all four crop edges; do not center, shrink, enlarge, move, or redraw it. No labels, gradients, antialiasing or transparency. Return only an opaque two-color image with the same crop aspect ratio.`;
      await sharp(source).extract({ left, top, width: cropWidth, height: cropHeight })
        .png().toFile(crop);
      await fsp.writeFile(path.join(loopDir, `${stem}_request.json`), JSON.stringify({
        endpoint: "images.edit", model: GPT_IMAGE_25_FLARE_MODEL, quality: qualityFor('segmentation'),
        client_kind: "segmentation", input_images: [crop], box, prompt,
      }, null, 2));
      await imageEdit(crop, raw, prompt, GPT_IMAGE_25_FLARE_MODEL, null, signal, {
        provider: "openai", clientKind: "segmentation", imagePaths: [crop],
        quality: qualityFor('segmentation'), background: "opaque", resizeOutput: false,
      });
      const rgb = await sharp(raw).flatten({ background: "#000000" })
        .resize(cropWidth, cropHeight, { fit: "fill", kernel: sharp.kernel.nearest })
        .removeAlpha().raw().toBuffer();
      const local = Buffer.alloc(cropWidth * cropHeight);
      for (let y = 0; y < cropHeight; y++) {
        for (let x = 0; x < cropWidth; x++) {
          const pixel = y * cropWidth + x;
          const offset = pixel * 3;
          const red = rgb[offset], green = rgb[offset + 1], blue = rgb[offset + 2];
          if (red < 128 || red <= green * 1.4 || red <= blue * 1.4) continue;
          local[pixel] = 255;
          selected[(top + y) * width + left + x] = 255;
          counts[index]++;
        }
      }
      if (!counts[index]) throw new Error(`FLAT_SEGMENT_EMPTY_BBOX:${box.id}`);
      const localRgb = Buffer.alloc(cropWidth * cropHeight * 3);
      for (let pixel = 0; pixel < local.length; pixel++) localRgb[pixel * 3] = local[pixel];
      await sharp(localRgb, { raw: { width: cropWidth, height: cropHeight, channels: 3 } })
        .png().toFile(normalized);
      results[index] = { ...box, source: crop, model_raw: raw, normalized,
        selected_pixels: counts[index], crop_bbox: [left, top, cropWidth, cropHeight] };
      onProgress({ current: results.filter(Boolean).length, total: bboxes.length,
        results: results.filter(Boolean) });
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, bboxes.length) }, makeOne));
  const failed = workers.find((worker) => worker.status === "rejected");
  if (failed) throw failed.reason;
  const missing = bboxes.filter((_, index) => counts[index] === 0).map((box) => box.id);
  if (missing.length) throw new Error(`FLAT_SEGMENT_EMPTY_BBOX:${missing.join(",")}`);
  const binary = path.join(loopDir, "flat_segment_binary_mask.png");
  await sharp(selected, { raw: { width, height, channels: 1 } }).png().toFile(binary);
  const normalized = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < selected.length; pixel++) normalized[pixel * 3] = selected[pixel];
  await sharp(normalized, { raw: { width, height, channels: 3 } }).png()
    .toFile(path.join(loopDir, "flat_segment_normalized.png"));
  const deleteSelected = Buffer.from(selected);
  const atlasAdded = {};
  for (const box of bboxes) {
    const layer = layers.find((item) => item.id === box.id);
    if (!layer?.source || !fs.existsSync(layer.source)) continue;
    const [lx, ly, lw, lh] = layer.bbox;
    const atlasAlpha = await sharp(layer.source).ensureAlpha().extractChannel(3)
      .resize(lw, lh, { fit: "fill" }).raw().toBuffer();
    let added = 0;
    const [bx, by, bw, bh] = box.bbox;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        if (atlasAlpha[y * lw + x] < 32) continue;
        const px = lx + x, py = ly + y;
        if (px < bx || px >= bx + bw || py < by || py >= by + bh ||
            px < 0 || px >= width || py < 0 || py >= height) continue;
        const pixel = py * width + px;
        if (!deleteSelected[pixel]) added++;
        deleteSelected[pixel] = 255;
      }
    }
    atlasAdded[box.id] = added;
  }
  const atlasUnionMask = path.join(loopDir, "flat_segment_union_mask.png");
  await sharp(deleteSelected, { raw: { width, height, channels: 1 } })
    .png().toFile(atlasUnionMask);
  const expanded = Buffer.from(deleteSelected);
  const edgePadding = {};
  for (const box of bboxes) {
    const [bx, by, bw, bh] = box.bbox;
    const radius = Math.max(2, Math.min(6, Math.round(Math.min(bw, bh) * 0.06)));
    edgePadding[box.id] = radius;
    const left = Math.max(0, Math.round(bx));
    const top = Math.max(0, Math.round(by));
    const right = Math.min(width, Math.round(bx + bw));
    const bottom = Math.min(height, Math.round(by + bh));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (!deleteSelected[y * width + x]) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const py = y + dy;
          if (py < 0 || py >= height) continue;
          const span = Math.floor(Math.sqrt(radius * radius - dy * dy));
          for (let px = Math.max(0, x - span); px <= Math.min(width - 1, x + span); px++)
            expanded[py * width + px] = 255;
        }
      }
    }
  }
  const deleteMask = path.join(loopDir, "flat_segment_delete_mask.png");
  await sharp(expanded, { raw: { width, height, channels: 1 } })
    .png().toFile(deleteMask);
  const alpha = Buffer.alloc(width * height * 4, 255);
  for (let pixel = 0; pixel < expanded.length; pixel++)
    if (expanded[pixel]) alpha[pixel * 4 + 3] = 0;
  const editMask = path.join(loopDir, ".background_work", "flat_segment_edit_mask.png");
  await sharp(alpha, { raw: { width, height, channels: 4 } }).png().toFile(editMask);
  await fsp.writeFile(path.join(loopDir, "flat_segment_manifest.json"), JSON.stringify({
    bbox_guide: guideVisible, flat_segment_binary_mask: binary,
    atlas_union_mask: atlasUnionMask, actual_delete_mask: deleteMask,
    source_canvas: [width, height], targets: results,
    selected_pixels_per_bbox: counts, atlas_alpha_added_pixels: atlasAdded,
    edge_padding_pixels: edgePadding,
    conversion: "per-bbox red dominant -> 0/255; union with model Atlas alpha; expand the binary deletion edge",
  }, null, 2));
  return editMask;
}

async function makeBackground(source, layers, loopDir, model, signal, options = {}) {
  const output = path.join(loopDir, "background.png");
  const meta = await sharp(source).metadata();
  const responseSize = backgroundResponseSize(meta.width, meta.height);
  const flatSegmentBackground = Boolean(options.flatSegmentBoxes?.length);
  const threeImageBackground = !options.svgGuide;
  if (flatSegmentBackground && options.svgGuide)
    throw new Error("FLAT_SEGMENT_SVG_GUIDE_UNSUPPORTED");
  // The deletion mask stays local; the semantic binary guide travels as an image.
  const workDir = path.join(loopDir, ".background_work");
  await fsp.mkdir(workDir, { recursive: true });
  // Standalone replays may reuse a completed local deletion contour. The Web
  // path creates it from this loop's selected foreground as before.
  const reusedMask = options.reuseDeletionMask ? path.resolve(options.reuseDeletionMask) : null;
  if (reusedMask) {
    const maskMeta = await sharp(reusedMask).metadata();
    if (!maskMeta.hasAlpha || maskMeta.width !== meta.width || maskMeta.height !== meta.height)
      throw new Error("BACKGROUND_REUSED_DELETION_MASK_MISMATCH");
  }
  const alphaMask = reusedMask || (options.flatSegmentBoxes?.length
    ? await makeFlatSegmentDeletionMask(source, options.flatSegmentBoxes, layers, loopDir, signal,
      options.onFlatSegmentProgress, options.referenceBoxes || [], options)
    : await maskForCutouts(
      meta.width,
      meta.height,
      layers,
      path.join(workDir, "mask.rgba.png"),
    ));
  // Preserve the binary keep mask for diagnosis, while the published mask and
  // model input both show the current image with its deletion holes transparent.
  const backgroundMask = path.join(loopDir, "background_mask.png");
  const backgroundKeepMask = path.join(loopDir, "background_keep_mask.png");
  const editMask = await makeBlackWhiteEditMask(alphaMask,
    threeImageBackground ? path.join(workDir, "background_edit_mask.png") : backgroundMask);
  if (threeImageBackground)
    await sharp(editMask).negate().png().toFile(backgroundKeepMask);
  const apiMask = threeImageBackground ? null : await makeOpenAiInpaintMask(
    alphaMask, path.join(loopDir, "background_mask_openai.png"));
  const repairInput = path.join(loopDir, "background_input.png");
  if (threeImageBackground)
    await makeTransparentHolePlate(source, alphaMask, repairInput);
  else
    await makeBlackHolePlate(source, alphaMask, repairInput);
  if (threeImageBackground)
    await fsp.copyFile(repairInput, backgroundMask);
  const repairSource = repairInput;
  const targets = layers.map((layer) => ({
    id: layer.id,
    bbox: layer.source_bbox || layer.working_bbox || layer.bbox,
    category: layer.category,
    description: String(layer.description || layer.name || layer.id).slice(0, 280),
    parent_id: layer.parent_id || null,
    occludes: layer.occludes || [],
    occluded_by: layer.occluded_by || [],
  }));
  const structureGuide = threeImageBackground
    ? await generateBackgroundStructureGuide(source, repairInput, alphaMask, targets, loopDir, signal,
      { maxAttempts: 1, onProgress: options.onFlatSegmentProgress,
        referenceBoxes: options.referenceBoxes || [],
        waitForAtlasRetry: options.waitForAtlasRetry, loopNumber: options.loopNumber })
    : null;
  if (threeImageBackground) options.onFlatSegmentProgress?.({
    current: 0, total: targets.length, stage: "preservation",
  });
  const preservation = threeImageBackground
    ? await retryJobOperation({ request_id: `loop_${options.loopNumber}_background_preservation`, label: "背景保留内容分析", input: repairInput, timeout_ms: getRoute("controller").timeout_ms }, () => generateBackgroundPreservationHints(repairInput, structureGuide.binary, targets, loopDir, signal))
    : null;
  // Background repair is intentionally pinned to the dedicated Sunburst/max
  // client. Foreground atlas/matte extraction and text cleanup use their own
  // explicitly selected clients.
  const backgroundModel = BACKGROUND_REPAIR_MODEL;
  const imageInputs = threeImageBackground
    ? [source, repairInput, structureGuide.binary]
    : [repairInput];
  if (options.svgGuide) {
    if (!options.svgGuide.png || !fs.existsSync(options.svgGuide.png))
      throw new Error("SVG_GUIDE_INPUT_MISSING");
    imageInputs.push(options.svgGuide.png);
  }
  const svgPrompt = options.svgGuide
    ? "\n\nImage 2 is the aligned residual structural SVG preview after the extracted nodes were removed. It is mandatory structural guidance only; use its layout, boundaries and depth relationships, but never copy its simplified vector colors or redraw removed objects. Image 1 and the edit mask remain the pixel-level truth."
    : "";
  const prompt = threeImageBackground
    ? buildThreeImageBackgroundPrompt(targets, null, preservation.hints)
    : `${BACKGROUND_PROMPT}\n\nThe black areas are deletion placeholders, never objects to preserve. Outside the transparent mask, the final result must retain the current-loop input exactly.${svgPrompt}`;
  if (threeImageBackground)
    await fsp.writeFile(path.join(loopDir, "background_final_prompt.txt"), prompt, "utf8");
  await fsp.writeFile(
    path.join(loopDir, "background_request.json"),
    JSON.stringify(
      {
        model: backgroundModel,
        quality: BACKGROUND_REPAIR_QUALITY,
        output_size: responseSize,
        response_geometry: "background_response.json",
        native_output: "background_model_native.png",
        method: threeImageBackground
          ? "single Gemini preservation inventory + one Sunburst edit of current-loop image, transparent-hole plate and binary guide; full model response is next-loop input"
          : "black-hole plate + optional residual SVG -> images.edit (OpenAI GPT Image 2.5 Sunburst)",
        bbox_targets: targets,
        input_image: repairInput,
        image_inputs: imageInputs,
        edit_target_image: repairInput,
        svg_guide: options.svgGuide
          ? {
              scene: options.svgGuide.scenePath || options.svgGuide.svgPath || null,
              residual: options.svgGuide.svgPath || null,
              preview: options.svgGuide.png || null,
              hidden_ids: options.svgGuide.hiddenIds || [],
              matches: options.svgGuide.matches || [],
            }
          : null,
        repair_mode: threeImageBackground
          ? "three_image_direct_sunburst_output"
          : options.svgGuide
            ? "svg_guided_gpt_image_2_5_sunburst"
            : "gpt_image_2_5_sunburst_direct",
        mask: threeImageBackground ? null : editMask,
        local_deletion_mask: alphaMask,
        diagnostic_keep_mask: threeImageBackground ? backgroundKeepMask : null,
        binary_guide: structureGuide?.binary || null,
        structure_guide_request: structureGuide?.requestPath || null,
        mask_api_input: apiMask,
        flat_segment_manifest: flatSegmentBackground
          ? path.join(loopDir, "flat_segment_manifest.json") : null,
        mask_format: threeImageBackground ? "Image 3: opaque RGB binary semantic reference PNG; no API mask" : "display/API: binary mask PNG",
        mask_semantics: threeImageBackground
          ? "Image 2 alpha=0: deletion holes; Image 3 white: remaining semantic element shapes to reconstruct using Image 2; black: everything else"
          : "RGB white=edit/remove foreground; RGB black=preserve; alpha=0 edit and alpha=255 preserve",
        mask_transport: threeImageBackground ? "three ordinary image uploads; no multipart mask field" : "OpenAI multipart mask field",
        semantic_guide: null,
        preservation_request: preservation?.requestPath || null,
        preservation_response: preservation?.responsePath || null,
        preservation_status: preservation?.status || null,
        preservation_hints: preservation?.hints || [],
        preservation_elapsed_ms: preservation?.elapsed_ms || null,
        controller_analysis: preservation?.status || "none",
        background_gemini_requests: preservation?.request_count || 0,
        reference_policy: threeImageBackground
          ? "Image 3 identifies retained components; Gemini inventory may add hints but cannot change deletion scope. The complete Sunburst response, aligned to the source canvas, becomes the next-loop input without local mask compositing or visual review."
          : options.svgGuide
            ? "Image 1 is the black-hole plate; Image 2 is the required residual SVG preview; native multipart mask controls edit boundary; the raw GPT Image 2.5 Sunburst max response is copied unchanged to background.png and is the next loop input"
            : "black-hole plate as the only image + native multipart mask; the raw GPT Image 2.5 Sunburst max response is copied unchanged to background.png and is the next loop input",
        canonical_output: threeImageBackground ? "background.png" : "background_model_raw.png",
        candidate_count: 1,
        selection_manifest: null,
        raw_output: "background_model_raw.png",
        next_loop_input: "background.png",
        protected_comparison: !threeImageBackground && options.protectOutsideMask !== false
          ? "background_protected.png" : null,
        prompt,
      },
      null,
      2,
    ),
  );
  const rawGenerated = path.join(loopDir, "background_model_raw.png");
  if (threeImageBackground) options.onFlatSegmentProgress?.({
    current: 0,
    total: 1,
    stage: "repair",
    preservation_status: preservation?.status || "none",
  });
  await retryJobOperation({ request_id: `loop_${options.loopNumber}_background_repair`, label: "背景补图", input: repairInput, timeout_ms: getRoute("background").timeout_ms }, () => imageEdit(repairSource, rawGenerated, prompt, backgroundModel, apiMask, signal, {
    provider: "openai", clientKind: "background-repair",
    imagePaths: imageInputs, quality: BACKGROUND_REPAIR_QUALITY,
    size: responseSize, preserveAspectRatio: true,
    nativeOutput: path.join(loopDir, "background_model_native.png"),
    responseMetadataPath: path.join(loopDir, "background_response.json"),
    timeoutMs:getRoute('background').timeout_ms,
    ...(threeImageBackground ? { maxAttempts: 1 } : {}),
  }));
  await fsp.copyFile(rawGenerated, output);
  if (threeImageBackground) options.onFlatSegmentProgress?.({
    current: 1, total: 1, stage: "repair",
    preservation_status: preservation?.status || "none",
  });
  if (!threeImageBackground && options.protectOutsideMask !== false) {
    const protectedOutput = path.join(loopDir, "background_protected.png");
    await applyGeneratedRegion(source, rawGenerated, alphaMask, protectedOutput, 1.5);
  }
  return output;
}

async function makeForegroundGuide(source, box, output) {
  const meta = await sharp(source).metadata();
  const [x, y, w, h] = box.bbox;
  const mask = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/></svg>`,
  );
  await sharp(source)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toFile(output);
  return output;
}

function extractionDescription(box) {
  if (box.category === "badge") {
    // Tiny badges are frequently mislabeled by the controller (for example,
    // a status glyph may be called a "sword badge" because it sits on the
    // sword card). Never feed that semantic guess back to the image model;
    // the bbox guide and the pixels inside it are authoritative.
    return [
      "tiny corner status marker only",
      "use only the visible pixels inside the bbox guide",
      "not the parent item artwork",
      "category=badge",
      box.role && `role=${box.role}`,
      box.reason,
      box.geometry_hints?.length
        ? `geometry hints=${JSON.stringify(box.geometry_hints[0])}`
        : "",
    ]
      .filter(Boolean)
      .join("; ")
      .replace(/\s+/g, " ")
      .slice(0, 900);
  }
  const parts = [
    box.label,
    box.category && `category=${box.category}`,
    box.role && `role=${box.role}`,
    box.reason,
    box.geometry_hints?.length ? `geometry hints=${JSON.stringify(box.geometry_hints[0])}` : "",
    box.parent_id && `parent=${box.parent_id}`,
    box.occludes?.length ? `covers=${box.occludes.join(",")}` : "",
    box.occluded_by?.length ? `behind=${box.occluded_by.join(",")}` : "",
  ].filter(Boolean);
  return parts.join("; ").replace(/\s+/g, " ").slice(0, 900) || box.id;
}

async function clipImageToBox(source, box, output) {
  const meta = await sharp(source).metadata();
  const [x, y, w, h] = box.bbox;
  const mask = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/></svg>`,
  );
  const clipped = await sharp(source)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  await sharp(clipped)
    .extract({ left: x, top: y, width: w, height: h })
    .png()
    .toFile(output);
  return output;
}

// Image models occasionally return the right object with a small translation
// or scale drift, even when the prompt and the transparent guide contain the
// correct original-canvas bbox.  Before the safety clip, normalize that
// foreground back to the controller bbox.  This keeps the PSD placement
// deterministic and prevents a valid object from becoming an empty crop when
// the model rendered it just outside the requested rectangle.
async function normalizeGeneratedForegroundToBox(source, box, output) {
  const meta = await sharp(source).metadata();
  const [targetX, targetY, targetW, targetH] = box.bbox;
  // Some providers (including Seedream 5.0 Pro) return opaque PNGs. There is
  // no meaningful alpha bbox to normalize in that case; keep the full-canvas
  // response and let the caller apply the controller-bbox safety clip or a
  // local matte generated from the crop.
  if (!meta.hasAlpha)
    return { path: source, aligned: false, alpha_bbox: null, opaque: true };
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaChannel = info.channels - 1;
  const threshold = 8;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + alphaChannel] <= threshold)
        continue;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!count) return { path: source, aligned: false, alpha_bbox: null };
  const alphaBox = [minX, minY, maxX + 1 - minX, maxY + 1 - minY];
  const inside =
    minX >= targetX &&
    minY >= targetY &&
    maxX + 1 <= targetX + targetW &&
    maxY + 1 <= targetY + targetH;
  if (inside) return { path: source, aligned: false, alpha_bbox: alphaBox };

  const aligned = await sharp(source)
    .extract({ left: minX, top: minY, width: alphaBox[2], height: alphaBox[3] })
    .resize(targetW, targetH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: meta.width,
      height: meta.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: aligned, left: targetX, top: targetY }])
    .png()
    .toFile(output);
  return { path: output, aligned: true, alpha_bbox: alphaBox };
}

// Keep the source RGB pixels and borrow only the model's alpha matte. This is
// particularly important for 20-40px badges: an image model can identify the
// shape but cannot reliably reproduce the original pixel art at that scale.
async function preserveSourcePixelsWithAlpha(source, alphaSource, box, output) {
  const [x, y, width, height] = box.bbox;
  const sourcePixels = await sharp(source)
    .extract({ left: x, top: y, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaPixels = await sharp(alphaSource)
    .extract({ left: x, top: y, width, height })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const sourceOffset = i * sourcePixels.info.channels;
    const resultOffset = i * 4;
    result[resultOffset] = sourcePixels.data[sourceOffset];
    result[resultOffset + 1] = sourcePixels.data[sourceOffset + 1];
    result[resultOffset + 2] = sourcePixels.data[sourceOffset + 2];
    result[resultOffset + 3] = alphaPixels.data[i];
  }
  await sharp(result, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}

// Last-resort matte for a tiny corner marker when img2 clearly selected the
// large parent artwork. It uses the source crop itself, estimating the card
// colour from the crop border and retaining the most salient connected
// foreground component. It never changes source RGB values.
async function preserveSmallBadgeWithContrastMask(source, box, output) {
  const [x, y, width, height] = box.bbox;
  const pixels = await sharp(source)
    .extract({ left: x, top: y, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = pixels.info.channels;
  const distances = new Float32Array(width * height);
  const border = [];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (px <= 1 || py <= 1 || px >= width - 2 || py >= height - 2) {
        const offset = (py * width + px) * channels;
        border.push([
          pixels.data[offset],
          pixels.data[offset + 1],
          pixels.data[offset + 2],
        ]);
      }
    }
  }
  const median = (values) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] || 0;
  };
  const background = [
    median(border.map((v) => v[0])),
    median(border.map((v) => v[1])),
    median(border.map((v) => v[2])),
  ];
  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    const dr = pixels.data[offset] - background[0];
    const dg = pixels.data[offset + 1] - background[1];
    const db = pixels.data[offset + 2] - background[2];
    distances[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const sorted = Array.from(distances).sort((a, b) => a - b);
  const percentile = sorted[Math.floor(sorted.length * 0.7)] || 0;
  // The marker is often a light glyph on a coloured card. Using the 70th
  // percentile itself would keep only its brightest antialiasing pixels; cap
  // the adaptive threshold so the complete small glyph remains connected.
  const threshold = Math.max(24, Math.min(96, percentile * 0.45));
  const visited = new Uint8Array(width * height);
  const components = [];
  const neighbors = [-1, 0, 1];
  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const start = sy * width + sx;
      if (visited[start] || distances[start] <= threshold) continue;
      const queue = [start];
      visited[start] = 1;
      const points = [];
      while (queue.length) {
        const current = queue.pop();
        const cy = Math.floor(current / width);
        const cx = current - cy * width;
        points.push(current);
        for (const dy of neighbors) {
          for (const dx of neighbors) {
            if (!dx && !dy) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (!visited[next] && distances[next] > threshold) {
              visited[next] = 1;
              queue.push(next);
            }
          }
        }
      }
      components.push(points);
    }
  }
  components.sort((a, b) => b.length - a.length);
  const chosen = components[0] || [];
  if (chosen.length < Math.max(4, Math.floor(width * height * 0.01))) return null;
  const selected = new Uint8Array(width * height);
  chosen.forEach((i) => (selected[i] = 1));
  const result = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const sourceOffset = i * channels;
    const resultOffset = i * 4;
    result[resultOffset] = pixels.data[sourceOffset];
    result[resultOffset + 1] = pixels.data[sourceOffset + 1];
    result[resultOffset + 2] = pixels.data[sourceOffset + 2];
    result[resultOffset + 3] = selected[i]
      ? Math.max(96, Math.min(255, Math.round((distances[i] - threshold) * 10 + 96)))
      : 0;
  }
  await sharp(result, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(output);
  return output;
}

// Fast path selected by the bbox controller. FeyNobg receives the original
// bbox crop directly, so no Seedream request is made and no generated RGB can
// drift from the source artwork. This route is valid only for fully visible,
// separable silhouettes; Gemini records that decision as remove_by_matte.
async function extractForegroundWithFeynobg(source, box, loopDir, index, signal) {
  const [x, y, width, height] = box.bbox;
  const safeName = `${String(index).padStart(3, "0")}_${box.id}`;
  const sourceCropPath = path.join(loopDir, "crops", `${safeName}_source_crop.png`);
  const guidePath = path.join(loopDir, "crops", `${safeName}_bbox_guide.png`);
  const rawMattePath = path.join(loopDir, "cutouts", `${safeName}_feynobg.png`);
  const alphaPath = path.join(loopDir, "cutouts", `${safeName}_feynobg_alpha.png`);
  const cutoutPath = path.join(loopDir, "cutouts", `${safeName}.png`);
  const requestPath = path.join(loopDir, "cutouts", `${safeName}_feynobg_request.json`);
  await Promise.all([
    fsp.mkdir(path.dirname(sourceCropPath), { recursive: true }),
    fsp.mkdir(path.dirname(cutoutPath), { recursive: true }),
  ]);
  const sourceCrop = await sharp(source)
    .extract({ left: x, top: y, width, height })
    .ensureAlpha()
    .png()
    .toBuffer();
  await fsp.writeFile(sourceCropPath, sourceCrop);
  await makeForegroundGuide(source, box, guidePath);
  await fsp.writeFile(
    requestPath,
    JSON.stringify(
      {
        method: "direct source bbox -> FeyNobg",
        endpoint_configured: Boolean(String(process.env.FEYNOBG_ENDPOINT || "").trim()),
        bbox: box.bbox,
        id: box.id,
        label: box.label,
        remove_by_matte: box.remove_by_matte === true,
        matte_reason: box.matte_reason || "",
        seedream_skipped: true,
      },
      null,
      2,
    ),
  );
  const matte = await requestLocalMatteImage(sourceCrop, signal);
  if (!matte)
    throw new Error("FeyNobg direct route is unavailable or returned no image");
  const matteMeta = await sharp(matte).metadata();
  if (!matteMeta.width || !matteMeta.height || !matteMeta.hasAlpha)
    throw new Error("FeyNobg direct route returned an image without Alpha");
  await fsp.writeFile(rawMattePath, matte);
  const alpha = await sharp(matte)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  let alphaMax = 0;
  for (const value of alpha) alphaMax = Math.max(alphaMax, value);
  if (alphaMax <= 0)
    throw new Error(`FeyNobg returned an empty matte for ${box.id}`);
  const rgb = await sharp(sourceCrop)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const sourceOffset = pixel * rgb.info.channels;
    const targetOffset = pixel * 4;
    rgba[targetOffset] = rgb.data[sourceOffset];
    rgba[targetOffset + 1] = rgb.data[sourceOffset + 1];
    rgba[targetOffset + 2] = rgb.data[sourceOffset + 2];
    rgba[targetOffset + 3] = alpha[pixel];
  }
  await Promise.all([
    sharp(alpha, { raw: { width, height, channels: 1 } }).png().toFile(alphaPath),
    sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(cutoutPath),
  ]);
  return {
    id: box.id,
    name: box.label,
    category: box.category,
    description: extractionDescription(box),
    source_bbox: [...box.bbox],
    working_bbox: [...box.bbox],
    bbox: [...box.bbox],
    source: path.resolve(cutoutPath),
    raw_source: path.resolve(sourceCropPath),
    source_crop: path.resolve(sourceCropPath),
    matte_input: path.resolve(sourceCropPath),
    bbox_guide: path.resolve(guidePath),
    generated_source: null,
    model_generated_source: null,
    atlas_alpha: path.resolve(alphaPath),
    feynobg_alpha: path.resolve(rawMattePath),
    alpha_alignment: "direct_source_bbox_feynobg",
    parent_id: box.parent_id,
    occludes: box.occludes,
    occluded_by: box.occluded_by,
    confidence: box.confidence,
    extraction_model: "FeyNobg",
    foreground_model: "FeyNobg",
    matting_model: "FeyNobg",
    extraction_method: "direct-source-bbox-feynobg",
    alpha_mode: "direct_feynobg_alpha_source_rgb",
    remove_by_matte: true,
    matte_reason: box.matte_reason || "",
    auto_matte_routed: true,
    seedream_skipped: true,
    feynobg_used: true,
    use_model_output: false,
    crop_mode: "preserve_bbox_canvas",
  };
}

async function extractForegroundBox(source, box, loopDir, index, model, signal, options = {}) {
  const useModelRgb = options.useModelOutput === true;
  const useFeynobg = options.useFeynobg !== false;
  const [targetX, targetY, targetW, targetH] = box.bbox;
  const safeName = `${String(index).padStart(3, "0")}_${box.id}`;
  const raw = path.join(loopDir, "crops", `${safeName}_input.png`);
  const guide = path.join(loopDir, "crops", `${safeName}_bbox_guide.png`);
  const generated = path.join(loopDir, "cutouts", `${safeName}_generated.png`);
  const generatedModel = path.join(loopDir, "cutouts", `${safeName}_model.png`);
  const generatedAligned = path.join(loopDir, "cutouts", `${safeName}_aligned.png`);
  const cutout = path.join(loopDir, "cutouts", `${safeName}.png`);
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  await fsp.mkdir(path.dirname(generated), { recursive: true });
  await fsp.mkdir(path.dirname(cutout), { recursive: true });
  await fsp.copyFile(source, raw);
  await makeForegroundGuide(source, box, guide);
  const description = compactForegroundDescription(box);
  const targetPromptData = seedreamTargetPromptData(box, 0);
  const prompt = FOREGROUND_EXTRACTION_PROMPT
    .replace("[X, Y, WIDTH, HEIGHT]", `[${targetX}, ${targetY}, ${targetW}, ${targetH}]`)
    .replace("DESCRIPTION", description.replace(/"/g, '\\"'))
    .replace("CATEGORY", String(box.category || "other"))
    .replace("LOOP", String(box.loop || 1));
  const badgePrompt = box.category === "badge"
    ? "\nBadge override: extract only the tiny marker inside the bbox; never include or redraw its parent artwork."
    : "";
  const finalPrompt = `${prompt}${badgePrompt}${targetPromptData.negative_description
    ? `\n\n${targetPromptData.negative_description}`
    : ""}`;
  const imageModel = model || modelFor('foreground');
  const sourceMeta = await sharp(source).metadata();
  const outputSize = imageEditSizeFor(sourceMeta.width, sourceMeta.height);
  await fsp.writeFile(
    path.join(loopDir, "cutouts", `${safeName}_request.json`),
    JSON.stringify(
      {
        model: imageModel,
        quality: FOREGROUND_ATLAS_QUALITY,
        method: isVolcengineImageProvider(imageModel)
          ? "images.generations (Volcano Ark image edit)"
          : "images.edit",
        background: "transparent",
        size: outputSize,
        input_images: [path.resolve(source), path.resolve(guide)],
        bbox: [targetX, targetY, targetW, targetH],
        description,
        lower_bboxes: targetPromptData.lower_bboxes,
        positive_description: targetPromptData.positive_description,
        negative_description: targetPromptData.negative_description,
        use_model_output: useModelRgb,
        use_feynobg: useFeynobg,
        prompt: finalPrompt,
      },
      null,
      2,
    ),
  );
  await imageEdit(
    source,
    generated,
    finalPrompt,
    imageModel,
    undefined,
    signal,
    {
      imagePaths: [source, guide],
      provider: "openai",
      clientKind: "foreground-image",
      background: "transparent",
      inputFidelity: "high",
      quality: FOREGROUND_ATLAS_QUALITY,
      size: outputSize,
    },
  );
  // Keep the unmodified model response for debugging. The working generated
  // image may be alpha-matted/aligned to the controller bbox below.
  await fsp.copyFile(generated, generatedModel);
  let generatedForMatte = generated;
  let localMatteUsed = false;
  if (isVolcengineImageProvider(imageModel) && useFeynobg) {
    const localMatte = path.join(loopDir, "cutouts", `${safeName}_local_matte.png`);
    try {
      localMatteUsed = await localMatteToBox(generated, box, localMatte, signal);
      if (localMatteUsed) generatedForMatte = localMatte;
    } catch (error) {
      await fsp.writeFile(
        path.join(loopDir, "cutouts", `${safeName}_local_matte_error.txt`),
        String(error?.message || error),
        "utf8",
      ).catch(() => {});
      if (error?.feynobgUnavailable || signal?.aborted) throw error;
      throw feynobgUnavailable(error?.message || String(error));
    }
  }
  const normalized = await normalizeGeneratedForegroundToBox(
    generatedForMatte,
    box,
    generatedAligned,
  );
  const generatedForClip = normalized.path;
  // Keep the raw/model RGB response intact when FeyNobg supplied only an
  // alpha matte. For the legacy source-RGB mode, the normalized matte remains
  // the clipping source; for direct model RGB mode, generated stays the RGB
  // source and generatedForClip contributes only its alpha channel.
  if (normalized.aligned && !localMatteUsed) await fsp.copyFile(generatedForClip, generated);
  // The model owns the alpha matte, while this hard clip is a safety boundary:
  // an unrelated object can never escape the controller-confirmed bbox. The
  // local crop keeps PSD placement exact (left/top remain the original bbox).
  const alphaPixels = await sharp(generatedForClip)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let alphaMin = 255;
  let alphaMax = 0;
  for (let i = alphaPixels.info.channels - 1; i < alphaPixels.data.length; i += alphaPixels.info.channels) {
    alphaMin = Math.min(alphaMin, alphaPixels.data[i]);
    alphaMax = Math.max(alphaMax, alphaPixels.data[i]);
  }
  if (alphaMax <= 0)
    throw new Error(`${imageModel} returned an empty transparent foreground for ${box.id}`);
  const coversCanvas = targetX === 0 && targetY === 0 && targetW === sourceMeta.width && targetH === sourceMeta.height;
  if (
    alphaMin >= 255 &&
    !coversCanvas &&
    !isVolcengineImageProvider(imageModel) &&
    process.env.LAYERFORGE_ALLOW_OPAQUE_FOREGROUND !== "1"
  ) {
    throw new Error(
      `${imageModel} returned an opaque foreground; transparent PNG output is required for bbox extraction. ` +
      "Use a transparent-capable image model (or set LAYERFORGE_ALLOW_OPAQUE_FOREGROUND=1 only for debugging).",
    );
  }
  const modelAlphaBox = normalized.alpha_bbox;
  const targetArea = Math.max(1, targetW * targetH);
  const modelAlphaArea = modelAlphaBox
    ? Math.max(1, modelAlphaBox[2] * modelAlphaBox[3])
    : 0;
  const modelLooksLikeParent =
    box.category === "badge" && modelAlphaArea > targetArea * 3;
  let alphaMode = alphaMin < 255
    ? "model_alpha_plus_bbox_clip"
    : isVolcengineImageProvider(imageModel)
      ? (localMatteUsed ? "local_feynobg_alpha_plus_bbox_clip" : "volc_opaque_bbox_clip")
      : "bbox_clip_fallback";
  if (useModelRgb) {
    // Direct mode keeps the image model's pixels and borrows only the selected
    // alpha channel (model alpha, inferred bbox alpha, or FeyNobg alpha).
    // This is deliberately before the badge/tiny-object source-pixel rules so
    // the UI switch has one unambiguous meaning for every bbox.
    await preserveSourcePixelsWithAlpha(generated, generatedForClip, box, cutout);
    alphaMode = localMatteUsed
      ? "model_rgb_plus_feynobg_alpha"
      : alphaMin < 255
        ? "model_rgb_plus_model_alpha"
        : "model_rgb_plus_bbox_clip";
  } else if (box.category === "badge") {
    // Preserve the original tiny artwork and use img2 only as a matte. If the
    // matte clearly covers a parent item, or simply because the target is
    // smaller than reliable image-model reproduction, derive a local
    // contrast matte from the source crop. This keeps all original badge
    // pixels and never lets a parent item leak into the layer.
    const contrast = await preserveSmallBadgeWithContrastMask(source, box, cutout);
    if (contrast) {
      alphaMode = modelLooksLikeParent
        ? "source_rgb_plus_contrast_mask_parent_rejected"
        : "source_rgb_plus_contrast_mask";
    } else {
      await preserveSourcePixelsWithAlpha(source, generatedForClip, box, cutout);
      alphaMode = modelLooksLikeParent
        ? "source_rgb_plus_model_alpha_parent_fallback"
        : "source_rgb_plus_model_alpha";
    }
  } else if (targetW <= 64 && targetH <= 64) {
    // Other tiny controls still use the model matte, but source RGB remains
    // unchanged so a small anti-aliased icon is not redrawn.
    await preserveSourcePixelsWithAlpha(source, generatedForClip, box, cutout);
    alphaMode = "source_rgb_plus_model_alpha";
  } else {
    await clipImageToBox(generatedForClip, box, cutout);
  }
  const clippedPixels = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clippedAlphaMax = 0;
  for (let i = clippedPixels.info.channels - 1; i < clippedPixels.data.length; i += clippedPixels.info.channels)
    clippedAlphaMax = Math.max(clippedAlphaMax, clippedPixels.data[i]);
  if (clippedAlphaMax <= 0)
    throw new Error(`${imageModel} returned no pixels inside bbox for ${box.id}`);
  const m = await sharp(cutout).metadata();
  return {
    id: box.id,
    name: box.label,
    category: box.category,
    description,
    source_bbox: [targetX, targetY, targetW, targetH],
    working_bbox: [targetX, targetY, targetW, targetH],
    bbox: [targetX, targetY, m.width, m.height],
    source: path.resolve(cutout),
    raw_source: path.resolve(raw),
    bbox_guide: path.resolve(guide),
    generated_source: path.resolve(generated),
    model_generated_source: path.resolve(generatedModel),
    alpha_alignment: normalized.aligned
      ? "model_alpha_bbox_fit_to_controller_bbox"
      : "none",
    parent_id: box.parent_id,
    occludes: box.occludes,
    occluded_by: box.occluded_by,
    confidence: box.confidence,
    extraction_model: imageModel,
    foreground_model: imageModel,
    matting_model: imageModel,
    extraction_method: `${imageModel}-bbox-description`,
    alpha_mode: alphaMode,
    use_model_output: useModelRgb,
    feynobg_used: localMatteUsed,
    crop_mode: "preserve_bbox_canvas",
  };
}
function depthGroups(detection, minArea) {
  const boxes = Object.fromEntries(
    detection.boxes
      .filter(
        (b) =>
          b.visible !== false &&
          FOREGROUND.has(b.category) &&
          b.bbox[2] * b.bbox[3] >= minArea,
      )
      .map((b) => [b.id, b]),
  );
  const order = [
    ...(detection.occlusion_tree.front_to_back || []).filter((id) => boxes[id]),
    ...Object.keys(boxes).filter(
      (id) => !(detection.occlusion_tree.front_to_back || []).includes(id),
    ),
  ];
  const depth = {};
  for (const id of order) {
    const b = boxes[id];
    depth[id] = Math.max(
      0,
      ...b.occluded_by.filter((x) => boxes[x]).map((x) => (depth[x] ?? 0) + 1),
    );
  }
  return [...new Set(Object.values(depth))]
    .sort((a, b) => a - b)
    .map((d) => ({
      depth: d,
      ids: order.filter((id) => depth[id] === d),
      boxes: order.filter((id) => depth[id] === d).map((id) => boxes[id]),
    }));
}
function bottomUpDepthMap(boxes) {
  const byId = Object.fromEntries(boxes.map((box) => [box.id, box]));
  const memo = new Map();
  const visit = (box, stack = new Set()) => {
    if (!box) return 0;
    if (memo.has(box.id)) return memo.get(box.id);
    if (stack.has(box.id)) return 0;
    const next = new Set(stack);
    next.add(box.id);
    const depth = (box.occluded_by || [])
      .map((id) => visit(byId[id], next) + 1)
      .reduce((max, value) => Math.max(max, value), 0);
    memo.set(box.id, depth);
    return depth;
  };
  return Object.fromEntries(boxes.map((box) => [box.id, visit(box)]));
}
function selectDeepestOccludedBoxes(detection, minArea = 0, excludedIds = new Set()) {
  const boxes = (detection?.boxes || []).filter(
    (box) =>
      !excludedIds.has(box.id) &&
      box.visible !== false &&
      FOREGROUND.has(box.category) &&
      bboxArea(box) >= minArea &&
      Array.isArray(box.occluded_by) &&
      box.occluded_by.length > 0,
  );
  if (!boxes.length) return { boxes: [], depths: {}, deepest: null };
  const depths = bottomUpDepthMap(detection.boxes || []);
  const deepest = Math.max(...boxes.map((box) => depths[box.id] || 0));
  return {
    boxes: boxes.filter((box) => (depths[box.id] || 0) === deepest),
    depths,
    deepest,
  };
}
function mergeBottomUpBoxes(canonical, boxes, loopNumber) {
  const mapped = new Map();
  const usedExisting = new Set();
  const nextId = (rawId, index) => {
    const base = `bu_l${String(loopNumber).padStart(2, "0")}_${safeId(rawId, `box_${index + 1}`)}`;
    let id = base;
    let suffix = 2;
    while (canonical.has(id)) id = `${base}_${suffix++}`;
    return id;
  };
  const findMatch = (box) => {
    let best = null;
    let bestScore = 0;
    for (const existing of canonical.values()) {
      if (usedExisting.has(existing.id) || existing.category !== box.category)
        continue;
      const overlap = bboxOverlap(existing, box);
      const sameLabel = String(existing.label || "").toLowerCase() === String(box.label || "").toLowerCase();
      const score = overlap.iou + (sameLabel ? 0.2 : 0);
      if (overlap.iou >= 0.45 || (sameLabel && overlap.containment >= 0.55)) {
        if (score > bestScore) {
          best = existing;
          bestScore = score;
        }
      }
    }
    return best;
  };
  const provisional = boxes.map((box, index) => {
    const existing = findMatch(box);
    const id = existing?.id || nextId(box.id, index);
    if (existing) usedExisting.add(existing.id);
    mapped.set(String(box.id), id);
    return { ...box, id, _existing: existing };
  });
  const resolve = (id) => mapped.get(String(id)) || (canonical.has(String(id)) ? String(id) : null);
  const result = provisional.map((box) => {
    const existing = box._existing;
    const [bx, by, bw, bh] = box.bbox;
    const bbox = existing
      ? [
          Math.min(existing.bbox[0], bx),
          Math.min(existing.bbox[1], by),
          Math.max(existing.bbox[0] + existing.bbox[2], bx + bw) - Math.min(existing.bbox[0], bx),
          Math.max(existing.bbox[1] + existing.bbox[3], by + bh) - Math.min(existing.bbox[1], by),
        ]
      : [...box.bbox];
    const merged = {
      ...box,
      bbox,
      parent_id: box.parent_id ? resolve(box.parent_id) : null,
      occludes: [...new Set((box.occludes || []).map(resolve).filter(Boolean))],
      occluded_by: [...new Set((box.occluded_by || []).map(resolve).filter(Boolean))],
    };
    delete merged._existing;
    canonical.set(merged.id, merged);
    return merged;
  });
  return { boxes: result, idMap: mapped };
}
async function composite(background, layers, output, width, height) {
  const inputs = [];
  const depthOf = (layer) => Number.isFinite(Number(layer?.depth)) ? Number(layer.depth) : -1;
  for (const layer of [...layers].sort((a, b) => depthOf(b) - depthOf(a))) {
    if (layer?.source && fs.existsSync(layer.source))
      inputs.push({
        input: await sharp(layer.source).png().toBuffer(),
        left: layer.bbox[0],
        top: layer.bbox[1],
      });
  }
  await sharp(background)
    .composite(inputs)
    .resize(width, height, { fit: "fill" })
    .png()
    .toFile(output);
  return output;
}

// In the PSD files produced by this ag-psd writer, Photoshop exposes root
// layer records in reverse of the supplied `children` array. Supply the array
// bottom-to-top: the opaque repaired background first and the frontmost layer
// last. The controller's front_to_back list wins for overlapping foreground
// layers; z-index is the deterministic fallback for the rest.
function psdChildrenOrder(plan) {
  const layers = [
    ...(Array.isArray(plan?.layers) ? plan.layers : []),
    ...(Array.isArray(plan?.text_layers) ? plan.text_layers : []),
  ];
  const frontToBack = Array.isArray(plan?.detection?.occlusion_tree?.front_to_back)
    ? plan.detection.occlusion_tree.front_to_back.map(String)
    : [];
  const rank = new Map(frontToBack.map((id, index) => [id, index]));
  const isBackground = (layer) =>
    layer?.kind === "background" ||
    layer?.role === "background_inpaint" ||
    String(layer?.id || "") === "background_final";
  const foreground = layers.filter((layer) => !isBackground(layer));
  const backgrounds = layers.filter(isBackground);
  const compareForegroundBackToFront = (a, b) => {
    const ar = rank.get(String(a.id));
    const br = rank.get(String(b.id));
    if (ar !== undefined || br !== undefined) {
      if (ar === undefined) return -1;
      if (br === undefined) return 1;
      if (ar !== br) return br - ar;
    }
    const z = Number(a.z_index || 0) - Number(b.z_index || 0);
    if (z) return z;
    return String(a.id || a.name || "").localeCompare(String(b.id || b.name || ""));
  };
  // Background records must be written first so Photoshop displays them at
  // the bottom of the layer panel and no opaque background covers foreground.
  backgrounds.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  return [...backgrounds, ...foreground.sort(compareForegroundBackToFront)];
}

function escapeXmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function containsCjkText(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(value || ""));
}

function containsJapaneseText(value) {
  return /[\u3040-\u30ff]/u.test(String(value || ""));
}

function textFontName(value, text = "") {
  const candidate = String(value || "").replace(/["']/g, "").split(",")[0].trim();
  const lower = candidate.toLowerCase().replace(/[\s_-]+/g, "");
  // Photoshop cannot render Han glyphs with Arial/Helvetica/Myriad or an
  // unavailable web font. These are the standard PostScript family names
  // confirmed on the Windows deployment host.
  if (containsCjkText(text)) {
    if (/^(simsun|nsimsun|songti|宋体|宋體)$/.test(lower)) return "SimSun";
    if (/^(simhei|heiti|黑体|黑體)$/.test(lower)) return "SimHei";
    if (/^(fangsong|仿宋)$/.test(lower)) return "FangSong";
    if (/^(kaiti|楷体|楷體)$/.test(lower)) return "KaiTi";
    if (/^(malgungothic|msgothic|mingliu|pmingliu)$/.test(lower)) return candidate;
    return "SimSun";
  }
  if (containsJapaneseText(text) && /^(arial|arialmt|helvetica|myriadpro|sans-serif|serif)$/.test(lower))
    return "MS-Gothic";
  return candidate || "ArialMT";
}

function textColorValue(value) {
  if (value && typeof value === "object" && ["r", "g", "b"].every((key) => value[key] !== undefined))
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(value.r) || 0))),
      g: Math.max(0, Math.min(255, Math.round(Number(value.g) || 0))),
      b: Math.max(0, Math.min(255, Math.round(Number(value.b) || 0))),
    };
  return { r: 255, g: 255, b: 255 };
}

function textColorHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.max(0, Math.min(255, Number(channel) || 0)).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function buildEditableTextLayers(textDetection, outputDir, width, height) {
  const boxes = Array.isArray(textDetection?.boxes)
    ? textDetection.boxes.filter((box) => box?.category === "text" && box.visible !== false)
    : [];
  const textDir = path.join(outputDir, "text_layers");
  await fsp.mkdir(textDir, { recursive: true });
  const layers = [];
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const [rawX, rawY, rawW, rawH] = Array.isArray(box.b) ? box.b : box.bbox || [];
    const x = Math.max(0, Math.min(Math.round(Number(rawX) || 0), Math.max(0, width - 1)));
    const y = Math.max(0, Math.min(Math.round(Number(rawY) || 0), Math.max(0, height - 1)));
    const w = Math.max(1, Math.min(Math.round(Number(rawW) || 1), width - x));
    const h = Math.max(1, Math.min(Math.round(Number(rawH) || 1), height - y));
    const content = String(box.text_content || box.label || "").trim();
    if (!content) continue;
    const color = textColorValue(box.text_fill_color);
    const fontName = textFontName(box.text_font_family, content);
    const requestedSize = Number(box.text_font_size);
    const fontSize = Math.max(6, Math.min(
      Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : h * 1.2,
      Math.max(6, h * 1.6),
    ));
    const align = ["left", "center", "right"].includes(box.text_align) ? box.text_align : "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const anchorX = align === "center" ? w / 2 : align === "right" ? w : 0;
    const lines = content.split(/\r?\n/);
    const lineHeight = Math.max(fontSize * 1.15, 8);
    const svgText = lines.map((line, lineIndex) =>
      `<tspan x="${anchorX}" dy="${lineIndex ? lineHeight : 0}">${escapeXmlText(line)}</tspan>`,
    ).join("");
    const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><text x="${anchorX}" y="${Math.min(h, Math.max(fontSize, fontSize * 0.9))}" text-anchor="${anchor}" font-family="${escapeXmlText(fontName)}" font-size="${fontSize}" font-weight="${box.text_bold ? "700" : "400"}" font-style="${box.text_italic ? "italic" : "normal"}" fill="${textColorHex(color)}">${svgText}</text></svg>`;
    const id = safeId(box.id || `text_${index + 1}`, `text_${index + 1}`);
    const previewPath = path.join(textDir, `${String(index + 1).padStart(3, "0")}_${id}.png`);
    await sharp(Buffer.from(previewSvg)).png().toFile(previewPath);
    const name = content.length > 48 ? `${content.slice(0, 45)}...` : content;
    layers.push({
      id,
      name: `Text: ${name}`,
      kind: "text",
      role: "text_editable",
      source: previewPath,
      bbox: [x, y, w, h],
      depth: -1,
      z_index: 200000 + index,
      opacity: 1,
      text_content: content,
      text_font_family: fontName,
      text_font_requested: box.text_font_family || null,
      text_font_fallback: fontName !== textFontName(box.text_font_family, "") ? "cjk-capable-system-font" : null,
      text_font_size: fontSize,
      text_fill_color: color,
      text_bold: box.text_bold === true,
      text_italic: box.text_italic === true,
      text_align: align,
      text: {
        // Point text stores its document position in the transform. Keep
        // these bounds local to the text frame, matching Photoshop's own
        // TySh records; duplicating absolute canvas coordinates here makes
        // Photoshop treat the layer as stale and ask to rasterize it.
        text: content,
        transform: [1, 0, 0, 1, x, y + fontSize],
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        shapeType: "point",
        pointBase: [0, 0],
        style: {
          font: { name: fontName },
          fontSize,
          fillColor: color,
          fauxBold: box.text_bold === true,
          fauxItalic: box.text_italic === true,
        },
        paragraphStyle: { justification: align },
      },
    });
  }
  return layers;
}

async function imageDataFromFile(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  const metadata = await sharp(file).metadata();
  if (!metadata.width || !metadata.height) return undefined;
  const raw = await sharp(file).ensureAlpha().raw().toBuffer();
  return {
    width: metadata.width,
    height: metadata.height,
    data: new Uint8Array(raw),
  };
}

async function exportPsd(plan, output, compositePath = null) {
  const exportPlan = Array.isArray(plan?.text_layers)
    ? plan
    : {
        ...plan,
        text_layers: await buildEditableTextLayers(
          plan?.text_detection || plan?.detection,
          path.dirname(output),
          plan?.canvas?.width,
          plan?.canvas?.height,
        ),
      };
  const children = [];
  for (const layer of psdChildrenOrder(exportPlan)) {
    if (layer?.kind === "text" || layer?.text) {
      // Keep the text bounds alongside the transform so Photoshop opens the
      // cached preview and the editable text in the same position.
      children.push({
        name: layer.name || layer.id,
        left: layer.bbox?.[0] || 0,
        top: layer.bbox?.[1] || 0,
        right: (layer.bbox?.[0] || 0) + (layer.bbox?.[2] || 0),
        bottom: (layer.bbox?.[1] || 0) + (layer.bbox?.[3] || 0),
        // Keep a rendered cache for Photoshop's initial composite while the
        // TySh record remains the source of truth for editing.
        imageData: await imageDataFromFile(layer.source),
        text: layer.text,
        opacity: layer.opacity ?? 1,
      });
      continue;
    }
    if (!layer?.source || !fs.existsSync(layer.source)) continue;
    children.push({
      name: layer.name || layer.id,
      left: layer.bbox?.[0] || 0,
      top: layer.bbox?.[1] || 0,
      imageData: await imageDataFromFile(layer.source),
      opacity: layer.opacity ?? 1,
    });
  }
  const buffer = writePsdBuffer({
    width: exportPlan.canvas.width,
    height: exportPlan.canvas.height,
    // Photoshop can preserve the layer records without this field, but a
    // complete composite prevents its compatibility-recovery dialog when
    // opening a freshly generated document.
    imageData: await imageDataFromFile(compositePath),
    children,
  });
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, buffer);
  return output;
}
async function runLayeredSplitLegacy({
  source,
  outputDir,
  maxDepth = 0,
  bboxMode = "gpt_direct",
  bboxOnly = false,
  controllerModel = DEFAULT_BBOX_CONTROLLER_MODEL,
  bboxRoi = true,
  imageModel = DEFAULT_IMAGE_MODEL,
  minArea = 500,
  psd,
  shouldStop = () => false,
  onProgress = () => {},
  signal,
}) {
  controllerModel = normalizeControllerModel(controllerModel);
  const report = (update) => {
    const normalized = { ...update };
    for (const key of ["title", "description"]) {
      if (typeof normalized[key] === "string")
        normalized[key] = normalized[key].replaceAll("gpt-5.6-sol", controllerModel);
    }
    onProgress({ at: new Date().toISOString(), ...normalized });
  };
  const imageAssets = (items) =>
    items
      .filter(([file]) => fs.existsSync(file))
      .map(([file, label, role]) => asset(file, label, role));
  const checkStop = () => {
    if (shouldStop()) throw new Error("JOB_STOPPED");
  };
  checkStop();
  await fsp.mkdir(outputDir, { recursive: true });
  const sourceAbs = path.resolve(source);
  const meta = await sharp(sourceAbs).metadata();
  const candidate = path.join(outputDir, "bbox_candidate.png");
  const review = path.join(outputDir, "bbox_review.png");
  const detectionPath = path.join(outputDir, "detection.json");
  const useImg2Candidate = bboxMode === "img2_assisted";
  if (useImg2Candidate) {
    report({
      id: "bbox_candidate",
      order: 1,
      status: "running",
      title: "Seedream 5.0 Pro 生成 bbox 候选图",
      description: "在原图上标出可拆分元素，再交给 gpt-5.6-sol 校对。",
    });
    await generateCandidate(sourceAbs, candidate, imageModel, signal);
    report({
      id: "bbox_candidate",
      order: 1,
      status: "completed",
      title: "Seedream 5.0 Pro 生成 bbox 候选图",
      description: "候选红框图已生成。",
      assets: imageAssets([[candidate, "bbox 候选红框图", "proposal"]]),
    });
    checkStop();
  }
  const bboxModelSource = path.join(outputDir, "bbox_model_source.jpg");
  const bboxModelCandidate = useImg2Candidate
    ? path.join(outputDir, "bbox_model_candidate.jpg")
    : null;
  const bboxRequestLog = path.join(outputDir, "bbox_request.json");
  const bboxVisionSource = await prepareBboxVisionImage(
    sourceAbs,
    bboxModelSource,
  );
  if (useImg2Candidate)
    await prepareBboxVisionImage(candidate, bboxModelCandidate);
  const bboxModelAssets = [
    [bboxModelSource, "bbox model input", "model_input"],
    ...(bboxModelCandidate
      ? [[bboxModelCandidate, "bbox proposal model input", "model_input"]]
      : []),
  ];
  const bboxOrder = useImg2Candidate ? 2 : 1;
  report({
    id: "bbox_tree",
    order: bboxOrder,
    status: "running",
    assets: imageAssets(bboxModelAssets),
    input_canvas: {
      width: bboxVisionSource.width,
      height: bboxVisionSource.height,
    },
    original_canvas: { width: meta.width, height: meta.height },
    input_bytes: bboxVisionSource.bytes,
    title: useImg2Candidate
      ? "gpt-5.6-sol 校对 bbox 和遮挡树"
      : "gpt-5.6-sol 直接分析 bbox 和遮挡树",
    description: useImg2Candidate
      ? "对照原图校正候选框，识别完整元素及遮挡关系。"
      : "直接分析原图；父级面板按完整外轮廓输出，不受子元素遮挡影响。",
  });
  let detection;
  if (bboxRoi) {
    detection = await analyzeBboxesBatched(
      sourceAbs,
      controllerModel,
      1,
      signal,
      {
        sourceInput: bboxModelSource,
        candidateInput: useImg2Candidate ? bboxModelCandidate : null,
        candidateSource: useImg2Candidate ? candidate : null,
        bboxMode: useImg2Candidate ? "img2_assisted" : "gpt_direct",
        batchDir: path.join(outputDir, "bbox_batches"),
        requestLog: bboxRequestLog,
        onProgress: ({ current, total, spec, assets }) =>
          report({
            id: "bbox_tree",
            order: bboxOrder,
            status: "running",
            title: useImg2Candidate
              ? "gpt-5.6-sol batched bbox correction"
              : "gpt-5.6-sol batched bbox analysis",
            description: `ROI batch ${Math.min(current + 1, total)}/${total}: ${spec.label}`,
            progress: { current, total },
            assets: imageAssets(
              assets.map((file) => [
                file,
                path.parse(file).name,
                "model_input",
              ]),
            ),
          }),
      },
    );
  } else {
    report({
      id: "bbox_tree",
      order: bboxOrder,
      status: "running",
      title: useImg2Candidate
        ? "gpt-5.6-sol single-image bbox correction"
        : "gpt-5.6-sol single-image bbox analysis",
      description: "Full analysis image in one request; ROI batching is disabled.",
      assets: imageAssets(bboxModelAssets),
    });
    detection = await analyzeBboxes(
      sourceAbs,
      useImg2Candidate ? candidate : null,
      controllerModel,
      1,
      signal,
      {
        source: bboxModelSource,
        candidate: useImg2Candidate ? bboxModelCandidate : null,
        compactResponse: true,
        // Keep the legacy full-image route compatible with LiteLLM/Azure.
        // `low` is supported by the deployment and avoids the unsupported
        // `none` value while retaining the larger full-image output budget.
        // The recursive pass only needs a short list of frontmost objects.
        // Keep GPT reasoning explicitly low so an upstream node cannot spend
        // the whole request budget on hidden reasoning before emitting JSON.
        reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
        // A single non-ROI image fits the context at high visual detail. This
        // retains the full-image request while giving the controller enough
        // pixels to trace panel/card boundaries and small icons accurately.
        imageDetail: "high",
        maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 8192 : null,
        requestLog: bboxRequestLog,
      },
    );
  }
  checkStop();
  await fsp.writeFile(detectionPath, JSON.stringify(detection, null, 2));
  const reviewAll = path.join(outputDir, "bbox_review_all.png");
  // Keep a labelled all-box overlay for auditing, but make the default review
  // readable: text is metadata and its many tiny labels otherwise hide the
  // actual image-layer geometry. Depth colours expose front/back groups.
  await Promise.all([
    drawReview(sourceAbs, detection, review, {
      includeText: false,
      showLabels: false,
      colorByDepth: true,
    }),
    drawReview(sourceAbs, detection, reviewAll, {
      includeText: true,
      showLabels: true,
      colorByDepth: false,
    }),
  ]);
  const groups = depthGroups(detection, minArea);
  const selectedGroups = maxDepth > 0 ? groups.slice(0, maxDepth) : groups;
  report({
    id: "bbox_tree",
    order: bboxOrder,
    status: "completed",
    title: useImg2Candidate
      ? "gpt-5.6-sol 校对 bbox 和遮挡树"
      : "gpt-5.6-sol 直接分析 bbox 和遮挡树",
    description: `分析完成：${detection.boxes.length} 个 bbox，${groups.length} 个遮挡深度组${bboxOnly ? "；本次仅审阅 bbox，不继续抠图" : `，本次处理 ${selectedGroups.length} 组`}。`,
    assets: imageAssets([[review, "bbox 校对结果", "review"]]),
    description: detection.batch_summary
      ? `分批分析完成：原始 ${detection.batch_summary.raw_boxes} 个，去重 ${detection.batch_summary.duplicates_removed} 个，最终 ${detection.boxes.length} 个 bbox；${groups.length} 个遮挡深度组。`
      : `分析完成：${detection.boxes.length} 个 bbox；${groups.length} 个遮挡深度组。`,
    assets: imageAssets([
      [review, "bbox review（仅图像元素，按深度着色）", "review"],
      [reviewAll, "bbox review（含文字完整审计）", "review-all"],
      ...bboxModelAssets,
      ...(detection.model_input?.batches || [])
        .filter((batch) => batch.id !== "overview")
        .map((batch) => [
          batch.preview_file,
          `${batch.id} ROI`,
          "model_input",
        ]),
    ]),
    detection,
    depth_groups: groups.map(({ depth, ids }) => ({ depth, ids })),
  });
  if (bboxOnly) {
    const plan = {
      project: path.parse(sourceAbs).name,
      source_image: sourceAbs,
      canvas: { width: meta.width, height: meta.height },
      layers: [],
      loops: [],
      detection,
      depth_groups: groups.map(({ depth, ids }) => ({ depth, ids })),
      max_depth: maxDepth,
      bbox_mode: detection.bbox_mode,
      bbox_controller_model: controllerModel,
      bbox_reasoning_effort: detection.bbox_reasoning_effort,
      bbox_roi: bboxRoi,
      bbox_only: true,
      shared_bbox_tree: true,
      source_image_excluded: true,
      text_excluded: true,
      matting_model: imageModel,
      extraction_model: imageModel,
      foreground_model: imageModel,
    };
    const planPath = path.join(outputDir, "recursive_layer_plan.json");
    await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
    return {
      plan: rel(planPath),
      psd: null,
      composite: null,
      loops: 0,
      layers: 0,
      stop: "bbox_only",
    };
  }
  // Text is the topmost metadata layer. Remove it once, before the first
  // recursive depth pass, and carry this clean plate through every later
  // loop. Re-running text removal after each inpaint pass makes the model
  // reinterpret already repaired pixels and is the source of cumulative
  // texture/pixel damage.
  const text = detection.boxes.filter(
    (b) => b.category === "text" && b.visible !== false,
  );
  const textCleanupDir = path.join(outputDir, "text_cleanup");
  await fsp.mkdir(textCleanupDir, { recursive: true });
  report({
    id: "text_cleanup",
    order: bboxOrder + 1,
    status: "running",
    title: "移除文字（仅执行一次）",
    description: text.length
      ? `使用 GPT Image 2.5 Sunburst max 清除 ${text.length} 个文字区域，并生成连续底图。`
      : "没有检测到文字区域，直接沿用原图。",
  });
  const initialClean = await removeText(
    sourceAbs,
    text,
    textCleanupDir,
    imageModel,
    signal,
  );
  report({
    id: "text_cleanup",
    order: bboxOrder + 1,
    status: "completed",
    title: "移除文字（仅执行一次）",
    description: text.length
      ? `${text.length} 个文字区域已清除，后续 loop 将复用这张底图。`
      : "没有文字区域，已复制原图作为后续底图。",
    assets: imageAssets([
      [path.join(textCleanupDir, "text_mask.png"), "文字区域遮罩", "mask"],
      [
        path.join(textCleanupDir, "text_inpaint_input.png"),
        "文字黑洞补图输入",
        "background-input",
      ],
      [
        path.join(textCleanupDir, "text_clean_generated.png"),
        "AI 去文字生成图",
        "text-clean-generated",
      ],
      [initialClean, "初始去文字底图（后续 loop 共用）", "text-clean"],
    ]),
  });
  let current = initialClean;
  const records = [];
  const allLayers = [];
  for (let groupIndex = 0; groupIndex < selectedGroups.length; groupIndex++) {
    const group = selectedGroups[groupIndex];
    checkStop();
    const orderBase = bboxOrder + 2 + groupIndex * 3;
    const loopLabel = `深度组 ${group.depth + 1}`;
    const loopDir = path.join(
      outputDir,
      `loop_${String(group.depth + 1).padStart(2, "0")}`,
    );
    await fsp.mkdir(loopDir, { recursive: true });
    // `current` already includes the one-time text cleanup (or the previous
    // loop's repaired background). There is deliberately no text-removal
    // request here.
    const clean = current;
    const layers = [];
    const matteAssets = [];
    report({
      id: `loop_${group.depth}_matte`,
      order: orderBase + 1,
      status: "running",
      title: `${loopLabel}：${imageModel} 描述抠图`,
      description: `按共享 bbox 处理本层 ${group.boxes.length} 个对象。`,
      progress: { current: 0, total: group.boxes.length },
      assets: [],
    });
    for (let i = 0; i < group.boxes.length; i++) {
      checkStop();
      const layer = await extractForegroundBox(clean, group.boxes[i], loopDir, i + 1, imageModel, signal);
      layer.depth = group.depth;
      layer.loop = group.depth + 1;
      layer.z_index = 100000 - group.depth * 100 + i;
      layers.push(layer);
      allLayers.push(layer);
      matteAssets.push(asset(layer.source, layer.name, "cutout"));
      report({
        id: `loop_${group.depth}_matte`,
        order: orderBase + 1,
        status: i + 1 === group.boxes.length ? "completed" : "running",
        title: `${loopLabel}：${imageModel} 描述抠图`,
        description: `已完成 ${i + 1}/${group.boxes.length}：${layer.name}`,
        progress: { current: i + 1, total: group.boxes.length },
        assets: [...matteAssets],
        cutouts: allLayers.length,
      });
    }
    report({
      id: `loop_${group.depth}_background`,
      order: orderBase + 2,
      status: "running",
      title: `${loopLabel}：GPT Image 2.5 Sunburst max 补全被挖空背景`,
      description: `使用 GPT Image 2.5 Sunburst max 按原生 mask 修补本层 ${group.boxes.length} 个黑洞区域，重建被遮挡背景。`,
    });
    const background = await makeBackground(
      clean,
      layers,
      loopDir,
      imageModel,
      signal,
    );
    report({
      id: `loop_${group.depth}_background`,
      order: orderBase + 2,
      status: "completed",
      title: `${loopLabel}：GPT Image 2.5 Sunburst max 补全被挖空背景`,
      description: `${loopLabel} 已处理完毕，背景将作为下一深度组的输入。`,
      assets: imageAssets([
        [path.join(loopDir, "background_mask.png"), "背景硬 mask（纯黑白）", "mask"],
        [path.join(loopDir, "background_mask_openai.png"), "GPT Image 2.5 Sunburst 原生 mask（含 alpha）", "mask-api"],
        [path.join(loopDir, "background_input.png"), "背景图输入（前景挖成黑洞）", "background-input"],
        [path.join(loopDir, "background_model_raw.png"), "GPT Image 2.5 Sunburst max 补图原始返回（保护前）", "background-generated"],
        [path.join(loopDir, "background_protected.png"), "Protected comparison only (not loop input)", "background-protected"],
        [background, "GPT Image 2.5 Sunburst max raw response copied unchanged (next loop input)", "background"],
      ]),
      loops: records.length + 1,
    });
    const pair = {
      loop: group.depth + 1,
      depth: group.depth,
      source: current,
      text_clean: clean,
      background,
      layers,
      bbox_ids: group.ids,
      selected: group.boxes,
      text,
      occlusion_tree: detection.occlusion_tree,
    };
    await fsp.writeFile(
      path.join(loopDir, "pair.json"),
      JSON.stringify(pair, null, 2),
    );
    await fsp.writeFile(
      path.join(loopDir, "detection.json"),
      JSON.stringify(
        {
          ...detection,
          selected_ids: group.ids,
          text_ids: text.map((b) => b.id),
        },
        null,
        2,
      ),
    );
    records.push(pair);
    current = background;
  }
  const finalBackground = current;
  const planLayers = [
    {
      id: "background_final",
      name: "Background (recursive final)",
      kind: "background",
      role: "background_inpaint",
      source: finalBackground,
      bbox: [0, 0, meta.width, meta.height],
      z_index: 0,
      opacity: 1,
    },
    ...allLayers.map((x) => ({
      ...x,
      kind: "foreground",
      role: "foreground_img2_cutout",
    })),
  ].sort((a, b) => a.z_index - b.z_index);
  const plan = {
    project: path.parse(sourceAbs).name,
    source_image: sourceAbs,
    canvas: { width: meta.width, height: meta.height },
    layers: planLayers,
    loops: records,
    detection,
    depth_groups: groups.map(({ depth, ids }) => ({ depth, ids })),
    max_depth: maxDepth,
    bbox_mode: detection.bbox_mode,
    bbox_controller_model: controllerModel,
    bbox_reasoning_effort: detection.bbox_reasoning_effort,
    bbox_roi: bboxRoi,
    bbox_only: false,
    shared_bbox_tree: true,
    source_image_excluded: true,
    text_excluded: true,
    matting_model: imageModel,
    extraction_model: imageModel,
    foreground_model: imageModel,
  };
  const planPath = path.join(outputDir, "recursive_layer_plan.json");
  await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  const exportOrder = bboxOrder + 2 + selectedGroups.length * 3;
  report({
    id: "export",
    order: exportOrder,
    status: "running",
    title: "合成预览并导出 PSD",
    description: `将最终背景和 ${allLayers.length} 个透明前景按 z-index 写入 PSD。`,
  });
  const compositePath = await composite(
    finalBackground,
    allLayers,
    path.join(outputDir, "composite.png"),
    meta.width,
    meta.height,
  );
  let psdPath = null;
  if (psd) psdPath = await exportPsd(plan, psd, compositePath);
  report({
    id: "export",
    order: exportOrder,
    status: "completed",
    title: "合成预览并导出 PSD",
    description: `处理完成：${records.length} 个深度组，${allLayers.length} 个前景图层。`,
    assets: imageAssets([[compositePath, "PSD 合成预览", "composite"]]),
    loops: records.length,
    cutouts: allLayers.length,
  });
  return {
    plan: rel(planPath),
    psd: psdPath ? rel(psdPath) : null,
    composite: rel(compositePath),
    loops: records.length,
    layers: allLayers.length,
    stop: maxDepth > 0 ? "max_depth" : "tree_consumed",
  };
}

async function runBottomUpRepairWorkflow({
  sourceAbs,
  sourceMeta,
  outputDir,
  textCleanImage,
  textDetection,
  text,
  maxDepth,
  minArea,
  controllerModel,
  imageModel,
  bboxPaddingPx = 3,
  useModelOutput = false,
  useFeynobg = true,
  matteRoutingMode = "force_model",
  geminiOriginalImage = true,
  bboxReview,
  psd,
  signal,
  report,
  imageAssets,
  checkStop,
}) {
  // Keep bottom-up compatibility metadata, but never perform a second bbox
  // review request in the raw-output workflow.
  bboxReview = false;
  bboxPaddingPx = clampBboxPadding(bboxPaddingPx, 3);
  useModelOutput = useModelOutput === true;
  matteRoutingMode = matteRoutingMode === "gemini_auto" && controllerModel === "gemini-3.8-flash"
    ? "gemini_auto"
    : "force_model";
  const allowGeminiMatteRouting = matteRoutingMode === "gemini_auto";
  useFeynobg = useFeynobg !== false;
  const useOriginalGeminiImage =
    controllerModel === "gemini-3.8-flash" && geminiOriginalImage;
  let current = textCleanImage;
  const records = [];
  const canonical = new Map();
  const processed = new Set();
  const maxLoops = maxDepth > 0 ? maxDepth : 64;
  let termination = "max_depth";

  for (let loopIndex = 0; loopIndex < maxLoops; loopIndex++) {
    checkStop();
    const loopNumber = loopIndex + 1;
    const loopDir = path.join(
      outputDir,
      `loop_${String(loopNumber).padStart(2, "0")}`,
    );
    await fsp.mkdir(loopDir, { recursive: true });
    const modelInputPath = path.join(loopDir, "bottom_up_model_source.jpg");
    const preview = await prepareBboxVisionImage(current, modelInputPath, {
      compress: !useOriginalGeminiImage,
    });
    const modelInput = preview.path;
    const detection = await retryJobOperation({ request_id: `bottom_up_${loopNumber}_bbox`, label: "从下往上 bbox 分析", input: current, timeout_ms: getRoute("controller").timeout_ms }, () => analyzeBboxes(
      current,
      null,
      controllerModel,
      loopNumber,
      signal,
      {
        source: modelInput,
        compactResponse: true,
        analysisPrompt: BOTTOM_UP_BBOX_PROMPT,
        reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
        imageDetail: "high",
        // Bottom-up discovery returns the shared visual tree (not just one
        // target), so give the compact wire format enough room for repeated
        // cards/icons without falling back to a truncated JSON document.
        maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 8192 : null,
        requestLog: path.join(loopDir, "bottom_up_bbox_request.json"),
      },
    ));
    const candidateBoxes = detection.boxes.filter(
      (box) =>
        box.visible !== false &&
        FOREGROUND.has(box.category) &&
        bboxArea(box) >= minArea,
    ).map((box) =>
      expandBboxForExtraction(box, bboxPaddingPx, sourceMeta.width, sourceMeta.height),
    );
    const mergedResult = mergeBottomUpBoxes(canonical, candidateBoxes, loopNumber);
    const workingDetection = {
      ...detection,
      boxes: mergedResult.boxes,
      occlusion_tree: detection.occlusion_tree,
    };
    let visualBoxes = workingDetection.boxes;
    const selectedInfo = selectDeepestOccludedBoxes(
      workingDetection,
      minArea,
      processed,
    );
    let selected = selectedInfo.boxes;
    const reviewImage = path.join(loopDir, "bottom_up_bbox_review.png");
    await drawReview(current, { ...workingDetection, boxes: visualBoxes }, reviewImage, {
      includeText: false,
      showLabels: true,
      colorByDepth: true,
    });
    const bboxAssets = [
      [current, "当前 loop 输入", "working-source"],
      [modelInput, "bottom-up 模型输入", "model_input"],
      [reviewImage, "bottom-up bbox 初检", "review"],
    ];
    let reviewedDetection = workingDetection;
    if (bboxReview && selected.length) {
      const sourceMeta = await sharp(current).metadata();
      const reviewHints = selected.map((box) => ({
        i: box.id,
        k: box.category,
        b: box.bbox,
        l: box.label,
        z: box.z_index,
        u: box.occluded_by,
      }));
      const reviewed = await retryJobOperation({ request_id: `bottom_up_${loopNumber}_bbox_review`, label: "从下往上 bbox 复核", input: current, timeout_ms: getRoute("controller").timeout_ms }, () => analyzeBboxes(
        current,
        null,
        controllerModel,
        loopNumber,
        signal,
        {
          source: modelInput,
          compactResponse: true,
          analysisPrompt: `${BOTTOM_UP_REVIEW_PROMPT}\nCandidates to review (attached-image pixels): ${JSON.stringify({ b: reviewHints })}`,
          reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
          imageDetail: "high",
          maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 3072 : null,
          requestLog: path.join(loopDir, "bottom_up_bbox_review_request.json"),
        },
      ));
      const reviewedBoxes = reviewed.boxes.filter(
        (box) => box.visible !== false && FOREGROUND.has(box.category),
      );
      if (reviewedBoxes.length) {
        const stable = stabilizeTopLayerReview(
          selected,
          reviewedBoxes,
          sourceMeta.width,
          sourceMeta.height,
        );
        const byId = new Map(stable.map((box) => [box.id, box]));
        selected = selected.map((box) => byId.get(box.id) || box);
        for (const box of selected) canonical.set(box.id, box);
        reviewedDetection = {
          ...workingDetection,
          boxes: workingDetection.boxes.map((box) => byId.get(box.id) || box),
        };
        visualBoxes = reviewedDetection.boxes.filter(
          (box) =>
            box.visible !== false &&
            FOREGROUND.has(box.category) &&
            bboxArea(box) >= minArea,
        );
        const consistencyPath = path.join(loopDir, "bottom_up_bbox_review_consistency.json");
        await fsp.writeFile(
          consistencyPath,
          JSON.stringify(
            {
              proposal_count: selected.length,
              reviewed_count: reviewedBoxes.length,
              final_count: stable.length,
              policy: "one-to-one candidate review; union bbox; no add/remove/merge/split",
              boxes: stable.map((box) => ({
                id: box.id,
                final_bbox: box.bbox,
                review_bbox: box.review_bbox || null,
                review_status: box.review_status || null,
              })),
            },
            null,
            2,
          ),
        );
        const correctedReview = path.join(loopDir, "bottom_up_bbox_corrected.png");
        await drawReview(current, { ...reviewedDetection, boxes: selected }, correctedReview, {
          includeText: false,
          showLabels: true,
          colorByDepth: true,
        });
        bboxAssets.push([correctedReview, "bottom-up bbox 复核结果", "review"]);
      }
    }
    await fsp.writeFile(
      path.join(loopDir, "bottom_up_detection.json"),
      JSON.stringify(
        {
          ...reviewedDetection,
          boxes: visualBoxes,
          selected_ids: selected.map((box) => box.id),
          selected_depth: selectedInfo.deepest,
          bbox_review_enabled: bboxReview,
          bbox_review_note: bboxReview
            ? "Bottom-up mode reviews only the selected deepest candidates; it never runs a second discovery pass."
            : "Bottom-up mode uses one full-image occlusion analysis per loop.",
          model_preview: preview,
        },
        null,
        2,
      ),
    );
    const bboxStepId = `bottom_up_loop_${loopNumber}_bbox`;
    report({
      id: bboxStepId,
      order: 3 + loopIndex * 3,
      status: selected.length ? "completed" : "completed",
      title: `Loop ${loopNumber}: ${controllerModel} bottom-up 遮挡分析`,
      description: selected.length
        ? `发现 ${visualBoxes.length} 个可见 bbox，最深被遮挡层为深度 ${selectedInfo.deepest}，本轮处理 ${selected.length} 个。`
        : "当前没有尚未处理的被遮挡 bbox，进入一次性 AI 描述抠图。",
      assets: imageAssets(bboxAssets),
      boxes: selected.length,
      detection: { ...reviewedDetection, boxes: visualBoxes },
      depth_groups: depthGroups({ ...detection, boxes: visualBoxes }, minArea).map(
        ({ depth, ids }) => ({ depth, ids }),
      ),
    });
    if (!selected.length) {
      termination = "no_occluded_boxes";
      break;
    }

    selected.forEach((box) => processed.add(box.id));
    const currentMeta = await sharp(current).metadata();
    const targetBboxes = selected.map((box) => box.bbox);
    const targetInfo = selected.map((box) => [
      box.id,
      box.bbox,
      compactPromptText([box.label || box.id, box.category].filter(Boolean).join("/"), 100),
      Array.isArray(box.occluded_by) ? box.occluded_by.map(String) : [],
    ]);
    const targetJson = JSON.stringify(targetInfo);
    const mask = await maskForBoxes(
      currentMeta.width,
      currentMeta.height,
      targetBboxes,
      path.join(loopDir, "bottom_up_target_mask.png"),
    );
    const aInput = path.join(loopDir, "bottom_up_a_input.png");
    const aGenerated = path.join(loopDir, "bottom_up_a_generated.png");
    const bInput = path.join(loopDir, "bottom_up_b_input.png");
    const bGenerated = path.join(loopDir, "bottom_up_b_generated.png");
    await makeBlackHolePlate(current, mask, aInput);
    report({
      id: `bottom_up_loop_${loopNumber}_repair_a`,
      order: 4 + loopIndex * 3,
      status: "running",
      title: `Loop ${loopNumber}: GPT Image 2.5 Sunburst max 生成 A 底图`,
      description: "根据最深 bbox 的文字描述和坐标，补齐被遮挡的底层元素；其他区域保持不变。",
      assets: imageAssets([
        [mask, "最深 bbox 补图遮罩", "mask"],
        [aInput, "A 底图黑洞输入", "background-input"],
      ]),
    });
    await retryJobOperation({ request_id: `bottom_up_${loopNumber}_repair_a`, label: "生成 A 底图", input: aInput, timeout_ms: getRoute("background").timeout_ms }, () => imageEdit(
      aInput,
      aGenerated,
      `${BOTTOM_UP_COMPLETE_PROMPT}\nTargets (JSON tuples [id,bbox,description,occluded_by]): ${targetJson}`,
      BACKGROUND_REPAIR_MODEL,
      mask,
      signal,
      {
        provider: "openai",
        clientKind: "background-repair",
        quality: BACKGROUND_REPAIR_QUALITY,
      },
    ));
    report({
      id: `bottom_up_loop_${loopNumber}_repair_a`,
      order: 4 + loopIndex * 3,
      status: "completed",
      title: `Loop ${loopNumber}: GPT Image 2.5 Sunburst max 生成 A 底图`,
      description: "A 底图已生成，保留原画布尺寸和目标元素位置。",
      assets: imageAssets([
        [mask, "最深 bbox 补图遮罩", "mask"],
        [aInput, "A 底图黑洞输入", "background-input"],
        [aGenerated, "A 底图（补齐后的深层元素）", "background-generated"],
      ]),
    });

    const nextMeta = await sharp(aGenerated).metadata();
    const bMask = await maskForBoxes(
      nextMeta.width,
      nextMeta.height,
      targetBboxes,
      path.join(loopDir, "bottom_up_remove_a_mask.png"),
    );
    await makeBlackHolePlate(aGenerated, bMask, bInput);
    report({
      id: `bottom_up_loop_${loopNumber}_repair_b`,
      order: 5 + loopIndex * 3,
      status: "running",
      title: `Loop ${loopNumber}: GPT Image 2.5 Sunburst max 生成 B 底图`,
      description: "移除 A 底图后，只补齐 A 底图下面的连续背景；B 作为下一 loop 输入。",
      assets: imageAssets([
        [aGenerated, "A 底图", "background-generated"],
        [bMask, "移除 A 的遮罩", "mask"],
        [bInput, "B 底图黑洞输入", "background-input"],
      ]),
    });
    await retryJobOperation({ request_id: `bottom_up_${loopNumber}_repair_b`, label: "生成 B 底图", input: bInput, timeout_ms: getRoute("background").timeout_ms }, () => imageEdit(
      bInput,
      bGenerated,
      `${BOTTOM_UP_REMOVE_PROMPT}\nRemoved targets (JSON tuples [id,bbox,description,occluded_by]): ${targetJson}`,
      BACKGROUND_REPAIR_MODEL,
      bMask,
      signal,
      {
        provider: "openai",
        clientKind: "background-repair",
        quality: BACKGROUND_REPAIR_QUALITY,
      },
    ));
    report({
      id: `bottom_up_loop_${loopNumber}_repair_b`,
      order: 5 + loopIndex * 3,
      status: "completed",
      title: `Loop ${loopNumber}: GPT Image 2.5 Sunburst max 生成 B 底图`,
      description: "B 底图已生成，将作为下一 loop 的输入。",
      assets: imageAssets([
        [aGenerated, "A 底图", "background-generated"],
        [bMask, "移除 A 的遮罩", "mask"],
        [bInput, "B 底图黑洞输入", "background-input"],
        [bGenerated, "B 底图（下一 loop 输入）", "background"],
      ]),
    });
    records.push({
      loop: loopNumber,
      input: current,
      bbox: selected,
      selected_ids: selected.map((box) => box.id),
      deepest: selectedInfo.deepest,
      a: aGenerated,
      b: bGenerated,
    });
    current = bGenerated;
  }

  const allVisual = [...canonical.values()];
  const finalMask = await maskForBoxes(
    sourceMeta.width,
    sourceMeta.height,
    allVisual.map((box) => box.bbox),
    path.join(outputDir, "bottom_up_final_mask.png"),
  );
  const finalInput = path.join(outputDir, "bottom_up_final_background_input.png");
  const finalBackground = path.join(outputDir, "bottom_up_final_background.png");
  await makeBlackHolePlate(current, finalMask, finalInput);
  const finalGptMask = path.join(outputDir, "bottom_up_final_gpt_mask.png");
  await makeOpenAiInpaintMask(finalMask, finalGptMask);
  report({
    id: "bottom_up_final_background",
    order: 6 + records.length * 3,
    status: "running",
    title: "GPT Image 2.5 Sunburst max 一次性生成最终底图",
    description: allVisual.length
      ? "所有 bbox 不再参与遮挡判断后，移除全部图层并生成连续最终背景。"
      : "没有可见图层需要从底图移除，直接沿用当前背景。",
    assets: imageAssets([
      [finalMask, "最终 bbox 遮罩", "mask"],
      [finalInput, "最终背景黑洞输入", "background-input"],
    ]),
  });
  if (allVisual.length) {
    const finalRepairSource = finalInput;
    const finalPrompt = BACKGROUND_PROMPT;
    await retryJobOperation({ request_id: "bottom_up_final_background", label: "最终背景补图", input: finalRepairSource, timeout_ms: getRoute("background").timeout_ms }, () => imageEdit(
      finalRepairSource,
      finalBackground,
      finalPrompt,
      BACKGROUND_REPAIR_MODEL,
      finalGptMask,
      signal,
      {
        provider: "openai",
        clientKind: "background-repair",
        imagePaths: [finalRepairSource],
        quality: BACKGROUND_REPAIR_QUALITY,
        timeoutMs:getRoute('background').timeout_ms,
      },
    ));
    await fsp.writeFile(
      path.join(outputDir, "bottom_up_final_background_request.json"),
      JSON.stringify({
        model: BACKGROUND_REPAIR_MODEL,
        quality: BACKGROUND_REPAIR_QUALITY,
        repair_mode: "gpt_image_2_5_sunburst_direct",
        input_image: finalRepairSource,
        mask: finalGptMask,
        prompt: finalPrompt,
      }, null, 2),
    );
  } else await fsp.copyFile(current, finalBackground);
  const finalBackgroundAssets = [];
  report({
    id: "bottom_up_final_background",
    order: 6 + records.length * 3,
    status: "completed",
    title: "GPT Image 2.5 Sunburst max 一次性生成最终底图",
    description: "最终底图已生成，下面只执行一次 AI 描述抠图。",
    assets: imageAssets([
      ...finalBackgroundAssets,
      [finalMask, "最终 bbox 遮罩", "mask"],
      [finalInput, "最终背景黑洞输入", "background-input"],
      [finalBackground, "最终连续底图", "background"],
    ]),
  });

  const allLayers = [];
  const matteDir = path.join(outputDir, "bottom_up_matte");
  const bottomDepths = bottomUpDepthMap(allVisual);
  const matteAssets = [];
  report({
    id: "bottom_up_matte",
    order: 7 + records.length * 3,
    status: "running",
    title: `${imageModel} 一次性抠出全部 bbox`,
    description: `bottom-up 补图完成，共处理 ${allVisual.length} 个视觉 bbox；现在统一抠图。`,
    progress: { current: 0, total: allVisual.length },
    assets: [],
  });
  for (let index = 0; index < allVisual.length; index++) {
    checkStop();
    const box = allVisual[index];
    const layer = await retryJobOperation({ request_id: `bottom_up_matte_${box.id}`, label: `前景抠取 ${box.id}`, input: textCleanImage, timeout_ms: getRoute("foreground").timeout_ms }, () => extractForegroundBox(
      textCleanImage,
      box,
      matteDir,
      index + 1,
      imageModel,
      signal,
      { useModelOutput, useFeynobg: allowGeminiMatteRouting && box.remove_by_matte === true },
    ));
    // The bottom-up detector's graph depth is back-to-front: a larger depth
    // is farther behind. Composite therefore consumes larger depths first,
    // while PSD z-index remains front-to-back (the inverse of graph depth).
    layer.depth = Number(bottomDepths[box.id]) || 0;
    layer.loop = records.length || 1;
    layer.z_index = 100000 - layer.depth * 100 - index;
    layer.extraction_route = "individual_image_model";
    allLayers.push(layer);
    matteAssets.push(asset(layer.source, layer.name, "cutout"));
    report({
      id: "bottom_up_matte",
      order: 7 + records.length * 3,
      status: index + 1 === allVisual.length ? "completed" : "running",
      title: `${imageModel} 一次性抠出全部 bbox`,
      description: `已完成 ${index + 1}/${allVisual.length}：${layer.name}`,
      progress: { current: index + 1, total: allVisual.length },
      assets: [...matteAssets],
      cutouts: allLayers.length,
    });
  }

  const bottomUpRouteSummary = {
    total_bbox_count: allLayers.length,
    // Bottom-up A/B repair always reconstructs each visual layer with the
    // image model; its optional FeyNobg call is an alpha post-pass, not a
    // direct source-crop route, and it never uses an Atlas request.
    feynobg_direct_bbox_count: 0,
    atlas_bbox_count: 0,
    individual_image_model_bbox_count: allLayers.length,
    feynobg_alpha_bbox_count: allLayers.filter((layer) => layer.feynobg_used === true).length,
    atlas_feynobg_alpha_bbox_count: 0,
    feynobg_direct_bbox_ids: [],
    atlas_bbox_ids: [],
    individual_image_model_bbox_ids: allLayers.map((layer) => String(layer.id)),
    per_loop: [],
  };
  report({
    id: "bottom_up_matte",
    order: 7 + records.length * 3,
    status: "completed",
    title: `${imageModel} bottom-up bbox extraction`,
    description:
      `Route result: FeyNobg direct 0; GPT Image 2.5 Flare max Atlas 0; individual GPT Image 2.5 Flare max ${bottomUpRouteSummary.individual_image_model_bbox_count}; ` +
      `FeyNobg alpha ${bottomUpRouteSummary.feynobg_alpha_bbox_count}`,
    progress: { current: allLayers.length, total: allVisual.length },
    assets: [...matteAssets],
    route_summary: bottomUpRouteSummary,
    cutouts: allLayers.length,
  });

  const aggregateBoxes = [...text, ...allVisual];
  const frontToBack = allLayers
    .slice()
    .sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0))
    .map((layer) => layer.id);
  const finalDetection = normalizeDetection(
    {
      canvas: { width: sourceMeta.width, height: sourceMeta.height },
      scene_summary: "Bottom-up occlusion repair",
      background_repair: {
        mode: "scene",
        reason: "bottom-up A/B image repair",
        refinement: "gpt_image_2_5_sunburst_direct",
      },
      boxes: aggregateBoxes,
      occlusion_tree: { front_to_back: frontToBack, roots: [] },
    },
    sourceMeta.width,
    sourceMeta.height,
  );
  finalDetection.loop = records.length;
  finalDetection.source = sourceAbs;
  finalDetection.bbox_mode = "bottom_up_repair";
  finalDetection.bbox_strategy = "deepest_occluded_a_then_b_then_one_time_matte";
  finalDetection.bbox_controller_model = controllerModel;
  finalDetection.bbox_padding_px = bboxPaddingPx;
  finalDetection.use_model_output = useModelOutput;
  finalDetection.use_feynobg = useFeynobg;
  finalDetection.auto_matte_routing = allowGeminiMatteRouting;
  finalDetection.matte_routing_mode = matteRoutingMode;
  finalDetection.feynobg_failure_policy = "abort_no_llm_fallback";
  finalDetection.bbox_review = bboxReview;
  finalDetection.text_detection = textDetection;
  finalDetection.bottom_up = true;
  finalDetection.bottom_up_processed_ids = [...processed];
  finalDetection.route_summary = bottomUpRouteSummary;
  const compositePath = await composite(
    finalBackground,
    allLayers,
    path.join(outputDir, "composite.png"),
    sourceMeta.width,
    sourceMeta.height,
  );
  const planLayers = [
    {
      id: "background_final",
      name: "Background (bottom-up final)",
      kind: "background",
      role: "background_inpaint",
      source: finalBackground,
      bbox: [0, 0, sourceMeta.width, sourceMeta.height],
      z_index: 0,
      opacity: 1,
    },
    ...allLayers.map((layer) => ({ ...layer, kind: "foreground", role: "foreground_img2_cutout" })),
  ].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  const plan = {
    project: path.parse(sourceAbs).name,
    source_image: sourceAbs,
    canvas: { width: sourceMeta.width, height: sourceMeta.height },
    layers: planLayers,
    loops: records,
    detection: finalDetection,
    text_detection: textDetection,
    depth_groups: records.map((record, index) => ({
      depth: index,
      ids: record.selected_ids,
    })),
    max_depth: maxDepth,
    bbox_mode: "bottom_up_repair",
    bbox_controller_model: controllerModel,
    bbox_review: bboxReview,
    bbox_padding_px: bboxPaddingPx,
    use_model_output: useModelOutput,
    use_feynobg: useFeynobg,
    auto_matte_routing: allowGeminiMatteRouting,
    matte_routing_mode: matteRoutingMode,
    feynobg_failure_policy: "abort_no_llm_fallback",
    route_summary: bottomUpRouteSummary,
    feynobg_direct_bbox_count: bottomUpRouteSummary.feynobg_direct_bbox_count,
    atlas_bbox_count: bottomUpRouteSummary.atlas_bbox_count,
    individual_image_model_bbox_count: bottomUpRouteSummary.individual_image_model_bbox_count,
    feynobg_alpha_bbox_count: bottomUpRouteSummary.feynobg_alpha_bbox_count,
    bbox_only: false,
    recursive_bottom_up: true,
    bottom_up_repair: true,
    shared_bbox_tree: true,
    source_image_excluded: true,
    text_excluded: true,
    text_clean_image: textCleanImage,
    matting_model: bottomUpRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    extraction_model: bottomUpRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    foreground_model: bottomUpRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    termination,
  };
  const planPath = path.join(outputDir, "recursive_layer_plan.json");
  await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  const review = path.join(outputDir, "bbox_review.png");
  const reviewAll = path.join(outputDir, "bbox_review_all.png");
  await Promise.all([
    drawReview(sourceAbs, finalDetection, review, {
      includeText: false,
      showLabels: false,
      colorByDepth: true,
    }),
    drawReview(sourceAbs, finalDetection, reviewAll, {
      includeText: true,
      showLabels: true,
      colorByDepth: false,
    }),
  ]);
  report({
    id: "bottom_up_export",
    order: 8 + records.length * 3,
    status: "running",
    title: "合成预览并导出 PSD",
    description: `bottom-up 补图完成：${records.length} 个 loop，${allLayers.length} 个前景图层。`,
  });
  let psdPath = null;
  if (psd) psdPath = await exportPsd(plan, psd, compositePath);
  report({
    id: "bottom_up_export",
    order: 8 + records.length * 3,
    status: "completed",
    title: "合成预览并导出 PSD",
    description: `已生成 ${allLayers.length} 个前景图层和最终连续底图。`,
    assets: imageAssets([[compositePath, "PSD 合成预览", "composite"]]),
    loops: records.length,
    cutouts: allLayers.length,
  });
  await fsp.writeFile(path.join(outputDir, "detection.json"), JSON.stringify(finalDetection, null, 2));
  return {
    plan: rel(planPath),
    psd: psdPath ? rel(psdPath) : null,
    composite: rel(compositePath),
    loops: records.length,
    layers: allLayers.length,
    stop: termination,
  };
}

// Recursive top-layer workflow. Unlike the legacy tree-first workflow above,
// this intentionally shares only the current working image between passes:
// text is detected/removed once, then each loop detects the currently exposed
// frontmost visual objects, extracts that layer with image-model alpha, inpaints its holes, and feeds
// the repaired plate into the next loop.
const BBOX_MASK_DELETE_PROMPT = `Analyze the attached current image for the next recursive deletion pass. Return ONLY the independently editable objects in the frontmost exposed layer that can be deleted now. The image may still contain ordinary UI text: a standalone foreground label can be a text object, while lettering fused with an emblem or illustration stays with that complete artwork. A covered card, panel, button or other parent surface must wait until its covering child has been deleted in a later pass. Give each spatially separate control or icon its own bbox: four adjacent gear, alert, mail and calendar buttons are four objects, never one enclosing "top icons" panel. Do not combine several buttons, cards, icons or labels into a row or group bbox merely because they align. For a button or control, include its complete visible backplate, border, glyph and glow in that one bbox; do not box just its bright glyph. Include the visible outline and antialiased edge with an 8-16 pixel safety margin, but do not include neighboring objects. Set occluded_by for any covered object you report. If the image is only continuous full-canvas scenery, return b=[] and r=["scene","scene-only terminal background"]. Return bbox JSON only, with no SVG or other visual guide.
${BBOX_COMPACT_FORMAT_GUIDANCE}
${BBOX_COMPACT_SCHEMA}`;

async function makeBboxMaskGuide(width, height, bbox, output) {
  const [x, y, w, h] = bbox.map((value) => Math.round(Number(value)));
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(width, x + w), bottom = Math.min(height, y + h);
  if (right <= left || bottom <= top) throw new Error(`invalid bbox: ${bbox}`);
  const rgba = Buffer.alloc(width * height * 4);
  for (let py = top; py < bottom; py++) {
    for (let px = left; px < right; px++) {
      const offset = (py * width + px) * 4;
      rgba[offset] = 255;
      rgba[offset + 1] = 36;
      rgba[offset + 2] = 36;
      rgba[offset + 3] = px < left + 3 || px >= right - 3 || py < top + 3 || py >= bottom - 3
        ? 220 : 100;
    }
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(output);
  return output;
}

async function runBboxMaskDelete({
  source,
  outputDir,
  maxDepth = 1,
  maxBoxes = 0,
  controllerModel = DEFAULT_BBOX_CONTROLLER_MODEL,
  maskModel = GPT_IMAGE_25_FLARE_MODEL,
  deleteModel = GPT_IMAGE_25_SUNBURST_MODEL,
  workspaceAccount = null,
  onProgress = () => {},
  signal,
}) {
  controllerModel = normalizeControllerModel(controllerModel);
  if (!Number.isInteger(maxDepth) || maxDepth < 1)
    throw new Error("bbox-mask-delete requires --max-depth >= 1");
  if (!Number.isInteger(maxBoxes) || maxBoxes < 0)
    throw new Error("--max-boxes must be a nonnegative integer");
  const sourceAbs = path.resolve(source);
  const sourceMeta = await sharp(sourceAbs).metadata();
  const { width, height } = sourceMeta;
  if (!width || !height) throw new Error("invalid source canvas");
  await fsp.mkdir(outputDir, { recursive: true });
  const planPath = path.join(outputDir, "bbox_mask_delete_plan.json");
  const plan = {
    mode: "bbox_mask_delete_local_experiment",
    source_image: sourceAbs,
    ...(workspaceAccount ? { workspace_account: workspaceAccount } : {}),
    canvas: { width, height },
    svg_guide_enabled: false,
    svg_guide: null,
    controller_model: controllerModel,
    mask_model: maskModel,
    delete_model: deleteModel,
    mask_threshold_for_api: 64,
    max_depth: maxDepth,
    max_boxes_per_loop: maxBoxes || null,
    loops: [],
    status: "running",
  };
  const savePlan = () => fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  const report = (update) => onProgress({ at: new Date().toISOString(), ...update });
  const assets = (items) => items
    .filter(([file]) => file && fs.existsSync(file))
    .map(([file, label, role]) => asset(file, label, role));
  await savePlan();
  let current = sourceAbs;
  try {
    for (let loop = 1; loop <= maxDepth; loop++) {
      const loopDir = path.join(outputDir, `loop_${String(loop).padStart(2, "0")}`);
      await fsp.mkdir(loopDir, { recursive: true });
      const loopInput = path.join(loopDir, "input.png");
      await sharp(current).png().toFile(loopInput);
      current = loopInput;
      report({ id: `loop_${loop}_bbox`, order: loop * 3, status: "running",
        title: `Loop ${loop}: 分析最前层 bbox`, assets: assets([[loopInput, "本轮输入", "working-source"]]) });
      console.log(`Loop ${loop}: analyzing bboxes`);
      const proposed = await analyzeBboxes(current, null, controllerModel, loop, signal, {
        source: current,
        compactResponse: true,
        analysisPrompt: BBOX_MASK_DELETE_PROMPT,
        reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
        imageDetail: "high",
        maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 4096 : null,
        requestLog: path.join(loopDir, "bbox_request.json"),
      });
      const detection = inferOcclusionFromFrontOrder(proposed);
      let boxes = isSceneOnlyTerminalDetection(detection) ? [] : detection.boxes.filter(
        (box) => box.visible !== false && box.category !== "background" &&
          (!Array.isArray(box.occluded_by) || box.occluded_by.length === 0),
      );
      if (maxBoxes) boxes = boxes.slice(0, maxBoxes);
      await fsp.writeFile(path.join(loopDir, "bbox_depth_filtered.json"), JSON.stringify({
        ...detection,
        boxes,
        selected_ids: boxes.map((box) => box.id),
        svg_guide_enabled: false,
        svg_guide: null,
      }, null, 2));
      await drawReview(current, { ...detection, boxes }, path.join(loopDir, "bbox_review.png"), {
        includeText: true, showLabels: true, colorByDepth: false,
      });
      report({ id: `loop_${loop}_bbox`, order: loop * 3, status: "completed",
        title: `Loop ${loop}: 分析最前层 bbox`, description: `选中 ${boxes.length} 个对象`,
        assets: assets([[loopInput, "本轮输入", "working-source"],
          [path.join(loopDir, "bbox_review.png"), "bbox 审核图", "review"]]),
        detection: { ...detection, boxes }, loops: plan.loops.length });
      if (!boxes.length) {
        plan.status = "scene_or_no_frontmost_boxes";
        break;
      }
      report({ id: `loop_${loop}_mask`, order: loop * 3 + 1, status: "running",
        title: `Loop ${loop}: GPT Image 2.5 Flare max 并行生成对象 mask`,
        progress: { current: 0, total: boxes.length }, assets: [] });
      const maskAlpha = Buffer.alloc(width * height);
      const results = new Array(boxes.length);
      let nextIndex = 0;
      const makeOneMask = async () => {
        while (nextIndex < boxes.length) {
          const index = nextIndex++;
          const box = boxes[index];
          const stem = `mask_${String(index + 1).padStart(3, "0")}`;
          const guide = path.join(loopDir, `${stem}_bbox_overlay.png`);
          const raw = path.join(loopDir, `${stem}_model_raw.png`);
          const normalized = path.join(loopDir, `${stem}_normalized.png`);
          await makeBboxMaskGuide(width, height, box.bbox, guide);
          const prompt = `Image segmentation task. Image 1 is the current full canvas. Image 2 is a transparent red bbox overlay marking exactly one target: ${box.label || box.id} (${box.category}), bbox ${JSON.stringify(box.bbox)} in ${width}x${height} image coordinates. Identify the complete real visible silhouette of that one object from Image 1. For a button or control, the target includes its full backplate or dark circular disc, border, icon/glyph, and glow; masking only the bright glyph is incomplete. Return a full-canvas transparent RGBA PNG: target pixels white with alpha about 200, antialiased edge with intermediate alpha, every other pixel fully transparent. Keep the object at its exact original position and scale. Do not fill the entire rectangle, redraw the scene, include neighboring objects, add text, or produce an opaque background. Output a mask only.`;
          await fsp.writeFile(path.join(loopDir, `${stem}_request.json`), JSON.stringify({
            endpoint: "images.edit", client_kind: "segmentation",
            model: maskModel, quality: qualityFor('segmentation'), background: "transparent",
            image_paths: [current, guide], prompt, bbox: box.bbox, box_id: box.id,
          }, null, 2));
          console.log(`Loop ${loop}: mask ${index + 1}/${boxes.length} ${box.id}`);
          await imageEdit(current, raw, prompt, maskModel, null, signal, {
            provider: "openai", clientKind: "segmentation",
            imagePaths: [current, guide], quality: qualityFor('segmentation'), background: "transparent",
            resizeOutput: false,
          });
          const rawMeta = await sharp(raw).metadata();
          const result = await sharp(raw).ensureAlpha()
            .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
            .raw().toBuffer({ resolveWithObject: true });
          const rgba = result.data;
          let selected = 0, outside = 0;
          const [bx, by, bw, bh] = box.bbox;
          for (let py = 0; py < height; py++) {
            for (let px = 0; px < width; px++) {
              const offset = (py * width + px) * 4 + 3;
              const alpha = rgba[offset];
              if (px < bx || py < by || px >= bx + bw || py >= by + bh) {
                if (alpha >= 64) outside++;
                rgba[offset] = 0;
              } else if (alpha >= 64) selected++;
            }
          }
          if (!selected)
            throw new Error(`${stem}: model returned no target alpha inside bbox; raw output retained`);
          await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(normalized);
          results[index] = { id: box.id, bbox: box.bbox, guide, model_raw: raw,
            normalized, model_canvas: [rawMeta.width, rawMeta.height], selected_pixels: selected,
            outside_bbox_pixels_clipped: outside };
          report({ id: `loop_${loop}_mask`, order: loop * 3 + 1, status: "running",
            title: `Loop ${loop}: GPT Image 2.5 Flare max 并行生成对象 mask`,
            progress: { current: results.filter(Boolean).length, total: boxes.length },
            assets: assets(results.filter(Boolean).flatMap((item) => [
              [item.guide, `${item.id} bbox`, "bbox-overlay"],
              [item.model_raw, `${item.id} 模型原始 mask`, "mask-raw"],
              [item.normalized, `${item.id} bbox 内 mask`, "mask"],
            ])) });
        }
      };
      const maskWorkers = await Promise.allSettled(
        Array.from({ length: Math.min(4, boxes.length) }, makeOneMask),
      );
      const failedWorker = maskWorkers.find((worker) => worker.status === "rejected");
      if (failedWorker) throw failedWorker.reason;
      for (const item of results) {
        const alpha = await sharp(item.normalized).extractChannel(3).raw().toBuffer();
        for (let pixel = 0; pixel < maskAlpha.length; pixel++)
          maskAlpha[pixel] = Math.max(maskAlpha[pixel], alpha[pixel]);
      }
      const combined = path.join(loopDir, "bbox_object_mask_model_combined.png");
      await writeAlphaPreview(maskAlpha, width, height, combined);
      const overlay = path.join(loopDir, "bbox_object_mask_preview.png");
      const tint = Buffer.alloc(width * height * 4);
      for (let pixel = 0; pixel < maskAlpha.length; pixel++) {
        const offset = pixel * 4;
        tint[offset] = 255; tint[offset + 1] = 35; tint[offset + 2] = 45;
        tint[offset + 3] = Math.round(maskAlpha[pixel] * 0.55);
      }
      await sharp(current).composite([{ input: await sharp(tint, {
        raw: { width, height, channels: 4 },
      }).png().toBuffer() }]).png().toFile(overlay);
      report({ id: `loop_${loop}_mask`, order: loop * 3 + 1, status: "completed",
        title: `Loop ${loop}: 对象 mask 已合并`,
        progress: { current: boxes.length, total: boxes.length },
        assets: assets([
          ...results.flatMap((item) => [
            [item.guide, `${item.id} bbox`, "bbox-overlay"],
            [item.model_raw, `${item.id} 模型原始 mask`, "mask-raw"],
            [item.normalized, `${item.id} bbox 内 mask`, "mask"],
          ]),
          [combined, "模型 mask 合并", "mask"], [overlay, "mask 叠加预览", "review"],
        ]) });
      const apiRgba = Buffer.alloc(width * height * 4);
      for (let pixel = 0; pixel < maskAlpha.length; pixel++) {
        const offset = pixel * 4;
        apiRgba[offset] = 255; apiRgba[offset + 1] = 255; apiRgba[offset + 2] = 255;
        apiRgba[offset + 3] = maskAlpha[pixel] >= 64 ? 0 : 255;
      }
      const apiMask = path.join(loopDir, "bbox_delete_mask_openai.png");
      await sharp(apiRgba, { raw: { width, height, channels: 4 } }).png().toFile(apiMask);
      const deleteInput = path.join(loopDir, "bbox_delete_input.png");
      await makeBlackHolePlate(current, apiMask, deleteInput);
      const rawDelete = path.join(loopDir, "bbox_delete_model_raw.png");
      const prompt = `Masked object removal. Image 1 is the current canvas with black deletion holes. Image 2 is a white-on-transparent silhouette mask generated from the selected bboxes. The native edit mask is authoritative: transparent pixels are editable, opaque pixels are protected. Remove only the selected objects represented by the black holes, then reconstruct the material immediately behind them. Preserve all other objects, text, UI, layout, colors and pixels outside the mask. Do not restore the removed objects or invent new UI. Return the complete canvas as PNG.`;
      await fsp.writeFile(path.join(loopDir, "bbox_delete_request.json"), JSON.stringify({
        endpoint: "images.edit", client_kind: "background-repair",
        model: deleteModel, quality: IMAGE_GENERATION_QUALITY,
        image_paths: [deleteInput, combined], mask: apiMask, prompt,
      }, null, 2));
      report({ id: `loop_${loop}_delete`, order: loop * 3 + 2, status: "running",
        title: `Loop ${loop}: GPT Image 2.5 Sunburst max 删除对象`,
        assets: assets([[deleteInput, "删除输入", "background-input"],
          [apiMask, "删除 API mask", "mask-api"]]) });
      console.log(`Loop ${loop}: deleting ${boxes.length} objects`);
      await imageEdit(deleteInput, rawDelete, prompt, deleteModel, apiMask, signal, {
        provider: "openai", clientKind: "background-repair",
        imagePaths: [deleteInput, combined], quality: qualityFor('background'), resizeOutput: false,
        timeoutMs:getRoute('background').timeout_ms,
      });
      const deleteMeta = await sharp(rawDelete).metadata();
      const background = path.join(loopDir, "background.png");
      await applyGeneratedRegion(current, rawDelete, apiMask, background);
      plan.loops.push({ loop, input: current, bbox: boxes, masks: results,
        combined_mask: combined, mask_preview: overlay, delete_input: deleteInput,
        delete_mask_openai: apiMask, delete_model_raw: rawDelete,
        delete_model_canvas: [deleteMeta.width, deleteMeta.height],
        background, next_loop_input_policy: "model_inside_mask_original_outside",
        model_output_resized_for_composite: deleteMeta.width !== width || deleteMeta.height !== height });
      await savePlan();
      report({ id: `loop_${loop}_delete`, order: loop * 3 + 2, status: "completed",
        title: `Loop ${loop}: 删除完成`,
        assets: assets([[deleteInput, "删除输入", "background-input"],
          [apiMask, "删除 API mask", "mask-api"],
          [rawDelete, "模型原始删除结果", "background-generated"],
          [background, "下一轮输入底图", "background"]]),
        loops: plan.loops.length, cutouts: results.length });
      current = background;
    }
    if (plan.status === "running") plan.status = "max_depth";
    plan.final_background = current;
    await savePlan();
    return { plan: rel(planPath), loops: plan.loops.length, layers: 0,
      final_background: rel(current), stop: plan.status };
  } catch (error) {
    plan.status = signal?.aborted ? "stopped" : "failed";
    plan.error = String(error?.message || error);
    await savePlan();
    throw error;
  }
}

function startBboxMaskDeleteWebJob({ id, source, out, workspaceAccount, payload }) {
  const maxDepth = Number(payload.max_depth ?? 1);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 32)
    throw new Error("bbox mask 删除实验的最大递归 loop 数必须在 1 到 32 之间");
  const abortController = new AbortController();
  const job = {
    id, workspace_account: workspaceAccount, status: "running", stage: "准备 bbox mask 删除实验",
    source: rel(source), output_dir: rel(out), max_depth: maxDepth,
    bbox_mask_delete_mode: true, bbox_mode: "bbox_mask_delete",
    bbox_controller_model: normalizeControllerModel(payload.controller_model),
    image_model: GPT_IMAGE_25_FLARE_MODEL,
    svg_guide_enabled: false, svg_guide_required: false, svg_guide_requested: false,
    started_at: new Date().toISOString(), loops: 0, cutouts: 0,
    steps: [], detection: null, depth_groups: [], retry_available: false,
    cancelled: false, abortController, process: null,
  };
  JOBS.set(id, job);
  job.process = runBboxMaskDelete({
    source, outputDir: out, maxDepth, workspaceAccount,
    controllerModel: job.bbox_controller_model, signal: abortController.signal,
    onProgress(update) {
      const existing = job.steps.find((step) => step.id === update.id);
      const next = applyStepUpdate(existing || { id: update.id }, update);
      if (!existing) job.steps.push(next);
      job.steps.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      job.stage = update.title || job.stage;
      job.current_step = update.id;
      job.current_loop = Number(String(update.id).match(/^loop_(\d+)_/)?.[1] || 0);
      job.updated_at = update.at;
      if (update.detection) job.detection = update.detection;
      if (update.loops !== undefined) job.loops = update.loops;
      if (update.cutouts !== undefined) job.cutouts = update.cutouts;
      persistRunTiming(job);
    },
  }).then((result) => {
    if (job.cancelled) {
      job.status = "stopped";
      job.stage = "已停止";
      return;
    }
    Object.assign(job, result);
    job.status = "completed";
    job.stage = "bbox mask 删除实验完成";
    job.completed_at = new Date().toISOString();
  }).catch((error) => {
    const message = conciseError(error);
    job.failure_reason = message;
    job.status = job.cancelled ? "stopped" : "failed";
    job.stage = job.cancelled ? "已停止" : message;
    if (!job.cancelled) job.error = error.stack || String(error);
    const running = job.steps.find((step) => step.status === "running");
    if (running) Object.assign(running, { status: job.status, description: message,
      failure_reason: message, completed_at: new Date().toISOString() });
  }).finally(() => {
    finishRunTiming(job);
    persistRunTiming(job);
  });
  return snapshot(job);
}

async function runLayeredSplit({
  source,
  outputDir,
  maxDepth = 0,
  bboxMode = "gpt_direct",
  bboxOnly = false,
  bboxReview = false,
  geminiOriginalImage = true,
  bottomUpRepair = false,
  controllerModel = DEFAULT_BBOX_CONTROLLER_MODEL,
  bboxRoi = false,
  imageModel = DEFAULT_IMAGE_MODEL,
  minArea = 500,
  atlasEnabled = true,
  atlasBatchSize = 4,
  atlasSize = ATLAS_MAX_SIZE,
  atlasColumns = null,
  atlasQuality = FOREGROUND_ATLAS_QUALITY,
  svgGuideEnabled = false,
  flatSegmentBackground,
  protectOutsideMask = true,
  bboxPaddingPx = 3,
  useModelOutput = false,
  useFeynobg = true,
  autoMatteRouting = false,
  matteRoutingMode = "force_model",
  psd,
  waitForAtlasRetry = null,
  resumeState = null,
  shouldStop = () => false,
  onProgress = () => {},
  signal,
}) {
  controllerModel = normalizeControllerModel(controllerModel);
  bboxPaddingPx = clampBboxPadding(bboxPaddingPx, 3);
  // The default three-image workflow reconstructs from the residual plate;
  // The image model receives the scene references directly.
  useModelOutput = useModelOutput === true;
  // The UI defaults to force_model. Only the explicit gemini_auto mode lets
  // Gemini's per-bbox remove_by_matte decision select direct FeyNobg.
  const requestedMatteRouting = matteRoutingMode === "gemini_auto" || autoMatteRouting === true;
  autoMatteRouting = requestedMatteRouting && !bottomUpRepair && controllerModel === "gemini-3.8-flash";
  matteRoutingMode = autoMatteRouting ? "gemini_auto" : "force_model";
  useFeynobg = autoMatteRouting;
  const useOriginalGeminiImage =
    controllerModel === "gemini-3.8-flash" && geminiOriginalImage;
  const bboxInputLabel = useOriginalGeminiImage
    ? "bbox 模型原图输入"
    : "bbox 模型压缩输入";
  // Raw bbox mode is intentional: use only the first controller response for
  // every loop. Ignore legacy/requested review flags so no second model call
  // or proposal/review union can change the original coordinates.
  bboxReview = false;
  ({ svgGuideEnabled, flatSegmentBackground } = resolveBackgroundWorkflow({
    svgGuideEnabled, flatSegmentBackground, bottomUpRepair,
  }));
  protectOutsideMask = protectOutsideMask !== false;
  const threeImageBackground = !svgGuideEnabled;
  const backgroundRepairMode = threeImageBackground
    ? "three_image_direct_sunburst_output"
    : "svg_guided_gpt_image_2_5_sunburst";
  if (svgGuideEnabled && bottomUpRepair)
    throw new Error("SVG_GUIDE_BOTTOM_UP_UNSUPPORTED");
  // Strict synchronized SVG mode is an extraction workflow: the model may
  // provide the matte, but its regenerated RGB is not authoritative. Keep the
  // original pixels so model redraw/scale drift cannot enter the final layer.
  // The explicit model-RGB switch remains available only to the legacy path.
  if (svgGuideEnabled) useModelOutput = false;
  if (bottomUpRepair) bboxOnly = false;
  const report = (update) => {
    const normalized = { ...update };
    for (const key of ["title", "description"]) {
      if (typeof normalized[key] === "string")
        normalized[key] = normalized[key].replaceAll("gpt-5.6-sol", controllerModel);
    }
    onProgress({ at: new Date().toISOString(), ...normalized });
  };
  const imageAssets = (items) =>
    items
      .filter(([file]) => file && IMAGE_SUFFIXES.has(path.extname(file).toLowerCase()) && fs.existsSync(file))
      .map(([file, label, role]) => asset(file, label, role));
  const checkStop = () => {
    if (shouldStop()) throw new Error("JOB_STOPPED");
  };
  checkStop();
  await fsp.mkdir(outputDir, { recursive: true });
  const sourceAbs = path.resolve(source);
  const meta = await sharp(sourceAbs).metadata();
  if (!meta.width || !meta.height) throw new Error("invalid source canvas");
  const review = path.join(outputDir, "bbox_review.png");
  const reviewAll = path.join(outputDir, "bbox_review_all.png");
  const detectionPath = path.join(outputDir, "detection.json");
  const textDir = path.join(outputDir, "text_cleanup");
  await fsp.mkdir(textDir, { recursive: true });

  // Pass 0 mirrors every visual loop. A loop restart reuses its already
  // generated input plate and therefore must not repeat text analysis or
  // text removal.
  let textBundle = null;
  let textBboxOnly = null;
  const textAnalysisStepId = svgGuideEnabled ? "text_bbox_svg" : "text_bbox";
  if (!resumeState) {
    if (svgGuideEnabled) {
    report({
      id: "text_bbox_svg",
      order: 1,
      status: "running",
      title: `${controllerModel} 同步生成文字 bbox + 全图 SVG`,
      description: "同一次分析识别普通文字 bbox 和完整场景 SVG；美术字保留为完整图片组件。",
      assets: imageAssets([[sourceAbs, "文字 bbox/SVG 同步分析输入原图", "svg-input"]]),
    });
    try {
      textBundle = await retryJobOperation({ request_id: textAnalysisStepId, label: "文字 bbox + SVG 分析", input: sourceAbs, timeout_ms: getRoute("controller").timeout_ms }, () => generateTextBboxSvgBundle(
        sourceAbs,
        textDir,
        meta.width,
        meta.height,
        signal,
        controllerModel,
      ));
    } catch (error) {
      report({
        id: "text_bbox_svg",
        order: 1,
        status: "failed",
        title: `${controllerModel} 同步生成文字 bbox + 全图 SVG`,
        description: `文字 bbox/SVG 同步生成或校验失败：${String(error?.message || error)}`,
        assets: imageAssets([
          [sourceAbs, "文字 bbox/SVG 同步分析输入原图", "svg-input"],
          [path.join(textDir, "text_bbox_review.png"), "普通文字 bbox 审核图", "review"],
          [path.join(textDir, "text_scene.png"), "文字删除前完整场景 SVG 预览", "svg-preview"],
        ]),
        failure_reason: String(error?.message || error),
      });
      throw error;
    }
    } else {
      report({
        id: textAnalysisStepId,
        order: 1,
        status: "running",
        title: `${controllerModel} 识别普通文字 bbox（SVG 已全面禁用）`,
        description: "只请求普通文字 bbox；不生成全图 SVG、坐标参考 SVG 或 residual SVG。",
        assets: imageAssets([[sourceAbs, "文字 bbox 分析输入原图", "model_input"]]),
      });
      try {
        textBboxOnly = await retryJobOperation({ request_id: textAnalysisStepId, label: "文字 bbox 分析", input: sourceAbs, timeout_ms: getRoute("controller").timeout_ms }, () => generateTextBboxOnlyDetection(
          sourceAbs,
          textDir,
          controllerModel,
          useOriginalGeminiImage,
          signal,
        ));
      } catch (error) {
        report({
          id: textAnalysisStepId,
          order: 1,
          status: "failed",
          title: `${controllerModel} 识别普通文字 bbox（SVG 已全面禁用）`,
          description: `纯 bbox 文字分析失败：${String(error?.message || error)}`,
          assets: imageAssets([[sourceAbs, "文字 bbox 分析输入原图", "model_input"]]),
          failure_reason: String(error?.message || error),
        });
        throw error;
      }
    }
  }
  const textDetection = resumeState?.textDetection || textBundle?.detection || textBboxOnly?.detection;
  if (!textDetection?.boxes) throw new Error("LOOP_RESTART_TEXT_DETECTION_MISSING");
  const text = textDetection.boxes.filter(
    (box) => box.category === "text" && box.visible !== false,
  );
  const textSvgGuide = textBundle?.svgGuide || null;
  const textReview = textSvgGuide?.reviewPath || null;
  if (!resumeState && svgGuideEnabled) report({
    id: "text_bbox_svg",
    order: 1,
    status: "completed",
    title: `${controllerModel} 同步生成文字 bbox + 全图 SVG`,
    description: `同一次 ${controllerModel} 图片识别响应生成 ${text.length} 个普通文字 bbox 和全图 SVG；已删除同 ID 文字节点并生成补图 residual。`,
    assets: imageAssets([
      [sourceAbs, "文字 bbox/SVG 同步分析输入原图", "svg-input"],
      [textSvgGuide.coordinateReferencePath, "文字 bbox/SVG 坐标参考图", "svg-input"],
      [textReview, "普通文字 bbox 审核图", "review"],
      [textSvgGuide.scenePath, "文字删除前完整场景 SVG", "svg-scene"],
      [textSvgGuide.scenePreview, "文字删除前完整场景 SVG 预览", "svg-preview"],
      [textSvgGuide.svgPath, "删除普通文字后的 residual.svg", "svg-residual"],
      [textSvgGuide.png, "删除普通文字后的 residual SVG 预览", "svg-residual-preview"],
    ]),
    text_count: text.length,
    detection: textDetection,
    depth_groups: [{ depth: 0, ids: text.map((box) => box.id) }],
    svg_guide: {
      hidden_ids: textSvgGuide.hiddenIds,
      matches: textSvgGuide.matches,
      residual: textSvgGuide.svgPath,
      preview: textSvgGuide.png,
    },
  });
  if (!resumeState && !svgGuideEnabled) report({
    id: textAnalysisStepId,
    order: 1,
    status: "completed",
    title: `${controllerModel} 识别普通文字 bbox（SVG 已全面禁用）`,
    description: `单次纯 bbox 请求识别 ${text.length} 个普通文字区域；本次任务不会生成或传递任何 SVG。请求：${rel(textBboxOnly.requestPath)}。`,
    assets: imageAssets([
      [sourceAbs, "文字 bbox 分析输入原图", "model_input"],
      [textBboxOnly.modelInput, "文字 bbox 模型输入", "model_input"],
      [textBboxOnly.reviewPath, "普通文字 bbox 审核图", "review"],
    ]),
    text_count: text.length,
    detection: textDetection,
    depth_groups: [{ depth: 0, ids: text.map((box) => box.id) }],
    svg_guide: null,
  });
  checkStop();

  // One-time text removal. Every later loop starts from this generated plate
  // or from the previous loop's generated background plate.
  if (!resumeState) report({
    id: "text_cleanup",
    order: 2,
    status: "running",
    title: "GPT Image 2.5 Sunburst max 一次性移除文字",
    description: text.length
      ? svgGuideEnabled
        ? `移除 ${text.length} 个文字区域；黑洞底图与 residual SVG 预览共同输入 GPT Image 2.5 Sunburst max。`
        : `移除 ${text.length} 个文字区域；只向 GPT Image 2.5 Sunburst max 发送黑洞底图和原生 mask，不生成或传递 SVG。`
      : "没有文字 bbox，直接使用原图作为 Loop 1 输入。",
    assets: imageAssets([[sourceAbs, "文字清理输入原图", "working-source"]]),
  });
  let textCleanImage = resumeState?.input || null;
  let textCleanupFallback = resumeState?.textCleanupFallback === true;
  try {
    if (resumeState) {
      if (!fs.existsSync(textCleanImage)) throw new Error("LOOP_RESTART_INPUT_MISSING");
    } else {
      textCleanImage = await retryJobOperation({ request_id: "text_cleanup", label: "去文字", input: sourceAbs, timeout_ms: getRoute("background").timeout_ms }, () => removeText(
        sourceAbs,
        text,
        textDir,
        imageModel,
        signal,
        { returnGenerated: true, svgGuide: textSvgGuide },
      ));
    }
  } catch (error) {
    // Keep the source pixels intact when the image gateway times out. This
    // lets the visual-layer loop continue for inspection without substituting
    // a blank/black plate; the warning is persisted in the plan below.
    if (resumeState || !/504|gateway time-?out|timed? ?out/i.test(String(error?.message || error)))
      throw error;
    textCleanupFallback = true;
    textCleanImage = path.join(textDir, "text_clean.png");
    await fsp.copyFile(sourceAbs, textCleanImage);
  }
  if (!resumeState) report({
    id: "text_cleanup",
    order: 2,
    status: "completed",
    title: "GPT Image 2.5 Sunburst max 一次性移除文字",
    description: `${bboxOnly
      ? "文字处理已完成；当前仅分析文字 bbox 模式在此停止。"
      : `文字处理只执行一次；AI 去文字生成图将直接作为第一个递归 loop 的输入：${rel(textCleanImage)}。`} ${svgGuideEnabled
      ? "本次文字补图使用 residual SVG 预览。"
      : "本次文字补图未生成、未读取、未传递任何 SVG。"}`,
    assets: imageAssets([
      [sourceAbs, "文字清理输入原图", "working-source"],
      [path.join(textDir, "text_mask.png"), "文字区域遮罩", "mask"],
      [path.join(textDir, "text_mask_openai.png"), "GPT Image 2.5 Sunburst 原生文字 mask", "mask-api"],
      [path.join(textDir, "text_inpaint_input.png"), "文字黑洞补图输入", "background-input"],
      [textSvgGuide?.png, "删除普通文字后的 residual SVG 预览（Sunburst max 输入）", "svg-residual-preview"],
      [textCleanImage, "AI 去文字生成图（Loop 1 直接输入）", "text-clean-generated"],
    ]),
  });

  // "仅分析文字 bbox" still performs the one-time AI text cleanup so the
  // generated clean plate can be inspected. It only stops before the first
  // visual-layer bbox loop, matting pass, and background inpaint.
  if (textCleanupFallback && !resumeState) {
    report({
      id: "text_cleanup",
      order: 2,
      status: "completed",
    title: "GPT Image 2.5 Sunburst max text cleanup (504 fallback)",
      description: "The upstream image edit timed out; the original plate is kept so the visual loop can continue. Text was not removed in this run.",
      warning: true,
      assets: imageAssets([
        [textCleanImage, "504 fallback: original plate", "text-clean-generated"],
      ]),
    });
  }

  // Strict SVG mode no longer creates a separate global scene. At the start
  // of every visual loop, one controller request authors both the frontmost bbox
  // subset and a complete SVG of that loop's current full screenshot.
  let svgGuideState = null;
  const svgGuideHistory = Array.isArray(resumeState?.svgGuideHistory)
    ? resumeState.svgGuideHistory.slice()
    : [];

  if (bboxOnly) {
    const textPlan = {
      project: path.parse(sourceAbs).name,
      source_image: sourceAbs,
      canvas: { width: meta.width, height: meta.height },
      layers: [],
      loops: [],
      detection: textDetection,
      text_detection: textDetection,
      depth_groups: [],
      max_depth: maxDepth,
      bbox_mode: "recursive_top_layer",
      bbox_controller_model: controllerModel,
      bbox_reasoning_effort: textDetection.bbox_reasoning_effort,
      bbox_roi: false,
      bbox_review: bboxReview,
      bbox_original_image: useOriginalGeminiImage,
      bbox_padding_px: bboxPaddingPx,
      use_model_output: useModelOutput,
      use_feynobg: useFeynobg,
      // bbox-only is an explicit inspection mode; no visual SVG stage runs.
      svg_guide_enabled: false,
      svg_guide_required: false,
      svg_guide_requested: svgGuideEnabled,
      svg_guide: null,
      protect_outside_mask: protectOutsideMask,
      route_summary: {
        total_bbox_count: 0,
        feynobg_direct_bbox_count: 0,
        atlas_bbox_count: 0,
        individual_image_model_bbox_count: 0,
        feynobg_alpha_bbox_count: 0,
        atlas_feynobg_alpha_bbox_count: 0,
        feynobg_direct_bbox_ids: [],
        atlas_bbox_ids: [],
        individual_image_model_bbox_ids: [],
        per_loop: [],
      },
      background_model: BACKGROUND_REPAIR_MODEL,
       background_repair_mode: "gpt_image_2_5_sunburst_direct",
      auto_matte_routing: autoMatteRouting,
      matte_routing_mode: matteRoutingMode,
      feynobg_failure_policy: "abort_no_llm_fallback",
      bbox_only: true,
      text_cleanup_fallback: textCleanupFallback,
      recursive_top_layer: true,
      shared_bbox_tree: false,
      source_image_excluded: true,
      text_excluded: true,
      matting_model: imageModel,
      extraction_model: imageModel,
      foreground_model: imageModel,
      text_clean_image: textCleanImage,
    };
    await fsp.writeFile(
      detectionPath,
      JSON.stringify(textDetection, null, 2),
    );
    const planPath = path.join(outputDir, "recursive_layer_plan.json");
    await fsp.writeFile(planPath, JSON.stringify(textPlan, null, 2));
    return {
      plan: rel(planPath),
      psd: null,
      composite: null,
      loops: 0,
      layers: 0,
      stop: "text_bbox_only_after_cleanup",
    };
  }

  if (bottomUpRepair) {
    return runBottomUpRepairWorkflow({
      sourceAbs,
      sourceMeta: meta,
      outputDir,
      textCleanImage,
      textDetection,
      text,
      maxDepth,
      minArea,
      controllerModel,
      imageModel,
      bboxPaddingPx,
      useModelOutput,
      useFeynobg,
      matteRoutingMode,
      geminiOriginalImage,
      bboxReview,
      psd,
      signal,
      report,
      imageAssets,
      checkStop,
    });
  }

  // Use the exact image-model output as Loop 1's source; no intermediate
  // "clean plate A" copy is inserted into the recursive chain.
  let current = textCleanImage;
  const records = Array.isArray(resumeState?.records)
    ? resumeState.records.map((record) => ({ ...record }))
    : [];
  const allLayers = records.flatMap((record) => Array.isArray(record.layers) ? record.layers : []);
  const routeSummaries = records
    .map((record) => record.route_summary)
    .filter(Boolean);
  const aggregateBoxes = [
    ...text,
    ...records.flatMap((record) => Array.isArray(record.bbox) ? record.bbox : []),
  ];
  const maxLoops = maxDepth > 0 ? maxDepth : 64;
  let termination = "max_depth";

  const firstLoopIndex = resumeState
    ? Math.max(0, Number(resumeState.startLoop || 1) - 1)
    : 0;
  for (let loopIndex = firstLoopIndex; loopIndex < maxLoops; loopIndex++) {
    checkStop();
    const loopNumber = loopIndex + 1;
    const loopDir = path.join(
      outputDir,
      `loop_${String(loopNumber).padStart(2, "0")}`,
    );
    // Filled after the matte planner is built; early bbox snapshots carry
    // null because no extraction route has been selected yet.
    let routeSummary = null;
    await fsp.mkdir(loopDir, { recursive: true });
    const modelInputPath = path.join(loopDir, "working_model_source.jpg");
    const modelPreview = await prepareBboxVisionImage(current, modelInputPath, {
      compress: !useOriginalGeminiImage,
    });
    // Strict synchronized mode always gives the same full-resolution current
    // screenshot to the bbox and SVG halves of the single controller request.
    const modelInput = svgGuideEnabled ? current : modelPreview.path;
    const requestLog = path.join(loopDir, "bbox_request.json");
    const bboxStepId = `loop_${loopNumber}_bbox`;
    report({
      id: bboxStepId,
      order: 3 + loopIndex * 3,
      status: "running",
      title: svgGuideEnabled
        ? `Loop ${loopNumber}：${controllerModel} 同步生成 bbox + 全图 SVG`
        : `Loop ${loopNumber}：${controllerModel} 提取最上层 bbox`,
      description: svgGuideEnabled
        ? `同一个 ${controllerModel} 请求识别当前完整截图：bbox 只返回最上层可抠对象，SVG 返回整张截图的完整结构；两者共享 ID 和坐标。`
        : `只分析当前底图中最前面、现在可以被抠出的图像元素；${useOriginalGeminiImage ? "Gemini 直接使用原图" : "使用压缩预览图"}。`,
      assets: imageAssets([
        [
          current,
          loopNumber === 1
            ? "Loop 1 输入（AI 去文字生成图）"
            : "当前 loop 输入图",
          "working-source",
        ],
        [modelInput, svgGuideEnabled ? `${controllerModel} 同批 bbox+SVG 完整截图输入` : bboxInputLabel, "model_input"],
      ]),
    });
    let proposed;
    let loopSvgGuideState = null;
    let svgBundle = null;
    try {
      if (svgGuideEnabled) {
        svgBundle = await retryJobOperation({ request_id: bboxStepId, label: `Loop ${loopNumber} bbox + SVG 分析`, input: current, timeout_ms: getRoute("controller").timeout_ms }, () => generateLoopBboxSvgBundle(
          current,
          loopDir,
          loopNumber,
          meta.width,
          meta.height,
          signal,
          controllerModel,
        ));
        proposed = svgBundle.detection;
        loopSvgGuideState = svgBundle.svgGuide;
        svgGuideState = loopSvgGuideState;
        svgGuideHistory.push({
          loop: loopNumber,
          scene: loopSvgGuideState.svgPath,
          preview: loopSvgGuideState.previewPath,
          coordinate_reference: loopSvgGuideState.coordinateReferencePath,
          request: loopSvgGuideState.requestPath,
          raw_response: loopSvgGuideState.rawPath,
          top_bbox_review: loopSvgGuideState.topBboxReviewPath,
          parent_repairs: loopSvgGuideState.parentRepairPath,
          response_meta: loopSvgGuideState.responseMetaPath,
          scene_json: loopSvgGuideState.sceneJsonPath,
          sync: loopSvgGuideState.syncPath,
          node_count: loopSvgGuideState.nodes.length,
          bbox_count: svgBundle.sync.bbox_count,
        });
      } else {
        proposed = await retryJobOperation({ request_id: bboxStepId, label: `Loop ${loopNumber} bbox 分析`, input: current, timeout_ms: getRoute("controller").timeout_ms }, () => analyzeBboxes(
          current,
          null,
          controllerModel,
          loopNumber,
          signal,
          {
            source: modelInput,
            compactResponse: true,
            analysisPrompt: TOP_LAYER_BBOX_PROMPT,
            reasoningEffort: isReasoningControllerModel(controllerModel) ? "low" : null,
            imageDetail: "high",
            maxCompletionTokens: isReasoningControllerModel(controllerModel) ? 4096 : null,
            requestLog,
          },
        ));
      }
    } catch (error) {
      report({
        id: bboxStepId,
        order: 3 + loopIndex * 3,
        status: "failed",
        title: svgGuideEnabled
          ? `Loop ${loopNumber}：${controllerModel} 同步生成 bbox + 全图 SVG`
          : `Loop ${loopNumber}：${controllerModel} 提取最上层 bbox`,
        description: svgGuideEnabled
          ? `同批 bbox/SVG 生成或同步校验失败：${String(error?.message || error)}；${fs.existsSync(path.join(loopDir, "bbox_raw_response.txt")) ? `原始返回：${rel(path.join(loopDir, "bbox_raw_response.txt"))}` : "请求没有产生原始返回文件"}`
          : `bbox 分析失败：${String(error?.message || error)}`,
        assets: imageAssets([[current, `Loop ${loopNumber} 同步分析输入`, "working-source"]]),
        failure_reason: String(error?.message || error),
      });
      throw error;
    }
    // The compact response can include only `f` (front-to-back) without
    // explicit occlusion arrays.  Reconstruct those edges from overlapping
    // boxes before selecting this loop's frontmost roots; otherwise a ring
    // and the map beneath it are incorrectly sent through the same atlas.
    // In synchronized mode the selected controller has already decided the topmost subset in
    // the same response as the SVG. Do not geometrically reinterpret that
    // contract in the backend.
    let currentDetection = svgGuideEnabled
      ? proposed
      : inferOcclusionFromFrontOrder(proposed);
    const sceneOnlyTerminal = isSceneOnlyTerminalDetection(currentDetection);
    let topBoxes = sceneOnlyTerminal
      ? []
      : currentDetection.boxes.filter(
          (box) =>
            box.visible !== false &&
            !["text", "background"].includes(box.category),
        );
    if (!sceneOnlyTerminal && bboxPaddingPx > 0) {
      // Depth inference uses the model's tight geometry above. Expand only
      // the selected extraction boxes so a larger safety margin cannot create
      // false occlusion edges between neighbouring UI elements.
      topBoxes = topBoxes.map((box) =>
        expandBboxForExtraction(box, bboxPaddingPx, meta.width, meta.height),
      );
    }
    // A recursive loop removes only the currently exposed depth. Independent
    // roots may share the loop (and can be atlas-batched), but a box that is
    // explicitly covered by another detected object must wait for a later
    // loop after its occluder has been repaired/removed. This prevents the
    // overlapping independent objects from entering the same foreground atlas pass.
    if (!svgGuideEnabled) {
      const frontmostBoxes = topBoxes.filter(
        (box) => !Array.isArray(box.occluded_by) || box.occluded_by.length === 0,
      );
      if (frontmostBoxes.length) topBoxes = frontmostBoxes;
    }
    const backgroundReferenceBoxes = immediateDeferredReferenceBoxes(
      currentDetection,
      topBoxes,
    );
    // Keep the depth-resolved result beside the raw controller response so
    // the UI and later audits can distinguish “model saw both boxes” from
    // “this loop is allowed to extract only the front one”.
    await fsp.writeFile(
      path.join(loopDir, "bbox_depth_filtered.json"),
      JSON.stringify(
        {
          ...currentDetection,
          boxes: topBoxes,
          selected_ids: topBoxes.map((box) => box.id),
          next_depth_reference_boxes: backgroundReferenceBoxes,
          scene_only_terminal: sceneOnlyTerminal,
          bbox_padding_px: bboxPaddingPx,
          use_model_output: useModelOutput,
          use_feynobg: useFeynobg,
          // Route counts are finalized after the matte planner runs.  Do not
          // read the loop-local summary here: this detection snapshot is
          // emitted before the extraction route is planned.
          route_summary: null,
          auto_matte_routing: autoMatteRouting,
          matte_routing_mode: matteRoutingMode,
        },
        null,
        2,
      ),
    );
    const proposalReview = path.join(loopDir, "bbox_proposal.png");
    const proposalDetection = { ...proposed, boxes: topBoxes };
    await drawReview(current, proposalDetection, proposalReview, {
      includeText: false,
      showLabels: true,
      colorByDepth: false,
    });
    const bboxAssets = [
      [
        current,
        loopNumber === 1
          ? "Loop 1 输入（AI 去文字生成图）"
          : "当前 loop 输入图",
        "working-source",
      ],
      [loopSvgGuideState?.coordinateReferencePath, `Loop ${loopNumber} 控制模型坐标参考图`, "model-input"],
      [modelInput, svgGuideEnabled ? `${controllerModel} 同批 bbox+SVG 完整截图输入` : bboxInputLabel, "model_input"],
      [loopSvgGuideState?.parentRepairPath, `Loop ${loopNumber} SVG parent repair record`, "svg-parent-repairs"],
      [proposalReview, svgGuideEnabled
        ? `Loop ${loopNumber} 同批 ${controllerModel} 最上层 bbox（未经后端重排）`
        : `Loop ${loopNumber} 最上层 bbox（按遮挡深度筛选）`, "proposal"],
      [loopSvgGuideState?.svgPath, `Loop ${loopNumber} 同批完整场景 SVG`, "svg-scene"],
      [loopSvgGuideState?.previewPath, `Loop ${loopNumber} 同批完整场景 SVG 预览`, "svg-preview"],
    ];
    if (loopSvgGuideState?.topBboxReviewPath) {
      bboxAssets.push([
        loopSvgGuideState.topBboxReviewPath,
        `Loop ${loopNumber} SVG top bbox red-box review`,
        "svg-top-bbox-review",
      ]);
    }

    // Strict synchronized mode uses the controller's bbox subset verbatim (apart from
    // the configured extraction padding). The legacy path retains its old
    // deterministic depth filter. Neither path makes a second bbox request.

    if (!topBoxes.length) {
      termination = sceneOnlyTerminal
        ? "scene_only_background"
        : "no_extractable_top_layer";
      report({
        id: bboxStepId,
        order: 3 + loopIndex * 3,
        status: "completed",
        title: svgGuideEnabled
          ? `Loop ${loopNumber}：${controllerModel} 同步生成 bbox + 全图 SVG`
          : `Loop ${loopNumber}：${controllerModel} 提取最上层 bbox`,
        description: sceneOnlyTerminal
          ? "当前图只剩连续的全屏场景背景；环境构件不再抠图，递归结束。"
          : "当前补图中没有可继续拆出的最上层图像元素，递归结束。",
        assets: imageAssets(bboxAssets),
        boxes: 0,
        detection: {
          ...currentDetection,
          boxes: [],
          scene_only_terminal: sceneOnlyTerminal,
          bbox_padding_px: bboxPaddingPx,
          use_model_output: useModelOutput,
          use_feynobg: useFeynobg,
          auto_matte_routing: autoMatteRouting,
          matte_routing_mode: matteRoutingMode,
          route_summary: routeSummary,
        },
        depth_groups: [],
      });
      break;
    }

    // Namespace each loop's ids so the aggregate detection remains editable
    // even if the controller reuses a short id such as `icon_1` next pass.
    const idMap = new Map(
      topBoxes.map((box, index) => [
        box.id,
        `l${String(loopNumber).padStart(2, "0")}_${box.id || `box_${index + 1}`}`,
      ]),
    );
    // The controller's front_to_back list is authoritative for overlaps.
    // Convert its frontmost-first order into the larger-z-is-front convention
    // used by the PSD/composite exporter instead of relying on bbox array
    // order, which need not match the image's visible depth order.
    const requestedFrontOrder = (currentDetection.occlusion_tree?.front_to_back || [])
      .map(String)
      .filter((id) => topBoxes.some((box) => String(box.id) === id));
    const frontRank = new Map(requestedFrontOrder.map((id, index) => [id, index]));
    const loopBoxes = topBoxes.map((box, index) => ({
      ...box,
      // The SVG and bbox were authored in the same controller response. Preserve
      // the model's shared id/bbox before namespacing and extraction padding.
      svg_node_id: svgGuideEnabled ? box.id : null,
      svg_match_bbox: svgGuideEnabled ? box.model_bbox || box.bbox : null,
      svg_parent_id: svgGuideEnabled ? box.svg_parent_id || null : null,
      id: idMap.get(box.id) || `l${String(loopNumber).padStart(2, "0")}_box_${index + 1}`,
      parent_id: box.parent_id ? idMap.get(box.parent_id) || null : null,
      occludes: (box.occludes || []).map((id) => idMap.get(id)).filter(Boolean),
      occluded_by: (box.occluded_by || []).map((id) => idMap.get(id)).filter(Boolean),
      // Keep lower-depth semantic/bbox context on the current layer for both
      // atlas and individual extraction prompts. The ids remain controller
      // references here, not PSD layer ids.
      atlas_negative_boxes: lowerOcclusionPromptBoxes(
        box,
        currentDetection.boxes,
      ),
      z_index: 100000 - loopIndex * 100 + (
        requestedFrontOrder.length
          ? requestedFrontOrder.length - (frontRank.get(String(box.id)) ?? requestedFrontOrder.length - index)
          : index
      ),
      loop: loopNumber,
    }));
    report({
      id: bboxStepId,
      order: 3 + loopIndex * 3,
      status: "completed",
      title: svgGuideEnabled
        ? `Loop ${loopNumber}：${controllerModel} 同步生成 bbox + 全图 SVG`
        : `Loop ${loopNumber}：${controllerModel} 提取最上层 bbox`,
      description: svgGuideEnabled
        ? `单次 ${controllerModel} 请求完成：完整 SVG 共 ${loopSvgGuideState.nodes.length} 个节点，最上层 bbox ${loopBoxes.length} 个；同批 ID/类别/坐标包围校验全部通过。输入：${rel(loopSvgGuideState.source)}；请求：${rel(loopSvgGuideState.requestPath)}；原始返回：${rel(loopSvgGuideState.rawPath)}；bbox：${rel(loopSvgGuideState.analysisPath)}；SVG：${rel(loopSvgGuideState.svgPath)}；SVG 预览：${rel(loopSvgGuideState.previewPath)}；同步记录：${rel(loopSvgGuideState.syncPath)}。`
        : `本轮确认 ${loopBoxes.length} 个当前最上层 bbox；使用 controller 首次输出，并按遮挡关系筛选，未执行二次复核。红框图：${rel(proposalReview)}。`,
      assets: imageAssets(bboxAssets),
      boxes: loopBoxes.length,
      detection: { ...currentDetection, boxes: loopBoxes },
      depth_groups: [{ depth: loopIndex, ids: loopBoxes.map((box) => box.id) }],
    });
    aggregateBoxes.push(...loopBoxes);

    const matteStepId = `loop_${loopNumber}_matte`;
    report({
      id: matteStepId,
      order: 4 + loopIndex * 3,
      status: "running",
      title: `Loop ${loopNumber}：${imageModel} 描述抠取最上层`,
      description: `只处理本轮 ${loopBoxes.length} 个 bbox，不触碰下一层。`,
      progress: { current: 0, total: loopBoxes.length },
      assets: imageAssets([
        [current, `Loop ${loopNumber} 抠图输入`, "working-source"],
        [modelInput, `Loop ${loopNumber} bbox 模型输入`, "model_input"],
      ]),
    });
    const layers = [];
    const matteAssets = [];
    const atlasAssets = [];
    const fallbackEvents = [];
    let activeRequest = null;
    // Gemini's per-bbox remove_by_matte recommendation is the sole route
    // selector: true uses the original crop directly with FeyNobg; false is
    // sent to GPT Image 2.5 Flare max Atlas or an individual Flare request.
    const compactAtlas = isGptImageModel(imageModel) || isVolcengineImageProvider(imageModel);
    const modelAtlasSize = atlasSizeForImageModel(imageModel, atlasSize);
    const useAtlas = atlasEnabled !== false;
    let completed = 0;
    const matteFallbackReasons = new Map();
    const appendLayer = (layer, box, fallbackReason = null) => {
      layer.depth = loopIndex;
      layer.loop = loopNumber;
      layer.z_index = box.z_index;
      layer.svg_node_id = box.svg_node_id || null;
      layer.svg_match_bbox = box.svg_match_bbox || box.model_bbox || box.bbox;
      layer.svg_parent_id = box.svg_parent_id || null;
      layer.remove_by_matte = box.remove_by_matte === true;
      layer.matte_reason = box.matte_reason || "";
      if (matteFallbackReasons.has(box.id)) {
        layer.auto_matte_fallback = true;
        layer.auto_matte_fallback_reason = matteFallbackReasons.get(box.id);
      }
      if (fallbackReason) {
        layer.atlas_fallback = true;
        layer.atlas_fallback_reason = fallbackReason;
      }
      layer.extraction_route = layer.seedream_skipped && layer.feynobg_used
        ? "feynobg_direct"
        : layer.atlas_batch !== undefined && layer.atlas_batch !== null
          ? "seedream_atlas"
          : "individual_image_model";
      layers.push(layer);
      allLayers.push(layer);
      matteAssets.push(asset(layer.source, layer.name, "cutout"));
      completed += 1;
    };
    const reportMatteProgress = (description, status = "running", extra = {}) => {
      report({
        id: matteStepId,
        order: 4 + loopIndex * 3,
        status,
        title: `Loop ${loopNumber}: ${imageModel} atlas extraction`,
        description,
        progress: { current: completed, total: loopBoxes.length },
        assets: [
          ...imageAssets([
            [current, `Loop ${loopNumber} 抠图输入`, "working-source"],
            [modelInput, `Loop ${loopNumber} bbox 模型输入`, "model_input"],
          ]),
          ...atlasAssets,
          ...matteAssets,
        ],
        route_summary: routeSummary,
        fallback_events: fallbackEvents.slice(),
        active_request: activeRequest,
        cutouts: allLayers.length,
        ...extra,
      });
    };
    const summarizeExtractedRoutes = (items) => {
      const byRoute = (route) => items.filter((layer) => layer.extraction_route === route);
      const direct = byRoute("feynobg_direct");
      const atlas = byRoute("seedream_atlas");
      const individual = byRoute("individual_image_model");
      return {
        total_bbox_count: items.length,
        feynobg_direct_bbox_count: direct.length,
        atlas_bbox_count: atlas.length,
        individual_image_model_bbox_count: individual.length,
        feynobg_direct_bbox_ids: direct.map((layer) => String(layer.id)),
        atlas_bbox_ids: atlas.map((layer) => String(layer.id)),
        individual_image_model_bbox_ids: individual.map((layer) => String(layer.id)),
        feynobg_alpha_bbox_count: items.filter((layer) => layer.feynobg_used === true).length,
        atlas_feynobg_alpha_bbox_count: atlas.filter((layer) => layer.feynobg_used === true).length,
      };
    };
    const requestAtlasBatch = async (batch, batchIndex, attempt = 1) => {
      const requestId = `loop_${loopNumber}_atlas_${batchIndex}`;
      const onRequestReady = async (request) => {
        activeRequest = {
          ...request,
          request_id: requestId,
          status: "running",
        };
        const inputAsset = asset(request.input, `batch ${batchIndex} · input atlas`, "atlas-input");
        if (!atlasAssets.some((item) => item.path === inputAsset.path)) atlasAssets.push(inputAsset);
        reportMatteProgress(
          `GPT Image 2.5 Flare max 请求 Atlas 批次 ${batchIndex}（第 ${attempt} 次）`,
          "running",
          { request_attempt: attempt },
        );
      };
      const options = {
        useModelRgb: useModelOutput,
        useFeynobg: false,
        atlasSize: modelAtlasSize,
        requestId,
        attempt,
        onRequestReady,
      };
      if (compactAtlas)
        return extractSeedreamAtlasBatch(
          current,
          batch,
          loopDir,
          batchIndex,
          imageModel,
          signal,
          options,
        );
      return extractForegroundAtlasBatch(
        current,
        batch,
        loopDir,
        batchIndex,
        imageModel,
        signal,
        { size: ATLAS_MAX_SIZE, quality: atlasQuality, ...options },
      );
    };
    const requiredDirectBoxes = autoMatteRouting
      ? loopBoxes.filter((candidate) => candidate.remove_by_matte === true)
      : [];
    const seedreamBoxes = [];
    for (let index = 0; index < loopBoxes.length; index++) {
      const box = loopBoxes[index];
      if (!autoMatteRouting || box.remove_by_matte !== true) {
        seedreamBoxes.push(box);
        continue;
      }
      checkStop();
      try {
        const layer = await retryJobOperation({ request_id: `loop_${loopNumber}_feynobg_${box.id}`, label: `前景抠取 ${box.id}`, input: current, timeout_ms: getRoute("foreground").timeout_ms }, () => extractForegroundWithFeynobg(
          current,
          box,
          loopDir,
          index + 1,
          signal,
        ));
        appendLayer(layer, box);
        atlasAssets.push(...imageAssets([
          [layer.source_crop, `${box.label} · source bbox crop`, "atlas-source"],
          [layer.feynobg_alpha, `${box.label} · direct FeyNobg output`, "atlas-feynobg"],
          [layer.atlas_alpha, `${box.label} · direct FeyNobg alpha`, "atlas-alpha-cell"],
          [layer.bbox_guide, `${box.label} · bbox guide`, "atlas-guide"],
        ]));
        reportMatteProgress(
          `Gemini remove_by_matte=true: direct FeyNobg ${completed}/${loopBoxes.length} ${layer.name}; GPT Image 2.5 Flare skipped`,
          completed === loopBoxes.length ? "completed" : "running",
        );
      } catch (error) {
        const reason = conciseError(error);
        if (!routeSummary) {
          routeSummary = {
            loop: loopNumber,
            total_bbox_count: loopBoxes.length,
            feynobg_direct_bbox_count: requiredDirectBoxes.length,
            atlas_bbox_count: 0,
            individual_image_model_bbox_count: loopBoxes.length - requiredDirectBoxes.length,
            feynobg_direct_bbox_ids: requiredDirectBoxes.map((candidate) => String(candidate.id)),
            atlas_bbox_ids: [],
            individual_image_model_bbox_ids: loopBoxes
              .filter((candidate) => candidate.remove_by_matte !== true)
              .map((candidate) => String(candidate.id)),
            feynobg_alpha_bbox_count: 0,
            atlas_feynobg_alpha_bbox_count: 0,
            atlas_feynobg_alpha_enabled: false,
            per_loop: [],
          };
          routeSummaries.push(routeSummary);
        }
        await fsp.writeFile(
          path.join(loopDir, "cutouts", `${String(index + 1).padStart(3, "0")}_${box.id}_direct_feynobg_error.txt`),
          reason,
          "utf8",
        ).catch(() => {});
        reportMatteProgress(
          `Gemini a=1 direct FeyNobg failed for ${box.id}; workflow stopped: ${reason}`,
          "failed",
        );
        if (error?.feynobgUnavailable || signal?.aborted) throw error;
        throw feynobgUnavailable(reason);
      }
    }
    const requestedBatchSize = compactAtlas
      ? atlasBatchSizeForImageModel(imageModel, atlasBatchSize)
      : Math.max(1, Math.min(64, Math.floor(Number(atlasBatchSize) || 4)));
    const batchMode = compactAtlas && isGptImageModel(imageModel)
      ? GPT_IMAGE_ATLAS_BATCH_MODE
      : null;
    const atlasBatches = compactAtlas
      ? planSeedreamAtlasBatches(seedreamBoxes, requestedBatchSize, modelAtlasSize)
      : planAtlasBatches(seedreamBoxes, requestedBatchSize, ATLAS_MAX_SIZE);
    const routeIds = (items) => items.map((box) => String(box.id));
    const directAutoBoxes = requiredDirectBoxes;
    const atlasBoxes = useAtlas
      ? atlasBatches
        .filter((batchPlan) => batchPlan.mode === "seedream_atlas")
        .flatMap((batchPlan) => batchPlan.boxes || [])
      : [];
    const individualBoxes = useAtlas
      ? atlasBatches
        .filter((batchPlan) => batchPlan.mode === "individual")
        .flatMap((batchPlan) => batchPlan.boxes || [])
      : seedreamBoxes;
    const feynobgDirectIds = [...new Set(routeIds(directAutoBoxes))];
    const atlasIds = [...new Set(routeIds(atlasBoxes))];
    const individualIds = [...new Set(routeIds(individualBoxes))];
    routeSummary = {
      loop: loopNumber,
      total_bbox_count: loopBoxes.length,
      feynobg_direct_bbox_count: feynobgDirectIds.length,
      atlas_bbox_count: atlasIds.length,
      individual_image_model_bbox_count: individualIds.length,
      feynobg_direct_bbox_ids: feynobgDirectIds,
      atlas_bbox_ids: atlasIds,
      individual_image_model_bbox_ids: individualIds,
      atlas_feynobg_alpha_bbox_count: 0,
      atlas_feynobg_alpha_enabled: false,
    };
    routeSummaries.push(routeSummary);
    const routeDescription =
      `Route plan: FeyNobg direct ${routeSummary.feynobg_direct_bbox_count}; ` +
      `GPT Image 2.5 Flare max Atlas ${routeSummary.atlas_bbox_count} (fixed-cell grid, max 7 items/batch); ` +
      `individual GPT Image 2.5 Flare max ${routeSummary.individual_image_model_bbox_count}`;
    reportMatteProgress(routeDescription);
    if (!useAtlas) {
    for (let i = 0; i < seedreamBoxes.length; i++) {
      checkStop();
      const box = seedreamBoxes[i];
      const layer = await retryJobOperation({ request_id: `loop_${loopNumber}_single_${box.id}`, label: `单 bbox 抠取 ${box.id}`, input: current, timeout_ms: getRoute("foreground").timeout_ms }, () => extractGptSingleAtlasBox(
        current,
        box,
        loopDir,
        loopBoxes.indexOf(box) + 1,
        imageModel,
        signal,
        { useModelRgb: useModelOutput, reason: "atlas_disabled" },
      ));
      appendLayer(layer, box);
      reportMatteProgress(
        `GPT Image 2.5 Flare max individual ${completed}/${loopBoxes.length}: ${layer.name}`,
        completed === loopBoxes.length ? "completed" : "running",
      );
    }
    }
    if (useAtlas) {
      let batchIndex = 0;
      for (const batchPlan of atlasBatches) {
        checkStop();
        const batch = batchPlan.boxes;
        batchIndex += 1;
        if (batchPlan.mode === "individual") {
          const box = batch[0];
          const globalIndex = loopBoxes.indexOf(box);
          const layer = await retryJobOperation({ request_id: `loop_${loopNumber}_single_${box.id}`, label: `单 bbox 抠取 ${box.id}`, input: current, timeout_ms: getRoute("foreground").timeout_ms }, () => extractGptSingleAtlasBox(
            current,
            box,
            loopDir,
            globalIndex + 1,
            imageModel,
            signal,
            { useModelRgb: useModelOutput, reason: batchPlan.reason || "bbox_over_gpt_atlas_cell" },
          ));
          appendLayer(layer, box);
          reportMatteProgress(
            `bbox ${box.id} is larger than the available atlas cell; individual request ${completed}/${loopBoxes.length}`,
            completed === loopBoxes.length ? "completed" : "running",
          );
          continue;
        }
        let batchResult = null;
        let attempt = 0;
        while (!batchResult) {
          attempt += 1;
          try {
            batchResult = await requestAtlasBatch(batch, batchIndex, attempt);
            activeRequest = null;
          } catch (error) {
            if (error?.feynobgUnavailable) {
              reportMatteProgress(
                `atlas batch ${batchIndex} FeyNobg failed; workflow stopped: ${conciseError(error)}`,
                "failed",
              );
              throw error;
            }
            const reason = conciseError(error);
            const failedBatchDir = path.join(
              loopDir,
              "seedream_atlas",
              `batch_${String(batchIndex).padStart(2, "0")}`,
            );
            await fsp.mkdir(failedBatchDir, { recursive: true }).catch(() => {});
            await fsp.writeFile(
              path.join(failedBatchDir, "failure_reason.txt"),
              reason,
              "utf8",
            ).catch(() => {});
            const fallbackEvent = {
              loop: loopNumber,
              batch: batchIndex,
              attempt,
              box_ids: batch.map((candidate) => String(candidate.id)),
              reason,
              at: new Date().toISOString(),
              retry_route: waitForAtlasRetry
                ? "manual_same_atlas_request"
                : "individual_gpt_image_2_single_atlas",
            };
            fallbackEvents.push(fallbackEvent);
            activeRequest = {
              ...(activeRequest || {}),
              request_id: activeRequest?.request_id || `loop_${loopNumber}_atlas_${batchIndex}`,
              batch: batchIndex,
              attempt,
              box_ids: fallbackEvent.box_ids,
              status: "failed",
              reason,
              ended_at: new Date().toISOString(),
              retryable: Boolean(waitForAtlasRetry),
            };
            if (waitForAtlasRetry) {
              reportMatteProgress(
                `Atlas 批次 ${batchIndex} 请求失败，等待重试：${reason}`,
                "waiting_retry",
                {
                  fallback_reason: reason,
                  fallback_batch: batchIndex,
                  fallback_box_ids: fallbackEvent.box_ids,
                  retry_request: activeRequest,
                },
              );
              await waitForAtlasRetry(activeRequest);
              checkStop();
              activeRequest = null;
              reportMatteProgress(
                `正在重试 Atlas 批次 ${batchIndex}（第 ${attempt + 1} 次）`,
                "running",
                { request_attempt: attempt + 1 },
              );
              continue;
            }
            reportMatteProgress(
              `atlas batch ${batchIndex} failed; fallback to individual bbox: ${reason}`,
              "running",
              {
                fallback_reason: reason,
                fallback_batch: batchIndex,
                fallback_box_ids: fallbackEvent.box_ids,
              },
            );
            for (const box of batch) {
              checkStop();
              const globalIndex = loopBoxes.indexOf(box);
              let layer;
              try {
                layer = await retryJobOperation({ request_id: `loop_${loopNumber}_single_${box.id}`, label: `单 bbox 抠取 ${box.id}`, input: current, timeout_ms: getRoute("foreground").timeout_ms }, () => extractGptSingleAtlasBox(
                  current,
                  box,
                  loopDir,
                  globalIndex + 1,
                  imageModel,
                  signal,
                  { useModelRgb: useModelOutput, reason },
                ));
              } catch (retryError) {
                const retryReason = conciseError(retryError);
                await fsp.writeFile(
                  path.join(failedBatchDir, `${safeId(box.id, `box_${globalIndex + 1}`)}_retry_failure_reason.txt`),
                  retryReason,
                  "utf8",
                ).catch(() => {});
                throw retryError;
              }
              appendLayer(layer, box, reason);
              reportMatteProgress(
                `fallback ${completed}/${loopBoxes.length}: ${layer.name}`,
                completed === loopBoxes.length ? "completed" : "running",
              );
            }
            break;
          }
        }
        if (!batchResult) continue;
        const batchDebugFiles = [
          [batchResult.input, `batch ${batchIndex} · input atlas`, "atlas-input"],
          [batchResult.generated, `batch ${batchIndex} · GPT Image 2.5 Flare max model.png`, "atlas-model"],
          [batchResult.inferredAlpha, `batch ${batchIndex} · raw model alpha.png`, "atlas-model-alpha"],
          [batchResult.alpha, `batch ${batchIndex} · validated final alpha.png`, "atlas-alpha"],
          [batchResult.atlas, `batch ${batchIndex} · final atlas.png (GPT Image 2.5 Flare max 原始返回)`, "atlas-output"],
          ...batchResult.layers.flatMap((layer, index) => [
            [layer.source_crop, `batch ${batchIndex} · cell ${index + 1} source crop`, "atlas-source"],
            [layer.model_crop, `batch ${batchIndex} · cell ${index + 1} model crop（模型 Alpha 紧边界直接拆分）`, "atlas-model-cell"],
            [layer.source, `batch ${batchIndex} · cell ${index + 1} final cutout（模型 cell RGBA 直接拆分）`, "atlas-final-cutout"],
            [layer.matte_input, `batch ${batchIndex} · cell ${index + 1} matte input${layer.atlas_alignment?.valid ? " (model)" : " (source fallback)"}`, "atlas-matte-input"],
            [layer.feynobg_alpha, `batch ${batchIndex} · cell ${index + 1} FeyNobg output`, "atlas-feynobg"],
            [layer.atlas_alpha, `batch ${batchIndex} · cell ${index + 1} alpha`, "atlas-alpha-cell"],
            [layer.bbox_guide, `batch ${batchIndex} · cell ${index + 1} bbox guide`, "atlas-guide"],
          ]),
        ];
        // The atlas cell crop is now the final model-rendered layer. Remove
        // the legacy labels that described it as alpha-only/source-RGB and
        // publish explicit direct-model cards instead.
        const visibleBatchDebugFiles = batchDebugFiles.filter(([, , kind]) =>
          kind !== "atlas-model-cell" && kind !== "atlas-final-cutout",
        );
        atlasAssets.push(...imageAssets(visibleBatchDebugFiles));
        atlasAssets.push(...imageAssets(batchResult.layers.flatMap((layer, index) => [
          [layer.model_crop, `batch ${batchIndex} 路 cell ${index + 1} model crop（模型直接拆分结果）`, "atlas-model-cell"],
          [layer.source, `batch ${batchIndex} 路 cell ${index + 1} final cutout（模型图集拆分结果）`, "atlas-final-cutout"],
        ])));
        const byId = new Map(batchResult.layers.map((layer) => [layer.id, layer]));
        const batchLayers = batch.map((box) => {
          const layer = byId.get(box.id);
          if (!layer)
            throw new Error(`atlas batch ${batchIndex} did not return ${box.id}`);
          return layer;
        });
        for (let index = 0; index < batch.length; index++) {
          const box = batch[index];
          const layer = batchLayers[index];
          appendLayer(layer, box);
          reportMatteProgress(
            `atlas batch ${batchIndex}: ${completed}/${loopBoxes.length} ${layer.name}`,
            completed === loopBoxes.length ? "completed" : "running",
          );
        }
      }
    }
    // The planner above describes the intended route.  Replace its counts
    // with the routes actually completed so an Atlas->individual recovery
    // (for a non-FeyNobg Atlas error) is visible and never reported as Atlas.
    routeSummary = {
      ...routeSummary,
      ...summarizeExtractedRoutes(layers),
      fallback_events: fallbackEvents.slice(),
      atlas_feynobg_alpha_enabled: false,
    };
    reportMatteProgress(
      `Route result: FeyNobg direct ${routeSummary.feynobg_direct_bbox_count}; ` +
        `GPT Image 2.5 Flare max Atlas ${routeSummary.atlas_bbox_count} (fixed-cell grid); ` +
        `individual GPT Image 2.5 Flare max ${routeSummary.individual_image_model_bbox_count}; ` +
        `FeyNobg alpha ${routeSummary.feynobg_alpha_bbox_count}`,
      "completed",
    );

    let svgResidualGuide = null;
    if (loopSvgGuideState) {
      const svgStepId = `loop_${loopNumber}_svg_residual`;
      report({
        id: svgStepId,
        order: 4.5 + loopIndex * 3,
        status: "running",
        title: `Loop ${loopNumber}：删除 SVG 已抠出节点`,
        description: "将本轮成功抠出的 layer 与 SVG 节点严格匹配；匹配失败会直接终止任务。",
        assets: imageAssets([
          [loopSvgGuideState.previewPath, "本轮同批完整场景 SVG 预览", "svg-preview"],
        ]),
      });
      try {
        const matches = matchLayersToSvgNodes(
          loopSvgGuideState.nodes,
          layers,
          loopSvgGuideState.hiddenIds,
          { strictIds: true },
        );
        svgResidualGuide = await renderRequiredResidualGuide(
          loopSvgGuideState,
          loopDir,
          loopNumber,
          matches,
          meta.width,
          meta.height,
        );
      } catch (error) {
        await fsp.writeFile(
          path.join(loopDir, "svg_match_failure.json"),
          JSON.stringify(
            {
              loop: loopNumber,
              layer_ids: layers.map((layer) => String(layer.id || "")),
              error: String(error?.message || error),
            },
            null,
            2,
          ),
          "utf8",
        );
        report({
          id: svgStepId,
          order: 4.5 + loopIndex * 3,
          status: "failed",
          title: `Loop ${loopNumber}：删除 SVG 已抠出节点`,
          description: `SVG 节点严格匹配失败：${String(error?.message || error)}`,
          assets: imageAssets([
            [loopSvgGuideState.previewPath, "本轮同批完整场景 SVG 预览", "svg-preview"],
            [path.join(loopDir, "svg_match_failure.json"), "SVG 匹配失败记录", "svg-match-error"],
          ]),
          failure_reason: String(error?.message || error),
        });
        throw error;
      }
      report({
        id: svgStepId,
        order: 4.5 + loopIndex * 3,
        status: "completed",
        title: `Loop ${loopNumber}：删除 SVG 已抠出节点`,
        description: `已隐藏 ${svgResidualGuide.matches.length} 个 SVG 节点（${svgResidualGuide.matches.map((item) => item.node_id).join(", ")}）。红框审查图显示删除前的 SVG 顶层 bbox；residual 只移除这些顶层节点，保留其 slot/panel 支撑面。生成本轮残差：${rel(svgResidualGuide.svgPath)}；预览：${rel(svgResidualGuide.png)}；匹配记录：${rel(path.join(loopDir, "svg_match.json"))}。`,
        assets: imageAssets([
          [loopSvgGuideState.previewPath, "本轮同批完整场景 SVG 预览", "svg-preview"],
          [loopSvgGuideState.topBboxReviewPath, "删除前：SVG 顶层 bbox 红框审查", "svg-top-bbox-review"],
          [svgResidualGuide.svgPath, "本轮 residual.svg", "svg-residual"],
          [svgResidualGuide.png, "本轮 residual.svg 预览（补图输入）", "svg-residual-preview"],
        ]),
        svg_guide: {
          hidden_ids: svgResidualGuide.hiddenIds,
          matches: svgResidualGuide.matches,
          paired_model_nodes: svgResidualGuide.matches.filter((item) => item.match_mode === "paired_model_id").length,
          residual: svgResidualGuide.svgPath,
          preview: svgResidualGuide.png,
        },
      });
    }

    const backgroundStepId = `loop_${loopNumber}_background`;
    report({
      id: backgroundStepId,
      order: 5 + loopIndex * 3,
      status: "running",
      title: flatSegmentBackground
        ? `Loop ${loopNumber}：Atlas 批量生成平涂分区 mask`
        : threeImageBackground
          ? `Loop ${loopNumber}：三图输入生成底图`
          : `Loop ${loopNumber}：GPT Image 2.5 Sunburst max 补全被挖空背景`,
      description: flatSegmentBackground
        ? `前景 Atlas 已完成；平涂分区按铺满画布的固定 cell Atlas 并行生成，核对所有目标后合并为严格二值删除 mask。`
        : threeImageBackground
          ? "生成透明洞底图和保留元素二值引导；Sunburst 补图一次，整张返回图等比对齐后直接用于下一轮。"
          : "使用 Sunburst max 只移除本轮前景并补齐当前底图，生成下一轮输入。",
      progress: flatSegmentBackground ? { current: 0, total: loopBoxes.length } : null,
      assets: imageAssets([
        [current, "本轮补图输入（当前底图）", "background-source"],
        [svgResidualGuide?.png, "本轮 residual.svg 预览（补图结构输入）", "svg-residual-preview"],
      ]),
    });
    const background = await makeBackground(
      current,
      layers,
      loopDir,
      imageModel,
      signal,
      {
        referenceBoxes: backgroundReferenceBoxes,
        svgGuide: svgResidualGuide,
        flatSegmentBoxes: flatSegmentBackground ? loopBoxes : null,
        waitForAtlasRetry,
        loopNumber,
        onFlatSegmentProgress: threeImageBackground ? (progress) => report({
          id: backgroundStepId,
          order: 5 + loopIndex * 3,
          status: progress.status || "running",
          active_request: progress.active_request ?? null,
          title: progress.stage === "repair"
            ? `Loop ${loopNumber}：Sunburst max 生成底图`
            : progress.stage === "preservation"
              ? `Loop ${loopNumber}：Gemini 清点保留内容`
            : progress.stage === "structure"
              ? `Loop ${loopNumber}：Sunburst max 生成黑白透明 flat segment`
              : progress.stage === "atlas"
                ? `Loop ${loopNumber}：批量生成平涂分区 mask Atlas ${progress.batch || 0}/${progress.batches || 0}`
              : `Loop ${loopNumber}：并行生成平涂分区 mask`,
          description: progress.status === "waiting_retry"
            ? progress.stage === "structure"
              ? `黑白透明分割图生成失败：${progress.active_request.reason}；等待重试，已完成的前景和 mask 保留。`
              : `平涂分区 mask Atlas ${progress.batch}/${progress.batches} 请求失败：${progress.active_request.reason}；等待重试，已完成 ${progress.current}/${progress.total} 个 bbox。`
            : progress.stage === "repair"
            ? progress.preservation_status === "unavailable"
              ? "Gemini 清点未返回完整结果；Sunburst 根据三张普通图片直接补图。"
              : "Sunburst 参考保留清单和透明洞底图生成整张底图。"
            : progress.stage === "preservation"
              ? "Gemini 只清点仍可见的保留元素；不生成坐标、证据点或删除指令。"
            : progress.stage === "structure"
              ? "Sunburst max 根据黑洞底图和透明洞底图生成一次整图分割；随后由 Gemini 快速清点遗漏的保留元素。"
              : progress.stage === "atlas"
                ? `固定 cell Atlas 已完成 ${progress.current}/${progress.total} 个 bbox；本批次 ${progress.batch || 0}/${progress.batches || 0}，每批最多 7 个目标、最多 4 批并行。${progress.automatic_attempt > 1 ? ` 本批自动重试：第 ${progress.automatic_attempt}/3 次生成。` : ""}`
              : `已完成 ${progress.current}/${progress.total} 个 bbox 的平涂分区。`,
          progress: { current: progress.current, total: progress.total },
          assets: imageAssets([
            ...(progress.atlas_batches || []).flatMap((batch) => [
              [batch.input, `Atlas ${batch.batch} 输入`, "atlas-input"],
              [batch.model_raw, `Atlas ${batch.batch} 模型输出`, "atlas-model"],
              [batch.normalized, `Atlas ${batch.batch} 二值化`, "atlas-mask"],
            ]),
            [path.join(loopDir, "flat_segment_binary_mask.png"), "严格二值删除 mask", "mask"],
            [path.join(loopDir, "flat_segment_union_mask.png"), "平涂与 Atlas 并集 mask", "mask"],
            [path.join(loopDir, "flat_segment_delete_mask.png"), "实际删除 mask（边缘外扩）", "mask"],
            [path.join(loopDir, "background_guide_model_raw.png"), "flat segment 模型原图（黑洞、白元素、透明背景）", "background-flat-segment"],
            [path.join(loopDir, "background_guide_segment.png"), "flat segment：按实际透明洞核对删除范围", "background-flat-segment"],
            [path.join(loopDir, "background_guide_white.png"), "删除黑块后的白色透明图", "background-white-segment"],
            [path.join(loopDir, "background_preservation_atlas.png"), "Gemini 保留内容逐格核对图集", "background-preservation-atlas"],
            [current, "模型输入 1/3：当前 loop 底图", "background-source"],
            [path.join(loopDir, "background_input.png"), "模型输入 2/3：透明洞底图", "background-transparent"],
            [path.join(loopDir, "background_guide_binary.png"), "模型输入 3/3：保留元素二值图（普通图片）", "background-binary-guide"],
          ]),
        }) : null,
        protectOutsideMask,
      },
    );
    const backgroundRepairAssets = [];
    report({
      id: backgroundStepId,
      order: 5 + loopIndex * 3,
      status: "completed",
      title: `Loop ${loopNumber}：GPT Image 2.5 Sunburst max 补全被挖空背景`,
       description: threeImageBackground
          ? `Sunburst 的整张返回图仅按原画布等比对齐，未做局部 mask 合成；下一轮直接使用：${rel(background)}。`
         : `本轮补图完成；Sunburst max 原始返回已原样复制为下一 loop 的当前输入：${rel(background)}。background_protected 仅作保护对比预览，不进入下一轮。`,
      assets: imageAssets([
        ...(!threeImageBackground ? [[current, "本轮补图输入（当前底图）", "background-source"]] : []),
        ...backgroundRepairAssets,
        [path.join(loopDir, "flat_segment_bbox_guide.png"), "flat segment bbox 参考图", "model_input"],
        ...Array.from({ length: loopBoxes.length }, (_, index) => [
          [path.join(loopDir, "flat_segment_atlas", `batch_${String(index + 1).padStart(2, "0")}`, "input.png"), `Atlas ${index + 1} 输入`, "atlas-input"],
          [path.join(loopDir, "flat_segment_atlas", `batch_${String(index + 1).padStart(2, "0")}`, "model_raw.png"), `Atlas ${index + 1} 模型输出`, "atlas-model"],
          [path.join(loopDir, "flat_segment_atlas", `batch_${String(index + 1).padStart(2, "0")}`, "normalized.png"), `Atlas ${index + 1} 二值化`, "atlas-mask"],
        ]).flat(),
        [path.join(loopDir, "flat_segment_normalized.png"), "平涂分区标准化", "mask"],
        [path.join(loopDir, "flat_segment_binary_mask.png"), "平涂分区二值 mask", "mask"],
        [path.join(loopDir, "flat_segment_union_mask.png"), "平涂与 Atlas 并集 mask", "mask"],
        [path.join(loopDir, "flat_segment_delete_mask.png"), "实际删除 mask（边缘外扩）", "mask"],
        [svgResidualGuide?.svgPath, "本轮 residual.svg", "svg-residual"],
        [svgResidualGuide?.png, "本轮 residual.svg 预览（Sunburst max 输入）", "svg-residual-preview"],
        ...(!threeImageBackground ? [[path.join(loopDir, "background_protected.png"), "本轮 mask 外保护后的背景", "background-protected"]] : []),
        ...(threeImageBackground ? [
          [path.join(loopDir, "background_guide_model_raw.png"), "flat segment 模型原图（黑洞、白元素、透明背景）", "background-flat-segment"],
          [path.join(loopDir, "background_guide_segment.png"), "flat segment：按实际透明洞核对删除范围", "background-flat-segment"],
          [path.join(loopDir, "background_guide_white.png"), "删除黑块后的白色透明图", "background-white-segment"],
          [path.join(loopDir, "background_preservation_atlas.png"), "Gemini 保留内容逐格核对图集", "background-preservation-atlas"],
          [current, "模型输入 1/3：当前 loop 底图", "background-source"],
          [path.join(loopDir, "background_input.png"), "模型输入 2/3：透明洞底图", "background-transparent"],
          [path.join(loopDir, "background_guide_binary.png"), "模型输入 3/3：保留元素二值图（普通图片）", "background-binary-guide"],
        ] : [
          [path.join(loopDir, "background_mask.png"), "本轮前景遮罩", "mask"],
          [path.join(loopDir, "background_mask_openai.png"), "Sunburst 原生 mask（含 alpha）", "mask-api"],
          [path.join(loopDir, "background_input.png"), "背景图输入（前景挖成黑洞）", "background-input"],
        ]),
        [path.join(loopDir, "background_model_native.png"), "Sunburst max 模型返回（未经缩放）", "background-native"],
        [path.join(loopDir, "background_model_raw.png"), threeImageBackground
          ? "Sunburst max 完整补图（等比缩放到原画布）"
          : "Sunburst max 补图（原始返回，直接作为下一轮底图）", "background"],
        [background, "下一 loop 当前底图", "background"],
      ]),
      loops: loopNumber,
      cutouts: allLayers.length,
    });
    const pair = {
      loop: loopNumber,
      input: current,
      bbox: loopBoxes,
      bbox_review_enabled: bboxReview,
      bbox_original_image: useOriginalGeminiImage,
      bbox_padding_px: bboxPaddingPx,
      use_model_output: useModelOutput,
      use_feynobg: useFeynobg,
      route_summary: routeSummary,
      background_model: BACKGROUND_REPAIR_MODEL,
      background_repair_mode: backgroundRepairMode,
      flat_segment_background: flatSegmentBackground,
      auto_matte_routing: autoMatteRouting,
      matte_routing_mode: matteRoutingMode,
      atlas_enabled: useAtlas,
      atlas_batch_size: useAtlas ? requestedBatchSize : null,
      atlas_batch_mode: useAtlas ? batchMode : null,
      // Both fields intentionally point to the original first-pass response;
      // `bbox_corrected` is retained as a compatibility alias for old clients.
      bbox_initial: proposed.boxes,
      bbox_raw: proposed.boxes,
      bbox_corrected: proposed.boxes,
      bbox_depth_filtered: topBoxes,
      layers,
      background,
      svg_guide: svgResidualGuide
        ? {
            scene: loopSvgGuideState.svgPath,
            scene_preview: loopSvgGuideState.previewPath,
            residual: svgResidualGuide.svgPath,
            preview: svgResidualGuide.png,
            hidden_ids: svgResidualGuide.hiddenIds,
            matches: svgResidualGuide.matches,
            sync: loopSvgGuideState.syncPath,
            request: loopSvgGuideState.requestPath,
            raw_response: loopSvgGuideState.rawPath,
            top_bbox_review: loopSvgGuideState.topBboxReviewPath,
          }
        : null,
      text_detection: textDetection,
    };
    await fsp.writeFile(
      path.join(loopDir, "pair.json"),
      JSON.stringify(pair, null, 2),
    );
    await fsp.writeFile(
      path.join(loopDir, "detection.json"),
      JSON.stringify(
        {
          ...currentDetection,
          boxes: loopBoxes,
          selected_ids: loopBoxes.map((box) => box.id),
          loop: loopNumber,
           bbox_padding_px: bboxPaddingPx,
           use_model_output: useModelOutput,
           use_feynobg: useFeynobg,
           auto_matte_routing: autoMatteRouting,
           matte_routing_mode: matteRoutingMode,
           route_summary: routeSummary,
         },
        null,
        2,
      ),
    );
      records.push({
        loop: loopNumber,
        input: current,
        bbox: loopBoxes,
        layers,
        background,
        svg_guide: svgResidualGuide
          ? {
              scene: loopSvgGuideState.svgPath,
              scene_preview: loopSvgGuideState.previewPath,
              residual: svgResidualGuide.svgPath,
              preview: svgResidualGuide.png,
              hidden_ids: svgResidualGuide.hiddenIds,
              matches: svgResidualGuide.matches,
              sync: loopSvgGuideState.syncPath,
              request: loopSvgGuideState.requestPath,
              raw_response: loopSvgGuideState.rawPath,
              top_bbox_review: loopSvgGuideState.topBboxReviewPath,
            }
          : null,
        route_summary: routeSummary,
        bbox_review_enabled: bboxReview,
    });
    current = background;
  }

  const finalBackground = current;
  const aggregateRouteSummary = {
    total_bbox_count: routeSummaries.reduce(
      (total, summary) => total + Number(summary?.total_bbox_count || 0),
      0,
    ),
    feynobg_direct_bbox_count: allLayers.filter(
      (layer) => layer.extraction_route === "feynobg_direct",
    ).length,
    atlas_bbox_count: allLayers.filter(
      (layer) => layer.extraction_route === "seedream_atlas",
    ).length,
    individual_image_model_bbox_count: allLayers.filter(
      (layer) => layer.extraction_route === "individual_image_model",
    ).length,
    feynobg_alpha_bbox_count: allLayers.filter(
      (layer) => layer.feynobg_used === true,
    ).length,
    atlas_feynobg_alpha_bbox_count: allLayers.filter(
      (layer) => layer.extraction_route === "seedream_atlas" && layer.feynobg_used === true,
    ).length,
    feynobg_direct_bbox_ids: allLayers
      .filter((layer) => layer.extraction_route === "feynobg_direct")
      .map((layer) => String(layer.id)),
    atlas_bbox_ids: allLayers
      .filter((layer) => layer.extraction_route === "seedream_atlas")
      .map((layer) => String(layer.id)),
    individual_image_model_bbox_ids: allLayers
      .filter((layer) => layer.extraction_route === "individual_image_model")
      .map((layer) => String(layer.id)),
    fallback_events: routeSummaries.flatMap((summary) =>
      Array.isArray(summary?.fallback_events) ? summary.fallback_events : [],
    ),
    per_loop: routeSummaries,
  };
  const frontToBack = [
    ...text.map((box) => box.id),
    ...allLayers
      .slice()
      .sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0))
      .map((layer) => layer.id),
  ];
  const finalDetection = normalizeDetection(
    {
      canvas: { width: meta.width, height: meta.height },
      scene_summary: "Recursive top-layer extraction",
      background_repair: {
        mode: "scene",
        reason: "iterative local inpainting",
        refinement: backgroundRepairMode,
      },
      boxes: aggregateBoxes,
      occlusion_tree: { front_to_back: frontToBack, roots: [] },
    },
    meta.width,
    meta.height,
  );
  finalDetection.loop = records.length;
  finalDetection.source = sourceAbs;
  finalDetection.bbox_mode = svgGuideEnabled ? "synchronized_bbox_svg" : "recursive_top_layer";
  finalDetection.bbox_strategy = svgGuideEnabled
    ? "one_controller_request_per_loop_top_bbox_plus_full_scene_svg"
    : "text_once_then_top_layer_each_loop";
  finalDetection.bbox_controller_model = controllerModel;
  finalDetection.bbox_reasoning_effort = svgGuideEnabled
    ? (controllerModel === "gpt-6-astra" ? "high" : null)
    : isReasoningControllerModel(controllerModel) ? "low" : null;
  finalDetection.bbox_original_image = useOriginalGeminiImage;
  finalDetection.bbox_padding_px = bboxPaddingPx;
  finalDetection.use_model_output = useModelOutput;
  finalDetection.use_feynobg = useFeynobg;
  finalDetection.svg_guide_enabled = svgGuideEnabled;
  finalDetection.svg_guide_required = svgGuideEnabled;
  finalDetection.svg_guide_requested = svgGuideEnabled;
  finalDetection.svg_guide = svgGuideState
    ? {
        model: svgGuideState.model,
        scene: svgGuideState.svgPath,
        preview: svgGuideState.previewPath,
        coordinate_reference: svgGuideState.coordinateReferencePath,
        request: svgGuideState.requestPath,
        raw_response: svgGuideState.rawPath,
        top_bbox_review: svgGuideState.topBboxReviewPath,
        response_meta: svgGuideState.responseMetaPath,
        scene_json: svgGuideState.sceneJsonPath,
        sync: svgGuideState.syncPath,
        loop: svgGuideState.loop,
        node_count: svgGuideState.nodes.length,
        hidden_ids: [...svgGuideState.hiddenIds],
        per_loop: svgGuideHistory,
      }
    : null;
  finalDetection.protect_outside_mask = protectOutsideMask;
  finalDetection.auto_matte_routing = autoMatteRouting;
  finalDetection.matte_routing_mode = matteRoutingMode;
  finalDetection.termination = termination;
  finalDetection.feynobg_failure_policy = "abort_no_llm_fallback";
  const finalAtlasEnabled = atlasEnabled !== false;
  const finalCompactAtlas = isGptImageModel(imageModel) || isVolcengineImageProvider(imageModel);
  const finalModelAtlasSize = atlasSizeForImageModel(imageModel, atlasSize);
  const finalAtlasBatchSize = finalCompactAtlas
    ? atlasBatchSizeForImageModel(imageModel, atlasBatchSize)
    : Math.max(1, Math.min(64, Math.floor(Number(atlasBatchSize) || 4)));
  const finalAtlasBatchMode = finalCompactAtlas && isGptImageModel(imageModel)
    ? GPT_IMAGE_ATLAS_BATCH_MODE
    : null;
  finalDetection.text_detection = textDetection;
  finalDetection.text_cleanup_fallback = textCleanupFallback;
  finalDetection.bbox_review = bboxReview;
  finalDetection.atlas_enabled = finalAtlasEnabled;
  finalDetection.atlas_batch_size = finalAtlasEnabled ? finalAtlasBatchSize : null;
  finalDetection.atlas_batch_mode = finalAtlasEnabled ? finalAtlasBatchMode : null;
  finalDetection.atlas_size = finalAtlasEnabled
    ? (finalCompactAtlas ? finalModelAtlasSize : atlasSize)
    : null;
  finalDetection.atlas_columns = finalAtlasEnabled
    ? (finalCompactAtlas ? null : atlasColumns)
    : null;
  finalDetection.atlas_quality = finalAtlasEnabled ? atlasQuality : null;
  finalDetection.route_summary = aggregateRouteSummary;
  finalDetection.model_response = {
    loops: records.length,
    text_count: text.length,
    bbox_review_enabled: bboxReview,
    atlas_enabled: finalAtlasEnabled,
    atlas_batch_size: finalAtlasEnabled ? finalAtlasBatchSize : null,
    atlas_batch_mode: finalAtlasEnabled ? finalAtlasBatchMode : null,
    auto_matte_routing: autoMatteRouting,
    matte_routing_mode: matteRoutingMode,
    direct_feynobg_count: allLayers.filter(
      (layer) => layer.seedream_skipped && layer.feynobg_used,
    ).length,
    oversized_feynobg_count: allLayers.filter(
      (layer) => layer.oversized_feynobg_routed,
    ).length,
    oversized_feynobg_fallback_count: allLayers.filter(
      (layer) => layer.oversized_feynobg_fallback,
    ).length,
    direct_feynobg_fallback_count: allLayers.filter((layer) => layer.auto_matte_fallback).length,
    route_summary: aggregateRouteSummary,
  };
  await fsp.writeFile(detectionPath, JSON.stringify(finalDetection, null, 2));
  await Promise.all([
    drawReview(sourceAbs, finalDetection, review, {
      includeText: false,
      showLabels: false,
      colorByDepth: true,
    }),
    drawReview(sourceAbs, finalDetection, reviewAll, {
      includeText: true,
      showLabels: true,
      colorByDepth: false,
    }),
  ]);
  const depthGroupsFinal = records.map((record, index) => ({
    depth: index,
    ids: record.bbox.map((box) => box.id),
  }));
  const textLayers = await buildEditableTextLayers(
    textDetection,
    outputDir,
    meta.width,
    meta.height,
  );
  const planLayers = [
    {
      id: "background_final",
      name: "Background (recursive final)",
      kind: "background",
      role: "background_inpaint",
      source: finalBackground,
      bbox: [0, 0, meta.width, meta.height],
      z_index: 0,
      opacity: 1,
    },
    ...allLayers.map((layer) => ({
      ...layer,
      kind: "foreground",
      role: layer.seedream_skipped && layer.feynobg_used
        ? "foreground_feynobg_cutout"
        : "foreground_img2_cutout",
    })),
  ].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  const autoMatteRoutedCount = allLayers.filter(
    (layer) => layer.auto_matte_routed,
  ).length;
  const oversizedFeynobgCount = allLayers.filter(
    (layer) => layer.oversized_feynobg_routed,
  ).length;
  const oversizedFeynobgFallbackCount = allLayers.filter(
    (layer) => layer.oversized_feynobg_fallback,
  ).length;
  const plan = {
    project: path.parse(sourceAbs).name,
    source_image: sourceAbs,
    canvas: { width: meta.width, height: meta.height },
    layers: planLayers,
    text_layers: textLayers,
    text_layer_count: textLayers.length,
    loops: records,
    detection: finalDetection,
    text_detection: textDetection,
    depth_groups: depthGroupsFinal,
    max_depth: maxDepth,
    bbox_mode: svgGuideEnabled ? "synchronized_bbox_svg" : "recursive_top_layer",
    bbox_controller_model: controllerModel,
    bbox_reasoning_effort: finalDetection.bbox_reasoning_effort,
    bbox_roi: false,
    bbox_review: bboxReview,
    bbox_original_image: useOriginalGeminiImage,
    bbox_padding_px: bboxPaddingPx,
    use_model_output: useModelOutput,
    use_feynobg: useFeynobg,
    svg_guide_enabled: svgGuideEnabled,
    svg_guide_required: svgGuideEnabled,
    svg_guide_requested: svgGuideEnabled,
    flat_segment_background: flatSegmentBackground,
    svg_guide: svgGuideState
      ? {
          model: svgGuideState.model,
          scene: svgGuideState.svgPath,
          preview: svgGuideState.previewPath,
          coordinate_reference: svgGuideState.coordinateReferencePath,
          request: svgGuideState.requestPath,
          raw_response: svgGuideState.rawPath,
          top_bbox_review: svgGuideState.topBboxReviewPath,
          response_meta: svgGuideState.responseMetaPath,
          scene_json: svgGuideState.sceneJsonPath,
          sync: svgGuideState.syncPath,
          loop: svgGuideState.loop,
          node_count: svgGuideState.nodes.length,
          hidden_ids: [...svgGuideState.hiddenIds],
          per_loop: svgGuideHistory,
        }
      : null,
    protect_outside_mask: protectOutsideMask,
    auto_matte_routing: autoMatteRouting,
    matte_routing_mode: matteRoutingMode,
    feynobg_failure_policy: "abort_no_llm_fallback",
    auto_matte_routed_count: autoMatteRoutedCount,
    oversized_feynobg_routed_count: oversizedFeynobgCount,
    oversized_feynobg_fallback_count: oversizedFeynobgFallbackCount,
    feynobg_direct_bbox_count: aggregateRouteSummary.feynobg_direct_bbox_count,
    atlas_bbox_count: aggregateRouteSummary.atlas_bbox_count,
    individual_image_model_bbox_count: aggregateRouteSummary.individual_image_model_bbox_count,
    feynobg_alpha_bbox_count: aggregateRouteSummary.feynobg_alpha_bbox_count,
    route_summary: aggregateRouteSummary,
    bbox_only: false,
    text_cleanup_fallback: textCleanupFallback,
    atlas_enabled: finalAtlasEnabled,
    atlas_batch_size: finalAtlasEnabled ? finalAtlasBatchSize : null,
    atlas_batch_mode: finalAtlasEnabled ? finalAtlasBatchMode : null,
    atlas_size: finalAtlasEnabled
      ? (finalCompactAtlas ? finalModelAtlasSize : atlasSize)
      : null,
    atlas_columns: finalAtlasEnabled
      ? (finalCompactAtlas ? null : atlasColumns)
      : null,
    atlas_quality: finalAtlasEnabled ? atlasQuality : null,
    recursive_top_layer: true,
    shared_bbox_tree: false,
    source_image_excluded: true,
    text_excluded: true,
    matting_model: aggregateRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    extraction_model: aggregateRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    foreground_model: aggregateRouteSummary.feynobg_alpha_bbox_count ? `${imageModel} + FeyNobg` : imageModel,
    termination,
  };
  const planPath = path.join(outputDir, "recursive_layer_plan.json");
  await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  report({
    id: "export",
    order: 6 + records.length * 3,
    status: "running",
    title: "合成预览并导出 PSD",
    description: `将 ${allLayers.length} 个逐轮前景图层与最终补图合成。`,
    assets: imageAssets([
      [finalBackground, "最终背景输入", "background"],
      [review, "最终 bbox 审核图", "review"],
    ]),
  });
  const compositePath = await composite(
    finalBackground,
    [...allLayers, ...textLayers],
    path.join(outputDir, "composite.png"),
    meta.width,
    meta.height,
  );
  let psdPath = null;
  if (psd) psdPath = await exportPsd(plan, psd, compositePath);
  report({
    id: "export",
    order: 6 + records.length * 3,
    status: "completed",
    title: "合成预览并导出 PSD",
    description: `完成 ${records.length} 个递归 loop，生成 ${allLayers.length} 个前景图层；终止原因：${termination}。`,
    assets: imageAssets([
      [review, "最终 bbox 审核图", "review"],
      [compositePath, "PSD 合成预览", "composite"],
    ]),
    detection: finalDetection,
    depth_groups: depthGroupsFinal,
    loops: records.length,
    cutouts: allLayers.length,
  });
  return {
    plan: rel(planPath),
    psd: psdPath ? rel(psdPath) : null,
    composite: rel(compositePath),
    loops: records.length,
    layers: allLayers.length,
    stop: termination,
  };
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function err(res, status, message) {
  json(res, status, { error: message });
}

async function uploadWorkspaceSource(payload, account = DEFAULT_WORKSPACE_ACCOUNT) {
  account = normalizeWorkspaceAccount(account);
  const raw = String(payload?.data || "");
  const match = raw.match(/^data:image\/(png|jpe?g|webp|gif|bmp|svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("仅支持 PNG、JPG、WEBP、GIF、BMP 或 SVG 图片");
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > 25 * 1024 * 1024)
    throw new Error("图片为空或超过 25 MB");
  const mimeExt = String(match[1]).toLowerCase() === "jpeg" || String(match[1]).toLowerCase() === "jpg"
    ? "jpg"
    : String(match[1]).toLowerCase() === "svg+xml" ? "svg" : String(match[1]).toLowerCase();
  const originalName = path.basename(String(payload?.name || `source.${mimeExt}`)).slice(0, 120);
  const stem = (path.parse(originalName).name || "source")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "source";
  const root = accountSourcesRoot(account);
  await fsp.mkdir(root, { recursive: true });
  const destination = path.join(root, `${Date.now()}_${stem}.${mimeExt}`);
  await fsp.writeFile(destination, buffer);
  try {
    await sharp(destination).metadata();
  } catch (error) {
    await fsp.rm(destination, { force: true });
    throw new Error(`图片无法读取：${error.message || error}`);
  }
  return {
    ...asset(destination, originalName, "workspace-upload"),
    workspace_account: account,
  };
}
async function catalog(account = DEFAULT_WORKSPACE_ACCOUNT) {
  account = normalizeWorkspaceAccount(account);
  const entries = await fsp.readdir(ROOT, { withFileTypes: true });
  const sources = [];
  const projects = [];
  let runHistoryCount = 0;
  for (const e of entries) {
    const full = path.join(ROOT, e.name);
    if (e.isFile() && IMAGE_SUFFIXES.has(path.extname(e.name).toLowerCase()))
      sources.push(asset(full, e.name, "workspace"));
    if (
      account === DEFAULT_WORKSPACE_ACCOUNT &&
      e.isDirectory() &&
      e.name !== "web_runs" &&
      !e.name.startsWith("layered_split_unit_test")
    ) {
      const plan = path.join(full, "recursive_layer_plan.json");
      if (fs.existsSync(plan)) {
        const data = JSON.parse(await fsp.readFile(plan, "utf8"));
        projects.push({
          name: data.project || e.name,
          label: `${data.project || e.name} / ${e.name}`,
          folder: e.name,
          path: rel(full),
          source:
            data.source_image && fs.existsSync(data.source_image)
              ? asset(data.source_image, "source", "source")
              : null,
          loops: (data.loops || []).length,
          layers: (data.layers || []).length,
          canvas: data.canvas,
          matting_model: data.matting_model,
          extraction_model: data.extraction_model || data.matting_model,
          foreground_model: data.foreground_model || data.extraction_model || data.matting_model,
          shared_bbox_tree: true,
          max_depth: data.max_depth,
          bbox_mode: data.bbox_mode || data.detection?.bbox_mode,
           bbox_controller_model: data.bbox_controller_model || data.detection?.bbox_controller_model || DEFAULT_BBOX_CONTROLLER_MODEL,
           bbox_roi: data.bbox_roi !== false,
          bbox_review: data.bbox_review !== false,
          bbox_original_image: data.bbox_original_image === true,
          auto_matte_routing: data.auto_matte_routing === true,
          matte_routing_mode: data.matte_routing_mode || (data.auto_matte_routing === true ? "gemini_auto" : "force_model"),
          atlas_enabled: data.atlas_enabled !== false,
          atlas_batch_size: recordedAtlasBatchSize(data),
          atlas_batch_mode: recordedAtlasBatchMode(data),
          atlas_size: recordedAtlasSize(data),
          atlas_columns: data.atlas_columns || null,
          atlas_quality: data.atlas_quality || "low",
          text_cleanup_fallback: data.text_cleanup_fallback === true,
          bottom_up_repair: data.bottom_up_repair === true,
          recursive_top_layer: data.recursive_top_layer === true,
          history: false,
          has_psd: (await fsp.readdir(full)).some((x) => x.endsWith(".psd")),
        });
      }
    }
  }
  const sourceRoot = accountSourcesRoot(account);
  if (fs.existsSync(sourceRoot)) {
    for (const source of await fsp.readdir(sourceRoot, { withFileTypes: true })) {
      if (source.isFile() && IMAGE_SUFFIXES.has(path.extname(source.name).toLowerCase()))
        sources.push(asset(path.join(sourceRoot, source.name), source.name, "workspace-upload"));
    }
  }
  const runRoots = [];
  const ownRunsRoot = accountRunsRoot(account);
  if (fs.existsSync(ownRunsRoot)) {
    for (const run of await fsp.readdir(ownRunsRoot, { withFileTypes: true }))
      if (run.isDirectory() && /^run_[A-Za-z0-9_-]+$/.test(run.name))
        runRoots.push({ full: path.join(ownRunsRoot, run.name), name: run.name });
  }
  // Keep pre-isolation runs visible only in the default workspace.  New runs
  // are always written under web_runs/accounts/<account>.
  if (account === DEFAULT_WORKSPACE_ACCOUNT) {
    const legacyRunsRoot = path.join(ROOT, "web_runs");
    if (fs.existsSync(legacyRunsRoot)) {
      for (const run of await fsp.readdir(legacyRunsRoot, { withFileTypes: true }))
        if (run.isDirectory() && /^run_[A-Za-z0-9_-]+$/.test(run.name))
          runRoots.push({ full: path.join(legacyRunsRoot, run.name), name: run.name });
    }
  }
  for (const run of runRoots) {
    const full = run.full;
    const plan = path.join(full, "recursive_layer_plan.json");
    const experimentPlan = path.join(full, "bbox_mask_delete_plan.json");
    if (!fs.existsSync(plan) && !fs.existsSync(experimentPlan)) continue;
    const data = JSON.parse(await fsp.readFile(fs.existsSync(plan) ? plan : experimentPlan, "utf8"));
    const owner = normalizeWorkspaceAccount(data.workspace_account || (isInside(full, ownRunsRoot) ? account : DEFAULT_WORKSPACE_ACCOUNT));
    if (owner !== account) continue;
    if (data.mode === "bbox_mask_delete_local_experiment") {
      runHistoryCount += 1;
      projects.push({
        name: run.name, label: `bbox mask 删除实验 / ${run.name}`,
        folder: run.name, path: rel(full), workspace_account: owner,
        source: data.source_image && fs.existsSync(data.source_image)
          ? asset(data.source_image, "source", "source") : null,
        loops: data.loops?.length || 0, layers: 0, canvas: data.canvas,
        bbox_mode: "bbox_mask_delete", bbox_mask_delete_mode: true,
        bbox_controller_model: data.controller_model, max_depth: data.max_depth,
        history: true, has_psd: false,
      });
      continue;
    }
    runHistoryCount += 1;
    projects.push({
      name: data.project || run.name,
      label: `${data.project || run.name} / ${run.name}`,
      folder: run.name,
      path: rel(full),
      workspace_account: owner,
      source:
        data.source_image && fs.existsSync(data.source_image)
          ? asset(data.source_image, "source", "source")
          : null,
      loops: (data.loops || []).length,
      layers: (data.layers || []).length,
      canvas: data.canvas,
      matting_model: data.matting_model,
      extraction_model: data.extraction_model || data.matting_model,
      foreground_model: data.foreground_model || data.extraction_model || data.matting_model,
      shared_bbox_tree: true,
      max_depth: data.max_depth,
      bbox_mode: data.bbox_mode || data.detection?.bbox_mode,
      bbox_controller_model: data.bbox_controller_model || data.detection?.bbox_controller_model || DEFAULT_BBOX_CONTROLLER_MODEL,
      bbox_roi: data.bbox_roi !== false,
      bbox_review: data.bbox_review !== false,
      bbox_original_image: data.bbox_original_image === true,
      auto_matte_routing: data.auto_matte_routing === true,
      matte_routing_mode: data.matte_routing_mode || (data.auto_matte_routing === true ? "gemini_auto" : "force_model"),
      atlas_enabled: data.atlas_enabled !== false,
      atlas_batch_size: recordedAtlasBatchSize(data),
      atlas_batch_mode: recordedAtlasBatchMode(data),
      atlas_size: recordedAtlasSize(data),
      atlas_columns: data.atlas_columns || null,
      atlas_quality: data.atlas_quality || "low",
      text_cleanup_fallback: data.text_cleanup_fallback === true,
      bottom_up_repair: data.bottom_up_repair === true,
      recursive_top_layer: data.recursive_top_layer === true,
      history: true,
      has_psd: (await fsp.readdir(full)).some((x) => x.endsWith(".psd")),
    });
  }
  projects.sort((a, b) => {
    const aTime = fs.statSync(path.join(ROOT, a.path)).mtimeMs;
    const bTime = fs.statSync(path.join(ROOT, b.path)).mtimeMs;
    return bTime - aTime;
  });
  sources.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { root: ROOT, projects, sources, run_history_count: runHistoryCount, workspace_account: account, model_config: publicConfig() };
}

async function clearRunHistory(payload, account = DEFAULT_WORKSPACE_ACCOUNT) {
  account = normalizeWorkspaceAccount(account);
  if (payload?.confirm !== "CLEAR_ALL_RUN_HISTORY")
    throw new Error("missing history deletion confirmation");
  const active = [...JOBS.values()].filter((job) =>
    normalizeWorkspaceAccount(job.workspace_account) === account &&
    ["running", "stopping"].includes(job.status),
  );
  if (active.length)
    throw new Error("仍有任务正在执行，请先强制结束后再清理历史");
  const targets = [];
  const ownRunsRoot = path.resolve(accountRunsRoot(account));
  if (fs.existsSync(ownRunsRoot)) {
    for (const entry of await fsp.readdir(ownRunsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^run_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const target = path.resolve(ownRunsRoot, entry.name);
      if (isInside(target, ownRunsRoot)) targets.push(target);
    }
  }
  // Legacy direct runs are only owned by the default workspace.  Never clear
  // another account's nested run directory.
  if (account === DEFAULT_WORKSPACE_ACCOUNT) {
    const legacyRoot = path.resolve(ROOT, "web_runs");
    if (fs.existsSync(legacyRoot)) {
      for (const entry of await fsp.readdir(legacyRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^run_[A-Za-z0-9_-]+$/.test(entry.name)) {
          const target = path.resolve(legacyRoot, entry.name);
          if (isInside(target, legacyRoot)) targets.push(target);
        }
      }
    }
  }
  for (const target of targets) await fsp.rm(target, { recursive: true, force: true });
  for (const [id, job] of JOBS) {
    if (normalizeWorkspaceAccount(job.workspace_account) !== account) continue;
    const output = path.resolve(ROOT, job.output_dir || "");
    if (targets.some((target) => isInside(output, target))) JOBS.delete(id);
  }
  return { deleted: targets.length, runs: targets.map((target) => path.basename(target)) };
}

async function bboxMaskDeleteProjectPayload(dir, account) {
  const plan = JSON.parse(await fsp.readFile(path.join(dir, "bbox_mask_delete_plan.json"), "utf8"));
  const loops = [];
  const records = new Map((plan.loops || []).map((record) => [record.loop, record]));
  const loopNumbers = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^loop_\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(5))).sort((a, b) => a - b);
  for (const loopNumber of loopNumbers) {
    const record = records.get(loopNumber) || { loop: loopNumber, bbox: [] };
    const loopDir = path.join(dir, `loop_${String(loopNumber).padStart(2, "0")}`);
    const detectionPath = path.join(loopDir, "bbox_depth_filtered.json");
    const detection = fs.existsSync(detectionPath)
      ? JSON.parse(await fsp.readFile(detectionPath, "utf8"))
      : { boxes: record.bbox || [] };
    const files = (await fsp.readdir(loopDir))
      .filter((name) => IMAGE_SUFFIXES.has(path.extname(name).toLowerCase()))
      .sort((a, b) => {
        const rank = (name) => name === "input.png" ? -2 : name === "background.png" ? 2 : 0;
        return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });
      })
      .map((name) => asset(path.join(loopDir, name), name,
        name === "input.png" ? "working-source"
          : name === "background.png" ? "background"
            : name.includes("mask") ? "mask" : "step"));
    loops.push({ index: loopNumber, name: `Loop ${loopNumber}: bbox mask 删除`,
      folder: rel(loopDir), steps: files, crops: [], cutouts: [], debug_assets: [],
      detection: { ...detection, box_count: detection.boxes?.length || 0,
        selected_count: record.bbox?.length || 0, text_count: 0 }, pair: record,
      depth: loopNumber - 1 });
  }
  const source = plan.source_image && fs.existsSync(plan.source_image)
    ? asset(plan.source_image, "source", "source") : null;
  const latestDetection = loops.at(-1)?.detection || { boxes: [] };
  return {
    name: "bbox mask 删除实验", label: `bbox mask 删除实验 / ${path.basename(dir)}`,
    run_timing: readRunTiming(dir),
    folder: path.basename(dir), path: rel(dir), workspace_account: account,
    source, source_image: source, canvas: plan.canvas,
    loops: loops.length, loops_data: loops, layers: [], text_layers: [], text_layer_count: 0,
    bbox_mask_delete_mode: true, bbox_mode: "bbox_mask_delete",
    bbox_controller_model: plan.controller_model, mask_model: plan.mask_model,
    delete_model: plan.delete_model, max_depth: plan.max_depth,
    svg_guide_enabled: false, svg_guide_required: false, svg_guide_requested: false,
    detection: latestDetection, depth_groups: [],
    root_assets: source ? [source] : [], psd: null, psd_url: null, has_psd: false,
    final_background: plan.final_background && fs.existsSync(plan.final_background)
      ? asset(plan.final_background, "最终底图", "background") : null,
    status: plan.status,
  };
}
async function projectPayload(raw, account = DEFAULT_WORKSPACE_ACCOUNT) {
  const dir = safePath(raw);
  assertProjectAccess(dir, account);
  if (fs.existsSync(path.join(dir, "bbox_mask_delete_plan.json")))
    return bboxMaskDeleteProjectPayload(dir, account);
  const planPath = path.join(dir, "recursive_layer_plan.json");
  const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
  const rootFiles = [
    ["bbox_candidate.png", "bbox candidate", "proposal"],
    ["bbox_review.png", "bbox review（仅图像元素，按深度着色）", "review"],
    ["bbox_review_all.png", "bbox review（含文字完整审计）", "review-all"],
    ["text_cleanup/text_mask.png", "初始文字区域遮罩", "mask"],
    ["text_cleanup/text_mask_openai.png", "GPT Image 2.5 Sunburst 原生文字 mask", "mask-api"],
    ["text_cleanup/text_inpaint_input.png", "文字黑洞补图输入", "background-input"],
    ["text_cleanup/text_model_source.jpg", "文字分析整图", "model_input"],
    ["text_cleanup/text_bbox_review.png", "文字 bbox 审核图", "review"],
    ["text_cleanup/text_coordinate_reference.png", "文字 SVG 坐标参考图", "svg-input"],
    ["text_cleanup/text_scene.svg", "文字删除前完整场景 SVG", "svg-scene"],
    ["text_cleanup/text_scene.png", "文字删除前完整场景 SVG 预览", "svg-preview"],
    ["text_cleanup/svg_residual.svg", "删除普通文字后的 residual.svg", "svg-residual"],
    ["text_cleanup/svg_residual.png", "删除普通文字后的 residual SVG 预览", "svg-residual-preview"],
    ["text_cleanup/text_clean_generated.png", "初始 AI 去文字生成图", "text-clean-generated"],
    ["text_cleanup/text_clean.png", "初始去文字底图（后续 loop 共用）", "text-clean"],
    ["bottom_up_final_mask.png", "bottom-up 最终 bbox 遮罩", "mask"],
    ["bottom_up_final_background_input.png", "bottom-up 最终背景黑洞输入", "background-input"],
    ["bottom_up_final_background.png", "bottom-up 最终连续背景", "background"],
    ["background_final.png", "23-box repaired background", "background"],
    ["foreground_atlas.png", "23-box foreground atlas", "atlas"],
    ["composite.png", "PSD composite", "composite"],
  ]
    .filter(([f]) => fs.existsSync(path.join(dir, f)))
    .map(([f, l, r]) => asset(path.join(dir, f), l, r));
  const loops = [];
  for (const record of plan.loops || []) {
    const recordBoxes = Array.isArray(record.bbox)
      ? record.bbox
      : Array.isArray(record.selected)
        ? record.selected
        : [];
    const selectedIds = Array.isArray(record.bbox_ids)
      ? record.bbox_ids
      : recordBoxes.map((box) => box.id).filter(Boolean);
    const recordText = Array.isArray(record.text)
      ? record.text
      : Array.isArray(record.text_detection?.boxes)
        ? record.text_detection.boxes
        : [];
    const loopDir = path.join(
      dir,
      `loop_${String(record.loop).padStart(2, "0")}`,
    );
    const files = [];
    const debugAssets = [];
    const collectDebugAssets = async (directory, kind = "atlas") => {
      const entries = (await fsp.readdir(directory, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collectDebugAssets(full, entry.name.toLowerCase().includes("reference") ? "background-reference" : kind);
          continue;
        }
        if (!IMAGE_SUFFIXES.has(path.extname(entry.name).toLowerCase())) continue;
        if (isHiddenBackgroundArtifact(entry.name)) continue;
        const lower = entry.name.toLowerCase();
        let role = kind === "background-reference" ? "background-reference" : "atlas-debug";
        if (lower === "input.png") role = "atlas-input";
        else if (lower === "model.png") role = "atlas-model";
        else if (lower === "alpha.png") role = "atlas-alpha";
        else if (lower === "atlas.png") role = "atlas-output";
        else if (lower === "model_alpha.png") role = "atlas-model-alpha";
        else if (lower.includes("source_crop")) role = "atlas-source";
        else if (lower.includes("model_crop")) role = "atlas-model-cell";
        else if (/^\d+_.+\.png$/i.test(lower) && !/(?:_alpha|_bbox_guide|_matte_input|_feynobg)/i.test(lower)) role = "atlas-final-cutout";
        else if (lower.includes("matte_input")) role = "atlas-matte-input";
        else if (lower.includes("feynobg")) role = "atlas-feynobg";
        else if (lower.includes("_alpha")) role = "atlas-alpha-cell";
        else if (lower.includes("bbox_guide")) role = "atlas-guide";
        debugAssets.push(asset(full, `${kind === "background-reference" ? "background reference" : "atlas debug"} · ${path.relative(loopDir, full).replaceAll(path.sep, "/")}`, role));
      }
    };
    // Keep the semantic loop input in the history payload. For loop 1 this
    // is the exact AI text-removal output (not a separate "clean A" copy);
    // a JPG may also be present when the selected controller uses compression.
    if (record.input && fs.existsSync(record.input)) {
      files.push(
        asset(
          record.input,
          record.loop === 1
            ? "Loop 1 输入（AI 去文字生成图）"
            : `Loop ${record.loop} 输入图`,
          "working-source",
        ),
      );
    }
    if (fs.existsSync(loopDir)) {
      for (const f of await fsp.readdir(loopDir)) {
        const full = path.join(loopDir, f);
        if (
          IMAGE_SUFFIXES.has(path.extname(f).toLowerCase()) &&
          !isHiddenBackgroundArtifact(f)
        ) {
          const guideRole = fs.existsSync(path.join(loopDir, "background_guide_binary.png")) ? {
            "background_input.png": "background-transparent",
            "background_mask.png": "background-transparent",
            "background_guide_model_raw.png": "background-flat-segment",
            "background_guide_segment.png": "background-flat-segment",
            "background_guide_white.png": "background-white-segment",
            "background_guide_binary.png": "background-binary-guide",
            "background_preservation_atlas.png": "background-preservation-atlas",
            "background_semantic_input.png": "background-semantic-input",
            "background_model_native.png": "background-native",
          }[f.toLowerCase()] : null;
          const role = guideRole || (/^background_semantic_context_\d+\.png$/i.test(f) ? "background-semantic-context" : /^background_geometry_context_\d+\.png$/i.test(f) ? "background-geometry-context" : f.toLowerCase() === "scene_top_bbox_review.png"
            ? "svg-top-bbox-review"
            : "step");
          files.push(asset(full, f, role));
        }
        if (f === "crops" || f === "cutouts") {
          for (const child of await fsp.readdir(full)) {
            const childPath = path.join(full, child);
            if (IMAGE_SUFFIXES.has(path.extname(child).toLowerCase()))
              files.push(
                asset(childPath, child, f === "crops" ? "crop" : "cutout"),
              );
          }
        }
        if (f === "seedream_atlas" || f === "background_references")
          await collectDebugAssets(full, f === "background_references" ? "background-reference" : "atlas");
      }
    }
    loops.push({
      index: record.loop,
      name: `loop ${record.loop}`,
      folder: rel(loopDir),
      steps: files,
      crops: files.filter((x) => x.role === "crop"),
      cutouts: files.filter((x) => x.role === "cutout"),
      debug_assets: debugAssets,
      detection: {
        ...plan.detection,
        selected_ids: selectedIds,
        text_ids: recordText.map((x) => x.id),
        box_count: plan.detection?.boxes?.length || 0,
        selected_count: selectedIds.length,
        text_count: recordText.length,
        boxes: plan.detection?.boxes || [],
        occlusion_tree: plan.detection.occlusion_tree,
      },
      pair: record,
      depth: record.depth ?? record.loop - 1,
    });
  }
  const psd = (await fsp.readdir(dir)).find((x) => x.endsWith(".psd"));
  const source = fs.existsSync(plan.source_image)
    ? asset(plan.source_image, "source", "source")
    : null;
  const planImageLayers = Array.isArray(plan.layers) ? plan.layers : [];
  const planTextLayers = Array.isArray(plan.text_layers) ? plan.text_layers : [];
  const exposedLayers = [...planImageLayers, ...planTextLayers];
  const visualLayers = planImageLayers.filter(
    (layer) => layer.kind === "foreground" || layer.role?.includes("foreground"),
  );
  const legacyDirect = visualLayers.filter(
    (layer) => layer.seedream_skipped === true && layer.feynobg_used === true,
  );
  const legacyAtlas = visualLayers.filter(
    (layer) => layer.atlas_batch !== undefined && layer.atlas_batch !== null,
  );
  const legacyIndividual = visualLayers.filter(
    (layer) => !legacyDirect.includes(layer) && !legacyAtlas.includes(layer),
  );
  const routeSummary = plan.route_summary || plan.detection?.route_summary || {
    total_bbox_count: visualLayers.length,
    feynobg_direct_bbox_count: Number(plan.detection?.model_response?.direct_feynobg_count ?? legacyDirect.length),
    atlas_bbox_count: legacyAtlas.length,
    individual_image_model_bbox_count: legacyIndividual.length,
    feynobg_alpha_bbox_count: visualLayers.filter((layer) => layer.feynobg_used === true).length,
    atlas_feynobg_alpha_bbox_count: legacyAtlas.filter((layer) => layer.feynobg_used === true).length,
    feynobg_direct_bbox_ids: legacyDirect.map((layer) => String(layer.id)),
    atlas_bbox_ids: legacyAtlas.map((layer) => String(layer.id)),
    individual_image_model_bbox_ids: legacyIndividual.map((layer) => String(layer.id)),
    per_loop: [],
  };
  return {
    name: plan.project,
    run_timing: readRunTiming(dir),
    workspace_account: normalizeWorkspaceAccount(plan.workspace_account || account),
    label: `${plan.project} / ${path.basename(dir)}`,
    folder: path.basename(dir),
    path: rel(dir),
    source,
    source_image: source,
    canvas: plan.canvas,
    loops: loops.length,
    layers: exposedLayers.length,
    text_layers: planTextLayers.map((layer) => ({
      ...layer,
      source_asset: layer.source && fs.existsSync(layer.source)
        ? asset(layer.source, layer.name, "text-layer-preview")
        : null,
    })),
    text_layer_count: planTextLayers.length,
    matting_model: plan.matting_model,
    extraction_model: plan.extraction_model || plan.matting_model,
    foreground_model: plan.foreground_model || plan.extraction_model || plan.matting_model,
    has_psd: Boolean(psd),
    shared_bbox_tree: plan.shared_bbox_tree === true,
    max_depth: plan.max_depth,
    bbox_mode: plan.bbox_mode || plan.detection?.bbox_mode || "img2_assisted",
    bbox_controller_model: plan.bbox_controller_model || plan.detection?.bbox_controller_model || DEFAULT_BBOX_CONTROLLER_MODEL,
    bbox_reasoning_effort: plan.bbox_reasoning_effort || plan.detection?.bbox_reasoning_effort || null,
    bbox_roi: plan.bbox_roi !== false,
    bbox_review: plan.bbox_review !== false,
    bbox_original_image: plan.bbox_original_image === true,
    bbox_padding_px: clampBboxPadding(plan.bbox_padding_px, 3),
    use_model_output: plan.use_model_output === true,
    use_feynobg: plan.use_feynobg !== false,
    svg_guide_enabled: plan.svg_guide_enabled === true,
    svg_guide_required: plan.svg_guide_required === true,
    svg_guide_requested: plan.svg_guide_requested === true,
    flat_segment_background: plan.flat_segment_background === true,
    svg_guide: plan.svg_guide || null,
    protect_outside_mask: plan.protect_outside_mask !== false,
    auto_matte_routing: plan.auto_matte_routing === true,
    matte_routing_mode: plan.matte_routing_mode || (plan.auto_matte_routing === true ? "gemini_auto" : "force_model"),
    atlas_enabled: plan.atlas_enabled !== false,
    atlas_batch_size: recordedAtlasBatchSize(plan),
    atlas_batch_mode: recordedAtlasBatchMode(plan),
    atlas_size: recordedAtlasSize(plan),
    atlas_columns: plan.atlas_columns || null,
    atlas_quality: plan.atlas_quality || "low",
    route_summary: routeSummary,
    feynobg_failure_policy: plan.feynobg_failure_policy || "abort_no_llm_fallback",
    feynobg_direct_bbox_count: Number(plan.feynobg_direct_bbox_count ?? routeSummary.feynobg_direct_bbox_count ?? 0),
    atlas_bbox_count: Number(plan.atlas_bbox_count ?? routeSummary.atlas_bbox_count ?? 0),
    individual_image_model_bbox_count: Number(plan.individual_image_model_bbox_count ?? routeSummary.individual_image_model_bbox_count ?? 0),
    feynobg_alpha_bbox_count: Number(plan.feynobg_alpha_bbox_count ?? routeSummary.feynobg_alpha_bbox_count ?? 0),
    text_cleanup_fallback: plan.text_cleanup_fallback === true,
    recursive_top_layer: plan.recursive_top_layer === true,
    bottom_up_repair: plan.bottom_up_repair === true,
    bbox_only: plan.bbox_only === true,
    psd: psd ? { name: psd, path: rel(path.join(dir, psd)) } : null,
    psd_url: psd
      ? `/download?path=${encodeURIComponent(rel(path.join(dir, psd))).replaceAll("%2F", "/")}`
      : null,
    root_assets: rootFiles,
    detection: plan.detection,
    depth_groups: plan.depth_groups,
    plan_flags: {
      source_image_excluded: true,
      text_excluded: true,
      matting_model: plan.matting_model,
      extraction_model: plan.extraction_model || plan.matting_model,
      foreground_model: plan.foreground_model || plan.extraction_model || plan.matting_model,
      bbox_mode: plan.bbox_mode || plan.detection?.bbox_mode || "img2_assisted",
      bbox_controller_model: plan.bbox_controller_model || plan.detection?.bbox_controller_model || DEFAULT_BBOX_CONTROLLER_MODEL,
      bbox_reasoning_effort: plan.bbox_reasoning_effort || plan.detection?.bbox_reasoning_effort || null,
      bbox_roi: plan.bbox_roi !== false,
      bbox_review: plan.bbox_review !== false,
      bbox_padding_px: clampBboxPadding(plan.bbox_padding_px, 3),
      use_model_output: plan.use_model_output === true,
      use_feynobg: plan.use_feynobg !== false,
      svg_guide_enabled: plan.svg_guide_enabled === true,
      svg_guide_required: plan.svg_guide_required === true,
      svg_guide_requested: plan.svg_guide_requested === true,
      svg_guide: plan.svg_guide || null,
      protect_outside_mask: plan.protect_outside_mask !== false,
      auto_matte_routing: plan.auto_matte_routing === true,
      matte_routing_mode: plan.matte_routing_mode || (plan.auto_matte_routing === true ? "gemini_auto" : "force_model"),
      atlas_enabled: plan.atlas_enabled !== false,
      atlas_batch_size: recordedAtlasBatchSize(plan),
      atlas_batch_mode: recordedAtlasBatchMode(plan),
      atlas_size: recordedAtlasSize(plan),
      atlas_columns: plan.atlas_columns || null,
      atlas_quality: plan.atlas_quality || "low",
      route_summary: routeSummary,
      feynobg_failure_policy: plan.feynobg_failure_policy || "abort_no_llm_fallback",
      feynobg_direct_bbox_count: Number(plan.feynobg_direct_bbox_count ?? routeSummary.feynobg_direct_bbox_count ?? 0),
      atlas_bbox_count: Number(plan.atlas_bbox_count ?? routeSummary.atlas_bbox_count ?? 0),
      individual_image_model_bbox_count: Number(plan.individual_image_model_bbox_count ?? routeSummary.individual_image_model_bbox_count ?? 0),
      feynobg_alpha_bbox_count: Number(plan.feynobg_alpha_bbox_count ?? routeSummary.feynobg_alpha_bbox_count ?? 0),
      text_cleanup_fallback: plan.text_cleanup_fallback === true,
      recursive_top_layer: plan.recursive_top_layer === true,
      bottom_up_repair: plan.bottom_up_repair === true,
      bbox_only: plan.bbox_only === true,
    },
    layers: exposedLayers.map((x) => ({
      ...x,
      source_asset: x.source && fs.existsSync(x.source)
        ? asset(x.source, x.name, x.kind === "text" ? "text-layer-preview" : x.kind)
        : null,
    })),
    loops_data: loops,
    layer_tree: {
      id: "root",
      name: "ROOT",
      children: exposedLayers.map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        bbox: x.bbox,
        z_index: x.z_index,
      })),
    },
  };
}

async function updateProjectBboxes(payload, account = DEFAULT_WORKSPACE_ACCOUNT) {
  const dir = safePath(payload?.path);
  assertProjectAccess(dir, account);
  const planPath = path.join(dir, "recursive_layer_plan.json");
  if (!fs.existsSync(planPath)) throw new Error("project plan not found");
  const active = [...JOBS.values()].find(
    (job) =>
      path.resolve(ROOT, job.output_dir || "") === dir &&
      ["running", "stopping"].includes(job.status),
  );
  if (active) throw new Error("当前流程仍在执行，结束后才能编辑 bbox");
  if (!Array.isArray(payload?.boxes)) throw new Error("boxes must be an array");

  const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
  const width = Number(plan.canvas?.width);
  const height = Number(plan.canvas?.height);
  if (!width || !height) throw new Error("invalid project canvas");
  const rawDetection = {
    ...(plan.detection || {}),
    boxes: payload.boxes,
    canvas: { width, height },
    occlusion_tree: payload.occlusion_tree || plan.detection?.occlusion_tree || {},
  };
  const detection = normalizeDetection(rawDetection, width, height);
  detection.loop = Number(plan.detection?.loop) || 1;
  detection.source = plan.source_image;
  detection.bbox_mode = plan.bbox_mode || plan.detection?.bbox_mode || "gpt_direct";
  detection.bbox_controller_model =
    plan.bbox_controller_model ||
    plan.detection?.bbox_controller_model ||
    DEFAULT_BBOX_CONTROLLER_MODEL;
  detection.bbox_reasoning_effort =
    plan.bbox_reasoning_effort || plan.detection?.bbox_reasoning_effort || null;
  detection.candidate = plan.detection?.candidate || null;
  detection.manually_edited = true;
  detection.edited_at = new Date().toISOString();

  const groups = depthGroups(detection, Number(plan.min_area) || 500).map(
    ({ depth, ids }) => ({ depth, ids }),
  );
  plan.detection = detection;
  plan.depth_groups = groups;
  plan.manual_bbox_edits = Number(plan.manual_bbox_edits || 0) + 1;
  plan.bbox_edited_at = detection.edited_at;

  await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  await fsp.writeFile(
    path.join(dir, "detection.json"),
    JSON.stringify(detection, null, 2),
  );
  if (plan.source_image && fs.existsSync(plan.source_image)) {
    await Promise.all([
      drawReview(
        plan.source_image,
        detection,
        path.join(dir, "bbox_review.png"),
        { includeText: false, showLabels: false, colorByDepth: true },
      ),
      drawReview(
        plan.source_image,
        detection,
        path.join(dir, "bbox_review_all.png"),
        { includeText: true, showLabels: true, colorByDepth: false },
      ),
    ]);
  }
  for (const record of plan.loops || []) {
    const loopDetection = path.join(
      dir,
      `loop_${String(record.loop).padStart(2, "0")}`,
      "detection.json",
    );
    if (fs.existsSync(path.dirname(loopDetection))) {
      await fsp.writeFile(
        loopDetection,
        JSON.stringify(
          {
            ...detection,
            selected_ids: record.bbox_ids || (record.bbox || []).map((box) => box.id).filter(Boolean),
            text_ids: (record.text || record.text_detection?.boxes || []).map((box) => box.id),
          },
          null,
          2,
        ),
      );
    }
  }
  for (const job of JOBS.values()) {
    if (path.resolve(ROOT, job.output_dir || "") !== dir) continue;
    job.detection = detection;
    job.depth_groups = groups;
  }
  return projectPayload(rel(dir), account);
}

async function startJob(payload, internal = {}) {
  const workspaceAccount = normalizeWorkspaceAccount(payload?.workspace_account);
  if (!apiKey('controller') || !apiKey('background')) throw new Error("请在 config.json 配置 controller 和 background 模型密钥");
  const source = safePath(payload.source);
  assertSourceAccess(source, workspaceAccount);
  if (!IMAGE_SUFFIXES.has(path.extname(source).toLowerCase()))
    throw new Error("source must be an image");
  const id = internal.id || `run_${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}_${crypto.randomBytes(3).toString("hex")}`;
  const out = internal.outputDir
    ? path.resolve(internal.outputDir)
    : path.join(accountRunsRoot(workspaceAccount), id);
  const resumeState = internal.resumeState || null;
  const abortController = new AbortController();
  const bboxMode = payload.bbox_mode === "img2_assisted"
    ? "img2_assisted"
    : "gpt_direct";
  const bottomUpRepair = payload.bottom_up_repair === true;
  // Bottom-up repair necessarily continues after the one-time text cleanup;
  // never let a stale UI/API checkbox stop the job before its first loop.
  const bboxOnly = payload.bbox_only === true && !bottomUpRepair;
  // Recursive passes always analyze the complete current working image.
  const bboxRoi = false;
  // Raw bbox mode is the only supported mode now. Keep the field for
  // backwards-compatible API responses, but never enable a review pass.
  const bboxReview = false;
  const controllerModel = normalizeControllerModel(payload.controller_model);
  const matteRoutingMode = payload.matte_routing_mode === "gemini_auto" || payload.auto_matte_routing === true
    ? "gemini_auto"
    : "force_model";
   // Resolve the foreground route centrally; the Web UI does not override model policy.
  const requestedImageModel = DEFAULT_IMAGE_MODEL;
  const compactAtlas = isGptImageModel(requestedImageModel) || isVolcengineImageProvider(requestedImageModel);
  // Gemini defaults to the original full-resolution image; the UI/API can
  // explicitly turn this off when a smaller request is preferred.
  const geminiOriginalImage =
    controllerModel === "gemini-3.8-flash" && payload.gemini_original_image !== false;
  const bboxPaddingPx = clampBboxPadding(payload.bbox_padding_px, 3);
  const useModelOutput = payload.use_model_output === true;
  const { flatSegmentBackground, svgGuideEnabled } = resolveBackgroundWorkflow({
    flatSegmentBackground: payload.flat_segment_background,
    svgGuideEnabled: payload.svg_guide_enabled,
    bottomUpRepair,
  });
  const protectOutsideMask = payload.protect_outside_mask !== false;
  if (svgGuideEnabled && bottomUpRepair)
    throw new Error("SVG_GUIDE_BOTTOM_UP_UNSUPPORTED: 请关闭严格 SVG 引导后再运行从下往上补图");
  // The route switch is resolved before creating the job metadata so the UI
  // and the worker receive the same effective FeyNobg setting.
  let useFeynobg = true;
  // The repair model receives the three scene references directly.
  // Bottom-up extraction reconstructs occluded objects, which a source-crop
  // matte cannot recover. Keep automatic direct routing exclusive to the
  // normal frontmost-first workflow.
  const autoMatteRouting =
    matteRoutingMode === "gemini_auto" &&
    !bottomUpRepair &&
    controllerModel === "gemini-3.8-flash";
  useFeynobg = autoMatteRouting;
  const atlasEnabled = flatSegmentBackground || payload.atlas_enabled !== false;
  const atlasBatchSize = compactAtlas
    ? atlasBatchSizeForImageModel(requestedImageModel)
    : Math.max(1, Math.min(64, Math.floor(Number(payload.atlas_batch_size) || 4)));
  const atlasBatchMode = compactAtlas && isGptImageModel(requestedImageModel)
    ? GPT_IMAGE_ATLAS_BATCH_MODE
    : null;
  // GPT Image 2.5 Flare uses compact fixed-cell atlases capped at 2048px per
  // edge. Legacy Ark/non-GPT atlas requests use a 256x256 default canvas;
  // source crops themselves are never resized and oversized crops receive a
  // dedicated native-size atlas when they cannot share the compact canvas.
  const atlasSize = compactAtlas
    ? atlasSizeForImageModel(requestedImageModel)
    : ATLAS_MAX_SIZE;
  // Native rectangle packing has no fixed row/column grid.
  const atlasColumns = null;
  const atlasQuality = FOREGROUND_ATLAS_QUALITY;
  // A zero max depth means process until the currently exposed scene has no
  // remaining detachable elements (the workflow still has its safety cap).
  // Keep this default consistent for both Release and Debug UI modes.
  const retryPolicy = normalizeRetryPolicy(payload);
  const requestedMaxDepth = Number(payload.max_depth ?? 0);
  let bboxSteps = bboxMode === "img2_assisted"
    ? [
        {
          id: "bbox_candidate",
          order: 1,
          status: "waiting",
          title: "GPT Image 2 生成 bbox 候选图",
          description: "等待向图像模型提交原图。",
          assets: [],
        },
        {
          id: "bbox_tree",
          order: 2,
          status: "waiting",
          title: "gpt-5.6-sol 校对 bbox 和遮挡树",
          description: "候选图生成后开始校对。",
          assets: [],
        },
      ]
    : [
        {
          id: "bbox_tree",
          order: 1,
          status: "waiting",
          title: "gpt-5.6-sol 直接分析 bbox 和遮挡树",
          description: "等待直接分析原图，不调用 GPT Image 2。",
          assets: [],
        },
      ];
  for (const step of bboxSteps) {
    if (step.title) step.title = step.title.replaceAll("gpt-5.6-sol", controllerModel);
    if (step.description) step.description = step.description.replaceAll("gpt-5.6-sol", controllerModel);
  }
  // Replace the legacy candidate/tree placeholders with the recursive
  // workflow's first two visible steps. A loop restart keeps only completed
  // steps before the target loop and appends fresh progress for that loop.
  if (resumeState) {
    bboxSteps = Array.isArray(internal.initialSteps)
      ? internal.initialSteps.map((step) => ({ ...step }))
      : [];
  } else {
    bboxSteps = [
      {
        id: svgGuideEnabled ? "text_bbox_svg" : "text_bbox",
        order: 1,
        status: "waiting",
        title: svgGuideEnabled
          ? `${controllerModel} 同步生成文字 bbox + 全图 SVG`
          : `${controllerModel} 识别普通文字 bbox（SVG 已全面禁用）`,
        description: svgGuideEnabled
          ? `同一次 ${controllerModel} 图片分析生成普通文字 bbox 和完整场景 SVG，并删除同 ID 文字节点生成 residual。`
          : "只分析普通文字 bbox；不生成或传递全图 SVG、residual SVG 及其预览。",
        assets: [],
      },
      {
        id: "text_cleanup",
        order: 2,
        status: "waiting",
        title: "GPT Image 2.5 Sunburst max 一次性移除文字",
        description: bboxOnly
          ? "仅分析文字 bbox 模式仍会调用一次 GPT Image 2.5 Sunburst max 去文字，然后在此停止视觉 loop。"
          : "生成 AI 去文字图，直接作为第一个递归 loop 的输入。",
        assets: [],
      },
    ];
    if (svgGuideEnabled && !bboxOnly) {
      bboxSteps.push({
        id: "svg_scene",
        order: 2.5,
        status: "waiting",
        title: `${controllerModel} 生成结构 SVG`,
        description: "Loop 1 开始前生成必需的结构 SVG；失败将直接终止任务。",
        assets: [],
      });
    }
  }
  const job = {
    id,
    workspace_account: workspaceAccount,
    status: "running",
    stage: resumeState
      ? `restarting from Loop ${resumeState.startLoop}`
      : "text bbox analysis",
    source: rel(source),
    output_dir: rel(out),
    ...retryPolicy,
    max_depth: Number.isFinite(requestedMaxDepth)
      ? requestedMaxDepth
      : 0,
    bbox_mode: bboxMode,
    bbox_controller_model: controllerModel,
    image_model: requestedImageModel,
    min_area: Number(payload.min_area || 500),
    bbox_only: bboxOnly,
    bottom_up_repair: bottomUpRepair,
    bbox_roi: bboxRoi,
    bbox_review: bboxReview,
    gemini_original_image: geminiOriginalImage,
    bbox_padding_px: bboxPaddingPx,
    use_model_output: useModelOutput,
    use_feynobg: useFeynobg,
    svg_guide_enabled: svgGuideEnabled,
    svg_guide_required: svgGuideEnabled,
    svg_guide_requested: svgGuideEnabled,
    flat_segment_background: flatSegmentBackground,
    protect_outside_mask: protectOutsideMask,
    feynobg_failure_policy: "abort_no_llm_fallback",
    auto_matte_routing: autoMatteRouting,
    matte_routing_mode: autoMatteRouting ? "gemini_auto" : "force_model",
    atlas_enabled: atlasEnabled,
    atlas_batch_size: atlasBatchSize,
    atlas_batch_mode: atlasBatchMode,
    atlas_size: atlasSize,
    atlas_columns: atlasColumns,
    atlas_quality: atlasQuality,
    started_at: new Date().toISOString(),
    loops: resumeState?.records?.length || 0,
    cutouts: (resumeState?.records || []).reduce(
      (total, record) => total + (Array.isArray(record.layers) ? record.layers.length : 0),
      0,
    ),
    steps: bboxSteps,
    detection: null,
    depth_groups: [],
    route_summary: null,
    fallback_events: [],
    last_fallback_reason: null,
    failure_reason: null,
    active_request: null,
    pending_atlas_retry: null,
    retry_available: false,
    retry_of: null,
    retry_attempt: 0,
    restarted_loop: resumeState?.startLoop || null,
    restarted_at: resumeState ? new Date().toISOString() : null,
    cancelled: false,
    abortController,
    process: null,
  };
  const retryController = createJobRetryController(job, { onChange: persistRunTiming });
  const waitForAtlasRetry = retryController.wait;
  JOBS.set(id, job);
  const onProgress = (update) => {
    const existing = job.steps.find((step) => step.id === update.id);
    const next = applyStepUpdate(existing || { id: update.id, assets: [] }, update);
    if (!existing) job.steps.push(next);
    job.steps.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    if (update.detection) job.detection = update.detection;
    if (update.depth_groups) job.depth_groups = update.depth_groups;
    if (update.route_summary) job.route_summary = update.route_summary;
    if (update.fallback_reason) job.last_fallback_reason = update.fallback_reason;
    if (Array.isArray(update.fallback_events)) job.fallback_events = update.fallback_events;
    if (update.active_request !== undefined) job.active_request = update.active_request;
    if (update.loops !== undefined) job.loops = update.loops;
    if (update.cutouts !== undefined) job.cutouts = update.cutouts;
    const loopStep = String(update.id || "").match(/^loop_(\d+)_/);
    if (loopStep) job.current_loop = Number(loopStep[1]);
    job.current_step = update.id;
    job.stage = update.title || job.stage;
    job.updated_at = update.at;
    persistRunTiming(job);
  };
  job.process = withJobRetryPolicy(retryController, () => runLayeredSplit({
    source,
    outputDir: out,
    maxDepth: job.max_depth,
    bboxMode: job.bbox_mode,
    bboxOnly: job.bbox_only,
    bboxRoi: job.bbox_roi,
    bboxReview: job.bbox_review,
    geminiOriginalImage: job.gemini_original_image,
    bboxPaddingPx: job.bbox_padding_px,
    useModelOutput: job.use_model_output,
    useFeynobg: job.use_feynobg,    autoMatteRouting: job.auto_matte_routing,
    matteRoutingMode: job.matte_routing_mode,
    waitForAtlasRetry,
    resumeState,
    bottomUpRepair: job.bottom_up_repair,
    controllerModel,
    imageModel: requestedImageModel,
    minArea: job.min_area,
    atlasEnabled: job.atlas_enabled,
    atlasBatchSize: job.atlas_batch_size,
    atlasSize: job.atlas_size,
    atlasColumns: job.atlas_columns,
    atlasQuality: job.atlas_quality,
    svgGuideEnabled: job.svg_guide_enabled,
    flatSegmentBackground: job.flat_segment_background,
    protectOutsideMask: job.protect_outside_mask,
    psd: path.join(out, `${path.parse(source).name}.psd`),
    shouldStop: () => job.cancelled,
    onProgress,
    signal: abortController.signal,
  }))
    .then((result) => {
      if (job.cancelled) {
        job.status = "stopped";
        job.stage = "force stopped";
        job.retry_available = true;
        return;
      }
      job.status = "completed";
      job.stage = "completed";
      job.completed_at = new Date().toISOString();
      Object.assign(job, result, {
        output_dir: rel(out),
        loops: result.loops,
        cutouts: result.layers,
      });
      if (result.plan) {
        const planPath = path.join(ROOT, result.plan);
        if (fs.existsSync(planPath)) {
          try {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            plan.workspace_account = workspaceAccount;
            Object.assign(plan, retryPolicy);
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
          } catch {}
        }
      }
    })
    .catch((error) => {
      const message = conciseError(error);
      job.failure_reason = message;
      job.retry_available = true;
      if (job.cancelled || error.message === "JOB_STOPPED") {
        job.status = "stopped";
        job.stage = "force stopped";
      } else {
        job.status = "failed";
        job.stage = message;
        job.error = error.stack || String(error);
      }
      const runningStep = job.steps.find((step) => step.status === "running" || step.status === "waiting_retry");
      if (runningStep) {
        runningStep.status = job.status === "stopped" ? "stopped" : "failed";
        runningStep.description =
          job.status === "stopped" ? "任务已由用户强制结束。" : message;
        runningStep.failure_reason = message;
        runningStep.retry_available = job.status === "failed";
        runningStep.completed_at = new Date().toISOString();
      }
    }).finally(() => {
      retryController.dispose();
      finishRunTiming(job);
      persistRunTiming(job);
    });
  return snapshot(job);
}

function restartRecordFromPair(pair, loopNumber) {
  return {
    loop: loopNumber,
    input: pair.input,
    bbox: Array.isArray(pair.bbox) ? pair.bbox : [],
    layers: Array.isArray(pair.layers) ? pair.layers : [],
    background: pair.background,
    svg_guide: pair.svg_guide || null,
    route_summary: pair.route_summary || null,
    bbox_review_enabled: pair.bbox_review_enabled === true,
  };
}

async function loadLoopRestartState(outputDir, loopNumber) {
  const textDetectionPath = path.join(outputDir, "text_cleanup", "detection.json");
  if (!fs.existsSync(textDetectionPath))
    throw new Error("当前流程缺少文字分析记录，无法从 loop 输入重新开始");
  const textDetection = JSON.parse(await fsp.readFile(textDetectionPath, "utf8"));
  const records = [];
  for (let index = 1; index < loopNumber; index++) {
    const pairPath = path.join(
      outputDir,
      `loop_${String(index).padStart(2, "0")}`,
      "pair.json",
    );
    if (!fs.existsSync(pairPath))
      throw new Error(`Loop ${index} 尚未完整结束，不能从 Loop ${loopNumber} 重新开始`);
    const pair = JSON.parse(await fsp.readFile(pairPath, "utf8"));
    if (!pair.background || !fs.existsSync(pair.background))
      throw new Error(`Loop ${index} 的下一轮输入图不存在`);
    records.push(restartRecordFromPair(pair, index));
  }
  const generatedTextInput = path.join(outputDir, "text_cleanup", "text_clean_generated.png");
  const copiedTextInput = path.join(outputDir, "text_cleanup", "text_clean.png");
  // Successful GPT Image 2.5 Sunburst max text cleanup returns text_clean_generated.png
  // directly. text_clean.png exists only when no ordinary text was found or
  // when the explicit 504 fallback copied the original plate.
  const loopOneInput = fs.existsSync(generatedTextInput)
    ? generatedTextInput
    : copiedTextInput;
  const input = loopNumber === 1
    ? loopOneInput
    : records[records.length - 1]?.background;
  if (!input || !fs.existsSync(input))
    throw new Error(`Loop ${loopNumber} 的输入图不存在`);
  if (!isInside(input, outputDir))
    throw new Error("Loop 输入图不属于当前流程");
  const svgGuideHistory = records
    .filter((record) => record.svg_guide)
    .map((record) => ({
      loop: record.loop,
      scene: record.svg_guide.scene || null,
      preview: record.svg_guide.scene_preview || null,
      request: record.svg_guide.request || null,
      raw_response: record.svg_guide.raw_response || null,
      top_bbox_review: record.svg_guide.top_bbox_review || null,
      sync: record.svg_guide.sync || null,
      bbox_count: record.bbox.length,
    }));
  return {
    startLoop: loopNumber,
    input,
    records,
    textDetection,
    svgGuideHistory,
    textCleanupFallback:
      !fs.existsSync(generatedTextInput) &&
      textDetection.boxes.some((box) => box.category === "text" && box.visible !== false),
  };
}

function restartPayloadFrom(job, plan, account) {
  return {
    auto_retry_count: job?.auto_retry_count ?? plan?.auto_retry_count,
    auto_retry_interval_seconds: job?.auto_retry_interval_seconds ?? plan?.auto_retry_interval_seconds,
    source: job?.source || plan?.source_image,
    workspace_account: account,
    max_depth: job?.max_depth ?? plan?.max_depth ?? 0,
    min_area: job?.min_area ?? 500,
    bbox_mode: job?.bbox_mode || plan?.bbox_mode || "gpt_direct",
    bbox_only: false,
    bottom_up_repair: false,
    controller_model: job?.bbox_controller_model || plan?.bbox_controller_model,
    image_model: job?.image_model || DEFAULT_IMAGE_MODEL,
    gemini_original_image: job?.gemini_original_image ?? plan?.bbox_original_image ?? true,
    bbox_padding_px: job?.bbox_padding_px ?? plan?.bbox_padding_px ?? 3,
    use_model_output: job?.use_model_output ?? plan?.use_model_output ?? false,
    matte_routing_mode: job?.matte_routing_mode || plan?.matte_routing_mode || "force_model",
    atlas_enabled: job?.atlas_enabled ?? plan?.atlas_enabled ?? true,
    atlas_batch_size: job?.atlas_batch_size ?? plan?.atlas_batch_size,
    atlas_size: job?.atlas_size ?? plan?.atlas_size,
    atlas_columns: job?.atlas_columns ?? plan?.atlas_columns,
    atlas_quality: job?.atlas_quality || plan?.atlas_quality || FOREGROUND_ATLAS_QUALITY,
    svg_guide_enabled: job?.svg_guide_enabled ?? plan?.svg_guide_enabled ?? true,
    flat_segment_background: job?.flat_segment_background ?? plan?.flat_segment_background ?? false,
    protect_outside_mask: job?.protect_outside_mask ?? plan?.protect_outside_mask ?? true,
  };
}

function completedLoopStepsForRestart(records, controllerModel = DEFAULT_BBOX_CONTROLLER_MODEL) {
  controllerModel = normalizeControllerModel(controllerModel);
  const steps = [];
  let cutoutCount = 0;
  for (const record of records) {
    const loopNumber = Number(record.loop);
    const layers = Array.isArray(record.layers) ? record.layers : [];
    cutoutCount += layers.length;
    steps.push({
      id: `loop_${loopNumber}_bbox`,
      order: 3 + (loopNumber - 1) * 3,
      status: "completed",
      title: `Loop ${loopNumber}：${controllerModel} 同步生成 bbox + 全图 SVG`,
      description: "该 Loop 在重新开始位置之前，保留原结果。",
      assets: record.input && fs.existsSync(record.input)
        ? [asset(record.input, `Loop ${loopNumber} 输入图`, "working-source")]
        : [],
      detection: { boxes: Array.isArray(record.bbox) ? record.bbox : [] },
      boxes: Array.isArray(record.bbox) ? record.bbox.length : 0,
    });
    steps.push({
      id: `loop_${loopNumber}_matte`,
      order: 4 + (loopNumber - 1) * 3,
      status: "completed",
      title: `Loop ${loopNumber}：GPT Image 2.5 Flare max 前景抠取`,
      description: `保留 ${layers.length} 个已完成前景图层。`,
      assets: layers
        .filter((layer) => layer.source && fs.existsSync(layer.source))
        .map((layer) => asset(layer.source, layer.name || layer.id, "cutout")),
      route_summary: record.route_summary || null,
      progress: { current: layers.length, total: layers.length },
      cutouts: cutoutCount,
    });
    steps.push({
      id: `loop_${loopNumber}_background`,
      order: 5 + (loopNumber - 1) * 3,
      status: "completed",
      title: `Loop ${loopNumber}：GPT Image 2.5 Sunburst max 补全被挖空背景`,
      description: `保留的背景图继续作为 Loop ${loopNumber + 1} 输入。`,
      assets: record.background && fs.existsSync(record.background)
        ? [asset(record.background, `Loop ${loopNumber + 1} 输入图`, "background")]
        : [],
      loops: loopNumber,
      cutouts: cutoutCount,
    });
  }
  return steps;
}

async function clearLoopAndLaterOutputs(outputDir, loopNumber) {
  const entries = await fsp.readdir(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    const match = entry.isDirectory() && entry.name.match(/^loop_(\d+)$/i);
    if (match && Number(match[1]) >= loopNumber)
      await fsp.rm(path.join(outputDir, entry.name), { recursive: true, force: true });
  }
  const finalNames = new Set([
    "recursive_layer_plan.json",
    "detection.json",
    "bbox_review.png",
    "bbox_review_all.png",
    "composite.png",
  ]);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (finalNames.has(entry.name) || entry.name.toLowerCase().endsWith(".psd"))
      await fsp.rm(path.join(outputDir, entry.name), { force: true });
  }
}

async function restartLoop(payload, account = DEFAULT_WORKSPACE_ACCOUNT) {
  account = normalizeWorkspaceAccount(account);
  const loopNumber = Number(payload?.loop);
  if (!Number.isInteger(loopNumber) || loopNumber < 1 || loopNumber > 64)
    throw new Error("loop 必须是 1 到 64 的整数");
  let previous = payload?.id ? JOBS.get(String(payload.id)) : null;
  if (previous && normalizeWorkspaceAccount(previous.workspace_account) !== account)
    throw new Error("run not found");
  const requestedOutput = payload?.path
    ? safePath(payload.path)
    : previous ? safePath(previous.output_dir) : null;
  if (!requestedOutput) throw new Error("run not found");
  assertProjectAccess(requestedOutput, account);
  const outputParent = path.dirname(requestedOutput);
  const isAccountRun = outputParent === path.resolve(accountRunsRoot(account));
  const isLegacyDefaultRun =
    account === DEFAULT_WORKSPACE_ACCOUNT &&
    outputParent === path.resolve(ROOT, "web_runs");
  if (!isAccountRun && !isLegacyDefaultRun)
    throw new Error("只有 Web run 可以从指定 Loop 重新开始");
  if (previous && path.resolve(ROOT, previous.output_dir || "") !== requestedOutput)
    throw new Error("run path does not match");
  if (!previous) {
    previous = [...JOBS.values()].find(
      (job) =>
        normalizeWorkspaceAccount(job.workspace_account) === account &&
        path.resolve(ROOT, job.output_dir || "") === requestedOutput,
    ) || null;
  }
  const restartKey = path.resolve(requestedOutput);
  if (RESTARTING_OUTPUTS.has(restartKey))
    throw new Error("该流程正在重新开始，请稍候");
  RESTARTING_OUTPUTS.add(restartKey);
  try {
    const planPath = path.join(requestedOutput, "recursive_layer_plan.json");
    const plan = fs.existsSync(planPath)
      ? JSON.parse(await fsp.readFile(planPath, "utf8"))
      : null;
    if (previous?.bottom_up_repair || plan?.bottom_up_repair)
      throw new Error("从指定 Loop 重新开始仅支持当前的从前往后递归流程");
    const resumeState = await loadLoopRestartState(requestedOutput, loopNumber);
    resumeState.textCleanupFallback =
      resumeState.textCleanupFallback === true ||
      previous?.text_cleanup_fallback === true ||
      plan?.text_cleanup_fallback === true;
    const previousSteps = (previous?.steps || []).filter((step) => {
      const match = String(step.id || "").match(/^loop_(\d+)_/);
      if (match) return Number(match[1]) < loopNumber;
      return !["export", "svg_scene"].includes(step.id);
    }).map((step) => ({ ...step }));
    const initialSteps = previousSteps.length
      ? previousSteps
      : completedLoopStepsForRestart(
          resumeState.records,
          previous?.bbox_controller_model || plan?.bbox_controller_model,
        );
    const restartPayload = restartPayloadFrom(previous, { ...readRunTiming(requestedOutput), ...plan }, account);
    if (!restartPayload.source) throw new Error("当前流程缺少原始 source 路径");
    const jobId = previous?.id || path.basename(requestedOutput);
    if (!/^run_[A-Za-z0-9_-]+$/.test(jobId))
      throw new Error("历史流程目录不是可重新开始的 Web run");
    if (!apiKey('controller') || !apiKey('background')) throw new Error("请在 config.json 配置 controller 和 background 模型密钥");
    const restartSource = safePath(restartPayload.source);
    assertSourceAccess(restartSource, account);
    if (!IMAGE_SUFFIXES.has(path.extname(restartSource).toLowerCase()))
      throw new Error("source must be an image");
    if (previous && ["running", "stopping", "waiting_retry"].includes(previous.status)) {
      previous.cancelled = true;
      previous.status = "stopping";
      previous.stage = `stopping before Loop ${loopNumber} restart`;
      previous.abortController?.abort();
      if (previous.process) await previous.process;
    }
    await clearLoopAndLaterOutputs(requestedOutput, loopNumber);
    return startJob(restartPayload, {
      id: jobId,
      outputDir: requestedOutput,
      resumeState,
      initialSteps,
    });
  } finally {
    RESTARTING_OUTPUTS.delete(restartKey);
  }
}

// Re-run a terminal job with the exact same source and model settings. This
// intentionally starts a fresh output directory so the failed attempt and its
// diagnostics remain available for comparison.
async function retryJob(id, account = DEFAULT_WORKSPACE_ACCOUNT) {
  const previous = JOBS.get(String(id || ""));
  if (!previous) throw new Error("run not found");
  if (normalizeWorkspaceAccount(previous.workspace_account) !== normalizeWorkspaceAccount(account))
    throw new Error("run not found");
  if (!["failed", "stopped"].includes(previous.status))
    throw new Error("only failed or stopped runs can be retried");
  const retryPayload = {
    auto_retry_count: previous.auto_retry_count,
    auto_retry_interval_seconds: previous.auto_retry_interval_seconds,
    source: previous.source,
    workspace_account: previous.workspace_account,
    max_depth: previous.max_depth,
    min_area: previous.min_area,
    bbox_mode: previous.bbox_mode,
    bbox_only: previous.bbox_only,
    bottom_up_repair: previous.bottom_up_repair,
    controller_model: previous.bbox_controller_model,
    image_model: previous.image_model,
    gemini_original_image: previous.gemini_original_image,
    bbox_padding_px: previous.bbox_padding_px,
    use_model_output: previous.use_model_output,
    matte_routing_mode: previous.matte_routing_mode,
    atlas_enabled: previous.atlas_enabled,
    atlas_batch_size: previous.atlas_batch_size,
    atlas_size: previous.atlas_size,
    atlas_columns: previous.atlas_columns,
    atlas_quality: previous.atlas_quality,
    svg_guide_enabled: previous.svg_guide_enabled,
    protect_outside_mask: previous.protect_outside_mask,
  };
  const started = await startJob(retryPayload);
  const retried = JOBS.get(started.id);
  if (retried) {
    retried.retry_of = previous.id;
    retried.retry_attempt = Number(previous.retry_attempt || 0) + 1;
    retried.retry_trigger_reason = previous.failure_reason || previous.last_fallback_reason || null;
  }
  return retried ? snapshot(retried) : started;
}

// Resume a blocked image request without restarting completed stages. Keep the
// Atlas endpoint compatible with existing foreground and mask retry controls.
async function retryAtlasRequest(id, requestId, account = DEFAULT_WORKSPACE_ACCOUNT) {
  const job = JOBS.get(String(id || ""));
  if (!job) throw new Error("run not found");
  if (normalizeWorkspaceAccount(job.workspace_account) !== normalizeWorkspaceAccount(account))
    throw new Error("run not found");
  const pending = job.pending_atlas_retry;
  if (job.status !== "waiting_retry" || !pending)
    throw new Error("no image request is waiting for retry");
  if (requestId && String(requestId) !== String(pending.request_id))
    throw new Error("image request is no longer pending");
  const resume = job.requestRetryResolve;
  if (typeof resume !== "function") throw new Error("retry handler is unavailable");
  resume();
  return snapshot(job);
}

function snapshot(job) {
  const {
    process,
    abortController,
    requestRetryResolve,
    requestRetryReject,
    pending_atlas_retry,
    ...rest
  } = job;
  return rest;
}
function persistRunTiming(job) {
  if (!job.output_dir) return;
  try {
    const file = path.join(ROOT, job.output_dir, "run_timing.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(timingSnapshot(job), null, 2));
    fs.renameSync(file + ".tmp", file);
  } catch (error) {
    console.warn("[run-timing]", error.message);
  }
}
function readRunTiming(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "run_timing.json"), "utf8")); }
  catch { return null; }
}
function serve(port = 8778, host = "127.0.0.1") {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const workspaceAccount = requestWorkspaceAccount(req);
      if (req.method === "POST" && u.pathname === "/api/run/stop") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const job = JOBS.get(payload.id);
        if (!job) return err(res, 404, "run not found");
        if (normalizeWorkspaceAccount(job.workspace_account) !== workspaceAccount)
          return err(res, 404, "run not found");
        job.cancelled = true;
        job.abortController?.abort();
        job.status = "stopping";
        job.stage = "force stopping";
        return json(res, 200, snapshot(job));
      }
      if (req.method === "POST" && u.pathname === "/api/run/retry") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 202, await retryJob(payload.id, workspaceAccount));
      }
      if (req.method === "POST" && u.pathname === "/api/run/restart-loop") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 202, await restartLoop(payload, workspaceAccount));
      }
      if (req.method === "POST" && u.pathname === "/api/run/atlas/retry") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 202, await retryAtlasRequest(payload.id, payload.request_id, workspaceAccount));
      }
      if (req.method === "GET" && u.pathname === "/") {
        const body = await fsp.readFile(path.join(WEB_ROOT, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && u.pathname.startsWith("/static/")) {
        const file = path.join(WEB_ROOT, path.basename(u.pathname));
        const body = await fsp.readFile(file);
        res.writeHead(200, {
          "Content-Type": file.endsWith(".js") ? "text/javascript"
            : file.endsWith(".html") ? "text/html; charset=utf-8" : "text/css",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/catalog")
        return json(res, 200, await catalog(workspaceAccount));
      if (req.method === "GET" && u.pathname === "/api/project")
        return json(res, 200, await projectPayload(u.searchParams.get("path"), workspaceAccount));
      if (req.method === "POST" && u.pathname === "/api/source/upload") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 201, await uploadWorkspaceSource(payload, workspaceAccount));
      }
      if (req.method === "POST" && u.pathname === "/api/project/bboxes") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 200, await updateProjectBboxes(payload, workspaceAccount));
      }
      if (req.method === "GET" && u.pathname === "/api/runs")
        return json(res, 200, { runs: [...JOBS.values()].filter((job) => normalizeWorkspaceAccount(job.workspace_account) === workspaceAccount).map(snapshot) });
      if (req.method === "GET" && u.pathname === "/api/run/status") {
        const job = JOBS.get(u.searchParams.get("id"));
        if (job && normalizeWorkspaceAccount(job.workspace_account) !== workspaceAccount)
          return err(res, 404, "run not found");
        return job
          ? json(res, 200, snapshot(job))
          : err(res, 404, "run not found");
      }
      if (req.method === "POST" && u.pathname === "/api/history/clear") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return json(res, 200, await clearRunHistory(payload, workspaceAccount));
      }
      if (req.method === "GET" && u.pathname === "/media") {
        const file = safePath(u.searchParams.get("path"));
        if (!IMAGE_SUFFIXES.has(path.extname(file).toLowerCase()))
          return err(res, 404, "only images are available");
        const body = await fsp.readFile(file);
        const ext = path.extname(file).toLowerCase();
        const contentType = ext === ".svg"
          ? "image/svg+xml"
          : `image/${ext.slice(1).replace("jpg", "jpeg")}`;
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
      if (req.method === "GET" && u.pathname === "/download") {
        const file = safePath(u.searchParams.get("path"));
        if (!/\.(psd|json|log|txt|svg)$/i.test(file))
          return err(res, 404, "only PSD, JSON, LOG, TXT, and SVG files are available");
        const body = await fsp.readFile(file);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
        });
        res.end(body);
        return;
      }
      if (
        req.method === "POST" &&
        (u.pathname === "/api/run/start" || u.pathname === "/api/run/stop")
      ) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (u.pathname.endsWith("/start"))
          return json(res, 202, await startJob({ ...payload, workspace_account: workspaceAccount }));
        const job = JOBS.get(payload.id);
        if (!job) return err(res, 404, "run not found");
        if (normalizeWorkspaceAccount(job.workspace_account) !== workspaceAccount)
          return err(res, 404, "run not found");
        job.cancelled = true;
        job.abortController?.abort();
        job.status = "stopping";
        job.stage = "force stopping";
        return json(res, 200, snapshot(job));
      }
      return err(res, 404, "not found");
    } catch (error) {
      console.error("[node-web]", error);
      err(res, 400, error.message || String(error));
    }
  });
  server.listen(port, host, () =>
    console.log(`LayerForge Node running at http://${host}:${port}`),
  );
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "serve")
    return serve(
      Number(args[1] || process.env.PORT || 8778),
      process.env.HOST || "127.0.0.1",
    );
  if (args[0] === "layered-split") {
    const source = safePath(args[1]);
    const get = (flag, fallback) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : fallback;
    };
    const out = safePath(
      get(
        "--output-dir",
        path.join(path.dirname(source), `${path.parse(source).name}_node_run`),
      ),
      false,
    );
    const maxDepth = Number(get("--max-depth", "0"));
    if (args.includes("--bbox-mask-delete")) {
      const result = await runBboxMaskDelete({
        source,
        outputDir: out,
        maxDepth,
        maxBoxes: Number(get("--max-boxes", "0")),
        controllerModel: get("--controller-model", DEFAULT_BBOX_CONTROLLER_MODEL),
        maskModel: get("--mask-model", GPT_IMAGE_25_FLARE_MODEL),
        deleteModel: get("--delete-model", GPT_IMAGE_25_SUNBURST_MODEL),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result = await runLayeredSplit({
      source,
      outputDir: out,
      maxDepth,
      bboxMode: get("--bbox-mode", "gpt_direct"),
      bboxOnly: args.includes("--bbox-only"),
      bottomUpRepair: args.includes("--bottom-up"),
      autoMatteRouting: args.includes("--auto-matte-routing"),
      controllerModel: get("--controller-model", DEFAULT_BBOX_CONTROLLER_MODEL),
      imageModel: get("--image-model", modelFor('foreground')),
      minArea: Number(get("--min-area", "500")),
      svgGuideEnabled: args.includes("--svg-guide") && !args.includes("--no-svg-guide"),
      flatSegmentBackground: args.includes("--no-flat-segment") ? false : undefined,
      protectOutsideMask: !args.includes("--no-mask-protection"),
      psd: get("--psd", null)
        ? safePath(get("--psd", null), false)
        : path.join(out, `${path.parse(source).name}.psd`),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    "Usage: node node/layerforge.js serve [port] | layered-split <image> --output-dir <dir> --max-depth 1 [--bbox-mask-delete] [--max-boxes N] [--svg-guide] [--no-flat-segment]",
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
module.exports = {
  runLayeredSplit,
  resolveBackgroundWorkflow,
  analyzeBboxes,
  analyzeBboxesBatched,
  dedupeBatchedBoxes,
  prepareBboxVisionImage,
  drawReview,
  exportPsd,
  buildEditableTextLayers,
  psdChildrenOrder,
  extractForegroundBox,
  extractForegroundWithFeynobg,
  // Exposed for deterministic local comparison tests.  These helpers still
  // use the same configured client routing as the production workflow.
  openaiClient,
  imageEdit,
  removeText,
  TEXT_REMOVAL_PROMPT,
  TOP_LAYER_BBOX_PROMPT,
  LOOP_BBOX_SVG_PROMPT,
  TEXT_BBOX_SVG_PROMPT,
  matteBox: extractForegroundBox,
  makeForegroundGuide,
  clipImageToBox,
  makeForegroundAtlasGuide,
  generateForegroundAtlas,
  splitForegroundAtlasAlpha,
  atlasBatchPlan,
  packAtlasLayout,
  planAtlasBatches,
  extractForegroundAtlasBatch,
  extractSeedreamAtlasBatch,
  splitSeedreamAtlasModel,
  recoverFixedAtlasCellRegions,
  renderExpandedAtlasCell,
  atlasCellOwnershipRect,
  detectGptAtlasRegions,
  seedreamAtlasGrid,
  seedreamAtlasTargetSize,
  gptImageAtlasCanvasDimensions,
  gptImageAtlasResponseSize,
  backgroundResponseSize,
  normalizeImageEditResponse,
  planSeedreamAtlasBatches,
  seedreamCellAlignment,
  fixedAtlasCellCropRect,
  writeAlphaPreview,
  isCircularRingBox,
  constrainSeedreamRingAlpha,
  normalizeGeneratedForegroundToBox,
  preserveSourcePixelsWithAlpha,
  preserveSmallBadgeWithContrastMask,
  extractionDescription,
  normalizeDetection,
  inferOcclusionFromFrontOrder,
  isSceneOnlyTerminalDetection,
  immediateDeferredReferenceBoxes,
  makeBackgroundReferenceCrops,
  positiveForegroundDescription,
  lowerOcclusionPromptBoxes,
  seedreamTargetPromptData,
  repairGeminiNormalizedCoordinates,
  clampBboxPadding,
  expandBboxForExtraction,
  depthGroups,
  maskForBoxes,
  maskForCutouts,
  makeFlatSegmentDeletionMask,
  flatSegmentAtlasGrid,
  readFlatSegmentAtlasMasks,
  makeTransparentHolePlate,
  normalizeBackgroundStructureGuide,
  validateBackgroundStructureCoverage,
  recheckBackgroundStructureEvidence,
  generateBackgroundStructureGuide,
  buildThreeImageBackgroundPrompt,
  BACKGROUND_TRANSPARENT_HOLE_PROMPT,
  normalizeBackgroundSemanticGuide,
  backgroundSemanticPixelCoordinates,
  groundBackgroundSemanticGuide,
  refineBackgroundGeometryGuide,
  generateBackgroundSemanticGuide,
  IMAGE_GENERATION_QUALITY,
  makeBackground,
  applyGeneratedRegion,
  applyGeneratedRegionSeamless,
  // SVG guide primitives are exported so the web runner and local smoke
  // tests use the same strict validation/matching implementation.
  validateSvgGuide,
  extractSvgGuideNodes,
  mapSynchronizedAnalysisToPixels,
  removeSvgGroups,
  matchLayersToSvgNodes,
  generateLoopBboxSvgBundle,
  generateTextBboxSvgBundle,
  extractSvgTextProperties,
  parseSynchronizedBundleJson,
  repairSynchronizedNormalizedBounds,
  normalizeSynchronizedSvgKinds,
  validateLoopBboxSvgSync,
  renderRequiredResidualGuide,
  composite,
};
