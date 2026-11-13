// Reuse regional inventories only when local pixels and dependencies are exact.
// The whole-canvas overview and downstream reconciliation still run each round.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {jsonrepair}=require('jsonrepair');
const {imageKey}=require('./bbox_atlas_pixels.js');
const VERSION='regional_detection_v1';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

function regionalContext(items,crop){
  const right=crop.left+crop.width,bottom=crop.top+crop.height;
  return items.filter(item=>{
    const [x,y,w,h]=item.bbox;
    return x<right&&x+w>crop.left&&y<bottom&&y+h>crop.top;
  });
}

async function regionalDetection({enabled,region,images,context,directory,cacheRoot,request,validate}){
  const started=Date.now();
  const eligible=enabled&&region.id!=='overview';
  const key=eligible?await imageKey(images,{version:VERSION,region,context}):null;
  const entry=key?path.join(cacheRoot,key+'.json'):null;
  const responseFile=path.join(directory,'response.json');
  let origin=null;
  if(entry){
    try{
      const record=JSON.parse(await fs.readFile(entry,'utf8'));
      if(record.version===VERSION&&record.key===key&&path.resolve(record.response)!==path.resolve(responseFile)){
        const bytes=await fs.readFile(record.response);
        if(hash(bytes)===record.response_sha256){
          const response=JSON.parse(bytes.toString('utf8'));
          if(response.cache_key===record.response_cache_key&&response.finish_reason!=='length'){
            const parsed=JSON.parse(jsonrepair(response.content));validate(parsed);
            const reuse={region:region.id,status:'reused',key,origin:record.response,elapsed_ms:Date.now()-started};
            await fs.writeFile(path.join(directory,'regional_reuse.json'),JSON.stringify(reuse,null,2)+'\n');
            return {parsed,reuse};
          }
        }
      }
    }catch(error){
      // Missing, damaged, or no longer valid evidence falls back to detection.
      // Never treat a cache problem as evidence that the region is empty.
      origin={cache_fallback:error.code||error.name};
    }
  }
  const parsed=await request();validate(parsed);
  if(entry){
    const bytes=await fs.readFile(responseFile),response=JSON.parse(bytes.toString('utf8'));
    const record={version:VERSION,key,response:responseFile,response_sha256:hash(bytes),response_cache_key:response.cache_key};
    await fs.mkdir(cacheRoot,{recursive:true});
    const temporary=entry+'.'+crypto.randomUUID()+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(record,null,2)+'\n');await fs.rename(temporary,entry);
  }
  const reuse={region:region.id,status:eligible?'requested_or_same_round_cache':region.id==='overview'?'fresh_overview':'disabled',key,...origin,elapsed_ms:Date.now()-started};
  await fs.writeFile(path.join(directory,'regional_reuse.json'),JSON.stringify(reuse,null,2)+'\n');
  return {parsed,reuse};
}
module.exports={VERSION,regionalContext,regionalDetection};
