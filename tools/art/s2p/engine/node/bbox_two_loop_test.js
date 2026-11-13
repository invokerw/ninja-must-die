#!/usr/bin/env node
const {modelFor,qualityFor,getRoute}=require('./model_config.js');
// Local experiment only. Does not change the default web/PSD workflow.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { jsonrepair } = require('jsonrepair');
const { openaiClient, imageEdit, splitSeedreamAtlasModel } = require('./layerforge.js');
const { groupCoupledRearCandidates } = require('./rear_coupled_composites.js');
const { imageKey, deleteBboxes, fixedAtlasTile, sceneAtlasTile, fillMissingPixels, alphaStats } = require('./bbox_atlas_pixels.js');

const MODEL = modelFor('background');
const CONTROLLER = modelFor('controller');
const BATCH = 7, PAD = 16, GAP = 24;
const SOURCE = path.resolve(__dirname, '../../../20260827-204428.png');
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '../../../web_runs/bbox-two-loop-20261012'));
const statePath = path.join(OUT, 'status.json');
let state = { source: SOURCE, model: MODEL, quality: qualityFor('background'), batch_size: BATCH, steps: [] };
let queue = Promise.resolve();

const overlap = (a, b) => Math.max(0, Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])) *
  Math.max(0, Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
const union = boxes => {
  const x = Math.min(...boxes.map(b=>b[0])), y = Math.min(...boxes.map(b=>b[1]));
  return [x,y,Math.max(...boxes.map(b=>b[0]+b[2]))-x,Math.max(...boxes.map(b=>b[1]+b[3]))-y];
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const relative = file => path.relative(OUT, file).split(path.sep).join('/');
const read = file => fsp.readFile(file,'utf8').then(JSON.parse);
const write = (file, value) => fsp.writeFile(file, JSON.stringify(value,null,2)+'\n','utf8');

async function save() {
  queue = queue.then(async()=>{ await write(statePath,state); await page(); });
  await queue;
}
async function step(id, title, worker) {
  const entry = { id, title, status:'running', started_at:new Date().toISOString() };
  state.steps.push(entry); await save();
  console.log(JSON.stringify({stage:id,status:'running',started_at:entry.started_at}));
  const timer = setInterval(()=>console.log(JSON.stringify({stage:id,status:'running',elapsed_s:Math.round((Date.now()-Date.parse(entry.started_at))/1000)})),30000);
  try { const result = await worker(); entry.status='completed'; return result; }
  catch(error) { entry.status='failed'; entry.error=String(error.message||error); throw error; }
  finally { clearInterval(timer); entry.ended_at=new Date().toISOString(); entry.elapsed_ms=Date.parse(entry.ended_at)-Date.parse(entry.started_at); await save(); console.log(JSON.stringify(entry)); }
}

async function checker(input, output) {
  const {width,height}=await sharp(input).metadata(), pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const color=(Math.floor(x/24)+Math.floor(y/24))%2?225:245;
    pixels.fill(color,(y*width+x)*3,(y*width+x)*3+3);
  }
  await sharp(pixels,{raw:{width,height,channels:3}}).composite([{input}]).png().toFile(output);
}
async function bboxPreview(source, boxes, output) {
  const {width,height}=await sharp(source).metadata(), raw=Buffer.alloc(width*height*4);
  for(const box of boxes) {
    const [x,y,w,h]=box.bbox;
    for(let t=0;t<3;t++) {
      const pixel=(px,py)=>{if(px<0||py<0||px>=width||py>=height)return; const o=(py*width+px)*4;raw[o]=255;raw[o+1]=65;raw[o+2]=105;raw[o+3]=255;};
      for(let px=x;px<x+w;px++){pixel(px,y+t);pixel(px,y+h-1-t);}
      for(let py=y;py<y+h;py++){pixel(x+t,py);pixel(x+w-1-t,py);}
    }
  }
  const lines=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer();
  await sharp(source).composite([{input:lines}]).png().toFile(output);
}

async function ask(images, prompt, dir, maxTokens=16384) {
  await fsp.mkdir(dir,{recursive:true});
  const requestPath=path.join(dir,'request.json'),responsePath=path.join(dir,'response.json');
  const cacheKey=await imageKey(images,{model:CONTROLLER,prompt,maxTokens});
  if(fs.existsSync(requestPath)&&fs.existsSync(responsePath)) {
    const previousRequest=await read(requestPath),previousResponse=await read(responsePath);
    if(previousRequest.cache_key===cacheKey && previousResponse.cache_key===cacheKey && previousResponse.finish_reason!=='length' && previousResponse.content)
      return JSON.parse(jsonrepair(previousResponse.content));
  }
  await write(requestPath,{model:CONTROLLER,images,prompt,max_completion_tokens:maxTokens,cache_key:cacheKey});
  const start=Date.now();
  const response=await openaiClient('controller').chat.completions.create({model:CONTROLLER,
    max_completion_tokens:maxTokens,response_format:{type:'json_object'},messages:[{role:'user',content:[
      ...images.map(image=>({type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(image).toString('base64'),detail:'high'}})),
      {type:'text',text:prompt}]}]});
  const content=String(response.choices?.[0]?.message?.content||'');
  await write(path.join(dir,'response.json'),{content,cache_key:cacheKey,usage:response.usage,finish_reason:response.choices?.[0]?.finish_reason,elapsed_ms:Date.now()-start});
  assert.notEqual(response.choices?.[0]?.finish_reason,'length','Controller output was truncated');
  return JSON.parse(jsonrepair(content));
}

function regions(width,height) {
  return Array.from({length:6},(_,i)=>{
    const col=i%3,row=Math.floor(i/3), x0=Math.floor(col*width/3),x1=Math.floor((col+1)*width/3);
    const y0=Math.floor(row*height/2),y1=Math.floor((row+1)*height/2), guard=80;
    const left=Math.max(0,x0-guard),top=Math.max(0,y0-guard),right=Math.min(width,x1+guard),bottom=Math.min(height,y1+guard);
    return {id:'roi_'+(i+1),core:[x0,y0,x1-x0,y1-y0],crop:{left,top,width:right-left,height:bottom-top}};
  });
}

async function detect(source, dir, mode, removed=[]) {
  const {width,height}=await sharp(source).metadata();
  const results=await Promise.allSettled(regions(width,height).map(async region=>{
    const target=path.join(dir,'detection',region.id);await fsp.mkdir(target,{recursive:true});
    const crop=path.join(target,'input.png');await sharp(source).extract(region.crop).png().toFile(crop);
    const image=path.join(target,'checker.png');await checker(crop,image);
    const common=`Image 1 is a local enlarged crop of Image 2, the whole current scene. Gray/white checkerboard in Image 1 represents transparent EMPTY pixels. Locate targets against ACTUAL colored pixels, not transparent holes. Return coordinates ONLY in normalized yxyx_1000 of Image 1: [y_min,x_min,y_max,x_max]. Cover the COMPLETE visible extent and its own antialiasing, outline and glow, with 2 source-pixel safety margin; do not clip protrusions. Never report source pixels or whole-scene normalized coordinates. Include an object crossing a crop edge only if you can locate its FULL extent inside Image 1. No environmental scenery targets, no full-screen background. IDs must be short ASCII snake_case. Return JSON {"coordinate_space":"yxyx_1000","elements":[{"id":"unique","category":"text/icon/button/panel/decoration","description":"actual appearance, target only","box":[y0,x0,y1,x1],"occluded_by":["ids from this response"],"members":[],"internal_front_to_back":[]}]}.
`;
    const task=mode==='text'
      ? `Find EVERY ordinary UI text label and number, including values on badges, short navigation captions, resource counters and independent titles. Each line is one category=text target containing ONLY glyphs and their outlines/shadows, never its icon or backplate. Numeric glyphs inside shield/coin/circle artwork are removable ordinary text. Keep fused non-readable emblem artwork. Non-text elements must not be returned. All text is frontmost, occluded_by=[]; members=[]; internal_front_to_back=[].`
      : `Find all independently editable surviving non-text UI objects, both current frontmost targets and immediately visible deeper surfaces. Independently bounded artwork, badges, controls and backplates have separate targets; a panel surface waits behind every visible icon covering it. Record actual direct blockers in occluded_by. CURRENT FRONTMOST bbox rectangles must not overlap each other; do not truncate any object's full bbox to force this. Important coupled-composite exception: a translucent circular glow/ring overlapping a map/illustration in the same control MUST be ONE target bbox covering BOTH full extents, with members naming ring and artwork, internal_front_to_back=["ring","artwork"]. Keep the luminous ring composited ABOVE the map wherever they intersect; never put the map on top of the ring. The control backplate remains a separate deeper target. Any independently visible foreground prop in front of this composite stays separate, and the composite is deferred behind that prop. Do not return separate ring or map targets in addition to this composite. Ring geometry must remain circular with its observed center and radius. Ordinary readable text has been removed; do not invent or box empty text positions. Removed earlier targets must stay absent: ${JSON.stringify(removed.map(x=>({id:x.id,description:x.description})))}.`;
    const parsed=await ask([image,source],common+task,target);
    assert.equal(parsed.coordinate_space,'yxyx_1000');
    const entries=parsed.elements.map(el=>{
      const [y0,x0,y1,x1]=el.box;assert(x1>x0&&y1>y0&&x0>=0&&y0>=0&&x1<=1000&&y1<=1000,'Invalid normalized bbox');
      const x=region.crop.left+Math.floor(x0*region.crop.width/1000),y=region.crop.top+Math.floor(y0*region.crop.height/1000);
      const right=region.crop.left+Math.ceil(x1*region.crop.width/1000),bottom=region.crop.top+Math.ceil(y1*region.crop.height/1000);
      return {...el,id:region.id+'_'+el.id,occluded_by:(el.occluded_by||[]).map(id=>region.id+'_'+id),bbox:[x,y,right-x,bottom-y]};
    });
    return entries.filter(el=>{const cx=el.bbox[0]+el.bbox[2]/2,cy=el.bbox[1]+el.bbox[3]/2;const [x,y,w,h]=region.core;return cx>=x&&cx<x+w&&cy>=y&&cy<y+h;});
  }));
  const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new Error(failures.map(result=>String(result.reason)).join('\n'));
  const rawElements=results.flatMap(result=>result.value);
  const elements=mode==='text'?rawElements:groupCoupledRearCandidates(rawElements);
  assert(elements.length>0,'No targets detected');
  const plan={source,canvas:[width,height],mode,elements,selected:elements,deferred:[],conflicts:[]};
  await write(path.join(dir,'plan_raw.json'),plan);
  if(mode==='text') {
    plan.elements=elements.filter(el=>el.category==='text');plan.selected=plan.elements;
  } else {
    const reviewImage=path.join(dir,'candidate_bbox.png');await bboxPreview(source,elements,reviewImage);
    const numberById=new Map(elements.map((el,i)=>[el.id,i+1]));
    const table=elements.map((el,i)=>[i+1,el.description,el.bbox,(el.occluded_by||[]).map(id=>numberById.get(id)).filter(Boolean)]);
    const pairs=[];for(let i=0;i<elements.length;i++)for(let j=i+1;j<elements.length;j++)if(overlap(elements[i].bbox,elements[j].bbox))pairs.push([i+1,j+1]);
    const prompt=`Audit ONLY front/behind relationships of these existing UI candidate bboxes in the attached current scene. Return a very short table, no discovery, descriptions or coordinates. Candidate tuples are [number,appearance,originalXYWH,priorBlockerNumbers]. Preserve every candidate and its full bbox. Decide which candidate is in FRONT from visible RGB crossing edges. A child icon lies in front of its backplate; a shield overlapping a progress fill lies in front of that fill. A translucent circular ring crossing map artwork is already ONE coupled composite with the ring ABOVE the map; keep it intact, behind any independent foreground prop and in front of its button backplate. Removed content is absent as transparent holes; do not treat a hole as an object. For every intersecting bbox pair listed below, at least one target must have a blocker so both cannot be frontmost in this pass. Do not assign cycles. Inspect the scene once and immediately return JSON {"items":[[candidateNumber,[directBlockerNumbers]]]} with exactly one entry for each of ${elements.length} candidates, including [] for uncovered ones. Only numbers, no prose. Candidates:${JSON.stringify(table)}. Intersecting bbox pairs:${JSON.stringify(pairs)}.`;
    const reviewed=await ask([source],prompt,path.join(dir,'compact_depth_review'),8192);
    assert.equal(reviewed.items.length,elements.length,'Missing candidates in compact depth audit');
    const relations=new Map(reviewed.items.map(item=>[item[0],item[1]]));
    plan.elements=elements.map((el,i)=>{
      const blockers=relations.get(i+1);assert(Array.isArray(blockers)&&blockers.every(n=>Number.isInteger(n)&&n>=1&&n<=elements.length&&n!==i+1),'Invalid compact depth relation');
      return {...el,label:el.description,occluded_by:blockers.map(n=>elements[n-1].id)};
    });
    const ids=new Set(plan.elements.map(el=>el.id));
    for(const el of plan.elements)assert(Array.isArray(el.occluded_by)&&el.occluded_by.every(id=>ids.has(id)&&id!==el.id),'Invalid blockers: '+el.id);
    plan.selected=plan.elements.filter(el=>!el.occluded_by.length);plan.deferred=plan.elements.filter(el=>el.occluded_by.length);
  }
  for(let i=0;i<plan.selected.length;i++)for(let j=i+1;j<plan.selected.length;j++)
    if(overlap(plan.selected[i].bbox,plan.selected[j].bbox))plan.conflicts.push([plan.selected[i].id,plan.selected[j].id]);
  await write(path.join(dir,'plan.json'),plan);
  await bboxPreview(source,plan.selected,path.join(dir,'selected_bbox.png'));
  assert.equal(plan.conflicts.length,0,'Frontmost bbox overlap: '+JSON.stringify(plan.conflicts));
  console.log(JSON.stringify({phase:'detected',mode,selected:plan.selected.length,deferred:plan.deferred.length}));
  return plan;
}

function layoutFor(boxes) {
  // Prefer the successful experiment's tight rows, common 2x scale.
  // If rows exceed the canvas, use two columns with the SAME scale for all targets.
  const verticalWidth=Math.max(...boxes.map(b=>b.bbox[2]))*2+PAD*2;
  const verticalHeight=boxes.reduce((n,b)=>n+b.bbox[3]*2+PAD*2+GAP,0)-GAP;
  const vertical=verticalWidth<=2048&&verticalHeight<=2048&&Math.max(verticalWidth,verticalHeight)/Math.min(verticalWidth,verticalHeight)<=3;
  const columns=vertical?1:Math.min(2,boxes.length),rows=Math.ceil(boxes.length/columns);
  const maxW=Math.max(...boxes.map(b=>b.bbox[2])),maxH=Math.max(...boxes.map(b=>b.bbox[3]));
  // Leave one 16px unit for per-cell rounding before the final canvas rounding.
  const scale=vertical?2:Math.min(2,(2032-columns*PAD*2-(columns-1)*GAP)/(columns*maxW),(2032-rows*PAD*2-(rows-1)*GAP)/(rows*maxH));
  let width,height,cells=[];
  if(vertical) {
    width=verticalWidth;height=verticalHeight;let y=0;
    cells=boxes.map((b,i)=>{const cw=b.bbox[2]*2,ch=b.bbox[3]*2,x=Math.floor((width-cw-PAD*2)/2);const cell={index:i+1,row:i+1,column:1,x,y,width:cw+PAD*2,height:ch+PAD*2,crop_x:PAD,crop_y:PAD,crop_width:cw,crop_height:ch,native_width:b.bbox[2],native_height:b.bbox[3],input_scale:scale,source_bbox:b.bbox};y+=cell.height+GAP;return cell;});
  } else {
    const cellWidth=Math.ceil(maxW*scale)+PAD*2,cellHeight=Math.ceil(maxH*scale)+PAD*2;
    width=cellWidth*columns+GAP*(columns-1);height=cellHeight*rows+GAP*(rows-1);
    cells=boxes.map((b,i)=>{const cw=Math.round(b.bbox[2]*scale),ch=Math.round(b.bbox[3]*scale);return {index:i+1,row:Math.floor(i/columns)+1,column:i%columns+1,x:(i%columns)*(cellWidth+GAP),y:Math.floor(i/columns)*(cellHeight+GAP),width:cellWidth,height:cellHeight,crop_x:Math.floor((cellWidth-cw)/2),crop_y:Math.floor((cellHeight-ch)/2),crop_width:cw,crop_height:ch,native_width:b.bbox[2],native_height:b.bbox[3],input_scale:scale,source_bbox:b.bbox};});
  }
  width=Math.ceil(width/16)*16;height=Math.ceil(height/16)*16;
  // Pad the canvas only; never enlarge a target just to meet API minimum pixels.
  while(width*height<655360||Math.max(width,height)/Math.min(width,height)>3) {
    if(width<=height)width+=16;else height+=16;
  }
  assert(width<=2048&&height<=2048&&width*height>=655360);
  return {fits:true,width,height,columns,rows,cells,packing:vertical?'tight_rows_common_scale':'grid_common_scale',input_scale:scale};
}

async function atlasInputs(source, boxes, layout, dir, prefix='') {
  const tiles=await Promise.all(boxes.map((b,i)=>sharp(source).extract({left:b.bbox[0],top:b.bbox[1],width:b.bbox[2],height:b.bbox[3]})
    .resize(layout.cells[i].crop_width,layout.cells[i].crop_height,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer()));
  const input=path.join(dir,prefix+'input.png');
  await sharp({create:{width:layout.width,height:layout.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite(tiles.map((tile,i)=>({input:tile,left:layout.cells[i].x+layout.cells[i].crop_x,top:layout.cells[i].y+layout.cells[i].crop_y}))).png().toFile(input);
  const lines=Buffer.alloc(layout.width*layout.height*4);
  const pixel=(x,y)=>{if(x<0||y<0||x>=layout.width||y>=layout.height)return;const k=(y*layout.width+x)*4;lines[k]=255;lines[k+1]=42;lines[k+2]=185;lines[k+3]=255;};
  for(const c of layout.cells) { const x=c.x+c.crop_x,y=c.y+c.crop_y,w=c.crop_width,h=c.crop_height;
    for(let t=1;t<=3;t++){for(let px=x-t;px<x+w+t;px++){pixel(px,y-t);pixel(px,y+h-1+t);}for(let py=y-t;py<y+h+t;py++){pixel(x-t,py);pixel(x+w-1+t,py);}}
  }
  const outline=await sharp(lines,{raw:{width:layout.width,height:layout.height,channels:4}}).png().toBuffer();
  const reference=path.join(dir,prefix+'bbox_reference.png');await sharp(input).composite([{input:outline}]).png().toFile(reference);
  return {input,reference};
}

async function generateBatch(source, boxes, dir, index, repair=false, context={}) {
  await fsp.mkdir(dir,{recursive:true});
  const savedLayers=path.join(dir,'layers.json');
  const layout=layoutFor(boxes),{input,reference}=await atlasInputs(source,boxes,layout,dir);
  const before=repair && context.referenceSource
    ? (await atlasInputs(context.referenceSource,boxes,layout,dir,'before_')).input:null;
  const targets=boxes.map((b,i)=>{const c=layout.cells[i];return {cell:i+1,id:b.id,description:b.description,
    target_rect:[c.x+c.crop_x,c.y+c.crop_y,c.crop_width,c.crop_height],original_size:b.bbox.slice(2),
    members:b.members||[],internal_front_to_back:b.internal_front_to_back||[],
    removed_in_this_crop:(context.removed||[]).filter(el=>overlap(el.bbox,b.bbox)).map(el=>({id:el.id,description:el.description})),
    source_canvas_edges:[b.bbox[0]===0?'left':null,b.bbox[1]===0?'top':null,b.bbox[0]+b.bbox[2]===state.canvas[0]?'right':null,b.bbox[1]+b.bbox[3]===state.canvas[1]?'bottom':null].filter(Boolean)};});
  const prompt=`Edit IMAGE 1 locally. It is an atlas with magenta outlines OUTSIDE exact target bboxes. IMAGE 2 is the identical unmarked atlas and the edit target. ${before?'IMAGE 3 is the SAME crops BEFORE foreground removal: use it to identify the original retained surfaces and deleted blockers, not to restore those blockers.':''} Extract only the ${boxes.length} described target objects, one complete independent transparent layer per cell. Erase magenta outlines and all neighboring/deeper content to alpha=0. Keep target order and the exact target_rect sizes/centers. All crops use common uniform scale ${layout.input_scale}; sizes differ and must NOT be normalized. Preserve the original visible appearance, contour, proportions, colors and internal markings. Do not reshape circles, rescale individual objects, clip protrusions, enlarge targets to their cell size, restyle or add objects. Transparent padding is not artwork. ${repair
    ? 'The retained targets have RECTANGULAR DELETION GAPS. These gaps removed independent foreground objects AND the covered parts of the deeper target. They are NOT target notches, black silhouettes, recessed emblems or black artwork. Rebuild the ENTIRE intended target through every gap, including its top/bottom/side boundary. A button backplate is an ordinary continuous filled rounded rectangle, without any icon-shaped engraving. A resource track has no leftover plus/coin/bolt/diamond sockets. Do not restore removed_in_this_crop. Keep the exact original intact border and surface style. Remove scenery and lower surfaces from the isolated layer. Preserve source viewport clipping.'
    : 'Only remove surroundings; the current foreground silhouette is already present. Text targets contain glyphs and their own outline/shadow only; every non-glyph pixel is transparent. Non-text targets keep their actual silhouette and transparent cut-through holes.'}
For a coupled ring/map composite, BOTH are one target: retain a complete circular cyan luminous ring OVER the map artwork at every crossing; map pixels cannot cover the ring. Keep center/radius and relative positions from the RGB reference. Do not include its button backplate. Return one transparent ${layout.width}x${layout.height} PNG aligned to IMAGE 1. Targets:${JSON.stringify(targets)}`;
  const imagePaths=[reference,input,...(before?[before]:[])];
  const cacheKey=await imageKey(imagePaths,{model:MODEL,prompt,layout,boxes,split:'fixed_target_rect_v2'});
  const requestPath=path.join(dir,'request.json');
  const completedPath=path.join(dir,'model_cache.json');
  const completed=fs.existsSync(completedPath)?await read(completedPath):null;
  const reusable=completed?.cache_key===cacheKey&&fs.existsSync(path.join(dir,'model.png'))&&
    completed.image_key===await imageKey([path.join(dir,'model.png')],{});
  if(reusable&&fs.existsSync(savedLayers)) {
    const saved=await read(savedLayers);
    if(saved.length===boxes.length&&saved.every((layer,i)=>layer.id===boxes[i].id&&
      layer.atlas_split_method==='returned_complete_alpha_bounds_aspect_preserved'&&fs.existsSync(layer.source)))return {layers:saved,reused:true};
  }
  await write(requestPath,{model:MODEL,quality:qualityFor('background'),mode:repair?'retained_bbox_completion':'foreground_extraction',layout,targets,image_paths:imagePaths,prompt,cache_key:cacheKey});
  if(!reusable||!fs.existsSync(path.join(dir,'model.png')))await imageEdit(reference,path.join(dir,'model.png'),prompt,MODEL,null,undefined,{provider:'openai',clientKind:'background-repair',imagePaths,
    background:'transparent',quality:qualityFor('background'),size:`${layout.width}x${layout.height}`,resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,responseMetadataPath:path.join(dir,'response_geometry.json')});
  await write(completedPath,{cache_key:cacheKey,image_key:await imageKey([path.join(dir,'model.png')],{})});
  const split=await splitSeedreamAtlasModel({source,boxes,modelOutput:path.join(dir,'model.png'),batchDir:dir,layout,
    model:MODEL,batchIndex:index,preserveAspectRatio:true});
  const layers=split.layers.map(layer=>({...layer,atlas_split_method:'returned_complete_alpha_bounds_aspect_preserved',cache_key:cacheKey}));
  await write(savedLayers,layers);return {layers,reused:false};
}

async function extract(source, boxes, dir, prefix, repair=false, context={}) {
  const groups=[];for(let i=0;i<boxes.length;i+=BATCH)groups.push(boxes.slice(i,i+BATCH));
  const results=await Promise.allSettled(groups.map((batch,i)=>step(prefix+'_batch_'+(i+1),`${repair?'后景补图':'抠图'}图集 ${i+1}（${batch.length} 张）`,()=>
    generateBatch(source,batch,path.join(dir,`batch_${String(i+1).padStart(2,'0')}`),i+1,repair,context))));
  const layers=results.flatMap(result=>result.status==='fulfilled'?result.value.layers:[]);
  await write(path.join(dir,'layers.json'),layers);
  const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new Error(failures.map(result=>String(result.reason)).join('\n'));
  assert.equal(layers.length,boxes.length);return layers;
}

async function fullComposite(source,layers,output,blend='over') {
  await sharp(source).composite(layers.map(layer=>({input:layer.source,left:layer.bbox[0],top:layer.bbox[1],blend}))).png().toFile(output);
}

async function loop1() {
  const dir=path.join(OUT,'loop_01');await fsp.mkdir(dir,{recursive:true});
  const input=path.join(dir,'input.png');await fsp.copyFile(SOURCE,input);
  const plan=fs.existsSync(path.join(dir,'plan.json'))?await read(path.join(dir,'plan.json')):
    await step('loop1_text_bbox','Loop 1：识别全部文字 bbox',()=>detect(input,dir,'text'));
  const results=await Promise.allSettled([
    step('loop1_text_layers','Loop 1：文字七张一批并行抠图',async()=>{
      const cache=path.join(dir,'cutouts/reuse.json');
      if(fs.existsSync(cache)) {
        const reuse=await read(cache);
        assert.equal(reuse.source_key,await imageKey([input],{}),'Reused text extraction source changed');
        const layers=await read(path.join(dir,'cutouts/layers.json'));
        assert.deepEqual(layers.map(el=>el.id),plan.selected.map(el=>el.id));
        assert(layers.every(el=>fs.existsSync(el.source)));return layers;
      }
      return extract(input,plan.selected,path.join(dir,'cutouts'),'loop1_text');
    }),
    step('loop1_remove_text','Loop 1：删除文字并补出后景',async()=>{
      return repairTextHoles();
    }),
  ]);
  const layers=results[0].status==='fulfilled'?results[0].value:[];
  const report={...plan,layers,text_removal:results[1].status==='fulfilled'?results[1].value:null,
    after:path.join(dir,'after.png'),failures:results.filter(result=>result.status==='rejected').map(result=>String(result.reason))};
  await write(path.join(dir,'report.json'),report);await save();
  if(report.failures.length)throw new Error(report.failures.join('\n'));
  const completed=await require('./bbox_two_loop_harmonize.js').harmonizeFirst(OUT);
  state=await read(statePath);await save();return completed;
}

async function repairTextHoles() {
  const dir=path.join(OUT,'loop_01'),plan=await read(path.join(dir,'plan.json'));
  const source=path.join(dir,'input.png'),holeInput=path.join(dir,'text_transparent_holes.png');
  const deletion=await deleteBboxes(source,plan.selected,holeInput);
  const {data,info}=await sharp(holeInput).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const boxes=remainingHoleBoxes(data,info.width,info.height);
  await write(path.join(dir,'scene_plan.json'),{source:holeInput,boxes});
  const layers=await fillSceneNeighborhoods(holeInput,boxes,path.join(dir,'scene_repair'),plan.selected,
    {referenceSource:source,prefix:'loop1_text_repair',text:true});
  await fullComposite(holeInput,layers,path.join(dir,'after.png'));
  const geometry=await alphaStats(path.join(dir,'after.png'));
  assert.equal(geometry.transparent_pixels,0,'Text completion left transparent gaps');
  assert(geometry.minimum_alpha>=248,'Text completion left a visible alpha gap');
  const result={next_input:path.join(dir,'after.png'),model_layers:layers,deletion,geometry,
    method:'transparent_text_holes_scene_atlas',assembly:'complete_model_scene_crops_with_dimension_correction_only'};
  if(fs.existsSync(path.join(dir,'report.json'))) {
    const report=await read(path.join(dir,'report.json'));
    report.text_removal=result;
    await write(path.join(dir,'report.json'),report);
  }
  await save();
  return result;
}

async function deletionHoles(source,layers,output) {
  return deleteBboxes(source,layers,output);
}

function remainingHoleBoxes(data,width,height) {
  const seen=new Uint8Array(width*height),components=[];
  for(let start=0;start<seen.length;start++) {
    if(seen[start]||data[start*4+3]>=248)continue;
    const pending=[start];seen[start]=1;let x0=width,y0=height,x1=0,y1=0;
    for(let head=0;head<pending.length;head++) {
      const p=pending[head],x=p%width,y=Math.floor(p/width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
      const adjacent=[];if(x>0)adjacent.push(p-1);if(x+1<width)adjacent.push(p+1);if(y>0)adjacent.push(p-width);if(y+1<height)adjacent.push(p+width);
      for(const n of adjacent)if(!seen[n]&&data[n*4+3]<248){seen[n]=1;pending.push(n);}
    }
    // Every real hole is retained. Tiny edge fragments are grouped with the same neighborhood.
    const margin=48,left=Math.max(0,x0-margin),top=Math.max(0,y0-margin),right=Math.min(width,x1+margin+1),bottom=Math.min(height,y1+margin+1);
    components.push([left,top,right-left,bottom-top]);
  }
  let merged=components;
  let changed=true;
  while(changed){changed=false;outer:for(let i=0;i<merged.length;i++)for(let j=i+1;j<merged.length;j++)if(overlap(merged[i],merged[j])){
    merged[i]=union([merged[i],merged[j]]);merged.splice(j,1);changed=true;break outer;
  }}
  return merged.map((bbox,i)=>({id:'remaining_scene_'+(i+1),category:'background',bbox,
    description:'Residual scene neighborhood; complete transparent deletion holes without recreating removed objects'}));
}

async function fillSceneNeighborhoods(source,boxes,dir,removed,context={}) {
  const groups=[];for(let i=0;i<boxes.length;i+=BATCH)groups.push(boxes.slice(i,i+BATCH));
  const results=await Promise.allSettled(groups.map((batch,i)=>step((context.prefix||'loop2_scene')+'_batch_'+(i+1),`后景场景图集 ${i+1}（${batch.length} 张）`,async()=>{
    const batchDir=path.join(dir,`batch_${String(i+1).padStart(2,'0')}`);await fsp.mkdir(batchDir,{recursive:true});
    const saved=path.join(batchDir,'layers.json');
    const layout=layoutFor(batch),{input,reference}=await atlasInputs(source,batch,layout,batchDir);
    const missingPreview=path.join(batchDir,'missing_checker.png');await checker(input,missingPreview);
    const before=context.referenceSource?(await atlasInputs(context.referenceSource,batch,layout,batchDir,'before_')).input:null;
    const targets=batch.map((b,j)=>{const c=layout.cells[j];return {cell:j+1,id:b.id,target_rect:[c.x+c.crop_x,c.y+c.crop_y,c.crop_width,c.crop_height],source_bbox:b.bbox,
      removed_in_this_crop:removed.filter(el=>overlap(el.bbox,b.bbox)).map(el=>({id:el.id,description:el.description}))};});
    const prompt=`Complete transparent RECTANGULAR deletion gaps in these ${batch.length} SCENE crops, without extracting or isolating icons. Image 1 has magenta outlines OUTSIDE exact target_rect boundaries. Image 2 is the same residual scene rendered on a gray/white CHECKERBOARD: every checkerboard area within target_rect is a MISSING surface to reconstruct, never retained artwork or a black shape. ${before?'Image 3 is the SAME crops BEFORE deletion: identify the removed objects listed per crop, and the retained surface they covered. Never copy removed objects from Image 3.':''} Return the SAME atlas layout. Within each target_rect preserve visible retained scene/UI pixels and exact geometry. Fill EVERY missing gap with the continuing retained rear surface, or adjacent scenery where no retained surface exists. A deletion rectangle is NEVER a black object, icon-shaped engraving, white block or opening in a panel. ${context.text?'Delete all ordinary glyphs/numbers and their outlines; numeric strokes inside colored circular/shield badges are ordinary removed text too. A missing number leaves continuous badge color/shading, never a white vertical bar. Keep non-text emblem artwork.':'Keep every retained non-text object present; only removed_in_this_crop must stay absent. Do not restore deleted icons, plus signs or props as dark silhouettes/sockets. Button backplates have a continuous surface and complete rounded outline through deletions.'} A cyan ring crossing map artwork stays OVER the artwork. Each target_rect must be FULLY OPAQUE to its exact boundaries. Output an OPAQUE atlas; outer padding can be neutral gray since it is discarded when splitting scene crops. No checkerboard, black placeholders or transparent notches may remain inside the crops. Remove magenta outlines. No redesign, reflow, moving rows or normalizing sizes. Output one ${layout.width}x${layout.height} PNG. Targets:${JSON.stringify(targets)}`;
    const imagePaths=[reference,missingPreview,...(before?[before]:[])];
    const cacheKey=await imageKey(imagePaths,{model:MODEL,prompt,layout,targets});
    const requestPath=path.join(batchDir,'request.json');
    const completedPath=path.join(batchDir,'model_cache.json');
    const completed=fs.existsSync(completedPath)?await read(completedPath):null;
    const reusable=completed?.cache_key===cacheKey&&fs.existsSync(path.join(batchDir,'model.png'))&&
      completed.image_key===await imageKey([path.join(batchDir,'model.png')],{});
    if(reusable&&fs.existsSync(saved)) {
      const layers=await read(saved);
      if(layers.length===batch.length&&layers.every((layer,j)=>layer.id===batch[j].id&&fs.existsSync(layer.source)))return layers;
    }
    await write(requestPath,{model:MODEL,quality:qualityFor('background'),layout,targets,prompt,image_paths:imagePaths,cache_key:cacheKey});
    const modelOutput=path.join(batchDir,'model.png');
    if(!reusable||!fs.existsSync(modelOutput))await imageEdit(reference,modelOutput,prompt,MODEL,null,undefined,{provider:'openai',clientKind:'background-repair',imagePaths,
      background:'opaque',quality:qualityFor('background'),size:`${layout.width}x${layout.height}`,resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,responseMetadataPath:path.join(batchDir,'response_geometry.json')});
    await write(completedPath,{cache_key:cacheKey,image_key:await imageKey([modelOutput],{})});
    const layers=await Promise.all(batch.map(async (box,j)=>{
      const output=path.join(batchDir,box.id+'.png');
      const tile=await sceneAtlasTile(modelOutput,layout,j,box.bbox[2],box.bbox[3]);
      await fsp.writeFile(output,tile.buffer);
      const sourceCrop=path.join(batchDir,box.id+'_source_crop.png');
      await sharp(source).extract({left:box.bbox[0],top:box.bbox[1],width:box.bbox[2],height:box.bbox[3]}).png().toFile(sourceCrop);
      return {id:box.id,bbox:box.bbox,source:output,source_crop:sourceCrop,model_generated_source:modelOutput,
        method:tile.method,model_rect:tile.model_rect};
    }));
    await write(path.join(batchDir,'layers.json'),layers);return layers;
  })));
  const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new Error(failures.map(result=>String(result.reason)).join('\n'));
  return results.flatMap(result=>result.value);
}

async function rearPlanAfterDeletion(foregroundPlan,source,dir) {
  const deletedIds=new Set(foregroundPlan.selected.map(element=>element.id));
  const elements=groupCoupledRearCandidates(foregroundPlan.elements.filter(element=>!deletedIds.has(element.id)));
  const remainingIds=new Set(elements.map(element=>element.id));
  const deletedReference=id=>[...deletedIds].some(deleted=>deleted===id||deleted.endsWith('_'+id));
  for(const element of elements) {
    element.occluded_by=(element.occluded_by||[]).filter(id=>remainingIds.has(id));
    element.members=(element.members||[]).filter(id=>!deletedReference(id));
    element.internal_front_to_back=(element.internal_front_to_back||[]).filter(id=>!deletedReference(id));
  }
  const selected=elements.filter(element=>!element.occluded_by.length),deferred=elements.filter(element=>element.occluded_by.length);
  const conflicts=[];for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++)if(overlap(selected[i].bbox,selected[j].bbox))conflicts.push([selected[i].id,selected[j].id]);
  const plan={source,canvas:foregroundPlan.canvas,mode:'rear',elements,selected,deferred,conflicts,
    bbox_origin:'same_loop_saved_controller_candidates',depth_method:'remove_extracted_blockers_from_controller_occlusion_graph',
    deleted_ids:[...deletedIds]};
  await write(path.join(dir,'plan.json'),plan);await bboxPreview(source,selected,path.join(dir,'selected_bbox.png'));
  assert.equal(conflicts.length,0,'Remaining frontmost bboxes overlap');assert(selected.length>0,'No retained rear candidates');
  console.log(JSON.stringify({phase:'rear_plan_updated',selected:selected.length,deferred:deferred.length,coupled:elements.filter(el=>el.members?.length>1).map(el=>el.id)}));
  return plan;
}

async function loop2() {
  const dir=path.join(OUT,'loop_02');await fsp.mkdir(dir,{recursive:true});
  const previous=await read(path.join(OUT,'loop_01/report.json'));
  const input=path.join(dir,'input.png');await fsp.copyFile(previous.after,input);
  const inputBytes=await fsp.readFile(input),previousBytes=await fsp.readFile(previous.after);
  assert(inputBytes.equals(previousBytes),'Loop 2 must start with the exact Loop 1 result');
  const sourceKey=await imageKey([input],{});
  const savedPlan=fs.existsSync(path.join(dir,'plan.json'))?await read(path.join(dir,'plan.json')):null;
  const plan=savedPlan?.source_key===sourceKey?savedPlan:
    await step('loop2_foreground_bbox','Loop 2：识别最上层图像 bbox 与后景关系',()=>detect(input,dir,'visual',previous.selected));
  plan.source_key=sourceKey;await write(path.join(dir,'plan.json'),plan);
  assert.equal(plan.conflicts.length,0,'Saved frontmost bbox plan has overlaps');
  // Bbox deletion does not depend on a newly rendered foreground silhouette,
  // so extraction and rear completion can run concurrently.
  const foregroundTask=step('loop2_foreground_layers','Loop 2：前景七张一批并行抠图',()=>extract(input,plan.selected,path.join(dir,'cutouts'),'loop2_foreground'));
  foregroundTask.catch(()=>{});
  const holes=path.join(dir,'holes.png');
  const deletion=await step('loop2_delete','Loop 2：按原图完整 bbox 删除前景',()=>deletionHoles(input,plan.selected,holes));
  const rearDir=path.join(dir,'rear');await fsp.mkdir(rearDir,{recursive:true});
  const rearPlan=await step('loop2_rear_bbox_update','Loop 2：更新已识别后景的遮挡关系（圆圈＋地图合并）',()=>rearPlanAfterDeletion(plan,holes,rearDir));
  assert.equal(rearPlan.conflicts.length,0,'Saved rear bbox plan has overlaps');
  const rearLayers=await step('loop2_rear_repair','Loop 2：后景 bbox 七张一批并行补图',()=>extract(holes,rearPlan.selected,rearDir,'loop2_rear',true,
    {referenceSource:input,removed:plan.selected}));
  const rearComposite=path.join(dir,'rear_composite.png');await fillMissingPixels(holes,rearLayers,rearComposite);
  // Complete scene crops from the original holes, not a mixture of shifted
  // generated rear fragments and the old scene. Use each whole model crop.
  const {data,info}=await sharp(holes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sceneBoxes=remainingHoleBoxes(data,info.width,info.height);
  await write(path.join(dir,'scene_plan.json'),{source:holes,boxes:sceneBoxes});
  let sceneLayers=[];
  if(sceneBoxes.length)sceneLayers=await step('loop2_scene_repair','Loop 2：完整场景小图补齐删除区域',()=>fillSceneNeighborhoods(holes,sceneBoxes,path.join(dir,'scene_repair'),[...previous.selected,...plan.selected],
    {referenceSource:input}));
  const after=path.join(dir,'after.png');await fullComposite(holes,sceneLayers,after);
  const geometry=await alphaStats(after);
  assert.equal(geometry.transparent_pixels,0,'Rear completion left transparent gaps');
  assert(geometry.minimum_alpha>=248,'Rear completion left a visible alpha gap');
  const layers=await foregroundTask;
  const restored=path.join(dir,'recomposed.png');await fullComposite(after,layers,restored);
  const coupled=rearPlan.elements.filter(el=>el.members?.length>1||el.internal_front_to_back?.length>1);
  const report={...plan,layers,deletion,holes,rear_plan:rearPlan,rear_layers:rearLayers,scene_layers:sceneLayers,
    after,recomposed:restored,coupled_composites:coupled,next_loop_input:after,loop2_source_matches_loop1_exactly:true,
    geometry,scene_assembly:'complete_scene_crops_from_original_bbox_holes_model_rgba_direct',
    workflow:'text_loop_then_frontmost_bbox_loop_then_seven_per_batch_rear_completion'};
  await write(path.join(dir,'report.json'),report);
  await comparison([path.join(OUT,'input.png'),previous.after,after],['原图','Loop 1 · 删除文字后的后景','Loop 2 · 删除前景并补出后景'],path.join(OUT,'two_loop_comparison.png'));
  await comparison([input,restored],['Loop 2 输入整图','Loop 2 图层放回后的整图'],path.join(OUT,'loop2_recomposition_comparison.png'));
  if(state.previous_output) {
    await comparison([path.join(state.previous_output,'loop_02/after.png'),after],['修复前：后景残留','修复后：后景整图'],path.join(OUT,'repair_comparison.png'));
    await comparison([path.join(state.previous_output,'loop_02/recomposed.png'),restored],['修复前：图层放回','修复后：图层放回'],path.join(OUT,'restoration_repair_comparison.png'));
  }
  const completed=await require('./bbox_two_loop_harmonize.js').harmonizeSecond(OUT);
  state=await read(statePath);await save();return completed;
}

async function reuseUnchangedPlans(previousOut) {
  const previous=path.resolve(previousOut);
  assert.notEqual(previous,OUT,'Fix must use a sibling output directory');
  assert((await fsp.readFile(SOURCE)).equals(await fsp.readFile(path.join(previous,'input.png'))),'Archived experiment used a different source');
  for(const loop of ['loop_01']) {
    const dir=path.join(OUT,loop);await fsp.mkdir(dir,{recursive:true});
    const plan=await read(path.join(previous,loop,'plan.json'));
    plan.source=path.join(dir,'input.png');plan.plan_reused_from=path.join(previous,loop,'plan.json');
    await write(path.join(dir,'plan.json'),plan);
  }
  // Text extraction saw the identical original pixels and is safe to reuse.
  const textDir=path.join(OUT,'loop_01/cutouts');await fsp.mkdir(textDir,{recursive:true});
  await fsp.copyFile(path.join(previous,'loop_01/cutouts/layers.json'),path.join(textDir,'layers.json'));
  await write(path.join(textDir,'reuse.json'),{source_key:await imageKey([SOURCE],{}),from:previous});
  state.previous_output=previous;
}

async function replayCompletedLayers(previousOut) {
  const previous=path.resolve(previousOut);
  assert.notEqual(previous,OUT,'Replay requires a new output directory');
  assert((await fsp.readFile(SOURCE)).equals(await fsp.readFile(path.join(previous,'input.png'))));
  const first=await read(path.join(previous,'loop_01/report.json'));
  const firstDir=path.join(OUT,'loop_01');await fsp.mkdir(firstDir,{recursive:true});
  const firstInput=path.join(firstDir,'input.png');await fsp.copyFile(SOURCE,firstInput);
  const firstHoles=path.join(firstDir,'text_transparent_holes.png');await deleteBboxes(firstInput,first.selected,firstHoles);
  const firstAfter=path.join(firstDir,'after.png'),textLayers=[];
  for(const layer of first.text_removal.model_layers) {
    const model=layer.model_generated_source,request=await read(path.join(path.dirname(model),'request.json'));
    const index=request.targets.findIndex(target=>target.id===layer.id);
    const tile=await sceneAtlasTile(model,request.layout,index,layer.bbox[2],layer.bbox[3]);
    const targetDir=path.join(firstDir,'reused_scene');await fsp.mkdir(targetDir,{recursive:true});
    const target=path.join(targetDir,layer.id+'.png');await fsp.writeFile(target,tile.buffer);
    textLayers.push({...layer,source:target,method:tile.method,model_rect:tile.model_rect});
  }
  await fullComposite(firstHoles,textLayers,firstAfter);
  const firstReport={...first,source:firstInput,after:firstAfter,text_removal:{...first.text_removal,next_input:firstAfter,model_layers:textLayers,
    assembly:'complete_model_scene_crops_with_dimension_correction_only'},reused_from:previous};
  await write(path.join(firstDir,'plan.json'),{...firstReport,layers:undefined,text_removal:undefined});
  await write(path.join(firstDir,'report.json'),firstReport);
  await bboxPreview(firstInput,first.selected,path.join(firstDir,'selected_bbox.png'));

  const second=await read(path.join(previous,'loop_02/report.json'));
  const dir=path.join(OUT,'loop_02');await fsp.mkdir(dir,{recursive:true});
  const input=path.join(dir,'input.png');await fsp.copyFile(firstAfter,input);
  // A filled text rectangle is not an independently editable object. Keep
  // the archived bboxes for the unchanged foreground artwork, and remove a
  // candidate that the controller mistook for a label slot inside old text.
  const textArtifact=el=>/label.*slot|slot.*label|recessed.*text/i.test(el.description||'')&&
    first.selected.some(text=>overlap(el.bbox,text.bbox)>=el.bbox[2]*el.bbox[3]*0.9);
  const dropped=second.selected.filter(textArtifact),droppedIds=new Set(dropped.map(el=>el.id));
  const elements=second.elements.filter(el=>!droppedIds.has(el.id)).map(el=>({...el,
    occluded_by:(el.occluded_by||[]).filter(id=>!droppedIds.has(id))}));
  const selected=second.selected.filter(el=>!droppedIds.has(el.id));
  const plan={source:input,canvas:state.canvas,elements,selected,deferred:elements.filter(el=>el.occluded_by?.length),conflicts:[],
    bbox_origin:'archived_same_source_artwork',reused_from:previous,dropped_text_patch_artifacts:dropped};
  await write(path.join(dir,'plan.json'),plan);await bboxPreview(input,selected,path.join(dir,'selected_bbox.png'));
  const layers=second.layers.filter(el=>!droppedIds.has(el.id));
  const holes=path.join(dir,'holes.png'),deletion=await deleteBboxes(input,selected,holes);
  const rearDir=path.join(dir,'rear');await fsp.mkdir(rearDir,{recursive:true});
  const rearPlan=await rearPlanAfterDeletion(plan,holes,rearDir);
  const rearLayers=second.rear_layers;
  await write(path.join(rearDir,'layers.json'),rearLayers);
  await fillMissingPixels(holes,rearLayers,path.join(dir,'rear_composite.png'));
  const {data,info}=await sharp(holes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sceneBoxes=remainingHoleBoxes(data,info.width,info.height);
  await write(path.join(dir,'scene_plan.json'),{source:holes,boxes:sceneBoxes});
  const sceneLayers=await step('loop2_scene_replay','Loop 2：直接补原始透明洞，替换完整场景小图',()=>
    fillSceneNeighborhoods(holes,sceneBoxes,path.join(dir,'scene_repair'),[...first.selected,...selected],{referenceSource:input}));
  const after=path.join(dir,'after.png');await fullComposite(holes,sceneLayers,after);
  const geometry=await alphaStats(after);assert.equal(geometry.transparent_pixels,0);assert(geometry.minimum_alpha>=248);
  const restored=path.join(dir,'recomposed.png');await fullComposite(after,layers,restored);
  const report={...plan,layers,deletion,holes,rear_plan:rearPlan,rear_layers:rearLayers,scene_layers:sceneLayers,geometry,
    after,recomposed:restored,next_loop_input:after,loop2_source_matches_loop1_exactly:true,
    coupled_composites:rearPlan.selected.filter(el=>/ring/i.test(el.description||'')&&/map/i.test(el.description||'')),
    scene_assembly:'complete_scene_crops_from_original_bbox_holes_model_rgba_direct'};
  await write(path.join(dir,'report.json'),report);
  state.previous_output=previous;
  await comparison([path.join(OUT,'input.png'),firstAfter,after],['原图','Loop 1 · 删除文字后的后景','Loop 2 · 删除前景后的后景'],path.join(OUT,'two_loop_comparison.png'));
  await comparison([input,restored],['Loop 2 输入整图','Loop 2 图层放回后的整图'],path.join(OUT,'loop2_recomposition_comparison.png'));
  await comparison([path.join(previous,'loop_02/after.png'),after],['修复前：矩形拼接残留','修复后：完整场景补图'],path.join(OUT,'repair_comparison.png'));
  await comparison([path.join(previous,'loop_02/recomposed.png'),restored],['修复前：图层放回','修复后：图层放回'],path.join(OUT,'restoration_repair_comparison.png'));
}

async function comparison(files,labels,output) {
  const displays=await Promise.all(files.map(async (file,i)=>{
    const target=output.replace('.png','_panel_'+(i+1)+'.png');await checker(file,target);return target;
  }));
  const first=await sharp(files[0]).metadata();
  const panelWidth=1280,panelHeight=Math.round(panelWidth*first.height/first.width),gap=16,header=64,totalWidth=files.length*panelWidth+(files.length+1)*gap;
  const previews=await Promise.all(displays.map(file=>sharp(file).resize(panelWidth,panelHeight,{fit:'contain',background:'#f3f5f8'}).png().toBuffer()));
  const title=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${panelHeight+header+gap}"><g fill="#17212f" font-family="Microsoft YaHei, sans-serif" font-size="28" font-weight="700">${labels.map((label,i)=>`<text x="${gap+i*(panelWidth+gap)}" y="42">${escape(label)}</text>`).join('')}</g></svg>`);
  await sharp({create:{width:totalWidth,height:panelHeight+header+gap,channels:4,background:'#f3f5f8'}})
    .composite([...previews.map((input,i)=>({input,left:gap+i*(panelWidth+gap),top:header})),{input:title,left:0,top:0}]).png().toFile(output);
  await sharp(output).resize({width:1920}).png().toFile(output.replace('.png','_preview.png'));
}

async function page() {
  const figures=[];
  for(const [label,file] of [['修复前后 · 后景整图','repair_comparison.png'],['修复前后 · 图层放回整图','restoration_repair_comparison.png'],['测试原图','input.png'],['Loop 1 · 删除文字后的整图','loop_01/after.png'],['Loop 1 · 文字 bbox','loop_01/selected_bbox.png'],['Loop 2 · 当前前景 bbox','loop_02/selected_bbox.png'],['Loop 2 · 删除当前前景后的透明洞整图','loop_02/holes.png'],['Loop 2 · 后景补图后的整图','loop_02/after.png'],['Loop 2 · 后景 bbox（圆圈＋地图合为一个）','loop_02/rear/selected_bbox.png'],['Loop 2 · 图层放回后的整图','loop_02/recomposed.png'],['两轮整图对照','two_loop_comparison.png'],['Loop 2 图层放回前后整图对照','loop2_recomposition_comparison.png'],['圆圈与地图同框补图结果','coupled_comparison.png']]) {
    if(fs.existsSync(path.join(OUT,file)))figures.push(`<figure><figcaption>${label}</figcaption><a href="${file}" target="_blank"><img src="${file}" alt="${label}"></a></figure>`);
  }
  let galleries='';
  for(const loop of ['loop_01','loop_02']) {
    const reportPath=path.join(OUT,loop,'report.json');if(!fs.existsSync(reportPath))continue;
    const report=await read(reportPath);
    galleries+=`<h2>${loop==='loop_01'?'Loop 1：文字图层':'Loop 2：前景图层'}</h2><div class="layers">${(report.layers||[]).map(layer=>`<article><p>${escape(layer.id)}</p><div class="pair"><img src="${escape(relative(layer.source_crop))}" alt="bbox 原图"><img src="${escape(relative(layer.source))}" alt="模型图层"></div></article>`).join('')}</div>`;
    if(report.rear_layers?.length)galleries+=`<h2>Loop 2：后景独立补图</h2><div class="layers">${report.rear_layers.map(layer=>`<article><p>${escape(layer.id)}</p><div class="pair"><img src="${escape(relative(layer.source_crop))}" alt="透明洞 bbox"><img src="${escape(relative(layer.source))}" alt="补好的后景图层"></div></article>`).join('')}</div>`;
    const modelFiles=[...new Set([...(report.layers||[]),...(report.rear_layers||[]),...(report.scene_layers||[]),...(report.text_removal?.model_layers||[])]
      .map(layer=>layer.model_generated_source||layer.generated_source).filter(Boolean))];
    for(const file of [report.harmonization?.model_output,report.text_removal?.harmonization?.model_output])if(file)modelFiles.push(file);
    galleries+=`<h2>${loop}：原始图集与模型返回</h2><div class="layers">${(await Promise.all(modelFiles.map(async file=>{
      const batchDir=path.dirname(file),requestPath=path.join(batchDir,path.basename(file)==='harmonized_model.png'?'harmonize_request.json':'request.json');
      if(!fs.existsSync(requestPath))return '';
      const request=await read(requestPath);
      return `<details><summary>${escape(path.relative(OUT,batchDir))}</summary><p><a href="${escape(relative(requestPath))}">完整提示词与输入记录</a></p><div class="pair">${(request.image_paths||[]).filter(image=>fs.existsSync(image)).map((image,i)=>`<figure><figcaption>输入 ${i+1}</figcaption><a href="${escape(relative(image))}"><img loading="lazy" src="${escape(relative(image))}"></a></figure>`).join('')}<figure><figcaption>模型原始返回</figcaption><a href="${escape(relative(file))}"><img loading="lazy" src="${escape(relative(file))}"></a></figure></div></details>`;
    }))).join('')}</div>`;
  }
  const visibleSteps=[...new Map(state.steps.filter(item=>item.status!=='failed').map(item=>[item.id,item])).values()];
  const failures=state.steps.filter(item=>item.status==='failed');
  const failureDetails=failures.length?`<details><summary>查看曾重试的步骤（${failures.length}）</summary><ul>${failures.map(item=>`<li>${escape(item.title)}：${escape(String(item.error||'').slice(0,360))}</li>`).join('')}</ul></details>`:'';
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bbox 两轮本地测试</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f3f5f8;color:#17212f;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}h1{font-size:25px}h2{font-size:20px;margin-top:30px}.grid,.layers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}figure,article{margin:0;padding:14px;border:1px solid #ccd4df;border-radius:8px;background:#fff}figcaption{font-weight:650;margin-bottom:10px}img{display:block;width:100%;height:auto;background-color:#ddd;background-image:conic-gradient(#ddd 25%,#f5f5f5 0 50%,#ddd 0 75%,#f5f5f5 0);background-size:24px 24px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.layers img{height:200px;object-fit:contain}table{border-collapse:collapse;width:100%;background:#fff}td,th{padding:10px;text-align:left;border:1px solid #d2d9e2}a{color:#175bba}article p{overflow-wrap:anywhere}details{margin:18px 0;padding:12px;border:1px solid #ccd4df;border-radius:6px;background:#fff}summary{cursor:pointer;font-weight:650}@media(max-width:800px){.grid,.layers{grid-template-columns:1fr}}</style></head><body>
<h1>bbox 两轮本地测试 · 修复版</h1><p>原图：20260827-204428.png。Loop 1 提取并删除文字，补出的后景直接作为 Loop 2 输入；Loop 2 提取当前最上层对象，删除后按互不重叠的后景 bbox 补图。图层七张一批，各批并行。圆圈与地图使用一个 bbox，圆圈覆盖地图。模型 ${MODEL}，质量 max。棋盘格表示真实透明区域。</p>
<p><strong>修复：</strong>删除使用原图完整 bbox；清除已删除的子元素描述；独立图层保留模型完整轮廓与比例。图集拼接后由模型校准整图接缝，最终图直接采用模型原始返回，仅校正画布尺寸，作为下一轮输入。状态：${escape(state.status||'运行中')}。<a href="status.json">完整时间记录</a> · <a href="input.png">原图</a> · <a href="verification.json">验证结果</a></p>${failureDetails}
<table><thead><tr><th>步骤</th><th>开始时间</th><th>运行耗时</th><th>结束时间</th><th>状态</th></tr></thead><tbody>${visibleSteps.map(item=>`<tr><td>${escape(item.title==='Loop 1：删除文字并补出后景'?'Loop 1：透明洞补字后景（最终版）':item.title)}</td><td>${escape(new Date(item.started_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</td><td data-start="${escape(item.started_at)}" data-end="${escape(item.ended_at||'')}">${((item.elapsed_ms||(Date.now()-Date.parse(item.started_at)))/1000).toFixed(1)} 秒</td><td>${item.ended_at?escape(new Date(item.ended_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})):'—'}</td><td>${escape({running:'运行中',completed:'完成'}[item.status])}</td></tr>`).join('')}</tbody></table>
<h2>整图结果</h2><div class="grid">${figures.join('')}</div>${galleries}
<script>setInterval(()=>document.querySelectorAll('[data-start]').forEach(e=>{if(!e.dataset.end)e.textContent=((Date.now()-Date.parse(e.dataset.start))/1000).toFixed(1)+' 秒'}),1000);${state.status==='completed'||state.status==='failed'?'':'setTimeout(()=>location.reload(),20000);'}</script></body></html>`;
  await fsp.writeFile(path.join(OUT,'index.html'),html,'utf8');
}

async function main() {
  await fsp.mkdir(OUT,{recursive:true});
  if(fs.existsSync(statePath))state=await read(statePath);
  delete state.error;
  state.canvas=await sharp(SOURCE).metadata().then(meta=>[meta.width,meta.height]);
  state.started_at=state.started_at||new Date().toISOString();state.status='running';
  await fsp.copyFile(SOURCE,path.join(OUT,'input.png'));await save();
  const phase=process.argv[2]||'all';
  if(phase==='fix'&&!fs.existsSync(path.join(OUT,'loop_01/plan.json'))) {
    assert(process.argv[4],'fix requires the previous experiment directory');
    await reuseUnchangedPlans(process.argv[4]);
  }
  if(phase==='loop1'||phase==='all'||phase==='fix')await loop1();
  if(phase==='text-repair') {
    await repairTextHoles();await require('./bbox_two_loop_harmonize.js').harmonizeFirst(OUT);state=await read(statePath);
  }
  if(phase==='loop2'||phase==='all'||phase==='fix')await loop2();
  if(phase==='replay')await replayCompletedLayers(process.argv[4]);
  if(phase==='page')await page();
  state.status=['loop1','text-repair'].includes(phase)?'loop1_completed':'completed';state.ended_at=new Date().toISOString();await save();
  console.log(JSON.stringify({phase,status:state.status,output:OUT}));
}

module.exports={checker,layoutFor,remainingHoleBoxes,fullComposite,comparison,deletionHoles};
if(require.main===module)main().catch(async error=>{state.status='failed';state.error=String(error.stack||error);await save();console.error(error.stack||error);process.exitCode=1;});
