"""Rebuild the versioned P1 runtime assets from retained model outputs (requires Pillow)."""
import json, hashlib, shutil, subprocess, sys
from pathlib import Path
from PIL import Image, ImageOps
root=Path(__file__).resolve().parents[2]
out=root/'art/generated'
layers=json.loads((root/'art/workbench/ui_touch_combat_v02_20261026_01/layers.json').read_text())
rows={r['id']:r for r in layers}
records=[]
def record(path,source,operation):
 im=Image.open(path)
 records.append(dict(path=str(path.relative_to(root/'art')),source=source,pixel_transform=operation,width=im.width,height=im.height,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),alpha_bbox=im.getbbox(),runtime_enabled=True,human_approved=False))
def copy_layer(key,name):
 r=rows[key]; dst=out/name
 shutil.copyfile(r['source'],dst)
 record(dst,dict(layer_id=key,psd='layered/ui_touch_v02_candidate/source/layers.psd',source_sha256=hashlib.sha256(Path(r['source']).read_bytes()).hexdigest()),'none; byte-identical copy of model RGBA layer')
manifest=json.loads((root/'art/layered/ui_touch_v02_candidate/manifest.json').read_text())
for action,parts in manifest['actions'].items():
 for role,item in parts.items():
  src=root/'art/layered/ui_touch_v02_candidate'/item['path']
  dst=out/'ui'/src.name
  shutil.copyfile(src,dst)
  record(dst,dict(path=str(src.relative_to(root/'art')),sha256=item['sha256']),'none; byte-identical copy')
  item['path']=src.name
manifest.update(stage='runtime_integration',runtime_ready=True,user_visual_acceptance='pending',validation='../validation/p1_20261027/validation.json')
(out/'ui/touch_layout.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
for key,name in [
 ('loop_04_roi_1_status_panel','ui/panel.png'),
 ('loop_03_roi_1_portrait_composite','ui/portrait.png'),
 ('loop_03_roi_3_pause_backplate','ui/pause_plate.png'),
 ('loop_02_roi_3_pause_icon','ui/pause_icon.png'),
 ('loop_02_roi_3_settings_icon','ui/settings_icon.png'),
 ('loop_02_roi_5_gem_4','collectibles/shadow_crystal.png')]:copy_layer(key,name)
# Make the panorama explicitly periodic, with identical edge pixels at both joins.
# This is an adapted imagegen painting, not a newly generated independent scene layer.
src=root/'art/style_guide/style_anchor.png'
im=Image.open(src).convert('RGB').resize((1024,576),Image.Resampling.LANCZOS)
loop=Image.new('RGB',(2048,576));loop.paste(im,(0,0));loop.paste(ImageOps.mirror(im),(1024,0))
dst=out/'environments/fog_ridge_panorama.png';loop.save(dst)
record(dst,dict(path='style_guide/style_anchor.png',sha256=hashlib.sha256(src.read_bytes()).hexdigest()),'Lanczos downsample to 1024x576 then append horizontal mirror; periodic panorama with visible mirrored geography')
records[-1]['runtime_enabled']=False
# Independent source assets remain versioned separately from fitted runtime textures.
for builder in ['build_player_art.py','build_environment_art.py','build_interaction_art.py','build_combat_art.py','build_finishing_art.py']:
 subprocess.run([sys.executable,str(root/'tools/art'/builder)],check=True)
player_meta=json.loads((out/'characters/shadow_runner_v01.json').read_text())
record(out/'characters/shadow_runner_v01.png',dict(generation_ids=sorted({r['source_id'] for r in player_meta['frames']}),metadata='generated/characters/shadow_runner_v01.json'),player_meta['processing'])
for layer in json.loads((out/'environments/layers_v01.json').read_text())['layers']:
 record(root/'art'/layer['path'],dict(generation_id=layer['source_id']),layer['pixel_transform'])
spike_meta=json.loads((out/'obstacles/steel_spike_v01.json').read_text())
record(root/'art'/spike_meta['path'],dict(generation_id=spike_meta['source_id']),spike_meta['pixel_transform'])
for metadata_path in ['combat/manifest.json','application/manifest.json']:
 for asset in json.loads((out/metadata_path).read_text())['assets']:
  record(root/'art'/asset['path'],dict(generation_id=asset['source_id'],metadata='generated/'+metadata_path),asset['pixel_transform'])
# Rebuilding runtime textures must preserve generation/recovery evidence.
manifest_path=out/'manifest.json'
production_manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else dict(date='2026-10-27',user_acceptance='pending')
production_manifest.update(stage='production_art_first_pass_pending_review',generator='OpenAI native imagegen outputs; runtime adaptations and recovered originals tracked separately',assets=records,incomplete=['final motion and visual polish after review','user visual acceptance','Android device performance and touch validation'])
manifest_path.write_text(json.dumps(production_manifest,ensure_ascii=False,indent=2)+'\n')
print('Exported',len(records),'textures')

# JSON manifests document provenance; exported controls use static GDScript data.
actions={action:{role:{k:v for k,v in part.items() if k in ['path','bbox','width','height']} for role,part in parts.items()} for action,parts in manifest['actions'].items()}
(root/'scripts/ui/touch_art_layout.gd').write_text('# Export-safe runtime data. Rebuilt by tools/art/export_production_art.py.\nextends RefCounted\n\nconst ACTIONS := '+json.dumps(actions,ensure_ascii=False,indent='\t')+'\n')
