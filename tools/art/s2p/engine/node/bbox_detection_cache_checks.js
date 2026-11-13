#!/usr/bin/env node
// Check invalidation and the real detector with deterministic local responses.
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const Module=require('node:module');
const {regionalContext,regionalDetection}=require('./bbox_detection_cache.js');
const {deleteBboxes}=require('./bbox_atlas_pixels.js');
const realLayerforge=require('./layerforge.js');
const write=(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n');

async function main(){
  const root=await fs.mkdtemp(path.resolve(__dirname,'../tmp/detection-cache-check-'));
  const current=path.join(root,'current.png'),reference=path.join(root,'reference.png');
  const paint=(file,alpha=1,color='#c02030')=>sharp({create:{width:20,height:20,channels:4,background:color}}).ensureAlpha(alpha).png().toFile(file);
  await paint(current);await paint(reference);
  const region={id:'roi_1',crop:{left:0,top:0,width:20,height:20},core:[0,0,20,20]};
  const local={id:'local',bbox:[4,4,8,8]},crossing={id:'crossing',bbox:[18,2,10,4]},outside={id:'outside',bbox:[20,2,10,4]};
  assert.deepEqual(regionalContext([local,crossing,outside],region.crop),[local,crossing]);
  let requests=0,serial=0;
  const validate=reply=>{assert.equal(reply.coordinate_space,'yxyx_1000');assert(Array.isArray(reply.elements));};
  async function invoke(context={},overrides={}){
    const directory=path.join(root,'unit',String(++serial));await fs.mkdir(directory,{recursive:true});
    return regionalDetection({enabled:true,region,images:[current,reference],context,directory,cacheRoot:path.join(root,'unit_cache'),validate,
      request:async()=>{requests++;const parsed={coordinate_space:'yxyx_1000',background_only:true,elements:[]};
        await write(path.join(directory,'response.json'),{content:JSON.stringify(parsed),cache_key:'fixture',finish_reason:'stop'});return parsed;},...overrides});
  }
  await invoke();const hit=await invoke();assert.equal(requests,1);assert.equal(hit.reuse.status,'reused');
  // Alpha is part of the key, including a completely transparent local crop.
  await sharp({create:{width:20,height:20,channels:4,background:{r:192,g:32,b:48,alpha:0}}}).png().toFile(current);
  await invoke();assert.equal(requests,2,'Alpha changes must invalidate regional reuse');
  await paint(reference,1,'#20c030');await invoke();assert.equal(requests,3,'Original reference changes must invalidate reuse');
  await invoke({removed:[local]});assert.equal(requests,4,'Local removal dependencies must invalidate reuse');
  const hintHit=await invoke({hints:[local]});assert.equal(requests,5,'New deeper hints must invalidate reuse');
  await fs.writeFile(path.join(root,'unit_cache',hintHit.reuse.key+'.json'),'{broken');
  await invoke({hints:[local]});assert.equal(requests,6,'Damaged cache must request detection instead of inventing an empty result');
  const origin=(await invoke({hints:[local]})).reuse.origin;await fs.writeFile(origin,'{}');
  await invoke({hints:[local]});assert.equal(requests,7,'Changed original model evidence must invalidate reuse');
  await invoke({}, {region:{...region,id:'overview'}});await invoke({}, {region:{...region,id:'overview'}});
  assert.equal(requests,9,'Whole-canvas detection must always run');
  await invoke({}, {enabled:false});assert.equal(requests,10);

  const source=path.join(root,'source.png');
  await sharp({create:{width:900,height:600,channels:4,background:'#303030'}}).composite([
    {input:await sharp({create:{width:15,height:14,channels:4,background:'#e02020'}}).png().toBuffer(),left:40,top:40},
    {input:await sharp({create:{width:15,height:14,channels:4,background:'#2020e0'}}).png().toBuffer(),left:820,top:40},
  ]).png().toFile(source);
  const calls=[];
  let forceUncertain=false,terminalDiscovery=false;
  async function locate(image,color){
    const dataUrl=image.image_url.url,bytes=Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64');
    const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    let left=info.width,top=info.height,right=-1,bottom=-1;
    for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
      const p=(y*info.width+x)*4;
      if(data[p+3]&&((color==='red'&&data[p]>180&&data[p+1]<70&&data[p+2]<70)||(color==='blue'&&data[p+2]>180&&data[p]<70&&data[p+1]<70))){
        left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
      }
    }
    return right<0?null:[Math.floor(top*1000/info.height),Math.floor(left*1000/info.width),Math.ceil((bottom+1)*1000/info.height),Math.ceil((right+1)*1000/info.width)];
  }
  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(Module._resolveFilename(request,parent)===path.join(__dirname,'layerforge.js'))return {...realLayerforge,openaiClient:()=>({chat:{completions:{create:async payload=>{
      const parts=payload.messages.find(message=>message.role==='user').content,images=parts.filter(p=>p.type==='image_url'),prompt=parts.find(p=>p.type==='text').text;
      let parsed,type;
      if(prompt.startsWith('The first ')){
        type='geometry';const targets=JSON.parse(prompt.slice(prompt.indexOf('Targets:')+8));
        parsed={coordinate_space:'crop_yxyx_1000',targets:await Promise.all(targets.map(async target=>{
          const box=await locate(images[target.original_image-1],target.id.includes('red')?'red':'blue');
          return {id:target.id,present:!!box,...(box?{box}:{})};
        }))};
      }else if(prompt.startsWith('Inspect the complete CURRENT scene.')){
        type='terminal';const box=terminalDiscovery?await locate(images[0],'red'):null;
        parsed={background_only:!box,reason:'fixture terminal review',remaining_elements:box?[{id:'red_icon',category:'icon',description:'red icon',box,
          ...(process.env.BBOX_COMBINED_DETECTION==='1'?{original_present:true,original_box:box}:{} )}]:[]};
      }else if(prompt.startsWith('Check these ')){
        type='pending';const hints=JSON.parse(prompt.slice(prompt.indexOf('Hints:')+6));
        parsed={checks:await Promise.all(hints.map(async hint=>{
          const box=await locate(images[0],hint.id.includes('red')?'red':'blue');
          return {hint_id:hint.id,present:!!box,element:box?{id:'blue_icon',category:'icon',description:'blue icon',box}:null};
        }))};
      }else{
        type=prompt.includes('This is a whole-canvas overview.')?'overview':'region';
        const elements=[];
        if(type==='region'&&!terminalDiscovery)for(const color of ['red','blue']){
          const box=await locate(images[0],color);
          if(box)elements.push({id:color+'_icon',category:'icon',description:color+' icon',box,occluded_by:[],members:[],internal_front_to_back:[]});
        }
        parsed={coordinate_space:'yxyx_1000',background_only:!elements.length,scene:'fixture',elements};
        if(process.env.BBOX_COMBINED_DETECTION==='1'){
          for(const element of elements){element.original_present=true;element.original_box=await locate(images.at(-1),element.id.includes('red')?'red':'blue');}
          const marker='Owned prior targets (SOURCE XYWH):';
          const owned=JSON.parse(prompt.slice(prompt.lastIndexOf(marker)+marker.length));
          parsed.hint_checks=await Promise.all(owned.map(async hint=>{
            const color=hint.id.includes('red')?'red':'blue',present=!!await locate(images[0],color);
            return {hint_id:hint.id,status:forceUncertain?'uncertain':present?'present':'absent',element_id:!forceUncertain&&present?color+'_icon':null};
          }));
        }
      }
      if(process.env.BBOX_LOCAL_DETECTION==='1'&&type==='region'){
        assert.equal(images.length,2,'Local detection only needs current and original local crops');
        assert(prompt.includes('Image 2 is the ORIGINAL UNMARKED same-coordinate crop'));
        assert(!prompt.includes('Image 3'),'No stale image-number reference');
      }
      calls.push(type);return {choices:[{message:{content:JSON.stringify(parsed)},finish_reason:'stop'}],usage:{completion_tokens:1}};
    }}}})};
    return originalLoad.call(this,request,parent,isMain);
  };
  const savedEnv=process.env.BBOX_INCREMENTAL_DETECTION;
  const savedLocal=process.env.BBOX_LOCAL_DETECTION;
  const savedCombined=process.env.BBOX_COMBINED_DETECTION;
  try{
    const {createCore}=require('./bbox_recursive_core.js');
    async function execute(name,enabled,local=false,combined=false,uncertain=false){
      process.env.BBOX_INCREMENTAL_DETECTION=enabled?'1':'0';
      process.env.BBOX_LOCAL_DETECTION=local?'1':'0';
      process.env.BBOX_COMBINED_DETECTION=combined?'1':'0';forceUncertain=uncertain;
      const dir=path.join(root,name);await fs.mkdir(dir);
      const state={source,loops:[]},core=createCore({state,step:async(_id,_title,work)=>work()});
      const before=calls.length,plans=[];let input=source;const removed=[];
      for(let i=0;i<3;i++){
        const roundDir=path.join(dir,'loop_'+String(i+2).padStart(2,'0'));await fs.mkdir(roundDir);
        const found=combined&&i>0?plans[0].selected.find(element=>element.id.includes('blue')):null;
        const hints=found?[{...found,bbox:found.geometry_bbox||found.source_bbox||found.bbox}]:[];
        const plan=await core.detect(input,roundDir,'visual',removed,hints);plans.push(plan);
        if(i<2){const chosen=plan.selected.find(x=>x.id.includes(i===0?'red':'blue'));assert(chosen);
          const next=path.join(dir,'input_'+(i+1)+'.png');await deleteBboxes(input,[chosen],next);input=next;removed.push(chosen);}
      }
      return {plans,calls:calls.slice(before),input};
    }
    const full=await execute('full',false),incremental=await execute('incremental',true);
    const shape=plan=>({selected:plan.selected.map(x=>({id:x.id,bbox:x.bbox,source_bbox:x.source_bbox,occluded_by:x.occluded_by})),
      deferred:plan.deferred.map(x=>({id:x.id,bbox:x.bbox,occluded_by:x.occluded_by})),background_only:!!plan.background_only,conflicts:plan.conflicts});
    assert.deepEqual(incremental.plans.map(shape),full.plans.map(shape),'Regional reuse changed actual scheduling, full extents or terminal decisions');
    assert((await fs.readFile(full.input)).equals(await fs.readFile(incremental.input)),'Regional reuse changed true alpha-hole inputs');
    assert.equal(full.calls.filter(x=>x==='region').length,18);assert.equal(incremental.calls.filter(x=>x==='region').length,8);
    assert.equal(incremental.calls.filter(x=>x==='overview').length,3);assert.equal(incremental.calls.filter(x=>x==='terminal').length,1);
    const local=await execute('local',true,true);
    assert.deepEqual(local.plans.map(shape),full.plans.map(shape));
    assert((await fs.readFile(local.input)).equals(await fs.readFile(full.input)));
    assert.equal(local.calls.filter(x=>x==='region').length,8);assert.equal(local.calls.filter(x=>x==='overview').length,3);
    const combined=await execute('combined',true,true,true);
    assert.equal(combined.calls.filter(type=>type==='geometry').length,0,'Combined original measurements must avoid redundant geometry requests');
    assert.equal(combined.calls.filter(type=>type==='pending').length,0,'Confirmed absent owned hints must avoid redundant presence requests');
    assert(combined.plans[2].background_only);assert(combined.plans[2].terminal);
    for(const [i,color] of [[0,'red'],[1,'blue']]){
      const selected=combined.plans[i].selected.find(element=>element.id.includes(color));
      const x=color==='red'?40:820,[bx,by,bw,bh]=selected.bbox;
      assert(bx<=x&&by<=40&&bx+bw>=x+15&&by+bh>=54,'Full source geometry must cover all native target pixels');
    }
    const uncertain=await execute('combined_uncertain',true,true,true,true);
    assert.equal(uncertain.calls.filter(type=>type==='pending').length,1,'Uncertain presence must retain batched discovery');
    assert.deepEqual(uncertain.plans.map(shape),combined.plans.map(shape));
    assert((await fs.readFile(uncertain.input)).equals(await fs.readFile(combined.input)));
    terminalDiscovery=true;forceUncertain=false;
    for(const combinedMode of [false,true]){
      process.env.BBOX_COMBINED_DETECTION=combinedMode?'1':'0';
      const dir=path.join(root,'terminal_geometry_'+combinedMode);await fs.mkdir(dir);
      const before=calls.length,core=createCore({state:{source,loops:[]},step:async(_id,_title,work)=>work()});
      const plan=await core.detect(source,dir,'visual',[],[]);
      assert.equal(plan.selected.length,1);assert(plan.selected[0].geometry_bbox,'Terminal discoveries need original geometry too');
      assert.equal(calls.slice(before).filter(type=>type==='geometry').length,combinedMode?0:1);
    }
    const result={status:'passed',model_calls:0,actual_core_detect:true,regional_requests_full:18,regional_requests_incremental:8,
      reused_regions:incremental.plans.reduce((n,p)=>n+p.detection_reuse.reused_regions,0),overview_calls:3,terminal_confirmation_preserved:true,
      plans_and_alpha_holes_identical:true,local_inputs_image_numbering_and_holes_checked:true,alpha_reference_dependencies_and_corrupt_cache_invalidate:true,
      combined_original_geometry_has_no_extra_request:true,owned_hint_absence_avoids_extra_request:true,uncertain_presence_retains_batched_fallback:true,terminal_geometry_preserved:true,output:root};
    await write(path.join(root,'verification.json'),result);console.log(JSON.stringify(result));
  }finally{
    Module._load=originalLoad;
    if(savedEnv===undefined)delete process.env.BBOX_INCREMENTAL_DETECTION;else process.env.BBOX_INCREMENTAL_DETECTION=savedEnv;
    if(savedLocal===undefined)delete process.env.BBOX_LOCAL_DETECTION;else process.env.BBOX_LOCAL_DETECTION=savedLocal;
    if(savedCombined===undefined)delete process.env.BBOX_COMBINED_DETECTION;else process.env.BBOX_COMBINED_DETECTION=savedCombined;
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
