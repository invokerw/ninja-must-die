const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const tool = path.resolve(__dirname,'..'), engine = path.join(tool,'engine');
const {controllerDefaults,gatewayCredential} = require('../engine/node/codex_config');
function setup(t) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'s2p credential ')));
	t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
	return root;
}
function writeProvider(file,{base='https://gateway.invalid/v1',token='INLINE_CANARY_ONE',login=false}={}) {
	fs.writeFileSync(file,`model="test-controller"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="${base}"\nwire_api="responses"\nrequires_openai_auth=${login}\nenv_key="S2P_GATEWAY_KEY"\nexperimental_bearer_token="${token}"\n`);
}
function envFor(config,file,extra={}) {
	const env = {...process.env};
	for (const key of Object.keys(env)) if (/^(S2P_|LAYERFORGE_|BBOX_)/.test(key) || key==='NODE_OPTIONS') delete env[key];
	return {...env,LAYERFORGE_CONFIG:config,S2P_CODEX_CONFIG:file,...extra};
}

test('复用绑定网关 API 凭据，轮换实时生效；不同主机、端口、路径、协议和登录态均不被自动复用', t => {
	const root=setup(t),file=path.join(root,'codex.toml');
	writeProvider(file);
	const defaults=controllerDefaults({file,env:{}}),binding=defaults.credential_binding;
	assert(!JSON.stringify(defaults).includes('INLINE_CANARY'));
	assert.equal(gatewayCredential(binding,'https://gateway.invalid/v1/',{env:{}}).key,'INLINE_CANARY_ONE');
	writeProvider(file,{token:'INLINE_CANARY_TWO'});
	assert.equal(gatewayCredential(binding,'https://gateway.invalid',{env:{}}).key,'INLINE_CANARY_TWO');
	for (const destination of ['https://other.invalid/v1','https://gateway.invalid:1234/v1','https://gateway.invalid/other/v1','http://gateway.invalid/v1']) {
		const result=gatewayCredential(binding,destination,{env:{S2P_GATEWAY_KEY:'ENV_CANARY'}});
		assert.equal(result.key,'');assert.equal(result.reason,'gateway_mismatch');
	}
	assert.equal(gatewayCredential(binding,binding.base_url,{env:{S2P_GATEWAY_KEY:'ENV_CANARY'}}).key,'ENV_CANARY');
	writeProvider(file,{login:true});
	assert.equal(gatewayCredential(binding,binding.base_url,{env:{}}).reason,'login_auth_not_reused');
	writeProvider(file,{base:'https://different.invalid/v1'});
	assert.equal(gatewayCredential(binding,binding.base_url,{env:{}}).reason,'provider_gateway_changed');
	fs.unlinkSync(file);
	assert.equal(gatewayCredential(binding,binding.base_url,{env:{}}).key,'');
});

test('真实 SDK 同网关复用内联 API key；覆盖和禁用生效，公开报告与任务快照无密钥', async t => {
	const root=setup(t),file=path.join(root,'codex.toml'),config=path.join(root,'config.json');
	const requests=[];
	const server=http.createServer(async(req,res)=>{
		for await(const _chunk of req) {}
		requests.push({path:req.url,auth:req.headers.authorization});
		res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'test-controller'},{id:'fixed-image'}]}));
	});
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	t.after(()=>new Promise(resolve=>server.close(resolve)));
	const base='http://127.0.0.1:'+server.address().port+'/v1';
	writeProvider(file,{base});
	const routes={controller:{source:'codex'},image:{model:'fixed-image',gateway_source:'codex',credential_source:'codex'},background:{inherits:'image'}};
	fs.writeFileSync(config,JSON.stringify({llm:{routes}}));
	fs.writeFileSync(path.join(root,'.env.local'),'LAYERFORGE_CONTROLLER_API_KEY=\nLAYERFORGE_BACKGROUND_API_KEY=\n');
	const env=envFor(config,file);
	const run=(args,extra={})=>exec(process.execPath,args,{cwd:engine,env:{...env,...extra},timeout:30000,maxBuffer:2**20});
	const doctorArgs=[path.join(tool,'cli.cjs'),'doctor','--config',config];
	const observed=JSON.parse((await run(doctorArgs)).stdout);
	assert.equal(requests.length,0);assert.equal(observed.status,'ready');
	for(const role of ['controller','background']) {
		assert.equal(observed.routes[role].credential_origin,'codex_gateway_bearer');
		assert.equal(observed.routes[role].base_url,base);
	}
	assert.equal(observed.routes.background.model,'fixed-image');
	assert(!JSON.stringify(observed).includes('INLINE_CANARY'));
	for(const role of ['controller','background']) await run([path.join(tool,'cli.cjs'),'models','--config',config,'--role',role]);
	assert.equal(requests.length,2);assert(requests.every(request=>request.auth==='Bearer INLINE_CANARY_ONE'));
	await run([path.join(tool,'cli.cjs'),'models','--config',config],{LAYERFORGE_CONTROLLER_API_KEY:'EXPLICIT_CANARY'});
	assert.equal(requests.at(-1).auth,'Bearer EXPLICIT_CANARY');
	const blocked=await run([...doctorArgs,'--controller-url','https://other.invalid/v1']).then(()=>assert.fail('Gateway mismatch must block'),error=>JSON.parse(error.stdout));
	assert.equal(blocked.routes.controller.credential_available,false);
	assert.equal(blocked.routes.controller.credential_reuse_status,'gateway_mismatch');
	routes.controller.credential_source='project';fs.writeFileSync(config,JSON.stringify({llm:{routes}}));
	await assert.rejects(run(doctorArgs),error=>JSON.parse(error.stdout).routes.controller.credential_available===false);
	delete routes.controller.credential_source;
	fs.writeFileSync(config,JSON.stringify({llm:{routes}}));
	const source=path.join(root,'input.png'),output=path.join(root,'run');
	await require('../engine/node_modules/sharp')({create:{width:32,height:24,channels:4,background:'#406080'}}).png().toFile(source);
	const mock={NODE_OPTIONS:'--require='+JSON.stringify(path.join(engine,'node/bbox_pipeline_checks.js')),BBOX_PIPELINE_MOCK:'1',BBOX_PIPELINE_TRACE:path.join(root,'trace.jsonl')};
	const args=[path.join(tool,'cli.cjs'),'run','--config',config,'--source',source,'--output',output,'--visual-window','3','--max-rounds','4'];
	const initial=await run(args,mock);assert(!initial.stdout.includes('INLINE_CANARY'));
	writeProvider(file,{base,token:'INLINE_CANARY_ROTATED'});
	await run([...args,'--resume'],mock);
	for(const name of fs.readdirSync(output,{recursive:true})) {
		const candidate=path.join(output,name);
		if(fs.statSync(candidate).isFile()&&/\.(json|log|html|js|cjs)$/.test(name)) assert(!fs.readFileSync(candidate,'utf8').includes('INLINE_CANARY'),'Credential persisted in '+name);
	}
	assert(!fs.readFileSync(config,'utf8').includes('INLINE_CANARY'));
});
