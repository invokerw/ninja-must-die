#!/usr/bin/env node
// Re-split saved text atlases, retaining all non-text layers and model bytes.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { splitSeedreamAtlasModel } = require('./layerforge.js');
const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const inside = (file, root) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
function relocate(value, from, to) {
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, from, to)]));
  return typeof value === 'string' && path.isAbsolute(value) && inside(value, from) ? path.join(to, path.relative(from, value)) : value;
}

async function main() {
  assert(process.argv[2] && process.argv[3], 'Usage: node node/bbox_text_atlas_replay.js COMPLETED_RUN NEW_OUTPUT');
  const parent = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  assert(!inside(parent, output) && !inside(output, parent), 'Use a new sibling output');
  try { assert.equal((await fs.readdir(output)).length, 0, 'Output must be empty'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = await read(path.join(parent, 'status.json'));
  assert.equal(original.status, 'completed');
  const names = ['status.json', 'layers.json', 'layers.psd', 'recomposed.png', 'verification.json', 'run_manifest.json'];
  const parentHashes = Object.fromEntries(await Promise.all(names.map(async name => [name, await hash(path.join(parent, name))])));
  const all = original.loops.flatMap(loop => loop.layers);
  const retained = await Promise.all(all.filter(l => l.category !== 'text').map(async l => ({ id: l.id, source: l.source, sha256: await hash(l.source) })));
  const models = await Promise.all([...new Set(all.map(l => l.model_generated_source || l.generated_source).filter(Boolean))]
    .map(async file => ({ file, sha256: await hash(file) })));
  const started = new Date().toISOString();
  await fs.cp(parent, output, { recursive: true });
  const state = relocate(original, parent, output), stage = path.join(output, 'text_atlas_replay');
  await fs.mkdir(stage, { recursive: true });
  await fs.copyFile(path.join(parent, 'recomposed.png'), path.join(output, 'previous.png'));
  const checks = []; let batchNumber = 0;
  for (const loop of state.loops) {
    const groups = new Map();
    for (const layer of loop.layers.filter(l => l.category === 'text')) {
      const model = layer.model_generated_source || layer.generated_source;
      assert(model, 'No saved model atlas for ' + layer.id);
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model).push(layer);
    }
    for (const [model, selected] of groups) {
      const request = await read(path.join(path.dirname(model), 'request.json'));
      const prefix = `loop_${String(loop.index).padStart(2, '0')}_`;
      const boxes = request.targets.map(target => {
        const box = loop.selected.find(item => item.id === target.id);
        const layer = selected.find(item => item.id === target.id || item.id === prefix + target.id);
        assert(box && layer, 'Missing saved text target ' + target.id);
        return { ...box, source_bbox: layer.semantic_bbox || box.source_bbox || box.bbox };
      });
      const batch = path.join(stage, `batch_${String(++batchNumber).padStart(2, '0')}`);
      await fs.mkdir(batch, { recursive: true });
      const split = await splitSeedreamAtlasModel({ source: loop.input, boxes, modelOutput: model,
        batchDir: batch, layout: request.layout, model: state.model, batchIndex: batchNumber,
        preserveAspectRatio: true, preserveSourceBounds: true });
      for (const old of selected) {
        const index = boxes.findIndex(box => old.id === box.id || old.id === prefix + box.id);
        assert(index >= 0);
        const fresh = split.layers[index], p = fresh.model_placement;
        assert(p.scale.every(s => s <= 1) && p.raster_scale.every(s => s <= 1));
        // Independently reproduce the declared crop and resize, then compare
        // the placed pixels byte for byte. Alpha is never cleaned or rebuilt.
        const [left, top, width, height] = fresh.atlas_cell.model_rect;
        let crop = sharp(model).extract({ left, top, width, height }).ensureAlpha();
        const [rw, rh] = p.rendered_size;
        if (rw !== width || rh !== height) crop = crop.resize(rw, rh, { fit: 'fill', kernel: sharp.kernel.lanczos3 });
        const expected = await crop.raw().toBuffer();
        const actual = await sharp(fresh.source).extract({ left: p.offset[0], top: p.offset[1], width: rw, height: rh }).ensureAlpha().raw().toBuffer();
        assert(actual.equals(expected), 'Placed RGBA differs from saved model crop: ' + old.id);
        const next = { ...old, ...fresh, id: old.id, name: old.name, depth: old.depth, z_index: old.z_index,
          text_atlas_replay: { parent_layer: relocate(old.source, output, parent), model_calls: 0 }, model_rgba_source: fresh.source };
        loop.layers[loop.layers.indexOf(old)] = next;
        checks.push({ id: old.id, previous_rect: old.atlas_cell.model_rect, rect: fresh.atlas_cell.model_rect,
          previous_placement: old.model_placement, placement: p, exact_declared_crop_rgba: true });
      }
    }
    await write(loop.report, loop);
  }
  const manifest = await read(path.join(output, 'run_manifest.json')), sources = [];
  for (const relative of ['node/bbox_text_atlas_replay.js', 'node/bbox_text_atlas.js', 'node/bbox_model_rgba.js', 'node/layerforge.js', 'node/bbox_recursive_core.js', 'node/bbox_recursive_test.js']) {
    const file = path.resolve(__dirname, '..', relative), snapshot = path.join(stage, 'code_snapshot', relative);
    await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.copyFile(file, snapshot);
    sources.push({ relative, file, snapshot, sha256: await hash(file) });
  }
  manifest.previous_postprocessing = manifest.postprocessing || null;
  manifest.derived_from = { output: parent, manifest_sha256: parentHashes['run_manifest.json'], model_calls: 0 };
  Object.assign(manifest, { reuse_text: true, reuse_text_source: parent, reuse_visual_layers: true,
    postprocessing: { kind: 'complete_saved_text_atlas_components', started_at: started, sources } });
  state.previous_visual_review = state.visual_review;
  state.visual_review = { status: 'targeted_review_pending', scope: 'Complete text glyph crops; other saved layers unchanged',
    remaining_findings: original.visual_review?.remaining_findings || [] };
  state.notice = '已用保存的模型图集修复文字跨格裁断和空白缩放；其余图层保持原样。0 次新模型调用，只裁切、缩小和定位，不修改模型 RGB 或 alpha。原始生成耗时属于父结果。';
  await write(path.join(output, 'run_manifest.json'), manifest);
  await write(path.join(output, 'status.json'), state);
  const project = path.resolve(__dirname, '..'), env = { ...process.env, BBOX_TEST_SOURCE: state.source };
  execFileSync(process.execPath, ['node/bbox_recursive_test.js', output, '--export-only'], { cwd: project, env, windowsHide: true, stdio: 'inherit' });
  const final = await read(path.join(output, 'status.json'));
  assert.equal(final.layer_count, original.layer_count);
  for (const entry of retained) {
    assert.equal(await hash(entry.source), entry.sha256, 'Parent layer changed');
    assert.equal(await hash(relocate(entry.source, parent, output)), entry.sha256, 'Non-text layer changed');
  }
  for (const entry of models) {
    assert.equal(await hash(entry.file), entry.sha256, 'Parent model changed');
    assert.equal(await hash(relocate(entry.file, parent, output)), entry.sha256, 'Saved model return changed');
  }
  for (const [name, digest] of Object.entries(parentHashes)) assert.equal(await hash(path.join(parent, name)), digest, 'Parent result changed');
  const ended = new Date().toISOString(), summary = { status: 'passed', parent, model_calls: 0, started_at: started, ended_at: ended,
    elapsed_ms: Date.parse(ended) - Date.parse(started), text_layers: checks.length, retained_visual_layers: retained.length,
    layer_count: final.layer_count, upscaled_layers: 0, parent_unchanged: true, non_text_rgba_unchanged: true,
    model_returns_unchanged: true, resolution_shortfalls: checks.filter(c => c.placement.resolution_shortfall).map(c => c.id), checks, parent_hashes: parentHashes };
  await write(path.join(output, 'text_atlas_verification.json'), summary);
  final.steps.push({ id: 'text_atlas_replay', title: '完整文字组件重新裁切放回（0 次新生图）', status: 'completed',
    started_at: started, ended_at: ended, elapsed_ms: summary.elapsed_ms });
  final.text_atlas_verification = { ...summary, checks: undefined, parent_hashes: undefined };
  await write(path.join(output, 'status.json'), final);
  execFileSync(process.execPath, ['node/bbox_recursive_test.js', output, '--report-only'], { cwd: project, env, windowsHide: true, stdio: 'inherit' });
  console.log(JSON.stringify({ ...summary, checks: undefined, parent_hashes: undefined }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
