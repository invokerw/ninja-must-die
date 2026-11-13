// Reposition returned wide strips from a completed run. No model requests.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),sharp=require('sharp');
const {splitWideSurface,splitWideModel,joinWideSurface}=require('./bbox_wide_surface.js');
const {exportPsd}=require('./layerforge.js');
const {readPsdPixels}=require('./bbox_recursive_test.js');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const write=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2)+'\n');
const hash=async f=>crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');
async function main(){
  const parent=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);assert.notEqual(parent,output);
  try{assert.equal((await fs.readdir(output)).length,0,'Output must be empty');}catch(e){if(e.code!=='ENOENT')throw e;}
  const started=new Date().toISOString(),state=await read(path.join(parent,'status.json'));
  assert.equal(state.status,'completed');
  const protectedFiles=['input.png','layers.psd','layers.json','recomposed.png','status.json','run_manifest.json'];
  const parentHashes=Object.fromEntries(await Promise.all(protectedFiles.map(async n=>[n,await hash(path.join(parent,n))])));
  const previous=await read(path.join(parent,'layers.json')),layers=[];
  await fs.mkdir(path.join(output,'code_snapshot'),{recursive:true});
  const code=[];
  for(const name of ['bbox_wide_surface_replay.js','bbox_wide_surface.js','bbox_model_rgba.js','bbox_recursive_test.js','bbox_recursive_core.js','layerforge.js']){
    await fs.copyFile(path.join(__dirname,name),path.join(output,'code_snapshot',name));code.push({name,sha256:await hash(path.join(__dirname,name))});
  }
  for(const name of ['input.png','fidelity_verification.json'])await fs.copyFile(path.join(parent,name),path.join(output,name));
  await fs.copyFile(path.join(parent,'recomposed.png'),path.join(output,'previous.png'));
  const replacements=[];
  for(const layer of previous){
    if(!layer.native_surface_pieces){layers.push(layer);continue;}
    const loop=state.loops.find(l=>l.layers.some(x=>x.id===layer.id));assert(loop);
    const selected=loop.selected[loop.layers.findIndex(x=>x.id===layer.id)];
    const model=layer.native_surface_pieces[0].model_generated_source;
    assert(layer.native_surface_pieces.every(p=>p.model_generated_source===model));
    const request=await read(path.join(path.dirname(model),'request.json'));
    const dir=path.join(output,'wide_surface');await fs.mkdir(dir,{recursive:true});
    const parts=await splitWideModel(model,splitWideSurface(selected),request.layout,path.join(dir,'pieces'));
    const joined=await joinWideSurface(selected,parts,path.join(dir,'surface.png'));
    const fresh={...layer,...joined,id:layer.id,name:layer.name,depth:layer.depth,z_index:layer.z_index,
      placement_replay:{parent_source:layer.source,method:'returned_wide_rows_without_alpha_padding',new_model_requests:0}};
    layers.push(fresh);replacements.push({id:layer.id,model,model_sha256:await hash(model),parts:joined.native_surface_pieces});
  }
  assert(replacements.length>0);
  const [width,height]=state.canvas,recomposed=path.join(output,'recomposed.png');
  await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(layers.map(l=>({input:l.source,left:l.bbox[0],top:l.bbox[1]}))).png().toFile(recomposed);
  await write(path.join(output,'layers.json'),layers);
  await exportPsd({canvas:{width,height},layers,text_layers:[]},path.join(output,'layers.psd'),recomposed);
  const psd=readPsdPixels(await fs.readFile(path.join(output,'layers.psd'))),pngs=[];
  assert.equal(psd.children.length,layers.length);assert.equal(psd.width,width);assert.equal(psd.height,height);
  for(let i=0;i<layers.length;i++){
    const actual=psd.children[i],expected=layers[i],raw=await sharp(expected.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.name,expected.name||expected.id);assert.equal(actual.left,expected.bbox[0]);assert.equal(actual.top,expected.bbox[1]);
    assert.equal(actual.imageData.width,raw.info.width);assert.equal(actual.imageData.height,raw.info.height);
    assert(Buffer.from(actual.imageData.data).equals(raw.data),'PSD RGBA mismatch '+expected.id);
    assert(!expected.model_placement||expected.model_placement.raster_scale.every(s=>s<=1));
    pngs.push({input:await sharp(Buffer.from(actual.imageData.data),{raw:{width:raw.info.width,height:raw.info.height,channels:4}}).png().toBuffer(),left:actual.left,top:actual.top});
  }
  const rebuilt=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(pngs).raw().toBuffer();
  assert(rebuilt.equals(await sharp(recomposed).ensureAlpha().raw().toBuffer()));
  for(const [name,digest] of Object.entries(parentHashes))assert.equal(await hash(path.join(parent,name)),digest,'Parent changed '+name);
  for(const r of replacements)assert.equal(await hash(r.model),r.model_sha256);
  const verification={status:'passed',canvas:state.canvas,layer_count:layers.length,replaced_placements:replacements.length,psd_layer_rgba_exact:true,psd_composite_exact:true,upscaled_layers:0,parent_and_model_returns_unchanged:true,new_model_requests:0};
  await write(path.join(output,'verification.json'),verification);
  const ended=new Date().toISOString(),elapsed=(Date.parse(ended)-Date.parse(started))/1000;
  const result={status:'completed',kind:'saved_wide_surface_placement_replay',parent,source_sha256:parentHashes['input.png'],started_at:started,ended_at:ended,elapsed_seconds:elapsed,
    generation_started_at:state.started_at,generation_ended_at:state.ended_at,generation_elapsed_seconds:(Date.parse(state.ended_at)-Date.parse(state.started_at))/1000,
    text_layers:state.loops[0].layers.length,visual_rounds:state.loops.length-1,layer_count:layers.length,new_model_requests:0,all_generation_from_this_fresh_parent:true,
    parent_hashes:parentHashes,replacements,code,model_output_policy:'model_rgba_downscale_only',rgb_recovery:false,alpha_recovery:false,
    visual_notes:['Returned wide strips were displaced beyond their requested atlas rows; their actual returned rows are now cropped and positioned.','The model still returned a thin hard top edge and a notch beneath Stage in the footer surface; these pixels are retained.','XP fill and container were detected as one target in this fresh run.']};
  await write(path.join(output,'run_manifest.json'),result);
  await write(path.join(output,'run_result.json'),{...result,psd:path.join(output,'layers.psd'),structural_verification:'passed'});
  const regions={left:[0,0,780,660],right:[2160,0,400,790],stage:[1980,970,580,470],footer:[0,1300,2560,140]};
  const detail=[];
  for(const [name,[left,top,w,h]] of Object.entries(regions)){
    for(const [i,file] of ['input.png','recomposed.png'].entries())await sharp(path.join(output,file)).extract({left,top,width:w,height:h}).png().toFile(path.join(output,`${name}_${i}.png`));
    detail.push(`<section><h2>${name}</h2><div class="row">${['原图','本次新生成'].map((label,i)=>`<figure><figcaption>${label}</figcaption><a href="${name}_${i}.png"><img src="${name}_${i}.png"></a></figure>`).join('')}</div></section>`);
  }
  await fs.writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全量重新生成：69 层 PSD</title><style>body{font:16px/1.6 system-ui;background:#101a27;color:#eef4fb;max-width:1120px;margin:auto;padding:24px}a{color:#8dcaff}.overlay{position:relative}.overlay img{display:block;width:100%;height:auto}.overlay img+img{position:absolute;left:0;top:0;opacity:.5}figure{margin:0;max-width:100%}figure img{max-width:100%;height:auto;display:block}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}section{padding:18px;margin:24px 0;background:#1d2c3e}</style><h1>全量重新生成结果</h1><p>${state.loops[0].layers.length} 个文字层、${layers.length-state.loops[0].layers.length-1} 个非文字层、1 个背景层，共 ${layers.length} 层；${state.loops.length-1} 个视觉轮。全量生成耗时 ${(result.generation_elapsed_seconds/60).toFixed(1)} 分钟（含接口重试）。</p><p>所有生成来自本次全新作业。随后仅修正底部通栏在返回图集中的裁切定位，新增生图请求 0 次。模型 RGB/alpha 直接保留，只裁切、缩小和定位。XP 填充与容器这次被识别为同一层。</p><p>仍可见的模型问题：底部通栏带有细上沿描边，以及 Stage 下方凹口；小地图局部笔触也与原图有差别。以下提供整图和原生局部对照。</p><p><a href="layers.psd">下载 PSD</a> · <a href="verification.json">PSD 验证</a> · <a href="run_manifest.json">生成与定位记录</a> · <a href="../${path.basename(parent)}/index.html">本次完整拆分过程与时间</a></p><div class="overlay"><img src="input.png"><img src="recomposed.png"></div><input type="range" min="0" max="100" value="50" style="width:100%" oninput="document.querySelector('.overlay img+img').style.opacity=this.value/100">${detail.join('')}</html>`);
  console.log(JSON.stringify({output,elapsed_seconds:elapsed,generation_elapsed_seconds:result.generation_elapsed_seconds,...verification}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
