const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {init, invocation} = require('../cli.cjs');

test('初始化不覆盖配置，项目移动后仍使用相邻引擎，相对路径保持调用者语义', t => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ninja s2p moved ')));
	t.after(() => fs.rmSync(root, {recursive:true, force:true}));
	const directory = path.join(root, 'tools/art/s2p');
	fs.mkdirSync(path.join(directory, 'engine/node'), {recursive:true});
	for (const name of ['cli.cjs', 'config.example.json', '.env.example']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(directory, name));
	const config = path.join(directory, 'config.local.json');
	const result = init(directory);
	assert.deepEqual(result.created, ['config.local.json', '.env.local']);
	fs.writeFileSync(config, 'private-fixture');
	assert.deepEqual(init(directory).kept, ['config.local.json', '.env.local']);
	assert.equal(fs.readFileSync(config, 'utf8'), 'private-fixture');
	const options = {directory, project:root, cwd:root};
	const run = invocation('run', ['--source=art/concepts/input image.png'], options);
	assert.equal(run.script, path.join(directory, 'engine/node/psd.js'));
	assert.equal(run.args[run.args.indexOf('--source')+1], path.join(root, 'art/concepts/input image.png'));
	assert.equal(run.args[run.args.indexOf('--config')+1], config);
	assert(run.args[run.args.indexOf('--output')+1].startsWith(path.join(root, 'art/workbench')+path.sep));
	assert.throws(() => invocation('run', ['--source', 'input.png', '--resume'], options), /续跑需要/);
	assert.throws(() => invocation('run', ['--source'], options), /需要路径/);
	assert.throws(() => invocation('run', ['--source', 'x', '--source=y'], options), /重复/);
	assert.throws(() => invocation('preflight', ['--project', '/external'], options), /项目内引擎/);
	assert.throws(() => invocation('compare', [], options), /需要 --output/);
	assert.throws(() => invocation('unknown', [], options), /未知命令/);
	// A relocated copy launches its own engine even when the caller has an external config.
	fs.writeFileSync(path.join(directory, 'engine/node/psd.js'), 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
	const child = spawnSync(process.execPath, [path.join(directory, 'cli.cjs'), 'preflight'], {
		cwd:root, env:{...process.env, LAYERFORGE_CONFIG:'/missing/external/config.json'}, encoding:'utf8'});
	assert.equal(child.status, 0, child.stderr);
	const observed = JSON.parse(child.stdout);
	assert.deepEqual(observed.args, ['preflight', '--config', config]);
	assert.equal(observed.cwd, path.join(directory, 'engine'));
	fs.unlinkSync(config);
	assert.throws(() => invocation('preflight', [], options), /缺少项目配置/);
	assert.equal(invocation('report', ['--output', 'saved run'], options).args.at(-1), path.join(root, 'saved run'));
});

test('Windows 与 Android 预设均排除工具目录，Godot 不导入工具依赖', () => {
	const root = path.resolve(__dirname, '../../../..');
	const presets = fs.readFileSync(path.join(root, 'export_presets.cfg'), 'utf8');
	const filters = [...presets.matchAll(/^exclude_filter="(.*)"$/gm)];
	assert.equal(filters.length, 2);
	assert(filters.every(match => match[1].split(',').includes('tools/*')));
	assert(fs.existsSync(path.join(__dirname, '../.gdignore')));
});

test('续跑代码身份覆盖实际引擎依赖闭包', () => {
	const engine = path.resolve(__dirname, '../engine');
	const {PIPELINE_FILES} = require(path.join(engine, 'node/psd.js'));
	const pending = [...PIPELINE_FILES], seen = new Set();
	while (pending.length) {
		const name = pending.pop();
		if (seen.has(name)) continue;
		seen.add(name);
		if (!name.endsWith('.js')) continue;
		const file = path.join(engine, name);
		for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
			if (!match[1].startsWith('.')) continue;
			let target = path.resolve(path.dirname(file), match[1]);
			if (!path.extname(target)) target += '.js';
			if (!fs.existsSync(target)) continue;
			const relative = path.relative(engine, target).split(path.sep).join('/');
			assert(PIPELINE_FILES.includes(relative), '运行依赖未纳入代码身份：'+relative);
			pending.push(relative);
		}
	}
});


test('显式控制器覆盖与 Codex profile 参数传给子进程，不写入配置', () => {
	const run = invocation('doctor', ['--config', 'settings.json', '--codex-config', 'codex defaults.toml', '--codex-profile=fast', '--controller-model=chosen-model', '--controller-protocol', 'responses']);
	assert.equal(run.env.S2P_CONTROLLER_MODEL,'chosen-model');
	assert.equal(run.env.S2P_CONTROLLER_WIRE_API,'responses');
	assert.equal(run.env.S2P_CODEX_PROFILE,'fast');
	assert.equal(run.env.S2P_CODEX_CONFIG,path.resolve('codex defaults.toml'));
	assert(!run.args.includes('--controller-model'));
	assert.equal(run.args[0],'doctor');
});
