#!/usr/bin/env python3
"""
SyncTab Native SQLite Host Bridge for Microsoft Edge on Ubuntu Linux.
Implements the Chromium Native Messaging standard stdio binary protocol with SQLite WAL mode.
Specification: SOT v2.2.0
"""

import sys
import os
import json
import struct
import sqlite3
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

# Chromium Native Messaging frames must stay within the protocol's 1 MiB limit.
MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024

def get_default_db_path() -> Path:
    """Returns OS-specific database path for Windows, macOS, or Linux/BSD."""
    if sys.platform.startswith("win"):
        # Windows: %LOCALAPPDATA%\sync-tab\tabs.sqlite
        local_appdata = os.environ.get("LOCALAPPDATA")
        base = Path(local_appdata) if local_appdata else (Path.home() / "AppData" / "Local")
        return base / "sync-tab" / "tabs.sqlite"
    elif sys.platform == "darwin":
        # macOS: ~/Library/Application Support/sync-tab/tabs.sqlite
        return Path.home() / "Library" / "Application Support" / "sync-tab" / "tabs.sqlite"
    else:
        # Linux / Unix / BSD: $XDG_DATA_HOME/sync-tab/tabs.sqlite or ~/.local/share/sync-tab/tabs.sqlite
        xdg_data = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg_data) if xdg_data else (Path.home() / ".local" / "share")
        return base / "sync-tab" / "tabs.sqlite"


# Configure logging to a rotating file instead of stderr. Browsers forward
# native-host stderr to syslog, which previously produced ~35k lines/day.
# The file handler keeps diagnostics without touching the stdio binary stream.
def _configure_logging() -> None:
    _log_path = get_default_db_path().parent / "native_host.log"
    _fmt = "[SyncTab NativeHost] %(asctime)s [%(levelname)s] %(message)s"
    try:
        _log_path.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            handlers=[RotatingFileHandler(str(_log_path), maxBytes=1_000_000, backupCount=1, encoding="utf-8")],
            level=logging.INFO,
            format=_fmt,
        )
    except OSError:
        # Data dir unwritable: fall back to WARNING-only stderr
        logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format=_fmt)


_configure_logging()


class SyncTabDatabase:
    def __init__(self, db_path: Path = None):
        self.db_path = db_path or get_default_db_path()
        self._ensure_directory()
        self._init_db()

    def _ensure_directory(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        # These two settings are connection-scoped; journal mode and schema version are not.
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self.get_connection() as conn:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS windows (
                    window_uuid TEXT PRIMARY KEY,
                    custom_name TEXT,
                    is_closed INTEGER DEFAULT 0,
                    is_pinned_template INTEGER DEFAULT 0,
                    closed_at INTEGER,
                    last_updated INTEGER NOT NULL,
                    bounds_json TEXT
                );

                CREATE TABLE IF NOT EXISTS tabs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    window_uuid TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT,
                    fav_icon_url TEXT,
                    pinned INTEGER DEFAULT 0,
                    tab_index INTEGER NOT NULL,
                    group_title TEXT,
                    group_color TEXT,
                    group_collapsed INTEGER DEFAULT 0,
                    FOREIGN KEY (window_uuid) REFERENCES windows(window_uuid) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS rolling_backups (
                    backup_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER NOT NULL,
                    trigger_reason TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_tabs_window ON tabs(window_uuid);
            """)
            # Never downgrade a database created by a newer schema version.
            current_version = conn.execute("PRAGMA user_version;").fetchone()[0]
            if current_version < 1:
                conn.execute("PRAGMA user_version = 1;")
            conn.commit()

    def get_db_size(self) -> int:
        try:
            return os.path.getsize(self.db_path)
        except OSError:
            return 0

    def save_state(self, schema: dict) -> bool:
        try:
            active_windows = schema.get("activeWindows", {})
            closed_windows = schema.get("closedWindows", {})
            backup = schema.get("previousSessionBackup")

            all_windows = {}
            all_windows.update(active_windows)
            all_windows.update(closed_windows)

            with self.get_connection() as conn:
                # Clear existing windows and cascade delete tabs
                conn.execute("DELETE FROM windows;")

                for uuid, win in all_windows.items():
                    bounds_json = json.dumps(win.get("bounds", {}))
                    conn.execute("""
                        INSERT INTO windows (
                            window_uuid, custom_name, is_closed, is_pinned_template,
                            closed_at, last_updated, bounds_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?);
                    """, (
                        uuid,
                        win.get("customName"),
                        1 if win.get("isClosed") else 0,
                        1 if win.get("isPinnedTemplate") else 0,
                        win.get("closedAt"),
                        win.get("lastUpdated", 0),
                        bounds_json
                    ))

                    # Insert tabs
                    tabs = win.get("tabs", [])
                    for tab in tabs:
                        group = tab.get("group", {})
                        conn.execute("""
                            INSERT INTO tabs (
                                window_uuid, url, title, fav_icon_url, pinned,
                                tab_index, group_title, group_color, group_collapsed
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                        """, (
                            uuid,
                            tab.get("url", ""),
                            tab.get("title", ""),
                            tab.get("favIconUrl", ""),
                            1 if tab.get("pinned") else 0,
                            tab.get("index", 0),
                            group.get("title", "") if group else "",
                            group.get("color", "") if group else "",
                            1 if (group and group.get("collapsed")) else 0
                        ))

                # Keep SQLite in sync when a rolling backup is cleared as well as when set.
                conn.execute("DELETE FROM rolling_backups;")
                if backup:
                    conn.execute("""
                        INSERT INTO rolling_backups (timestamp, trigger_reason, payload_json)
                        VALUES (?, ?, ?);
                    """, (
                        backup.get("timestamp", 0),
                        backup.get("triggerReason", "manual"),
                        json.dumps(backup)
                    ))

                conn.commit()
            return True
        except Exception as e:
            logging.error(f"Error saving state: {e}")
            return False

    def load_state(self) -> Optional[dict]:
        try:
            active_windows = {}
            closed_windows = {}

            with self.get_connection() as conn:
                win_rows = conn.execute("SELECT * FROM windows;").fetchall()
                for win_row in win_rows:
                    uuid = win_row["window_uuid"]
                    is_closed = bool(win_row["is_closed"])
                    bounds = json.loads(win_row["bounds_json"]) if win_row["bounds_json"] else {}

                    # Fetch tabs
                    tab_rows = conn.execute("""
                        SELECT * FROM tabs WHERE window_uuid = ? ORDER BY tab_index ASC;
                    """, (uuid,)).fetchall()

                    tabs = []
                    for t in tab_rows:
                        group = None
                        if t["group_title"]:
                            group = {
                                "title": t["group_title"],
                                "color": t["group_color"] or "grey",
                                "collapsed": bool(t["group_collapsed"])
                            }

                        tabs.append({
                            "url": t["url"],
                            "title": t["title"] or "Untitled",
                            "favIconUrl": t["fav_icon_url"] or "",
                            "pinned": bool(t["pinned"]),
                            "index": t["tab_index"],
                            "group": group
                        })

                    win_data = {
                        "windowUuid": uuid,
                        "customName": win_row["custom_name"],
                        "isClosed": is_closed,
                        "isPinnedTemplate": bool(win_row["is_pinned_template"]),
                        "closedAt": win_row["closed_at"],
                        "lastUpdated": win_row["last_updated"],
                        "bounds": bounds,
                        "tabs": tabs
                    }

                    if is_closed:
                        closed_windows[uuid] = win_data
                    else:
                        active_windows[uuid] = win_data

                # Fetch rolling backup
                backup = None
                backup_row = conn.execute("SELECT * FROM rolling_backups ORDER BY backup_id DESC LIMIT 1;").fetchone()
                if backup_row:
                    backup = json.loads(backup_row["payload_json"])

            return {
                "version": "2.2.0",
                "activeWindows": active_windows,
                "closedWindows": closed_windows,
                "previousSessionBackup": backup
            }
        except Exception as e:
            logging.error(f"Error loading state: {e}")
            # None signals the caller to use the extension's local mirror, not an empty state.
            return None


def read_message():
    """Reads a 4-byte length prefixed JSON message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    msg_length = struct.unpack("@I", raw_length)[0]
    if msg_length > MAX_NATIVE_MESSAGE_BYTES:
        logging.error("Native message rejected: %d bytes exceeds the %d-byte limit", msg_length, MAX_NATIVE_MESSAGE_BYTES)
        # Do not attempt to allocate/read an untrusted multi-gigabyte frame. The
        # caller treats None as EOF and exits, leaving the extension to use its mirror.
        return None
    raw_msg = sys.stdin.buffer.read(msg_length)
    if len(raw_msg) < msg_length:
        return None
    return json.loads(raw_msg.decode("utf-8"))


def send_message(message: dict):
    """Sends a 4-byte length prefixed JSON message to stdout."""
    encoded = json.dumps(message, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_NATIVE_MESSAGE_BYTES:
        encoded = json.dumps({
            "success": False,
            "error": f"Native response exceeds {MAX_NATIVE_MESSAGE_BYTES}-byte protocol limit"
        }).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    # Enforce pure binary stdio mode on Windows to prevent CRLF line ending corruption
    if sys.platform.startswith("win"):
        try:
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        except Exception as e:
            logging.warning(f"Could not set binary mode on Windows: {e}")

    db = SyncTabDatabase()
    logging.info(f"SyncTab Native Host started. Platform: {sys.platform}. DB path: {db.db_path}")

    while True:
        try:
            msg = read_message()
            if msg is None:
                logging.info("Stdin closed by browser. Exiting.")
                break

            action = msg.get("action", "")
            logging.debug("Received action: %s", action)

            if action == "PING":
                send_message({
                    "success": True,
                    "dbPath": str(db.db_path),
                    "dbSize": db.get_db_size()
                })
            elif action == "SAVE_STATE":
                ok = db.save_state(msg.get("payload", {}))
                send_message({
                    "success": ok,
                    "dbPath": str(db.db_path),
                    "dbSize": db.get_db_size()
                })
            elif action == "LOAD_STATE":
                data = db.load_state()
                send_message({
                    "success": data is not None,
                    "data": data,
                    **({} if data is not None else {"error": "Could not load SQLite state"}),
                    "dbPath": str(db.db_path),
                    "dbSize": db.get_db_size()
                })
            else:
                send_message({
                    "success": False,
                    "error": f"Unknown action: {action}"
                })
        except Exception as e:
            logging.error(f"Error in main loop: {e}")
            send_message({"success": False, "error": str(e)})


if __name__ == "__main__":
    main()
