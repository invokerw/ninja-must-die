"""Exercise release/preview metadata and untrusted tag handling without an SDK."""

import configparser
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_export", ROOT / "tools/ci/prepare_export.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExportMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ninja-export-")
        self.addCleanup(self.directory.cleanup)
        self.project = Path(self.directory.name)
        (self.project / "export_presets.cfg").write_bytes((ROOT / "export_presets.cfg").read_bytes())
        self.environment = patch.dict(os.environ, {
            "JAVA_HOME": "C:/Build Tools/Java 17",
            "ANDROID_HOME": "C:/Build Tools/Android SDK",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def configure(self, tag="v0.14.0", code=12, signed=False):
        return MODULE.prepare(self.project, tag, code, signed, self.project / "settings")

    def android_settings(self):
        presets = configparser.ConfigParser(interpolation=None)
        presets.read(self.project / "export_presets.cfg", encoding="utf-8")
        return presets["preset.1.options"]

    def test_preview_is_installable_without_using_the_release_package_id(self):
        result = self.configure()
        settings = self.android_settings()
        self.assertEqual(result["android_mode"], "debug")
        self.assertEqual(json.loads(settings["package/unique_name"]), "io.github.invokerw.ninjamustdie.preview")
        self.assertEqual(settings["version/code"], "12")
        self.assertEqual(json.loads(settings["version/name"]), "0.14.0")

    def test_signed_build_uses_the_release_identity(self):
        result = self.configure(signed=True, code=13)
        self.assertEqual(result["android_mode"], "release")
        self.assertEqual(json.loads(self.android_settings()["package/unique_name"]), "io.github.invokerw.ninjamustdie")

    def test_tags_cannot_escape_output_directory_or_collide_after_sanitizing(self):
        first = self.configure(tag='release/test-$(echo bad)"')
        second = self.configure(tag='release-test--echo-bad-')
        self.assertRegex(first["build_name"], r"^[A-Za-z0-9._-]+$")
        self.assertNotEqual(first["build_name"], second["build_name"])
        self.assertEqual(json.loads(self.android_settings()["version/name"]), 'release-test--echo-bad-')

    def test_invalid_android_version_codes_fail_before_changing_presets(self):
        original = (self.project / "export_presets.cfg").read_bytes()
        for code in (0, -1, 2_100_000_001):
            with self.assertRaises(ValueError):
                self.configure(code=code)
        self.assertEqual((self.project / "export_presets.cfg").read_bytes(), original)

    def test_editor_paths_preserve_spaces_without_credentials(self):
        self.configure()
        settings = (self.project / "settings/editor_settings-4.7.tres").read_text(encoding="utf-8")
        self.assertIn('export/android/java_sdk_path = "C:/Build Tools/Java 17"', settings)
        self.assertIn('export/android/android_sdk_path = "C:/Build Tools/Android SDK"', settings)
        self.assertNotIn("password", settings)


if __name__ == "__main__":
    unittest.main()
