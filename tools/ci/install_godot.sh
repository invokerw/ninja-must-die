#!/usr/bin/env bash
set -euo pipefail

# Match the engine used for the project's regressions; use standard GDScript builds.
release="4.7-stable"
base_url="https://github.com/godotengine/godot-builds/releases/download/$release"
bin_dir="$HOME/.local/bin"
template_dir="$HOME/.local/share/godot/export_templates/4.7.stable"
download_dir="${RUNNER_TEMP:-/tmp}/ninja-godot-downloads"
mkdir -p "$bin_dir" "$template_dir" "$download_dir"

download_verified() {
  local filename="$1" checksum="$2"
  curl --fail --location --retry 3 --output "$download_dir/$filename" "$base_url/$filename"
  printf '%s  %s\n' "$checksum" "$download_dir/$filename" | sha256sum --check --status
}

case "${1:-}" in
  engine)
    if [[ ! -x "$bin_dir/godot" ]]; then
      archive="Godot_v${release}_linux.x86_64.zip"
      download_verified "$archive" "0b1a6c54c2c619c12e169fe9241edda4b81080b519451cec2984bf0d2c6cb73c"
      unzip -q -o "$download_dir/$archive" -d "$download_dir/engine"
      install -m 755 "$download_dir/engine/Godot_v${release}_linux.x86_64" "$bin_dir/godot"
      rm -- "$download_dir/$archive"
    fi
    "$bin_dir/godot" --version
    ;;
  templates)
    if [[ ! -f "$template_dir/windows_release_x86_64.exe" || ! -f "$template_dir/android_debug.apk" || ! -f "$template_dir/android_release.apk" ]]; then
      archive="Godot_v${release}_export_templates.tpz"
      download_verified "$archive" "9714459dc071907c0f3d5f17d608faf69e7cda21331fc5d39c4503ffa4e99eec"
      unzip -q -j -o "$download_dir/$archive" \
        templates/windows_release_x86_64.exe templates/android_debug.apk templates/android_release.apk \
        -d "$template_dir"
      rm -- "$download_dir/$archive"
    fi
    ;;
  *)
    printf 'Usage: %s engine|templates\n' "$0" >&2
    exit 2
    ;;
esac
