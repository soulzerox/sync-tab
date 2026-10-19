# Chrome Web Store & Edge Add-ons Listing Metadata

> **Last Updated:** 2026-10-20  
> **Version:** 3.0.0  
> **Target Stores:** Microsoft Edge Add-ons & Chrome Web Store  

---

## 1. Store Listing Details

### Extension Name
`SyncTab — Group Sync`

### Summary (Short Description — Max 132 chars)
`สรุปกลุ่มแท็บของ Edge ให้พร้อมกลับไปทำงาน — เปิดซ้ำเป็น Sleeping Tabs โหลดเมื่อคลิกเท่านั้น (ทำงาน local 100%)`

### Detailed Description
```
SyncTab — Group Sync is a local-first Microsoft Edge (Chromium) extension that syncs ONLY the tabs you put into named tab groups.

How it works:
- Put browser tabs into a named tab group — SyncTab mirrors that group in real time: tabs you open or close are tracked automatically across all normal (non-incognito) windows.
- Close a group or a window? The tabs stay recorded as "sleeping" memories (💤) so nothing is ever lost just because you closed your workspace.
- Open the popup and restore the whole group — or only the tabs you tick — as Edge Sleeping Tabs (discarded: true): they are created, grouped with the original name & color, and stay 0% CPU / ~0% memory until you click them.
- Rename a group on the browser and SyncTab follows (two-way). Duplicate tabs in the target window are skipped automatically. Ungrouped tabs, unnamed groups, incognito windows, and internal pages (edge://…) are never tracked.

Key Features:
- 🎯 Group-only sync: zero noise from your ungrouped everyday browsing.
- ⚡ Real-time mirror of group life cycle — open, close, move, and rename are all reflected instantly.
- 💤 Restore as Sleeping Tabs, one by one, gently spaced — gentle on the browser.
- 🧹 No leftovers to babysit — no background polling, no alarms, no native apps. Data lives in chrome.storage.local.
- 🌗 Adaptive dark/light UI that follows system or your explicit choice.
- 🔒 100% local-first & private: no analytics, no cloud, no telemetry, no outbound network requests.
```

---

## 2. Permissions Justifications (Plain-English Review Justifications)

| Permission | Review Justification (Why needed) |
|---|---|
| `tabs` | Required to observe tab open/close/move events on grouped tabs, read their URL/title/favicon for the mirror, and re-create saved tabs in sleeping state (`discarded: true`) when the user clicks restore. |
| `tabGroups` | Required to track named tab groups (title/color/window membership) in real time, detect group creation/removal/rename, and assign restored tabs into the correct group. |
| `storage` | Required to persist the group records the extension maintains locally in `chrome.storage.local` (schema v3, single key `groupsSync`). |
| `unlimitedStorage` | Required so long-used group records are never evicted by the browser when storage pressure is high; the extension relies on storage being durable. |

(No other permissions are used — no native messaging, no alarms, no host permissions, no network access.)

---

## 3. Privacy & Data Use Disclosures

- **Single Purpose:** Mirroring named tab groups and letting the user restore those saved tabs as sleeping tabs.
- **Data Collection:** **Zero data is collected or transmitted externally.**
- **Network Access:** The extension makes **NO outbound network requests**. All operations are strictly local to the user's machine.
- **Data Storage:** Data is stored exclusively in `chrome.storage.local` (key `groupsSync`).
- **Incognito:** The extension does not access or store tabs from incognito windows.

---

## 4. Version History

- **v3.0.0 (2026-10-20):** Complete redesign to "Group Sync" — sync only named tab groups (exact name = identity, union across windows), real-time open/close mirror, manual restore of selected/all saved tabs as Edge Sleeping Tabs (create → group → setColor → discard, staggered, mutex-guarded), two-way group rename, one-time migration wipe of the old window-snapshot data, removed native messaging host and alarms entirely (permissions now: tabs, tabGroups, storage, unlimitedStorage).
- **v2.2.1 (2026-09-07):** (window-era) Startup Synchronization Gate, `isWindowClosing` drain protection, `lastKnownTabs` fallback cache.
- **v2.2.0 (2026-09-01):** (window-era) Multi-window snapshot sync with SQLite WAL native integration.
