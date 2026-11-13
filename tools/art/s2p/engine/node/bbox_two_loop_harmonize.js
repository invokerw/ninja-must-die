#!/usr/bin/env node
const {modelFor,qualityFor,getRoute}=require('./model_config.js');
// Local correction of atlas seams. The image model response becomes the next
// loop input directly, with canvas-size correction only.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {imageEdit}=require('./layerforge.js');
const {imageKey,deleteBboxes,alphaStats}=require('./bbox_atlas_pixels.js');
const {comparison,checker}=require('./bbox_two_loop_test.js');
const MODEL=modelFor('background');
let out=path.resolve(process.argv[2]||path.join(__dirname,'../../../web_runs/bbox-two-loop-final-20261012'));
const read=file=>fsp.readFile(file,'utf8').then(JSON.parse);
const write=(file,value)=>fsp.writeFile(file,JSON.stringify(value,null,2)+'\n','utf8');

async function generate(id,title,images,prompt,dir) {
  const statusPath=path.join(out,'status.json'),state=await read(statusPath);
  const started=new Date().toISOString(),record={id,title,status:'running',started_at:started};
  state.steps.push(record);state.status='running';delete state.ended_at;await write(statusPath,state);
  const key=await imageKey(images,{model:MODEL,prompt,size:'2560x1440',quality:qualityFor('background')});
  const output=path.join(dir,'harmonized_model.png'),cache=path.join(dir,'harmonize_cache.json');
  const request=path.join(dir,'harmonize_request.json');
  await write(request,{model:MODEL,quality:qualityFor('background'),image_paths:images,prompt,size:'2560x1440',cache_key:key});
  const timer=setInterval(()=>console.log(JSON.stringify({stage:id,elapsed_s:Math.round((Date.now()-Date.parse(started))/1000)})),30000);
  try {
    const cached=fs.existsSync(cache)?await read(cache):null;
    if(!cached||cached.cache_key!==key||!fs.existsSync(output)||cached.image_key!==await imageKey([output],{})) {
      await imageEdit(images[0],output,prompt,MODEL,null,undefined,{provider:'openai',clientKind:'background-repair',
        imagePaths:images,background:'opaque',quality:qualityFor('background'),size:'2560x1440',resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,
        responseMetadataPath:path.join(dir,'harmonize_geometry.json')});
      await write(cache,{cache_key:key,image_key:await imageKey([output],{})});
    }
    const metadata=await sharp(output).metadata();
    const corrected=path.join(dir,'after.png');
    if(metadata.width===2560&&metadata.height===1440)await fsp.copyFile(output,corrected);
    else await sharp(output).resize(2560,1440,{fit:'fill'}).png().toFile(corrected);
    const geometry=await alphaStats(corrected);assert.equal(geometry.transparent_pixels,0);
    assert(geometry.minimum_alpha>=248,'Harmonization left a missing surface');
    record.status='completed';return {model_output:output,after:corrected,geometry,request,
      method:'whole_scene_model_harmonization_dimension_correction_only'};
  } catch(error) {record.status='failed';record.error=String(error.message||error);throw error;}
  finally {
    clearInterval(timer);record.ended_at=new Date().toISOString();record.elapsed_ms=Date.parse(record.ended_at)-Date.parse(started);
    state.status=record.status==='failed'?'failed':'running';await write(statusPath,state);console.log(JSON.stringify(record));
  }
}

async function harmonizeFirst(outputDir) {
  out=path.resolve(outputDir);
  const firstDir=path.join(out,'loop_01');
  const first=await read(path.join(firstDir,'report.json'));
  const tiledFirst=path.join(firstDir,'atlas_assembled.png');
  if(!fs.existsSync(tiledFirst))await fsp.copyFile(path.join(firstDir,'after.png'),tiledFirst);
  const firstPrompt=`Edit Image 1, the complete 2560x1440 original game UI. Image 2 has true transparent rectangular gaps where ALL ordinary UI text and numbers were deleted. Image 3 is the text-free atlas reconstruction, but it contains tile seams, gray rectangular outlines, small gray strips and exposure/color patches. Return a single coherent TEXT-FREE version of Image 1: remove the exact text/numbers listed below and reconstruct the surfaces they cover, using Image 2 to locate deletion regions. Preserve every NON-TEXT icon, coin, shield, yellow tier badge, robot, controls, ticket, glove, map, cyan circular ring, background scenery and their exact positions, extents, colors and front/behind ordering from Image 1. Digits inside badges are ordinary text: their missing areas become continuous cyan or yellow badge shading, never a white vertical bar, engraved digit or black placeholder. Preserve fused non-readable emblem artwork. The cyan ring crosses ABOVE the map. Image 3 is only a semantic removal reference; REMOVE ALL rectangular tile frames, gray bands, duplicated borders, stitching seams, placeholder blocks and patch exposure boundaries. Do not erase or move any non-text target. Keep existing contour widths and circular geometry. No new content or glyphs. Return ONE fully opaque 2560x1440 PNG. Removed glyph bboxes, original XYWH: ${JSON.stringify(first.selected.map(el=>({id:el.id,bbox:el.bbox,description:el.description})))}`;
  const firstResult=await generate('loop1_seam_harmonization','Loop 1：整图消除图集接缝，直接采用模型返回',
    [path.join(firstDir,'input.png'),path.join(firstDir,'text_transparent_holes.png'),tiledFirst],firstPrompt,firstDir);
  first.text_removal={...first.text_removal,harmonization:firstResult};first.after=firstResult.after;
  await write(path.join(firstDir,'report.json'),first);
  return first;
}

async function harmonizeSecond(outputDir) {
  out=path.resolve(outputDir);
  const firstDir=path.join(out,'loop_01'),secondDir=path.join(out,'loop_02');
  const first=await read(path.join(firstDir,'report.json')),second=await read(path.join(secondDir,'report.json'));
  await fsp.copyFile(first.after,path.join(secondDir,'input.png'));
  const holes=path.join(secondDir,'holes.png');second.deletion=await deleteBboxes(path.join(secondDir,'input.png'),second.selected,holes);
  const tiledSecond=path.join(secondDir,'atlas_assembled.png');
  if(!fs.existsSync(tiledSecond))await fsp.copyFile(path.join(secondDir,'after.png'),tiledSecond);
  const secondPrompt=`Edit Image 1, the CURRENT complete text-free loop input at 2560x1440. Image 2 is the same image with the selected current FOREGROUND objects removed as true alpha=0 rectangular gaps. Image 3 is the rear atlas reconstruction: it demonstrates the required surviving content, but its tile frames, color seams, gray strips and mismatched fragments are ERRORS. Remove ONLY the exact foreground objects listed below from Image 1 and complete the surface/scenery BEHIND them. Use Image 2 to identify the missing areas. Keep ALL surviving rear objects from Image 1 at their original locations and scale: experience cyan fill plus dark track, profile panel, season panel and segmented progress strip, green/brown/purple resource container bars, settings button backplate, SIX small rounded-square button backplates, FOUR bottom navigation button backplates, right-side stage button backplate, and the folded map PLUS a complete circular cyan luminous ring. Treat ring and map as ONE coupled retained composite; the cyan ring crosses ABOVE the map artwork. The pointing hand is removed, while the map AND ring stay present and are fully completed. Retain the observed ring center/radius and its genuine circular geometry. Resource bars and all button/panel surfaces are continuous: do not keep removed icons as black silhouettes, sockets, engravings, notches or shaped holes. Complete every interrupted panel boundary through deleted icon locations. Never restore any removed foreground icon, label, number, trophy, badge, glove or prop. REMOVE ALL tile boundary lines, gray strips, doubled borders, black or white placeholders, patch exposure changes and visible rectangular stitching, including outside alpha gaps. Image 1 controls the actual geometry/style; Image 3 only controls which objects survive. Keep environmental scenery unchanged in appearance and composition. Return ONE coherent fully opaque 2560x1440 PNG. Removed foreground objects: ${JSON.stringify(second.selected.map(el=>({id:el.id,bbox:el.bbox,description:el.description})))}`;
  const secondResult=await generate('loop2_seam_harmonization','Loop 2：整图校准后景，保留地图与完整圆圈',
    [path.join(secondDir,'input.png'),holes,tiledSecond],secondPrompt,secondDir);
  second.source=path.join(secondDir,'input.png');second.after=secondResult.after;second.next_loop_input=second.after;
  second.holes=holes;second.harmonization=secondResult;second.geometry=secondResult.geometry;
  second.scene_assembly='raw_whole_scene_model_response_after_atlas_with_dimension_correction_only';
  await sharp(second.after).composite(second.layers.map(layer=>({input:layer.source,left:layer.bbox[0],top:layer.bbox[1]})))
    .png().toFile(path.join(secondDir,'recomposed.png'));
  await write(path.join(secondDir,'report.json'),second);
  await comparison([path.join(out,'input.png'),first.after,second.after],['原图','Loop 1 · 删除文字后的后景','Loop 2 · 删除前景后的后景'],path.join(out,'two_loop_comparison.png'));
  await comparison([path.join(secondDir,'input.png'),second.recomposed],['Loop 2 输入整图','Loop 2 图层放回后的整图'],path.join(out,'loop2_recomposition_comparison.png'));
  const old=path.join(out,'../bbox-two-loop-20261012');
  if(fs.existsSync(path.join(old,'loop_02/after.png')))await comparison([path.join(old,'loop_02/after.png'),second.after],['修复前：黑色残留与重复边框','修复后：后景整图'],path.join(out,'repair_comparison.png'));
  if(fs.existsSync(path.join(old,'loop_02/recomposed.png')))await comparison([path.join(old,'loop_02/recomposed.png'),second.recomposed],['修复前：图层放回','修复后：图层放回'],path.join(out,'restoration_repair_comparison.png'));
  await checker(holes,path.join(secondDir,'holes_checker.png'));
  return second;
}

async function main() {
  await harmonizeFirst(out);
  await harmonizeSecond(out);
  const state=await read(path.join(out,'status.json'));state.status='completed';state.ended_at=new Date().toISOString();
  await write(path.join(out,'status.json'),state);console.log(JSON.stringify({status:'completed',output:out}));
}
module.exports={harmonizeFirst,harmonizeSecond};
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
