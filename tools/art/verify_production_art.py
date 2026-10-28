"""Check provenance, transparency and the two joins in the mirrored panorama."""
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT / "art/generated/manifest.json").read_text())
for asset in manifest["assets"]:
    path = ROOT / "art" / asset["path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == asset["sha256"], path
    image = Image.open(path)
    assert image.size == (asset["width"], asset["height"]), path
    if image.mode == "RGBA":
        alpha = image.getchannel("A")
        low, high = alpha.getextrema()
        assert low == 0 and high >= 240, path
        assert alpha.getpixel((0, 0)) == 0, path
        if not path.name.startswith('fog_ridge_foreground'):
            assert alpha.getpixel((image.width - 1, image.height - 1)) == 0, path

panorama = Image.open(ROOT / "art/generated/environments/fog_ridge_panorama.png")
assert panorama.crop((0, 0, 1, panorama.height)).tobytes() == panorama.crop(
    (2047, 0, 2048, panorama.height)
).tobytes(), "Panorama wrap edge"
assert panorama.crop((1023, 0, 1024, panorama.height)).tobytes() == panorama.crop(
    (1024, 0, 1025, panorama.height)
).tobytes(), "Panorama mirror join"
atlas = Image.open(ROOT / "art/generated/characters/shadow_runner_v01.png")
frames = json.loads((ROOT / "art/generated/characters/shadow_runner_v01.json").read_text())
assert atlas.size == (1280, 1024) and atlas.mode == "RGBA"
assert len(frames['frames']) == 20
for frame in frames['frames']:
    x, y, width, height = frame['region']
    alpha = atlas.crop((x, y, x + width, y + height)).getchannel('A')
    bbox = alpha.getbbox()
    assert bbox and bbox[0] >= 2 and bbox[1] >= 2 and bbox[2] <= 254 and bbox[3] <= 254
    # Neighboring frames must not bleed through crop margins.
    assert alpha.crop((0, 0, 256, 2)).getextrema()[1] == 0
    assert alpha.crop((0, 254, 256, 256)).getextrema()[1] == 0
ridge = Image.open(ROOT / "art/generated/environments/fog_ridge_middle_v01.png")
assert ridge.mode == 'RGBA'
assert ridge.crop((0, 0, 1, ridge.height)).tobytes() == ridge.crop((ridge.width - 1, 0, ridge.width, ridge.height)).tobytes(), 'Middle layer wrap'
assert ridge.getchannel('A').crop((0, 0, ridge.width, 250)).getextrema()[1] == 0, 'Middle layer clear sky'
foreground = Image.open(ROOT / 'art/generated/environments/fog_ridge_foreground_v01.png')
assert foreground.crop((0, 0, 1, foreground.height)).tobytes() == foreground.crop((foreground.width - 1, 0, foreground.width, foreground.height)).tobytes(), 'Foreground wrap'
assert foreground.getchannel('A').crop((0, 0, foreground.width, 790)).getextrema()[1] == 0, 'Foreground must remain below gameplay'
combat = json.loads((ROOT / 'art/generated/combat/manifest.json').read_text())
assert len(combat['assets']) == 10
for asset in combat['assets']:
    image = Image.open(ROOT / 'art' / asset['path'])
    alpha = image.getchannel('A')
    assert alpha.getbbox() == tuple(asset['alpha_bbox'])
    assert alpha.getextrema() == (0, 255)
    assert alpha.getpixel((0, 0)) == 0
icon = Image.open(ROOT / 'art/generated/application/app_icon_v01.png')
assert icon.size == (1024, 1024) and icon.mode == 'RGB'
print(f"ART_ASSETS_PASS ({len(manifest['assets'])} hashes, 20 bounded character frames, 10 combat sprites, alpha, ridge/foreground wraps, icon)")
