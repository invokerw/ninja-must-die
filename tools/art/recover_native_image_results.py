"""Recover completed native image results from a local Codex rollout (requires Pillow)."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path

from PIL import Image


def image_calls(value):
    if isinstance(value, dict):
        if value.get("type") == "image_generation_call":
            yield value
        else:
            for child in value.values():
                yield from image_calls(child)
    elif isinstance(value, list):
        for child in value:
            yield from image_calls(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rollout", type=Path)
    parser.add_argument("--only-id", action="append", help="Recover only these image call IDs; repeat as needed")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "art/generated/recovered_20261027")
    args = parser.parse_args()
    records = []
    args.output.mkdir(parents=True, exist_ok=True)
    with args.rollout.open() as source:
        for line_number, line in enumerate(source, 1):
            if "image_generation_call" not in line:
                continue
            event = json.loads(line)
            for call in image_calls(event):
                if args.only_id and call.get("id") not in args.only_id:
                    continue
                if call.get("status") != "completed" or not isinstance(call.get("result"), str):
                    continue
                data = base64.b64decode(call["result"], validate=True)
                if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Completed result is not a PNG")
                im = Image.open(io.BytesIO(data))
                im.load()
                call_id = call["id"]
                if not call_id.startswith("ig_") or not call_id[3:].isalnum():
                    raise ValueError("Unexpected image call identifier")
                destination = args.output / (call_id + ".png")
                if destination.exists() and destination.read_bytes() != data:
                    raise ValueError("Refusing to overwrite a different recovered image")
                destination.write_bytes(data)
                records.append(dict(
                    id=call_id, timestamp_utc=event.get("timestamp"), status=call["status"],
                    source_line=line_number, path=destination.name,
                    base64_characters=len(call["result"]), bytes=len(data),
                    sha256=hashlib.sha256(data).hexdigest(), width=im.width, height=im.height,
                    mode=im.mode, has_alpha="A" in im.getbands() or "transparency" in im.info,
                    revised_prompt=call.get("revised_prompt"), runtime_enabled=False,
                ))
    report = dict(date="2026-10-27", source="local native image_generation_call result; original PNG bytes", images=records)
    (args.output / "recovery.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for row in records:
        print(json.dumps({k: v for k, v in row.items() if k != "revised_prompt"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
