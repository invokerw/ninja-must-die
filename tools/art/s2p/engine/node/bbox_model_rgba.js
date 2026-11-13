// Crop returned model RGBA and place it without ever enlarging its pixels.
const assert=require('node:assert/strict');
const sharp=require('sharp');

function preserveModelAspect(box){
  // A composite bbox describes several objects and their relative layout.
  // Its union ratio cannot justify stretching every member. Member ids are
  // arbitrary: a floor circle may be named "magic_circle", never "ring".
  return box.category==='text'||box.preserve_model_aspect===true||
    (box.members||[]).length>1;
}

async function placeModelRgba(model,rect,bbox,target=bbox,uniform=true){
  const [x,y,width,height]=bbox,[tx,ty,tw,th]=target;
  assert(tx>=x&&ty>=y&&tx+tw<=x+width&&ty+th<=y+height,'Placement target exceeds layer canvas');
  const requested=uniform?Math.min(tw/rect.width,th/rect.height):null;
  const scale=uniform?Math.min(1,requested):null;
  // A generated crop can already be squashed. With grounded source geometry,
  // restore the original target ratio rather than preserving that distortion.
  // If either model dimension is insufficient, reduce BOTH target dimensions
  // by the same coverage factor; neither returned-pixel axis is enlarged.
  const coverage=uniform?null:Math.min(1,rect.width/tw,rect.height/th);
  const rw=Math.max(1,Math.min(rect.width,tw,Math.round(uniform?rect.width*scale:tw*coverage)));
  const rh=Math.max(1,Math.min(rect.height,th,Math.round(uniform?rect.height*scale:th*coverage)));
  let crop=sharp(model).extract(rect).ensureAlpha();
  const unscaled=rw===rect.width&&rh===rect.height;
  if(!unscaled)crop=crop.resize(rw,rh,{fit:'fill',kernel:sharp.kernel.lanczos3});
  const raw=await crop.raw().toBuffer({resolveWithObject:true});
  assert.equal(raw.info.channels,4);
  const left=tx-x+Math.floor((tw-rw)/2),top=ty-y+Math.floor((th-rh)/2);
  const canvas=Buffer.alloc(width*height*4);
  // A blend onto an empty canvas can round low-alpha RGB. Copy RGBA rows so
  // the unscaled path is pixel-identical to the returned model crop.
  for(let row=0;row<rh;row++)raw.data.copy(canvas,((top+row)*width+left)*4,row*rw*4,(row+1)*rw*4);
  return {bbox,buffer:await sharp(canvas,{raw:{width,height,channels:4}}).png().toBuffer(),placement:{
    policy:'model_rgba_downscale_only',model_size:[rect.width,rect.height],rendered_size:[rw,rh],
    scale:uniform?[scale,scale]:[rw/rect.width,rh/rect.height],raster_scale:[rw/rect.width,rh/rect.height],offset:[left,top],unscaled_rgba_exact:unscaled,
    geometry_fit:uniform?'returned_model_ratio':'original_target_ratio',target_size:[tw,th],target_coverage:uniform?null:coverage,
    resolution_shortfall:uniform?requested>1:coverage<1,
    rgb_recovery:false,alpha_recovery:false}};
}
module.exports={placeModelRgba,preserveModelAspect};
