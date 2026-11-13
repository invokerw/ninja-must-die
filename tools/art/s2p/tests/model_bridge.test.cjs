const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const tool = path.resolve(__dirname, '..'), engine = path.join(tool, 'engine');
const {controllerDefaults} = require('../engine/node/codex_config');
const {responsesPayload, chatResult, adaptController} = require('../engine/node/controller_client');

function scope(t) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's2p bridge ')));
	t.after(() => fs.rmSync(root, {recursive:true,force:true}));
	return root;
}
function codex(file, {base='http://127.0.0.1:1/v1',model='configured-controller',wire='responses'} = {}) {
	fs.writeFileSync(file, `model = "${model}"\nmodel_provider = "local-test"\nmodel_reasoning_effort = "high"\n[model_providers."local-test"]\nbase_url = "${base}"\nwire_api = "${wire}"\nenv_key = "S2P_FIXTURE_KEY"\nexperimental_bearer_token = "DO_NOT_IMPORT_TOKEN"\n[profiles."fast.profile"]\nmodel = "profile-controller"\nmodel_reasoning_effort = "low"\n`);
}
function cleanEnv(extra={}) {
	const env = {...process.env};
	for (const key of Object.keys(env)) if (/^(S2P_|LAYERFORGE_|BBOX_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
	return {...env,...extra};
}

test('TOML profile、公开字段白名单、环境密钥名及任务快照，缺失/错误配置明确失败', t => {
	const root = scope(t), file = path.join(root, 'config.toml');
	codex(file);
	const resolved = controllerDefaults({file,profile:'fast.profile',env:{}});
	assert.equal(resolved.model,'profile-controller');
	assert.equal(resolved.reasoning_effort,'low');
	assert.equal(resolved.config_source.scope,'configured_default');
	assert.equal(resolved.credential_env,'S2P_FIXTURE_KEY');
	assert(!JSON.stringify(resolved).includes('DO_NOT_IMPORT_TOKEN'));
	assert.throws(() => controllerDefaults({file,profile:'missing',env:{}}),/profile 不存在/);
	assert.throws(() => controllerDefaults({file,profile:'../outside',env:{}}),/名称无效/);
	fs.writeFileSync(path.join(root,'separate.config.toml'),'model="separate-controller"\n');
	assert.equal(controllerDefaults({file,profile:'separate',env:{}}).model,'separate-controller');
	fs.unlinkSync(file);
	assert.throws(() => controllerDefaults({file,env:{}}),/无法读取/);
	assert.equal(controllerDefaults({env:{S2P_CONTROLLER_SNAPSHOT:JSON.stringify(resolved)}}).model,'profile-controller');
	assert.throws(() => controllerDefaults({profile:'different',env:{S2P_CONTROLLER_SNAPSHOT:JSON.stringify(resolved)}}),/续跑必须/);
	fs.writeFileSync(file,'bad = "DO_NOT_PRINT_SECRET');
	assert.throws(() => controllerDefaults({file,env:{}}),error => !error.message.includes('DO_NOT_PRINT_SECRET'));
	codex(file,{base:'http://user:password@localhost/v1'});
	assert.throws(() => controllerDefaults({file,env:{}}),/不含凭据/);
});

test('Responses 精确保留多图、JSON schema、token 与推理参数，拒绝/截断/空结果不会伪装成功', async () => {
	const payload = {model:'controller',max_completion_tokens:123,reasoning_effort:'low',response_format:{type:'json_schema',json_schema:{name:'box',strict:true,schema:{type:'object'}}},messages:[
		{role:'system',content:'Return JSON.'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,one',detail:'high'}},{type:'image_url',image_url:{url:'data:image/png;base64,two'}},{type:'text',text:'Inspect both.'}]}]};
	const copy = JSON.stringify(payload), adapted = responsesPayload(payload,{reasoning_effort:'high'});
	assert.equal(JSON.stringify(payload),copy);
	assert.equal(adapted.store,false);assert.equal(adapted.max_output_tokens,123);
	assert.deepEqual(adapted.reasoning,{effort:'low'});
	assert.equal(adapted.input[1].content.filter(part => part.type === 'input_image').length,2);
	assert.deepEqual(adapted.text.format,{type:'json_schema',...payload.response_format.json_schema});
	assert(!responsesPayload({...payload,reasoning_effort:null}, {reasoning_effort:'high'}).reasoning);
	const completed = {status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}};
	assert.equal(chatResult(completed).choices[0].message.content,'{"ok":true}');
	assert.equal(chatResult({...completed,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}).choices[0].finish_reason,'length');
	assert.throws(() => chatResult({...completed,output:[{type:'message',content:[{type:'refusal',refusal:'blocked'}]}]}),/拒绝/);
	assert.throws(() => chatResult({status:'completed',output:[]}),/未返回文字/);
	assert.throws(() => chatResult({status:'failed',error:{message:'secret'}}),/未完成/);
	let calls=0;
	const client = {chat:{completions:{create:async request=>{calls++;assert(!Object.hasOwn(request,'reasoning_effort'));return 'chat';}}},responses:{create:async()=>{throw Error('wrong endpoint');}}};
	assert.equal(await adaptController(client,{wire_api:'chat_completions',reasoning_effort:'high'}).chat.completions.create({...payload,reasoning_effort:null}),'chat');
	assert.equal(calls,1);
});

test('真实 SDK 经本地 HTTP 验证 Responses/Chat、诊断、模型列表、透明图像能力和脱敏', async t => {
	const root = scope(t), calls=[];
	const sharp = require('../engine/node_modules/sharp');
	const png = await sharp({create:{width:2,height:2,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:await sharp({create:{width:1,height:1,channels:4,background:'#ff0000'}}).png().toBuffer(),left:0,top:0}]).png().toBuffer();
	let serverError = false;
	const server = http.createServer(async (req,res) => {
		const chunks=[];for await (const chunk of req) chunks.push(chunk);
		const body=Buffer.concat(chunks).toString();calls.push({url:req.url,body,auth:req.headers.authorization});
		res.setHeader('Content-Type','application/json');
		if (serverError) {res.statusCode=401;res.end(JSON.stringify({error:{message:'SECRET_ECHO_S2P_FIXTURE',type:'auth'}}));return;}
		if (req.url.endsWith('/models')) {res.end(JSON.stringify({object:'list',data:[{id:'model-b'},{id:'model-a'}]}));return;}
		if (req.url.endsWith('/images/edits')) {res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));return;}
		const content='{"color":"red"}';
		res.end(JSON.stringify(req.url.endsWith('/responses') ? {id:'response-fixture',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:content}]}]} : {choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
	});
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	t.after(()=>new Promise(resolve=>server.close(resolve)));
	const base='http://127.0.0.1:'+server.address().port+'/v1', codexFile=path.join(root,'codex.toml'), config=path.join(root,'config.json');
	codex(codexFile,{base});
	fs.writeFileSync(config,JSON.stringify({llm:{routes:{controller:{source:'codex'},image:{base_url:base,api_key:'fixture-image',env:{base_url:[],api_key:[]}}}}}));
	const env=cleanEnv({LAYERFORGE_CONFIG:config,S2P_CODEX_CONFIG:codexFile,S2P_FIXTURE_KEY:'fixture-controller'});
	async function invoke(args,extra={}) { return exec(process.execPath,args,{cwd:engine,env:{...env,...extra},timeout:30000,maxBuffer:2**20}); }
	let result=JSON.parse((await invoke([path.join(tool,'cli.cjs'),'doctor','--config',config])).stdout);
	assert.equal(calls.length,0);assert.equal(result.model_calls,0);assert.equal(result.routes.controller.credential_available,true);
	assert.equal(result.routes.controller.wire_api,'responses');assert(!JSON.stringify(result).includes('fixture-controller'));
	result=JSON.parse((await invoke([path.join(tool,'cli.cjs'),'doctor','--config',config,'--online','--image-probe'])).stdout);
	assert.equal(result.status,'ready');assert.equal(result.model_calls,2);
	assert.equal(calls[0].url,'/v1/responses');assert.equal(calls[0].auth,'Bearer fixture-controller');
	const request=JSON.parse(calls[0].body);assert.equal(request.model,'configured-controller');assert.equal(request.store,false);
	assert.equal(request.text.format.type,'json_object');assert(request.input[0].content.some(part=>part.type==='input_image'));
	assert.equal(calls[1].url,'/v1/images/edits');assert.equal(calls[1].auth,'Bearer fixture-image');
	assert.equal((calls[1].body.match(/filename=/g)||[]).length,2);
	result=JSON.parse((await invoke([path.join(tool,'cli.cjs'),'models','--config',config])).stdout);
	assert.deepEqual(result.model_ids,['model-a','model-b']);assert.equal(result.capability_status,'not_inferred_from_model_names');
	await invoke(['-e',"const {openaiClient}=require('./node/layerforge');openaiClient('controller').chat.completions.create({model:'override',messages:[{role:'user',content:'JSON'}]}).then(()=>{});"],{LAYERFORGE_CONTROLLER_WIRE_API:'chat_completions'});
	assert.equal(calls.at(-1).url,'/v1/chat/completions');
	serverError=true;
	try {await invoke([path.join(tool,'cli.cjs'),'doctor','--config',config,'--online']);assert.fail('401 must fail');}
	catch(error) {const diagnostic=JSON.parse(error.stdout);assert.equal(diagnostic.routes.controller.probe.http_status,401);assert(!error.stdout.includes('SECRET_ECHO'));assert(!error.stderr.includes('SECRET_ECHO'));}
});

test('真实 CLI 的模拟拆层在 Codex 默认值改动/文件删除后仍按任务快照续跑', async t => {
	const root=scope(t), config=path.join(root,'config.json'), codexFile=path.join(root,'codex.toml'), source=path.join(root,'input.png'), output=path.join(root,'run');
	codex(codexFile);
	await require('../engine/node_modules/sharp')({create:{width:32,height:24,channels:4,background:'#406080'}}).png().toFile(source);
	const routes={controller:{source:'codex'}};
	for(const role of ['image','background']) routes[role]={api_key:'fixture',env:{api_key:[]}};
	fs.writeFileSync(config,JSON.stringify({llm:{routes}}));
	const env=cleanEnv({LAYERFORGE_CONFIG:config,S2P_CODEX_CONFIG:codexFile,S2P_FIXTURE_KEY:'fixture-controller',
		NODE_OPTIONS:'--require='+JSON.stringify(path.join(engine,'node/bbox_pipeline_checks.js')),
		BBOX_PIPELINE_MOCK:'1',BBOX_PIPELINE_TRACE:path.join(root,'trace.jsonl')});
	const args=[path.join(tool,'cli.cjs'),'run','--source',source,'--output',output,'--config',config,'--visual-window','3','--max-rounds','4'];
	await exec(process.execPath,args,{cwd:engine,env,timeout:30000,maxBuffer:2**20});
	const manifest=JSON.parse(fs.readFileSync(path.join(output,'run_manifest.json')));
	assert.equal(manifest.model_config.routes.controller.model,'configured-controller');
	assert(!JSON.stringify(manifest).includes('fixture-controller'));
	codex(codexFile,{model:'changed-controller'});
	await exec(process.execPath,[...args,'--resume'],{cwd:engine,env,timeout:30000,maxBuffer:2**20});
	fs.unlinkSync(codexFile);
	await exec(process.execPath,[...args,'--resume'],{cwd:engine,env,timeout:30000,maxBuffer:2**20});
	const before=fs.readFileSync(path.join(output,'run_manifest.json'));
	await assert.rejects(exec(process.execPath,[...args,'--resume','--controller-model','override-controller'],{cwd:engine,env,timeout:30000,maxBuffer:2**20}),/Model configuration changed/);
	assert(before.equals(fs.readFileSync(path.join(output,'run_manifest.json'))));
});
