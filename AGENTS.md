# AGENTS.md — sync tab

Chrome/Edge extension "SyncTab — Group Sync" (MV3). Group-only tab sync: mirror live named tab groups in real time, let the user restore saved tabs as sleeping (discarded) tabs from the popup. No native messaging host since v3 (see `docs/adr/0001-teardown-window-sync-system.md`).

## Layout
- `manifest.json` — MV3 manifest, permissions: `tabs`, `tabGroups`, `storage`, `unlimitedStorage`
- `background/service-worker.js` — wires chrome listeners synchronously (mirror), message router for the 8 RPC types
- `background/browser-mirror.js` — chrome events → in-memory registries → liveMap → GroupStore; URL แท็บอ่านจาก `changeInfo.url`/`pendingUrl` (v3.2 — `tab.url` ใน event ยังเป็นค่าเก่า); แท็บหลับแบบ Edge (`discarded` ยังเปิดค้าง) ยังเข้า registry นับตื่นตาม L17 — ยกเว้นแท็บผลจาก restore (ธง `s` ใน binding, ผู้ใช้กดตื่นแล้วถอนธง); prune ตอน reconcile เอาเฉพาะแท็บที่ปิดไปจริงตาม window scan
- `background/group-store.js` — the single state seam (storage projection, schema v3, debounced persist + `flush()`; backup hook + `consumeRestoredSyncNotice()`)
- `background/restore-engine.js` — restore flow: diff → create → ensure-URL → group → setColor → รอ commit จริง (`changeInfo.title`/`status:"complete"` เท่านั้น — `changeInfo.url`/`{status:"loading"}` ยังไม่นับ) → discard, staggered + mutex
- `background/debug-log.js` — debug log รายละเอียดทุกขั้น (ring buffer 1000): scope restore/mirror/store/sw; อ่านจาก SW devtools `__syncTabLogs.getLogs()` หรือ RPC GET_DEBUG_LOGS; console.debug เปิดผ่าน `enableConsole`
- `background/sync-backup.js` — เงาสำรองคลังไป `chrome.storage.sync` (compact + chunk ≤6800, throttle 5 นาที, กู้เฉพาะ local ว่างจริง)
- `background/url-sanitizer.js` — URL filtering/normalizing; v3.1 strips `#hash` + tracking params (`TRACKING_PARAM_PREFIXES`: `__cf_chl`, `utm_`, `fbclid`, `gclid`, …) as the record dedupe base; v3.5 also strips volatile SPA params (`VOLATILE_PARAM_NAMES`: `draftId`, `tab`) so `/settings?tab=x` = `/settings`
- `popup/` — popup UI (html/css/js; tokens in `design-system/synctab/pages/popup.md`)
- `shared/` — `constants.js` (schema/keys/timings), `messages.js` (MSG RPC + theme values), `types.js` (JSDoc), `ui-utils.js` (pure popup helpers)
- `test/` — `node --test` suites with the shared fake-chrome harness (`test/helpers/fake-chrome.js`)
- `icons/` + `scripts/make-icons.py` — extension icons (16/32/48/128) regenerated from a 512px master (python3 + Pillow, concept: grouped tab stack with live dot)
- `SOT.md` / `CONTEXT.md` / `PRODUCT.md` / `docs/` — spec, glossary, product note, ADR + history

## Conventions
- Spec source of truth: `SOT.md` (v3 sync laws L1–L15; read before touching sync behavior).
- v3.1 close/navigation semantics: mirror binds `tabId ↔ record` (`store.setLiveBinding`, persisted in `liveTabs`/`restoredTabIds`). Explicit per-tab close (`isWindowClosing=false`, unprotected origin) → `store.consumeDeletedTabs` deletes the record; window close / crash-wake / restored-or-scan-first origin (`r=1`) → record sleeps (old behavior). URL change on a bound tab → `store.moveLiveTabs` moves the record (old row deleted, `addedAt`/`order` carried). These run AFTER `applyLiveMap` per burst; never write schema fields directly.
- Popup talks to the service worker ONLY via `chrome.runtime.sendMessage` (`shared/messages.js` MSG constants) — no direct `chrome.tabs`/`chrome.storage` in popup.
- All state mutations go through `GroupStore`; mirror is read-only over registries. Persist is debounced (80 ms) — end writes with `await store.flush()` when determinism matters.
- Tab/group identity = exact group name (trim-able but case-sensitive window-agnostic); ungrouped tabs, unnamed groups, incognito, and privileged URLs (`edge://*`, etc.) are never tracked (L1).
- Restore simulates a staggered sequence: `tabs.create → tabs.group → tabGroups.update(color) → tabs.discard` per tab, always discard LAST (sleeping tabs), guarded by a per-name mutex; live group lookup happens in the focused window only.
- Tests run with `npm test` (`node --test`, ESM). Keep tests framework-free; reuse `test/helpers/fake-chrome.js` (seed convention: explicit ids ≥ 100; fake-generated ids start at 1).
- In service-worker context, ALWAYS call platform globals through member expressions — `globalThis.setTimeout(...)` / `globalThis.structuredClone(v)` — never keep a detached reference (`const s = setTimeout`). Detached WebIDL functions throw `TypeError: Illegal invocation` in some Chromium/Edge SW builds (popup pages are forgiving, SW is not).
- No bundler/build step; plain ES modules everywhere.
