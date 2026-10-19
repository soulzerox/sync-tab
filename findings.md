# Findings: Edge Tab Recovery Safety Net

- `previousSessionBackup` is currently created for last-window-close, crash reconciliation, and manual backup; no periodic capture or popup restore path exists.
- `RESTORE_SESSION_BACKUP` is declared but unused.
- `manifest.json` already grants the `alarms` permission.
- `syncActiveWindows` replaces the live mirror from each capture, so the checkpoint ring must be independent from active state.
- `DiffEngine.syncWindowToActive` already performs URL-deduped additive restore, staggered creation, and group reconstruction; expose the same core for checkpoint-provided tabs.
- Browser tab-removal events do not prove whether the user or browser initiated a closure; surface mass drops as suspected and give the user an acknowledge action.
- The Native Messaging SQLite schema does not preserve settings or recovery metadata; `NativeAdapter.loadAll()` merges them from `chrome.storage.local`. The deployed host is kept in sync with `native-host/native_host.py` through the installer.
- Local storage is written before SQLite; if SQLite fails, the next worker startup must reconcile by window UUID and revision instead of blindly trusting a non-empty but stale native database.
- Native Messaging input and output frames are bounded to 1 MiB. Oversized input terminates that host process so it cannot misparse the remaining bytes as a new frame; the extension can fall back to its local mirror.
- `blacklistDomains` existed in the settings schema but had no effect and no popup control. It now normalizes domain entries, filters active snapshots, and can be edited in Settings.
- Recovery mass-loss heuristics must distinguish explicit whole-window closure from unexplained tab drops; after a non-final regular window closes, refresh the baseline with the one-event loss check bypassed.
- Manual backups must be copied by value; otherwise mutations to shared active-window objects can retroactively alter a backup.
- To avoid native messaging payload growth, checkpoint tabs keep only URL, pinned/order, and group metadata; titles and favicons remain in the active mirror.
- Restore diff checks tabs across all regular windows, not only the target window, so checkpoint recovery does not recreate a URL already open elsewhere.
- Empty page titles were sanitized to the literal `Untitled`, which was then persisted and shown by the popup. `sanitizeTitle` now accepts a URL fallback and derives a title from HTTP(S) hostname plus the final path segment; initialization repairs legacy placeholders in active/closed windows and saved checkpoint/session snapshots, preserving meaningful titles. Popup display also uses this fallback defensively.
- No CONTEXT.md exists. `SOT.md` is the project source of truth.
