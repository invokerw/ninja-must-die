// Keep wide, shallow surfaces at native resolution without upsampling.
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {placeModelRgba}=require('./bbox_model_rgba.js');
function isWideSurface(box){
  const [, ,width,height]=box.source_bbox||box.bbox;
  return ['panel','button'].includes(box.category)&&width>1536&&width/height>4;
}
function splitWideSurface(box){
  const [x,y,width,height]=box.source_bbox||box.bbox;
  const count=Math.ceil(width/1280);assert(count<=7);
  return Array.from({length:count},(_,i)=>{
    const left=x+Math.floor(width*i/count),right=x+Math.floor(width*(i+1)/count);
    const px=Math.max(box.bbox[0],left-6),py=Math.max(box.bbox[1],y-6);
    const pr=Math.min(box.bbox[0]+box.bbox[2],right+6),pb=Math.min(box.bbox[1]+box.bbox[3],y+height+6);
    return {...box,id:`${box.id}_piece_${i+1}`,bbox:[px,py,pr-px,pb-py],source_bbox:[left,y,right-left,height],
      horizontal_piece:{index:i+1,total:count,parent_id:box.id}};
  });
}
function wideRowLayout(boxes){
  const pad=28,gap=24,maxW=Math.max(...boxes.map(b=>b.bbox[2]));
  const scale=Math.min(1.45,(2048-pad*2)/maxW,(2048-boxes.length*pad*2-(boxes.length-1)*gap)/boxes.reduce((n,b)=>n+b.bbox[3],0));
  assert(scale>=1,'Wide strip atlas must have native input coverage');
  const width=Math.ceil((Math.round(maxW*scale)+pad*2)/16)*16;
  let y=0;
  const cells=boxes.map((box,i)=>{
    const cw=Math.round(box.bbox[2]*scale),ch=Math.round(box.bbox[3]*scale);
    const cell={index:i+1,x:0,y,width,height:ch+pad*2,crop_x:pad,crop_y:pad,crop_width:cw,crop_height:ch,native_width:box.bbox[2],native_height:box.bbox[3],input_scale:scale};
    y+=cell.height+gap;return cell;
  });
  const height=Math.max(1024,Math.ceil((y-gap)/16)*16);assert(width<=2048&&height<=2048);
  return {fits:true,width,height,cells,input_scale:scale,packing:'native_wide_rows'};
}
async function joinWideSurface(box,parts,file){
  const [x,y,width,height]=box.bbox,canvas=Buffer.alloc(width*height*4);
  for(const part of parts){
    const raw=await sharp(part.source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const [sx,sy,sw,sh]=part.semantic_bbox||part.source_bbox;
    const [bx,by]=part.bbox;
    assert(sx>=x&&sy>=y&&sx+sw<=x+width&&sy+sh<=y+height);
    assert(sx>=bx&&sy>=by&&sx+sw<=bx+raw.info.width&&sy+sh<=by+raw.info.height);
    for(let row=0;row<sh;row++)raw.data.copy(canvas,((sy-y+row)*width+sx-x)*4,((sy-by+row)*raw.info.width+sx-bx)*4,((sy-by+row)*raw.info.width+sx-bx+sw)*4);
  }
  await sharp(canvas,{raw:{width,height,channels:4}}).png().toFile(file);
  const scales=[0,1].map(axis=>Math.max(...parts.map(p=>p.model_placement.raster_scale[axis])));
  assert(scales.every(s=>s<=1));
  return {...box,source:file,semantic_bbox:box.source_bbox||box.bbox,
    atlas_split_method:'native_wide_disjoint_rgba_strips',
    model_placement:{policy:'model_rgba_downscale_only',scale:scales,raster_scale:scales,geometry_fit:'native_disjoint_surface_strips',resolution_shortfall:parts.some(p=>p.model_placement.resolution_shortfall),rgb_recovery:false,alpha_recovery:false},
    native_surface_pieces:parts.map(p=>({source:p.source,bbox:p.bbox,semantic_bbox:p.semantic_bbox,model_generated_source:p.model_generated_source,model_rect:p.model_rect,model_row_localization:p.model_row_localization,model_placement:p.model_placement}))};
}
function locateWideModelRows(data,info,count){
  const strong=new Uint32Array(info.height),visible=new Uint32Array(info.height);
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    const alpha=data[(y*info.width+x)*4+3];if(alpha)visible[y]++;if(alpha>16)strong[y]++;
  }
  const threshold=Math.max(8,Math.floor(info.width*.15)),bands=[];
  for(let y=0;y<info.height;y++)if(strong[y]>=threshold){
    const start=y;while(y+1<info.height&&strong[y+1]>=threshold)y++;
    bands.push({top:start,bottom:y+1,weight:strong.subarray(start,y+1).reduce((a,b)=>a+b,0)});
  }
  assert(bands.length>=count,'Cannot locate the returned wide strip rows');
  const selected=bands.sort((a,b)=>b.weight-a.weight).slice(0,count).sort((a,b)=>a.top-b.top);
  return selected.map((band,index)=>{
    const lower=index?Math.floor((selected[index-1].bottom+band.top)/2):0;
    const upper=index+1<count?Math.ceil((band.bottom+selected[index+1].top)/2):info.height;
    let top=band.top,bottom=band.bottom;
    const edgeThreshold=Math.max(2,Math.floor(info.width*.01));
    while(top>lower&&visible[top-1]>=edgeThreshold)top--;
    while(bottom<upper&&visible[bottom]>=edgeThreshold)bottom++;
    let left=info.width,right=0;
    for(let y=top;y<bottom;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]){left=Math.min(left,x);right=Math.max(right,x+1);}
    assert(right>left);
    return {left,top,width:right-left,height:bottom-top};
  });
}
async function splitWideModel(model,boxes,layout,directory){
  const fs=require('node:fs/promises'),path=require('node:path');
  const raw=await sharp(model).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const rows=locateWideModelRows(raw.data,raw.info,boxes.length);
  await fs.mkdir(directory,{recursive:true});
  return Promise.all(boxes.map(async(box,i)=>{
    const rect=rows[i];
    // Models can translate complete rows beyond the requested cell boundary.
    // Locate the returned rows globally, in order. Do not add transparent
    // padding to these bounds: fitting that padding creates seams at joins.
    const placed=await placeModelRgba(model,rect,box.bbox,box.source_bbox,false);
    const source=path.join(directory,`${String(i+1).padStart(3,'0')}_${box.id}.png`);
    await fs.writeFile(source,placed.buffer);
    return {...box,source,semantic_bbox:box.source_bbox,model_generated_source:model,model_rect:rect,
      model_row_localization:'returned_wide_rows_without_alpha_padding',
      model_placement:placed.placement,atlas_resize_scale:placed.placement.scale,atlas_split_method:'returned_native_surface_strip'};
  }));
}
module.exports={isWideSurface,splitWideSurface,wideRowLayout,joinWideSurface,splitWideModel,locateWideModelRows};
