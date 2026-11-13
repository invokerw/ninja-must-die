// A crossing glow and its artwork are repaired together to retain their internal compositing.
// Geometry comes from the candidate plan; there are no image-specific coordinates.
const intersects = (a,b) => a[0]<b[0]+b[2] && b[0]<a[0]+a[2] && a[1]<b[1]+b[3] && b[1]<a[1]+a[3];
const isRing = element => /(?:ring|halo)/i.test(element.description||'') &&
  /(?:cyan|glow|luminous|light|translucent)/i.test(element.description||'');
const isArtwork = element => /(?:map|artwork|illustration)/i.test(element.description||'') && !isRing(element) &&
  !/(?:button|panel|backplate|surface)/i.test(element.category||'');

function groupCoupledRearCandidates(elements) {
  const result=elements.map(element=>({...element})),aliases=new Map();
  for(let i=0;i<result.length;i++) {
    const ring=result[i];
    if(!isRing(ring)||ring.members?.length>1)continue;
    const j=result.findIndex((artwork,index)=>index!==i&&isArtwork(artwork)&&!artwork.members?.length &&
      // A floor rune behind a standing character is an independent rear
      // decoration. Coupling must not reverse an explicit foreground blocker.
      !ring.occluded_by?.includes(artwork.id)&&
      (!ring.region||!artwork.region||ring.region===artwork.region)&&intersects(ring.bbox,artwork.bbox));
    if(j<0)continue;
    const artwork=result[j];
    const x=Math.min(ring.bbox[0],artwork.bbox[0]),y=Math.min(ring.bbox[1],artwork.bbox[1]);
    const right=Math.max(ring.bbox[0]+ring.bbox[2],artwork.bbox[0]+artwork.bbox[2]);
    const bottom=Math.max(ring.bbox[1]+ring.bbox[3],artwork.bbox[1]+artwork.bbox[3]);
    const id=ring.id+'_with_'+artwork.id;
    aliases.set(ring.id,id);aliases.set(artwork.id,id);
    const ownIds=new Set([ring.id,artwork.id]);
    result[i]={...ring,id,bbox:[x,y,right-x,bottom-y],category:'decoration',
      description:`Coupled composite: ${ring.description} composited ABOVE ${artwork.description}; exclude the deeper control backplate`,
      members:[ring.id,artwork.id],internal_front_to_back:[ring.id,artwork.id],
      occluded_by:[...new Set([...(ring.occluded_by||[]),...(artwork.occluded_by||[])])].filter(blocker=>!ownIds.has(blocker))};
    if(ring.original_measurement?.present&&artwork.original_measurement?.present){
      const [rx,ry,rw,rh]=ring.original_measurement.bbox,[ax,ay,aw,ah]=artwork.original_measurement.bbox;
      const left=Math.min(rx,ax),top=Math.min(ry,ay);
      result[i].original_measurement={present:true,bbox:[left,top,Math.max(rx+rw,ax+aw)-left,Math.max(ry+rh,ay+ah)-top]};
    }else delete result[i].original_measurement;
    delete result[i].box;delete result[i].normalized_box;
    result.splice(j,1);if(j<i)i--;
  }
  return result.map(element=>({...element,
    occluded_by:[...new Set((element.occluded_by||[]).map(id=>aliases.get(id)||id))].filter(id=>id!==element.id),
  }));
}

module.exports={groupCoupledRearCandidates};
