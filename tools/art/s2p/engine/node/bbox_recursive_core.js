const {modelFor,qualityFor,getRoute}=require('./model_config.js');
// Shared local bbox/atlas primitives; runtime supplies timing and canvas state.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {jsonrepair}=require('jsonrepair');
const {openaiClient,splitSeedreamAtlasModel}=require('./layerforge.js');
const {imageRequest}=require('./bbox_image_requests.js');
const {repeatedSurfaceGuard,visibleBoxFraction}=require('./bbox_surface_geometry.js');
const {groupCoupledRearCandidates}=require('./rear_coupled_composites.js');
const {imageKey,fixedCellAlphaTile}=require('./bbox_atlas_pixels.js');
const {preserveModelAspect}=require('./bbox_model_rgba.js');
const {visualAtlasBatches}=require('./bbox_visual_atlas.js');
const {isWideSurface,splitWideSurface,wideRowLayout,joinWideSurface,splitWideModel}=require('./bbox_wide_surface.js');
const {checker,layoutFor}=require('./bbox_two_loop_test.js');
const {regionalContext,regionalDetection}=require('./bbox_detection_cache.js');
const {assignHintOwners,combinedPrompt,validateCombined,sourceBox}=require('./bbox_combined_detection.js');
const MODEL=modelFor('background'),CONTROLLER=modelFor('controller');
const BATCH=Number(process.env.BBOX_VISUAL_BATCH_SIZE??7),TEXT_BATCH=14,GEOMETRY_BATCH=7;
assert(Number.isSafeInteger(BATCH)&&BATCH>0,'BBOX_VISUAL_BATCH_SIZE must be a positive integer');
const read=file=>fsp.readFile(file,'utf8').then(JSON.parse);
const write=(file,value)=>fsp.writeFile(file,JSON.stringify(value,null,2)+'\n','utf8');
const overlap=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
// An intact foreground needs only the original appearance pixels. Supplying a
// regenerated text-free rendering alongside them can invite a new rendering.
// Keep both references for surfaces, composites and any crop intersecting a
// previously removed object/text: those need current ownership information.
function intactOriginalTargets(boxes,removed) {
  return boxes.length>0&&removed.every(element=>Array.isArray(element.bbox)&&element.bbox.length===4)&&boxes.every(box=>{
    if(!['icon','artwork','decoration'].includes(box.category)||(box.members||[]).length>1||box.occluded_by?.length)return false;
    const original=box.source_bbox;
    if(!Array.isArray(original)||original.length!==4||!original.every(Number.isFinite)||original[2]<=0||original[3]<=0)return false;
    return !removed.some(element=>overlap(element.bbox,box.bbox)>0);
  });
}
// Tilted or tightly stacked text lines can have intersecting rectangles even
// when their glyphs do not touch. Extract them together instead of clipping a
// line or deferring it past the one-time text removal. Repeat after each union:
// the union itself can intersect a third line that neither member touched.
function groupOverlappingTextTargets(elements) {
  assert(elements.every(el=>el.category==='text'),'Text grouping accepts only text targets');
  const groups=elements.map((el,index)=>({bbox:el.bbox.slice(),members:[el],index}));
  let changed=true;
  while(changed) {
    changed=false;
    for(let i=0;i<groups.length&&!changed;i++)for(let j=i+1;j<groups.length;j++) {
      const a=groups[i],b=groups[j];
      if(!overlap(a.bbox,b.bbox))continue;
      const left=Math.min(a.bbox[0],b.bbox[0]),top=Math.min(a.bbox[1],b.bbox[1]);
      a.bbox=[left,top,Math.max(a.bbox[0]+a.bbox[2],b.bbox[0]+b.bbox[2])-left,
        Math.max(a.bbox[1]+a.bbox[3],b.bbox[1]+b.bbox[3])-top];
      a.members.push(...b.members);groups.splice(j,1);changed=true;break;
    }
  }
  const indexById=new Map(elements.map((el,index)=>[el.id,index]));
  return groups.map(group=>{
    if(group.members.length===1)return group.members[0];
    const members=group.members.sort((a,b)=>indexById.get(a.id)-indexById.get(b.id));
    return {...members[0],id:members[0].id+'_text_group',bbox:group.bbox,
      description:'All original text lines together, preserving their relative positions: '+members.map(el=>el.description||el.id).join('; '),
      occluded_by:[],members:[],internal_front_to_back:[],bbox_grouping:'overlapping_text_union',
      text_group_members:members.map(el=>({id:el.id,description:el.description,bbox:el.bbox.slice()}))};
  });
}
// Add context around each detected target while preserving disjoint deletion
// rectangles. The original detector box is retained as source_bbox for audit.
function expandDisjointBboxes(boxes, padding, canvas) {
  const [width,height]=canvas;
  const originals=boxes.map(item=>item.bbox.slice());
  const expanded=boxes.map((item,index)=>{
    const [x,y,w,h]=originals[index];
    let left=Math.max(0,x-padding),top=Math.max(0,y-padding);
    let right=Math.min(width,x+w+padding),bottom=Math.min(height,y+h+padding);
    originals.forEach((other,j)=>{
      if(index===j)return;
      const [ox,oy,ow,oh]=other;
      const vertical=oy<y+h && oy+oh>y;
      const horizontal=ox<x+w && ox+ow>x;
      if(vertical && ox+ow<=x) left=Math.max(left,ox+ow);
      if(vertical && ox>=x+w) right=Math.min(right,ox);
      if(horizontal && oy+oh<=y) top=Math.max(top,oy+oh);
      if(horizontal && oy>=y+h) bottom=Math.min(bottom,oy);
    });
    return {...item,source_bbox:item.source_bbox || [x,y,w,h],bbox:[left,top,right-left,bottom-top]};
  });
  // Padding on both sides of a narrow gap would otherwise make two expanded
  // rectangles overlap. Split that gap at its midpoint, while keeping each
  // original detector rectangle completely covered.
  for(let i=0;i<expanded.length;i++) for(let j=i+1;j<expanded.length;j++) {
    const a=expanded[i].bbox,b=expanded[j].bbox,oa=originals[i],ob=originals[j];
    if(!overlap(a,b)) continue;
    const ax2=oa[0]+oa[2],ay2=oa[1]+oa[3],bx2=ob[0]+ob[2],by2=ob[1]+ob[3];
    if(ay2<=ob[1] || by2<=oa[1]) {
      const upper=ay2<=ob[1];
      const boundary=Math.round((upper ? ay2 + ob[1] : by2 + oa[1])/2);
      if(upper) {const bottom=b[1]+b[3];a[3]=boundary-a[1];b[1]=boundary;b[3]=bottom-boundary;}
      else {const bottom=a[1]+a[3];b[3]=boundary-b[1];a[1]=boundary;a[3]=bottom-boundary;}
    } else if(ax2<=ob[0] || bx2<=oa[0]) {
      const left= ax2<=ob[0];
      const boundary=Math.round((left ? ax2 + ob[0] : bx2 + oa[0])/2);
      if(left) {const right=b[0]+b[2];a[2]=boundary-a[0];b[0]=boundary;b[2]=right-boundary;}
      else {const right=a[0]+a[2];b[2]=boundary-b[0];a[0]=boundary;a[2]=right-boundary;}
    }
  }
  for(const item of expanded) {
    const [x,y,w,h]=item.bbox;
    item.bbox=[Math.max(0,Math.round(x)),Math.max(0,Math.round(y)),Math.max(1,Math.min(width,Math.round(x+w))-Math.max(0,Math.round(x))),Math.max(1,Math.min(height,Math.round(y+h))-Math.max(0,Math.round(y)))];
    item.bbox_padding=padding;
  }
  return expanded;
}
function scheduleDisjointFrontmost(elements) {
  // Empty frame interiors can overlap another object's bbox without a visible
  // crossing. Keep the semantic depth graph intact and serialize these edits
  // so deleting one whole rectangle cannot erase another same-pass target.
  const frontmost=elements.filter(el=>!el.occluded_by?.length);
  const accepted=[],scheduling=[];
  for(const el of frontmost.slice().sort((a,b)=>a.bbox[2]*a.bbox[3]-b.bbox[2]*b.bbox[3])) {
    const blockers=accepted.filter(other=>overlap(el.bbox,other.bbox));
    if(blockers.length)scheduling.push({id:el.id,reason:'bbox_intersection',wait_for:blockers.map(other=>other.id)});
    else accepted.push(el);
  }
  const chosen=new Set(accepted.map(el=>el.id));
  return {selected:elements.filter(el=>chosen.has(el.id)),deferred:elements.filter(el=>!chosen.has(el.id)),scheduling};
}
function missingRetainedHints(elements,hints) {
  return hints.filter(hint=>!elements.some(el=>{
    const a=hint.bbox[2]*hint.bbox[3],b=el.bbox[2]*el.bbox[3];
    return Math.min(a,b)/Math.max(a,b)>.65 && overlap(hint.bbox,el.bbox)/Math.min(a,b)>.8;
  }));
}
// Adjacent detectors can disagree by half a pixel about which core owns an
// object. Resolve ownership together so both sides cannot discard that object.
function selectRegionalCandidates(elements) {
  const owns=el=>{
    // A reconciled object may cross every local crop. Its constituent views
    // have already established one complete identity before core ownership.
    if(el.regional_geometry_sources?.length>1)return true;
    if(!el.detection_core || el.detection_region==='overview')return true;
    const [x,y,w,h]=el.detection_core,cx=el.bbox[0]+el.bbox[2]/2,cy=el.bbox[1]+el.bbox[3]/2;
    return cx>=x&&cx<x+w&&cy>=y&&cy<y+h;
  };
  const distance=el=>{
    const [x,y,w,h]=el.detection_core,cx=el.bbox[0]+el.bbox[2]/2,cy=el.bbox[1]+el.bbox[3]/2;
    return Math.max(0,x-cx,cx-x-w,y-cy,cy-y-h);
  };
  const complete=el=>{
    const crop=el.detection_crop;if(!crop)return false;
    const [x,y,w,h]=el.bbox;
    return x>crop.left+1&&y>crop.top+1&&x+w<crop.left+crop.width-1&&y+h<crop.top+crop.height-1;
  };
  const sameTarget=(a,b)=>{
    if(a.occluded_by?.includes(b.id)||b.occluded_by?.includes(a.id))return false;
    const foreground=category=>['icon','artwork'].includes(category);
    if(a.category!==b.category&&!(foreground(a.category)&&foreground(b.category)))return false;
    const [, ,aw,ah]=a.bbox,[, ,bw,bh]=b.bbox;
    return Math.min(aw,bw)/Math.max(aw,bw)>.8&&Math.min(ah,bh)/Math.max(ah,bh)>.8&&
      overlap(a.bbox,b.bbox)/Math.min(aw*ah,bw*bh)>.9;
  };
  const accepted=elements.filter(owns),outside=elements.filter(el=>!owns(el)),rescued=new Set(),aliases=new Map();
  for(const el of outside.filter(el=>distance(el)<=4&&complete(el)).sort((a,b)=>distance(a)-distance(b))) {
    const duplicate=accepted.find(other=>sameTarget(el,other));
    if(duplicate)aliases.set(el.id,duplicate.id);
    else {accepted.push(el);rescued.add(el.id);}
  }
  const ids=new Set(accepted.map(el=>el.id));
  for(const el of outside.filter(el=>!ids.has(el.id)&&!aliases.has(el.id))) {
    const duplicate=accepted.find(other=>sameTarget(el,other));
    if(duplicate)aliases.set(el.id,duplicate.id);
  }
  return elements.filter(el=>ids.has(el.id)).map(el=>({...el,
    ...(rescued.has(el.id)?{bbox_region_rescued:true}:{}),
    occluded_by:[...new Set(elements.filter(other=>other.id===el.id||aliases.get(other.id)===el.id)
      .flatMap(other=>other.occluded_by||[]).map(id=>aliases.get(id)||id))].filter(id=>id!==el.id),
  }));
}
function dedupeCandidates(elements) {
  const kept=[],aliases=new Map();
  const ranked=elements.slice().sort((a,b)=>b.bbox[2]*b.bbox[3]-a.bbox[2]*a.bbox[3]);
  for(const el of ranked) {
    const area=el.bbox[2]*el.bbox[3];
    const duplicate=kept.find(other=>{
      if(other.category!==el.category)return false;
      const otherArea=other.bbox[2]*other.bbox[3],ratio=Math.min(otherArea,area)/Math.max(otherArea,area);
      if(overlap(other.bbox,el.bbox)/Math.min(otherArea,area)<=.9)return false;
      if(ratio>.8)return true;
      // An occluding panel can make a local detector stop at the occlusion
      // boundary rather than the crop edge. Prefer the overview's full extent
      // when the same illustration matches across its other axis and anchor.
      if(other.detection_region!=='overview'||el.category!=='artwork'||ratio<=.65)return false;
      const [x,y,w,h]=el.bbox,[ox,oy,ow,oh]=other.bbox;
      return (Math.abs(x-ox)<=8&&Math.abs(x+w-ox-ow)<=8&&(Math.abs(y-oy)<=8||Math.abs(y+h-oy-oh)<=8))||
        (Math.abs(y-oy)<=8&&Math.abs(y+h-oy-oh)<=8&&(Math.abs(x-ox)<=8||Math.abs(x+w-ox-ow)<=8));
    });
    if(duplicate)aliases.set(el.id,duplicate.id);else kept.push(el);
  }
  const ids=new Set(kept.map(el=>el.id));
  return elements.filter(el=>ids.has(el.id)).map(el=>({...el,
    occluded_by:[...new Set(elements.filter(other=>other.id===el.id||aliases.get(other.id)===el.id)
      .flatMap(other=>other.occluded_by||[]).map(id=>aliases.get(id)||id))].filter(id=>id!==el.id),
  }));
}
// Geometry measured before deleting a foreground child remains authoritative.
// Later inventories may rename its parent or locate only a surviving fragment.
function matchOriginalGeometry(element, hints) {
  const identity=element.geometry_identity||element.recovered_hint||element.id;
  // A presence reply can link a surviving component to its old whole-object
  // hint. That link establishes presence, not an interchangeable aspect ratio.
  // Remeasure a newly named foreground fragment instead of fitting it into the
  // parent object's rectangle. Surfaces still recover their complete extent.
  const fragment=target=>/\b(?:fragment|portion|piece|section)\b/.test(String(target.id||'').replace(/_/g,' '))||
    /\b(?:fragment|remaining portion|surviving portion|(?:left|right) side .+ of)\b/i.test(String(target.description||''));
  const partialForeground=['icon','artwork','decoration'].includes(element.category)&&fragment(element);
  const candidates=hints.filter(hint=>(!partialForeground||fragment(hint))&&overlap(element.bbox,hint.geometry_bbox||hint.source_bbox||hint.bbox)>0);
  const description=String(element.description||'').trim().toLowerCase();
  const exact=candidates.filter(hint=>(hint.geometry_identity||hint.id)===identity ||
    (description&&String(hint.description||'').trim().toLowerCase()===description));
  if(exact.length===1)return exact[0];
  if(exact.length>1)return exact.sort((a,b)=>overlap(element.bbox,b.geometry_bbox||b.bbox)-overlap(element.bbox,a.geometry_bbox||a.bbox))[0];
  const words=id=>new Set(String(id).toLowerCase().replace(/^(?:pending_)?(?:roi_\d+_|overview_)/,'').split('_')
    .filter(word=>!['top','exp','experience','progress'].includes(word))
    .map(word=>({bg:'backplate',background:'backplate',container:'backplate',panel:'backplate'}[word]||word)));
  const a=words(identity);
  const similar=candidates.map(hint=>{
    const b=words(hint.geometry_identity||hint.id),common=[...a].filter(word=>b.has(word));
    const box=hint.geometry_bbox||hint.source_bbox||hint.bbox;
    const covered=overlap(element.bbox,box)/Math.min(box[2]*box[3],element.bbox[2]*element.bbox[3]);
    return {hint,score:common.length/(a.size+b.size-common.length),covered,common:common.length};
  }).filter(item=>item.common>=2&&item.score>=.65&&item.covered>=.6).sort((a,b)=>b.score-a.score);
  if(similar.length&&(!similar[1]||similar[0].score-similar[1].score>=.15))return similar[0].hint;
  // An empty surface is often renamed after its child is removed. A unique
  // nearby surface of the same scale can retain identity without wording.
  // Small inset controls and icons cannot inherit their parent's geometry.
  if(['panel','button'].includes(element.category)) {
    const [x,y,w,h]=element.bbox;
    const surfaces=candidates.filter(hint=>{
      if(!['panel','button'].includes(hint.category))return false;
      const [hx,hy,hw,hh]=hint.geometry_bbox||hint.source_bbox||hint.bbox;
      const ratio=(w*h)/(hw*hh),covered=overlap(element.bbox,[hx,hy,hw,hh])/Math.min(w*h,hw*hh);
      return ratio>=.65&&ratio<=1.5&&covered>=.85&&
        Math.abs(x+w/2-hx-hw/2)<=Math.max(w,hw)*.2&&Math.abs(y+h/2-hy-hh/2)<=Math.max(h,hh)*.2;
    });
    const identities=new Map(surfaces.map(hint=>[hint.geometry_identity||hint.id,hint]));
    if(identities.size===1)return identities.values().next().value;
  }
  return null;
}
function alignMeasuredGeometry(detected,measured,category) {
  const area=Math.min(detected[2]*detected[3],measured[2]*measured[3]);
  let consistent=overlap(detected,measured)>=area*.5;
  if(['icon','artwork','decoration','text'].includes(category)) {
    const widthRatio=measured[2]/detected[2],heightRatio=measured[3]/detected[3];
    const shiftX=Math.abs(measured[0]+measured[2]/2-detected[0]-detected[2]/2);
    const shiftY=Math.abs(measured[1]+measured[3]/2-detected[1]-detected[3]/2);
    consistent &&= widthRatio>=.75&&widthRatio<=1.3&&heightRatio>=.75&&heightRatio<=1.3&&
      shiftX<=Math.max(2,detected[2]*.2)&&shiftY<=Math.max(2,detected[3]*.2);
  }
  let bbox=(consistent?measured:detected).slice();
  if(consistent&&['icon','artwork','decoration','text'].includes(category)) {
    // Remeasurement can refine context but must not crop away pixels already
    // located by the first detector (e.g. orb 83x100 -> 64x90).
    const left=Math.min(detected[0],measured[0]),top=Math.min(detected[1],measured[1]);
    bbox=[left,top,Math.max(detected[0]+detected[2],measured[0]+measured[2])-left,
      Math.max(detected[1]+detected[3],measured[1]+measured[3])-top];
  }
  return {bbox,rejected:!consistent};
}
function validateBackgroundConfirmation(reply) {
  assert(reply&&typeof reply==='object'&&!Array.isArray(reply),'Expected background confirmation object');
  assert.equal(typeof reply.background_only,'boolean','Missing background_only');
  assert(Array.isArray(reply.remaining_elements),'Missing remaining_elements');
  if(reply.background_only)assert.equal(reply.remaining_elements.length,0,'Background-only reply contains targets');
  else assert(reply.remaining_elements.length>0,'No remaining objects located');
  for(const element of reply.remaining_elements) {
    element.box ??= element.box_2d;
    if(Number.isFinite(element.id))element.id=String(element.id);
    assert(typeof element.id==='string'&&element.id.length>0,'Missing remaining object id');
    const b=element.box;
    assert(Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]<=1000&&b[3]<=1000&&b[2]>b[0]&&b[3]>b[1],'Invalid remaining object bbox');
  }
}
function pruneClippedOverviewDuplicates(elements,canvas) {
  const overview=elements.filter(el=>el.detection_region==='overview');
  const surfaces=category=>['panel','button'].includes(category);
  const aliases=new Map();
  const kept=elements.filter(el=>{
    const crop=el.detection_crop;if(!crop || el.detection_region==='overview')return true;
    const [x,y,w,h]=el.bbox,[width,height]=canvas;
    const clippedX=(crop.left>0 || crop.left+crop.width<width) && Math.abs(x-crop.left)<=4 && Math.abs(x+w-crop.left-crop.width)<=4;
    const clippedY=(crop.top>0 || crop.top+crop.height<height) && Math.abs(y-crop.top)<=4 && Math.abs(y+h-crop.top-crop.height)<=4;
    const touchesInteriorEdge=(crop.left>0&&Math.abs(x-crop.left)<=4)||
      (crop.top>0&&Math.abs(y-crop.top)<=4)||
      (crop.left+crop.width<width&&Math.abs(x+w-crop.left-crop.width)<=4)||
      (crop.top+crop.height<height&&Math.abs(y+h-crop.top-crop.height)<=4);
    // Function words vary between local and whole-object descriptions and
    // must not dilute matching material/object evidence at a clipped edge.
    const stopwords=new Set(['a','an','the','and','or','of','with','in','on','at','to','for','from','by','is','its']);
    const words=description=>new Set((String(description||'').toLowerCase().match(/[a-z]+/g)||[]).filter(word=>!stopwords.has(word)));
    // Regional descriptions can name only visible body parts. The controller's
    // shared descriptive identity is additional evidence for the same object;
    // bare categories/numeric ids still require the appearance checks below.
    const identity=target=>String(target.id||'').replace(/^(?:(?:roi_\d+|overview)_)+/,'');
    const namedIdentity=full=>identity(el)===identity(full)&&(identity(el).match(/[a-z]{2,}/gi)||[]).length>=2;
    const sameAppearance=full=>{const a=words(el.description),b=words(full.description);return namedIdentity(full)||(a.size>0&&[...a].filter(word=>b.has(word)).length/Math.min(a.size,b.size)>=.4);};
    const adjacent=elements.filter(full=>full!==el&&full.detection_region!==el.detection_region&&
      surfaces(full.category)&&surfaces(el.category)&&
      !full.occluded_by?.includes(el.id)&&!el.occluded_by?.includes(full.id)).sort((a,b)=>b.bbox[2]*b.bbox[3]-a.bbox[2]*a.bbox[3]);
    const extendsAcrossEdge=full=>{
      const [fx,fy,fw,fh]=full.bbox,rx=x+w,by=y+h,fr=fx+fw,fb=fy+fh;
      const sameY=h/fh>.75&&h/fh<1.25&&Math.min(Math.abs(y-fy),Math.abs(by-fb))<=8;
      const sameX=w/fw>.75&&w/fw<1.25&&Math.min(Math.abs(x-fx),Math.abs(rx-fr))<=8;
      return (sameY&&((crop.left>0&&Math.abs(x-crop.left)<=4&&fx<x-8&&Math.abs(rx-fr)<=16)||
        (crop.left+crop.width<width&&Math.abs(rx-crop.left-crop.width)<=4&&fr>rx+8&&Math.abs(x-fx)<=16)))||
        (sameX&&((crop.top>0&&Math.abs(y-crop.top)<=4&&fy<y-8&&Math.abs(by-fb)<=16)||
        (crop.top+crop.height<height&&Math.abs(by-crop.top-crop.height)<=4&&fb>by+8&&Math.abs(y-fy)<=16)));
    };
    const complete=overview.find(full=>full.category===el.category &&
      !full.occluded_by?.includes(el.id)&&!el.occluded_by?.includes(full.id)&&overlap(full.bbox,el.bbox)/(w*h)>.85 &&
      ((touchesInteriorEdge&&full.bbox[2]*full.bbox[3]>w*h*1.2&&
        (sameAppearance(full)||(w/full.bbox[2]>.85&&w/full.bbox[2]<1.15)||(h/full.bbox[3]>.85&&h/full.bbox[3]<1.15)))||
       (clippedX && h/full.bbox[3]>.75 && h/full.bbox[3]<1.25) ||
       (clippedY && w/full.bbox[2]>.75 && w/full.bbox[2]<1.25)))||
      adjacent.find(full=>touchesInteriorEdge&&full.bbox[2]*full.bbox[3]>w*h*1.2&&overlap(full.bbox,el.bbox)/(w*h)>.85&&extendsAcrossEdge(full));
    if(complete){
      aliases.set(el.id,complete.id);
      // Local fragments can supply the last visible pixels omitted by the
      // overview. Preserve that full envelope while retaining one identity.
      const [fx,fy,fw,fh]=complete.bbox,left=Math.min(fx,x),top=Math.min(fy,y);
      complete.bbox=[left,top,Math.max(fx+fw,x+w)-left,Math.max(fy+fh,y+h)-top];
      complete.occluded_by=[...new Set([...(complete.occluded_by||[]),...(el.occluded_by||[])])];
      return false;
    }return true;
  });
  return kept.map(el=>({...el,occluded_by:[...new Set((el.occluded_by||[]).map(id=>aliases.get(id)||id))].filter(id=>id!==el.id)}));
}
// Two overlapping local crops can EACH clip a different side of the same
// object. Neither view is a complete duplicate, so reconcile their extents
// before choosing the owning core or accepting their original measurements.
function reconcileClippedRegionalCandidates(elements,canvas) {
  const [width,height]=canvas;
  const groups=elements.map(element=>({element:{...element,bbox:element.bbox.slice()},sources:[element]}));
  const edges=element=>{
    const c=element.detection_crop,[x,y,w,h]=element.bbox;
    if(!c||element.detection_region==='overview')return {};
    return {left:c.left>0&&Math.abs(x-c.left)<=4,right:c.left+c.width<width&&Math.abs(x+w-c.left-c.width)<=4,
      top:c.top>0&&Math.abs(y-c.top)<=4,bottom:c.top+c.height<height&&Math.abs(y+h-c.top-c.height)<=4};
  };
  const words=value=>new Set((String(value||'').toLowerCase().match(/[a-z]+/g)||[])
    .filter(word=>!['a','an','the','and','or','of','with','in','on','at','to','for','from','by','is','its'].includes(word)));
  const compatible=(a,b)=>{
    const surface=element=>['panel','button'].includes(element.category);
    const foreground=element=>['icon','artwork'].includes(element.category);
    if(a.category!==b.category&&!(surface(a)&&surface(b))&&!(foreground(a)&&foreground(b)))return false;
    if(surface(a)&&surface(b))return true;
    const aw=words(a.description),bw=words(b.description),common=[...aw].filter(word=>bw.has(word));
    return common.length>=2&&common.length/Math.min(aw.size,bw.size)>=.4;
  };
  const matches=(a,b)=>{
    if(a.detection_region===b.detection_region||!compatible(a,b))return false;
    const ae=edges(a),be=edges(b),[x,y,w,h]=a.bbox,[bx,by,bw,bh]=b.bbox;
    const surface=['panel','button'].includes(a.category)&&['panel','button'].includes(b.category);
    if(overlap(a.bbox,b.bbox)/Math.min(w*h,bw*bh)<(surface ? .7 : .8))return false;
    const sameY=Math.min(h,bh)/Math.max(h,bh)>=.8&&Math.min(Math.abs(y-by),Math.abs(y+h-by-bh))<=8;
    const sameX=Math.min(w,bw)/Math.max(w,bw)>=.8&&Math.min(Math.abs(x-bx),Math.abs(x+w-bx-bw))<=8;
    const horizontal=(ae.right&&bx+bw>x+w+8&&(be.left&&x<bx-8||Math.abs(x-bx)<=16))||
      (be.right&&x+w>bx+bw+8&&(ae.left&&bx<x-8||Math.abs(x-bx)<=16))||
      (ae.left&&bx<x-8&&Math.abs(x+w-bx-bw)<=16)||(be.left&&x<bx-8&&Math.abs(x+w-bx-bw)<=16);
    const vertical=(ae.bottom&&by+bh>y+h+8&&(be.top&&y<by-8||Math.abs(y-by)<=16))||
      (be.bottom&&y+h>by+bh+8&&(ae.top&&by<y-8||Math.abs(y-by)<=16))||
      (ae.top&&by<y-8&&Math.abs(y+h-by-bh)<=16)||(be.top&&y<by-8&&Math.abs(y+h-by-bh)<=16);
    return sameY&&horizontal||sameX&&vertical;
  };
  const union=boxes=>{
    const left=Math.min(...boxes.map(b=>b[0])),top=Math.min(...boxes.map(b=>b[1]));
    return [left,top,Math.max(...boxes.map(b=>b[0]+b[2]))-left,Math.max(...boxes.map(b=>b[1]+b[3]))-top];
  };
  let changed=true;
  while(changed){
    changed=false;
    for(let i=0;i<groups.length&&!changed;i++)for(let j=i+1;j<groups.length;j++){
      const a=groups[i],b=groups[j],ids=new Set([...a.sources,...b.sources].map(element=>element.id));
      // An explicit front/behind relationship establishes independent layers.
      if([...a.sources,...b.sources].some(element=>(element.occluded_by||[]).some(id=>ids.has(id))))continue;
      if(!a.sources.some(left=>b.sources.some(right=>matches(left,right))))continue;
      a.sources.push(...b.sources);a.element.bbox=union(a.sources.map(element=>element.bbox));
      a.element.regional_aliases=a.sources.map(element=>element.id);
      a.element.regional_geometry_sources=a.sources.map(element=>({id:element.id,region:element.detection_region,bbox:element.bbox.slice(),
        original_measurement:element.original_measurement||null}));
      a.element.bbox_reconciliation='cross_region_clipped_union';
      // The full unmarked reference must include every original fragment too.
      a.element.original_measurement=a.sources.every(element=>element.original_measurement?.present)
        ?{present:true,bbox:union(a.sources.map(element=>element.original_measurement.bbox))}:undefined;
      a.element.occluded_by=[...new Set(a.sources.flatMap(element=>element.occluded_by||[]))];
      groups.splice(j,1);changed=true;break;
    }
  }
  const aliases=new Map(groups.flatMap(group=>group.sources.map(element=>[element.id,group.element.id])));
  return groups.map(({element})=>({...element,occluded_by:[...new Set((element.occluded_by||[]).map(id=>aliases.get(id)||id))].filter(id=>id!==element.id)}));
}
function createCore({state,step}) {
async function bboxPreview(source, boxes, output) {
  const {width,height}=await sharp(source).metadata(), raw=Buffer.alloc(width*height*4);
  for(const box of boxes) {
    const [x,y,w,h]=box.bbox;
    for(let t=0;t<3;t++) {
      const pixel=(px,py)=>{if(px<0||py<0||px>=width||py>=height)return; const o=(py*width+px)*4;raw[o]=255;raw[o+1]=65;raw[o+2]=105;raw[o+3]=255;};
      for(let px=x;px<x+w;px++){pixel(px,y+t);pixel(px,y+h-1-t);}
      for(let py=y;py<y+h;py++){pixel(x+t,py);pixel(x+w-1-t,py);}
    }
  }
  const lines=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer();
  await sharp(source).composite([{input:lines}]).png().toFile(output);
}

async function ask(images, prompt, dir, maxTokens=16384, validate=null) {
  await fsp.mkdir(dir,{recursive:true});
  const requestPath=path.join(dir,'request.json'),responsePath=path.join(dir,'response.json');
  const reasoningEffort=['pending_bbox_discovery','compact_depth_review'].includes(path.basename(dir))?'low':null;
  const cacheKey=await imageKey(images,{model:CONTROLLER,prompt,maxTokens,...(reasoningEffort?{reasoning_effort:reasoningEffort}:{})});
  if(fs.existsSync(requestPath)&&fs.existsSync(responsePath)) {
    const previousRequest=await read(requestPath),previousResponse=await read(responsePath);
    if(previousRequest.cache_key===cacheKey && previousResponse.cache_key===cacheKey && previousResponse.finish_reason!=='length' && previousResponse.content) {
      try {const parsed=JSON.parse(jsonrepair(previousResponse.content));if(validate)validate(parsed);return parsed;}
      catch(error) {if(!validate)throw error;}
    }
  }
  let feedback='';
  for(let attempt=0;attempt<(validate?2:1);attempt++) {
    const actualPrompt=prompt+feedback;
    await write(requestPath,{model:CONTROLLER,images,prompt:actualPrompt,base_prompt:prompt,max_completion_tokens:maxTokens,reasoning_effort:reasoningEffort,cache_key:cacheKey,attempt:attempt+1});
    const start=Date.now();
    const payload={model:CONTROLLER,...(reasoningEffort?{reasoning_effort:reasoningEffort}:{}),
      max_completion_tokens:maxTokens,response_format:{type:'json_object'},messages:[
      {role:'system',content:'Return a valid JSON object.'},
      {role:'user',content:[
        ...images.map(image=>({type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(image).toString('base64'),detail:'high'}})),
        {type:'text',text:actualPrompt}]}]};
    let response,transientAttempts=0;
    for(;;) {
      try {response=await openaiClient('controller').chat.completions.create(payload);break;}
      catch(error) {
        const status=error.status||error.statusCode;
        if(payload.reasoning_effort&&status===400&&/reasoning[_ -]?effort/i.test(error.message||'')&&/unsupported|not support|unknown|invalid|allowed|permitted/i.test(error.message||'')) {
          payload.reasoning_effort=null;
          await write(path.join(dir,'request_reasoning_fallback.json'),{model:CONTROLLER,images,prompt:actualPrompt,max_completion_tokens:maxTokens,reasoning_effort:null});
          console.log(JSON.stringify({stage:'controller_reasoning_fallback',region:path.basename(dir),reason:'parameter_not_supported'}));
          continue;
        }
        const transient=[408,409,425,429,500,502,503,504].includes(status)||/timeout|timed out|connection error|ECONNRESET|socket hang up|gateway/i.test(error.message||'');
        if(!transient||transientAttempts>=1)throw error;
        transientAttempts++;
        const delay=status===429?30000:3000;
        console.log(JSON.stringify({stage:'controller_transient_retry',region:path.basename(dir),retry:transientAttempts,status:status||'network',delay_s:delay/1000}));
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
    const content=String(response.choices?.[0]?.message?.content||'');
    const record={content,cache_key:cacheKey,reasoning_effort:payload.reasoning_effort||null,usage:response.usage,finish_reason:response.choices?.[0]?.finish_reason,elapsed_ms:Date.now()-start};
    try {
      assert.notEqual(record.finish_reason,'length','Controller output was truncated');
      const parsed=JSON.parse(jsonrepair(content));if(validate)validate(parsed);
      await write(responsePath,record);return parsed;
    } catch(error) {
      record.validation_error=error.message;
      await write(responsePath,record);
      await write(path.join(dir,`response_rejected_${Date.now()}.json`),record);
      if(!validate||attempt===1)throw error;
      feedback=` Your previous reply failed format validation: ${error.message}. Return the complete JSON OBJECT using the exact schema specified above, never a bare array. Every box must contain four finite normalized numbers inside 0..1000 with positive width and height. Preserve every requested ID and entry.`;
      console.log(JSON.stringify({stage:'bbox_format_retry',region:path.basename(dir),retry:attempt+1}));
    }
  }
}

function validateDetection(parsed) {
  assert(parsed&&!Array.isArray(parsed)&&typeof parsed==='object','Expected detection JSON object');
  assert.equal(parsed.coordinate_space,'yxyx_1000');
  assert(Array.isArray(parsed.elements),'Missing detection elements array');
  for(const el of parsed.elements) {
    assert(typeof el.id==='string'&&el.id.length>0,'Missing bbox id');
    assert(Array.isArray(el.box)&&el.box.length===4,'Invalid normalized bbox');
    const [y0,x0,y1,x1]=el.box;
    assert(el.box.every(Number.isFinite)&&x1>x0&&y1>y0&&x0>=0&&y0>=0&&x1<=1000&&y1<=1000,'Invalid normalized bbox');
  }
}

function regions(width,height) {
  return Array.from({length:6},(_,i)=>{
    const col=i%3,row=Math.floor(i/3), x0=Math.floor(col*width/3),x1=Math.floor((col+1)*width/3);
    const y0=Math.floor(row*height/2),y1=Math.floor((row+1)*height/2), guard=80;
    const left=Math.max(0,x0-guard),top=Math.max(0,y0-guard),right=Math.min(width,x1+guard),bottom=Math.min(height,y1+guard);
    return {id:'roi_'+(i+1),core:[x0,y0,x1-x0,y1-y0],crop:{left,top,width:right-left,height:bottom-top}};
  });
}

async function detect(source, dir, mode, removed=[], retainedHints=[]) {
  const {width,height}=await sharp(source).metadata();
  const referenceSource=mode==='visual' ? state.source : null;
  const incremental=mode==='visual'&&process.env.BBOX_INCREMENTAL_DETECTION!=='0';
  const combined=mode==='visual'&&process.env.BBOX_COMBINED_DETECTION==='1';
  const detectionRegions=[...regions(width,height),{id:'overview',core:[0,0,width,height],crop:{left:0,top:0,width,height}}];
  const hintOwners=combined?assignHintOwners(retainedHints,detectionRegions):null;
  const priorChecks=[];
  const reuseRecords=[];
  const wholeChecker=path.join(dir,'detection_current_checker.png');
  await checker(source,wholeChecker);
  const results=await Promise.allSettled(detectionRegions.map(async region=>{
    const target=path.join(dir,'detection',region.id);await fsp.mkdir(target,{recursive:true});
    const crop=path.join(target,'input.png');await sharp(source).extract(region.crop).png().toFile(crop);
    const image=path.join(target,'checker.png');await checker(crop,image);
    const reference=path.join(target,'original_reference.png');
    if(referenceSource)await sharp(referenceSource).extract(region.crop).png().toFile(reference);
    const scoped=mode==='visual'&&region.id!=='overview';
    const localRemoved=scoped?regionalContext(removed,region.crop):removed;
    const localHints=scoped?regionalContext(retainedHints,region.crop):retainedHints;
    const geometryReference=referenceSource?` Image 3 is the ORIGINAL UNMARKED same-coordinate crop, without deletion holes. Use Image 1 to decide which objects still survive; use Image 3 to recover their complete original geometry, rounded corners, glow and hidden extent. Rectangular holes are missing evidence, NEVER an object's new edge or a division into separate targets. A panel partly deleted behind an icon remains ONE full original panel, not only its surviving right-hand fragment. A progress fill keeps its original start/end, including the part hidden by a removed badge. Do not invent a new panel in an originally empty name/text area. Never return previously removed icons, text or artwork just because they remain in Image 3. Original text is reference only and is already removed. Preserve one semantic target identity; do not return both a fragment and its complete target.`:'';
    const common=`Image 1 is a local enlarged crop of Image 2, the whole current scene. Gray/white checkerboard in both current images represents transparent EMPTY pixels.${geometryReference} Return coordinates ONLY in normalized yxyx_1000 of Image 1: [y_min,x_min,y_max,x_max]. Cover the COMPLETE target extent and its own antialiasing, outline, glow and shadow; do not clip protrusions. Do not add padding; the caller adds safe context after scheduling. Never report source pixels or whole-scene normalized coordinates. Include an object crossing a crop edge only if you can locate its FULL extent inside Image 1. No environmental scenery targets, no full-screen background. Background means the coherent natural scenery, including rocks, plants and terrain. All HUD panels, footer strips, rings, glows, controls, independent props and featured foreground subjects are editable elements. Featured playable vehicles, vessels, aircraft, movable machines, characters and creatures are separate artwork layers, even when rendered photorealistically inside the setting without a UI frame. A featured vehicle or character is NOT natural scenery or fixed architecture. Include its full visible silhouette, wheels, wings, thrusters, arms, cables and other attachments as one semantic target; record any overlapping foreground panel as a blocker. Fixed structural machinery and mounted scenery decorations remain part of the coherent setting. If none remain in this crop return background_only=true and elements=[]. IDs must be short ASCII snake_case. Return JSON {"coordinate_space":"yxyx_1000","background_only":false,"scene":"short reason","elements":[{"id":"unique","category":"text/icon/button/panel/decoration/artwork","description":"actual appearance, target only","box":[y0,x0,y1,x1],"occluded_by":["ids from this response"],"members":[],"internal_front_to_back":[]}]}.
`;
    const task=mode==='text'
      ? `Find EVERY ordinary UI text label and number, including values on badges, short navigation captions, resource counters and independent titles. Each line is one category=text target containing ONLY glyphs and their outlines/shadows, never its icon or backplate. Numeric glyphs inside shield/coin/circle artwork are removable ordinary text. Keep fused non-readable emblem artwork. Non-text elements must not be returned. All text is frontmost, occluded_by=[]; members=[]; internal_front_to_back=[].`
      : `Find all independently editable surviving non-text raster objects: UI objects, standalone props and character/creature illustrations, both current frontmost targets and immediately visible deeper surfaces. Independently bounded artwork, badges, controls and backplates have separate targets; a panel surface waits behind every visible icon covering it. Record actual direct blockers in occluded_by. CURRENT FRONTMOST bbox rectangles must not overlap each other; do not truncate any object's full bbox to force this. Important coupled-composite exception: a translucent circular glow/ring overlapping a map/illustration in the same control MUST be ONE target bbox covering BOTH full extents, with members naming ring and artwork, internal_front_to_back=["ring","artwork"]. Keep the luminous ring composited ABOVE the map wherever they intersect; never put the map on top of the ring. The control backplate remains a separate deeper target. Any independently visible foreground prop in front of this composite stays separate, and the composite is deferred behind that prop. Do not return separate ring or map targets in addition to this composite. Ring geometry must remain circular with its observed center and radius. Ordinary readable text has been removed; do not invent or box empty text positions. Removed earlier targets must stay absent: ${JSON.stringify(localRemoved.map(x=>({id:x.id,description:x.description})))}.`;
    const overviewTask=region.id==='overview'
      ? ` This is a whole-canvas overview. Return objects wider than ${Math.floor(width/3+120)} source pixels or taller than ${Math.floor(height/2+120)} source pixels, plus ANY complete object whose full bbox cannot fit within any of these local XYWH crops: ${JSON.stringify(regions(width,height).map(r=>[r.crop.left,r.crop.top,r.crop.width,r.crop.height]))}. This includes foreground character illustrations, tall translucent panels and continuous full-width bars crossing crop boundaries. Return full object extents; never fragments. Ordinary small targets fully contained in a local crop belong to local detection. ${mode==='text'?'Return ONLY text; the same crop-coverage rule applies to long text lines.':''}`:'';
    let prompt=common+task+` Previous rounds found these deeper candidates; inspect their CURRENT visible pixels so a surviving plain backplate is not forgotten. Hints are SOURCE XYWH on the whole scene, not output coordinates. Do not invent a candidate that is absent now. Still return CURRENT crop-normalized full extents: ${JSON.stringify(localHints.map(el=>({description:el.description,bbox:el.bbox})))}`+overviewTask;
    const ownedHints=combined?hintOwners.get(region.id):[];
    if(combined)prompt+=combinedPrompt(ownedHints);
    const validateReply=parsed=>{validateDetection(parsed);if(combined)validateCombined(parsed,ownedHints);};
    const localInputs=scoped&&process.env.BBOX_LOCAL_DETECTION==='1';
    if(localInputs)prompt=prompt.replace('Image 1 is a local enlarged crop of Image 2, the whole current scene. Gray/white checkerboard in both current images represents transparent EMPTY pixels.',
      'Image 1 is the CURRENT local crop. Its gray/white checkerboard represents transparent EMPTY pixels. The caller separately checks the whole canvas and resolves cross-region depth.').replace('Image 3 is the ORIGINAL UNMARKED same-coordinate crop','Image 2 is the ORIGINAL UNMARKED same-coordinate crop').replaceAll('use Image 3','use Image 2').replaceAll('in Image 3','in Image 2');
    const detectionImages=localInputs?[image,reference]:[image,wholeChecker,...(referenceSource?[reference]:[])];
    const result=await regionalDetection({enabled:incremental,region,images:[crop,...(referenceSource?[reference]:[])],
      context:{model:CONTROLLER,canvas:[width,height],prompt,maxTokens:16384,
        removed:localRemoved.map(el=>({id:el.id,description:el.description,bbox:el.bbox})),
        hints:localHints.map(el=>({id:el.id,description:el.description,bbox:el.bbox,occluded_by:el.occluded_by||[]}))},
      directory:target,cacheRoot:path.join(path.dirname(dir),'regional_detection_cache'),
      request:()=>ask(detectionImages,prompt,target,16384,validateReply),validate:validateReply});
    const {parsed}=result;reuseRecords.push(result.reuse);
    if(combined)priorChecks.push(...parsed.hint_checks.map(check=>({...check,region:region.id,element_id:check.element_id?region.id+'_'+check.element_id:null})));
    assert.equal(parsed.coordinate_space,'yxyx_1000');
    const entries=parsed.elements.map(el=>{
      const [y0,x0,y1,x1]=el.box;assert(x1>x0&&y1>y0&&x0>=0&&y0>=0&&x1<=1000&&y1<=1000,'Invalid normalized bbox');
      const x=region.crop.left+Math.floor(x0*region.crop.width/1000),y=region.crop.top+Math.floor(y0*region.crop.height/1000);
      const right=region.crop.left+Math.ceil(x1*region.crop.width/1000),bottom=region.crop.top+Math.ceil(y1*region.crop.height/1000);
      return {...el,id:region.id+'_'+el.id,occluded_by:(el.occluded_by||[]).map(id=>region.id+'_'+id),bbox:[x,y,right-x,bottom-y],
        ...(combined?{original_measurement:{present:el.original_present,bbox:el.original_present?sourceBox(el.original_box,region.crop):null},
          ...(parsed.hint_checks.find(check=>check.status==='present'&&check.element_id===el.id)?{recovered_hint:parsed.hint_checks.find(check=>check.status==='present'&&check.element_id===el.id).hint_id}:{})}:{}),
        detection_region:region.id,detection_crop:region.crop,detection_core:region.core,geometry_reference:referenceSource};
    });
    return entries;
  }));
  const detectionReuse={mode:mode==='text'?'text':incremental?'regional_cache_v1':'full',reused_regions:reuseRecords.filter(r=>r.status==='reused').length,
    regional_count:6,overview_always_checked:true,regions:reuseRecords.sort((a,b)=>a.region.localeCompare(b.region))};
  await write(path.join(dir,'detection_reuse.json'),detectionReuse);
  if(mode==='visual')console.log(JSON.stringify({stage:'regional_detection_reuse',reused:detectionReuse.reused_regions,total:6}));
  const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new Error(failures.map(result=>String(result.reason)).join('\n'));
  const rawElements=selectRegionalCandidates(reconcileClippedRegionalCandidates(
    pruneClippedOverviewDuplicates(results.flatMap(result=>result.value),[width,height]),[width,height]));
  const unique=dedupeCandidates(rawElements);
  let elements=mode==='text'?unique:groupCoupledRearCandidates(unique);
  if(mode==='text'&&!elements.some(el=>el.category==='text')) {
    const plan={source,canvas:[width,height],mode,elements:[],selected:[],deferred:[],conflicts:[],no_text:true};
    await write(path.join(dir,'plan.json'),plan);return plan;
  }
  // A deferred surface can disappear from a fresh inventory even though its
  // pixels remain. Resolve all missing reminders together before deleting
  // anything. This is bbox discovery, not image-quality review or regeneration.
  const confirmedAbsent=new Set(priorChecks.filter(check=>check.status==='absent').map(check=>check.hint_id));
  const confirmedPresent=new Set(priorChecks.filter(check=>check.status==='present'&&elements.some(element=>
    element.id===check.element_id||element.regional_aliases?.includes(check.element_id)||element.recovered_hint===check.hint_id||element.members?.includes(check.element_id))).map(check=>check.hint_id));
  const missing=mode==='text'?[]:missingRetainedHints(elements,retainedHints).filter(hint=>!confirmedAbsent.has(hint.id)&&!confirmedPresent.has(hint.id));
  let continuity=combined?{inventory_hint_checks:priorChecks}:null;
  if(missing.length) {
    const hints=missing.map(el=>({id:el.id,description:el.description,bbox:el.bbox,already_found:elements.filter(other=>overlap(other.bbox,el.bbox)).map(other=>({description:other.description,bbox:other.bbox}))}));
    const parsed=await ask([wholeChecker,...(referenceSource?[referenceSource]:[])],`Check these ${missing.length} pending objects in ONE pass. Image 1 is CURRENT pixels with checkerboard for deleted regions. Image 2 is ORIGINAL geometry reference only. An empty backplate can survive after its old icon was removed. A transparent deletion rectangle is not a new object boundary: recover the surviving target's FULL original bbox from Image 2. Do not invent surfaces in originally empty name/text regions or restore removed objects. Return immediately {"checks":[{"hint_id":"exact hint id","present":true,"element":{"id":"short ASCII id","category":"panel/button/icon/decoration/artwork","description":"brief current appearance","box":[y_min,x_min,y_max,x_max]}}]}. Return exactly one check per hint. If absent or already represented by an already_found candidate, present=false and element=null. Coordinates are normalized yxyx_1000 on this whole image; hints and already_found use SOURCE XYWH. Cover the complete actual target, not its old child. No scenery, invention or lengthy explanation. Hints:${JSON.stringify(hints)}`,path.join(dir,'pending_bbox_discovery'),16384);
    assert(Array.isArray(parsed.checks)&&parsed.checks.length===missing.length,'Missing pending bbox checks');
    const checked=new Set();
    for(const check of parsed.checks) {
      assert(missing.some(h=>h.id===check.hint_id)&&!checked.has(check.hint_id),'Invalid pending hint id');checked.add(check.hint_id);
      assert(typeof check.present==='boolean','Invalid pending presence');
      if(!check.present)continue;
      const el=check.element;assert(el&&Array.isArray(el.box)&&el.box.length===4,'Pending bbox missing');
      const [y0,x0,y1,x1]=el.box;assert(el.box.every(Number.isFinite)&&x1>x0&&y1>y0&&x0>=0&&y0>=0&&x1<=1000&&y1<=1000,'Invalid pending bbox');
      const x=Math.floor(x0*width/1000),y=Math.floor(y0*height/1000);
      const added={...el,id:'pending_'+check.hint_id,occluded_by:[],bbox:[x,y,Math.ceil(x1*width/1000)-x,Math.ceil(y1*height/1000)-y],detection_region:'pending',recovered_hint:check.hint_id};
      if(missingRetainedHints(elements,[added]).length)elements.push(added);
    }
    continuity={...(continuity||{}),hints:missing.map(el=>el.id),checks:parsed.checks};
    await write(path.join(dir,'pending_bbox_checks.json'),continuity);
  }
  let geometry=null;
  if(mode==='visual'&&elements.length&&referenceSource) {
    // A presence check may suppress a reminder because a newly named candidate
    // already represents it. That must not erase its pre-deletion geometry.
    const geometryHints=[...(state.loops||[]).flatMap(loop=>loop.deferred||[]),...retainedHints];
    const grounded=await (combined?groundDetectedGeometry:groundCandidateGeometry)(source,referenceSource,elements,removed,dir,[width,height],geometryHints);
    geometry=grounded.geometry;
    elements=groupCoupledRearCandidates(dedupeCandidates(grounded.elements));
    await write(path.join(dir,'source_geometry.json'),geometry);
  }
  if(!elements.length) {
    let terminalPrompt='Inspect the complete CURRENT scene. Checkerboard regions are deleted transparent pixels, not objects. Background includes the coherent environment: terrain, rocks, plants, fixed architectural surfaces, stairs and platforms that form the setting. Do not isolate parts of that coherent setting as movable props. A surviving UI panel, button, resource bar, ring, glow, independent foreground prop or featured vehicle/machine/character/creature means background_only=false. Featured playable vehicles, vessels, aircraft and movable machines are separate artwork layers, even when embedded photorealistically in the setting without a frame. Their whole silhouette, including propellers, wings, thrusters, arms and attachments, must be extracted before confirming background_only. Only fixed structural machinery belongs to the setting. People and character artwork are separate layers. Ignore tiny raster seams. Return exactly JSON {"background_only":true,"reason":"short reason","remaining_elements":[]}. If false, remaining_elements must contain actual visible objects in this exact schema: {"id":"short_ascii_id","category":"panel/button/icon/decoration/artwork/prop","description":"actual appearance","box":[y_min,x_min,y_max,x_max]}. Every box is normalized yxyx_1000 on the full image. Do not infer deleted objects from empty holes.';
    const terminalImages=[wholeChecker,...(referenceSource?[referenceSource]:[])];
    terminalPrompt+=` Image 2 is the ORIGINAL unmarked scene, for original identity, full extent and front/behind reference only. Image 1 alone decides current survival. Locate a whole original semantic object, not an arbitrary fragment created by deletion rectangles. Never restore removed objects merely because they appear in the original. Previously removed targets: ${JSON.stringify(removed.map(element=>({id:element.id,description:element.description})))}.`;
    if(combined)terminalPrompt+=' In this same pass, every remaining_elements entry must also include original_present (boolean) and original_box (full ORIGINAL target normalized yxyx_1000 on the entire scene, null if original_present=false). Independently measure full original silhouette, outline, glow and shadow; exclude the host panel and other independent targets. Do not use a deletion edge as the original extent.';
    const validateTerminal=reply=>{validateBackgroundConfirmation(reply);if(combined)validateCombined({elements:reply.remaining_elements||[],hint_checks:[]},[]);};
    const terminal=await ask(terminalImages,terminalPrompt,path.join(dir,'background_confirmation'),combined?8192:4096,validateTerminal);
    if(terminal.background_only===true && !terminal.remaining_elements?.length) { const plan={source,canvas:[width,height],mode,elements:[],selected:[],deferred:[],conflicts:[],background_only:true,terminal,continuity,detection_reuse:detectionReuse};await write(path.join(dir,'plan.json'),plan);return plan;}
    for(const el of terminal.remaining_elements||[]) {const [y0,x0,y1,x1]=el.box;const x=Math.floor(x0*width/1000),y=Math.floor(y0*height/1000);elements.push({...el,id:'terminal_'+el.id,occluded_by:[],bbox:[x,y,Math.ceil(x1*width/1000)-x,Math.ceil(y1*height/1000)-y],
      ...(combined?{original_measurement:{present:el.original_present,bbox:el.original_present?sourceBox(el.original_box,{left:0,top:0,width,height}):null}}:{})});}
    assert(elements.length,'Controller did not confirm background or locate remaining objects');
    if(referenceSource){
      const grounded=await (combined?groundDetectedGeometry:groundCandidateGeometry)(source,referenceSource,elements,removed,path.join(dir,'terminal_geometry'),[width,height],retainedHints);
      elements=groupCoupledRearCandidates(dedupeCandidates(grounded.elements));geometry=grounded.geometry;
      await write(path.join(dir,'terminal_source_geometry.json'),geometry);
      assert(elements.length,'Terminal inventory contradicted the original reference; no valid remaining target');
    }
  }
  const plan={source,canvas:[width,height],mode,elements,selected:elements,deferred:[],conflicts:[],continuity,geometry,detection_reuse:detectionReuse};
  await write(path.join(dir,'plan_raw.json'),plan);
  if(mode==='text') {
    plan.elements=groupOverlappingTextTargets(elements.filter(el=>el.category==='text'));plan.selected=plan.elements;
  } else {
    const reviewImage=path.join(dir,'candidate_bbox.png');await bboxPreview(source,elements,reviewImage);
    const numberById=new Map(elements.map((el,i)=>[el.id,i+1]));
    const knownIds=new Set(elements.map(el=>el.id));
    plan.elements=elements.map(el=>({...el,label:el.description,occluded_by:[...new Set(el.occluded_by||[])].filter(id=>knownIds.has(id)&&id!==el.id)}));
    const table=plan.elements.map((el,i)=>[i+1,el.description,el.bbox,el.occluded_by.map(id=>numberById.get(id))]);
    const pairs=[];for(let i=0;i<elements.length;i++)for(let j=i+1;j<elements.length;j++)if(overlap(elements[i].bbox,elements[j].bbox))pairs.push([i+1,j+1]);
    const unresolved=pairs.filter(([a,b])=>!table[a-1][3].length&&!table[b-1][3].length);
    if(unresolved.length) {
      const relevant=new Set(unresolved.flat());
      const prompt=`Inspect these ${unresolved.length} intersecting bbox PAIRS together in ONE pass. Only resolve actual front/behind crossings from the current RGB image. A child icon is above its backplate; a panel crossing a character is above the character. Empty frame interiors may overlap another bbox without material crossing. Do not discover objects, rewrite coordinates or return a full depth graph. For each requested [a,b], return [a,b,front] where front is a or b if one object's pixels visibly cover the other, and 0 if there is no crossing, the bboxes merely overlap, or depth is unclear. Keep coupled translucent ring/artwork targets intact. Return immediately JSON {"pairs":[[a,b,front],...]} in the exact requested pair order, only numbers and no prose. Candidates [number,appearance,XYWH]:${JSON.stringify(table.filter(row=>relevant.has(row[0])).map(row=>row.slice(0,3)))}. Pairs:${JSON.stringify(unresolved)}.`;
      const validate=review=>{assert(Array.isArray(review.pairs)&&review.pairs.length===unresolved.length,'Missing pair depth decisions');review.pairs.forEach((item,i)=>{const [a,b]=unresolved[i];assert(Array.isArray(item)&&item.length===3&&item[0]===a&&item[1]===b&&[0,a,b].includes(item[2]),'Invalid pair depth decision');});};
      const reviewed=await ask([wholeChecker,...(referenceSource?[referenceSource]:[])],prompt+' Image 1 is the current scene with deletion holes. Image 2 is original geometry/occlusion reference only; deleted objects are absent now.',path.join(dir,'pair_depth_review'),8192,validate);
      for(const [a,b,front] of reviewed.pairs) {
        if(!front)continue;
        const back=front===a?b:a,frontId=plan.elements[front-1].id;
        plan.elements[back-1].occluded_by=[...new Set([...plan.elements[back-1].occluded_by,frontId])];
      }
      plan.depth_pairs=reviewed.pairs;
    }
    const ids=new Set(plan.elements.map(el=>el.id));
    for(const el of plan.elements)assert(Array.isArray(el.occluded_by)&&el.occluded_by.every(id=>ids.has(id)&&id!==el.id),'Invalid blockers: '+el.id);
    Object.assign(plan,scheduleDisjointFrontmost(plan.elements));
    // The expanded rectangles are the authoritative deletion and extraction
    // geometry. Keep source_bbox so the web page can show the detector output.
    const expanded=expandDisjointBboxes(plan.selected,6,[width,height]);
    const expandedById=new Map(expanded.map(el=>[el.id,el]));
    plan.selected=expanded;
    plan.elements=plan.elements.map(el=>expandedById.get(el.id)||el);
  }
  for(let i=0;i<plan.selected.length;i++)for(let j=i+1;j<plan.selected.length;j++)
    if(overlap(plan.selected[i].bbox,plan.selected[j].bbox))plan.conflicts.push([plan.selected[i].id,plan.selected[j].id]);
  await write(path.join(dir,'plan.json'),plan);
  await bboxPreview(source,plan.selected,path.join(dir,'selected_bbox.png'));
  assert.equal(plan.conflicts.length,0,'Frontmost bbox overlap: '+JSON.stringify(plan.conflicts));
  assert(plan.selected.length>0,'Occlusion cycle: no frontmost target');
  console.log(JSON.stringify({phase:'detected',mode,selected:plan.selected.length,deferred:plan.deferred.length}));
  return plan;
}

async function groundDetectedGeometry(source,referenceSource,elements,removed,dir,canvas,retained=[]) {
  const pixels=elements.some(element=>['panel','button'].includes(element.category))
    ?await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true}):null;
  const ready=[],fallback=[],measured=[],absent=[];
  for(const element of elements){
    const hint=matchOriginalGeometry(element,retained);
    if(hint){ready.push({...element,detection_bbox:element.bbox,
      bbox:(hint.geometry_bbox||hint.source_bbox||hint.bbox).slice(),geometry_bbox:(hint.geometry_bbox||hint.source_bbox||hint.bbox).slice(),
      geometry_identity:hint.geometry_identity||hint.id,geometry_reference:referenceSource,geometry_method:'retained_original_bbox'});continue;}
    const original=element.original_measurement;
    if(!original){fallback.push(element);continue;}
    if(!original.present){absent.push(element.id);continue;}
    const surfaceGuard=pixels?repeatedSurfaceGuard(element.bbox,original.bbox,element.category,elements,
      visibleBoxFraction(pixels.data,pixels.info,element.bbox)):null;
    const {bbox,rejected}=surfaceGuard||alignMeasuredGeometry(element.bbox,original.bbox,element.category);
    ready.push({...element,detection_bbox:element.bbox,bbox,geometry_bbox:bbox.slice(),geometry_identity:element.id,
      geometry_reference:referenceSource,geometry_method:surfaceGuard?'detected_repeated_surface_after_inconsistent_measurement':rejected?'detection_bbox_after_displaced_measurement':'inventory_original_geometry',
      ...(surfaceGuard?{surface_geometry_guard:surfaceGuard.guard}:{}),...(rejected?{rejected_geometry_bbox:original.bbox}:{})});
    measured.push({id:element.id,detected_bbox:element.bbox,original_bbox:original.bbox,accepted_bbox:bbox});
  }
  // An uncertain presence fallback may discover a new target. Measure only those
  // targets conventionally, retaining every peer for the repeated-control guard.
  const extra=fallback.length?await groundCandidateGeometry(source,referenceSource,fallback,removed,path.join(dir,'fallback_geometry'),canvas,retained,elements):null;
  const byId=new Map([...ready,...(extra?.elements||[])].map(element=>[element.id,element]));
  return {elements:elements.flatMap(element=>byId.has(element.id)?[byId.get(element.id)]:[]),geometry:{
    method:'inventory_original_geometry_then_retained_bbox',measured,absent,
    anchors:ready.filter(element=>element.geometry_method==='retained_original_bbox').map(element=>({id:element.id,original_id:element.geometry_identity,bbox:element.bbox})),
    fallback:extra?.geometry||null}};
}

async function groundCandidateGeometry(source,referenceSource,elements,removed,dir,canvas,retained=[],peers=elements) {
  const currentPixels=elements.some(el=>['panel','button'].includes(el.category))
    ?await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true}):null;
  const anchored=[],unmatched=[];
  for(const element of elements) {
    const hint=matchOriginalGeometry(element,retained);
    if(hint)anchored.push({...element,detection_bbox:element.bbox,
      bbox:(hint.geometry_bbox||hint.source_bbox||hint.bbox).slice(),
      geometry_bbox:(hint.geometry_bbox||hint.source_bbox||hint.bbox).slice(),
      geometry_identity:hint.geometry_identity||hint.id,geometry_reference:referenceSource,
      geometry_method:'retained_original_bbox'});
    else unmatched.push(element);
  }
  const contexts=unmatched.map(el=>{
    const [x,y,w,h]=el.bbox,pad=Math.max(80,Math.ceil(Math.max(w,h)*.65));
    const left=Math.max(0,x-pad),top=Math.max(0,y-pad);
    return {...el,bbox:[left,top,Math.min(canvas[0],x+w+pad)-left,Math.min(canvas[1],y+h+pad)-top]};
  });
  const groups=[];for(let i=0;i<contexts.length;i+=GEOMETRY_BATCH)groups.push(contexts.slice(i,i+GEOMETRY_BATCH));
  const results=await Promise.allSettled(groups.map(async(boxes,index)=>{
    const folder=path.join(dir,'source_geometry',`batch_${String(index+1).padStart(2,'0')}`);
    await fsp.mkdir(folder,{recursive:true});const originals=[],currents=[];
    await Promise.all(boxes.map(async(box,i)=>{
      const [left,top,width,height]=box.bbox,region={left,top,width,height};
      const original=path.join(folder,`original_${i+1}.png`),current=path.join(folder,`current_${i+1}.png`),preview=path.join(folder,`current_${i+1}_checker.png`);
      await sharp(referenceSource).extract(region).png().toFile(original);await sharp(source).extract(region).png().toFile(current);await checker(current,preview);
      originals[i]=original;currents[i]=preview;
    }));
    const targets=boxes.map((box,i)=>({id:box.id,description:box.description,members:box.members||[],original_image:i+1,current_image:boxes.length+i+1,
      removed_in_context:removed.filter(el=>overlap(el.bbox,box.bbox)).map(el=>el.description)}));
    const validate=reply=>{
      assert.equal(reply.coordinate_space,'crop_yxyx_1000');assert(Array.isArray(reply.targets)&&reply.targets.length===boxes.length,'Missing grounded geometries');
      const ids=new Set();for(const item of reply.targets){assert(boxes.some(box=>box.id===item.id)&&!ids.has(item.id),'Invalid geometry id');ids.add(item.id);
        assert.equal(typeof item.present,'boolean');if(!item.present)continue;const b=item.box;
        assert(Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]<=1000&&b[3]<=1000&&b[2]>b[0]&&b[3]>b[1],'Invalid crop geometry');}
    };
    const prompt=`The first ${boxes.length} images are ORIGINAL UNMARKED source crops. The next ${boxes.length} are the matching CURRENT crops with checkerboard for deleted foreground. Measure each listed surviving target using its assigned ORIGINAL image for FULL original geometry and its CURRENT image only for presence. Return normalized yxyx_1000 relative to the COMPLETE width/height of that target's assigned image, not the whole scene and not another image. A rectangular deletion hole is never a target edge. A backplate continues behind a removed foreground icon and a progress fill retains its original start/end. Recover the full original panel, not just the right-hand fragment beside an icon. Never invent a panel behind text/name if the original has no panel. Exclude removed objects. A cyan ring plus map is ONE target covering BOTH full extents, ring above map; exclude foreground prop/text/deeper button. Include complete outline/shadow/glow, no padding. Return JSON {"coordinate_space":"crop_yxyx_1000","targets":[{"id":"exact supplied id","present":true,"box":[y_min,x_min,y_max,x_max]}]}. Exactly one entry per target; present=false if invented or already completely removed. No new targets or prose. Targets:${JSON.stringify(targets)}`;
    const reply=await ask([...originals,...currents],prompt,folder,16384,validate);
    return {index:index+1,reply,elements:boxes.flatMap(box=>{
      const measured=reply.targets.find(item=>item.id===box.id);if(!measured.present)return [];
      const [y0,x0,y1,x1]=measured.box,[cx,cy,cw,ch]=box.bbox,left=cx+Math.floor(x0*cw/1000),top=cy+Math.floor(y0*ch/1000);
      const originalElement=elements.find(el=>el.id===box.id);
      const measuredBbox=[left,top,cx+Math.ceil(x1*cw/1000)-left,cy+Math.ceil(y1*ch/1000)-top];
      const surfaceGuard=currentPixels?repeatedSurfaceGuard(originalElement.bbox,measuredBbox,originalElement.category,peers,
        visibleBoxFraction(currentPixels.data,currentPixels.info,originalElement.bbox)):null;
      const {bbox,rejected}=surfaceGuard||alignMeasuredGeometry(originalElement.bbox,measuredBbox,originalElement.category);
      return [{...originalElement,detection_bbox:originalElement.bbox,bbox,geometry_bbox:bbox.slice(),geometry_identity:originalElement.id,geometry_reference:referenceSource,
        geometry_method:surfaceGuard?'detected_repeated_surface_after_inconsistent_measurement':rejected?'detection_bbox_after_displaced_measurement':'original_crop',
        ...(surfaceGuard?{surface_geometry_guard:surfaceGuard.guard}:{}),...(rejected?{rejected_geometry_bbox:measuredBbox}:{})}];
    })};
  }));
  const errors=results.filter(result=>result.status==='rejected');if(errors.length)throw new Error(errors.map(result=>String(result.reason)).join('\n'));
  const byId=new Map([...anchored,...results.flatMap(result=>result.value.elements)].map(el=>[el.id,el]));
  return {elements:elements.flatMap(el=>byId.has(el.id)?[byId.get(el.id)]:[]),geometry:{method:'retained_original_bbox_then_paired_crops',anchors:anchored.map(el=>({id:el.id,original_id:el.geometry_identity,bbox:el.bbox,detection_bbox:el.detection_bbox})),batches:results.map(result=>({index:result.value.index,...result.value.reply}))}};
}

async function atlasInputs(source, boxes, layout, dir, prefix='') {
  const tiles=await Promise.all(boxes.map((b,i)=>sharp(source).extract({left:b.bbox[0],top:b.bbox[1],width:b.bbox[2],height:b.bbox[3]})
    .resize(layout.cells[i].crop_width,layout.cells[i].crop_height,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer()));
  const input=path.join(dir,prefix+'input.png');
  await sharp({create:{width:layout.width,height:layout.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite(tiles.map((tile,i)=>({input:tile,left:layout.cells[i].x+layout.cells[i].crop_x,top:layout.cells[i].y+layout.cells[i].crop_y}))).png().toFile(input);
  const lines=Buffer.alloc(layout.width*layout.height*4);
  const pixel=(x,y)=>{if(x<0||y<0||x>=layout.width||y>=layout.height)return;const k=(y*layout.width+x)*4;lines[k]=255;lines[k+1]=42;lines[k+2]=185;lines[k+3]=255;};
  for(const c of layout.cells) { const x=c.x+c.crop_x,y=c.y+c.crop_y,w=c.crop_width,h=c.crop_height;
    for(let t=1;t<=3;t++){for(let px=x-t;px<x+w+t;px++){pixel(px,y-t);pixel(px,y+h-1+t);}for(let py=y-t;py<y+h+t;py++){pixel(x-t,py);pixel(x+w-1+t,py);}}
  }
  const outline=await sharp(lines,{raw:{width:layout.width,height:layout.height,channels:4}}).png().toBuffer();
  const reference=path.join(dir,prefix+'bbox_reference.png');await sharp(input).composite([{input:outline}]).png().toFile(reference);
  return {input,reference};
}

async function generateBatch(source, boxes, dir, index, repair=false, context={}) {
  await fsp.mkdir(dir,{recursive:true});
  const savedLayers=path.join(dir,'layers.json');
  const layout=context.nativeWideRows?wideRowLayout(boxes):layoutFor(boxes),{input,reference}=await atlasInputs(source,boxes,layout,dir);
  const before=context.referenceSource
    ? (await atlasInputs(context.referenceSource,boxes,layout,dir,'before_')).input:null;
  const targets=boxes.map((b,i)=>{const c=layout.cells[i];return {cell:i+1,id:b.id,category:b.category,
    role:['panel','button'].includes(b.category)?'surface_only':'foreground_object_only',description:b.description,
    target_rect:[c.x+c.crop_x,c.y+c.crop_y,c.crop_width,c.crop_height],original_size:b.bbox.slice(2),
    members:b.members||[],internal_front_to_back:b.internal_front_to_back||[],
    ...(b.horizontal_piece?{horizontal_piece:b.horizontal_piece}:{}),
    removed_in_this_crop:(context.removed||[]).filter(el=>overlap(el.bbox,b.bbox)).map(el=>({id:el.id,description:el.description})),
    source_canvas_edges:[b.bbox[0]===0?'left':null,b.bbox[1]===0?'top':null,b.bbox[0]+b.bbox[2]===state.canvas[0]?'right':null,b.bbox[1]+b.bbox[3]===state.canvas[1]?'bottom':null].filter(Boolean)};});
  const textOnly=!repair&&boxes.every(box=>box.category==='text');
  const originalOnly=!textOnly&&Boolean(before)&&intactOriginalTargets(boxes,context.removed||[]);
  const borderless=state.surface_style==='borderless';
  const surfaceInstruction=borderless
    ? 'For role=surface_only (panels and buttons): keep the original colored fill, gradient, rounded silhouette, bevel shading and soft shadow, but REMOVE all hard perimeter strokes, duplicate inner/outer outlines and inset wire frames. Do not substitute a pale stroke. Preserve functional marks that belong to this target, including plus signs and progress dividers; never remove those marks as frame lines. Exclude separately extracted icons and text. Complete continuous material AND original opacity through deleted foreground rectangles without restoring removed_in_this_crop. A deletion gap is missing evidence, not a transparent window, engraving or inset socket. Do not draw a new frame around any gap.'
    : 'For role=surface_only (panels and buttons): extract the named surface and its own frame. Complete its continuous material AND original opacity through deleted foreground rectangles, without restoring removed_in_this_crop. A deletion gap is missing evidence, not an alpha=0 window, engraving or inset socket. Do not invent a new frame along the deletion gap.';
  let prompt=textOnly
    ? `Image 1 is an atlas with magenta outlines just outside the requested text crops. Image 2 is the same unmarked atlas and provides the actual pixels. Extract only the ${boxes.length} listed text labels and numbers. Preserve each glyph's exact wording, font shape, color, outline, shadow and position. Remove every non-glyph pixel, including magenta outlines, to true alpha=0. Keep each result inside its listed target_rect and its assigned cell. Do not redraw, translate, resize, merge or omit glyphs. Return one transparent ${layout.width}x${layout.height} PNG aligned to Image 1. Targets:${JSON.stringify(targets)}`
    : `${before?'IMAGE 1 is the ORIGINAL unmarked screenshot crop atlas: the authoritative source of the target pixels, shading and material. IMAGE 2 is the same-coordinate CURRENT atlas: use it only to identify surviving targets, deletion holes and removed foreground. Its pixels may already have been regenerated; never copy its changed lighting or simplified shading. Image 1 still contains removed foreground: exclude removed_in_this_crop.':'IMAGE 1 is the CURRENT unmarked crop atlas and the source of the target pixels.'}
Return one transparent ${layout.width}x${layout.height} PNG with exactly ${boxes.length} independent targets in their assigned target_rects, in fixed cell order. Preserve original shape, markings, proportions and colors. ${borderless?'Preserve outlines only for actual icon/illustration artwork; panels and buttons follow the borderless surface instructions below.':'Preserve the original target outline.'} All crops use uniform scale ${layout.input_scale}; never normalize different objects to equal sizes or enlarge an object to fill its cell.
Transfer the visible target pixels faithfully. Preserve the original soft highlight falloff, reflected colors, midtone gradients, surface texture, bevel thickness and self-shadow. Keep the original exposure, contrast, saturation and edge softness. Do not simplify these into flat color fills, thick graphic outlines or new cel shading. Do not relight, beautify or invent stronger 3D shading; retain the exact existing rendering.
For role=foreground_object_only (icons, badges, illustrations, decorations): extract ONLY the named object and its own outline, glow and shadow. Host inventory slots, rounded card rectangles, colored slot fills, inset mats, surrounding frames and panel borders are NOT part of the object, even when visible behind it in the reference. Remove all those host-container pixels to real alpha=0. Do not draw a rectangle or frame behind the object. Preserve genuine object details such as a book cover or a shield's own rim. If deletion holes cross the object, complete only its actual silhouette, never a host card.
${surfaceInstruction}
For horizontal_piece targets, cells are adjacent LEFT-TO-RIGHT strips of one wide surface. Keep continuous matching fill, shading and opacity across shared boundaries. No seam, rounded end cap, outline, bevel or fade at a shared internal edge. Each piece keeps its listed native extent.
Recover fractional alpha only for materials that are actually translucent; opaque parts keep their original opacity. Outside the isolated target and at genuine target openings use alpha=0. Remove deeper scenery visible through translucent material, while preserving the material's own RGB/alpha. Never bake a white/gray matte, checkerboard or annotation into a target.
For a listed coupled ring/artwork target, preserve both as one composite, ring above artwork; exclude its deeper backplate. Preserve the original relative component sizes and centers: the ring must remain circular and an offset small illustration must not be enlarged to fill its interior. Keep viewport clipping and all small protrusions. Reference pixels determine material and shape; descriptions only locate the object and may contain inaccurate color words. Targets:${JSON.stringify(targets)}`;
  if(originalOnly)prompt=`Perform faithful alpha extraction of the ${boxes.length} visible objects in this ORIGINAL screenshot crop atlas. This is the ONLY appearance reference. Copy each object's existing visible rendering into its matching atlas position and make its host container and surrounding background transparent.
Return exactly one transparent ${layout.width}x${layout.height} PNG, same canvas and layout as the input, cell order unchanged. The source crops already use uniform scale ${layout.input_scale}; never reframe an object or normalize different sizes. Keep the exact source silhouette, angle, width-to-height ratio, soft edges, surface texture, fine scratches, cloudy glass, intricate patterns, gradients, subdued reflections, shadow falloff, original highlight placement and exposure. Preserve real tonal complexity and natural material variation. Do not redraw as a cleaner icon, vector emblem, toon illustration, flat badge or glossy simplified 3D asset. Do not add outlines, sharp specular lines, gold trim, stronger contrast, saturation or lighting. Do not beautify or invent detail. Every visible pixel of the actual object is already present: no reconstruction or creative completion is needed.
Extract only the named object and its own physical details, outline, glow and shadow. Exclude every host slot, backplate, border and unrelated scene. Preserve meaningful semitransparency only where the source material requires it. No matte, checkerboard or solid rectangle. Reference pixels determine appearance; descriptions only identify the target. Targets:${JSON.stringify(targets)}`;
  if(context.correction)prompt+=`\nCORRECTION FOR THIS BATCH: ${context.correction} Preserve reference pixels rather than inaccurate color words. Do not reproduce previously removed objects.`;
  const imagePaths=textOnly?[reference,input]:originalOnly?[before]:(before?[before,input]:[input]);
  const appearancePolicy=textOnly?'text_glyphs_current':originalOnly?'original_visible_pixels_only_v1':before?'original_pixels_primary_current_ownership_v1':'current_pixels_only';
  const cacheKey=await imageKey(imagePaths,{model:MODEL,prompt,layout,boxes,split:'model_rgba_downscale_only_source_geometry_v10_returned_rows_columns_crop_integrity'});
  const requestPath=path.join(dir,'request.json');
  const completedPath=path.join(dir,'model_cache.json');
  const completed=fs.existsSync(completedPath)?await read(completedPath):null;
  const reusable=completed?.cache_key===cacheKey&&fs.existsSync(path.join(dir,'model.png'))&&
    completed.image_key===await imageKey([path.join(dir,'model.png')],{});
  if(reusable&&fs.existsSync(savedLayers)) {
    const saved=await read(savedLayers);
    if(saved.length===boxes.length&&saved.every((layer,i)=>layer.id===boxes[i].id&&
      layer.atlas_split_method===(context.nativeWideRows?'returned_native_surface_strip':context.fixedCellCoordinates?'fixed_cell_alpha_bounds':'returned_alpha_bounds_inside_source_bbox')&&
      (context.nativeWideRows||context.fixedCellCoordinates||layer.atlas_source_bounds_fit===(boxes[i].source_bbox&&!preserveModelAspect(boxes[i])?'original_bbox_ratio_downscale_only':'uniform_contain_downscale_only'))&&
      layer.model_placement?.policy==='model_rgba_downscale_only'&&layer.model_placement.scale.every(scale=>scale<=1)&&
      !layer.fidelity?.applied&&fs.existsSync(layer.source)))return {layers:saved,reused:true};
  }
  await write(requestPath,{model:MODEL,quality:qualityFor('background'),mode:textOnly?'text_extraction':'typed_target_extraction',surface_style:textOnly?'not_applicable':state.surface_style||'original',appearance_source_policy:appearancePolicy,layout,targets,image_paths:imagePaths,
    unmarked_current_source:source,unmarked_reference_source:context.referenceSource || null,prompt,cache_key:cacheKey});
  if(!reusable||!fs.existsSync(path.join(dir,'model.png')))await imageRequest(imagePaths[0],path.join(dir,'model.png'),prompt,MODEL,null,undefined,{provider:'openai',clientKind:'background-repair',imagePaths,
    background:'transparent',quality:qualityFor('background'),size:`${layout.width}x${layout.height}`,resizeOutput:false,maxAttempts:1,timeoutMs:getRoute('background').timeout_ms,responseMetadataPath:path.join(dir,'response_geometry.json')});
  await write(completedPath,{cache_key:cacheKey,image_key:await imageKey([path.join(dir,'model.png')],{})});
  let layers;
  if(context.nativeWideRows){
    layers=await splitWideModel(path.join(dir,'model.png'),boxes,layout,path.join(dir,'layers'));
  }else if(context.fixedCellCoordinates){
    const layerDir=path.join(dir,'fixed_cell_layers');await fsp.mkdir(layerDir,{recursive:true});
    layers=await Promise.all(boxes.map(async(box,i)=>{
      const tile=await fixedCellAlphaTile(path.join(dir,'model.png'),layout,i,box.bbox[2],box.bbox[3]);
      const source=path.join(layerDir,`${String(i+1).padStart(3,'0')}_${box.id}.png`);await fsp.writeFile(source,tile.buffer);
      return {...box,source,source_bbox:box.bbox,bbox:box.bbox,model_generated_source:path.join(dir,'model.png'),atlas_split_method:'fixed_cell_alpha_bounds',model_rect:tile.rect,model_placement:tile.placement,atlas_resize_scale:tile.placement.scale,cache_key:cacheKey};
    }));
  }else{
    const split=await splitSeedreamAtlasModel({source,boxes,modelOutput:path.join(dir,'model.png'),batchDir:dir,layout,model:MODEL,batchIndex:index,preserveAspectRatio:true,preserveSourceBounds:true});
    layers=split.layers.map((layer,i)=>({...layer,members:boxes[i].members||[],internal_front_to_back:boxes[i].internal_front_to_back||[],atlas_split_method:'returned_alpha_bounds_inside_source_bbox',cache_key:cacheKey}));
  }
  await write(savedLayers,layers);return {layers,reused:false};
}

async function extract(source, boxes, dir, prefix, repair=false, context={}) {
  const batchSize=!repair&&boxes.every(box=>box.category==='text')?TEXT_BATCH:BATCH;
  const wide=boxes.filter(isWideSurface),ordinary=boxes.filter(box=>!isWideSurface(box));
  const textOnly=ordinary.length>0&&ordinary.every(box=>box.category==='text');
  const batches=textOnly?Array.from({length:Math.ceil(ordinary.length/batchSize)},(_,i)=>ordinary.slice(i*batchSize,(i+1)*batchSize)):visualAtlasBatches(ordinary,batchSize,layoutFor);
  const groups=batches.map(batch=>({batch}));
  groups.push(...wide.map(box=>({batch:splitWideSurface(box),wide:box})));
  const results=await Promise.allSettled(groups.map(({batch,wide},i)=>step(prefix+'_batch_'+(i+1),`${repair?'图像提取':'抠图'}图集 ${i+1}（${batch.length} 张${wide?'，宽底板分段':''}）`,async()=>{
    const batchDir=path.join(dir,`batch_${String(i+1).padStart(2,'0')}`);
    const result=await generateBatch(source,batch,batchDir,i+1,repair,{...context,...(wide?{nativeWideRows:true}:{})});
    if(!wide)return result;
    const joined=await joinWideSurface(wide,result.layers,path.join(batchDir,'wide_surface.png'));
    await write(path.join(batchDir,'wide_surface.json'),joined);
    return {layers:[joined],reused:result.reused};
  })));
  let layers=results.flatMap(result=>result.status==='fulfilled'?result.value.layers:[]);
  layers=boxes.flatMap(box=>layers.filter(layer=>layer.id===box.id));
  await write(path.join(dir,'layers.json'),layers);
  const failures=results.filter(result=>result.status==='rejected');if(failures.length)throw new Error(failures.map(result=>String(result.reason)).join('\n'));
  assert.equal(layers.length,boxes.length);return layers;
}

async function fullComposite(source,layers,output,blend='over') {
  await sharp(source).composite(layers.map(layer=>({input:layer.source,left:layer.bbox[0],top:layer.bbox[1],blend}))).png().toFile(output);
}


return {ask,detect,groundCandidateGeometry,groundDetectedGeometry,atlasInputs,extract,bboxPreview,generateBatch};
}
module.exports={createCore,BATCH,TEXT_BATCH,GEOMETRY_BATCH,overlap,groupOverlappingTextTargets,expandDisjointBboxes,pruneClippedOverviewDuplicates,reconcileClippedRegionalCandidates,missingRetainedHints,scheduleDisjointFrontmost,dedupeCandidates,matchOriginalGeometry,validateBackgroundConfirmation,alignMeasuredGeometry,selectRegionalCandidates};
