#!/usr/bin/env node
// Repair demonstrated repeated-surface placement errors from saved model
// atlases. Creates a separate derived run; never edits the original run.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const sharp=require('sharp');
const {splitSeedreamAtlasModel}=require('./layerforge.js');
const {repeatedSurfaceGuard,visibleBoxFraction}=require('./bbox_surface_geometry.js');
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const write=(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n');
const digest=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const same=(a,b)=>a&&b&&a.every((v,i)=>Math.abs(v-b[i])<=1);
const inside=(file,root)=>{const r=path.relative(root,file);return !r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
function relocate(value,source,target) {
  if(Array.isArray(value))return value.map(item=>relocate(item,source,target));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,relocate(item,source,target)]));
  if(typeof value==='string'&&path.isAbsolute(value)&&inside(value,source))return path.join(target,path.relative(source,value));
  return value;
}
async function main() {
  if(!process.argv[2]||!process.argv[3])throw new Error('Usage: node node/bbox_surface_recover.js COMPLETED_RUN NEW_OUTPUT');
  const parent=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
  assert(!inside(output,parent)&&!inside(parent,output),'Source and output must be separate sibling directories');
  const original=await read(path.join(parent,'status.json'));
  assert.equal(original.status,'completed','Finish the model run before deterministic recovery');
  try {assert.equal((await fs.readdir(output)).length,0,'Output directory must be empty');}catch(error){if(error.code!=='ENOENT')throw error;}
  const first=original.loops[1],plan=await read(path.join(path.dirname(first.report),'plan_raw.json'));
  const pixels=await sharp(first.input).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const peers=plan.elements.map(el=>({...el,bbox:el.detection_bbox||el.bbox}));
  const audits=plan.elements.flatMap(el=>{
    if(!el.detection_bbox||!el.geometry_bbox)return [];
    const guard=repeatedSurfaceGuard(el.detection_bbox,el.geometry_bbox,el.category,peers,visibleBoxFraction(pixels.data,pixels.info,el.detection_bbox));
    return guard?[{id:el.id,category:el.category,detected:el.detection_bbox,measured:el.geometry_bbox,guard:guard.guard}]:[];
  });
  if(!audits.length){console.log(JSON.stringify({status:'not_needed',model_calls:0}));return;}
  const protectedNames=['status.json','layers.json','layers.psd','recomposed.png','verification.json'];
  const parentHashes=Object.fromEntries(await Promise.all(protectedNames.map(async name=>[name,await digest(path.join(parent,name))])));
  const started=new Date().toISOString();
  await fs.cp(parent,output,{recursive:true});
  const state=relocate(original,parent,output),corrections=[];
  const stage=path.join(output,'surface_geometry_recovery');await fs.mkdir(stage,{recursive:true});
  for(const loop of state.loops.slice(1)) {
    const affected=loop.layers.flatMap((layer,index)=>{
      const audit=audits.find(item=>item.category===layer.category&&same(layer.semantic_bbox,item.measured));
      return audit?[{layer,index,audit}]:[];
    });
    const batches=new Map();
    for(const item of affected) {
      const batch=path.dirname(item.layer.model_generated_source||item.layer.generated_source);
      if(!batches.has(batch))batches.set(batch,[]);batches.get(batch).push(item);
    }
    for(const [batch,items] of batches) {
      const request=await read(path.join(batch,'request.json'));
      const boxes=request.targets.map(target=>{
        const box=loop.selected.find(el=>el.id===target.id);assert(box,'Saved batch target missing from round');
        const item=items.find(entry=>loop.selected[entry.index].id===box.id);
        return item?{...box,source_bbox:item.audit.detected.slice()}:box;
      });
      const batchDir=path.join(stage,`loop_${loop.index}_${path.basename(batch)}`);
      await fs.mkdir(batchDir,{recursive:true});
      const split=await splitSeedreamAtlasModel({source:loop.input,boxes,modelOutput:path.join(batch,'model.png'),batchDir,layout:request.layout,model:state.model,batchIndex:1,preserveAspectRatio:true,preserveSourceBounds:true});
      for(const item of items) {
        const at=boxes.findIndex(box=>box.id===loop.selected[item.index].id),old=item.layer;
        assert(same(split.layers[at].semantic_bbox,item.audit.detected),'Corrected semantic extent not applied');
        loop.layers[item.index]={...old,...split.layers[at],id:old.id,name:old.name,depth:old.depth,z_index:old.z_index,
          surface_geometry_recovery:{...item.audit,previous_source:old.source,model_calls:0,method:'saved_model_alpha_repositioned_inside_original_deletion_bbox'}};
        corrections.push({id:old.id,name:old.name,old_semantic_bbox:old.semantic_bbox,semantic_bbox:split.layers[at].semantic_bbox,previous_source:old.source,source:split.layers[at].source,audit:item.audit});
      }
    }
  }
  const alreadyCorrected=audits.filter(audit=>!corrections.some(item=>item.audit.id===audit.id)).map(audit=>{
    const layer=state.loops.flatMap(loop=>loop.layers).find(item=>item.category===audit.category&&same(item.semantic_bbox,audit.detected));
    assert(layer,'Rejected surface has neither a matching bad layer nor a later correct placement: '+audit.id);
    return {audit,layer:layer.id,semantic_bbox:layer.semantic_bbox,reason:'later_measurement_already_restored_detected_extent'};
  });
  assert.equal(corrections.length+alreadyCorrected.length,audits.length,'Every rejected measurement must be accounted for');
  const manifest=await read(path.join(output,'run_manifest.json'));
  const files=['node/bbox_recursive_core.js','node/bbox_surface_geometry.js','node/bbox_surface_recover.js','node/bbox_recursive_test.js','node/layerforge.js'];
  const identities=[];
  for(const relative of files) {
    const file=path.resolve(__dirname,'..',relative),snapshot=path.join(stage,'code_snapshot',relative);
    await fs.mkdir(path.dirname(snapshot),{recursive:true});await fs.copyFile(file,snapshot);
    identities.push({relative,file,sha256:await digest(file),snapshot});
  }
  manifest.derived_from={output:parent,manifest_sha256:await digest(path.join(parent,'run_manifest.json')),model_calls:0};
  manifest.reuse_text=true;manifest.reuse_text_source=parent;manifest.reuse_visual_layers=true;
  manifest.local_corrections=true;manifest.local_correction_kind='deterministic_geometry_only';
  manifest.postprocessing={kind:'deterministic_repeated_surface_geometry',started_at:started,sources:identities};
  state.surface_geometry_recovery={started_at:started,parent,model_calls:0,corrections,already_corrected:alreadyCorrected,scope:'Only surface placement changed; original model atlases and recursive alpha-hole inputs preserved. Foreground source-pixel recovery unchanged.'};
  state.notice=`原像素完整测试的派生结果：用同一批模型图集修正 ${corrections.length} 个重复底板的测框尺寸；没有新增生图请求。原始结果保留在 ${parent}。`;
  await write(path.join(output,'run_manifest.json'),manifest);
  await write(path.join(output,'status.json'),state);
  execFileSync(process.execPath,['node/bbox_recursive_test.js',output,'--export-only'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,BBOX_TEST_SOURCE:state.source},stdio:'inherit',windowsHide:true});
  const final=await read(path.join(output,'status.json'));
  const ended=new Date().toISOString();
  final.surface_geometry_recovery.ended_at=ended;
  final.steps.push({id:'surface_geometry_recovery',title:`原图重复底板尺寸校验与离线纠正（${corrections.length} 层，0 次生图）`,status:'completed',started_at:started,ended_at:ended,elapsed_ms:Date.parse(ended)-Date.parse(started)});
  final.ended_at=ended;await write(path.join(output,'status.json'),final);
  await write(path.join(stage,'report.json'),{parent,parent_hashes:parentHashes,corrections,already_corrected:alreadyCorrected,started_at:started,ended_at:ended,model_calls:0});
  for(const [name,hash] of Object.entries(parentHashes))assert.equal(await digest(path.join(parent,name)),hash,'Original result was altered: '+name);
  execFileSync(process.execPath,['node/bbox_recursive_test.js',output,'--report-only'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,BBOX_TEST_SOURCE:state.source},stdio:'inherit',windowsHide:true});
  console.log(JSON.stringify({output,corrected_layers:corrections.length,model_calls:0,parent_unchanged:true}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
