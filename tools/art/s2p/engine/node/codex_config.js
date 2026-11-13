// Public defaults are serializable; API credentials are resolved separately, only at runtime.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {parse} = require('smol-toml');
const configError = message => Object.assign(new Error(message), {code:'S2P_CODEX_CONFIG'});
const PUBLIC_FIELDS = ['model', 'base_url', 'wire_api', 'reasoning_effort', 'source', 'config_source', 'credential_env', 'credential_binding', 'credential_source'];

function protocol(value = 'responses') {
	if (['chat', 'chat_completions', 'chat/completions'].includes(value)) return 'chat_completions';
	if (value === 'responses') return value;
	throw configError('控制器协议必须为 responses 或 chat_completions。');
}
function readToml(file) {
	try { return parse(fs.readFileSync(file, 'utf8'), {unsafeKeyBehaviour:'throw'}); }
	catch { throw configError('无法读取或解析 Codex 配置：'+file); }
}
function readSelection(file, profile, useDefaultProfile = true) {
	const base = readToml(file);
	if (useDefaultProfile) profile = profile || base.profile;
	let selected = {};
	if (profile) {
		if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(profile)) throw configError('Codex profile 名称无效。');
		selected = base.profiles?.[profile];
		if (!selected) {
			const profileFile = path.join(path.dirname(file), profile+'.config.toml');
			if (!fs.existsSync(profileFile)) throw configError('Codex profile 不存在：'+profile);
			selected = readToml(profileFile);
		}
	}
	return {base, selected, profile:profile || null};
}
function endpoint(base) {
	const url = new URL(base);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw configError('模型网关地址无效。');
	let pathname = url.pathname.replace(/\/+$/, '');
	if (!/\/v1$/i.test(pathname)) pathname += /\.openai\.azure\.com$/i.test(url.hostname) ? '/openai/v1' : '/v1';
	return url.origin+pathname;
}
function gatewayCredential(binding, targetBase, {env = process.env} = {}) {
	// A rotated key is read from the original provider, never from the newly selected default.
	if (!binding?.base_url || !binding.config_source?.file) return {key:'', origin:'missing', reason:'missing_codex_binding'};
	try {
		if (endpoint(binding.base_url) !== endpoint(targetBase)) return {key:'', origin:'blocked', reason:'gateway_mismatch'};
	} catch { return {key:'', origin:'blocked', reason:'invalid_gateway'}; }
	if (binding.credential_env && env[binding.credential_env]) return {key:env[binding.credential_env], origin:'codex_environment'};
	try {
		const source = binding.config_source;
		const {base, selected} = readSelection(source.file, source.profile, false);
		const provider = {...(base.model_providers?.[source.provider] || {}), ...(selected.model_providers?.[source.provider] || {})};
		const currentBase = provider.base_url || (source.provider === 'openai' ? 'https://api.openai.com/v1' : '');
		if (!currentBase || endpoint(currentBase) !== endpoint(binding.base_url)) return {key:'', origin:'blocked', reason:'provider_gateway_changed'};
		if (provider.requires_openai_auth === true) return {key:'', origin:'blocked', reason:'login_auth_not_reused'};
		if (provider.env_key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.env_key) && env[provider.env_key]) return {key:env[provider.env_key], origin:'codex_environment'};
		const token = provider.experimental_bearer_token;
		if (typeof token === 'string' && token.trim() && !/[\r\n]/.test(token)) return {key:token.trim(), origin:'codex_gateway_bearer'};
		return {key:'', origin:'missing', reason:'missing_gateway_credential'};
	} catch { return {key:'', origin:'missing', reason:'codex_credential_unavailable'}; }
}
function controllerDefaults({file, profile, env = process.env} = {}) {
	if (env.S2P_CONTROLLER_SNAPSHOT) {
		let saved;
		try { saved = JSON.parse(env.S2P_CONTROLLER_SNAPSHOT); } catch { throw configError('控制器任务快照无效。'); }
		if (profile && profile !== saved.config_source?.profile) throw configError('续跑必须保留原 Codex profile。');
		if (file && path.resolve(file) !== saved.config_source?.file) throw configError('续跑必须保留原 Codex 配置来源。');
		if (saved.source !== 'codex' || !saved.model || !saved.base_url) throw configError('控制器任务快照缺少公开配置。');
		return Object.fromEntries(PUBLIC_FIELDS.filter(key => saved[key] !== undefined).map(key => [key, saved[key]]));
	}
	file = path.resolve(file || env.S2P_CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'));
	const {base, selected, profile:chosenProfile} = readSelection(file, profile || env.S2P_CODEX_PROFILE);
	profile = chosenProfile;
	const config = {...base, ...selected};
	const providerId = config.model_provider || 'openai';
	const provider = {...(base.model_providers?.[providerId] || {}), ...(selected.model_providers?.[providerId] || {})};
	const baseUrl = provider.base_url || (providerId === 'openai' ? 'https://api.openai.com/v1' : '');
	if (typeof config.model !== 'string' || !config.model.trim() || !baseUrl) throw configError('Codex 配置需要明确的 model 和服务商 base_url。');
	let url;
	try { url = new URL(baseUrl); } catch { throw configError('Codex 服务商地址无效。'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw configError('Codex 服务商地址必须为不含凭据和查询参数的 HTTP(S) 地址。');
	const credentialEnv = provider.env_key || (providerId === 'openai' ? 'OPENAI_API_KEY' : null);
	if (credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) throw configError('Codex env_key 必须是环境变量名。');
	const configSource = {file, profile:profile || null, provider:providerId, scope:'configured_default'};
	return {
		model:config.model, base_url:baseUrl, wire_api:protocol(provider.wire_api),
		...(config.model_reasoning_effort ? {reasoning_effort:config.model_reasoning_effort} : {}),
		source:'codex', credential_env:credentialEnv, credential_source:'codex',
		config_source:configSource,
		credential_binding:{base_url:baseUrl, config_source:configSource, credential_env:credentialEnv},
	};
}
module.exports = {controllerDefaults, gatewayCredential, protocol};
