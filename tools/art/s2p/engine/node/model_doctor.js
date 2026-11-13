#!/usr/bin/env node
// Explicit online probes use the configured API credentials; default diagnostics are local only.
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
function safeFailure(error) {
	const status = Number(error.status);
	return {status:'failed', ...(Number.isInteger(status) && status >= 100 && status < 600 ? {http_status:status} : {}),
		reason:status === 401 || status === 403 ? '接口鉴权失败或无权限。' : status === 404 ? '接口路径或模型不可用。' : status === 429 ? '接口限流。' : '请求、响应格式或能力检查失败；未输出可能含敏感内容的服务端错误。'};
}
function routeSummary(role) {
	const config = require('./model_config');
	const route = config.getRoute(role);
	return {role, ...config.publicConfig().routes[role], credential_available:Boolean(route.api_key),
		credential_policy:'explicit_key_then_bound_codex_gateway', credential_origin:route.credential_origin,
		...(route.credential_reuse_status ? {credential_reuse_status:route.credential_reuse_status} : {}),
		key_environment:role === 'controller' ? ['LAYERFORGE_CONTROLLER_API_KEY', ...(route.credential_env ? [route.credential_env] : [])] : ['LAYERFORGE_BACKGROUND_API_KEY'], capability_status:'not_tested'};
}
async function probeController(client, route) {
	const sharp = require('sharp');
	const png = await sharp({create:{width:16,height:16,channels:4,background:'#ff0000'}}).png().toBuffer();
	const response = await client.chat.completions.create({model:route.model, max_completion_tokens:4096,
		response_format:{type:'json_object'}, messages:[{role:'user', content:[
			{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64')}},
			{type:'text',text:'Inspect the image. Return only a JSON object with one property "color", the lowercase English name of the solid color shown.'},
		]}]}, {timeout:30000,maxRetries:0});
	if (response.choices?.[0]?.finish_reason !== 'stop' || JSON.parse(response.choices[0].message.content).color !== 'red') throw Error('Controller probe failed');
	return {status:'passed', checks:['image_input','json_output'], scope:'single_small_probe'};
}
async function probeImage(client, route) {
	const sharp = require('sharp');
	const {toFile} = require('openai');
	const png = await sharp({create:{width:16,height:16,channels:4,background:'#ff0000'}}).png().toBuffer();
	const image = await toFile(png, 'probe.png', {type:'image/png'});
	const other = await toFile(png, 'reference.png', {type:'image/png'});
	const result = await client.images.edit({model:route.model, image:[image,other], background:'transparent',
		quality:route.quality, size:'1024x1024', prompt:'Use the references to draw one small solid red circle centered on a fully transparent background. Keep most pixels transparent.'}, {timeout:route.timeout_ms,maxRetries:0});
	// Never follow arbitrary media URLs returned by a provider.
	if (!result.data?.[0]?.b64_json) throw Error('Image probe requires inline PNG');
	const pngBytes = Buffer.from(result.data[0].b64_json, 'base64');
	if (!pngBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Image probe requires PNG');
	const {data,info} = await sharp(pngBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
	let transparent = false, visible = false;
	for (let offset = 3; offset < data.length; offset += info.channels) {
		transparent ||= data[offset] === 0;
		visible ||= data[offset] > 0;
	}
	if (!transparent || !visible) throw Error('Image probe requires real transparency and visible content');
	return {status:'passed', checks:['multiple_image_inputs','inline_png','transparent_pixels','visible_pixels'], scope:'single_small_probe'};
}
async function diagnose({online = false, imageProbe = false} = {}) {
	const result = {command:'doctor', online:Boolean(online || imageProbe), model_calls:0, routes:{}, limitations:[
		'Codex 来源表示配置文件中的默认值，不代表当前聊天临时选中的模型。',
		'网关 API 凭据仅在运行时复用，并绑定网关地址；不读取 auth.json 登录会话，也不保存密钥。',
	]};
	for (const role of ['controller','background']) {
		const summary = routeSummary(role);
		result.routes[role] = summary;
		if (!(role === 'controller' ? online : imageProbe)) continue;
		if (!summary.credential_available) { summary.probe = {status:'blocked', reason:'未配置 API 密钥。'}; continue; }
		try {
			const {openaiClient} = require('./layerforge');
			const route = require('./model_config').getRoute(role);
			result.model_calls++;
			summary.probe = await (role === 'controller' ? probeController : probeImage)(openaiClient(role), route);
			summary.capability_status = 'probe_passed';
		} catch (error) { summary.probe = safeFailure(error); }
	}
	result.status = Object.values(result.routes).every(route => route.credential_available && (!route.probe || route.probe.status === 'passed')) ? 'ready' : 'needs_configuration';
	return result;
}
async function models(role = 'controller') {
	if (!['controller','background'].includes(role)) throw Error('models --role 仅支持 controller 或 background。');
	const summary = routeSummary(role);
	if (!summary.credential_available) return {command:'models', status:'blocked', route:summary, reason:'未配置 API 密钥。'};
	try {
		const result = await require('./layerforge').openaiClient(role).models.list({timeout:15000,maxRetries:0});
		return {command:'models', status:'passed', route:summary, model_ids:result.data.map(model => model.id).sort(),
			has_more:Boolean(result.has_more), capability_status:'not_inferred_from_model_names'};
	} catch (error) { return {command:'models', route:summary, ...safeFailure(error)}; }
}
async function main(argv = process.argv.slice(2)) {
	const {values,positionals} = parseArgs({args:argv,allowPositionals:true,options:{config:{type:'string'},'env-file':{type:'string'},online:{type:'boolean'},'image-probe':{type:'boolean'},role:{type:'string'}}});
	if (positionals.length !== 1 || !['doctor','models'].includes(positionals[0])) throw Error('需要 doctor 或 models 命令。');
	if (values.config) process.env.LAYERFORGE_CONFIG = path.resolve(values.config);
	if (values['env-file']) {
		const file = path.resolve(values['env-file']);
		if (!fs.existsSync(file)) throw Error('环境文件不存在。');
		require('./model_config').loadEnv(file);
	}
	const result = positionals[0] === 'doctor' ? await diagnose({online:values.online,imageProbe:values['image-probe']}) : await models(values.role);
	console.log(JSON.stringify(result,null,2));
	if (!['ready','passed'].includes(result.status)) process.exitCode = 1;
}
module.exports = {diagnose,models,probeController,probeImage,safeFailure};
if (require.main === module) main().catch(error => {console.error(JSON.stringify({status:'failed',reason:error.code === 'S2P_CODEX_CONFIG' ? error.message : '无法解析模型配置或诊断参数；请检查本地 JSON / TOML、profile 和命令选项。'}));process.exitCode=1;});
