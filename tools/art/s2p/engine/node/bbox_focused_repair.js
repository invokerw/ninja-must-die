const {modelFor,qualityFor,getRoute}=require('./model_config.js');
// A bounded, explicit repair of saved layers. Preserve the original run.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {layoutFor}=require('./bbox_two_loop_test.js');
const {createCore}=require('./bbox_recursive_core.js');
const {imageRequest}=require('./bbox_image_requests.js');
const {orderRepairedLayers}=require('./bbox_repair_order.js');
const {exportPsd,splitSeedreamAtlasModel}=require('./layerforge.js');
const {readPsd,initializeCanvas}=require('ag-psd');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const write=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2)+'\n');
const hash=async f=>crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const intersection=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
async function originalState(parent){
  const seen=new Set();let directory=parent;
  while(!seen.has(directory)){
    seen.add(directory);
    const file=path.join(directory,'status.json');
    try{return {state:await read(file),file,sha256:await hash(file)};}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const manifest=await read(path.join(directory,'run_manifest.json'));
    assert(manifest.parent,'No original loop state in repair ancestry: '+directory);
    directory=path.resolve(directory,manifest.parent);
  }
  throw new Error('Cycle in repair ancestry');
}
async function main(){
  assert(process.argv.length>=5,'Usage: bbox_focused_repair.js PARENT SPEC NEW_OUTPUT');
  const parent=path.resolve(process.argv[2]),specFile=path.resolve(process.argv[3]),output=path.resolve(process.argv[4]);
  assert.notEqual(parent,output);
  try{assert.equal((await fs.readdir(output)).length,0,'Output must be empty');}catch(e){if(e.code!=='ENOENT')throw e;}
  const ancestry=await originalState(parent),state=ancestry.state,old=await read(path.join(parent,'layers.json')),spec=await read(specFile);
  assert.equal(state.status,'completed');assert(spec.groups.length>0);
  // A complete replacement can supersede previously separated fragments.
  // Drop them only after successful generation of the named replacement.
  const removals=spec.remove_layers||[],removedIds=new Set(),requestedIds=new Set(spec.groups.flatMap(group=>group.targets.map(target=>target.layer_id)));
  assert(Array.isArray(removals),'remove_layers must be an array');
  for(const removal of removals){
    assert(old.some(layer=>layer.id===removal.layer_id),'Unknown removed layer '+removal.layer_id);
    assert(!removedIds.has(removal.layer_id)&&!requestedIds.has(removal.layer_id),'Removed layer must be unique and cannot be a repair target');
    assert(requestedIds.has(removal.replaced_by_layer_id),'Removed fragment requires a requested complete replacement');
    assert(typeof removal.reason==='string'&&removal.reason.trim(),'Record why the fragment is superseded');
    removedIds.add(removal.layer_id);
  }
  const started=new Date().toISOString(),[width,height]=state.canvas;
  const source=path.join(parent,'input.png');
  assert.equal(await hash(source),await hash(state.source),'Parent and original loop sources differ');
  const title=spec.title||'局部图层修复',description=spec.description||'按指定范围修复图层，保留其他图层。';
  const protectedFiles=['input.png','layers.psd','layers.json','recomposed.png','run_manifest.json'];
  for(const optional of ['status.json','repair_status.json']){
    try{await fs.access(path.join(parent,optional));protectedFiles.push(optional);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const parentHashes=Object.fromEntries(await Promise.all(protectedFiles.map(async n=>[n,await hash(path.join(parent,n))])));
  await fs.mkdir(path.join(output,'code_snapshot'),{recursive:true});
  const snapshots=[];
  for(const name of ['bbox_focused_repair.js','bbox_repair_order.js','bbox_model_rgba.js','bbox_visual_atlas.js','bbox_text_atlas.js','bbox_recursive_core.js','bbox_two_loop_test.js','bbox_atlas_pixels.js','bbox_image_requests.js','layerforge.js']){
    const source=path.join(__dirname,name);await fs.copyFile(source,path.join(output,'code_snapshot',name));snapshots.push({name,sha256:await hash(source)});
  }
  await fs.copyFile(specFile,path.join(output,'repair_spec.json'));
  await fs.copyFile(path.join(parent,'input.png'),path.join(output,'input.png'));
  await fs.copyFile(path.join(parent,'recomposed.png'),path.join(output,'previous.png'));
  const progress=[];
  let progressWrites=Promise.resolve();
  const saveProgress=()=>progressWrites=progressWrites.then(async()=>{
    await write(path.join(output,'repair_status.json'),{status:'running',started_at:started,steps:progress});
    await fs.writeFile(path.join(output,'index.html'),`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="15"><h1>${esc(title)}正在运行</h1><p>开始：${started}</p><pre>${esc(JSON.stringify(progress,null,2))}</pre>`);
  });
  const core=createCore({state:{source,canvas:state.canvas,loops:[]},step:async(_id,_title,work)=>work()});
  const groups=spec.groups.map((group,gi)=>{
    const records=[];
    for(const target of group.targets){
      const previous=old.find(x=>x.id===target.layer_id);assert(previous,'Unknown layer '+target.layer_id);
      const loop=state.loops.find(l=>l.layers.some(x=>x.id===previous.id));assert(loop);
      const selected=loop.selected[loop.layers.findIndex(x=>x.id===previous.id)];
      const semantic=target.semantic_bbox||previous.semantic_bbox||selected.source_bbox||selected.bbox;
      const count=target.horizontal_pieces||1;assert(Number.isInteger(count)&&count>=1&&count<=7);
      for(let part=0;part<count;part++){
        const left=semantic[0]+Math.floor(semantic[2]*part/count),right=semantic[0]+Math.floor(semantic[2]*(part+1)/count);
        const sourceBBox=[left,semantic[1],right-left,semantic[3]];
        const pad=6,x=Math.max(0,left-pad),y=Math.max(0,semantic[1]-pad),r=Math.min(width,right+pad),b=Math.min(height,semantic[1]+semantic[3]+pad);
        // Shared half boundary has no contextual overlap: returned pieces meet
        // at the original native boundary, without synthesized seam blending.
        const box={...selected,id:`g${gi+1}_${records.length+1}`,bbox:[x,y,r-x,b-y],source_bbox:sourceBBox,
          description:target.description||selected.description,preserve_model_aspect:target.preserve_model_aspect===true};
        records.push({previous,loop,box,target,part,count});
      }
    }
    assert(records.length<=7,'Each atlas is limited to seven targets');
    return {group,records,index:gi+1};
  });
  await write(path.join(output,'run_manifest.json'),{status:'running',kind:'bounded_saved_layer_repair',started_at:started,parent,parent_hashes:parentHashes,
    original_loop_state:{file:ancestry.file,sha256:ancestry.sha256},layer_list_source:path.join(parent,'layers.json'),
    source_sha256:await hash(path.join(parent,'input.png')),model:modelFor('background'),quality:qualityFor('background'),new_atlas_requests:groups.length,
    target_pieces:groups.reduce((n,g)=>n+g.records.length,0),removed_fragments:removals,quality_attempts_per_target:1,source_pixel_recovery:false,alpha_reconstruction:false,code:snapshots});
  await saveProgress();
  const results=await Promise.allSettled(groups.map(async({group,records,index})=>{
    const dir=path.join(output,`batch_${String(index).padStart(2,'0')}`);await fs.mkdir(dir,{recursive:true});
    const boxes=records.map(r=>r.box);
    let layout=layoutFor(boxes);
    if(group.native_wide_rows){
      const scale=1.45,pad=28,gap=24,maxWidth=Math.max(...boxes.map(b=>Math.round(b.bbox[2]*scale)))+pad*2;
      let y=0;const cells=boxes.map((box,i)=>{const cw=Math.round(box.bbox[2]*scale),ch=Math.round(box.bbox[3]*scale),cell={index:i+1,x:0,y,width:maxWidth,height:ch+pad*2,crop_x:pad,crop_y:pad,crop_width:cw,crop_height:ch,native_width:box.bbox[2],native_height:box.bbox[3],input_scale:scale};y+=cell.height+gap;return cell;});
      layout={fits:true,width:Math.ceil(maxWidth/16)*16,height:Math.max(1024,Math.ceil((y-gap)/16)*16),cells,input_scale:scale,packing:'native_wide_rows'};
      assert(layout.width<=2048&&layout.height<=2048);
    }
    await core.atlasInputs(source,boxes,layout,dir,'original_');
    const current=await Promise.all(records.map(async(record,i)=>{
      const [left,top,w,h]=record.box.bbox,c=layout.cells[i];
      return {input:await sharp(record.loop.input).extract({left,top,width:w,height:h}).resize(c.crop_width,c.crop_height,{fit:'fill'}).png().toBuffer(),left:c.x+c.crop_x,top:c.y+c.crop_y};
    }));
    const currentPath=path.join(dir,'current.png');
    await sharp({create:{width:layout.width,height:layout.height,channels:4,background:'#00000000'}}).composite(current).png().toFile(currentPath);
    const targets=records.map((record,i)=>{
      const c=layout.cells[i];return {cell:i+1,id:record.box.id,role:record.target.role||(['panel','button'].includes(record.box.category)?'surface_only':'foreground_object_only'),
        rect:[c.x+c.crop_x,c.y+c.crop_y,c.crop_width,c.crop_height],source_bbox:record.box.bbox,target_bbox:record.box.source_bbox,
        description:record.box.description,instruction:record.target.instruction,geometry_anchor:record.target.geometry_anchor||null,
        horizontal_piece:record.count>1?{index:record.part+1,total:record.count}:null,
        exclude:state.loops.filter(l=>l.index<record.loop.index).flatMap(l=>l.selected).filter(x=>intersection(x.bbox,record.box.bbox)).map(x=>x.description)};
    });
    const prompt=`Return one transparent ${layout.width}x${layout.height} RGBA PNG in the EXACT atlas cell order and coordinates. Image 1 is ORIGINAL unmarked pixels: authoritative for shape, material, small detail and component layout. Image 2 is the matching current crop atlas: use its transparent holes only for removed-foreground ownership, not as object boundaries. Isolate only the named targets. Complete only genuinely occluded parts. Preserve reference pixel appearance, gradients, relative component sizes, positions, original exposure and anti-aliasing. Do not redesign or enlarge the objects. Leave all unrequested neighbors, text, icons and deeper background at alpha=0. Keep explicitly requested functional symbols such as plus signs and progress dividers. Do not add frames, black outlines, rectangular mats, checkerboard or annotations. A surface stays continuous and its original opacity through deletion holes. For each requested borderless surface preserve the colored fill, shading and shape but remove black/dark perimeter stroke and duplicate inner/outer outlines; do not replace them with a light stroke. Preserve the outlines of actual icon artwork. Do not move or normalize components. Native geometry anchors are source-image pixel coordinates; map them into the assigned source_bbox and atlas rect. For horizontally adjacent pieces of the same wide surface, output matching continuous fill/opacity, no seam, border, cap, bevel or fade at the shared edge. Targets:${JSON.stringify(targets)}`;
    const images=[path.join(dir,'original_input.png'),currentPath],model=path.join(dir,'model.png');
    await write(path.join(dir,'request.json'),{model:modelFor('background'),quality:qualityFor('background'),layout,targets,image_paths:images,prompt});
    const step={batch:index,targets:records.length,status:'running',started_at:new Date().toISOString()};progress.push(step);await saveProgress();
    console.log(JSON.stringify({stage:'focused_repair_generation',batch:index,targets:records.length,canvas:[layout.width,layout.height]}));
    await imageRequest(images[0],model,prompt,modelFor('background'),null,undefined,{provider:'openai',clientKind:'background-repair',imagePaths:images,background:'transparent',quality:qualityFor('background'),size:`${layout.width}x${layout.height}`,resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,responseMetadataPath:path.join(dir,'response_geometry.json')});
    const split=await splitSeedreamAtlasModel({source,boxes,modelOutput:model,batchDir:dir,layout,model:modelFor('background'),batchIndex:index,preserveAspectRatio:true,preserveSourceBounds:true});
    split.layers.forEach(layer=>assert(layer.model_placement.raster_scale.every(s=>s<=1)));
    step.status='completed';step.ended_at=new Date().toISOString();await saveProgress();
    console.log(JSON.stringify({stage:'focused_repair_batch_complete',batch:index}));
    return records.map((record,i)=>({...record,fresh:split.layers[i]}));
  }));
  const failures=results.filter(x=>x.status==='rejected');assert.equal(failures.length,0,failures.map(x=>x.reason?.stack||String(x.reason)).join('\n'));
  const records=results.flatMap(x=>x.value),replacement=new Map();
  await fs.mkdir(path.join(output,'layers'),{recursive:true});
  for(const record of records){
    if(replacement.has(record.previous.id))continue;
    const pieces=records.filter(x=>x.previous.id===record.previous.id),oldLayer=record.previous;
    if(pieces.length===1){replacement.set(oldLayer.id,{...oldLayer,...record.fresh,id:oldLayer.id,name:oldLayer.name,depth:oldLayer.depth,z_index:oldLayer.z_index,
      focused_repair:{previous_source:oldLayer.source,attempts:1,instruction:record.target.instruction}});continue;}
    const [x,y,w,h]=oldLayer.bbox;
    const source=path.join(output,'layers',oldLayer.id+'.png');
    // Copy downsampled returned RGBA into disjoint native strips. No seam
    // blending, alpha cleanup, source-pixel replacement, or upsampling.
    const canvas=Buffer.alloc(w*h*4);
    for(const piece of pieces){
      const raw=await sharp(piece.fresh.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const [sx,sy,sw,sh]=piece.box.source_bbox,[bx,by]=piece.fresh.bbox;
      for(let row=0;row<sh;row++)raw.data.copy(canvas,((sy-y+row)*w+sx-x)*4,((sy-by+row)*raw.info.width+sx-bx)*4,((sy-by+row)*raw.info.width+sx-bx+sw)*4);
    }
    await sharp(canvas,{raw:{width:w,height:h,channels:4}}).png().toFile(source);
    const {model_placement,model_generated_source,model_crop,atlas_cell,atlas_resize_scale,...rest}=oldLayer;
    replacement.set(oldLayer.id,{...rest,source,focused_repair:{previous_source:oldLayer.source,attempts:1,instruction:record.target.instruction,pieces:pieces.map(p=>({source:p.fresh.source,bbox:p.box.source_bbox,model:p.fresh.model_generated_source,placement:p.fresh.model_placement}))}});
  }
  const constraints=records.filter(r=>r.target.behind_layer_ids?.length).map(r=>({id:r.previous.id,behind:r.target.behind_layer_ids}));
  for(const removal of removals)assert(replacement.has(removal.replaced_by_layer_id),'Missing successful replacement for removed fragment');
  const layers=orderRepairedLayers(old.filter(layer=>!removedIds.has(layer.id)).map(l=>replacement.get(l.id)||l),constraints),recomposed=path.join(output,'recomposed.png');
  await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(layers.map(l=>({input:l.source,left:l.bbox[0],top:l.bbox[1]}))).png().toFile(recomposed);
  await write(path.join(output,'layers.json'),layers);
  await exportPsd({canvas:{width,height},layers,text_layers:[]},path.join(output,'layers.psd'),recomposed);
  initializeCanvas(()=>{throw new Error('Unexpected canvas');},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
  const decoded=readPsd(await fs.readFile(path.join(output,'layers.psd')),{useImageData:true,skipThumbnail:true});
  assert.equal(decoded.children.length,layers.length);assert.equal(decoded.width,width);assert.equal(decoded.height,height);
  const pngs=[];
  for(let i=0;i<layers.length;i++){
    const actual=decoded.children[i],expected=layers[i],raw=await sharp(expected.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.name,expected.name||expected.id);assert.equal(actual.left,expected.bbox[0]);assert.equal(actual.top,expected.bbox[1]);
    assert.equal(actual.imageData.width,raw.info.width);assert.equal(actual.imageData.height,raw.info.height);
    assert(Buffer.from(actual.imageData.data).equals(raw.data),'PSD RGBA mismatch '+expected.id);
    pngs.push({input:await sharp(Buffer.from(actual.imageData.data),{raw:{width:raw.info.width,height:raw.info.height,channels:4}}).png().toBuffer(),left:actual.left,top:actual.top});
  }
  const rebuilt=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(pngs).raw().toBuffer();
  assert(rebuilt.equals(await sharp(recomposed).ensureAlpha().raw().toBuffer()),'PSD composite mismatch');
  for(const [file,digest] of Object.entries(parentHashes))assert.equal(await hash(path.join(parent,file)),digest,'Parent changed: '+file);
  assert.equal(await hash(ancestry.file),ancestry.sha256,'Original loop state changed');
  const shortfalls=records.filter(r=>r.fresh.model_placement.resolution_shortfall).map(r=>r.previous.id);
  const verification={status:'passed',canvas:[width,height],layer_count:layers.length,replaced_layers:replacement.size,new_image_requests:groups.length,
    psd_layer_rgba_exact:true,psd_composite_exact:true,upscaled_layers:0,parent_unchanged:true,resolution_shortfalls:shortfalls,depth_constraints:constraints,removed_fragments:removals,
    scope:'Structure and downsampling verified. Source-pixel fidelity and perfect model redraw are not claimed.'};
  await write(path.join(output,'verification.json'),verification);
  const detail=[];
  for(const [name,region] of Object.entries(spec.review_regions)){
    const [left,top,w,h]=region;
    for(const [i,file] of ['input.png','previous.png','recomposed.png'].entries())await sharp(path.join(output,file)).extract({left,top,width:w,height:h}).png().toFile(path.join(output,`${name}_${i}.png`));
    detail.push(`<section><h2>${esc(name)}</h2><div class="row">${['原图','上一版','修复版'].map((label,i)=>`<figure><figcaption>${label}</figcaption><a href="${name}_${i}.png"><img src="${name}_${i}.png"></a></figure>`).join('')}</div></section>`);
  }
  const ended=new Date().toISOString(),elapsed=(Date.parse(ended)-Date.parse(started))/1000;
  const manifest=await read(path.join(output,'run_manifest.json'));await write(path.join(output,'run_manifest.json'),{...manifest,status:'completed',ended_at:ended,elapsed_seconds:elapsed,replaced_layers:replacement.size,reused_layers:layers.length-replacement.size,parent_unchanged:true,resolution_shortfalls:shortfalls});
  await write(path.join(output,'repair_status.json'),{status:'completed',started_at:started,ended_at:ended,elapsed_seconds:elapsed,steps:progress});
  await fs.writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui;background:#101a27;color:#eef4fb;max-width:1120px;margin:auto;padding:24px}a{color:#8dcaff}button{padding:8px;margin-right:10px}.overlay{position:relative}.overlay img{display:block;width:100%;height:auto}.overlay #corrected{position:absolute;left:0;top:0;opacity:.5}.row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}figure{margin:0;max-width:100%}figure img{display:block;max-width:100%;height:auto}section{margin:30px 0;padding:18px;background:#1d2c3e}</style><h1>${esc(title)}</h1><p>替换 ${replacement.size} 个图层，复用 ${layers.length-replacement.size} 个图层，最终 ${layers.length} 层。新增 ${groups.length} 张图集，耗时 ${elapsed.toFixed(1)} 秒。每个目标只生成一次，直接保留模型 RGB/alpha，仅裁切、缩小和定位。${shortfalls.length?'存在模型分辨率不足，请查看验证记录。':'本次返回分辨率均足够，无放大。'}</p><p>${esc(description)}</p><p><a href="layers.psd">下载 PSD</a> · <a href="verification.json">PSD 校验</a> · <a href="run_manifest.json">运行记录</a> · <a href="repair_spec.json">修复范围</a></p><p><button id="show-original" onclick="document.getElementById('base').src='input.png'">与原图比较</button><button id="show-previous" onclick="document.getElementById('base').src='previous.png'">与上一版比较</button></p><div class="overlay"><img id="base" src="input.png"><img id="corrected" src="recomposed.png"></div><input id="compare-slider" style="width:100%" type="range" min="0" max="100" value="50" oninput="document.getElementById('corrected').style.opacity=this.value/100">${detail.join('')}</html>`);
  console.log(JSON.stringify({status:'completed',output,elapsed_seconds:elapsed,...verification}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
