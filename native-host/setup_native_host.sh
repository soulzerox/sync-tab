#!/usr/bin/env bash
# ==============================================================================
# SyncTab Native SQLite Host 1-Click Installer for Linux & macOS
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 is not installed. Please install Python 3 using your package manager."
    exit 1
fi

chmod +x "$SCRIPT_DIR/native_host.py"
chmod +x "$SCRIPT_DIR/install.py"
chmod +x "$SCRIPT_DIR/setup_native_host.sh"

python3 "$SCRIPT_DIR/install.py"
