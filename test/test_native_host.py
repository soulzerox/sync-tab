"""
Unit Tests for Python Native Host & SQLite Storage Engine
"""

import unittest
import tempfile
import os
import shutil
import sqlite3
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "native-host")))
from native_host import MAX_NATIVE_MESSAGE_BYTES, SyncTabDatabase, read_message, send_message


class TestSyncTabDatabase(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = Path(self.test_dir) / "test_tabs.sqlite"
        self.db = SyncTabDatabase(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_native_message_rejects_oversized_frame_before_reading_payload(self):
        import io
        import struct

        oversized_header = struct.pack("@I", MAX_NATIVE_MESSAGE_BYTES + 1)
        with patch("native_host.sys.stdin", io.TextIOWrapper(io.BytesIO(oversized_header))):
            # read_message uses stdin.buffer; the text wrapper exposes the original bytes.
            self.assertIsNone(read_message())

    def test_native_response_is_bounded_to_protocol_limit(self):
        import io

        output = io.BytesIO()
        with patch("native_host.sys.stdout", type("Stdout", (), {"buffer": output})()):
            send_message({"success": True, "payload": "x" * (MAX_NATIVE_MESSAGE_BYTES + 100)})
        output.seek(0)
        header = output.read(4)
        size = int.from_bytes(header, byteorder=sys.byteorder)
        self.assertLessEqual(size, MAX_NATIVE_MESSAGE_BYTES)
        payload = output.read(size)
        self.assertFalse(__import__("json").loads(payload)["success"])

    def test_database_initialization_and_wal_mode(self):
        self.assertTrue(self.db_path.exists())
        with self.db.get_connection() as conn:
            journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
            self.assertEqual(journal_mode.lower(), "wal")
            user_version = conn.execute("PRAGMA user_version;").fetchone()[0]
            self.assertEqual(user_version, 1)

    def test_schema_version_is_not_reset_on_every_connection(self):
        with self.db.get_connection() as conn:
            conn.execute("PRAGMA user_version = 7;")
            conn.commit()

        with self.db.get_connection() as conn:
            version = conn.execute("PRAGMA user_version;").fetchone()[0]
        self.assertEqual(version, 7, "opening a connection must not downgrade the database schema version")

    def test_clearing_previous_backup_removes_stale_sqlite_backup(self):
        self.assertTrue(self.db.save_state({
            "activeWindows": {},
            "closedWindows": {},
            "previousSessionBackup": {"timestamp": 10, "triggerReason": "manual_checkpoint", "windows": []}
        }))
        self.assertIsNotNone(self.db.load_state()["previousSessionBackup"])

        self.assertTrue(self.db.save_state({
            "activeWindows": {},
            "closedWindows": {},
            "previousSessionBackup": None
        }))
        self.assertIsNone(self.db.load_state()["previousSessionBackup"])

    def test_load_failure_returns_none_for_safe_local_fallback(self):
        with patch.object(self.db, "get_connection", side_effect=sqlite3.DatabaseError("database unavailable")):
            self.assertIsNone(self.db.load_state())

    def test_save_and_load_state_roundtrip(self):
        test_payload = {
            "version": "2.2.0",
            "activeWindows": {
                "uuid-win-1": {
                    "windowUuid": "uuid-win-1",
                    "customName": "Work Research",
                    "isClosed": False,
                    "isPinnedTemplate": False,
                    "lastUpdated": 1700000000000,
                    "bounds": {"left": 50, "top": 50, "width": 1400, "height": 900},
                    "tabs": [
                        {
                            "url": "https://github.com/microsoft/edge",
                            "title": "Microsoft Edge GitHub",
                            "favIconUrl": "https://github.com/favicon.ico",
                            "pinned": True,
                            "index": 0,
                            "group": {
                                "title": "Dev",
                                "color": "blue",
                                "collapsed": False
                            }
                        },
                        {
                            "url": "https://news.ycombinator.com",
                            "title": "Hacker News",
                            "favIconUrl": "",
                            "pinned": False,
                            "index": 1
                        }
                    ]
                }
            },
            "closedWindows": {
                "uuid-win-2": {
                    "windowUuid": "uuid-win-2",
                    "customName": "Shopping Archive",
                    "isClosed": True,
                    "isPinnedTemplate": True,
                    "closedAt": 1700000500000,
                    "lastUpdated": 1700000500000,
                    "bounds": {},
                    "tabs": [
                        {
                            "url": "https://amazon.com",
                            "title": "Amazon",
                            "pinned": False,
                            "index": 0
                        }
                    ]
                }
            },
            "previousSessionBackup": {
                "timestamp": 1700001000000,
                "triggerReason": "last_window_close",
                "totalWindows": 2,
                "totalTabs": 3,
                "windows": []
            }
        }

        # Save to SQLite
        save_ok = self.db.save_state(test_payload)
        self.assertTrue(save_ok)
        self.assertGreater(self.db.get_db_size(), 0)

        # Load back from SQLite
        loaded = self.db.load_state()
        self.assertEqual(loaded["version"], "2.2.0")
        self.assertIn("uuid-win-1", loaded["activeWindows"])
        self.assertIn("uuid-win-2", loaded["closedWindows"])

        win1 = loaded["activeWindows"]["uuid-win-1"]
        self.assertEqual(win1["customName"], "Work Research")
        self.assertEqual(len(win1["tabs"]), 2)
        self.assertEqual(win1["tabs"][0]["url"], "https://github.com/microsoft/edge")
        self.assertEqual(win1["tabs"][0]["pinned"], True)
        self.assertEqual(win1["tabs"][0]["group"]["title"], "Dev")
        self.assertEqual(win1["tabs"][0]["group"]["color"], "blue")

        win2 = loaded["closedWindows"]["uuid-win-2"]
        self.assertEqual(win2["isPinnedTemplate"], True)
        self.assertEqual(win2["tabs"][0]["url"], "https://amazon.com")

        self.assertIsNotNone(loaded["previousSessionBackup"])
        self.assertEqual(loaded["previousSessionBackup"]["triggerReason"], "last_window_close")


if __name__ == "__main__":
    unittest.main()
