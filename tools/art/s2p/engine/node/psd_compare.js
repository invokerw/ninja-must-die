// Create an evidence page from a completed run. Never modify its layers or PSD.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const assert = require('node:assert/strict');

const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reasonText = reason => ({
  insufficient_separation_evidence:'模型轮廓不足以可靠分离对象',
  insufficient_visible_background:'可用于估计背景的像素不足',
  no_reliable_foreground_seed:'缺少可信的前景像素',
  no_reliable_background_seed:'缺少可信的背景像素',
  empty_refined_foreground:'未得到可靠的前景轮廓',
  large_silhouette_disagreement:'模型轮廓与原图差异过大',
  complex_background_uncertain_matte:'背景较复杂，透明边缘估计不可靠',
  model_material_alpha_inconsistent_with_source:'模型给出的半透明度与原图不一致',
  missing_visible_reference_detail:'未完整覆盖原图中的可见细节',
  edge_reconstruction_error:'透明边缘放回后的误差过大',
  no_visible_opaque_pixels:'没有可核对的可见不透明像素',
}[reason] || reason);

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const i=args.indexOf(name); return i<0 ? null : args[i+1]; };
  if (!value('--project') || !value('--output')) throw new Error('Usage: node compare.cjs --project ABSOLUTE_PROJECT --output ABSOLUTE_COMPLETED_RUN');
  const project = path.resolve(value('--project')), output = path.resolve(value('--output'));
  const sharp = createRequire(path.join(project, 'package.json'))('sharp');
  const state = await read(path.join(output, 'status.json'));
  assert.equal(state.status, 'completed', 'Comparison requires a completed run');
  const layers = await read(path.join(output, 'layers.json'));
  const verification = await read(path.join(output, 'verification.json'));
  const fidelity = await read(path.join(output, 'fidelity_verification.json'));
  const manifest = await read(path.join(output, 'run_manifest.json'));
  const original = path.join(output, 'input.png');
  assert.equal(hash(await fs.readFile(original)), manifest.source_sha256, 'Run input does not match recorded source');
  const identity = [];
  for (const entry of [...manifest.sources, ...(manifest.supplemental_sources || [])]) {
    const snapshot = path.join(output, 'code_snapshot', entry.relative);
    assert.equal(hash(await fs.readFile(snapshot)), entry.sha256, 'Snapshot identity mismatch: '+entry.relative);
    const current=await fs.readFile(path.join(project, entry.relative)).then(hash).catch(()=>null);
    identity.push({relative:entry.relative, sha256:entry.sha256, current_matches:current===entry.sha256, recorded_at:entry.recorded_at || manifest.started_at, recorded_at_launch:!entry.recorded_at});
  }
  const postprocessingIdentity=[];
  for (const entry of manifest.postprocessing?.sources || []) {
    assert.equal(hash(await fs.readFile(entry.snapshot)),entry.sha256,'Postprocessing snapshot mismatch: '+entry.relative);
    postprocessingIdentity.push({relative:entry.relative,sha256:entry.sha256});
  }
  const directory = path.join(output, 'quality_review');
  await fs.mkdir(directory, {recursive:true});
  const [width, height] = state.canvas;
  const modelComposite = path.join(directory, 'model_composite.png');
  await sharp({create:{width,height,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite(layers.map(layer => ({input:layer.model_rgba_source || layer.source,left:layer.bbox[0],top:layer.bbox[1]})))
    .png().toFile(modelComposite);
  const sources = [original, modelComposite, state.recomposed];
  const originalPixels = await sharp(original).ensureAlpha().raw().toBuffer();
  const finalPixels = await sharp(state.recomposed).ensureAlpha().raw().toBuffer();
  let checkedCompositePixels=0, mismatchedCompositePixels=0, maxCompositeDifference=0;
  const href = file => path.relative(output, file).split(path.sep).map(encodeURIComponent).join('/');
  const link = (file, text) => file ? `<a href="${esc(href(file))}">${esc(text)}</a>` : '';
  const directMode=state.model_output_policy==='model_rgba_downscale_only'||manifest.model_output_policy==='model_rgba_downscale_only';
  const targets = layers.filter(layer => layer.fidelity || layer.model_placement);
  const rows = [], records = [];
  for (let i=0; i<targets.length; i++) {
    const layer=targets[i], f=layer.fidelity||{status:'direct_model_rgba',applied:false,reasons:layer.model_placement?.resolution_shortfall?['model_resolution_shortfall']:[]}, [x,y,w,h]=layer.bbox;
    const compositeCheck={pixels:0,mismatched_pixels:0,max_rgb_difference:0};
    if (f.applied) {
      const mask=await sharp(f.opaque_source_mask).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
      assert.equal(mask.info.width,w); assert.equal(mask.info.height,h);
      for (let my=0;my<h;my++) for (let mx=0;mx<w;mx++) if (mask.data[my*w+mx]) {
        const offset=((my+y)*width+mx+x)*4;
        const difference=Math.max(...[0,1,2].map(c=>Math.abs(finalPixels[offset+c]-originalPixels[offset+c])));
        compositeCheck.pixels++;
        if (difference) compositeCheck.mismatched_pixels++;
        compositeCheck.max_rgb_difference=Math.max(compositeCheck.max_rgb_difference,difference);
      }
      checkedCompositePixels+=compositeCheck.pixels;
      mismatchedCompositePixels+=compositeCheck.mismatched_pixels;
      maxCompositeDifference=Math.max(maxCompositeDifference,compositeCheck.max_rgb_difference);
    }
    const box={left:Math.max(0,x-12),top:Math.max(0,y-12),width:Math.min(width,x+w+12)-Math.max(0,x-12),height:Math.min(height,y+h+12)-Math.max(0,y-12)};
    const slug=String(i+1).padStart(3,'0')+'_'+layer.id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const parts=[], cropFiles=[];
    for (let column=0;column<sources.length;column++) {
      const native=path.join(directory,`${slug}_${column}.png`);
      await sharp(sources[column]).extract(box).png().toFile(native);
      cropFiles.push(native);
      parts.push({input:await sharp(native).resize(220,190,{fit:'contain',withoutEnlargement:true,background:'#202d3e',kernel:'nearest'}).png().toBuffer(),left:column*232,top:28});
    }
    const labels=directMode?['Original','Model RGBA, shrink only','Exported result']:['Original','Model cutouts, placed','Source pixel recovery'];
    const header=Buffer.from(`<svg width="684" height="28">${labels.map((label,j)=>`<text x="${j*232+4}" y="19" fill="#edf3fa" font-size="13" font-family="Arial">${label}</text>`).join('')}</svg>`);
    const montage=path.join(directory,slug+'.png');
    await sharp({create:{width:684,height:218,channels:4,background:'#202d3e'}}).composite([...parts,{input:header,left:0,top:0}]).png().toFile(montage);
    const record={id:layer.id,name:layer.name,category:layer.category,bbox:layer.bbox,applied:f.applied,status:f.status,reasons:f.reasons,model_placement:layer.model_placement||null,
      visible_opaque_pixels:f.visible_opaque_pixels||0,final_composite_check:compositeCheck,report:f.report,retry:layer.fidelity_retry||null,montage,crops:cropFiles,model_rgba:layer.model_rgba_source,final_rgba:layer.source};
    records.push(record);
    const retry=record.retry;
    rows.push(`<article id="object-${i+1}"><h2>${esc(layer.name||layer.id)} <small>${esc(layer.category)} · ${directMode?'模型 RGBA（原尺寸或缩小）':f.applied?'已应用原像素恢复':'待检查，保留模型图'}</small></h2>
      <p>bbox ${esc(JSON.stringify(layer.bbox))} · 可见不透明像素 ${record.visible_opaque_pixels} · ${retry?`补救 ${retry.attempts} 次，选择 ${esc(retry.selected)}`:'没有质量补救'}${f.applied?` · 最终整图中 ${compositeCheck.mismatched_pixels} 个声明像素与原图不同`:''}</p>
      <p>${(f.reasons||[]).map(reason=>esc(reason==='model_resolution_shortfall'?'模型返回尺寸不足，保留原尺寸放置':reasonText(reason))).join('；')||(directMode?'模型 RGB/alpha 直接放回，缩放倍数不超过 1；未进行原像素恢复。':'该对象局部恢复检查通过。')}</p>
      <a href="${esc(href(montage))}"><img loading="lazy" src="${esc(href(montage))}" alt="原图、模型、原像素恢复三列对照"></a>
      <p>${link(cropFiles[0],'原生原图局部')} · ${link(cropFiles[1],'模型合成局部')} · ${link(cropFiles[2],'最终合成局部')} · ${link(layer.model_rgba_source,'选用模型 RGBA')} · ${link(layer.source,'最终 RGBA')} · ${link(f.report,'恢复诊断')}${retry?` · ${link(retry.first_source,'首次候选')} · ${link(retry.retry_source,'重试候选')}`:''}</p></article>`);
  }
  const elapsed=(Date.parse(state.ended_at)-Date.parse(state.started_at))/1000;
  const summary={status:state.status,elapsed_seconds:elapsed,visual_rounds:state.loops.length-1,layer_count:state.layer_count,
    structural_verification:verification.status,fidelity,code_identity:identity,objects:records,
    derived_from:manifest.derived_from||null,postprocessing_identity:postprocessingIdentity,surface_geometry_recovery:state.surface_geometry_recovery||null,
    final_composite_source_check:{status:!checkedCompositePixels?'not_checked':mismatchedCompositePixels?'needs_review':'passed',pixels:checkedCompositePixels,mismatched_pixels:mismatchedCompositePixels,max_rgb_difference:maxCompositeDifference},
    comparison_scope:'The middle column composites the selected model cutouts at the same positions and layer order, before source-pixel recovery. Text, surfaces and background are shared with the final result. This is a report only; no layer changes.'};
  await fs.writeFile(path.join(directory,'review.json'),JSON.stringify(summary,null,2)+'\n');
  const policyNotice=directMode?'<p class="notice">直接使用模型 RGB 与 alpha，只允许缩小；缩略图也不放大。未启用原像素恢复，不声称与原图像素一致。</p>':'';
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原像素恢复与模型抠图对照</title>
    <style>body{font:16px/1.6 system-ui,sans-serif;background:#101823;color:#e9eff9;max-width:1120px;margin:auto;padding:24px}a{color:#85c4ff}article{background:#1b2736;padding:18px;margin:22px 0;border-radius:10px}img{max-width:100%;height:auto}small{font-weight:400;color:#b7c7db}h2{font-size:20px}.notice{padding:14px;background:#26334b}li{margin:8px 0}</style>
    <h1>${directMode?'原图 / 模型 RGBA 直接放回 / 导出结果':'原图 / 本轮模型抠图 / 原像素恢复'}</h1>
    ${policyNotice}
    ${manifest.derived_from&&!directMode?`<p class="notice">这是完整生图测试的派生结果。使用父作业的模型图集离线修正 ${state.surface_geometry_recovery?.corrections.length||0} 个底板尺寸，没有新增生图。原始作业与循环透明洞记录均保留。${link(path.join(manifest.derived_from.output,'index.html'),'查看父作业')}</p>`:''}
    <p>${Math.floor(elapsed/60)} 分 ${Math.round(elapsed%60)} 秒 · ${state.loops.length-1} 个图像轮 · ${state.layer_count} 层 · 结构验收 ${esc(verification.status)}</p>
    <p>已恢复 ${fidelity.applied_layers} 个前景，${fidelity.checked_opaque_pixels} 个声明为可见不透明的像素逐字节核对。${fidelity.pending.length} 个对象待检查；补救过 ${fidelity.retry_attempted} 个对象，每对象最多一次。</p>
    <p>另在最终整图核对 ${checkedCompositePixels} 个声明像素：${mismatchedCompositePixels} 个不同，最大 RGB 差 ${maxCompositeDifference}。这项检查用于发现图层虽然正确、放回后却被错误覆盖的情况。</p>
    <p class="notice">中列把本轮所选模型 RGBA 按同一位置与层序合成，右列是原像素恢复后的实际最终图。缩略图采用等比缩放；原生局部链接不缩放。文字、底板、遮挡处补全与真实半透明 alpha 不在精确还原声明内。此页面不修改任何图层或 PSD。</p>
    ${state.visual_review?.findings?`<h2>整图检查</h2><ul>${state.visual_review.findings.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}
    <p><a href="index.html">逐轮过程</a> · ${link(state.psd,'下载 PSD')} · ${link(path.join(output,'comparison.png'),'前后整图对照')} · ${link(modelComposite,'模型图层整图合成')} · <a href="quality_review/review.json">独立对照记录</a></p>
    <h2>未通过局部恢复检查</h2><ul>${fidelity.pending.length?fidelity.pending.map(item=>`<li>${esc(item.name||item.id)}：${(item.reasons||[]).map(reason=>esc(reasonText(reason))).join('；')}</li>`).join(''):'<li>无。仍需人工检查元素完整性、层序及未覆盖类别。</li>'}</ul>
    ${rows.join('')}</html>`;
  await fs.writeFile(path.join(output,'quality.html'),html);
  console.log(JSON.stringify({report:path.join(output,'quality.html'),objects:records.length,checked_opaque_pixels:fidelity.checked_opaque_pixels,pending:fidelity.pending.length}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
