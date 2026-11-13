#!/usr/bin/env node
const {modelFor,qualityFor,getRoute}=require('./model_config.js');
// Local recursive experiment. Production web routing remains independently configured.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {readPsd, initializeCanvas} = require('ag-psd');
const {exportPsd} = require('./layerforge.js');
const {imageRequest} = require('./bbox_image_requests.js');
const {imageKey, deleteBboxes, alphaStats} = require('./bbox_atlas_pixels.js');
const {checker, fullComposite, comparison} = require('./bbox_two_loop_test.js');
const {createCore, overlap, BATCH, TEXT_BATCH} = require('./bbox_recursive_core.js');
const {refreshLoopPreviews} = require('./bbox_recursive_previews.js');
const {runVisualWindow} = require('./bbox_visual_window.js');

const MODEL = modelFor('background');
const ROOT = path.resolve(__dirname, '../../..');
const SOURCE = path.resolve(process.env.BBOX_TEST_SOURCE || path.join(ROOT, '20260827-204428.png'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'web_runs/bbox-recursive-20261013'));
const TEXT_ARCHIVE = path.resolve(process.env.BBOX_TEXT_ARCHIVE || path.join(ROOT, 'web_runs/bbox-two-loop-final-20261012'));
const PIPELINE = process.env.BBOX_PIPELINE !== '0';
const VISUAL_WINDOW = PIPELINE ? Number(process.env.BBOX_VISUAL_WINDOW || 1) : 1;
assert(Number.isSafeInteger(VISUAL_WINDOW) && VISUAL_WINDOW >= 1 && VISUAL_WINDOW <= 3, 'Visual planning window must be 1..3');
const DETECTION_MODE=process.env.BBOX_INCREMENTAL_DETECTION==='0'?'full':'regional_cache_v1';
const DETECTION_PASS=process.env.BBOX_COMBINED_DETECTION==='1'?'combined_original_geometry_and_hint_presence_v1':'separate';
const read = file => fsp.readFile(file, 'utf8').then(JSON.parse);
const write = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const FLOW='text_completed_then_recursive_true_alpha_holes_v2';
const state = {flow:FLOW,source: SOURCE, model: MODEL, controller: modelFor('controller'), quality: qualityFor('background'), batch_size: BATCH, text_batch_size: TEXT_BATCH, surface_style:process.env.BBOX_SURFACE_STYLE==='borderless'?'borderless':'original', model_output_policy:'model_rgba_downscale_only', steps: [], loops: []};
state.detection_mode=DETECTION_MODE;
state.detection_pass=DETECTION_PASS;
let saves = Promise.resolve();
let pendingDetection = null;
let pendingTextVisual = null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rel = file => path.relative(OUT, file).split(path.sep).join('/');
const img = (file, label, original = file) => file && fs.existsSync(file) ? `<figure><a href="${esc(rel(original))}" target="_blank"><img loading="lazy" src="${esc(rel(file))}" style="background:repeating-conic-gradient(#ddd 0% 25%,#f5f5f5 0% 50%) 0/24px 24px"></a><figcaption>${esc(label)}</figcaption></figure>` : '';
const link = (file,label) => file && fs.existsSync(file) ? `<a href="${esc(rel(file))}" target="_blank">${esc(label)}</a>` : '';
function atlasTargetLegend(request, loop) {
  if(!Array.isArray(request.targets)||!request.targets.length)return '';
  const categories={text:'文字',icon:'图标',button:'按钮',panel:'面板／底板',decoration:'装饰',artwork:'图案'};
  const earlier=new Map();
  for(const previous of state.loops.filter(item=>item.index<loop.index))
    for(let i=0;i<(previous.selected||[]).length;i++)earlier.set(previous.selected[i].id,previous.layers?.[i]);
  const rows=request.targets.map((target,i)=>{
    const box=loop.selected?.find(item=>item.id===target.id);
    const category=target.category||box?.category;
    const removed=(target.removed_in_this_crop||[]).map(item=>{
      const layer=earlier.get(item.id);
      return link(layer?.source,item.description||item.id)||esc(item.description||item.id);
    }).join('；')||'—';
    return `<tr><td>第 ${esc(target.cell||i+1)} 格</td><td>${esc(categories[category]||category||'对象')}</td><td>${esc(target.description||box?.description||target.id)}</td><td>${removed}</td></tr>`;
  }).join('');
  return `<p>每格只提取下表指定的对象，同一批可同时包含图标和底板。原图参考中仍有此前已提取的前景；提取其后方底板时，这些前景应当留在独立图层中。</p><table><thead><tr><th>格子</th><th>本格目标类型</th><th>本格提取内容</th><th>此前已提取（点击查看图层）</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function atlasArtifacts(loop) {
  const directory=path.dirname(loop.report);
  const corrections=(loop.corrections||[]).map(item=>`<h3>已纠正图集 ${item.batch}</h3><p>${esc(item.reason)} · ${link(path.join(item.directory,'correction.json'),'纠正要求')}</p><div class="images">${img(path.join(directory,'cutouts',`batch_${String(item.batch).padStart(2,'0')}`,'model.png'),'首次返回')}${img(path.join(item.directory,'model.png'),'纠正后返回')}</div>`).join('');
  return ['cutouts','repair'].map(kind=>{
    const folder=path.join(directory,kind);if(!fs.existsSync(folder))return '';
    return fs.readdirSync(folder).filter(name=>/^batch_\d+$/.test(name)).map(name=>{
      const batch=path.join(folder,name);
      let legend='';
      if(fs.existsSync(path.join(batch,'request.json'))){try{legend=atlasTargetLegend(JSON.parse(fs.readFileSync(path.join(batch,'request.json'),'utf8')),loop);}catch{}}
      return `<h3>${kind==='cutouts'?'抠图':'后景补图'} ${esc(name)}</h3><p>${link(path.join(batch,'request.json'),'完整抠图请求')} ${link(path.join(batch,'model_request.json'),'完整补图请求')}</p>${legend}<div class="images">${img(path.join(batch,'bbox_reference.png'),'当前输入与 bbox 定位外框')}${img(path.join(batch,'input.png'),'当前实际输入：此前已提取的对象是透明洞')}${img(path.join(batch,'before_input.png'),kind==='cutouts'?'原图参考：用于还原材质，仍包含此前已提取的前景':'删除前像素参考')}${img(path.join(batch,'model.png'),'模型返回：每格只保留该格指定的目标')}</div>`;
    }).join('');
  }).join('')+corrections+`<p>${link(path.join(directory,'after_model_request.json'),'整图补图请求')} ${link(path.join(directory,'pending_bbox_checks.json'),'待提取后景的批量 bbox 记录')}</p>`;
}

async function page() {
  const statusLabel=({running:'运行中',completed:'已完成',incomplete:'未完成（已保存进度）',failed:'失败'})[state.status] || state.status;
  const fidelityNotice=state.fidelity_summary?`<p class="notice">原像素验收：${esc(state.fidelity_summary.status)} · ${state.fidelity_summary.applied_layers} 个前景已恢复原图像素 · ${state.fidelity_summary.checked_opaque_pixels} 个可见不透明像素逐字节核对 · ${state.fidelity_summary.pending.length} 个对象待检查。此验收不覆盖文字、底板、遮挡补全及真实半透明材质。<a href="fidelity_verification.json">验收范围与待检查对象</a></p>`:'';
  const detectionNotice=state.detection_mode==='regional_cache_v1'?`<p class="notice">增量检测：局部像素、原图参考与区域内依赖一致才复用；已提交轮次累计复用 ${state.loops.reduce((sum,loop)=>sum+(loop.detection_reuse?.reused_regions||0),0)} 个分区。每轮整图检测、跨区遮挡处理与最终背景确认照常执行。</p>`:'';
  const notice=detectionNotice+(state.surface_style==='borderless'?'<p class="notice">本次底板去线框：移除 UI 底板的硬外框和重复内框；保留填色、渐变、软阴影、功能刻度，以及文字和图标本身的描边。</p>':'')+(state.notice?`<p class="notice">${esc(state.notice)}</p>`:'')+fidelityNotice;
  const timingFiles=fs.readdirSync(OUT,{recursive:true}).filter(name=>name.endsWith('_timing.json'));
  const requestTimings=await Promise.all(timingFiles.map(async name=>{try{return await read(path.join(OUT,name));}catch{return null;}}));
  const timingRows=requestTimings.filter(Boolean).map(t=>'<tr><td>'+esc(rel(t.output))+'</td><td>'+esc(t.status)+'</td><td>'+((t.queue_ms??(Date.now()-Date.parse(t.queued_at)))/1000).toFixed(1)+' 秒</td><td>'+(t.started_at?((t.execution_ms??(Date.now()-Date.parse(t.started_at)))/1000).toFixed(1)+' 秒':'等待中')+'</td><td>'+t.attempts.length+'</td></tr>').join('');
  const timingTable='<details open><summary>生图请求：排队与执行（执行含接口传输、重试）</summary><table><tr><th>输出</th><th>状态</th><th>排队</th><th>执行</th><th>尝试次数</th></tr>'+timingRows+'</table></details>';
  const steps = state.steps.map(s => `<tr><td>${esc(s.title)}</td><td>${esc(s.status)}</td><td>${esc(s.started_at)}</td><td data-start="${esc(s.started_at)}" data-end="${esc(s.ended_at || '')}">${((s.elapsed_ms || 0)/1000).toFixed(1)} 秒</td><td>${esc(s.ended_at || '')}</td></tr>`).join('');
  const loops = state.loops.map(loop => {
    const inputPreview = loop.input_checker || loop.input;
    const bboxPreview = loop.bbox_preview_checker || loop.bbox_preview;
    const nextPreview = loop.index === 1 ? (loop.after_checker || loop.after) : loop.holes_checker;
    const recomposedPreview = loop.recomposed_checker || loop.recomposed;
    return `<section><h2>${loop.index === 1 ? '文字轮' : `图像轮 ${loop.index - 1}`} · ${loop.layers?.length || 0} 个图层</h2><p>当前输入保留真实 alpha=0 透明洞。bbox 沿用物体在删除前的完整边界，新物体参考无洞原图定位；透明洞用于判断当前还剩哪些物体。</p><div class="images">${img(inputPreview,'本轮输入：棋盘格表示透明区域',loop.input)}${img(loop.bbox_source_checker,'本轮检测 bbox：透明洞底图',loop.bbox_source_checker || loop.bbox_preview)}${img(loop.bbox_original_reference,'相同 bbox 放在原图上：检查完整轮廓',loop.bbox_original_reference)}${img(bboxPreview,'本轮提取 bbox：含安全余量',loop.bbox_preview || bboxPreview)}${img(loop.holes_checker,'删除后的真实透明洞',loop.holes || loop.holes_checker)}${img(nextPreview,loop.index===1?'下一轮输入：已补齐的无文字底图':'下一轮输入：直接沿用透明洞图',loop.after)}${img(recomposedPreview,'本轮物体放回：检查位置与大小',loop.recomposed || recomposedPreview)}</div><details><summary>查看独立图层与模型图集</summary><div class="tiles">${(loop.layers || []).map(l=>img(l.source, l.name || l.id)).join('')}</div>${atlasArtifacts(loop)}<p>${link(loop.input,'原始输入 PNG')} ${link(loop.bbox_preview,'完整 bbox 图')} ${link(loop.recomposed,'放回合成图')}</p><a href="${esc(rel(loop.report))}">本轮数据</a></details></section>`;
  }).join('');
  const detailComparisons=(state.detail_comparisons||[]).map(item=>img(item.source,item.label)).join('');
  const final = state.psd ? `<section><h2>最终结果</h2><p><a href="${esc(rel(state.psd))}">下载 PSD</a> · <a href="verification.json">验证数据</a> · <a href="layers.json">图层清单</a> · <a href="comparison.png">整图对照 PNG</a></p><p>拖动滑块叠加比较原图与 PSD 图层合成图。</p><div class="overlay"><img src="input.png"><img id="rebuilt" src="recomposed.png" style="opacity:.5"></div><input aria-label="合成图透明度" type="range" min="0" max="100" value="50" oninput="document.getElementById('rebuilt').style.opacity=this.value/100"><div class="images">${img(path.join(OUT,'comparison.png'),'原图 / 所有图层合成')}${img(state.background,'最终背景')}${detailComparisons}</div></section>` : '';
  await fsp.writeFile(path.join(OUT, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>递归 bbox 分层测试</title><style>body{font:15px system-ui;color:#dce7f4;background:#101722;margin:24px}a{color:#75c3ff}h1,h2{font-weight:600}section{margin:26px 0;border-top:1px solid #425269;padding-top:16px}.images,.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}figure{margin:0;background:#202d3e;padding:8px}img{max-width:100%;display:block}figcaption{padding:8px}.tiles{grid-template-columns:repeat(7,minmax(0,1fr))}.tiles img{width:auto;height:auto;max-height:110px;object-fit:contain;background:repeating-conic-gradient(#ccc 0% 25%,#eee 0% 50%) 0/16px 16px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:6px;text-align:left;border-bottom:1px solid #334155}.overlay{position:relative;max-width:1280px}.overlay img+img{position:absolute;left:0;top:0;width:100%}input{width:min(100%,1280px)}.error{color:#ff9d9d;white-space:pre-wrap}.notice{padding:12px;background:#203747;border-left:3px solid #75c3ff}</style><h1>递归 bbox 分层测试</h1><p>状态：${esc(statusLabel)} · 文字每批 ${state.text_batch_size || state.batch_size || 7} 个 · 图像每批 ${state.batch_size || 7} 个，各批并行 · ${MODEL} / max</p><p>开始：${esc(state.started_at)} · 结束：${esc(state.ended_at || '')} · 总耗时：<span id="elapsed"></span></p><p>文字轮先补齐无文字底图。后续图像轮在真实透明洞图上找 bbox、批量抠图，删除后直接作为下轮输入。图像循环中不补整图。</p>${state.error?`<p class="error">${esc(state.error)}</p>`:''}${notice}${final}${timingTable}<p>步骤总耗时包含排队；旧请求没有独立计时记录。</p><details open><summary>步骤时间</summary><table><thead><tr><th>步骤</th><th>状态</th><th>开始时间</th><th>已运行</th><th>结束时间</th></tr></thead><tbody>${steps}</tbody></table></details>${loops}<script>const start=${JSON.stringify(state.started_at || '')},end=${JSON.stringify(state.ended_at || '')};function tick(){document.getElementById('elapsed').textContent=((Date.parse(end)||Date.now())-Date.parse(start))/1000+' 秒';for(const cell of document.querySelectorAll('[data-start]')){const a=Date.parse(cell.dataset.start),b=Date.parse(cell.dataset.end)||Date.now();cell.textContent=((b-a)/1000).toFixed(1)+' 秒';}}tick();setInterval(tick,1000);${state.status==='running'?'setTimeout(()=>location.reload(),15000);':''}</script></html>`, 'utf8');
}
async function save() {
  saves = saves.then(async()=>{await write(path.join(OUT, 'status.json'), state); await page();});
  await saves;
}
async function step(id, title, work, metadata={}) {
  const record = {id,title,...metadata,status:'running',started_at:new Date().toISOString()};
  state.steps.push(record); await save(); console.log(JSON.stringify(record));
  const timer = setInterval(()=>console.log(JSON.stringify({stage:id,elapsed_s:Math.round((Date.now()-Date.parse(record.started_at))/1000)})),30000);
  try {const result=await work();record.status='completed';return result;}
  catch(error){record.status='failed';record.error=error.message;throw error;}
  finally{clearInterval(timer);record.ended_at=new Date().toISOString();record.elapsed_ms=Date.parse(record.ended_at)-Date.parse(record.started_at);await save();console.log(JSON.stringify(record));}
}
let core = createCore({state, step});

async function model(images, prompt, output, size, background) {
  const request = output.replace(/\.png$/, '_request.json');
  const cache = output.replace(/\.png$/, '_cache.json');
  const key = await imageKey(images, {model:MODEL,prompt,size,background,quality:qualityFor('background')});
  await write(request,{model:MODEL,quality:qualityFor('background'),image_paths:images,prompt,size,background,cache_key:key});
  const cached = fs.existsSync(cache) ? await read(cache) : null;
  if(!(cached?.key===key && fs.existsSync(output) && cached.output_key===await imageKey([output],{}))){
    await imageRequest(images[0],output,prompt,MODEL,null,undefined,{provider:'openai',clientKind:'background-repair',imagePaths:images,background,quality:qualityFor('background'),size,resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,responseMetadataPath:output.replace(/\.png$/,'_geometry.json')});
    await write(cache,{key,output_key:await imageKey([output],{})});
  }
  return output;
}
async function correctedCanvas(modelOutput, output) {
  const meta=await sharp(modelOutput).metadata();
  const [width,height]=state.canvas;
  if(meta.width===width && meta.height===height) await fsp.copyFile(modelOutput,output);
  else await sharp(modelOutput).resize(width,height,{fit:'fill'}).png().toFile(output);
  const stats=await alphaStats(output);
  assert.equal(stats.transparent_pixels,0,'Model left transparent deletion gaps');
  assert(stats.minimum_alpha>=248,'Model left an incomplete surface');
  return stats;
}

async function textRound() {
  const dir=path.join(OUT,'loop_01');await fsp.mkdir(dir,{recursive:true});
  const matchingArchive=fs.existsSync(path.join(TEXT_ARCHIVE,'input.png'))&&
    fs.existsSync(path.join(TEXT_ARCHIVE,'loop_01/report.json'))&&
    await imageKey([SOURCE],{})===await imageKey([path.join(TEXT_ARCHIVE,'input.png')],{});
  if(!matchingArchive)return freshTextRound(dir);
  const archived=await read(path.join(TEXT_ARCHIVE,'loop_01/report.json'));
  const input=path.join(dir,'input.png'),after=path.join(dir,'after.png');
  await fsp.copyFile(SOURCE,input);
  const holes=path.join(dir,'holes.png'),holes_checker=path.join(dir,'holes_checker.png');
  await deleteBboxes(input,archived.selected,holes);await checker(holes,holes_checker);
  await fsp.copyFile(archived.after,after);
  const layers=await Promise.all(archived.layers.map(async(l,i)=>{
    const source=path.join(dir,`${String(i+1).padStart(3,'0')}_${l.id}.png`);await fsp.copyFile(l.source,source);
    return {...l,source,id:`loop_01_${l.id}`,name:`文字 / ${archived.selected.find(e=>e.id===l.id)?.description || l.id}`,depth:1,z_index:100000-i};
  }));
  const report={index:1,input,after,holes,holes_checker,layers,selected:archived.selected,deferred:[],report:path.join(dir,'report.json'),reused_from:TEXT_ARCHIVE,reuse_reason:'Reuse completed text removal and text cutouts for identical source',assembly:'completed_text_removal'};
  await refreshLoopPreviews(report);state.loops.push(report);await save();return report;
}

async function freshTextRound(dir) {
  const input=path.join(dir,'input.png');await fsp.copyFile(SOURCE,input);
  const plan=await step('loop1_text_bbox','识别当前原图的全部文字 bbox',()=>core.detect(input,dir,'text'));
  if(!plan.selected.length) {
    const after=path.join(dir,'after.png');await fsp.copyFile(input,after);
    const report={index:1,input,after,layers:[],selected:[],deferred:[],report:path.join(dir,'report.json'),no_text:true};
    await refreshLoopPreviews(report);state.loops.push(report);await save();return report;
  }
  const holes=path.join(dir,'holes.png');await deleteBboxes(input,plan.selected,holes);
  const holes_checker=path.join(dir,'holes_checker.png');await checker(holes,holes_checker);
  const extractText=()=>core.extract(input,plan.selected,path.join(dir,'cutouts'),'loop1_cutout',false,{referenceSource:SOURCE,removed:[]});
  const completeText=()=>step('loop1_text_completion','补齐删除文字后的底图（仅文字轮）',()=>model([input,holes],`Remove ONLY the listed text labels and numbers from Image 1. Image 2 marks their exact bbox deletions as true transparent holes. Fill those holes with the continuing underlying surfaces, preserving every icon, character, panel, color, position and non-text detail. Do not remove or recreate any other object. Return an opaque ${state.canvas.join('x')} PNG. Text to remove: ${JSON.stringify(plan.selected.map(el=>({description:el.description,bbox:el.bbox})))}`,path.join(dir,'after_model.png'),state.canvas.join('x'),'opaque'));
  let extracted,raw;
  if(PIPELINE){
    // Both operations depend only on the detected text and these exact holes.
    // They continue to share the existing two image-request slots.
    const completeAndPlan=async()=>{
      const completed=await completeText();
      if(VISUAL_WINDOW>1&&Number(process.env.BBOX_MAX_ROUNDS||24)>=1){
        const after=path.join(dir,'after.png');await correctedCanvas(completed,after);
        const nextDir=path.join(OUT,'loop_02');await fsp.mkdir(nextDir,{recursive:true});
        const nextInput=path.join(nextDir,'input.png');await fsp.copyFile(after,nextInput);
        const staged={index:1,input,after,selected:plan.selected,deferred:[],layers:[]};
        const snapshot=structuredClone({...state,loops:[...state.loops,staged]});
        const detector=createCore({state:snapshot,step});
        const result=step('loop2_bbox','第 1 轮 bbox（与剩余文字抠图并行）',()=>detector.detect(nextInput,nextDir,'visual',snapshot.loops.flatMap(loop=>loop.selected),retainedHints(snapshot.loops)),{prefetched_text:true})
          .then(value=>({plan:value}),error=>({error}));
        pendingTextVisual={input:nextInput,dir:nextDir,result};pendingDetection=result;
      }
      return completed;
    };
    const results=await Promise.allSettled([extractText(),completeAndPlan()]);
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    [extracted,raw]=results.map(result=>result.value);
  }else{extracted=await extractText();raw=await completeText();}
  const layers=extracted.map((layer,i)=>({...layer,id:'loop_01_'+layer.id,name:'文字 / '+plan.selected[i].description,depth:1}));
  const after=path.join(dir,'after.png');await correctedCanvas(raw,after);
  const rear={after,raw,assembly:'completed_text_removal'},recomposed=path.join(dir,'recomposed.png');await fullComposite(after,layers,recomposed);
  const report={index:1,input,selected:plan.selected,deferred:[],layers,...rear,holes,holes_checker,recomposed,bbox_preview:path.join(dir,'selected_bbox.png'),report:path.join(dir,'report.json'),text_method:'fresh_source_text_atlas'};
  await refreshLoopPreviews(report);state.loops.push(report);await save();return report;
}

async function finishBackground(holes, loops=state.loops) {
  const removed=loops.flatMap(loop=>loop.selected||[]).map(el=>({description:el.description,bbox:el.bbox}));
  const raw=await model([holes,SOURCE],`Complete ONLY natural background scenery through the true alpha=0 holes in Image 1. Image 1 is the edit target after ALL foreground and UI objects have been extracted. Image 2 is the original image, reference only for scenery tone and geometry. Keep existing scenery pixels, exposure, color saturation, softness, blur and geometry. Extend the observed original background at the same brightness and focus; never convert a subdued backdrop into a sharp bright landscape. Fill every transparent hole with continuous natural scenery. Do not restore any UI, text, character, item, panel or control from Image 2. No redesign, brightening, sharpening, extra sunlight or new props. Removed objects: ${JSON.stringify(removed)}. Return one opaque ${state.canvas.join('x')} PNG.`,path.join(OUT,'background_model.png'),state.canvas.join('x'),'opaque');
  const background=path.join(OUT,'background.png');await correctedCanvas(raw,background);return background;
}

async function verifyHoleTransition(input,holes) {
  const before=await sharp(input).ensureAlpha().raw().toBuffer();
  const after=await sharp(holes).ensureAlpha().raw().toBuffer();
  assert.equal(before.length,after.length,'Deletion changed the canvas');
  let deleted=0,transparent=0;
  for(let p=0;p<after.length;p+=4) {
    if(after[p+3])assert(after.subarray(p,p+4).equals(before.subarray(p,p+4)),'Deletion changed surviving pixels');
    else {transparent++;assert(after[p]===0&&after[p+1]===0&&after[p+2]===0,'Transparent hole has nonzero RGB');if(before[p+3])deleted++;}
    if(!before[p+3])assert.equal(after[p+3],0,'Deletion restored an earlier hole');
  }
  assert(deleted>0,'All selected bboxes are already empty; no extraction progress');
  return {surviving_rgba_exact:true,previous_holes_preserved:true,deleted_pixels:deleted,transparent_pixels:transparent};
}

function orderLayers(loops) {
  return loops.flatMap(loop=>loop.layers.map((layer,i)=>({...layer,depth:loop.index,z_index:100000-loop.index*1000-i})));
}
function retainedHints(loops) {
  const removed=loops.flatMap(loop=>loop.selected || []);
  const absent=new Set(loops.flatMap(loop=>(loop.continuity?.checks||[]).filter(check=>check.present===false).map(check=>check.hint_id)));
  for(const check of loops.flatMap(loop=>loop.continuity?.inventory_hint_checks||[]))if(check.status==='absent')absent.add(check.hint_id);
  return loops.flatMap(loop=>loop.deferred || []).filter(el=>!absent.has(el.id)&&!removed.some(selected=>{
    const a=el.bbox[2]*el.bbox[3],b=selected.bbox[2]*selected.bbox[3];
    // Categories can change between fresh inventories (button versus panel,
    // decoration versus icon). These are only reminders; actual pixels decide.
    return Math.min(a,b)/Math.max(a,b)>.75 && overlap(el.bbox,selected.bbox)/Math.min(a,b)>.85;
  })).filter((el,i,list)=>!list.slice(0,i).some(prev=>prev.category===el.category && overlap(prev.bbox,el.bbox)/Math.max(prev.bbox[2]*prev.bbox[3],el.bbox[2]*el.bbox[3])>.85));
}
function readPsdPixels(buffer) {
  // Read RGBA directly without installing a native canvas dependency.
  initializeCanvas(()=>{throw new Error('PSD pixel verification unexpectedly requested a canvas');},
    (width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
  return readPsd(buffer,{useImageData:true,skipThumbnail:true});
}
async function exportFinal(background) {
  const layers=orderLayers(state.loops);
  const reference=await sharp(SOURCE).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let checkedOpaque=0;const applied=layers.filter(layer=>layer.fidelity?.applied);
  for(const layer of applied) {
    const actual=await sharp(layer.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const mask=await sharp(layer.fidelity.opaque_source_mask).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
    assert.equal(mask.info.width,actual.info.width);assert.equal(mask.info.height,actual.info.height);
    let count=0;
    for(let y=0;y<mask.info.height;y++)for(let x=0;x<mask.info.width;x++)if(mask.data[y*mask.info.width+x]) {
      const a=(y*actual.info.width+x)*4,b=((y+layer.bbox[1])*reference.info.width+x+layer.bbox[0])*4;
      assert.equal(actual.data[a+3],255,'Claimed source pixel is not opaque');
      assert(actual.data.subarray(a,a+3).equals(reference.data.subarray(b,b+3)),'Restored RGB differs from original at native coordinates');count++;
    }
    assert.equal(count,layer.fidelity.visible_opaque_pixels);checkedOpaque+=count;
  }
  const pending=layers.filter(layer=>layer.fidelity?.status==='needs_review').map(layer=>({id:layer.id,name:layer.name,reasons:layer.fidelity.reasons,report:layer.fidelity.report,retry:layer.fidelity_retry||null}));
  state.fidelity_summary={status:pending.length?'needs_review':applied.length?'passed_visible_opaque':'not_applicable',applied_layers:applied.length,checked_opaque_pixels:checkedOpaque,pending,
    scope:'Only declared visible opaque foreground pixels at original coordinates; no claim about hidden pixels, glass alpha, text or surfaces',
    retry_attempted:layers.filter(layer=>layer.fidelity_retry).length,retry_budget_per_object:state.model_output_policy==='model_rgba_downscale_only'?0:1};
  await write(path.join(OUT,'fidelity_verification.json'),state.fidelity_summary);
  const backgroundLayer={id:'background_final',name:'背景',kind:'background',source:background,bbox:[0,0,...state.canvas],z_index:0};
  const backToFront=[backgroundLayer,...layers.slice().sort((a,b)=>a.z_index-b.z_index)];
  const recomposed=path.join(OUT,'recomposed.png');await fullComposite(background,backToFront.slice(1),recomposed);
  const psd=path.join(OUT,'layers.psd');
  await exportPsd({canvas:{width:state.canvas[0],height:state.canvas[1]},layers:backToFront,text_layers:[]},psd,recomposed);
  await write(path.join(OUT,'layers.json'),backToFront);
  const decoded=readPsdPixels(await fsp.readFile(psd));
  assert.equal(decoded.width,state.canvas[0]);assert.equal(decoded.height,state.canvas[1]);
  assert.equal(decoded.children.length,backToFront.length);
  const pngs=[];const details=[];
  for(let i=0;i<decoded.children.length;i++) {
    const actual=decoded.children[i],expected=backToFront[i],pixels=await sharp(expected.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.name,expected.name || expected.id);
    assert.equal(actual.left,expected.bbox[0]);assert.equal(actual.top,expected.bbox[1]);
    assert.equal(actual.imageData.width,pixels.info.width);assert.equal(actual.imageData.height,pixels.info.height);
    assert(Buffer.from(actual.imageData.data).equals(pixels.data),'PSD changed layer RGB/alpha: '+expected.id);
    const buffer=await sharp(Buffer.from(actual.imageData.data),{raw:{width:actual.imageData.width,height:actual.imageData.height,channels:4}}).png().toBuffer();
    pngs.push({input:buffer,left:actual.left,top:actual.top});
    const alpha=await alphaStats(expected.source);details.push({id:expected.id,depth:expected.depth,bbox:expected.bbox,...alpha,psd_rgba_exact:true});
  }
  const psdComposite=path.join(OUT,'psd_recomposed.png');
  await sharp({create:{width:decoded.width,height:decoded.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(pngs).png().toFile(psdComposite);
  const rgbaA=await sharp(recomposed).ensureAlpha().raw().toBuffer(),rgbaB=await sharp(psdComposite).ensureAlpha().raw().toBuffer();
  assert(rgbaA.equals(rgbaB),'PSD layers composite differs from PNG');
  await comparison([path.join(OUT,'input.png'),psdComposite],['原图','PSD 全部图层合成'],path.join(OUT,'comparison.png'));
  await sharp(path.join(OUT,'comparison.png')).resize({width:1920}).png().toFile(path.join(OUT,'comparison_preview.png'));
  let total=0;
  const original=await sharp(SOURCE).ensureAlpha().raw().toBuffer();
  for(let p=0;p<original.length;p+=4)for(let c=0;c<3;c++)total+=Math.abs(original[p+c]-rgbaA[p+c]);
  const links=[];
  const visualBase=await sharp(state.loops[0].after).ensureAlpha().raw().toBuffer();
  for(let i=1;i<state.loops.length;i++)assert.equal(await imageKey([state.loops[i-1].after],{}),await imageKey([state.loops[i].input],{}),'Loop source was altered');
  for(const loop of state.loops) {
    if(loop.index===1||!loop.holes)continue;
    assert.equal(await imageKey([loop.holes],{}),await imageKey([loop.after],{}),'Next-loop input must be the exact transparent-hole file');
    const remaining=await sharp(loop.after).ensureAlpha().raw().toBuffer();
    for(let p=0;p<remaining.length;p+=4)if(remaining[p+3])assert(remaining.subarray(p,p+4).equals(visualBase.subarray(p,p+4)),'Surviving text-free source pixels changed');
    links.push({index:loop.index,next_input_exact_alpha_holes:true,surviving_text_free_rgba_exact:true});
  }
  const verification={status:'passed',background_only:state.terminal,canvas:state.canvas,visual_rounds:state.loops.length-1,text_layers:state.loops[0].layers.length,layer_count:backToFront.length,psd_layer_rgba_exact:true,psd_composite_exact:true,loop_inputs_byte_identical:true,model_responses:links,mean_absolute_rgb_difference:total/(state.canvas[0]*state.canvas[1]*3),layers:details};
  await write(path.join(OUT,'verification.json'),verification);
  Object.assign(state,{psd,recomposed:psdComposite,background,layer_count:backToFront.length,verification});await save();
}

async function main() {
  await fsp.mkdir(OUT,{recursive:true});
  if(fs.existsSync(path.join(OUT,'status.json'))){const checkpoint=await read(path.join(OUT,'status.json'));assert.equal(checkpoint.flow,FLOW,'Old repaired-image checkpoint cannot resume in transparent-hole flow');Object.assign(state,checkpoint);if(!Object.hasOwn(checkpoint,'model_output_policy'))delete state.model_output_policy;if(!Object.hasOwn(checkpoint,'text_batch_size'))state.text_batch_size=checkpoint.batch_size||7;}
  if(process.argv.includes('--report-only')) {
    for(const loop of state.loops)await refreshLoopPreviews(loop);
    await save();return;
  }
  if(process.argv.includes('--export-only')) {
    assert(state.background&&fs.existsSync(state.background),'No completed background to export');
    assert.notEqual(state.status,'running','Wait for the current extraction before updating the PSD');
    for(const loop of state.loops)await refreshLoopPreviews(loop);
    await exportFinal(state.background);await page();return;
  }
  assert.equal(path.resolve(state.source),SOURCE,'Output checkpoint belongs to a different source');
  assert.equal(state.batch_size,BATCH,'Visual atlas batch size changed; resume with the original BBOX_VISUAL_BATCH_SIZE or use a new output directory');
  assert.equal(state.detection_mode||'full',DETECTION_MODE,'Detection mode changed; resume with the original BBOX_INCREMENTAL_DETECTION setting');
  assert.equal(state.detection_pass||'separate',DETECTION_PASS,'Combined detection changed on resume');
  for(const record of state.steps){
    const batch=record.id.match(/^loop(\d+)_cutout_batch_(\d+)$/);
    if(batch && record.title.includes('?'))record.title=`第 ${Number(batch[1])-1} 轮抠图图集 ${batch[2]}`;
    if(record.status==='running'){
      record.status='interrupted';record.ended_at=new Date().toISOString();
      record.elapsed_ms=Date.parse(record.ended_at)-Date.parse(record.started_at);
    }
  }
  state.canvas=await sharp(SOURCE).metadata().then(m=>[m.width,m.height]);
  if(state.scheduling)assert.equal(state.scheduling.visual_window||1,VISUAL_WINDOW,'Visual planning window changed on resume');
  state.scheduling={mode:PIPELINE?(VISUAL_WINDOW>1?'bounded_visual_window':'one_round_lookahead'):'serial',visual_window:VISUAL_WINDOW,image_concurrency:Math.max(1,Number(process.env.BBOX_IMAGE_CONCURRENCY)||2),text_completion_parallel:PIPELINE,text_visual_overlap:VISUAL_WINDOW>1};
  state.started_at ||= new Date().toISOString();state.status='running';delete state.error;delete state.notice;delete state.stop_reason;delete state.ended_at;
  await fsp.copyFile(SOURCE,path.join(OUT,'input.png'));await save();
  if(!state.loops.length)await step('text_round','准备文字图层并删除文字',textRound);
  let previous=state.loops.at(-1);
  let ahead=null;
  const maxRounds=Number(process.env.BBOX_MAX_ROUNDS || 24); // Diagnostic guard, never a successful stop.
  if(VISUAL_WINDOW>1){
    const result=await runVisualWindow({loops:state.loops,maxRounds,window:VISUAL_WINDOW,
      detect:async(index,loops)=>{
        if(index===2&&pendingTextVisual){
          const seed=pendingTextVisual;
          assert.equal(await imageKey([seed.input],{}),await imageKey([loops.at(-1).after],{}),'Text prefetch must use the exact completed opaque base');
          const result=await seed.result;pendingTextVisual=null;pendingDetection=null;
          if(result.error)throw result.error;
          return {...result.plan,window_input:seed.input,window_dir:seed.dir};
        }
        const dir=path.join(OUT,`loop_${String(index).padStart(2,'0')}`);await fsp.mkdir(dir,{recursive:true});
        const input=path.join(dir,'input.png');await fsp.copyFile(loops.at(-1).after,input);
        const snapshot=structuredClone({...state,loops});
        const detector=createCore({state:snapshot,step});
        const plan=await step(`loop${index}_bbox`,`第 ${index-1} 轮 bbox 与遮挡关系`,()=>detector.detect(input,dir,'visual',loops.flatMap(loop=>loop.selected),retainedHints(loops)),{planning_window:VISUAL_WINDOW});
        return {...plan,window_input:input,window_dir:dir};
      },
      prepare:async(index,plan,loops)=>{
        assert(plan.selected.length>0,'Occlusion graph has no accessible frontmost target');
        const input=plan.window_input,dir=plan.window_dir,holes=path.join(dir,'holes.png');
        await deleteBboxes(input,plan.selected,holes);
        const transition=await verifyHoleTransition(input,holes);await write(path.join(dir,'transition_check.json'),transition);
        const holes_checker=path.join(dir,'holes_checker.png');await checker(holes,holes_checker);
        return {index,plan,input,dir,holes,holes_checker,transition,removed:loops.flatMap(loop=>loop.selected),
          staged:{index,input,after:holes,selected:plan.selected,deferred:plan.deferred,continuity:plan.continuity,layers:[]}};
      },
      extract:item=>core.extract(item.input,item.plan.selected,path.join(item.dir,'cutouts'),`loop${item.index}_cutout`,true,{referenceSource:SOURCE,removed:item.removed}),
      commit:async(item,extracted)=>{
        const {index,input,dir,holes,holes_checker,transition,plan}=item;
        assert.equal(state.loops.length,index-1,'Visual round committed out of order');
        const layers=extracted.map((layer,i)=>({...layer,id:`loop_${String(index).padStart(2,'0')}_${layer.id}`,name:`第 ${index-1} 轮 / ${plan.selected[i].description}`,depth:index}));
        const after=path.join(dir,'after.png');await fsp.copyFile(holes,after);
        const recomposed=path.join(dir,'recomposed.png');await fullComposite(after,layers,recomposed);
        const report={index,input,after,assembly:FLOW,selected:plan.selected,deferred:plan.deferred,continuity:plan.continuity,geometry:plan.geometry,geometry_reference:SOURCE,detection_reuse:plan.detection_reuse,transition,layers,holes,holes_checker,recomposed,bbox_preview:path.join(dir,'selected_bbox.png'),report:path.join(dir,'report.json')};
        await refreshLoopPreviews(report);state.loops.push(report);await save();
      },
      background:(plan,_index,loops)=>step('final_background','补齐最终背景（与剩余抠图并行）',()=>finishBackground(plan.window_input,loops)),
      complete:async(background,plan)=>{
        state.terminal=plan.terminal;
        await step('export','合成图层并导出、读取验证 PSD',()=>exportFinal(background));
        state.status='completed';state.ended_at=new Date().toISOString();await save();
        console.log(JSON.stringify({status:'completed',output:OUT,visual_rounds:state.loops.length-1,layer_count:state.layer_count}));
      }});
    if(result.completed)return;
  }
  for(let index=state.loops.length+1;VISUAL_WINDOW===1&&index<=maxRounds+1;index++) {
    // Pick up local detection/cutout fixes at round boundaries, keeping
    // already completed batches and inputs intact.
    delete require.cache[require.resolve('./bbox_recursive_core.js')];
    core=require('./bbox_recursive_core.js').createCore({state,step});
    const dir=path.join(OUT,`loop_${String(index).padStart(2,'0')}`);await fsp.mkdir(dir,{recursive:true});
    const input=path.join(dir,'input.png');
    if(ahead){
      assert.equal(ahead.index,index,'Lookahead belongs to a different round');
      assert.equal(await imageKey([input],{}),await imageKey([previous.after],{}),'Prefetched input differs from the committed alpha-hole image');
    }else await fsp.copyFile(previous.after,input);
    const removedEarlier=state.loops.flatMap(loop=>loop.selected);
    let plan;
    if(ahead){const result=await ahead.result;ahead=null;pendingDetection=null;if(result.error)throw result.error;plan=result.plan;}
    else plan=await step(`loop${index}_bbox`,`第 ${index-1} 轮重新识别 bbox 和遮挡关系`,()=>core.detect(input,dir,'visual',removedEarlier,retainedHints(state.loops)));
    if(plan.background_only){state.terminal=plan.terminal;const background=await step('final_background','仅在全部提取完成后补齐最终背景',()=>finishBackground(input));await step('export','合成全部图层、导出并读取验证 PSD',()=>exportFinal(background));state.status='completed';state.ended_at=new Date().toISOString();await save();console.log(JSON.stringify({status:'completed',output:OUT,visual_rounds:state.loops.length-1,layer_count:state.layer_count}));return;}
    assert(plan.selected.length>0,'Occlusion graph has no accessible frontmost target');
    const holes=path.join(dir,'holes.png');await deleteBboxes(input,plan.selected,holes);
    const transition=await verifyHoleTransition(input,holes);await write(path.join(dir,'transition_check.json'),transition);
    const holes_checker=path.join(dir,'holes_checker.png');await checker(holes,holes_checker);
    if(PIPELINE&&index<maxRounds+1){
      // The next residual depends on bbox deletion, not on generated cutouts.
      // Give its detector a private snapshot of exactly the metadata it would
      // receive after this round commits. Never commit a speculative loop.
      const nextIndex=index+1,nextDir=path.join(OUT,`loop_${String(nextIndex).padStart(2,'0')}`);
      await fsp.mkdir(nextDir,{recursive:true});const nextInput=path.join(nextDir,'input.png');await fsp.copyFile(holes,nextInput);
      const staged={index,input,after:holes,selected:plan.selected,deferred:plan.deferred,continuity:plan.continuity,layers:[]};
      const snapshot=structuredClone({...state,loops:[...state.loops,staged]});
      const nextCore=require('./bbox_recursive_core.js').createCore({state:snapshot,step});
      // Convert rejection into a settled result immediately. If extraction
      // fails, drain the in-flight detector before writing the final failure.
      const result=step(`loop${nextIndex}_bbox`,`第 ${nextIndex-1} 轮重新识别 bbox 和遮挡关系`,()=>nextCore.detect(nextInput,nextDir,'visual',snapshot.loops.flatMap(loop=>loop.selected),retainedHints(snapshot.loops)),{prefetched:true})
        .then(nextPlan=>({plan:nextPlan}),error=>({error}));
      ahead={index:nextIndex,result};pendingDetection=result;
    }
    let extracted;
    try{extracted=await core.extract(input,plan.selected,path.join(dir,'cutouts'),`loop${index}_cutout`,true,{referenceSource:SOURCE,removed:removedEarlier});}
    catch(error){if(ahead)await ahead.result;throw error;}
    const layers=extracted.map((l,i)=>({...l,id:`loop_${String(index).padStart(2,'0')}_${l.id}`,name:`第 ${index-1} 轮 / ${plan.selected[i].description}`,depth:index}));
    const after=path.join(dir,'after.png');await fsp.copyFile(holes,after);
    const rear={after,assembly:FLOW},recomposed=path.join(dir,'recomposed.png');await fullComposite(after,layers,recomposed);
    const report={index,input,selected:plan.selected,deferred:plan.deferred,continuity:plan.continuity,geometry:plan.geometry,geometry_reference:SOURCE,detection_reuse:plan.detection_reuse,transition,layers,...rear,holes,holes_checker,recomposed,bbox_preview:path.join(dir,'selected_bbox.png'),report:path.join(dir,'report.json')};
    await refreshLoopPreviews(report);state.loops.push(report);await save();previous=report;
  }
  state.status='incomplete';state.stop_reason='diagnostic_round_limit';
  state.notice=`已达到本次测试的 ${maxRounds} 个图像轮上限，进度已保存；尚未确认只剩背景，也尚未导出最终 PSD。增加轮数上限后可从下一轮继续。`;
  state.ended_at=new Date().toISOString();await save();
  console.log(JSON.stringify({status:state.status,reason:state.stop_reason,output:OUT,visual_rounds:state.loops.length-1}));
  process.exitCode=2;
}
module.exports={orderLayers,correctedCanvas,readPsdPixels,retainedHints,verifyHoleTransition};
if(require.main===module)main().catch(async error=>{if(pendingDetection)await pendingDetection;state.status='failed';state.error=String(error.stack || error);state.ended_at=new Date().toISOString();await save();console.error(error.stack || error);process.exitCode=1;});
