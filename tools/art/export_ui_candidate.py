#!/usr/bin/env python3
"""Package selected verified PSD layers without changing their RGB or alpha."""
import hashlib
import json
import shutil
import struct
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
RUN = PROJECT / "art/workbench/ui_touch_combat_v02_20261026_01"
OUT = PROJECT / "art/layered/ui_touch_v02_candidate"
SELECTION = {
    "jump_only": ("loop_03_roi_4_left_control_backplate", "loop_02_roi_4_jump_icon"),
    "rope_flip": ("loop_03_roi_4_right_control_backplate", "loop_02_roi_4_vertical_icon"),
    "dash": ("loop_03_roi_6_sprint_backplate", "loop_02_roi_6_sprint_icon"),
    "weapon": ("loop_03_roi_6_swirl_backplate", "loop_02_roi_6_swirl_icon"),
    "skill": ("loop_03_roi_6_slash_backplate", "loop_02_roi_6_slash_icon"),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    result = json.loads((RUN / "run_result.json").read_text())
    verified = json.loads((RUN / "inspection/artifact_readback.json").read_text())
    assert result["status"] == "completed" and result["structural_verification"] == "passed"
    assert verified["status"] == "passed"
    assert digest(RUN / "layers.psd") == verified["psd_sha256"]
    layers = {entry["id"]: entry for entry in json.loads((RUN / "layers.json").read_text())}
    hashes = {entry["id"]: entry["png_sha256"] for entry in verified["layers"]}
    (OUT / "textures").mkdir(parents=True, exist_ok=True)
    (OUT / "source").mkdir(exist_ok=True)
    (OUT / "source/.gdignore").write_text("")
    actions = {}
    for action, ids in SELECTION.items():
        actions[action] = {}
        for role, layer_id in zip(("plate", "icon"), ids):
            layer = layers[layer_id]
            source = Path(layer["source"])
            assert digest(source) == hashes[layer_id]
            relative = f"textures/{action}_{role}.png"
            target = OUT / relative
            shutil.copyfile(source, target)
            data = target.read_bytes()
            assert data[:8] == b"\x89PNG\r\n\x1a\n"
            width, height = struct.unpack(">II", data[16:24])
            assert [width, height] == layer["bbox"][2:]
            assert digest(target) == hashes[layer_id]
            actions[action][role] = {
                "path": relative,
                "source_layer_id": layer_id,
                "source_layer_path": str(source.relative_to(RUN)),
                "bbox": layer["bbox"],
                "width": width,
                "height": height,
                "sha256": hashes[layer_id],
                "pixel_transform": "none; byte-identical copy",
            }
    for name in ("layers.psd", "verification.json", "fidelity_verification.json"):
        shutil.copyfile(RUN / name, OUT / "source" / name)
    shutil.copyfile(RUN / "inspection/visual_review.json", OUT / "source/visual_review.json")
    manifest = {
        "schema_version": 1,
        "stage": "ui_component_candidate",
        "runtime_ready": False,
        "preview_ready": True,
        "user_visual_acceptance": "pending",
        "source_design": "art/concepts/ui_touch_combat_design_v02.png",
        "source_sha256": verified["source_sha256"],
        "source_run": str(RUN.relative_to(PROJECT)),
        "psd": "source/layers.psd",
        "psd_sha256": verified["psd_sha256"],
        "actions": actions,
        "state_rendering": "Godot tint, pressed transform, cooldown arc and live labels; source PNGs unchanged",
        "alternate_weapon": "star_lance uses the existing WeaponArt vector icon until matching raster art is made",
        "excluded": {
            "progress_rail_and_markers": "Duplicated nodes; preview uses a single native Godot progress rail with four fixed markers.",
            "tightrope_and_attachments": "Visual geometry differs from design; retain current gameplay rope.",
            "background_and_character": "Not part of this UI component package.",
            "raster_text": "Runtime text is rendered by Godot labels.",
        },
        "known_differences": ["Model-redrawn button rims, rivets, bevels and glow remain in the candidate textures."],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Exported {len(actions) * 2} unchanged PNG layers and candidate PSD to {OUT}")


if __name__ == "__main__":
    main()
