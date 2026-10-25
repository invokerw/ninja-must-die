"""Set per-run export metadata without storing signing credentials in the project."""

import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re


def prepare(project: Path, tag: str, version_code: int, signed: bool, config_dir: Path) -> dict:
    if not tag or not 1 <= version_code <= 2_100_000_000:
        raise ValueError("A nonempty build tag and a positive Android version code are required")
    # Slashes, shell metacharacters and non-ASCII tag names never enter output paths.
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", tag).strip(".-")[:80] or "build"
    if slug != tag:
        slug += "-" + hashlib.sha256(tag.encode()).hexdigest()[:8]

    presets = configparser.ConfigParser(interpolation=None, delimiters=("=",))
    presets.optionxform = str
    preset_path = project / "export_presets.cfg"
    with preset_path.open(encoding="utf-8") as source:
        presets.read_file(source)
    android = presets["preset.1.options"]
    android["version/code"] = str(version_code)
    android["version/name"] = json.dumps(tag.removeprefix("v"), ensure_ascii=False)
    android["package/unique_name"] = json.dumps(
        "io.github.invokerw.ninjamustdie" + ("" if signed else ".preview")
    )
    with preset_path.open("w", encoding="utf-8", newline="\n") as output:
        presets.write(output, space_around_delimiters=False)

    java_path = os.environ["JAVA_HOME"]
    android_path = os.environ["ANDROID_HOME"]
    config_dir.mkdir(parents=True, exist_ok=True)
    settings = config_dir / "editor_settings-4.7.tres"
    settings.write_text(
        '[gd_resource type="EditorSettings" format=3]\n\n[resource]\n'
        f'export/android/java_sdk_path = {json.dumps(java_path)}\n'
        f'export/android/android_sdk_path = {json.dumps(android_path)}\n',
        encoding="utf-8",
    )
    return {
        "build_name": f"ninja-must-die-{slug}",
        "android_mode": "release" if signed else "debug",
        "version_code": version_code,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--tag", default=os.environ.get("BUILD_TAG", ""))
    parser.add_argument("--version-code", type=int, default=int(os.environ.get("GITHUB_RUN_NUMBER", "1")))
    parser.add_argument("--signed", action="store_true")
    parser.add_argument("--config-dir", type=Path, default=Path.home() / ".config" / "godot")
    args = parser.parse_args()
    metadata = prepare(args.project, args.tag, args.version_code, args.signed, args.config_dir)
    print(json.dumps(metadata))
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            for key, value in metadata.items():
                output.write(f"{key}={value}\n")
