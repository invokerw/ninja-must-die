// Display artifacts only. Keep raw alpha-hole images as the recursive inputs.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const {checker} = require('./bbox_two_loop_test.js');

const COLORS = [
  [230, 45, 85], [0, 125, 220], [175, 45, 220],
  [0, 145, 100], [230, 100, 0], [90, 80, 230],
];
const DIGITS = [
  ['111','101','101','101','111'], ['010','110','010','010','111'],
  ['111','001','111','100','111'], ['111','001','111','001','111'],
  ['101','101','111','001','001'], ['111','100','111','001','111'],
  ['111','100','111','101','111'], ['111','001','001','001','001'],
  ['111','101','111','101','111'], ['111','101','111','001','111'],
];
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const intersection = (a,b) => Math.max(0, Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])) *
  Math.max(0, Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));

function disjointHalo(boxes, padding, width, height) {
  return boxes.map((item, index) => {
    const [x,y,w,h]=item.bbox;
    let left=Math.max(0,x-padding), top=Math.max(0,y-padding);
    let right=Math.min(width,x+w+padding), bottom=Math.min(height,y+h+padding);
    boxes.forEach((other,j)=>{
      if(index===j)return;
      const [ox,oy,ow,oh]=other.bbox;
      const vertical=oy<y+h && oy+oh>y;
      const horizontal=ox<x+w && ox+ow>x;
      if(vertical && ox+ow<=x)left=Math.max(left,ox+ow);
      if(vertical && ox>=x+w)right=Math.min(right,ox);
      if(horizontal && oy+oh<=y)top=Math.max(top,oy+oh);
      if(horizontal && oy>=y+h)bottom=Math.min(bottom,oy);
    });
    return {...item,bbox:[left,top,Math.max(1,right-left),Math.max(1,bottom-top)]};
  });
}

async function numberedBboxPreview(source, boxes, output) {
  const {width,height} = await sharp(source).metadata();
  const raw = Buffer.alloc(width*height*4);
  const pixel = (x,y,color) => {
    if(x<0 || y<0 || x>=width || y>=height)return;
    const p=(y*width+x)*4;
    raw[p]=color[0];raw[p+1]=color[1];raw[p+2]=color[2];raw[p+3]=255;
  };
  boxes.forEach((box,index) => {
    const [x,y,w,h]=box.bbox, color=COLORS[index%COLORS.length];
    const line=Math.min(2,w,h);
    for(let t=0;t<line;t++) {
      for(let px=x;px<x+w;px++){pixel(px,y+t,color);pixel(px,y+h-1-t,color);}
      for(let py=y;py<y+h;py++){pixel(x+t,py,color);pixel(x+w-1-t,py,color);}
    }
    const text=String(index+1);
    const scale=Math.min(w,h)>=18?2:1, labelW=(text.length*4-1)*scale+4, labelH=5*scale+4;
    // Labels stay inside their own bbox; narrow separators only get a border.
    if(labelW>w || labelH>h)return;
    for(let py=y;py<y+labelH;py++)for(let px=x;px<x+labelW;px++)pixel(px,py,color);
    for(let d=0;d<text.length;d++)for(let row=0;row<5;row++)for(let col=0;col<3;col++) {
      if(DIGITS[Number(text[d])][row][col]!=='1')continue;
      for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)
        pixel(x+2+(d*4+col)*scale+dx,y+2+row*scale+dy,[255,255,255]);
    }
  });
  const overlay=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer();
  await sharp(source).composite([{input:overlay}]).png().toFile(output);
}

async function refreshLoopPreviews(loop) {
  const dir=path.dirname(loop.report);
  const selected=loop.selected || [], layers=loop.layers || [];
  const conflicts=[];
  for(let a=0;a<selected.length;a++)for(let b=a+1;b<selected.length;b++) {
    const area=intersection(selected[a].bbox,selected[b].bbox);
    if(area)conflicts.push({a:selected[a].id,b:selected[b].id,area});
  }
  assert.equal(conflicts.length,0,`Loop ${loop.index} contains overlapping selected bboxes`);
  const rawInput=await fs.readFile(loop.input);
  const rawAfter=await fs.readFile(loop.after);
  const inputPixels=await sharp(rawInput).ensureAlpha().raw().toBuffer();
  let transparent=0,opaqueBlack=0;
  for(let p=0;p<inputPixels.length;p+=4) {
    if(inputPixels[p+3]===0)transparent++;
    else if(inputPixels[p+3]===255 && inputPixels[p]<4 && inputPixels[p+1]<4 && inputPixels[p+2]<4)opaqueBlack++;
  }
  const recomposed=path.join(dir,'recomposed.png');
  // Always rebuild from the current layers. A restored/corrected report must
  // never leave a previously cropped composition on the process page.
  const rebuilt=await sharp(rawAfter).composite(layers.map(layer=>({
    input:layer.source,left:layer.bbox[0],top:layer.bbox[1],
  }))).png().toBuffer();
  await fs.writeFile(recomposed,rebuilt);
  const inputChecker=path.join(dir,'input_checker.png');
  const afterChecker=path.join(dir,'after_checker.png');
  const recomposedChecker=path.join(dir,'recomposed_checker.png');
  const bboxPreview=path.join(dir,'selected_bbox.png');
  const bboxPreviewChecker=path.join(dir,'bbox_preview_checker.png');
  const bboxSourceChecker=path.join(dir,'bbox_source_checker.png');
  const bboxOriginal=path.join(dir,'bbox_original_reference.png');
  const bboxSafetyChecker=path.join(dir,'bbox_safety_checker.png');
  await checker(loop.input,inputChecker);
  await checker(loop.after,afterChecker);
  await checker(recomposed,recomposedChecker);
  await numberedBboxPreview(loop.input,selected,bboxPreview);
  await numberedBboxPreview(inputChecker,selected,bboxPreviewChecker);
  await numberedBboxPreview(inputChecker,selected.map(item=>({...item,bbox:item.source_bbox || item.bbox})),bboxSourceChecker);
  const {width,height}=await sharp(loop.input).metadata();
  if(loop.geometry_reference)await numberedBboxPreview(loop.geometry_reference,selected,bboxOriginal);
  await numberedBboxPreview(inputChecker,disjointHalo(selected,6,width,height),bboxSafetyChecker);
  const verification={
    refreshed_at:new Date().toISOString(),
    selected_bbox_count:selected.length,
    selected_bbox_intersections:conflicts.length,
    input_transparent_pixels:transparent,
    input_opaque_near_black_pixels:opaqueBlack,
    detection_source:loop.input,
    input_sha256:hash(rawInput),
    after_sha256:hash(rawAfter),
    recomposed_sha256:hash(rebuilt),
    preview_only:true,
    legend:selected.map((el,index)=>({number:index+1,id:el.id,bbox:el.bbox,description:el.description})),
  };
  assert((await fs.readFile(loop.input)).equals(rawInput),'Preview changed the recursive input');
  assert((await fs.readFile(loop.after)).equals(rawAfter),'Preview changed the recursive output');
  Object.assign(loop,{
    recomposed,input_checker:inputChecker,after_checker:afterChecker,
    bbox_preview:bboxPreview,bbox_preview_checker:bboxPreviewChecker,
    bbox_source_checker:bboxSourceChecker,
    ...(loop.geometry_reference?{bbox_original_reference:bboxOriginal}:{}),
    recomposed_checker:recomposedChecker,preview_verification:verification,
    bbox_safety_checker:bboxSafetyChecker,
  });
  await fs.writeFile(path.join(dir,'preview_verification.json'),JSON.stringify(verification,null,2)+'\n','utf8');
  await fs.writeFile(loop.report,JSON.stringify(loop,null,2)+'\n','utf8');
  return verification;
}

module.exports={refreshLoopPreviews,numberedBboxPreview,disjointHalo};
