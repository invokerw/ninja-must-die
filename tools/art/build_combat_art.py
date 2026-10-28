"""Extract outlined combat sprites from retained native RGB sheets; record the matte."""
import hashlib
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "art/generated/combat_sources_20261027"
OUTPUT = ROOT / "art/generated/combat"
BOSS_ID = "ig_05fba3112b35c417016ae064208f6087d08f0126f82c7920b5"
OBJECT_ID = "ig_05fba3112b35c417016ae0646f4e2887d09cf58a7d4c2a6f61"


def extract(image, rows):
    rgb = np.asarray(image.convert("RGB")).astype(np.int16)
    h, w = rgb.shape[:2]
    neutral = (rgb.min(axis=2) > 140) & (rgb.max(axis=2) - rgb.min(axis=2) < 45)
    available = bytearray(neutral.astype(np.uint8).tobytes())
    removed = bytearray(w * h)
    pending = deque()
    for x in range(w):
        pending.extend([x, (h - 1) * w + x])
    for y in range(h):
        pending.extend([y * w, y * w + w - 1])
    while pending:
        at = pending.pop()
        if not available[at]:
            continue
        available[at] = 0
        removed[at] = 255
        x, y = at % w, at // w
        pending.extend(([at - 1] if x else []) + ([at + 1] if x < w - 1 else []) + ([at - w] if y else []) + ([at + w] if y < h - 1 else []))
    remaining = bytearray(255 - p for p in removed)
    found = []
    for start in range(w * h):
        if not remaining[start]:
            continue
        remaining[start] = 0
        pending = deque([start])
        pixels = []
        while pending:
            at = pending.pop()
            pixels.append(at)
            x, y = at % w, at // w
            for neighbor in ([at - 1] if x else []) + ([at + 1] if x < w - 1 else []) + ([at - w] if y else []) + ([at + w] if y < h - 1 else []):
                if remaining[neighbor]:
                    remaining[neighbor] = 0
                    pending.append(neighbor)
        if len(pixels) < 1200:
            continue
        xs, ys = [at % w for at in pixels], [at // w for at in pixels]
        bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
        cut = image.crop(bbox).convert("RGBA")
        alpha = Image.new("L", cut.size)
        for at in pixels:
            alpha.putpixel((at % w - bbox[0], at // w - bbox[1]), 255)
        # The dark outline surrounds bright metal; connected exterior removal keeps
        # enclosed white highlights. One source-pixel erosion removes checker fringes.
        alpha = alpha.filter(ImageFilter.MinFilter(3))
        cut.putalpha(alpha)
        found.append((bbox, cut))
    return sorted(found, key=lambda item: (int((item[0][1] + item[0][3]) / 2) // (h // rows), item[0][0]))


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []
    preview = Image.new("RGB", (1280, 1024), "#34495e")
    def save(name, source_id, source, size, preview_at, pivot=None):
        bbox, cut = source
        image = Image.new("RGBA", size)
        if pivot is None:
            cut.thumbnail((size[0] - 16, size[1] - 16), Image.Resampling.LANCZOS)
            origin = ((size[0] - cut.width) // 2, (size[1] - cut.height) // 2)
        else:
            cut = cut.resize((round(cut.width * 0.94), round(cut.height * 0.94)), Image.Resampling.LANCZOS)
            origin = (round(384 - (pivot[0] - bbox[0]) * 0.94), round(230 - (pivot[1] - bbox[1]) * 0.94))
            assert origin[0] >= 4 and origin[1] >= 4 and origin[1] + cut.height <= 508
        image.alpha_composite(cut, origin)
        path = OUTPUT / (name + ".png")
        image.save(path)
        records.append(dict(path=str(path.relative_to(ROOT / "art")), source_id=source_id, source_bbox=list(bbox), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), width=size[0], height=size[1], alpha_bbox=list(image.getbbox()), runtime_enabled=True, human_approved=False,
                            pixel_transform="RGB source; connected exterior neutral matte (min RGB>140, channel spread<45), keep enclosed highlights; 1px outline erosion, isolate connected subject, Lanczos fit with 8px margins. Not native generated alpha."))
        show = image.copy()
        show.thumbnail((400, 230))
        preview.paste(show, preview_at, show)
        ImageDraw.Draw(preview).text((preview_at[0], preview_at[1] + 232), name, fill="white")
    bosses = extract(Image.open(SOURCE / (BOSS_ID + ".png")), 2)
    objects = extract(Image.open(SOURCE / (OBJECT_ID + ".png")), 2)
    assert len(bosses) == 4, len(bosses)
    assert len(objects) == 6, len(objects)
    for index, name in enumerate(["boss_armored_v01", "boss_weak_v01", "boss_enraged_v01", "boss_defeated_v01"]):
        save(name, BOSS_ID, bosses[index], (768, 512), ((index % 2) * 620, (index // 2) * 256), [(384, 210), (1153, 210), (384, 719), (1153, 726)][index])
    for index, name in enumerate(["crescent_wheel_v01", "star_lance_v01", "shuriken_v01", "sentry_up_v01", "sentry_down_v01", "enemy_dart_v01"]):
        save(name, OBJECT_ID, objects[index], (256, 256), ((index % 3) * 420, 512 + (index // 3) * 256))
    (OUTPUT / "manifest.json").write_text(json.dumps(dict(stage="runtime_pending_visual_acceptance", assets=records), ensure_ascii=False, indent=2) + "\n")
    validation = ROOT / "art/validation/p2_combat_20261027"
    validation.mkdir(parents=True, exist_ok=True)
    preview.save(validation / "sprites.png")
    print("COMBAT_ART_BUILT", len(records), "textures")


if __name__ == "__main__":
    main()
