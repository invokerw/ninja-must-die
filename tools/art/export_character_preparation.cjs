// Export the approved preparation candidates from retained local model outputs.
// No model calls or RGB/alpha repair. Run with Node 20+ and sharp installed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const root = path.resolve(__dirname, '../..');
const run = path.join(root, 'art/workbench/ui/character_setup/v02/extraction_aligned');
const layered = path.join(root, 'art/layered/ui/character_setup/v02');
const generated = path.join(root, 'art/generated/ui/character_setup/v02');
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const relative = p => path.relative(root, p).split(path.sep).join('/');
const entries = {
	shadow_runner_portrait: 'loop_02_roi_1_upper_portrait',
	wind_scout_portrait: 'loop_02_roi_1_lower_portrait',
	thunder_guard_portrait: 'loop_02_roi_4_locked_portrait',
	wind_scout: 'loop_04_overview_featured_scout',
};
(async () => {
	const result = JSON.parse(fs.readFileSync(path.join(run, 'run_result.json')));
	const verified = JSON.parse(fs.readFileSync(path.join(run, 'verification.json')));
	if (result.status !== 'completed' || verified.status !== 'passed') throw new Error('Extraction must finish and pass structural checks first');
	const layers = JSON.parse(fs.readFileSync(path.join(run, 'layers.json')));
	for (const directory of [layered, generated, path.join(layered, 'source'), path.join(layered, 'textures'), path.join(layered, 'inspection')]) fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(layered, '.gdignore'), '');
	for (const filename of ['layers.psd', 'verification.json', 'fidelity_verification.json', 'run_result.json', 'run_manifest.json', 'layers.json']) {
		fs.copyFileSync(path.join(run, filename), path.join(layered, 'source', filename));
	}
	const assets = [];
	for (const [name, id] of Object.entries(entries)) {
		const layer = layers.find(value => value.id === id);
		if (!layer) throw new Error('Missing layer: ' + id);
		const texture = path.join(layered, 'textures', name + '.png');
		const runtime = path.join(generated, name + '.png');
		fs.copyFileSync(layer.source, texture);
		fs.copyFileSync(texture, runtime);
		const original = path.join(layered, 'inspection', name + '_original.png');
		const raw = path.join(layered, 'inspection', name + '_raw.png');
		fs.copyFileSync(layer.source_crop, original);
		const [left, top, width, height] = layer.atlas_cell.model_rect;
		await sharp(layer.model_generated_source).extract({ left, top, width, height }).png().toFile(raw);
		fs.copyFileSync(layer.model_generated_source, path.join(layered, 'source', name + '_atlas.png'));
		const metadata = await sharp(texture).metadata();
		const stats = await sharp(texture).stats();
		assets.push({
			id: name, layer_id: id, source: relative(texture), runtime: relative(runtime), sha256: digest(texture),
			width: metadata.width, height: metadata.height, has_alpha: metadata.hasAlpha,
			alpha_range: metadata.hasAlpha ? [stats.channels[3].min, stats.channels[3].max] : null,
			bbox: layer.bbox, model_rect: layer.atlas_cell.model_rect,
			original_crop: relative(original), raw_model_crop: relative(raw),
			model_atlas: relative(path.join(layered, 'source', name + '_atlas.png')),
			pixel_transform: 'Byte-identical copy of directly placed model RGBA; no enlargement, sharpening or alpha edits',
			user_runtime_visual_acceptance: 'approved',
		});
	}
	const source = path.join(layered, 'source/shadow_runner_native.png');
	const shadowRuntime = path.join(generated, 'shadow_runner.png');
	await sharp(source).resize({ width: 724, withoutEnlargement: true }).png().toFile(shadowRuntime);
	const shadowMetadata = await sharp(shadowRuntime).metadata();
	assets.push({ id: 'shadow_runner', source: relative(source), source_sha256: digest(source), runtime: relative(shadowRuntime), sha256: digest(shadowRuntime), width: shadowMetadata.width, height: shadowMetadata.height, has_alpha: shadowMetadata.hasAlpha, pixel_transform: 'Native imagegen RGBA downsampled to width 724 with sharp, no alpha repair or enlargement', user_runtime_visual_acceptance: 'approved' });
	const manifest = { date: '2026-11-12', concept: 'art/concepts/ui/character_setup/v02.png', concept_approval: '可以实现', state: 'runtime_ready', runtime_ready: true, source_run: relative(run), structural_verification: 'passed', psd: relative(path.join(layered, 'source/layers.psd')), psd_sha256: digest(path.join(layered, 'source/layers.psd')), assets, notes: ['Only portraits and featured scout artwork enter the runtime; controls, text and states remain native Godot.', 'The model redraws details; structural validation does not establish original pixel fidelity.', 'Shadow Runner native image has faint alpha fringe at source scale. Actual menu-size inspection is recorded separately.', 'Thunder Guard remains a locked grayscale portrait because level 1-3 has not shipped.'] };
	fs.writeFileSync(path.join(layered, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
	console.log('Exported ' + assets.length + ' preparation textures and retained PSD/raw-model inspection evidence.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
