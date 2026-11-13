// Fold original geometry and known-target presence into the inventory request.
const assert = require('node:assert/strict');

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
    box[0] >= 0 && box[1] >= 0 && box[2] <= 1000 && box[3] <= 1000 && box[2] > box[0] && box[3] > box[1];
}

function sourceBox(box, crop) {
  assert(validBox(box), 'Invalid original normalized box');
  const [y0, x0, y1, x1] = box;
  const x = crop.left + Math.floor(x0 * crop.width / 1000), y = crop.top + Math.floor(y0 * crop.height / 1000);
  return [x, y, crop.left + Math.ceil(x1 * crop.width / 1000) - x, crop.top + Math.ceil(y1 * crop.height / 1000) - y];
}

function assignHintOwners(hints, regions) {
  const owners = new Map(regions.map(region => [region.id, []]));
  for (const hint of new Map(hints.map(hint => [hint.id, hint])).values()) {
    const [x, y, w, h] = hint.geometry_bbox || hint.source_bbox || hint.bbox;
    const locals = regions.filter(region => region.id !== 'overview' && x >= region.crop.left && y >= region.crop.top &&
      x + w <= region.crop.left + region.crop.width && y + h <= region.crop.top + region.crop.height);
    const owner = locals.find(region => x+w/2 >= region.core[0] && x+w/2 < region.core[0]+region.core[2] &&
      y+h/2 >= region.core[1] && y+h/2 < region.core[1]+region.core[3]) || locals[0] || regions.find(region => region.id === 'overview');
    assert(owner, 'Hint requires a whole-canvas owner');
    owners.get(owner.id).push(hint);
  }
  return owners;
}

const HINT_MARKER = 'Owned prior targets (SOURCE XYWH):';
function combinedPrompt(hints) {
  return `\nIn this SAME inventory pass, independently measure each surviving target on the ORIGINAL unmarked reference. Extend EVERY element with "original_present":true or false and "original_box":[y_min,x_min,y_max,x_max] (null when original_present=false). original_box uses the same crop-normalized coordinates as box, but measures the COMPLETE original semantic object, including outline, glow and shadow, never the rectangular deletion boundary. Keep the target separate from its host panel and other independent icons. original_present=false means the CURRENT inventory invented an object absent from the ORIGINAL; do not infer a panel behind originally bare text. The CURRENT image alone decides survival; do not resurrect a removed object merely because the ORIGINAL contains it.
Also return "hint_checks":[{"hint_id":"exact supplied id","status":"present/absent/uncertain","element_id":"this response's element id or null"}]. Exactly one check per owned prior target, even when absent; [] if none. For present, include the complete surviving target in elements and reference its id. For absent or uncertain use element_id=null. Check CURRENT pixels for presence, ORIGINAL only for full geometry. Use uncertain when presence cannot be decided; the caller will retain the existing batched discovery fallback. Do not silently treat an uncertain hint as absent. No prose or additional objects solely from the original reference.
${HINT_MARKER}${JSON.stringify(hints.map(hint => ({id:hint.id,description:hint.description,bbox:hint.geometry_bbox||hint.source_bbox||hint.bbox})))}`;
}

function validateCombined(parsed, hints) {
  for (const element of parsed.elements) {
    assert.equal(typeof element.original_present, 'boolean', 'Missing original presence');
    assert(element.original_present ? validBox(element.original_box) : element.original_box === null, 'Invalid original geometry');
  }
  assert(Array.isArray(parsed.hint_checks) && parsed.hint_checks.length === hints.length, 'Missing owned hint checks');
  const seen = new Set(), assigned = new Set();
  for (const check of parsed.hint_checks) {
    assert(hints.some(hint => hint.id === check.hint_id) && !seen.has(check.hint_id), 'Invalid owned hint id');
    seen.add(check.hint_id);
    assert(['present', 'absent', 'uncertain'].includes(check.status), 'Invalid hint presence');
    if (check.status === 'present') {
      assert(parsed.elements.some(element => element.id === check.element_id), 'Present hint has no inventory target');
      assert(!assigned.has(check.element_id), 'Independent prior targets collapsed into one inventory target');
      assigned.add(check.element_id);
    } else assert(check.element_id == null, 'Absent/uncertain hint must not reference a target');
  }
}

module.exports = {assignHintOwners, combinedPrompt, validateCombined, sourceBox, HINT_MARKER};
