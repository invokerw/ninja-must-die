// Repeated, fully visible controls provide geometry evidence independent of a
// second language-model measurement. Do not apply this to hole-damaged boxes.
function repeatedSurfaceGuard(detected,measured,category,peers,visibleFraction) {
  if(!['panel','button'].includes(category)||visibleFraction<.98)return null;
  const support=peers.filter(peer=>peer.category===category&&
    Math.abs(peer.bbox[2]/detected[2]-1)<=.08&&Math.abs(peer.bbox[3]/detected[3]-1)<=.08);
  const unique=[];
  for(const peer of support)if(!unique.some(other=>Math.abs(other.bbox[0]-peer.bbox[0])<4&&Math.abs(other.bbox[1]-peer.bbox[1])<4))unique.push(peer);
  if(unique.length<3)return null;
  const ratios=[measured[2]/detected[2],measured[3]/detected[3]];
  const shifts=[Math.abs(measured[0]+measured[2]/2-detected[0]-detected[2]/2),Math.abs(measured[1]+measured[3]/2-detected[1]-detected[3]/2)];
  if(ratios.every(r=>r>=.85&&r<=1.15)&&shifts.every((s,i)=>s<=Math.max(2,detected[i+2]*.12)))return null;
  return {bbox:detected.slice(),rejected:true,guard:{reason:'remeasurement_disagrees_with_visible_repeated_surfaces',support_count:unique.length,visible_fraction:visibleFraction,measured_size_ratios:ratios,measured_center_shifts:shifts}};
}

function visibleBoxFraction(pixels,info,bbox) {
  const [x,y,w,h]=bbox;let visible=0;
  for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)
    if(pixels[(row*info.width+col)*info.channels+3]>=248)visible++;
  return visible/(w*h);
}
module.exports={repeatedSurfaceGuard,visibleBoxFraction};
