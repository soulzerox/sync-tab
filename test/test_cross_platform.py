import unittest
import tempfile
import sys
import os
from pathlib import Path
from unittest.mock import patch

# Add native-host to sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT / "native-host"))

from native_host import get_default_db_path, SyncTabDatabase
from install import create_manifest_json, deploy_host_files, get_manifest_path_and_target, EXTENSION_ID, HOST_NAME


class TestCrossPlatformSupport(unittest.TestCase):
    def test_linux_db_path_resolution(self):
        with patch.object(sys, "platform", "linux"):
            with patch.dict(os.environ, {"XDG_DATA_HOME": "/custom/xdg/data"}):
                p = get_default_db_path()
                self.assertEqual(str(p), "/custom/xdg/data/sync-tab/tabs.sqlite")

    def test_macos_db_path_resolution(self):
        with patch.object(sys, "platform", "darwin"):
            p = get_default_db_path()
            expected_suffix = os.path.join("Library", "Application Support", "sync-tab", "tabs.sqlite")
            self.assertTrue(str(p).endswith(expected_suffix))

    def test_windows_db_path_resolution(self):
        with patch.object(sys, "platform", "win32"):
            with patch.dict(os.environ, {"LOCALAPPDATA": "/mock/windows/appdata/local"}):
                p = get_default_db_path()
                self.assertTrue(str(p).endswith("sync-tab/tabs.sqlite") or str(p).endswith(r"sync-tab\tabs.sqlite"))
                self.assertEqual(p.name, "tabs.sqlite")

    def test_deployment_failure_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_source = type("BrokenSource", (), {
                "read_bytes": lambda self: (_ for _ in ()).throw(PermissionError("permission denied"))
            })()
            with patch("install.PYTHON_HOST_PY", fake_source):
                with patch.object(sys, "platform", "linux"):
                    with self.assertRaisesRegex(RuntimeError, "Unable to deploy SyncTab Native Host"):
                        deploy_host_files(Path(temp_dir))

    def test_universal_manifest_generation(self):
        manifest = create_manifest_json("/path/to/host")
        self.assertEqual(manifest["name"], HOST_NAME)
        self.assertEqual(manifest["type"], "stdio")
        self.assertEqual(manifest["allowed_origins"], [f"chrome-extension://{EXTENSION_ID}/"])


if __name__ == "__main__":
    unittest.main()
