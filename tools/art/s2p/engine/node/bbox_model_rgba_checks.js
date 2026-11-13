// Verify actual RGBA storage, including fractional alpha, not just scale labels.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const {placeModelRgba,preserveModelAspect}=require('./bbox_model_rgba.js');
const {fixedCellAlphaTile}=require('./bbox_atlas_pixels.js');
async function main(){
  const dir=await fs.mkdtemp(path.resolve(__dirname,'../tmp/model-rgba-check-'));
  const rgba=Buffer.alloc(8*6*4);
  for(let p=0;p<48;p++){rgba[p*4]=(p*17)%256;rgba[p*4+1]=(p*31)%256;rgba[p*4+2]=(p*9)%256;rgba[p*4+3]=[0,1,17,79,128,254,255][p%7];}
  const model=path.join(dir,'model.png');await sharp(rgba,{raw:{width:8,height:6,channels:4}}).png().toFile(model);
  const rect={left:0,top:0,width:8,height:6};
  const native=await placeModelRgba(model,rect,[0,0,24,20]);
  const raw=await sharp(native.buffer).ensureAlpha().raw().toBuffer();
  const [left,top]=native.placement.offset;
  for(let y=0;y<6;y++)assert(raw.subarray(((y+top)*24+left)*4,((y+top)*24+left+8)*4).equals(rgba.subarray(y*8*4,(y+1)*8*4)),'Unscaled model RGB and alpha must survive crop and placement byte for byte');
  assert.deepEqual(native.placement.scale,[1,1]);assert(native.placement.resolution_shortfall);
  const small=await placeModelRgba(model,rect,[0,0,4,4]);
  assert.deepEqual(small.placement.rendered_size,[4,3]);
  const same=await placeModelRgba(model,rect,[0,0,8,6]);
  assert((await sharp(same.buffer).raw().toBuffer()).equals(rgba),'A scale of one never enters a resampling or compositing step');
  const corrected=await placeModelRgba(model,rect,[0,0,4,6],undefined,false);
  assert.deepEqual(corrected.placement.rendered_size,[4,6],'Restore a tall original target from a squat model crop without enlarging either axis');
  assert.deepEqual(corrected.placement.raster_scale,[.5,1]);
  assert.equal(corrected.placement.geometry_fit,'original_target_ratio');
  const short=await placeModelRgba(model,rect,[0,0,16,6],undefined,false);
  assert.deepEqual(short.placement.rendered_size,[8,3],'Resolution shortfall must retain the ORIGINAL target ratio');
  assert(short.placement.resolution_shortfall);
  const composite={category:'icon',members:['ring','artwork'],internal_front_to_back:['ring','artwork']};
  const circle=Buffer.alloc(80*80*4);
  for(let y=0;y<80;y++)for(let x=0;x<80;x++)if(Math.abs(Math.hypot(x-39.5,y-39.5)-28)<3){const p=(y*80+x)*4;circle[p]=90;circle[p+1]=240;circle[p+2]=255;circle[p+3]=255;}
  const circleFile=path.join(dir,'circle.png');await sharp(circle,{raw:{width:80,height:80,channels:4}}).png().toFile(circleFile);
  const round=await placeModelRgba(circleFile,{left:0,top:0,width:80,height:80},[0,0,60,40],undefined,preserveModelAspect(composite));
  const roundRaw=await sharp(round.buffer).raw().toBuffer();let minX=60,maxX=0,minY=40,maxY=0;
  for(let y=0;y<40;y++)for(let x=0;x<60;x++)if(roundRaw[(y*60+x)*4+3]>128){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  assert.deepEqual(round.placement.rendered_size,[40,40]);
  assert(Math.abs((maxX-minX)-(maxY-minY))<=2,'A ring inside a wide composite bbox must remain circular (allow two raster antialias pixels)');
  assert.equal(preserveModelAspect({category:'icon'}),false,'Single foreground targets still restore original target dimensions');
  const floorComposite={category:'artwork',members:['magic_circle','character_archer'],internal_front_to_back:['magic_circle','character_archer']};
  assert.equal(preserveModelAspect(floorComposite),true,'Composite geometry must not depend on a member id containing the English word ring');
  assert.equal(preserveModelAspect({...floorComposite,internal_front_to_back:[]}),true,'Independent member count still declares a union bbox when explicit order is absent');
  const actualCharacterGeometry=await placeModelRgba(model,rect,[0,0,683,764],undefined,preserveModelAspect(floorComposite));
  assert.equal(actualCharacterGeometry.placement.geometry_fit,'returned_model_ratio');
  assert.equal(actualCharacterGeometry.placement.scale[0],actualCharacterGeometry.placement.scale[1],'Do not widen a composite while restoring its union bbox');
  const fixed=await fixedCellAlphaTile(model,{width:8,height:6,cells:[{x:0,y:0,width:8,height:6}]},0,24,20);
  assert.deepEqual(fixed.placement.scale,[1,1],'Fixed-cell fallback cannot enlarge either');
  for(const uniform of [true,false])for(const dims of [[30,2],[2,30],[8,6],[3,2]]){
    const result=await placeModelRgba(model,rect,[0,0,...dims],undefined,uniform);
    assert(result.placement.scale.every(scale=>scale<=1));
    assert(result.placement.raster_scale.every(scale=>scale<=1));
    assert(result.placement.rendered_size[0]<=8&&result.placement.rendered_size[1]<=6);
  }
  console.log('PASS: exact unscaled RGBA including alpha=1, shrink-only fitting, mixed dimensions, fixed-cell fallback');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
