// Check resume identity, evidence reporting and portable archive integrity.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const zlib=require('node:zlib');
const {execFileSync}=require('node:child_process');
const {options,runSettings,validateResume,report,digest}=require('./psd');
const {zip}=require('./psd_archive');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'psd-node-runner-'));
const write=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
const source=path.join(directory,'source.png');fs.writeFileSync(source,'fixture-source');
const settings=runSettings(options(['run','--source',source,'--visual-window','3','--local-detection-inputs','--combined-detection']));
const records=[{relative:'pipeline.js',sha256:'abc'}],models={routes:{background:{model:'fixture'}}};
const manifest={source_sha256:digest(source),sources:records,model_config:models,...settings};
validateResume(manifest,source,records,models,settings);
for(const [key,value]of Object.entries(settings)){
  const changed={...settings,[key]:typeof value==='boolean'?!value:typeof value==='number'?value+1:'changed'};
  assert.throws(()=>validateResume(manifest,source,records,models,changed),/Run setting changed/);
}
assert.throws(()=>validateResume(manifest,source,[{relative:'pipeline.js',sha256:'def'}],models,settings),/Pipeline code/);
assert.throws(()=>validateResume(manifest,source,records,{routes:{}},settings),/Model configuration changed/);
fs.appendFileSync(source,'changed');assert.throws(()=>validateResume(manifest,source,records,models,settings),/Source image changed/);
for(const args of [['run','--serial','--visual-window','3'],['run','--visual-batch-size','0'],['report','--port','65536'],['run','--bogus']])assert.throws(()=>options(args));
console.log('PASS: source/code/models and every saved run setting gate resume before model calls');
write('status.json',{status:'completed',source,started_at:'2026-01-01T00:00:00Z',ended_at:'2026-01-01T00:00:05Z',verification:{status:'passed'},loops:[]});
assert.equal(report(directory).structural_verification,'not_checked');
write('verification.json',{status:'failed'});assert.equal(report(directory).structural_verification,'failed');
write('verification.json',{status:'passed'});fs.mkdirSync(path.join(directory,'inspection'));write('inspection/visual_review.json',{status:'needs_review',findings:['fixture']});
const result=report(directory);assert.equal(result.elapsed_seconds,5);assert.equal(result.visual_review.status,'needs_review');assert.equal(result.structural_verification,'passed');
const html=fs.readFileSync(path.join(directory,'result.html'),'utf8');assert(html.includes('min="0" max="1"'));assert(!html.includes('__RUN_ROOT_JSON__'));
console.log('PASS: report separates independent PSD verification from visual review; unified 0–1 comparison remains');
const text=path.join(directory,'测试.md');fs.writeFileSync(text,'UTF8 fixture 测试');const archive=path.join(directory,'archive.zip');zip(directory,[text],archive);
const bytes=fs.readFileSync(archive);assert.equal(bytes.readUInt32LE(0),0x04034b50);const n=bytes.readUInt16LE(26),size=bytes.readUInt32LE(18);
assert.equal(bytes.subarray(30,30+n).toString(),'测试.md');assert.deepEqual(zlib.inflateRawSync(bytes.subarray(30+n,30+n+size)),fs.readFileSync(text));
assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
console.log('PASS: UTF8 ZIP archive payload round-trips');
async function cliCheck(){
  const sharp=require('sharp'),{promisify}=require('node:util'),{execFile}=require('node:child_process');
  const input=path.join(directory,'input.png'),output=path.join(directory,'cli-run'),config=path.join(directory,'models.json');
  await sharp({create:{width:32,height:24,channels:4,background:'#406080'}}).png().toFile(input);
  fs.writeFileSync(config,JSON.stringify({llm:{routes:Object.fromEntries(['controller','image','background'].map(role=>[role,{api_key:'local-fixture',env:{api_key:[]}}]))}}));
  const env={...process.env,LAYERFORGE_CONFIG:config,NODE_OPTIONS:`--require="${path.join(__dirname,'bbox_pipeline_checks.js').replace(/\\/g,'/')}"`,BBOX_PIPELINE_MOCK:'1',BBOX_PIPELINE_TRACE:path.join(directory,'trace.jsonl')};
  let server;
  try{
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(__dirname,'psd.js'),'run','--source',input,'--output',output,'--config',config,'--visual-window','3','--max-rounds','4','--serve','--port','18945'],{env,cwd:path.dirname(__dirname),windowsHide:true,timeout:30000,maxBuffer:2**20});
    fs.writeFileSync(path.join(directory,'cli.log'),stdout);
    server=JSON.parse(fs.readFileSync(path.join(output,'web_server.json'),'utf8'));
    const result=JSON.parse(fs.readFileSync(path.join(output,'run_result.json'),'utf8'));
    assert.equal(result.status,'completed');assert.equal(result.structural_verification,'passed');
    assert.equal(fs.readFileSync(input).equals(fs.readFileSync(path.join(output,'input.png'))),true);
    const response=await fetch(result.web);assert.equal(response.status,200);assert((await response.text()).includes('id="blend"'));
    const download=await fetch(result.web.replace('result.html','layers.psd'),{method:'HEAD'});assert.equal(download.status,200);assert(Number(download.headers.get('content-length'))>0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output,'run_manifest.json'),'utf8')).runtime,'node');
    console.log('PASS: canonical Node CLI completes deterministic PSD export/readback, comparison and detached HTTP download with zero model calls');
  }finally{
    if(!server&&fs.existsSync(path.join(output,'web_server.json')))server=JSON.parse(fs.readFileSync(path.join(output,'web_server.json'),'utf8'));
    if(server)process.kill(server.pid);
  }
}
cliCheck().catch(error=>{console.error(error.stack);process.exitCode=1;});
