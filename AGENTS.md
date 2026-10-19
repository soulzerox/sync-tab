# AGENTS.md — sync tab

Chrome/Edge extension "SyncTab — Group Sync" (MV3). Group-only tab sync: mirror live named tab groups in real time, let the user restore saved tabs as sleeping (discarded) tabs from the popup. No native messaging host since v3 (see `docs/adr/0001-teardown-window-sync-system.md`).

## Layout
- `manifest.json` — MV3 manifest, permissions: `tabs`, `tabGroups`, `storage`, `unlimitedStorage`
- `background/service-worker.js` — wires chrome listeners synchronously (mirror), message router for the 6 RPC types
- `background/browser-mirror.js` — chrome events → in-memory registries → liveMap → GroupStore
- `background/group-store.js` — the single state seam (storage projection, schema v3, debounced persist + `flush()`)
- `background/restore-engine.js` — restore flow: diff → create → group → setColor → discard, staggered + mutex
- `background/url-sanitizer.js` — URL filtering/normalizing (kept from v2; `TRACKING_PARAM_PREFIXES` is now `[]`)
- `popup/` — popup UI (html/css/js; tokens in `design-system/synctab/pages/popup.md`)
- `shared/` — `constants.js` (schema/keys/timings), `messages.js` (MSG RPC + theme values), `types.js` (JSDoc), `ui-utils.js` (pure popup helpers)
- `test/` — `node --test` suites with the shared fake-chrome harness (`test/fake-chrome.js`)
- `SOT.md` / `CONTEXT.md` / `PRODUCT.md` / `docs/` — spec, glossary, product note, ADR + history

## Conventions
- Spec source of truth: `SOT.md` (v3 sync laws L1–L12; read before touching sync behavior).
- Popup talks to the service worker ONLY via `chrome.runtime.sendMessage` (`shared/messages.js` MSG constants) — no direct `chrome.tabs`/`chrome.storage` in popup.
- All state mutations go through `GroupStore`; mirror is read-only over registries. Persist is debounced (80 ms) — end writes with `await store.flush()` when determinism matters.
- Tab/group identity = exact group name (trim-able but case-sensitive window-agnostic); ungrouped tabs, unnamed groups, incognito, and privileged URLs (`edge://*`, etc.) are never tracked (L1).
- Restore simulates a staggered sequence: `tabs.create → tabs.group → tabGroups.update(color) → tabs.discard` per tab, always discard LAST (sleeping tabs), guarded by a per-name mutex; live group lookup happens in the focused window only.
- Tests run with `npm test` (`node --test`, ESM). Keep tests framework-free; reuse `test/fake-chrome.js` (seed convention: explicit ids ≥ 100; fake-generated ids start at 1).
- No bundler/build step; plain ES modules everywhere.
