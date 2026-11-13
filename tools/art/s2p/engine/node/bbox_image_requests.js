// Shared request slots for local atlas extraction and background repair.
// Preserve parallel batches while respecting the gateway's actual rate limit.
const {imageEdit}=require('./layerforge.js');
const fs=require('node:fs/promises');
const concurrency=Math.max(1,Number(process.env.BBOX_IMAGE_CONCURRENCY)||2);
let active=0;
const pending=[];
async function imageRequest(...args) {
  const timingPath=String(args[1]).replace(/\.png$/i,'_timing.json');
  const timing={output:args[1],queued_at:new Date().toISOString(),status:'queued',attempts:[]};
  const save=()=>fs.writeFile(timingPath,JSON.stringify(timing,null,2)+'\n');
  await save();
  if(active>=concurrency)await new Promise(resolve=>pending.push(resolve));
  else active++;
  try {
    timing.started_at=new Date().toISOString();timing.queue_ms=Date.parse(timing.started_at)-Date.parse(timing.queued_at);timing.status='running';await save();
    for(let attempt=0;;attempt++) {
      const record={attempt:attempt+1,started_at:new Date().toISOString()};timing.attempts.push(record);await save();
      try {const result=await imageEdit(...args);record.ended_at=new Date().toISOString();record.status='completed';timing.status='completed';return result;}
      catch(error) {
        record.ended_at=new Date().toISOString();record.status='failed';record.error=error.message;timing.status='failed';await save();
        const status=error.status||error.statusCode;
        const limited=status===429||/429|rate limit/i.test(error.message||'');
        const transient=[408,409,425,500,502,503,504].includes(status)||/timeout|timed out|connection error|ECONNRESET|socket hang up|gateway/i.test(error.message||'');
        if((!limited&&!transient)||attempt>=(limited?2:1))throw error;
        const delay=limited?(attempt+1)*30000:3000;
        console.log(JSON.stringify({stage:limited?'image_rate_limit':'image_transient_retry',retry:attempt+1,status:status||'network',delay_s:delay/1000}));
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
  } finally {
    timing.ended_at=new Date().toISOString();timing.execution_ms=Date.parse(timing.ended_at)-Date.parse(timing.started_at);timing.total_ms=Date.parse(timing.ended_at)-Date.parse(timing.queued_at);
    const next=pending.shift();if(next)next();else active--;
    await save();
  }
}
module.exports={imageRequest};
