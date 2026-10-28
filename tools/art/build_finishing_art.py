"""Build the retained portrait app icon and a low foreground strip."""
import hashlib
import json
from pathlib import Path

from PIL import Image

from build_combat_art import extract
from build_environment_art import periodic_rgba

ROOT = Path(__file__).resolve().parents[2]
ICON_ID = "ig_05fba3112b35c417016ae066c1e58c87d0978113e1e2fdab2d"
FOREGROUND_ID = "ig_05fba3112b35c417016ae068e66a2487d09a2f80c0541a49c6"
generated = ROOT / "art/generated"
icon = Image.open(generated / "icon_sources_20261027" / (ICON_ID + ".png")).convert("RGB")
icon = icon.resize((1024, 1024), Image.Resampling.LANCZOS)
icon_path = generated / "application/app_icon_v01.png"
icon_path.parent.mkdir(exist_ok=True)
icon.save(icon_path)
source = Image.open(generated / "foreground_sources_20261027" / (FOREGROUND_ID + ".png"))
subjects = extract(source, 1)
assert len(subjects) == 1
bbox, cut = subjects[0]
cut = cut.resize((cut.width, round(cut.height * 0.5)), Image.Resampling.LANCZOS)
foreground = Image.new("RGBA", source.size)
foreground.alpha_composite(cut, (bbox[0], source.height - cut.height))
foreground_path = generated / "environments/fog_ridge_foreground_v01.png"
periodic_rgba(foreground).save(foreground_path)
records = []
for path, call_id, operation in [(icon_path, ICON_ID, "Lanczos resize retained opaque 1254px square portrait to 1024px application icon"), (foreground_path, FOREGROUND_ID, "RGB exterior-neutral matte, 1px outline erosion; vertically compress foreground 50% and bottom-align below route; 192px premultiplied cosine wrap seam")]:
    image = Image.open(path)
    records.append(dict(path=str(path.relative_to(ROOT / "art")), source_id=call_id, width=image.width, height=image.height, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), pixel_transform=operation, runtime_enabled=True, human_approved=False))
(generated / "application/manifest.json").write_text(json.dumps(dict(stage="runtime_pending_visual_acceptance", assets=records), ensure_ascii=False, indent=2) + "\n")
print("FINISHING_ART_BUILT", len(records), "textures")
