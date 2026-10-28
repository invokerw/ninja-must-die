"""Assemble retained native RGBA poses into aligned runtime frames (Pillow only)."""
import hashlib
import json
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "art/generated/player_sources_20261027"
OUTPUT = ROOT / "art/generated/characters"
RUN_ID = "ig_05fba3112b35c417016ae05abd897887d086aafe5305a2e6d3"
POSE_ID = "ig_05fba3112b35c417016ae05a33c6a087d0a2349fe6ea44edc8"


def subjects(image, row_height):
    """Isolate connected solid subjects and retain their original soft edge alpha."""
    w, h = image.size
    remaining = bytearray(image.getchannel("A").point(lambda a: 255 if a > 100 else 0).tobytes())
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
        if len(pixels) < 500:
            continue
        xs, ys = [p % w for p in pixels], [p // w for p in pixels]
        box = (max(0, min(xs) - 3), max(0, min(ys) - 3), min(w, max(xs) + 4), min(h, max(ys) + 4))
        cut = image.crop(box)
        mask = Image.new("L", cut.size)
        for at in pixels:
            mask.putpixel((at % w - box[0], at // w - box[1]), 255)
        mask = mask.filter(ImageFilter.MaxFilter(5))
        cut.putalpha(ImageChops.darker(cut.getchannel("A"), mask))
        found.append((box, cut))
    return sorted(found, key=lambda item: (item[0][1] // row_height, item[0][0]))


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    run_image = Image.open(SOURCE / (RUN_ID + ".png")).convert("RGBA")
    pose_image = Image.open(SOURCE / (POSE_ID + ".png")).convert("RGBA")
    runs, poses = subjects(run_image, 512), subjects(pose_image, 256)
    assert len(runs) == 8 and len(poses) == 24
    atlas = Image.new("RGBA", (1280, 1024))
    records = []
    preview = Image.new("RGB", (1280, 1136), "#3c4d66")
    pen = ImageDraw.Draw(preview)

    def place(name, index, source_id, source, scale, pivot, destination):
        box, cut = source
        resized = cut.resize((round(cut.width * scale), round(cut.height * scale)), Image.Resampling.LANCZOS)
        at = (round(destination[0] - (pivot[0] - box[0]) * scale), round(destination[1] - (pivot[1] - box[1]) * scale))
        assert min(at) >= 4 and at[0] + resized.width <= 252 and at[1] + resized.height <= 252, (name, index, at, resized.size)
        frame = Image.new("RGBA", (256, 256))
        frame.alpha_composite(resized, at)
        number = len(records)
        origin = ((number % 5) * 256, (number // 5) * 256)
        atlas.alpha_composite(frame, origin)
        records.append(dict(animation=name, frame=index, region=[*origin, 256, 256], source_id=source_id, source_bbox=list(box), scale=scale, source_pivot=list(pivot), destination_pivot=list(destination), alpha_bbox=list(frame.getbbox())))
        py = origin[1] + (number // 5) * 28 + 28
        preview.paste(frame, (origin[0], py), frame.getchannel("A"))
        pen.text((origin[0] + 8, py - 20), f"{name} {index}", fill="white")
        if name in ("run", "hang"):
            line_y = py + (24 if name == "hang" else 228)
            pen.line((origin[0], line_y, origin[0] + 255, line_y), fill="#cba866", width=1)

    faces = [354, 713, 1076, 1467, 368, 716, 1077, 1466]
    for index, source in enumerate(runs):
        # Keep the face/torso horizontally stable, with contact/down/passing/flight height changes.
        box, _ = source
        bottom = 208 if index % 4 == 3 else 228
        top = bottom - source[1].height * 0.46
        place("run", index, RUN_ID, source, 0.46, (faces[index], box[1]), (177, top))
    for index in range(4):
        source = poses[12 + index]
        box, _ = source
        # Both hands share a fixed rope height; the torso stays upright beneath it.
        hand_mid_x = [136, 384, 637, 895][index]
        place("hang", index, POSE_ID, source, 0.80, (hand_mid_x, 531), (144, 24))
    for index in range(2):
        source = poses[16 + index]
        box, _ = source
        place("jump" if index == 0 else "fall", 0, POSE_ID, source, 0.82, ([1198, 1479][index], box[1]), (177, 48))
    for index in range(2):
        source = poses[18 + index]
        box, _ = source
        place("flip", index, POSE_ID, source, 0.80, ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), (138, 126))
    for index in range(2):
        place("dash", index, POSE_ID, poses[20 + index], 0.78, ([685, 936][index], 885), (148, 126))
    place("hurt", 0, POSE_ID, poses[22], 0.82, (1164, 890), (144, 126))
    place("death", 0, POSE_ID, poses[23], 0.80, (1420, 977), (144, 228))
    destination = OUTPUT / "shadow_runner_v01.png"
    atlas.save(destination)
    report = dict(stage="runtime_pending_visual_acceptance", frame_size=[256, 256], draw_scale=1 / 3, anchor=[144, 126], canvas=list(atlas.size),
                  sha256=hashlib.sha256(destination.read_bytes()).hexdigest(),
                  processing="Connected native-alpha subjects (>100 core; 2px edge expansion), retain original alpha inside each subject; Lanczos resize, fixed frame placement. No synthetic limb motion, mirrored poses or inverted hanging.",
                  frames=records)
    (OUTPUT / "shadow_runner_v01.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    preview.save(ROOT / "art/validation/p1_player_20261027/frames.png")
    print("PLAYER_ATLAS_BUILT", len(records), "frames", atlas.size)


if __name__ == "__main__":
    (ROOT / "art/validation/p1_player_20261027").mkdir(parents=True, exist_ok=True)
    main()
