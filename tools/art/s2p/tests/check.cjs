// All clients use fixture credentials; upstream checks use mocks or loopback servers.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const tool = path.resolve(__dirname, '..');
const engine = path.join(tool, 'engine');
const suites = ['model_config', 'psd', 'bbox_recursive', 'bbox_surface_geometry', 'bbox_extraction',
	'bbox_model_rgba', 'bbox_text_atlas', 'bbox_visual_atlas', 'bbox_pipeline',
	'bbox_detection_cache', 'bbox_combined_detection'];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ninja-s2p-check-'));
try {
	const manifest = JSON.parse(fs.readFileSync(path.join(tool, 'vendor-manifest.json'), 'utf8'));
	for (const file of manifest.files) {
		const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(engine, file.path))).digest('hex');
		if (hash !== file.sha256) throw Error('内置引擎与来源快照不符：'+file.path);
	}
	for (const dependency of ['sharp', 'ag-psd', 'openai', 'jsonrepair', 'smol-toml']) {
		const resolved = fs.realpathSync(require.resolve(dependency, {paths:[engine]}));
		if (!resolved.startsWith(engine+path.sep+'node_modules'+path.sep)) throw Error('依赖未安装在项目内：'+dependency);
	}
	const fixture = JSON.parse(fs.readFileSync(path.join(engine, 'config.example.json'), 'utf8'));
	for (const route of Object.values(fixture.llm.routes)) {
		route.api_key = 'offline-fixture';
		route.base_url = 'http://127.0.0.1:1/v1';
		route.env = Object.fromEntries(['api_key', 'base_url', 'model', 'quality', 'provider', 'timeout_ms', 'max_retries'].map(key => [key, []]));
	}
	const config = path.join(temporary, 'config.json');
	fs.writeFileSync(config, JSON.stringify(fixture));
	const env = {...process.env, LAYERFORGE_CONFIG:config};
	for (const key of Object.keys(env)) if (key.startsWith('S2P_') || key.startsWith('BBOX_') || (key.startsWith('LAYERFORGE_') && key !== 'LAYERFORGE_CONFIG')) delete env[key];
	delete env.NODE_OPTIONS;
	const commands = [['--test', path.join(__dirname, 'cli.test.cjs'), path.join(__dirname, 'model_bridge.test.cjs'), path.join(__dirname, 'credential_reuse.test.cjs')],
		...suites.map(suite => ['node/'+suite+'_checks.js']), ['node/job_retry_test.js']];
	for (const args of commands) {
		console.log('检查 '+args.at(-1));
		const result = spawnSync(process.execPath, args, {cwd:engine, env, stdio:'inherit'});
		if (result.error) throw result.error;
		if (result.status !== 0) throw Error('检查失败：'+args.at(-1)+'，退出码 '+result.status);
	}
	console.log('S2P_CHECK_PASS：来源哈希、项目入口及 12 套引擎离线检查通过；未调用真实模型。');
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	fs.rmSync(temporary, {recursive:true, force:true});
}
