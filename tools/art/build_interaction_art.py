"""Fit a generated triangular spike to the exact gameplay collision silhouette."""
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CALL_ID = "ig_05fba3112b35c417016ae05ee1b8dc87d0bb351d6e42e4e23f"
source = ROOT / "art/generated/interaction_sources_20261027" / (CALL_ID + ".png")
image = Image.open(source).convert("RGBA")
# The native result has a baked checkerboard. Use the known straight metal outline,
# never color-key the reflective steel or pretend the source had native alpha.
vertices = [(628, 88), (249, 1147), (1005, 1147)]
mask = Image.new("L", image.size)
ImageDraw.Draw(mask).polygon(vertices, fill=255)
image.putalpha(mask)
image = image.crop((247, 86, 1007, 1149)).resize((256, 256), Image.Resampling.LANCZOS)
# Enforce the runtime triangle after filtering to prevent any painted pixels outside
# its collision silhouette. Supersampling keeps a soft, subpixel edge at game scale.
mask = Image.new("L", (1024, 1024))
ImageDraw.Draw(mask).polygon([(512, 4), (4, 1016), (1020, 1016)], fill=255)
mask = mask.resize((256, 256), Image.Resampling.LANCZOS)
from PIL import ImageChops
image.putalpha(ImageChops.darker(image.getchannel("A"), mask))
output = ROOT / "art/generated/obstacles/steel_spike_v01.png"
output.parent.mkdir(parents=True, exist_ok=True)
image.save(output)
record = dict(path=str(output.relative_to(ROOT / "art")), source_id=CALL_ID, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), sha256=hashlib.sha256(output.read_bytes()).hexdigest(), width=256, height=256,
              pixel_transform="Native RGB artwork; explicit triangle alpha mask at source vertices (628,88),(249,1147),(1005,1147), crop (247,86,1007,1149), Lanczos to 256 square, supersampled collision-outline mask. Not native generated alpha.", runtime_enabled=True, human_approved=False)
output.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
print("INTERACTION_ART_BUILT", output.name)
