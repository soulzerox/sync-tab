# AGENTS.md — sync tab

Chrome/Edge extension "SyncTab" + Python Native Messaging host (stdio + SQLite WAL).

## Layout
- `manifest.json`, `background/`, `popup/`, `shared/`, `icons/` — extension (MV3)
- `native-host/native_host.py` — native messaging host (deployed copy: `~/.local/share/sync-tab/native_host.py`, manifests in browser `NativeMessagingHosts/com.synctab.native.json`)
- `test/` — python + JS test suites

## Conventions
- Native host logs MUST NOT go to stdout (corrupts stdio binary protocol). Use rotating file logs under `$XDG_DATA_HOME/sync-tab/`.
- Keep deployed `~/.local/share/sync-tab/native_host.py` in sync with `native-host/native_host.py`.
- Spec source of truth: `SOT.md`.