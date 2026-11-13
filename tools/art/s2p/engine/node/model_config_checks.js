// Real SDK requests against a loopback fixture; no external model calls.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const sharp=require('sharp');
const exec=promisify(execFile),ROOT=path.resolve(__dirname,'..');
async function main(){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'psd-node-config-'));
  const file=path.join(temporary,'config.json'),requests=[];
  const png=await sharp({create:{width:8,height:8,channels:4,background:'#143c64'}}).png().toBuffer();
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks)});
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url.endsWith('chat/completions')?{choices:[{index:0,message:{role:'assistant',content:'{}'},finish_reason:'stop'}]}:{data:[{b64_json:png.toString('base64')}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const config=JSON.parse(await fs.readFile(path.join(ROOT,'config.example.json'),'utf8'));
    const disable=Object.fromEntries(['api_key','base_url','model','quality','timeout_ms','max_retries','provider'].map(k=>[k,[]]));
    for(const [name,route]of Object.entries(config.llm.routes))Object.assign(route,{env:disable,api_key:'fixture-'+name,base_url:`http://127.0.0.1:${server.address().port}/${name}/v1`,model:'test-'+name,quality:'high',timeout_ms:12345,max_retries:0});
    const env={...process.env,LAYERFORGE_CONFIG:file};
    const save=()=>fs.writeFile(file,JSON.stringify(config));
    const run=code=>exec(process.execPath,['-e',code],{cwd:ROOT,env,windowsHide:true,timeout:30000});
    await save();
    const publicResult=await run("console.log(JSON.stringify(require('./node/model_config').publicConfig()))");
    assert(!publicResult.stdout.includes('api_key'));assert(!publicResult.stdout.includes('fixture-'));
    assert.equal(JSON.parse(publicResult.stdout).routes.background.model,'test-background');
    console.log('PASS: shared Node configuration exposes routes without credentials');
    config.llm.routes.background={inherits:'image',env:{...disable,model:['PSD_TEST_MODEL']}};
    config.llm.routes.image.api_key='${PSD_MISSING_KEY}';env.PSD_TEST_MODEL='custom-background';await save();
    const inherited=JSON.parse((await run("console.log(JSON.stringify(require('./node/model_config').getRoute('background-repair')))")).stdout);
    assert.equal(inherited.api_key,'');assert.equal(inherited.model,'custom-background');assert.equal(inherited.base_url,config.llm.routes.image.base_url);
    await assert.rejects(run("require('./node/layerforge').openaiClient('background')"));
    delete env.PSD_TEST_MODEL;
    config.llm.routes.image.api_key='fixture-image';config.llm.routes.background={...config.llm.routes.image,model:'gpt-image-2.5-sunburst',api_key:'fixture-background',base_url:`http://127.0.0.1:${server.address().port}/background/v1`};await save();
    const source=path.join(temporary,'source.png');await fs.writeFile(source,png);env.PSD_TEST_SOURCE=source;env.PSD_TEST_OUTPUT=path.join(temporary,'out.png');
    await run(`const {openaiClient,imageEdit}=require('./node/layerforge');const {modelFor}=require('./node/model_config');(async()=>{await openaiClient('controller').chat.completions.create({model:modelFor('controller'),messages:[{role:'user',content:'test'}]});await imageEdit(process.env.PSD_TEST_SOURCE,process.env.PSD_TEST_OUTPUT,'test',modelFor('background'),null,null,{clientKind:'background-repair',resizeOutput:false,maxAttempts:1});})().catch(e=>{console.error(e.message);process.exitCode=1;});`);
    assert.equal(requests.length,2);assert.equal(requests[0].url,'/controller/v1/chat/completions');assert.equal(requests[0].auth,'Bearer fixture-controller');assert.equal(JSON.parse(requests[0].body).model,'test-controller');
    assert.equal(requests[1].url,'/background/v1/images/edits');assert.equal(requests[1].auth,'Bearer fixture-background');
    const multipart=requests[1].body.toString();assert(multipart.includes('gpt-image-2.5-sunburst'));assert(/name="quality"\r\n\r\nhigh\r\n/.test(multipart));assert(!multipart.includes('name="input_fidelity"'));
    console.log('PASS: actual Node SDK sends configured model, URL, quality and auth');
    const valid=JSON.stringify(config);
    for(const invalid of ['missing','malformed','cycle','timeout']){
      if(invalid==='missing')await fs.unlink(file);
      else if(invalid==='malformed')await fs.writeFile(file,'{broken');
      else{const changed=JSON.parse(valid);if(invalid==='cycle')changed.llm.routes.image.inherits='background';else changed.llm.routes.image.timeout_ms=-1;await fs.writeFile(file,JSON.stringify(changed));}
      await assert.rejects(run("require('./node/model_config').publicConfig()"));await fs.writeFile(file,valid);
    }
    console.log('PASS: missing/malformed configuration, inheritance cycle and invalid timeout fail before requests');
    const before=requests.length;
    const preflight=await exec(process.execPath,[path.join(ROOT,'node/psd.js'),'preflight','--config',file],{cwd:ROOT,env,windowsHide:true,timeout:30000});
    assert.equal(JSON.parse(preflight.stdout).model_calls,0);assert(!preflight.stdout.includes('fixture-'));assert.equal(requests.length,before);
    console.log('PASS: canonical Node preflight makes zero model calls');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    // Temporary fixture directory intentionally retained for failure diagnosis.
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
