// Correct grounded foreground dimensions from saved raw RGBA. No model calls.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {exportPsd}=require('./layerforge.js');
const {placeModelRgba}=require('./bbox_model_rgba.js');
const {readPsd,initializeCanvas}=require('ag-psd');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const write=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2)+'\n');
const hash=async f=>crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main(){
  if(!process.argv[2]||!process.argv[3])throw new Error('Usage: bbox_model_geometry_replay.js ITEM_RUN NEW_OUTPUT');
  const parent=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
  assert.notEqual(parent,output);
  try{assert.equal((await fs.readdir(output)).length,0,'Output must be empty');}catch(e){if(e.code!=='ENOENT')throw e;}
  const started=new Date().toISOString(),old=await read(path.join(parent,'candidate_layers.json'));
  const original=path.join(parent,'input.png'),previous=path.join(parent,'candidate_recomposed.png');
  const protectedNames=['layers.psd','candidate_layers.json','candidate_recomposed.png','input.png','experiment_manifest.json'];
  const parentHashes=Object.fromEntries(await Promise.all(protectedNames.map(async n=>[n,await hash(path.join(parent,n))])));
  const dimensions=await sharp(original).metadata(),width=dimensions.width,height=dimensions.height;
  await fs.mkdir(path.join(output,'layers'),{recursive:true});
  await fs.mkdir(path.join(output,'code_snapshot'),{recursive:true});
  const code=[];
  for(const file of ['bbox_model_geometry_replay.js','bbox_model_rgba.js','layerforge.js']){
    const source=path.join(__dirname,file);await fs.copyFile(source,path.join(output,'code_snapshot',file));code.push({file,sha256:await hash(source)});
  }
  const modelHashes={},changes=[],layers=[];
  for(const layer of old){
    if(!layer.material_experiment){layers.push(layer);continue;}
    const model=layer.model_generated_source;
    modelHashes[model]??=await hash(model);
    assert(layer.semantic_bbox&&layer.atlas_cell?.model_rect,'Missing original geometry or raw model crop: '+layer.id);
    const [left,top,rw,rh]=layer.atlas_cell.model_rect;
    const placed=await placeModelRgba(model,{left,top,width:rw,height:rh},layer.bbox,layer.semantic_bbox,false);
    const file=path.join(output,'layers',layer.id+'.png');await fs.writeFile(file,placed.buffer);
    const expected=layer.semantic_bbox.slice(2),actual=placed.placement.rendered_size;
    assert(placed.placement.raster_scale.every(s=>s<=1),'Upsampling is forbidden');
    if(!placed.placement.resolution_shortfall)assert.deepEqual(actual,expected,'Grounded source dimensions were not restored');
    const next={...layer,source:file,model_crop:file,model_rgba_source:file,model_placement:placed.placement,
      atlas_resize_scale:placed.placement.raster_scale,atlas_aspect_preserved:false,atlas_original_geometry_preserved:true,
      atlas_original_geometry_bbox:layer.semantic_bbox,atlas_source_bounds_fit:'original_bbox_ratio_downscale_only',
      geometry_correction:{kind:'original_target_ratio_downsample_only',previous_source:layer.source,previous_size:layer.model_placement.rendered_size,raw_model_sha256:modelHashes[model]}};
    layers.push(next);changes.push({id:layer.id,bbox:layer.bbox,original_target:layer.semantic_bbox,previous_size:layer.model_placement.rendered_size,
      corrected_size:actual,placement:placed.placement,raw_model:model,raw_model_sha256:modelHashes[model],source:file});
  }
  assert.equal(changes.length,old.filter(x=>x.material_experiment).length);
  const recomposed=path.join(output,'recomposed.png');
  await sharp({create:{width,height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers.map(x=>({input:x.source,left:x.bbox[0],top:x.bbox[1]}))).png().toFile(recomposed);
  await fs.copyFile(original,path.join(output,'input.png'));await fs.copyFile(previous,path.join(output,'previous.png'));
  await write(path.join(output,'layers.json'),layers);
  await exportPsd({canvas:{width,height},layers,text_layers:[]},path.join(output,'layers.psd'),recomposed);
  initializeCanvas(()=>{throw new Error('Unexpected canvas');},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
  const decoded=readPsd(await fs.readFile(path.join(output,'layers.psd')),{useImageData:true,skipThumbnail:true});
  assert.equal(decoded.width,width);assert.equal(decoded.height,height);assert.equal(decoded.children.length,layers.length);
  const decodedPngs=[];
  for(let i=0;i<layers.length;i++){
    const actual=decoded.children[i],expected=layers[i],png=await sharp(expected.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.name,expected.name||expected.id);assert.equal(actual.left,expected.bbox[0]);assert.equal(actual.top,expected.bbox[1]);
    assert.equal(actual.imageData.width,png.info.width);assert.equal(actual.imageData.height,png.info.height);
    assert(Buffer.from(actual.imageData.data).equals(png.data),'PSD RGBA mismatch: '+expected.id);
    decodedPngs.push({input:await sharp(Buffer.from(actual.imageData.data),{raw:{width:png.info.width,height:png.info.height,channels:4}}).png().toBuffer(),left:actual.left,top:actual.top});
  }
  const rebuilt=await sharp({create:{width,height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(decodedPngs).raw().toBuffer();
  assert(rebuilt.equals(await sharp(recomposed).ensureAlpha().raw().toBuffer()),'PSD composite mismatch');
  for(const [name,digest] of Object.entries(parentHashes))assert.equal(await hash(path.join(parent,name)),digest,'Parent changed: '+name);
  for(const [model,digest] of Object.entries(modelHashes))assert.equal(await hash(model),digest,'Raw model changed');
  const verification={status:'passed',canvas:[width,height],layer_count:layers.length,corrected_layers:changes.length,model_calls:0,
    psd_layer_rgba_exact:true,psd_composite_exact:true,original_target_sizes_restored:changes.filter(x=>!x.placement.resolution_shortfall).length,
    upscaled_layers:0,parent_unchanged:true,raw_models_unchanged:true,source_pixel_recovery:false,alpha_reconstruction:false,
    resolution_shortfalls:changes.filter(x=>x.placement.resolution_shortfall).map(x=>x.id),changes};
  await write(path.join(output,'verification.json'),verification);
  const rows=[],montages=[];
  for(let i=0;i<changes.length;i++){
    const c=changes[i],[left,top,w,h]=c.bbox,region={left,top,width:w,height:h},sources=[original,previous,recomposed],links=[];
    for(let j=0;j<sources.length;j++){
      const name=`item_${String(i+1).padStart(2,'0')}_${j}.png`;await sharp(sources[j]).extract(region).png().toFile(path.join(output,name));
      links.push(`<div><p>${['原图','上一版','尺寸修正'][j]}</p><img src="${name}" width="${w}" height="${h}"></div>`);
      montages.push({chunk:Math.floor(i/7),input:await sharp(path.join(output,name)).resize(140,128,{fit:'contain',withoutEnlargement:true,background:'#283548'}).png().toBuffer(),left:j*154,top:28+(i%7)*148});
    }
    rows.push(`<article><h3>${esc(c.id)}</h3><p>原图目标 ${c.original_target.slice(2).join(' × ')}；上一版 ${c.previous_size.join(' × ')}；修正后 ${c.corrected_size.join(' × ')}。原始模型像素缩小系数：${c.placement.raster_scale.map(x=>x.toFixed(4)).join(' / ')}。</p><div class="items">${links.join('')}</div></article>`);
  }
  const label=Buffer.from('<svg width="462" height="28"><text x="5" y="18" fill="white">Original</text><text x="159" y="18" fill="white">Previous</text><text x="313" y="18" fill="white">Geometry correction</text></svg>');
  for(let chunk=0;chunk<Math.ceil(changes.length/7);chunk++)await sharp({create:{width:462,height:28+Math.min(7,changes.length-chunk*7)*148,channels:4,background:'#172233'}}).composite([...montages.filter(x=>x.chunk===chunk).map(({chunk,...x})=>x),{input:label,left:0,top:0}]).png().toFile(path.join(output,`comparison_${chunk+1}.png`));
  const ended=new Date().toISOString();
  await write(path.join(output,'run_manifest.json'),{status:'completed',kind:'saved_raw_rgba_geometry_correction',started_at:started,ended_at:ended,elapsed_seconds:(Date.parse(ended)-Date.parse(started))/1000,
    derived_from:{output:parent,parent_hashes:parentHashes},source_sha256:await hash(original),model_calls:0,layer_count:layers.length,corrected_item_layers:changes.length,code,
    scope:'Grounded original target width/height restored by separate per-axis downsampling of saved raw model crops. Other layers are reused. Model-internal redraw differences are not corrected.'});
  await fs.writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Icon 尺寸修正</title><style>body{font:16px/1.6 system-ui;background:#101a27;color:#eef4fb;max-width:1100px;margin:auto;padding:24px}a{color:#8dcaff}button{margin-right:12px;padding:8px}.overlay{position:relative}.overlay img{display:block;width:100%;height:auto}.overlay #corrected{position:absolute;left:0;top:0;opacity:.5}.items{display:flex;gap:24px;flex-wrap:wrap;align-items:center}.items img{max-width:100%;height:auto}article{background:#1d2c3e;padding:16px;margin:20px 0}</style><h1>Icon 宽高修正：原图 / 上一版 / 新版</h1><p>复用原始模型 RGBA，修正 ${changes.length} 个 item 的宽高，0 次新生图。横纵方向分别缩小到原图目标边界，均不放大；没有原像素替换、锐化或 alpha 重算。最终 ${layers.length} 层，PSD 读回通过。</p><p><a href="layers.psd">下载修正 PSD</a> · <a href="recomposed.png">新版整图</a> · <a href="verification.json">尺寸和 PSD 校验</a> · <a href="run_manifest.json">运行记录</a></p><p><button id="show-original" onclick="document.getElementById('base').src='input.png'">与原图比较</button><button id="show-previous" onclick="document.getElementById('base').src='previous.png'">与上一版比较</button></p><div class="overlay"><img id="base" src="input.png"><img id="corrected" src="recomposed.png"></div><input id="compare-slider" style="width:100%" type="range" min="0" max="100" value="50" oninput="document.getElementById('corrected').style.opacity=this.value/100"><p>滑块左端是原图或上一版，右端是新版；只改变叠加透明度。下方局部以原生像素显示。模型内部的形状、材质和高光重绘差异仍可能存在。</p>${rows.join('')}</html>`);
  console.log(JSON.stringify({status:'completed',output,elapsed_seconds:(Date.parse(ended)-Date.parse(started))/1000,layer_count:layers.length,corrected_items:changes.length,model_calls:0,verification:'passed'}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
