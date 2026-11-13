#!/usr/bin/env node
// Project-owned adapter. The matching engine is always resolved beside this file.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const TOOL = __dirname;
const ENGINE = path.join(TOOL, 'engine');
const PROJECT = path.resolve(TOOL, '../../..');
const PATH_OPTIONS = new Set(['--source', '--output', '--config', '--env-file', '--reuse-text']);
const BRIDGE_OPTIONS = {'--codex-config':'S2P_CODEX_CONFIG', '--codex-profile':'S2P_CODEX_PROFILE', '--controller-model':'S2P_CONTROLLER_MODEL', '--controller-url':'S2P_CONTROLLER_BASE_URL', '--controller-protocol':'S2P_CONTROLLER_WIRE_API'};

function help() {
	console.log(`项目内 s2p（需要 Node.js 20.9+）
  node tools/art/s2p/cli.cjs init
  npm ci --prefix tools/art/s2p/engine
  node tools/art/s2p/cli.cjs check
  node tools/art/s2p/cli.cjs doctor [--online] [--image-probe]
  node tools/art/s2p/cli.cjs models [--role controller|background]
  node tools/art/s2p/cli.cjs preflight
  node tools/art/s2p/cli.cjs run --source PNG [--output EMPTY_DIR] [--resume] [--serve]
  node tools/art/s2p/cli.cjs report --output RUN_DIR [--serve]
  node tools/art/s2p/cli.cjs compare --output RUN_DIR

init 创建独立配置和空密钥文件，已有文件保持原样。
run 默认写入 art/workbench/；续跑必须明确指定原 --output。
preflight 不调用模型；check 使用本地夹具，不依赖真实密钥或模型服务。
run 会将输入图发送到配置的模型接口。其余引擎选项见 README.md。
控制器默认可读取 Codex 配置；图像模型由项目独立指定。
覆盖：--codex-config TOML --codex-profile NAME --controller-model MODEL
      --controller-url URL --controller-protocol responses|chat_completions
doctor 默认不联网，--online 探测控制器，--image-probe 会实际请求一次图像编辑。
models 联网查询可用名称，不据名称推断能力。
路径相对于调用命令时的工作目录；配置默认使用本工具的 config.local.json。`);
}

function init(directory = TOOL) {
	const created = [], kept = [];
	for (const [source, target] of [['config.example.json', 'config.local.json'], ['.env.example', '.env.local']]) {
		try {
			fs.copyFileSync(path.join(directory, source), path.join(directory, target), fs.constants.COPYFILE_EXCL);
			fs.chmodSync(path.join(directory, target), 0o600);
			created.push(target);
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			kept.push(target);
		}
	}
	return {created, kept};
}

function invocation(command, argv, {directory = TOOL, project = PROJECT, cwd = process.cwd()} = {}) {
	if (!['preflight', 'run', 'report', 'compare', 'doctor', 'models'].includes(command)) throw Error('未知命令：'+command);
	const args = [], found = new Set(), env = {...process.env};
	delete env.S2P_CONTROLLER_SNAPSHOT;
	for (let i = 0; i < argv.length; i++) {
		const [option, ...inline] = argv[i].split('=');
		if (option === '--project') throw Error('s2p 固定使用项目内引擎，不接受 --project。');
		if (Object.hasOwn(BRIDGE_OPTIONS, option)) {
			if (found.has(option)) throw Error('重复配置参数：'+option);
			const value = inline.length ? inline.join('=') : argv[++i];
			if (!value || value.startsWith('--')) throw Error(option+' 需要值。');
			env[BRIDGE_OPTIONS[option]] = option === '--codex-config' ? path.resolve(cwd, value) : value;
			found.add(option);
			continue;
		}
		if (!PATH_OPTIONS.has(option)) { args.push(argv[i]); continue; }
		if (found.has(option)) throw Error('重复路径参数：'+option);
		const value = inline.length ? inline.join('=') : argv[++i];
		if (!value || value.startsWith('--')) throw Error(option+' 需要路径。');
		args.push(option, path.resolve(cwd, value));
		found.add(option);
	}
	const engine = path.join(directory, 'engine');
	if (command === 'run') {
		if (!found.has('--source')) throw Error('run 需要 --source。');
		if (args.includes('--resume') && !found.has('--output')) throw Error('续跑需要 --output 指向原任务目录。');
		if (!found.has('--output')) {
			const name = 's2p_'+new Date().toISOString().replace(/[:.]/g, '-')+'_'+randomUUID().slice(0, 8);
			args.push('--output', path.join(project, 'art/workbench', name));
		}
	}
	if (['preflight', 'run', 'doctor', 'models'].includes(command) && !found.has('--config')) {
		const config = path.join(directory, 'config.local.json');
		if (!fs.existsSync(config)) throw Error('缺少项目配置，请先运行 node tools/art/s2p/cli.cjs init 并填写 .env.local。');
		args.push('--config', config);
	}
	if (['report', 'compare'].includes(command) && !found.has('--output')) throw Error(command+' 需要 --output。');
	if (['doctor','models'].includes(command)) return {script:path.join(engine, 'node/model_doctor.js'),args:[command,...args],cwd:engine,env};
	return command === 'compare'
		? {script:path.join(engine, 'node/psd_compare.js'), args:['--project', engine, ...args], cwd:engine,env}
		: {script:path.join(engine, 'node/psd.js'), args:[command, ...args], cwd:engine,env};
}

function main(argv = process.argv.slice(2)) {
	const [major, minor] = process.versions.node.split('.').map(Number);
	if (major < 20 || (major === 20 && minor < 9)) throw Error('s2p 需要 Node.js 20.9 或更新版本。');
	const [command, ...args] = argv;
	if (!command || command === '--help' || command === '-h') { help(); return; }
	if (command === 'init') {
		if (args.length) throw Error('init 不接受额外参数。');
		console.log(JSON.stringify(init()));
		return;
	}
	if (command === 'check') {
		if (args.length) throw Error('check 不接受额外参数。');
		const result = spawnSync(process.execPath, [path.join(TOOL, 'tests/check.cjs')], {cwd:ENGINE, stdio:'inherit'});
		if (result.error) throw result.error;
		process.exitCode = result.status ?? 1;
		return;
	}
	const run = invocation(command, args);
	const result = spawnSync(process.execPath, [run.script, ...run.args], {cwd:run.cwd, env:run.env, stdio:'inherit'});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}

module.exports = {init, invocation, main};
if (require.main === module) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
