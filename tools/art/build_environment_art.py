"""Build a sky layer and a non-mirrored periodic RGBA ridge from native outputs."""
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "art/generated/environment_sources_20261027"
OUTPUT = ROOT / "art/generated/environments"
SKY_ID = "ig_05fba3112b35c417016ae05c50992487d0a34a6cfdcd54dff3"
RIDGE_ID = "ig_05fba3112b35c417016ae05c7fadbc87d0acf7902f27141c94"


def periodic_rgba(image, overlap=192):
    original = np.asarray(image).astype(np.float32) / 255.0
    # Remove near-zero alpha noise in the native output's otherwise empty sky.
    original[original[:, :, 3] <= 2.0 / 255.0] = 0.0
    # Blend RGB in premultiplied space so transparent pixels cannot add dark fringes.
    original[:, :, :3] *= original[:, :, 3:4]
    result = original[:, overlap:].copy()
    weight = ((1.0 - np.cos(np.linspace(0.0, np.pi, overlap))) / 2.0).reshape(1, overlap, 1)
    result[:, -overlap:] = original[:, -overlap:] * (1.0 - weight) + original[:, :overlap] * weight
    # The wrap is between neighboring original columns; match endpoints exactly.
    seam = (result[:, 0] + result[:, -1]) * 0.5
    result[:, 0] = result[:, -1] = seam
    alpha = result[:, :, 3:4]
    np.divide(result[:, :, :3], alpha, out=result[:, :, :3], where=alpha > 0)
    result[:, :, :3][np.repeat(alpha == 0, 3, axis=2)] = 0
    return Image.fromarray(np.clip(np.round(result * 255), 0, 255).astype(np.uint8))


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sky = OUTPUT / "fog_ridge_sky_v01.png"
    shutil.copyfile(SOURCE / (SKY_ID + ".png"), sky)
    image = Image.open(SOURCE / (RIDGE_ID + ".png")).convert("RGBA")
    destination = OUTPUT / "fog_ridge_middle_v01.png"
    periodic_rgba(image).save(destination)
    records = []
    for path, source_id, operation in [(sky, SKY_ID, "original opaque PNG; fixed sky with bounded camera drift, no repeating moon"), (destination, RIDGE_ID, "zero alpha<=2 native noise; 192px cosine wrap overlap in premultiplied RGBA; matching endpoint pixels; no mirroring")]:
        im = Image.open(path)
        records.append(dict(path=str(path.relative_to(ROOT / "art")), source_id=source_id, width=im.width, height=im.height, mode=im.mode, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), pixel_transform=operation, runtime_enabled=True, human_approved=False))
    (OUTPUT / "layers_v01.json").write_text(json.dumps(dict(stage="runtime_pending_visual_acceptance", layers=records), ensure_ascii=False, indent=2) + "\n")
    # Preview the true wrap boundary, over the sky.
    ridge = Image.open(destination)
    preview = Image.open(sky).convert("RGBA").resize((ridge.width, ridge.height))
    preview.alpha_composite(ridge)
    left = preview.crop((preview.width - 256, 0, preview.width, preview.height))
    right = preview.crop((0, 0, 256, preview.height))
    check = Image.new("RGB", (512, preview.height))
    check.paste(left, (0, 0))
    check.paste(right, (256, 0))
    check.save(ROOT / "art/validation/p1_player_20261027/middle_wrap.png")
    print("ENVIRONMENT_LAYERS_BUILT", [(r["width"], r["height"], r["mode"]) for r in records])


if __name__ == "__main__":
    main()
