// Real splitter regression: interleaved bboxes, alpha=1 bridges, no alpha edits.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { splitSeedreamAtlasModel, detectGptAtlasRegions } = require('./layerforge.js');
const { visualAtlasBatches, inspectVisualCrops, assertVisualCrops } = require('./bbox_visual_atlas.js');
const { orderRepairedLayers } = require('./bbox_repair_order.js');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const repairedOrder=orderRepairedLayers([{id:'background'},{id:'badge'},{id:'backplate'},{id:'text'}],[{id:'backplate',behind:['badge']}]);
  assert.deepEqual(repairedOrder.map(l=>l.id),['background','backplate','badge','text']);
  assert.deepEqual(repairedOrder.map(l=>l.z_index),[0,1,2,3]);
  assert.throws(()=>orderRepairedLayers([{id:'a'},{id:'b'}],[{id:'a',behind:['b']},{id:'b',behind:['a']}]),/Conflicting/);
  const dir = await fs.mkdtemp(path.resolve(__dirname, '../tmp/visual-atlas-check-'));
  const width = 240, height = 120, rgba = Buffer.alloc(width * height * 4);
  const paint = (x, y, w, h, color) => {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++)
      Buffer.from(color).copy(rgba, (py * width + px) * 4);
  };
  // A C-shaped first target surrounds part of the second without touching it.
  // Both rectangular crops contain foreign pixels. Cell clipping loses the arm.
  paint(15, 15, 25, 85, [240, 70, 40, 255]);
  paint(15, 15, 140, 15, [240, 70, 40, 255]);
  paint(15, 85, 140, 15, [240, 70, 40, 255]);
  paint(145, 71, 10, 15, [240, 70, 40, 255]);
  paint(135, 45, 70, 25, [20, 110, 250, 255]);
  const model = path.join(dir, 'interleaved.png');
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(model);
  const originalHash = hash(await fs.readFile(model));
  const boxes = [{ id: 'large', category: 'artwork', bbox: [0, 0, 120, 120] },
    { id: 'control', category: 'panel', bbox: [120, 0, 120, 120] }];
  const layout = { width, height, cells: [
    { x: 0, y: 0, width: 120, height: 120 }, { x: 120, y: 0, width: 120, height: 120 }] };
  const splitDir = path.join(dir, 'split'); await fs.mkdir(splitDir);
  await assert.rejects(splitSeedreamAtlasModel({ source: model, boxes, modelOutput: model,
    batchDir: splitDir, layout, model: 'fixture', batchIndex: 1 }), /VISUAL_ATLAS_INTERLEAVED_TARGETS/);
  const diagnostic = JSON.parse(await fs.readFile(path.join(splitDir, 'split_regions.json')));
  assert.equal(diagnostic.crop_integrity.status, 'failed');
  assert(diagnostic.crop_integrity.conflicts.some(c => c.target_index === 0 && c.foreign_target_index === 1));
  assert(diagnostic.crop_integrity.conflicts.some(c => c.target_index === 1 && c.foreign_target_index === 0));
  assert.equal(hash(await fs.readFile(model)), originalHash, 'Never edit the raw model atlas');
  await assert.rejects(fs.access(path.join(splitDir, 'layers.json')), 'Do not export contaminated layers');

  // Fractional-alpha contact does not justify splitting a connected material.
  paint(40, 57, 95, 1, [90, 80, 70, 1]);
  const bridge = path.join(dir, 'bridge.png');
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(bridge);
  const located = await detectGptAtlasRegions(bridge, boxes, layout);
  const check = await inspectVisualCrops(bridge, located.regions);
  assert(check.merged_components.length > 0, 'Alpha=1 must participate in connectivity');
  assert.throws(() => assertVisualCrops(check), /VISUAL_ATLAS_INTERLEAVED_TARGETS/);

  // A low-alpha bridge outside two disjoint crops is harmless. Keep the raw
  // crop bytes instead of rejecting or thresholding a model's soft haze.
  const haze = Buffer.alloc(100 * 60 * 4);
  for (let y = 20; y < 40; y++) for (const x0 of [10, 70]) for (let x = x0; x < x0 + 20; x++)
    Buffer.from([70, 130, 210, 255]).copy(haze, (y * 100 + x) * 4);
  for (let x = 30; x < 70; x++) Buffer.from([70, 130, 210, 1]).copy(haze, (30 * 100 + x) * 4);
  const hazeFile = path.join(dir, 'haze.png'); await sharp(haze, { raw: { width: 100, height: 60, channels: 4 } }).png().toFile(hazeFile);
  const hazeCheck = await inspectVisualCrops(hazeFile, [
    { target_index: 0, component_seeds: [2010], rect: { left: 8, top: 18, width: 24, height: 24 } },
    { target_index: 1, component_seeds: [2070], rect: { left: 68, top: 18, width: 24, height: 24 } }]);
  assert.equal(hazeCheck.status, 'passed'); assert.equal(hazeCheck.merged_components.length, 1);
  assert.deepEqual(hazeCheck.ambiguous_shared_alpha, []);

  const stray = Buffer.from(haze);
  // Leave one transparent column between target A and target B's faint haze.
  for (let y = 0; y < 60; y++) stray.fill(0, (y * 100 + 30) * 4, (y * 100 + 31) * 4);
  const strayFile = path.join(dir, 'subpixel-haze.png'), strayDir = path.join(dir, 'subpixel-haze'); await fs.mkdir(strayDir);
  await sharp(stray, { raw: { width: 100, height: 60, channels: 4 } }).png().toFile(strayFile);
  const strayResult = await splitSeedreamAtlasModel({ source: strayFile,
    boxes: [{ id: 'a', category: 'icon', bbox: [0, 0, 50, 60] }, { id: 'b', category: 'icon', bbox: [50, 0, 50, 60] }],
    modelOutput: strayFile, batchDir: strayDir, layout: { width: 100, height: 60,
      cells: [{ x: 0, y: 0, width: 50, height: 60 }, { x: 50, y: 0, width: 50, height: 60 }] },
    model: 'fixture', batchIndex: 1, preserveAspectRatio: true });
  const strayDiagnostic = JSON.parse(await fs.readFile(path.join(strayDir, 'split_regions.json')));
  assert.equal(strayDiagnostic.crop_integrity.status, 'passed');
  assert.equal(strayDiagnostic.crop_integrity.retained_subpixel_haze[0].alpha_sum, 1);
  const strayLayer = strayResult.layers[0], sr = strayLayer.atlas_cell.model_rect, so = strayLayer.model_placement.offset;
  assert((await sharp(strayFile).extract({ left: sr[0], top: sr[1], width: sr[2], height: sr[3] }).raw().toBuffer())
    .equals(await sharp(strayLayer.source).extract({ left: so[0], top: so[1], width: sr[2], height: sr[3] }).raw().toBuffer()), 'Faint foreign haze is retained byte-for-byte, never cleaned');
  stray[(30 * 100 + 31) * 4 + 3] = 255;
  await sharp(stray, { raw: { width: 100, height: 60, channels: 4 } }).png().toFile(strayFile);
  assert.equal((await inspectVisualCrops(strayFile, strayDiagnostic.regions)).status, 'failed', 'An opaque foreign pixel is not subpixel haze');

  // Model moves a compact seven-cell input to a full-canvas grid. A calendar
  // has more detached parts than the old target-count-based candidate cap.
  const moved = Buffer.alloc(400 * 400 * 4), fill = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) Buffer.from(color).copy(moved, (yy * 400 + xx) * 4);
  };
  for (let i = 0; i < 7; i++) if (i !== 1) fill(115 + i % 2 * 160, 25 + Math.floor(i / 2) * 95, 32, 32, [30 + i * 25, 180, 90, 255]);
  fill(275, 20, 72, 4, [240, 240, 240, 255]); fill(275, 80, 72, 4, [240, 240, 240, 255]);
  fill(275, 20, 4, 64, [240, 240, 240, 255]); fill(343, 20, 4, 64, [240, 240, 240, 255]);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) fill(287 + x * 13, 33 + y * 14, 4, 4, [240, 240, 240, 255]);
  const movedFile = path.join(dir, 'moved.png'), movedDir = path.join(dir, 'moved'); await fs.mkdir(movedDir);
  await sharp(moved, { raw: { width: 400, height: 400, channels: 4 } }).png().toFile(movedFile);
  const movedBoxes = Array.from({ length: 7 }, (_, i) => ({ id: 'm' + i, category: 'icon', bbox: [i * 40, 0, 32, 32] }));
  const movedLayout = { width: 400, height: 400, cells: movedBoxes.map((_, i) => ({ x: i % 2 * 60, y: Math.floor(i / 2) * 60, width: 48, height: 48 })) };
  const movedResult = await splitSeedreamAtlasModel({ source: movedFile, boxes: movedBoxes, modelOutput: movedFile,
    batchDir: movedDir, layout: movedLayout, model: 'fixture', batchIndex: 1, preserveAspectRatio: true });
  const movedDiagnostic = JSON.parse(await fs.readFile(path.join(movedDir, 'split_regions.json')));
  assert.equal(movedDiagnostic.crop_integrity.status, 'passed');
  assert(movedDiagnostic.regions[1].component_indices.length >= 13, 'Retain every disconnected calendar detail');
  assert(movedResult.layers[0].atlas_cell.model_rect[0] < 200);
  assert(movedResult.layers[1].atlas_cell.model_rect[0] > 250, 'Returned column rank overrides stale input coordinates');
  assert(movedResult.layers.every(l => l.atlas_split_method === 'fixed_cell_order_alpha_crop'));

  // Detached details can sort before a large hollow target's own centroid.
  // Greedy row construction then leaves a fake extra row inside that target.
  const rowPixels = Buffer.alloc(640 * 800 * 4), rowFill = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) Buffer.from([180, 110, 220, 255]).copy(rowPixels, (yy * 640 + xx) * 4);
  };
  rowFill(30, 20, 250, 10); rowFill(30, 260, 250, 10); rowFill(30, 20, 10, 250); rowFill(270, 20, 10, 250);
  rowFill(120, 40, 12, 12); rowFill(60, 140, 12, 12); rowFill(360, 100, 230, 140);
  for (const y of [350, 530]) for (const x of [40, 360]) rowFill(x, y, 200, 80);
  rowFill(40, 700, 180, 60);
  const rowFile = path.join(dir, 'detached-row.png'), rowDir = path.join(dir, 'detached-row'); await fs.mkdir(rowDir);
  await sharp(rowPixels, { raw: { width: 640, height: 800, channels: 4 } }).png().toFile(rowFile);
  const rowBoxes = movedBoxes.map((b, i) => ({ ...b, bbox: [i * 80, 0, 64, 64] }));
  await splitSeedreamAtlasModel({ source: rowFile, boxes: rowBoxes, modelOutput: rowFile, batchDir: rowDir,
    layout: { width: 640, height: 800, cells: rowBoxes.map((_, i) => ({ x: i % 2 * 80, y: Math.floor(i / 2) * 80, width: 64, height: 64 })) },
    model: 'fixture', batchIndex: 1, preserveAspectRatio: true });
  const rowDiagnostic = JSON.parse(await fs.readFile(path.join(rowDir, 'split_regions.json')));
  assert.equal(rowDiagnostic.crop_integrity.status, 'passed');
  assert.equal(rowDiagnostic.regions[0].component_indices.length, 3, 'Hollow target and both detached stars stay in their returned row');
  assert.equal(rowDiagnostic.regions[1].component_indices.length, 1);

  const target = (id, w, h) => ({ id, bbox: [0, 0, w, h] });
  const large = target('large', 510, 490), controls = Array.from({ length: 7 }, (_, i) => target('c' + i, 250 + i, 150));
  const packed = visualAtlasBatches([controls[0], large, ...controls.slice(1)], 7);
  assert.deepEqual(packed.map(g => g.length), [1, 7], 'Separate a dominant object without increasing this request count');
  assert.equal(packed[0][0], large);
  const { layoutFor } = require('./bbox_two_loop_test.js');
  const tallMixed = [target('sidebar', 216, 893), target('character', 321, 471),
    ...Array.from({ length: 5 }, (_, i) => target('slot' + i, 150, 150))];
  assert(layoutFor(tallMixed).input_scale < 0.52, 'Saved seven-target layout discarded nearly half the native input');
  const nativeMixed = visualAtlasBatches(tallMixed, 7, layoutFor);
  assert.deepEqual(nativeMixed.map(g => g.length), [2, 5], 'Separate both large objects from the smaller slots');
  assert(nativeMixed.every(g => layoutFor(g).input_scale >= 1));
  const tallPeers = Array.from({ length: 7 }, (_, i) => target('tall' + i, 200, 850));
  const nativePeers = visualAtlasBatches(tallPeers, 7, layoutFor);
  assert(nativePeers.length > 1, 'Equal-area tall targets must also retain native input coverage');
  assert(nativePeers.every(g => layoutFor(g).input_scale >= 1));
  assert.deepEqual(new Set(nativePeers.flat().map(t => t.id)), new Set(tallPeers.map(t => t.id)));
  const similar = Array.from({ length: 27 }, (_, i) => target('c' + i, 80 + i, 60 + i));
  const groups = visualAtlasBatches(similar, 7);
  assert.equal(groups.length, 4); assert(groups.every(g => g.length <= 7));
  assert.deepEqual(groups.flat().map(b => b.id).sort(), similar.map(b => b.id).sort());
  assert.deepEqual(visualAtlasBatches([], 7), []);

  // Accepted crops retain model RGB and alpha=1 exactly in the real splitter.
  const small = Buffer.alloc(40 * 40 * 4);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++)
    Buffer.from([73, 179, 231, x === 10 ? 1 : 255]).copy(small, (y * 40 + x) * 4);
  const clean = path.join(dir, 'clean.png'), cleanDir = path.join(dir, 'clean'); await fs.mkdir(cleanDir);
  await sharp(small, { raw: { width: 40, height: 40, channels: 4 } }).png().toFile(clean);
  const result = await splitSeedreamAtlasModel({ source: clean, boxes: [{ id: 'one', category: 'icon', bbox: [0, 0, 40, 40] }],
    modelOutput: clean, batchDir: cleanDir, layout: { width: 40, height: 40, cells: [{ x: 0, y: 0, width: 40, height: 40 }] },
    model: 'fixture', batchIndex: 1, preserveAspectRatio: true });
  const layer = result.layers[0], [left, top, cw, ch] = layer.atlas_cell.model_rect;
  const expected = await sharp(clean).extract({ left, top, width: cw, height: ch }).raw().toBuffer();
  const [px, py] = layer.model_placement.offset;
  const actual = await sharp(layer.source).extract({ left: px, top: py, width: cw, height: ch }).raw().toBuffer();
  assert(expected.equals(actual), 'Guard must not modify the accepted crop RGB/alpha');
  assert(actual.some((v, i) => i % 4 === 3 && v === 1));
  const missingDir = path.join(dir, 'missing'); await fs.mkdir(missingDir);
  await assert.rejects(splitSeedreamAtlasModel({ source: clean,
    boxes: [{ id: 'a', category: 'icon', bbox: [0, 0, 20, 40] }, { id: 'b', category: 'icon', bbox: [20, 0, 20, 40] }],
    modelOutput: clean, batchDir: missingDir, layout: { width: 40, height: 40,
      cells: [{ x: 0, y: 0, width: 20, height: 40 }, { x: 20, y: 0, width: 20, height: 40 }] },
    model: 'fixture', batchIndex: 1 }), /VISUAL_ATLAS_OWNERSHIP_UNRESOLVED/,
  'Missing ownership must not fall back to stale cell coordinates');
  await assert.rejects(fs.access(path.join(missingDir, 'layers.json')));
  console.log('PASS: interleaved/ambiguous crops rejected; disjoint alpha=1 haze retained; moved grids and 19 components retain target order; exact RGBA; 7-target packing');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
