#!/usr/bin/env node
// The single supported screenshot-to-PSD CLI. No Python runtime is required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const {parseArgs} = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const PIPELINE_FILES = [
  'node/psd.js', 'node/psd_compare.js', 'node/psd_result.html', 'node/psd_server.js',
  'node/model_config.js', 'node/codex_config.js', 'node/controller_client.js', 'package.json', 'package-lock.json', 'config.example.json', 'node/bbox_recursive_test.js',
  'node/bbox_recursive_core.js', 'node/bbox_recursive_previews.js', 'node/bbox_image_requests.js',
  'node/bbox_atlas_pixels.js', 'node/bbox_two_loop_test.js', 'node/rear_coupled_composites.js',
  'node/layerforge.js', 'web/run-timing.js', 'node/bbox_surface_geometry.js',
  'node/bbox_model_rgba.js', 'node/bbox_wide_surface.js', 'node/bbox_text_atlas.js',
  'node/bbox_visual_atlas.js', 'node/bbox_detection_cache.js', 'node/bbox_visual_window.js',
  'node/bbox_combined_detection.js', 'node/job_retry.js', 'node/bbox_two_loop_harmonize.js',
];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2)+'\n');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function resultPage(output) {
  const template = fs.readFileSync(path.join(__dirname, 'psd_result.html'), 'utf8');
  fs.writeFileSync(path.join(output, 'result.html'), template.replace('__RUN_ROOT_JSON__', JSON.stringify(output).replace(/</g, '\\u003c')));
}
function identity(records) {
  const result = {};
  for (const entry of records) {
    const name = entry.relative.replace(/\\/g, '/');
    if (name in result && result[name] !== entry.sha256) throw Error('Conflicting pipeline identity: '+name);
    result[name] = entry.sha256;
  }
  return result;
}
const same = (a, b) => JSON.stringify(a, Object.keys(a || {}).sort()) === JSON.stringify(b, Object.keys(b || {}).sort());
function runSettings(args) {
  return {
    scheduling_mode: args.serial ? 'serial' : args['visual-window'] > 1 ? 'bounded_visual_window' : 'one_round_lookahead',
    visual_window: args['visual-window'], batch_size: args['visual-batch-size'],
    detection_mode: args['full-detection'] ? 'full' : 'regional_cache_v1',
    local_detection_inputs: args['local-detection-inputs'], combined_detection: args['combined-detection'],
    surface_style: args['borderless-surfaces'] ? 'borderless' : 'original',
    max_rounds: args['max-rounds'], reuse_text: Boolean(args['reuse-text']),
    reuse_text_source: args['reuse-text'] ? path.resolve(args['reuse-text']) : null,
  };
}
function validateResume(manifest, source, records, models, settings) {
  if (manifest.source_sha256 !== digest(source)) throw Error('Source image changed. Use a new output directory.');
  if (!same(identity([...(manifest.sources || []), ...(manifest.supplemental_sources || [])]), identity(records)))
    throw Error('Pipeline code or dependency list changed. Use a new output directory.');
  if (JSON.stringify(manifest.model_config) !== JSON.stringify(models)) throw Error('Model configuration changed. Use a new output directory.');
  for (const [key, value] of Object.entries(settings)) {
    if (manifest[key] !== value) throw Error('Run setting changed: '+key+'. Resume with the original settings or use a new output directory.');
  }
}
function preflight(project = ROOT) {
  for (const name of PIPELINE_FILES) if (!fs.existsSync(path.join(project, name))) throw Error('Required pipeline file is missing: '+name);
  execFileSync(process.execPath, ['-e', "require('sharp');require('ag-psd');require('openai');require('jsonrepair')"], {cwd:project, windowsHide:true, stdio:'pipe'});
  for (const name of ['node/psd.js', 'node/bbox_recursive_core.js', 'node/bbox_recursive_test.js'])
    execFileSync(process.execPath, ['--check', name], {cwd:project, windowsHide:true, stdio:'pipe'});
  return JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./node/model_config');for(const role of ['controller','background'])if(!c.getRoute(role).api_key)throw Error('Missing API key for '+role);console.log(JSON.stringify(c.publicConfig()));"], {cwd:project, windowsHide:true, encoding:'utf8'}));
}
function report(output) {
  const state = read(path.join(output, 'status.json'));
  resultPage(output);
  const optional = name => fs.existsSync(path.join(output, name)) ? read(path.join(output, name)) : null;
  const verification = optional('verification.json');
  const checkpoint = state.verification?.status, independent = verification?.status;
  const disagreement = Boolean(checkpoint && independent && checkpoint !== independent);
  const fidelity = optional('fidelity_verification.json');
  const regional = fs.readdirSync(output, {withFileTypes:true}).filter(e => e.isDirectory() && /^loop_/.test(e.name))
    .map(e => optional(path.join(e.name, 'detection_reuse.json'))).filter(Boolean);
  const result = {
    status:state.status, source:state.source, output, psd:state.psd,
    elapsed_seconds:state.ended_at ? (Date.parse(state.ended_at)-Date.parse(state.started_at))/1000 : null,
    visual_rounds:Math.max(0, (state.loops || []).length-1), layer_count:state.layer_count,
    structural_verification:disagreement ? ([checkpoint, independent].includes('failed') ? 'failed' : 'evidence_conflict') : independent || 'not_checked',
    structural_evidence:{checkpoint, independent_file:independent, disagreement},
    fidelity_status:fidelity?.status || 'not_checked', checked_opaque_pixels:fidelity?.checked_opaque_pixels || 0,
    pending_objects:fidelity?.pending || [],
    visual_review:optional('inspection/visual_review.json') || state.visual_review || {status:'not_reviewed'},
    model_output_policy:state.model_output_policy, batch_size:state.batch_size, text_batch_size:state.text_batch_size,
    scheduling:state.scheduling || {mode:'serial'}, detection_mode:state.detection_mode || 'full',
    detection_pass:state.detection_pass || 'separate',
    regional_detection_reuse:{reused_regions:regional.reduce((n,r)=>n+(r.reused_regions || 0),0), visual_rounds_checked:regional.filter(r=>r.mode!=='text').length},
    surface_style:state.surface_style || 'original', model_placement_verification:state.model_placement_verification,
    comparison_report:path.join(output, 'result.html'),
    scope:'Returned model RGB/alpha are placed directly with downsampling only; no source-pixel fidelity claim.',
  };
  write(path.join(output, 'run_result.json'), result);
  return result;
}
async function getJson(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      let body = ''; response.on('data', b => body += b);
      response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    request.setTimeout(500, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}
async function serve(output, preferredPort) {
  resultPage(output);
  const root = fs.realpathSync(path.dirname(output)), name = encodeURIComponent(path.basename(output));
  const expected = digest(path.join(output, 'run_manifest.json'));
  for (let port=preferredPort; port<Math.min(preferredPort+10, 65536); port++) {
    const base = `http://127.0.0.1:${port}/`;
    const existing = await getJson(base+'__psd_server__');
    if (existing?.root === root && (await getJson(base+name+'/run_manifest.json'))?.source_sha256 === read(path.join(output, 'run_manifest.json')).source_sha256)
      return base+name+'/result.html';
    const log = fs.openSync(path.join(output, 'web_server.log'), 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'psd_server.js'), root, String(port)], {detached:true, windowsHide:true, stdio:['ignore', log, log]});
    fs.closeSync(log);
    let failure; child.on('error', error => { failure = error; }); child.unref();
    for (let attempt=0; attempt<20; attempt++) {
      await delay(100);
      if (failure || child.exitCode !== null) break;
      const active = await getJson(base+'__psd_server__');
      if (active?.pid === child.pid && active.root === root) {
        write(path.join(output, 'web_server.json'), {pid:child.pid, port, root, manifest_sha256:expected});
        return base+name+'/result.html';
      }
    }
  }
  throw Error('No available local report port');
}
function options(argv) {
  const schema = {
    help:{type:'boolean', short:'h'}, config:{type:'string'}, 'env-file':{type:'string'},
    source:{type:'string'}, output:{type:'string'}, resume:{type:'boolean', default:false}, 'reuse-text':{type:'string'},
    'visual-batch-size':{type:'string', default:'7'}, serial:{type:'boolean', default:false},
    'visual-window':{type:'string', default:'1'}, 'full-detection':{type:'boolean', default:false},
    'local-detection-inputs':{type:'boolean', default:false}, 'combined-detection':{type:'boolean', default:false},
    'borderless-surfaces':{type:'boolean', default:false}, 'max-rounds':{type:'string', default:'24'},
    serve:{type:'boolean', default:false}, port:{type:'string', default:'8925'},
  };
  const {values, positionals} = parseArgs({args:argv, options:schema, allowPositionals:true});
  if (values.help) return {help:true};
  if (positionals.length !== 1 || !['preflight', 'run', 'report'].includes(positionals[0])) throw Error('Expected command: preflight, run or report. Use --help.');
  for (const key of ['visual-batch-size', 'visual-window', 'max-rounds', 'port']) {
    values[key] = Number(values[key]);
    if (!Number.isInteger(values[key]) || values[key] < 1) throw Error('--'+key+' must be a positive integer');
  }
  if (![1,2,3].includes(values['visual-window'])) throw Error('--visual-window must be 1, 2 or 3');
  if (values.serial && values['visual-window'] !== 1) throw Error('--serial requires --visual-window 1');
  if (values.port > 65535) throw Error('--port must be at most 65535');
  return {...values, command:positionals[0]};
}
async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.help) { console.log('Usage: node node/psd.js preflight|run|report [options]\nRun: --source PNG --output EMPTY_DIR [--config JSON] [--env-file DOTENV] [--resume]\n      [--visual-batch-size 7] [--visual-window 1|2|3] [--serial] [--max-rounds 24]\n      [--local-detection-inputs] [--combined-detection] [--full-detection]\n      [--borderless-surfaces] [--reuse-text ARCHIVE] [--serve] [--port 8925]\nReport: --output RUN_DIR [--serve] [--port 8925]'); return; }
  if (args.command === 'report') {
    if (!args.output) throw Error('report requires --output');
    const output = path.resolve(args.output), result = report(output);
    if (args.serve) { result.web = await serve(output, args.port); write(path.join(output, 'run_result.json'), result); }
    console.log(JSON.stringify(result)); return result;
  }
  if (args.config) process.env.LAYERFORGE_CONFIG = path.resolve(args.config);
  if (args['env-file']) {
    const file = path.resolve(args['env-file']);
    if (!fs.existsSync(file)) throw Error('Environment file does not exist: '+file);
    require('./model_config').loadEnv(file);
  }
  // Resume imports the saved public Codex defaults; current credentials remain external.
  if(args.resume && args.output) {
    const manifest=path.join(path.resolve(args.output),'run_manifest.json');
    if(fs.existsSync(manifest)) {
      const saved=read(manifest).model_config?.routes?.controller;
      if(saved?.source==='codex')process.env.S2P_CONTROLLER_SNAPSHOT=JSON.stringify(saved);
    }
  }
  const models = preflight();
  if(models.routes.controller.source==='codex')process.env.S2P_CONTROLLER_SNAPSHOT=JSON.stringify(models.routes.controller);
  if (args.command === 'preflight') { const result = {status:'passed', project:ROOT, node:process.execPath, node_version:process.version, model_calls:0, model_config:models}; console.log(JSON.stringify(result)); return result; }
  if (!args.source) throw Error('run requires --source');
  const source = path.resolve(args.source);
  if (!fs.statSync(source).isFile()) throw Error('Source image does not exist');
  const output = path.resolve(args.output || path.join(path.dirname(source), 'web_runs', 'psd-'+new Date().toISOString().replace(/[:.]/g,'-')));
  fs.mkdirSync(output, {recursive:true});
  const manifestFile = path.join(output, 'run_manifest.json'), settings = runSettings(args);
  const records = PIPELINE_FILES.map(relative => ({file:path.join(ROOT, relative), relative, sha256:digest(path.join(ROOT, relative))}));
  if (args.resume) {
    if (!fs.existsSync(path.join(output, 'status.json')) || !fs.existsSync(manifestFile)) throw Error('Resume requires a saved manifest and checkpoint');
    validateResume(read(manifestFile), source, records, models, settings);
  } else {
    if (fs.readdirSync(output).length) throw Error('Output directory is not empty; use --resume or choose a new directory');
    const manifest = {manifest_version:3, started_at:new Date().toISOString(), source, source_sha256:digest(source),
      runtime:'node', model:models.routes.background.model, quality:models.routes.background.quality, controller:models.routes.controller.model,
      model_config:models, ...settings, text_batch_size:14, geometry_batch_size:7, image_concurrency:2,
      reuse_visual_layers:false, local_corrections:false, source_pixel_recovery:false, quality_retry_per_object:0,
      regional_context_policy:'crop_intersection_v1', text_visual_overlap:args['visual-window']>1,
      model_output_policy:'model_rgba_downscale_only', native_wide_surface_strips:true, sources:records};
    write(manifestFile, manifest);
    for (const entry of records) { const target=path.join(output,'code_snapshot',entry.relative); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(entry.file,target); }
  }
  let web;
  if (args.serve) { web = await serve(output, args.port); console.log(JSON.stringify({web, output})); }
  const env = {...process.env, BBOX_TEST_SOURCE:source,
    BBOX_TEXT_ARCHIVE:args['reuse-text'] ? path.resolve(args['reuse-text']) : path.join(output,'__no_text_archive__'),
    BBOX_VISUAL_BATCH_SIZE:String(args['visual-batch-size']), BBOX_VISUAL_WINDOW:String(args['visual-window']),
    BBOX_INCREMENTAL_DETECTION:args['full-detection']?'0':'1', BBOX_LOCAL_DETECTION:args['local-detection-inputs']?'1':'0',
    BBOX_COMBINED_DETECTION:args['combined-detection']?'1':'0', BBOX_MAX_ROUNDS:String(args['max-rounds']),
    BBOX_IMAGE_CONCURRENCY:'2', BBOX_PIPELINE:args.serial?'0':'1', BBOX_SURFACE_STYLE:settings.surface_style};
  const log = fs.createWriteStream(path.join(output,'run.log'), {flags:'a'});
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node/bbox_recursive_test.js', output], {cwd:ROOT, env, windowsHide:true, stdio:['ignore','pipe','pipe']});
      child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
      child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
      child.on('error', reject); child.on('close', value => resolve(value ?? 1));
    });
  } finally { await new Promise(resolve => log.end(resolve)); }
  for (const entry of records) if (digest(entry.file) !== entry.sha256) throw Error('Pipeline changed while active: '+entry.relative);
  if (fs.existsSync(path.join(output,'status.json'))) {
    let result = report(output);
    if (code === 0 && result.status === 'completed') {
      execFileSync(process.execPath, ['node/psd_compare.js','--project',ROOT,'--output',output], {cwd:ROOT, windowsHide:true, stdio:'inherit'});
      result = report(output);
    }
    if (web) { result.web=web; write(path.join(output,'run_result.json'),result); }
    console.log(JSON.stringify(result));
    if (code === 0 && result.status !== 'completed') throw Error('Pipeline ended without a completed PSD');
  } else if (code === 0) throw Error('Pipeline ended without a checkpoint');
  if (code !== 0) throw Error('PSD pipeline failed (exit '+code+'). See '+path.join(output,'run.log'));
}
module.exports = {main, PIPELINE_FILES, options, preflight, runSettings, validateResume, report, serve, digest};
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
