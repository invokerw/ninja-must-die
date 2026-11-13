#!/usr/bin/env node
// Verify recursive depth ordering and PSD RGBA storage without model calls.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const {exportPsd,splitSeedreamAtlasModel}=require('./layerforge.js');
const {orderLayers,readPsdPixels,retainedHints}=require('./bbox_recursive_test.js');
const {pruneClippedOverviewDuplicates,reconcileClippedRegionalCandidates,missingRetainedHints,scheduleDisjointFrontmost,expandDisjointBboxes,overlap,groupOverlappingTextTargets,dedupeCandidates,matchOriginalGeometry,validateBackgroundConfirmation,alignMeasuredGeometry,selectRegionalCandidates}=require('./bbox_recursive_core.js');
const {deleteBboxes,fixedCellAlphaTile}=require('./bbox_atlas_pixels.js');
async function main(){
  const tiltedText=[
    {id:'english',category:'text',description:'RECRUIT',bbox:[10,10,80,30]},
    {id:'chinese',category:'text',description:'Chinese subtitle',bbox:[15,35,60,20]},
    {id:'neighbor',category:'text',description:'Other label',bbox:[100,10,40,20]},
  ];
  const groupedText=groupOverlappingTextTargets(tiltedText);
  assert.equal(groupedText.length,2,'Intersecting bilingual lines must survive one-time text removal together');
  assert.deepEqual(groupedText[0].bbox,[10,10,80,45]);
  assert.deepEqual(groupedText[0].text_group_members.map(el=>el.id),['english','chinese']);
  assert.strictEqual(groupedText[1],tiltedText[2],'An independent text target remains unchanged');
  assert.deepEqual(tiltedText[0].bbox,[10,10,80,30],'Grouping must not mutate detector evidence');
  const closureText=groupOverlappingTextTargets([
    {id:'horizontal',category:'text',bbox:[0,0,20,10]},
    {id:'vertical',category:'text',bbox:[10,5,10,20]},
    {id:'inside_union',category:'text',bbox:[0,15,5,5]},
    {id:'touching',category:'text',bbox:[20,0,10,10]},
  ]);
  assert.equal(closureText.length,2,'Union geometry must be reconciled until all text targets are disjoint');
  assert.deepEqual(closureText[0].text_group_members.map(el=>el.id),['horizontal','vertical','inside_union']);
  assert.equal(overlap(closureText[0].bbox,closureText[1].bbox),0,'Touching edges need no grouping');
  // Actual detector outputs from the fresh V8 run straddle x=512 in opposite
  // directions. Independent core filters used to drop both helmet detections.
  const seamObjects=[
    {id:'left_helmet',category:'artwork',bbox:[471,517,82,102],detection_region:'roi_4',detection_core:[0,512,512,512],detection_crop:{left:0,top:432,width:592,height:592},occluded_by:[]},
    {id:'right_helmet',category:'icon',bbox:[470,515,83,105],detection_region:'roi_5',detection_core:[512,512,512,512],detection_crop:{left:432,top:432,width:672,height:592},occluded_by:[]},
    {id:'slot',category:'panel',bbox:[442,498,139,145],detection_region:'roi_5',detection_core:[512,512,512,512],detection_crop:{left:432,top:432,width:672,height:592},occluded_by:['right_helmet']},
  ];
  const seamSelection=selectRegionalCandidates(seamObjects);
  assert.deepEqual(seamSelection.map(el=>el.id),['left_helmet','slot'],'Keep exactly one complete target at a shared region boundary');
  assert.equal(seamSelection[0].bbox_region_rescued,true);
  assert.deepEqual(seamSelection[1].occluded_by,['left_helmet'],'Rewire the backplate dependency to the retained foreground');
  const ownedSeam=selectRegionalCandidates([seamObjects[0],{...seamObjects[1],bbox:[471,515,83,105]},seamObjects[2]]);
  assert.deepEqual(ownedSeam.map(el=>el.id),['right_helmet','slot'],'Prefer an existing owner over a duplicate rescue');
  assert(!ownedSeam[0].bbox_region_rescued);
  assert.equal(selectRegionalCandidates([{...seamObjects[0],bbox:[514,517,82,102]}]).length,0,'A target far inside another core is not a boundary rescue');
  assert.equal(selectRegionalCandidates([{...seamObjects[0],detection_crop:{left:0,top:432,width:553,height:592}}]).length,0,'Do not rescue a clipped local fragment');
  const stacked=selectRegionalCandidates([seamObjects[0],{...seamObjects[1],occluded_by:['left_helmet']}]);
  assert.equal(stacked.length,2,'Explicitly stacked foreground layers must not become aliases');
  const droneFragments=[
    {id:'roi_5_prop_shield_drone',category:'artwork',description:'Spherical drone with blue sensor and white side shield plate',bbox:[921,764,183,125],
      original_measurement:{present:true,bbox:[921,764,183,125]},detection_region:'roi_5',detection_crop:{left:432,top:432,width:672,height:592},detection_core:[512,512,512,512],occluded_by:[]},
    {id:'roi_6_drone_artwork',category:'artwork',description:'White and orange spherical shield drone illustration with blue lens',bbox:[944,756,214,131],
      original_measurement:{present:true,bbox:[944,756,214,131]},detection_region:'roi_6',detection_crop:{left:944,top:432,width:592,height:592},detection_core:[1024,512,512,512],occluded_by:[]},
    {id:'left_card',category:'panel',description:'Dark beveled card panel for shield drone',bbox:[890,736,214,193],
      original_measurement:{present:true,bbox:[890,736,214,193]},detection_region:'roi_5',detection_crop:{left:432,top:432,width:672,height:592},detection_core:[512,512,512,512],occluded_by:['roi_5_prop_shield_drone']},
    {id:'right_card',category:'panel',description:'Dark grey HUD card backplate with cyan corner accents',bbox:[944,739,234,192],
      original_measurement:{present:true,bbox:[944,739,234,192]},detection_region:'roi_6',detection_crop:{left:944,top:432,width:592,height:592},detection_core:[1024,512,512,512],occluded_by:['roi_6_drone_artwork']},
  ];
  const droneEvidence=structuredClone(droneFragments),reconciledDrone=reconcileClippedRegionalCandidates(droneFragments,[1536,1024]);
  assert.deepEqual(droneFragments,droneEvidence,'Keep original regional evidence unchanged');
  assert.deepEqual(reconciledDrone.map(el=>el.id),['roi_5_prop_shield_drone','left_card']);
  assert.deepEqual(reconciledDrone[0].bbox,[921,756,237,133],'Both side wings must be inside one complete original bbox');
  assert.deepEqual(reconciledDrone[0].original_measurement.bbox,[921,756,237,133],'Clipped original measurements cannot overwrite the merged extent');
  assert.deepEqual(reconciledDrone[1].bbox,[890,736,288,195]);
  assert.deepEqual(reconciledDrone[1].occluded_by,['roi_5_prop_shield_drone'],'Both panel fragments share the complete drone blocker');
  assert.equal(selectRegionalCandidates(reconciledDrone).length,2,'Ownership must run after reconciliation of cross-core extents');
  assert.deepEqual(scheduleDisjointFrontmost(selectRegionalCandidates(reconciledDrone)).selected.map(el=>el.id),['roi_5_prop_shield_drone']);
  const explicitWing=structuredClone(droneFragments.slice(0,2));explicitWing[1].occluded_by=[explicitWing[0].id];
  assert.equal(reconcileClippedRegionalCandidates(explicitWing,[1536,1024]).length,2,'Explicit separate foreground depth forbids merging');
  const unrelatedProp=structuredClone(droneFragments.slice(0,2));unrelatedProp[1].description='Red rectangular ammunition storage chest';
  assert.equal(reconcileClippedRegionalCandidates(unrelatedProp,[1536,1024]).length,2,'Overlapping unrelated props are independent');
  const intactNeighbors=structuredClone(droneFragments.slice(0,2));intactNeighbors.forEach(el=>el.detection_crop={left:400,top:432,width:900,height:592});
  assert.equal(reconcileClippedRegionalCandidates(intactNeighbors,[1536,1024]).length,2,'Overlap without crop-edge evidence is insufficient');
  const verticalFragments=droneFragments.slice(0,2).map(el=>({...el,bbox:[el.bbox[1],el.bbox[0],el.bbox[3],el.bbox[2]],
    detection_crop:{left:el.detection_crop.top,top:el.detection_crop.left,width:el.detection_crop.height,height:el.detection_crop.width},original_measurement:undefined}));
  assert.deepEqual(reconcileClippedRegionalCandidates(verticalFragments,[1024,1536])[0].bbox,[756,921,133,237],'Vertical crop boundaries use the same full-extent reconciliation');
  assert.deepEqual(alignMeasuredGeometry([602,508,27,30],[603,489,26,19]),{bbox:[602,508,27,30],rejected:true},'A remeasurement must not move an icon into an adjacent row');
  assert.deepEqual(alignMeasuredGeometry([304,508,27,28],[304,487,28,46],'icon'),{bbox:[304,508,27,28],rejected:true},'A badge must not inherit an expanded panel-like measurement');
  assert.deepEqual(alignMeasuredGeometry([470,666,83,100],[479,675,64,90],'artwork'),{bbox:[470,666,83,100],rejected:false},'The crystal ball must retain the entire initially detected silhouette');
  assert.deepEqual(alignMeasuredGeometry([235,201,262,163],[40,201,457,164]),{bbox:[40,201,457,164],rejected:false},'A parent can expand through a foreground deletion hole');
  const alternateBox={background_only:false,remaining_elements:[{id:1,box_2d:[100,200,300,400]}]};
  validateBackgroundConfirmation(alternateBox);
  assert.deepEqual(alternateBox.remaining_elements[0].box,[100,200,300,400]);
  assert.throws(()=>validateBackgroundConfirmation({background_only:false,remaining_elements:[{id:'missing_box'}]}),/bbox/);
  const candidates=[
    {id:'empty_frame',bbox:[10,10,100,100],occluded_by:[]},
    {id:'artwork',bbox:[30,30,40,40],occluded_by:[]},
    {id:'neighbor',bbox:[130,10,30,30],occluded_by:[]},
    {id:'backplate',bbox:[0,0,200,150],occluded_by:['artwork']},
  ];
  const scheduled=scheduleDisjointFrontmost(candidates);
  assert.deepEqual(scheduled.selected.map(el=>el.id),['artwork','neighbor']);
  assert.deepEqual(scheduled.deferred.map(el=>el.id),['empty_frame','backplate']);
  assert.deepEqual(scheduled.scheduling,[{id:'empty_frame',reason:'bbox_intersection',wait_for:['artwork']}]);
  assert.deepEqual(candidates[0].occluded_by,[],'Scheduling must not invent semantic occlusion');
  assert.strictEqual(scheduled.deferred[0],candidates[0],'Keep full target geometry');
  const originalPanel={id:'roi_1_chest_panel_bg',description:'quest backplate',bbox:[40,201,457,164]};
  assert.strictEqual(matchOriginalGeometry({id:'renamed',description:'quest backplate',bbox:[235,201,262,163]},[originalPanel]),originalPanel,'Recover complete pre-hole parent geometry');
  assert.equal(matchOriginalGeometry({id:'renamed',description:'quest backplate',bbox:[127,30,444,34]},[originalPanel]),null,'Do not match a phantom panel elsewhere');
  const fill={id:'roi_1_top_profile_fill_bar',bbox:[91,69,207,57]};
  assert.strictEqual(matchOriginalGeometry({id:'roi_1_top_profile_exp_fill',bbox:[130,69,168,57]},[fill]),fill,'Keep identity through minor detector renaming');
  const track={id:'roi_1_top_profile_bar_bg',category:'panel',bbox:[26,66,545,64]};
  assert.strictEqual(matchOriginalGeometry({id:'roi_1_roi_1_top_exp_bar_track',category:'panel',description:'empty experience groove',bbox:[90,64,480,64]},[track]),track,'An empty backplate retains its complete original bounds');
  assert.equal(matchOriginalGeometry({id:'inset',category:'panel',bbox:[90,70,160,40]},[track]),null,'A child panel cannot inherit a larger parent bbox');
  const wholeDrone={id:'roi_6_drone_artwork',category:'artwork',description:'White and orange spherical shield drone illustration with blue lens',bbox:[944,756,214,131]};
  assert.equal(matchOriginalGeometry({id:'roi_6_drone_wing_fragment',recovered_hint:wholeDrone.id,category:'artwork',description:'Right side curved wing/shield plate of the shield drone',bbox:[1102,758,54,126]},[wholeDrone]),null,'A wing fragment must be remeasured instead of inheriting whole-drone proportions');
  assert.strictEqual(matchOriginalGeometry({...wholeDrone,id:'renamed',recovered_hint:wholeDrone.id,bbox:[945,758,210,126]},[wholeDrone]),wholeDrone,'A whole foreground target can still keep its validated identity');
  assert.equal(overlap(...scheduled.selected.map(el=>el.bbox)),0);
  const padded=expandDisjointBboxes([
    {id:'left',bbox:[10,10,40,40]},
    {id:'right',bbox:[50,10,40,40]},
    {id:'below',bbox:[10,50,40,40]},
  ],6,[100,100]);
  assert.deepEqual(padded.map(el=>el.source_bbox),[[10,10,40,40],[50,10,40,40],[10,50,40,40]]);
  assert(padded.every(el=>el.bbox_padding===6));
  for(let i=0;i<padded.length;i++)for(let j=i+1;j<padded.length;j++)assert.equal(overlap(padded[i].bbox,padded[j].bbox),0);
  assert(padded.every((el,i)=>el.bbox[0]<=el.source_bbox[0]&&el.bbox[1]<=el.source_bbox[1]&&
    el.bbox[0]+el.bbox[2]>=el.source_bbox[0]+el.source_bbox[2]&&el.bbox[1]+el.bbox[3]>=el.source_bbox[1]+el.source_bbox[3]));
  assert.deepEqual(scheduleDisjointFrontmost(candidates.filter(el=>el.id!=='artwork')).selected.map(el=>el.id),['empty_frame','neighbor']);
  const duplicates=dedupeCandidates([
    {id:'local_artwork',category:'artwork',bbox:[10,10,100,82],occluded_by:['front_panel']},
    {id:'overview_artwork',category:'artwork',bbox:[10,10,100,100],occluded_by:['front_panel']},
    {id:'front_panel',category:'panel',bbox:[10,70,100,30],occluded_by:[]},
    {id:'tiny_artwork',category:'artwork',bbox:[15,15,10,10],occluded_by:['local_artwork']},
  ]);
  assert.deepEqual(duplicates.map(el=>el.id),['overview_artwork','front_panel','tiny_artwork']);
  assert.deepEqual(duplicates[0].bbox,[10,10,100,100],'Prefer full artwork extent');
  assert.deepEqual(duplicates[2].occluded_by,['overview_artwork'],'Keep references to the deduplicated target');
  const occludedIllustration=dedupeCandidates([
    {id:'partial_person',category:'artwork',bbox:[1126,111,310,446],detection_region:'roi_3',occluded_by:[]},
    {id:'whole_person',category:'artwork',bbox:[1122,110,315,552],detection_region:'overview',occluded_by:['front_panel']},
    {id:'front_panel',category:'panel',bbox:[1072,556,429,434],occluded_by:[]},
    {id:'badge',category:'artwork',bbox:[1130,120,20,20],occluded_by:[]},
  ]);
  assert.deepEqual(occludedIllustration.map(el=>el.id),['whole_person','front_panel','badge']);
  assert.deepEqual(occludedIllustration[0].occluded_by,['front_panel'],'Partial foreground detection must not erase the full-object blocker');
  const ordered=orderLayers([{index:1,layers:[{id:'text'}]},{index:2,layers:[{id:'icon'}]},{index:3,layers:[{id:'panel'}]}]);
  assert.deepEqual(ordered.sort((a,b)=>a.z_index-b.z_index).map(l=>l.id),['panel','icon','text']);
  const normalized=pruneClippedOverviewDuplicates([
    {id:'full_bar',category:'panel',bbox:[0,900,1800,100],detection_region:'overview'},
    {id:'bar_fragment',category:'panel',bbox:[500,900,800,100],detection_region:'roi_5',detection_crop:{left:500,top:450,width:800,height:550}},
    {id:'edge_fragment',category:'panel',bbox:[1300,900,500,100],detection_region:'roi_6',detection_crop:{left:1300,top:450,width:500,height:550}},
    {id:'button',category:'panel',bbox:[700,850,160,130],detection_region:'roi_5',detection_crop:{left:500,top:450,width:800,height:550}},
    {id:'child',category:'icon',bbox:[710,860,30,30],occluded_by:['bar_fragment']},
  ],[1800,1000]);
  assert.deepEqual(normalized.map(el=>el.id),['full_bar','button','child']);
  assert.deepEqual(normalized.at(-1).occluded_by,['full_bar']);
  const panelFragments=pruneClippedOverviewDuplicates([
    {id:'whole',category:'panel',description:'cream parchment inventory grid panel with ornamental corner filigree and golden border',bbox:[253,96,817,885],detection_region:'overview'},
    {id:'partial',category:'panel',description:'cream parchment inventory grid panel with ornamental corner filigree',bbox:[254,97,338,495],detection_region:'roi_1',detection_crop:{left:0,top:0,width:592,height:592}},
    {id:'child_panel',category:'panel',description:'small blue item slot',bbox:[400,450,150,142],detection_region:'roi_1',detection_crop:{left:0,top:0,width:592,height:592}},
  ],[1536,1024]);
  assert.deepEqual(panelFragments.map(el=>el.id),['whole','child_panel'],'Discard partial same-surface boxes while preserving distinct children');
  const sideFragments=pruneClippedOverviewDuplicates([
    {id:'sidebar_full',category:'panel',description:'tall vertical dark translucent sidebar panel holding category tabs',bbox:[33,104,206,846],detection_region:'overview'},
    {id:'sidebar_lower',category:'panel',description:'Dark blue-grey sidebar navigation container panel on the left',bbox:[33,432,205,552],detection_region:'roi_4',detection_crop:{left:0,top:432,width:592,height:592}},
    {id:'child_control',category:'panel',description:'round capsule backpack button',bbox:[43,880,187,69],detection_region:'roi_4',detection_crop:{left:0,top:432,width:592,height:592}},
  ],[1536,1024]);
  assert.deepEqual(sideFragments.map(el=>el.id),['sidebar_full','child_control']);
  assert.deepEqual(sideFragments[0].bbox,[33,104,206,880],'Retain lower visible frame pixels from local view');
  const adjacentPanels=pruneClippedOverviewDuplicates([
    {id:'full_squads',category:'panel',description:'Little Twin Stars themed panel',bbox:[1139,396,306,136],detection_region:'roi_2',detection_crop:{left:602,top:0,width:843,height:552},occluded_by:['badge']},
    {id:'squads_fragment',category:'panel',description:'squads navigation backplate',bbox:[1285,394,162,151],detection_region:'roi_3',detection_crop:{left:1285,top:0,width:763,height:552},occluded_by:[]},
    {id:'badge',category:'icon',bbox:[1146,405,134,119],occluded_by:[]},
    {id:'full_mission',category:'button',description:'mission card backplate',bbox:[1168,719,277,169],detection_region:'roi_5',detection_crop:{left:602,top:392,width:843,height:552},occluded_by:['mission_badge']},
    {id:'mission_fragment',category:'panel',description:'mission card fragment',bbox:[1285,728,160,160],detection_region:'roi_6',detection_crop:{left:1285,top:392,width:763,height:552},occluded_by:[]},
    {id:'mission_badge',category:'icon',bbox:[1184,733,123,124],occluded_by:[]},
  ],[2048,944]);
  assert.deepEqual(adjacentPanels.map(b=>b.id),['full_squads','badge','full_mission','mission_badge'],'Adjacent local views must not retain a cropped duplicate surface');
  assert.deepEqual(adjacentPanels[0].occluded_by,['badge']);
  assert.deepEqual(scheduleDisjointFrontmost(adjacentPanels).selected.map(b=>b.id),['badge','mission_badge'],'Whole backplates stay behind their own icons');
  const distinctNested=[
    {id:'outer',category:'panel',bbox:[100,10,200,100],detection_region:'roi_1',occluded_by:['inner']},
    {id:'inner',category:'button',bbox:[200,10,100,100],detection_region:'roi_2',detection_crop:{left:200,top:0,width:200,height:150},occluded_by:[]},
  ];
  assert.equal(pruneClippedOverviewDuplicates(distinctNested,[500,200]).length,2,'Explicit nested surface depth must not become a crop alias');
  const archerFragments=pruneClippedOverviewDuplicates([
    {id:'partial_archer',category:'artwork',description:'Female archer character with white hair, green armor, quiver, and bow',bbox:[373,92,219,500],detection_region:'roi_1',detection_crop:{left:0,top:0,width:592,height:592},occluded_by:[]},
    {id:'whole_archer',category:'artwork',description:'Full-body illustration of an elf archer in green leather armor holding a bow',bbox:[377,93,478,731],detection_region:'overview',occluded_by:[]},
    {id:'floor_rune',category:'decoration',bbox:[258,778,683,79],occluded_by:['partial_archer']},
    {id:'separate_badge',category:'artwork',description:'small blue star badge',bbox:[560,550,32,32],detection_region:'roi_1',detection_crop:{left:0,top:0,width:592,height:592},occluded_by:[]},
  ],[1536,1024]);
  assert.deepEqual(archerFragments.map(el=>el.id),['whole_archer','floor_rune','separate_badge'],'Retain one full character, not a crop-edge torso plus the same full figure');
  assert.deepEqual(archerFragments[0].bbox,[373,92,482,732],'Preserve the union of visible full-character evidence');
  assert.deepEqual(archerFragments[1].occluded_by,['whole_archer'],'A rear effect keeps the whole character as its blocker');
  const lowerBodyAndFull=[
    {id:'roi_5_character_lyra',category:'artwork',description:'Legs, boots, and lower cloak of character Lyra holding a bow',bbox:[432,432,429,405],detection_region:'roi_5',detection_crop:{left:432,top:432,width:672,height:592},occluded_by:[]},
    {id:'overview_character_lyra',category:'artwork',description:'Full-body illustration of an elven archer in green cloak and leather armor holding a recurve bow',bbox:[287,76,574,759],detection_region:'overview',occluded_by:['nameplate']},
    {id:'nameplate',category:'panel',bbox:[428,825,245,62],occluded_by:[]},
  ];
  const oneNamedCharacter=pruneClippedOverviewDuplicates(structuredClone(lowerBodyAndFull),[1536,1024]);
  assert.deepEqual(oneNamedCharacter.map(el=>el.id),['overview_character_lyra','nameplate'],'A named crop-edge lower body must not survive beside the same full person');
  assert.deepEqual(oneNamedCharacter[0].occluded_by,['nameplate'],'The whole person retains its real foreground blocker');
  const genericIds=structuredClone(lowerBodyAndFull);
  genericIds[0].id='roi_5_artwork_1';genericIds[1].id='overview_artwork_1';
  assert.equal(pruneClippedOverviewDuplicates(genericIds,[1536,1024]).length,3,'Generic category/numeric ids are insufficient evidence to alias distinct artwork');
  const namedDepth=structuredClone(lowerBodyAndFull);
  namedDepth[1].occluded_by.push(namedDepth[0].id);
  assert.equal(pruneClippedOverviewDuplicates(namedDepth,[1536,1024]).length,3,'Matching descriptive ids cannot override explicit independent artwork depth');
  const nestedArtwork=[
    {id:'whole',category:'artwork',description:'green armor illustration',bbox:[200,100,500,700],detection_region:'overview',occluded_by:['child']},
    {id:'child',category:'artwork',description:'green armor emblem',bbox:[400,300,192,292],detection_region:'roi_1',detection_crop:{left:0,top:0,width:592,height:592},occluded_by:[]},
  ];
  assert.equal(pruneClippedOverviewDuplicates(nestedArtwork,[1536,1024]).length,2,'An explicitly independent foreground target must not be aliased to the overview');
  const hints=retainedHints([{deferred:[{id:'parent',category:'panel',bbox:[20,30,200,100]},{id:'removed_panel',category:'panel',bbox:[400,20,80,60]}],selected:[]},
    {selected:[{category:'icon',bbox:[40,40,30,30]},{category:'panel',bbox:[401,21,80,60]}]}]);
  assert.deepEqual(hints.map(el=>el.id),['parent']);
  assert.deepEqual(retainedHints([{selected:[],deferred:[{id:'gone',bbox:[20,30,200,100]}]},
    {selected:[],continuity:{checks:[{hint_id:'gone',present:false}]}}]),[]);
  assert.deepEqual(retainedHints([{selected:[],deferred:[{id:'gone',bbox:[20,30,200,100]}]},
    {selected:[],continuity:{inventory_hint_checks:[{hint_id:'gone',status:'absent'}]}}]),[]);
  assert.equal(retainedHints([{selected:[],deferred:[{id:'uncertain',bbox:[20,30,200,100]}]},
    {selected:[],continuity:{inventory_hint_checks:[{hint_id:'uncertain',status:'uncertain'}]}}]).length,1);
  assert.deepEqual(missingRetainedHints([
    {category:'button',bbox:[401,21,80,60]},
    {category:'panel',bbox:[20,60,200,15]},
  ],[{id:'parent',bbox:[20,30,200,100]},{id:'found',bbox:[400,20,80,60]}]).map(el=>el.id),['parent']);
  const dir=path.resolve(__dirname,'../tmp/recursive-psd-check');await fs.mkdir(dir,{recursive:true});
  // A generated object with the wrong aspect must recover the source target's
  // dimensions without filling the safe context margin around that target.
  const atlasFixture=path.join(dir,'geometry_atlas.png'),sceneFixture=path.join(dir,'geometry_source.png');
  const wrongAspect=Buffer.alloc(80*80*4);
  for(let y=25;y<55;y++)for(let x=20;x<60;x++)Buffer.from([50,180,230,255]).copy(wrongAspect,(y*80+x)*4);
  await sharp(wrongAspect,{raw:{width:80,height:80,channels:4}}).png().toFile(atlasFixture);
  await sharp({create:{width:100,height:80,channels:4,background:'#203040'}}).png().toFile(sceneFixture);
  await fs.mkdir(path.join(dir,'geometry_split'),{recursive:true});
  const semanticSplit=await splitSeedreamAtlasModel({source:sceneFixture,boxes:[{id:'surface',category:'panel',bbox:[10,10,72,32],source_bbox:[16,16,60,20]}],
    modelOutput:atlasFixture,batchDir:path.join(dir,'geometry_split'),layout:{width:80,height:80,cells:[{x:0,y:0,width:80,height:80,crop_x:4,crop_y:4,crop_width:72,crop_height:32}]},
    model:'fixture',batchIndex:1,preserveAspectRatio:true,preserveSourceBounds:true});
  const surface=await sharp(semanticSplit.layers[0].source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([surface.info.width,surface.info.height],[72,32]);
  for(let y=0;y<32;y++)for(let x=0;x<72;x++)if(x<6||x>=66||y<6||y>=26)
    assert.equal(surface.data[(y*72+x)*4+3],0,'BBox padding must stay transparent');
  const xs=[],ys=[];for(let y=0;y<32;y++)for(let x=0;x<72;x++)if(surface.data[(y*72+x)*4+3]>128){xs.push(x);ys.push(y);}
  assert(Math.max(...xs)-Math.min(...xs)+1<=44,'A smaller returned panel must not be enlarged to fill its semantic bbox');
  assert.equal(semanticSplit.layers[0].model_placement.resolution_shortfall,true);
  assert(semanticSplit.layers[0].atlas_resize_scale.every(scale=>scale<=1));
  assert(Math.max(...ys)-Math.min(...ys)+1>=12,'Insufficient native width scales both source dimensions down instead of upsampling');
  const iconDir=path.join(dir,'icon_geometry_split');await fs.mkdir(iconDir,{recursive:true});
  const iconSplit=await splitSeedreamAtlasModel({source:sceneFixture,boxes:[{id:'icon',category:'icon',bbox:[10,10,72,32],source_bbox:[16,16,60,20]}],
    modelOutput:atlasFixture,batchDir:iconDir,layout:{width:80,height:80,cells:[{x:0,y:0,width:80,height:80,crop_x:4,crop_y:4,crop_width:72,crop_height:32}]},
    model:'fixture',batchIndex:1,preserveAspectRatio:true,preserveSourceBounds:true});
  const icon=await sharp(iconSplit.layers[0].source).ensureAlpha().raw().toBuffer();
  const iconXs=[],iconYs=[];for(let y=0;y<32;y++)for(let x=0;x<72;x++)if(icon[(y*72+x)*4+3]>128){iconXs.push(x);iconYs.push(y);}
  const iconWidth=Math.max(...iconXs)-Math.min(...iconXs)+1,iconHeight=Math.max(...iconYs)-Math.min(...iconYs)+1;
  assert(Math.abs(iconSplit.layers[0].model_placement.rendered_size[0]/iconSplit.layers[0].model_placement.rendered_size[1]-60/20)<.1,
    'A distorted model icon must recover the original target ratio');
  assert(iconWidth<=40&&iconHeight<30,'Use only downsampling while restoring source geometry');
  assert(iconSplit.layers[0].atlas_resize_scale.every(scale=>scale<=1));
  assert.equal(iconSplit.layers[0].atlas_source_bounds_fit,'original_bbox_ratio_downscale_only');
  const coupledDir=path.join(dir,'coupled_geometry_split');await fs.mkdir(coupledDir,{recursive:true});
  const coupledSplit=await splitSeedreamAtlasModel({source:sceneFixture,boxes:[{id:'coupled',category:'icon',members:['ring','artwork'],internal_front_to_back:['ring','artwork'],bbox:[10,10,72,32],source_bbox:[16,16,60,20]}],
    modelOutput:atlasFixture,batchDir:coupledDir,layout:{width:80,height:80,cells:[{x:0,y:0,width:80,height:80,crop_x:4,crop_y:4,crop_width:72,crop_height:32}]},
    model:'fixture',batchIndex:1,preserveAspectRatio:true,preserveSourceBounds:true});
  const coupled=coupledSplit.layers[0];
  assert.equal(coupled.atlas_source_bounds_fit,'uniform_contain_downscale_only','A composite union bbox must not anisotropically flatten its circular member');
  assert(Math.abs(coupled.model_placement.rendered_size[0]/coupled.model_placement.rendered_size[1]-4/3)<.1);
  const floorDir=path.join(dir,'floor_character_composite');await fs.mkdir(floorDir,{recursive:true});
  const floorSplit=await splitSeedreamAtlasModel({source:sceneFixture,boxes:[{id:'floor_and_person',category:'artwork',members:['magic_circle','character_archer'],internal_front_to_back:['magic_circle','character_archer'],bbox:[10,10,72,32],source_bbox:[16,16,60,20]}],
    modelOutput:atlasFixture,batchDir:floorDir,layout:{width:80,height:80,cells:[{x:0,y:0,width:80,height:80,crop_x:4,crop_y:4,crop_width:72,crop_height:32}]},
    model:'gpt-image-2.5-sunburst',batchIndex:1,preserveAspectRatio:true,preserveSourceBounds:true});
  assert.equal(floorSplit.layers[0].atlas_source_bounds_fit,'uniform_contain_downscale_only','A named floor-circle/character union must use the same aspect safeguard as ring/artwork');
  const disconnected=Buffer.alloc(20*20*4);
  const paint=(x,y,w,h,color)=>{for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)Buffer.from(color).copy(disconnected,(py*20+px)*4);};
  paint(4,1,3,2,[255,100,0,255]);paint(11,4,3,2,[255,100,0,255]);paint(2,11,16,8,[90,30,150,255]);
  const atlas=path.join(dir,'disconnected_atlas.png');await sharp(disconnected,{raw:{width:20,height:20,channels:4}}).png().toFile(atlas);
  const layout={width:20,height:20,cells:[{x:0,y:0,width:20,height:10},{x:0,y:10,width:20,height:10}]};
  const first=await fixedCellAlphaTile(atlas,layout,0,20,10),second=await fixedCellAlphaTile(atlas,layout,1,20,10);
  const firstPixels=await sharp(first.buffer).ensureAlpha().raw().toBuffer(),secondPixels=await sharp(second.buffer).ensureAlpha().raw().toBuffer();
  assert(first.rect.top+first.rect.height<=10,'Disconnected ornament must stay inside its assigned cell');
  assert(second.rect.top>=10,'Backplate must not be grouped with the ornament');
  assert(firstPixels.some((v,p)=>p%4===0&&v>200),'Both disconnected ornament components remain visible');
  assert(secondPixels.some((v,p)=>p%4===2&&v>100),'Later backplate keeps its own pixels');
  const bg=path.join(dir,'bg.png'),fg=path.join(dir,'fg.png');
  await sharp({create:{width:8,height:6,channels:4,background:{r:20,g:90,b:180,alpha:251/255}}}).png().toFile(bg);
  const firstHoles=path.join(dir,'holes_first.png'),nextHoles=path.join(dir,'holes_next.png');
  await deleteBboxes(bg,[{bbox:[1,1,2,2]}],firstHoles);
  await deleteBboxes(firstHoles,[{bbox:[5,3,2,2]}],nextHoles);
  const before=await sharp(bg).ensureAlpha().raw().toBuffer(),after=await sharp(nextHoles).ensureAlpha().raw().toBuffer();
  for(let y=0;y<6;y++)for(let x=0;x<8;x++){
    const p=(y*8+x)*4,deleted=(x>=1&&x<3&&y>=1&&y<3)||(x>=5&&x<7&&y>=3&&y<5);
    assert(after.subarray(p,p+4).equals(deleted?Buffer.alloc(4):before.subarray(p,p+4)),'Next round must retain previous alpha holes and exact surviving pixels');
  }
  const pixels=Buffer.alloc(4*4*4);
  for(let y=1;y<3;y++)for(let x=1;x<3;x++){
    const p=(y*4+x)*4;pixels[p]=250;pixels[p+1]=100;pixels[p+2]=10;pixels[p+3]=[35,130,205,255][(y-1)*2+x-1];
  }
  await sharp(pixels,{raw:{width:4,height:4,channels:4}}).png().toFile(fg);
  const expected=path.join(dir,'composite.png');await sharp(bg).composite([{input:fg,left:2,top:1}]).png().toFile(expected);
  const output=path.join(dir,'fixture.psd');
  await exportPsd({canvas:{width:8,height:6},layers:[{id:'background_final',kind:'background',source:bg,bbox:[0,0,8,6],z_index:0},{id:'glow',source:fg,bbox:[2,1,4,4],z_index:10}],text_layers:[]},output,expected);
  const psd=readPsdPixels(await fs.readFile(output));
  assert.deepEqual(psd.children.map(l=>[l.name,l.left,l.top]),[['background_final',0,0],['glow',2,1]]);
  const pngs=[];
  for(let i=0;i<psd.children.length;i++){
    const l=psd.children[i],raw=await sharp([bg,fg][i]).ensureAlpha().raw().toBuffer();
    assert(Buffer.from(l.imageData.data).equals(raw),'PSD modified RGBA or transparent padding');
    pngs.push({input:await sharp(Buffer.from(l.imageData.data),{raw:{width:l.imageData.width,height:l.imageData.height,channels:4}}).png().toBuffer(),left:l.left,top:l.top});
  }
  const recomposed=await sharp({create:{width:8,height:6,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(pngs).raw().toBuffer();
  assert(recomposed.equals(await sharp(expected).ensureAlpha().raw().toBuffer()));
  console.log('PASS: clipped overview duplicates without dropping child panels; recursive depth order; PSD position, padding, fractional alpha and recomposition');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
