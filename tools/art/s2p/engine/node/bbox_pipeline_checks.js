#!/usr/bin/env node
// Exercise the actual runner in separate processes with deterministic models.
// Verify overlap, commit order, identical residuals/PSD, and failure/resume.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.env.BBOX_PIPELINE_MOCK === '1') {
  const Module = require('node:module'), originalLoad = Module._load;
  const log = (event, details = {}) => fsSync.appendFileSync(process.env.BBOX_PIPELINE_TRACE, JSON.stringify({ event, time: Date.now(), ...details }) + '\n');
  const box = i => ({ id: `object_${i}`, category: 'icon', description: `object ${i}`, bbox: [i * 8, 8, 5, 5], occluded_by: [] });
  const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent);
    if (resolved === path.join(__dirname, 'bbox_image_requests.js')) return { imageRequest: async (_image, output) => {
      log('completion_start', { output }); await delay(85);
      await sharp({ create: { width: 32, height: 24, channels: 4, background: '#203040' } }).png().toFile(output);
      log('completion_end', { output }); return output;
    } };
    if (resolved === path.join(__dirname, 'bbox_recursive_core.js')) return {
      BATCH: 7, TEXT_BATCH: 14, overlap,
      createCore: ({ state, step }) => ({
        detect: async (source, dir, mode, removed = [], hints = []) => {
          const round = mode === 'text' ? 1 : Number(path.basename(dir).slice(5));
          log('detect_start', { round, mode, removed: removed.map(b => b.id), hints: hints.map(b => b.id) });
          await delay(110);
          if (mode === 'text') return { selected: [{ id: 'label', category: 'text', description: 'label', bbox: [0, 0, 5, 4] }], deferred: [] };
          assert.equal(state.loops.length, round - 1, 'Detector snapshot must include the pending preceding round');
          assert.equal(removed.length, round - 1, 'Removed targets must include the preceding round exactly once');
          const rgba = await sharp(source).ensureAlpha().raw().toBuffer();
          for (let i = 2; i < round; i++) assert.equal(rgba[(8 * 32 + (i - 2) * 8) * 4 + 3], 0, 'Next input must contain every preceding true alpha hole');
          if (round === 3) assert.deepEqual(hints.map(b => b.id), ['object_1'], 'Deferred hints must survive lookahead');
          if (process.env.BBOX_PIPELINE_MOCK_FAILURE === 'detect' && round === 3) throw new Error('injected_detector_failure');
          log('detect_end', { round });
          return round >= 4 ? { background_only: true, terminal: { background_only: true } } : {
            selected: [box(round - 2)], deferred: round === 2 ? [box(1)] : [], continuity: null };
        },
        extract: async (_source, boxes, dir, prefix) => step(prefix + '_batch_1', 'mock batch', async () => {
          const round = prefix === 'loop1_cutout' ? 1 : Number(prefix.match(/^loop(\d+)_/)[1]);
          log('extract_start', { round });
          await delay(170);
          if (process.env.BBOX_PIPELINE_MOCK_FAILURE === 'extract' && round === 2) throw new Error('injected_extraction_failure');
          if (process.env.BBOX_PIPELINE_MOCK_FAILURE === 'text_extract' && round === 1) throw new Error('injected_text_extraction_failure');
          await fs.mkdir(dir, { recursive: true });
          const layers = await Promise.all(boxes.map(async item => {
            const source = path.join(dir, item.id + '.png');
            await sharp({ create: { width: item.bbox[2], height: item.bbox[3], channels: 4, background: '#e04080' } }).png().toFile(source);
            return { ...item, source };
          }));
          log('extract_end', { round }); return layers;
        }),
      }),
    };
    return originalLoad.call(this, request, parent, isMain);
  };
} else {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  async function execute(root, source, name, pipeline, failure = '', maxRounds = 4, resumeOutput = null, visualWindow = 1) {
    const output = resumeOutput || path.join(root, name), trace = path.join(root, name + '.jsonl');
    const env = { ...process.env, BBOX_TEST_SOURCE: source, BBOX_TEXT_ARCHIVE: path.join(root, 'no_archive'),
      BBOX_PIPELINE: pipeline ? '1' : '0', BBOX_VISUAL_WINDOW: String(visualWindow), BBOX_PIPELINE_MOCK: '1', BBOX_PIPELINE_TRACE: trace,
      BBOX_PIPELINE_MOCK_FAILURE: failure, BBOX_MAX_ROUNDS: String(maxRounds) };
    const child = spawn(process.execPath, ['--require', __filename, path.join(__dirname, 'bbox_recursive_test.js'), output], {
      cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await fs.writeFile(path.join(root, name + '.log'), text);
    const state = await read(path.join(output, 'status.json'));
    const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    return { output, state, events, code };
  }
  async function main() {
    const {runVisualWindow}=require('./bbox_visual_window.js');
    let planned=0,committed=0,peak=0,active=0;
    const bounded=await runVisualWindow({loops:[{index:1}],maxRounds:12,window:3,
      detect:async index=>{await delay(1);return {index,background_only:index===10};},
      prepare:async(index,plan)=>{planned++;peak=Math.max(peak,planned-committed);assert(peak<=3);return {index,staged:{index}};},
      extract:async item=>{active++;await delay(item.index%2?8:32);active--;return item.index;},
      commit:async(item,index)=>{assert.equal(index,committed+2,'Commit depth must stay ordered');committed++;},
      background:async()=>{await delay(1);return 'background';},complete:async()=>assert.equal(committed,8)});
    assert(bounded.completed);assert.equal(active,0);assert.equal(peak,3,'Exercise the window bound with many rounds');
    const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/pipeline-check-')), source = path.join(root, 'source.png');
    await sharp({ create: { width: 32, height: 24, channels: 4, background: '#406080' } }).png().toFile(source);
    const serial = await execute(root, source, 'serial', false), pipelined = await execute(root, source, 'pipelined', true);
    for (const run of [serial, pipelined]) { assert.equal(run.code, 0); assert.equal(run.state.verification.status, 'passed'); }
    const eventTime = (run, event, round) => run.events.find(e => e.event === event && e.round === round).time;
    assert(eventTime(pipelined, 'detect_start', 3) < eventTime(pipelined, 'extract_end', 2), 'Next detection must overlap current extraction');
    assert(eventTime(serial, 'detect_start', 3) >= eventTime(serial, 'extract_end', 2), 'Control mode must remain serial');
    const completion = run => run.events.find(e => e.event === 'completion_start' && e.output.endsWith('after_model.png')).time;
    assert(completion(pipelined) < eventTime(pipelined, 'extract_end', 1), 'Text completion must overlap text extraction');
    assert(completion(serial) >= eventTime(serial, 'extract_end', 1));
    for (const file of ['recomposed.png', 'psd_recomposed.png', 'layers.psd']) assert((await fs.readFile(path.join(serial.output, file))).equals(await fs.readFile(path.join(pipelined.output, file))), 'Scheduling changed ' + file);
    for (let i=0;i<serial.state.loops.length;i++) for (const field of ['input','after','holes']) {
      const a=serial.state.loops[i][field],b=pipelined.state.loops[i][field];
      if(a||b)assert(a&&b&&(await fs.readFile(a)).equals(await fs.readFile(b)), `Scheduling changed loop ${i+1} ${field}`);
    }
    assert.equal(serial.events.filter(e => e.event === 'detect_start').length, pipelined.events.filter(e => e.event === 'detect_start').length, 'Lookahead cannot add detector calls');
    const failed = await execute(root, source, 'failed_extract', true, 'extract');
    assert.equal(failed.code, 1); assert.equal(failed.state.loops.length, 1, 'An incomplete extraction cannot commit a speculative loop');
    assert(failed.state.steps.every(s => s.status !== 'running'), 'Drain lookahead before recording final failure');
    const resumed = await execute(root, source, 'resumed', true, '', 4, failed.output);
    assert.equal(resumed.code, 0); assert.equal(resumed.state.verification.status, 'passed');
    const detectorFailure = await execute(root, source, 'failed_detect', true, 'detect');
    assert.equal(detectorFailure.code, 1); assert.equal(detectorFailure.state.loops.length, 2, 'Commit the completed predecessor before reporting its prefetched successor failure');
    const limited = await execute(root, source, 'round_limit', true, '', 1);
    assert.equal(limited.code, 2); assert(!limited.events.some(e => e.event === 'detect_start' && e.round > 2), 'No lookahead beyond the diagnostic round guard');
    const windowed=await execute(root,source,'windowed',true,'',4,null,3);
    assert.equal(windowed.code,0);assert.equal(windowed.state.verification.status,'passed');
    assert(eventTime(windowed,'detect_start',4)<eventTime(windowed,'extract_end',2),'Plan beyond one pending round');
    assert(eventTime(windowed,'detect_start',2)<eventTime(windowed,'extract_end',1),'First visual detection should overlap pending text cutouts on the completed opaque base');
    assert(windowed.events.find(e=>e.event==='completion_start'&&e.output.endsWith('background_model.png'))?.time < eventTime(windowed,'extract_end',3),'Final background should overlap pending cutouts');
    assert.equal((await read(path.join(serial.output,'background_model_request.json'))).prompt,(await read(path.join(windowed.output,'background_model_request.json'))).prompt,'Background must exclude all staged targets');
    for(const file of ['recomposed.png','psd_recomposed.png','layers.psd'])assert((await fs.readFile(path.join(serial.output,file))).equals(await fs.readFile(path.join(windowed.output,file))),'Window scheduling changed '+file);
    for(let i=0;i<serial.state.loops.length;i++)for(const field of ['input','after','holes']){
      const a=serial.state.loops[i][field],b=windowed.state.loops[i][field];
      if(a||b)assert(a&&b&&(await fs.readFile(a)).equals(await fs.readFile(b)),`Window scheduling changed loop ${i+1} ${field}`);
    }
    const windowFailed=await execute(root,source,'window_failed_extract',true,'extract',4,null,3);
    assert.equal(windowFailed.code,1);assert.equal(windowFailed.state.loops.length,1,'Window cannot commit a descendant of a failed extraction');
    assert(windowFailed.state.steps.every(s=>s.status!=='running'),'Drain all window work before failure');
    const windowResume=await execute(root,source,'window_resumed',true,'',4,windowFailed.output,3);
    assert.equal(windowResume.code,0);assert.equal(windowResume.state.verification.status,'passed');
    const windowDetectorFailure=await execute(root,source,'window_failed_detect',true,'detect',4,null,3);
    assert.equal(windowDetectorFailure.code,1);assert.equal(windowDetectorFailure.state.loops.length,2);
    const windowLimited=await execute(root,source,'window_limit',true,'',1,null,3);
    assert.equal(windowLimited.code,2);assert(!windowLimited.events.some(e=>e.event==='detect_start'&&e.round>2));
    const textFailed=await execute(root,source,'window_failed_text',true,'text_extract',4,null,3);
    assert.equal(textFailed.code,1);assert.equal(textFailed.state.loops.length,0);
    assert(textFailed.state.steps.every(step=>step.status!=='running'),'Failed text extraction must drain early visual detection');
    const result = { status: 'passed', model_calls: 0, output: root, actual_runner_e2e: true,
      text_completion_overlaps: true, next_detection_overlaps: true, serial_and_pipelined_psd_exact: true,
      all_recursive_input_and_hole_bytes_identical: true,
      detector_call_count_unchanged: true, pending_geometry_and_hints_preserved: true,
      extraction_failure_drained: true, detection_failure_predecessor_committed: true, resume_passed: true, round_guard_preserved: true,
      visual_window_psd_and_holes_exact:true,window_failure_drain_and_resume:true,final_background_overlaps:true,text_visual_overlap_and_failure_draining:true };
    await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  }
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
