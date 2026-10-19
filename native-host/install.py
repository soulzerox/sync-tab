#!/usr/bin/env python3
"""
Universal Cross-Platform Native Messaging Host Installer for SyncTab.
Supports:
- Windows 10 / 11 / Server (Registry configuration for Edge, Chrome, Brave, Vivaldi)
- macOS (Darwin NativeMessagingHosts directory configuration)
- Linux (Ubuntu, Debian, Fedora, Arch, openSUSE, and other XDG-compliant distros)
"""

import os
import sys
import json
import stat
from pathlib import Path

EXTENSION_ID = "gacoeejinnjilkgcjpbdgchngndpbjaa"
HOST_NAME = "com.synctab.native"
DESCRIPTION = "SyncTab Native SQLite Bridge for Microsoft Edge & Chromium (Cross-Platform)"

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_HOST_PY = SCRIPT_DIR / "native_host.py"
WINDOWS_LAUNCHER_BAT = SCRIPT_DIR / "native_host.bat"


def get_manifest_path_and_target():
    """Returns the host target path depending on OS."""
    if sys.platform.startswith("win"):
        return str(WINDOWS_LAUNCHER_BAT)
    return str(PYTHON_HOST_PY)


def create_manifest_json(target_path: str) -> dict:
    """Generates the native messaging host manifest dictionary."""
    return {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": target_path,
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{EXTENSION_ID}/"
        ]
    }


def get_persistent_app_dir() -> Path:
    """Returns the persistent installation directory for the current OS."""
    if sys.platform.startswith("win"):
        local_appdata = os.environ.get("LOCALAPPDATA")
        base = Path(local_appdata) if local_appdata else (Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg_data = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg_data) if xdg_data else (Path.home() / ".local" / "share")
    app_dir = base / "sync-tab"
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir


def deploy_host_files(app_dir: Path) -> str:
    """Copies native host scripts into persistent OS directory and returns executable target path."""
    dest_py = app_dir / "native_host.py"
    try:
        dest_py.write_bytes(PYTHON_HOST_PY.read_bytes())
    except OSError as exc:
        raise RuntimeError(f"Unable to deploy SyncTab Native Host to {dest_py}: {exc}") from exc

    if sys.platform.startswith("win"):
        dest_bat = app_dir / "native_host.bat"
        dest_bat.write_text(f'@echo off\npython "%~dp0native_host.py" %*\n')
        return str(dest_bat)
    else:
        dest_py.chmod(dest_py.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        return str(dest_py)


def install_windows(manifest_data: dict, app_dir: Path):
    """Installs native host on Windows by creating manifest and updating Windows Registry."""
    print("Detected Operating System: Windows")
    manifest_file = app_dir / f"{HOST_NAME}.json"
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)
    print(f"✅ Generated Windows Native Manifest: {manifest_file}")

    # Register in Windows Registry under HKCU
    try:
        import winreg

        registry_targets = [
            r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
            r"Software\Vivaldi\NativeMessagingHosts"
        ]

        for reg_sub_key in registry_targets:
            try:
                full_key_path = f"{reg_sub_key}\\{HOST_NAME}"
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, full_key_path)
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_file))
                winreg.CloseKey(key)
                print(f"✅ Registered in Registry: HKCU\\{full_key_path}")
            except Exception as reg_err:
                print(f"⚠️ Could not register in HKCU\\{reg_sub_key}: {reg_err}")

    except ImportError:
        print("⚠️ winreg module unavailable. Please ensure you are running on native Windows.")


def install_macos(manifest_data: dict):
    """Installs native host on macOS."""
    print("Detected Operating System: macOS (Darwin)")
    macos_targets = [
        Path.home() / "Library" / "Application Support" / "Microsoft Edge" / "NativeMessagingHosts",
        Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "NativeMessagingHosts",
        Path.home() / "Library" / "Application Support" / "Chromium" / "NativeMessagingHosts",
        Path.home() / "Library" / "Application Support" / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
        Path.home() / "Library" / "Application Support" / "Vivaldi" / "NativeMessagingHosts"
    ]

    for target_dir in macos_targets:
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            manifest_dest = target_dir / f"{HOST_NAME}.json"
            with open(manifest_dest, "w", encoding="utf-8") as f:
                json.dump(manifest_data, f, indent=2)
            print(f"✅ Registered Native Host: {manifest_dest}")
        except Exception as err:
            print(f"⚠️ Could not write to {target_dir}: {err}")


def install_linux(manifest_data: dict):
    """Installs native host on Linux and other Unix-like systems."""
    print("Detected Operating System: Linux / Unix")
    config_dir = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    linux_targets = [
        config_dir / "microsoft-edge" / "NativeMessagingHosts",
        config_dir / "microsoft-edge-stable" / "NativeMessagingHosts",
        config_dir / "microsoft-edge-beta" / "NativeMessagingHosts",
        config_dir / "microsoft-edge-dev" / "NativeMessagingHosts",
        config_dir / "google-chrome" / "NativeMessagingHosts",
        config_dir / "google-chrome-beta" / "NativeMessagingHosts",
        config_dir / "google-chrome-unstable" / "NativeMessagingHosts",
        config_dir / "chromium" / "NativeMessagingHosts",
        config_dir / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
        config_dir / "vivaldi" / "NativeMessagingHosts",
        config_dir / "opera" / "NativeMessagingHosts"
    ]

    for target_dir in linux_targets:
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            manifest_dest = target_dir / f"{HOST_NAME}.json"
            with open(manifest_dest, "w", encoding="utf-8") as f:
                json.dump(manifest_data, f, indent=2)
            print(f"✅ Registered Native Host: {manifest_dest}")
        except Exception as err:
            print(f"⚠️ Could not write to {target_dir}: {err}")


def main():
    print("=" * 60)
    print(" SyncTab Universal Cross-Platform Native Host Installer")
    print("=" * 60)

    app_dir = get_persistent_app_dir()
    target_path = deploy_host_files(app_dir)
    manifest_data = create_manifest_json(target_path)

    if sys.platform.startswith("win"):
        install_windows(manifest_data, app_dir)
    elif sys.platform == "darwin":
        install_macos(manifest_data)
    else:
        install_linux(manifest_data)

    # Verify SQLite Database creation
    try:
        sys.path.insert(0, str(SCRIPT_DIR))
        from native_host import SyncTabDatabase
        db = SyncTabDatabase()
        print(f"✅ Verified SQLite Database in WAL mode at: {db.db_path}")
    except Exception as db_err:
        print(f"⚠️ SQLite verification warning: {db_err}")

    print("=" * 60)
    print("🎉 Installation Complete on all supported browsers!")
    print("You can now open the SyncTab extension and click 'Test Connection'.")
    print("=" * 60)


if __name__ == "__main__":
    main()
