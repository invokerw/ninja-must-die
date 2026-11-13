const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');
const {placeModelRgba}=require('./bbox_model_rgba.js');

async function imageKey(images, specification) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(specification));
  for (const file of images) hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

// A regenerated cutout can have a different silhouette. Its alpha cannot be
// used as a deletion mask on the earlier source image without leaving ghosts.
// Delete the controller's complete rectangles, then repair the exposed rear.
async function deleteBboxes(source, boxes, output) {
  const {data, info} = await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let deleted = 0;
  for (const {bbox:[x,y,w,h]} of boxes) {
    assert([x,y,w,h].every(Number.isInteger) && w>0 && h>0);
    assert(x>=0 && y>=0 && x+w<=info.width && y+h<=info.height);
    for (let py=y;py<y+h;py++) for (let px=x;px<x+w;px++) {
      const offset=(py*info.width+px)*4;
      if (data[offset+3]) deleted++;
      data.fill(0,offset,offset+4);
    }
  }
  await sharp(data,{raw:info}).png().toFile(output);
  return {deleted_pixels:deleted,mask_source:'controller_source_bboxes',mask_postprocessing:'none',
    deletion_method:'complete_bbox_to_alpha_zero'};
}

// Preserve the atlas coordinate system, including transparent margins inside
// each target. Tight alpha bounds must never be resized to the entire bbox.
async function fixedAtlasTile(modelOutput, layout, index, nativeWidth, nativeHeight) {
  const c=layout.cells[index];
  assert(c && nativeWidth>0 && nativeHeight>0);
  const metadata=await sharp(modelOutput).metadata();
  const sx=metadata.width/layout.width, sy=metadata.height/layout.height;
  assert(Math.abs(sx/sy-1)<=0.02,'Atlas response changed its aspect ratio');
  const left=Math.round((c.x+c.crop_x)*sx),top=Math.round((c.y+c.crop_y)*sy);
  const right=Math.round((c.x+c.crop_x+c.crop_width)*sx);
  const bottom=Math.round((c.y+c.crop_y+c.crop_height)*sy);
  assert(right>left && bottom>top && right<=metadata.width && bottom<=metadata.height);
  return sharp(modelOutput).ensureAlpha().extract({left,top,width:right-left,height:bottom-top})
    .resize(nativeWidth,nativeHeight,{fit:'fill'}).png().toBuffer();
}

async function fixedCellAlphaTile(modelOutput,layout,index,nativeWidth,nativeHeight) {
  const cell=layout.cells[index],{data,info}=await sharp(modelOutput).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const left=Math.round(cell.x*info.width/layout.width),top=Math.round(cell.y*info.height/layout.height);
  const right=Math.min(info.width,Math.round((cell.x+cell.width)*info.width/layout.width));
  const bottom=Math.min(info.height,Math.round((cell.y+cell.height)*info.height/layout.height));
  let x0=right,y0=bottom,x1=-1,y1=-1;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(data[(y*info.width+x)*4+3]>16){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  assert(x1>=x0&&y1>=y0,'Assigned cell has no returned object');
  x0=Math.max(left,x0-2);y0=Math.max(top,y0-2);x1=Math.min(right-1,x1+2);y1=Math.min(bottom-1,y1+2);
  const rect={left:x0,top:y0,width:x1-x0+1,height:y1-y0+1};
  const rendered=await placeModelRgba(modelOutput,rect,[0,0,nativeWidth,nativeHeight]);
  return {buffer:rendered.buffer,rect,placement:rendered.placement};
}

// Opaque scene atlases use neutral gray padding. Locate the returned colored
// rectangle in its assigned cell before resizing; the model can shift the
// entire rectangle a few pixels despite keeping the atlas order.
async function sceneAtlasTile(modelOutput,layout,index,nativeWidth,nativeHeight) {
  const {data,info}=await sharp(modelOutput).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const cell=layout.cells[index],sx=info.width/layout.width,sy=info.height/layout.height;
  assert(Math.abs(sx/sy-1)<=0.02,'Scene atlas aspect ratio changed');
  const left=Math.max(0,Math.round(cell.x*sx)),top=Math.max(0,Math.round(cell.y*sy));
  const right=Math.min(info.width,Math.round((cell.x+cell.width)*sx));
  const bottom=Math.min(info.height,Math.round((cell.y+cell.height)*sy));
  let x0=right,y0=bottom,x1=left-1,y1=top-1;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++) {
    const i=(y*info.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
    if(data[i+3]>=248 && Math.max(r,g,b)-Math.min(r,g,b)>18) {
      x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
    }
  }
  const width=x1-x0+1,height=y1-y0+1;
  const expectedW=cell.crop_width*sx,expectedH=cell.crop_height*sy;
  const aligned=width>=expectedW*0.5&&width<=expectedW*1.5&&height>=expectedH*0.5&&height<=expectedH*1.5;
  if(!aligned)return {buffer:await fixedAtlasTile(modelOutput,layout,index,nativeWidth,nativeHeight),
    method:'fixed_target_rect',model_rect:null};
  return {buffer:await sharp(modelOutput).extract({left:x0,top:y0,width,height})
    .resize(nativeWidth,nativeHeight,{fit:'fill'}).png().toBuffer(),
    method:'returned_scene_rectangle_dimension_correction',model_rect:[x0,y0,width,height]};
}

async function fillMissingPixels(source, layers, output) {
  const original=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const filled=await sharp(source).ensureAlpha().composite(layers.map(layer=>({input:layer.source,
    left:layer.bbox[0],top:layer.bbox[1],blend:'dest-over'}))).raw().toBuffer();
  // Near-opaque source pixels are already filled surfaces. Preserve their
  // original RGBA bytes, rather than mixing another copy of the rear into
  // Sunburst's common alpha=250..254 interiors.
  for(let i=0;i<filled.length;i+=4)if(original.data[i+3]>=248)
    original.data.copy(filled,i,i,i+4);
  await sharp(filled,{raw:original.info}).png().toFile(output);
}

async function alphaStats(file) {
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let transparent=0,partial=0,minimum=255;
  for(let i=3;i<data.length;i+=4) {
    minimum=Math.min(minimum,data[i]);
    if(data[i]===0)transparent++;
    else if(data[i]<255)partial++;
  }
  return {width:info.width,height:info.height,transparent_pixels:transparent,partial_pixels:partial,minimum_alpha:minimum};
}

module.exports={imageKey,deleteBboxes,fixedAtlasTile,fixedCellAlphaTile,sceneAtlasTile,fillMissingPixels,alphaStats};
