const assert=require('node:assert/strict');
const {assignHintOwners,validateCombined,sourceBox}=require('./bbox_combined_detection.js');

const regions=[
  {id:'left',core:[0,0,500,600],crop:{left:0,top:0,width:580,height:600}},
  {id:'right',core:[500,0,500,600],crop:{left:420,top:0,width:580,height:600}},
  {id:'overview',core:[0,0,1000,600],crop:{left:0,top:0,width:1000,height:600}},
];
const hints=[{id:'small',bbox:[480,100,60,60]},{id:'crossing',bbox:[200,100,600,200]}];
const owners=assignHintOwners(hints,regions);
assert.deepEqual(owners.get('right').map(x=>x.id),['small']);
assert.deepEqual(owners.get('overview').map(x=>x.id),['crossing']);
assert.equal([...owners.values()].flat().length,2,'Each prior target must have exactly one complete-view owner');
assert.deepEqual(sourceBox([100,200,500,800],regions[1].crop),[536,60,348,240]);
const reply={elements:[{id:'target',original_present:true,original_box:[100,200,500,800]}],
  hint_checks:[{hint_id:'small',status:'present',element_id:'target'}]};
validateCombined(reply,[hints[0]]);
assert.throws(()=>validateCombined({...reply,hint_checks:[]},[hints[0]]),/Missing owned/);
assert.throws(()=>validateCombined({...reply,hint_checks:[{hint_id:'small',status:'present',element_id:'invented'}]},[hints[0]]),/no inventory/);
assert.throws(()=>validateCombined({...reply,elements:[{id:'target',original_present:true,original_box:[0,0,1001,100]}]},[hints[0]]),/original geometry/);
validateCombined({elements:[],hint_checks:[{hint_id:'small',status:'uncertain',element_id:null}]},[hints[0]]);
validateCombined({elements:[{id:'invented_panel',original_present:false,original_box:null}],hint_checks:[]},[]);
const {groupCoupledRearCandidates}=require('./rear_coupled_composites.js');
const pair=[{id:'ring',description:'luminous cyan ring',bbox:[10,20,50,50],original_measurement:{present:true,bbox:[9,19,52,52]}},
  {id:'map',category:'artwork',description:'map illustration',bbox:[30,40,50,40],original_measurement:{present:true,bbox:[29,39,52,42]}}];
assert.deepEqual(groupCoupledRearCandidates(pair)[0].original_measurement.bbox,[9,19,72,62],'Coupled original geometry must cover both ring and artwork');
assert.equal(groupCoupledRearCandidates([{...pair[0],original_measurement:undefined},pair[1]])[0].original_measurement,undefined,'Incomplete coupled evidence needs conventional grounding');
const floorEffect=[{id:'floor_circle',category:'decoration',description:'glowing cyan concentric rings on the stone floor',bbox:[250,775,690,85],occluded_by:['archer']},
  {id:'archer',category:'artwork',description:'full-body archer illustration',bbox:[375,90,480,735],occluded_by:[]}];
const separate=groupCoupledRearCandidates(floorEffect);
assert.deepEqual(separate.map(el=>el.id),['floor_circle','archer'],'A floor effect behind a character must remain a separate layer');
assert.deepEqual(separate[0].occluded_by,['archer'],'Coupling must not reverse the detected front/behind relation');
console.log('PASS: one complete-view owner per hint; crop/source geometry; present links; uncertain fallback; invalid replies rejected');
