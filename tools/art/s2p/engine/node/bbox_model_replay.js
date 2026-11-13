#!/usr/bin/env node
// Reuse saved atlases, change only placement policy, and export a separate PSD.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {execFileSync}=require('node:child_process');
const {splitSeedreamAtlasModel}=require('./layerforge.js');
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const inside=(file,root)=>{const r=path.relative(root,file);return r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function relocate(value,from,to){
  if(Array.isArray(value))return value.map(item=>relocate(item,from,to));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,relocate(item,from,to)]));
  return typeof value==='string'&&path.isAbsolute(value)&&inside(value,from)?path.join(to,path.relative(from,value)):value;
}
async function main(){
  if(!process.argv[2]||!process.argv[3])throw new Error('Usage: node node/bbox_model_replay.js COMPLETED_RUN NEW_OUTPUT');
  const parent=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
  assert(!inside(parent,output)&&!inside(output,parent));
  try{assert.equal((await fs.readdir(output)).length,0,'Output must be empty');}catch(error){if(error.code!=='ENOENT')throw error;}
  const original=await read(path.join(parent,'status.json'));assert.equal(original.status,'completed');
  const names=['status.json','layers.json','layers.psd','recomposed.png','verification.json'];
  const parentHashes=Object.fromEntries(await Promise.all(names.map(async name=>[name,await hash(path.join(parent,name))])));
  const started=new Date().toISOString();await fs.cp(parent,output,{recursive:true});
  const state=relocate(original,parent,output),stage=path.join(output,'model_output_replay');await fs.mkdir(stage,{recursive:true});
  const checks=[];let batchNumber=0;
  for(const loop of state.loops){
    const groups=new Map();
    for(const layer of loop.layers){
      const model=layer.model_generated_source||layer.generated_source;assert(model,'No saved model atlas: '+layer.id);
      if(!groups.has(model))groups.set(model,[]);groups.get(model).push(layer);
    }
    for(const [model,selected] of groups){
      const request=await read(path.join(path.dirname(model),'request.json'));
      const boxes=request.targets.map(target=>{
        const box=loop.selected.find(item=>item.id===target.id);assert(box,'Missing target '+target.id);
        const layer=loop.layers.find(item=>item.id===target.id||item.id===`loop_${String(loop.index).padStart(2,'0')}_`+target.id);
        return {...box,source_bbox:layer?.semantic_bbox||box.source_bbox||box.bbox};
      });
      const before=await hash(model),batch=path.join(stage,`batch_${String(++batchNumber).padStart(3,'0')}`);await fs.mkdir(batch,{recursive:true});
      const split=await splitSeedreamAtlasModel({source:loop.input,boxes,modelOutput:model,batchDir:batch,layout:request.layout,model:state.model,batchIndex:batchNumber,preserveAspectRatio:true,preserveSourceBounds:true});
      assert.equal(await hash(model),before,'Raw model atlas changed');
      for(const old of selected){
        const at=boxes.findIndex(box=>old.id===box.id||old.id===`loop_${String(loop.index).padStart(2,'0')}_`+box.id);assert(at>=0);
        const fresh=split.layers[at],p=fresh.model_placement;
        assert(p.scale.every(scale=>scale<=1)&&p.raster_scale.every(scale=>scale<=1),'Model pixels were enlarged');
        let exact=null;
        if(p.unscaled_rgba_exact){
          const [left,top,width,height]=fresh.atlas_cell.model_rect;
          const source=await sharp(model).extract({left,top,width,height}).ensureAlpha().raw().toBuffer();
          const placed=await sharp(fresh.source).extract({left:p.offset[0],top:p.offset[1],width,height}).ensureAlpha().raw().toBuffer();
          exact=source.equals(placed);assert(exact,'Unscaled model RGBA changed');
        }
        const next={...old,...fresh,id:old.id,name:old.name,depth:old.depth,z_index:old.z_index,model_rgba_source:fresh.source};
        for(const key of ['fidelity','fidelity_retry','pixel_fidelity_version','surface_geometry_recovery'])delete next[key];
        loop.layers[loop.layers.indexOf(old)]=next;
        checks.push({id:old.id,category:old.category,model_sha256:before,source:fresh.source,placement:p,unscaled_rgba_verified:exact});
      }
    }
    await write(loop.report,loop);
  }
  const manifest=await read(path.join(output,'run_manifest.json')),sources=[];
  for(const relative of ['node/bbox_model_replay.js','node/bbox_model_rgba.js','node/layerforge.js','node/bbox_recursive_core.js','node/bbox_recursive_test.js']){
    const file=path.resolve(__dirname,'..',relative),snapshot=path.join(stage,'code_snapshot',relative);await fs.mkdir(path.dirname(snapshot),{recursive:true});await fs.copyFile(file,snapshot);sources.push({relative,file,snapshot,sha256:await hash(file)});
  }
  manifest.previous_postprocessing=manifest.postprocessing||null;
  manifest.derived_from={output:parent,manifest_sha256:await hash(path.join(parent,'run_manifest.json')),model_calls:0};
  Object.assign(manifest,{reuse_text:true,reuse_text_source:parent,reuse_visual_layers:true,source_pixel_recovery:false,quality_retry_per_object:0,model_output_policy:'model_rgba_downscale_only',postprocessing:{kind:'saved_model_rgba_downscale_only',started_at:started,sources}});
  state.model_output_policy='model_rgba_downscale_only';state.previous_visual_review=state.visual_review;state.visual_review={status:'not_reviewed',reason:'Layers now use raw model RGB/alpha with downscale-only placement.'};
  state.notice='本结果直接拆分已保存的模型 RGBA，只允许缩小，尺寸不足保留原尺寸居中放置；没有原像素替换、重算 alpha 或新生图。文字仍为每批 14 个。旧时间记录属于原生图过程。';
  await write(path.join(output,'run_manifest.json'),manifest);await write(path.join(output,'status.json'),state);
  execFileSync(process.execPath,['node/bbox_recursive_test.js',output,'--export-only'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,BBOX_TEST_SOURCE:state.source},windowsHide:true,stdio:'inherit'});
  const ended=new Date().toISOString(),elapsed=Date.parse(ended)-Date.parse(started),final=await read(path.join(output,'status.json'));
  const summary={status:'passed',parent,model_calls:0,started_at:started,ended_at:ended,elapsed_ms:elapsed,layers:checks.length,upscaled_layers:0,unscaled_layers:checks.filter(item=>item.unscaled_rgba_verified).length,resolution_shortfalls:checks.filter(item=>item.placement.resolution_shortfall).map(item=>item.id),checks,parent_hashes:parentHashes};
  await write(path.join(output,'model_placement_verification.json'),summary);
  final.steps.push({id:'model_output_replay',title:'模型 RGBA 直接放回：只缩小、禁止放大（0 次生图）',status:'completed',started_at:started,ended_at:ended,elapsed_ms:elapsed});
  final.model_placement_verification={...summary,checks:undefined,parent_hashes:undefined};await write(path.join(output,'status.json'),final);
  for(const [name,digest] of Object.entries(parentHashes))assert.equal(await hash(path.join(parent,name)),digest,'Parent result changed');
  execFileSync(process.execPath,['node/bbox_recursive_test.js',output,'--report-only'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,BBOX_TEST_SOURCE:state.source},windowsHide:true,stdio:'inherit'});
  console.log(JSON.stringify({...summary,checks:undefined,parent_hashes:undefined,parent_unchanged:true}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
