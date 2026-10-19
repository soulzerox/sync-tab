# Chrome Web Store & Edge Add-ons Listing Metadata

> **Last Updated:** 2026-09-07  
> **Version:** 2.2.0  
> **Target Stores:** Microsoft Edge Add-ons & Chrome Web Store  

---

## 1. Store Listing Details

### Extension Name
`SyncTab — Smart Multi-Window & Tab Manager for Edge`

### Summary (Short Description — Max 132 chars)
`Smart Multi-Window & Tab Sync with Edge Sleeping Tab Restore and Persistent Local SQLite Drive Backup on Ubuntu Linux.`

### Detailed Description
```
SyncTab is a high-performance, local-first browser extension designed for Microsoft Edge and Chromium browsers on Ubuntu Linux. It intelligently tracks, organizes, and syncs open tabs across multiple separate windows with zero CPU/RAM cost when idle.

Key Features:
- 🚀 Smart Missing Tab Restore: Automatically detects missing tabs on startup or window restore, opening them in Edge Sleeping Tabs state (discarded: true) to consume 0% RAM and CPU until clicked.
- 🪟 Multi-Window Topology & Isolation: Assigns persistent UUIDs to each window so your research, development, and personal sessions stay neatly separated.
- 💾 Persistent SQLite Drive Backup: Direct integration with native SQLite database on your Ubuntu Linux drive (~/.local/share/sync-tab/tabs.sqlite) with WAL mode, making your saved sessions 100% immune to browser cache wipes or profile resets.
- ⚡ 0ms Close Flush & Hot Sync: Instant zero-latency state capture on window or tab close with crash recovery safeguards.
- 📌 Window Templates & Selective Restore: Pin frequently used window workspaces as permanent templates, or select individual tabs to sync into your current active window.
- 🎨 Modern Glassmorphic UI: Adaptive dark/light theme seamlessly matching your Ubuntu GNOME desktop styling.
- 🔒 100% Local-First & Private: No external analytics, no cloud trackers, and zero telemetry. All data stays strictly on your local device.
```

---

## 2. Permissions Justifications (Plain-English Review Justifications)

| Permission | Review Justification (Why needed) |
|---|---|
| `tabs` | Required to read URLs and titles of open browser tabs so they can be synced across windows, and to recreate missing tabs in sleeping state (`discarded: true`). |
| `tabGroups` | Required to detect, preserve, and restore tab group titles and colors across window sessions. |
| `storage` | Required to save active window states, closed window archives, and user preferences locally in `chrome.storage.local`. |
| `unlimitedStorage` | Required to prevent local snapshot and backup eviction when disk space is constrained by the browser. |
| `nativeMessaging` | Required to communicate with the local Python host bridge on Ubuntu Linux to persist tab data into an OS-level SQLite database file. |
| `alarms` | Required to schedule background periodic maintenance and garbage collection without keeping the service worker alive continuously. |

---

## 3. Privacy & Data Use Disclosures

- **Single Purpose:** Tab and multi-window session management, backup, and restore.
- **Data Collection:** **Zero data is collected or transmitted externally.**
- **Network Access:** The extension makes **NO outbound network requests**. All operations are strictly local to the user's machine.
- **Data Storage:** Data is stored exclusively in `chrome.storage.local` and optionally in the user's local directory `~/.local/share/sync-tab/tabs.sqlite`.

---

## 4. Version History

- **v2.2.1 (2026-09-07):** Hardened browser lifecycle resilience. Added Startup Synchronization Gate (`ensureStartupReconciled`) eliminating startup event race conditions, `isWindowClosing` tab drain protection on browser exit, `lastKnownTabs` fallback cache against empty tab overwrites, and automatic tab restore on startup as Edge Sleeping Tabs (`autoRestoreOnStartup`).
- **v2.2.0 (2026-09-01):** Production-ready release with Deep Module Architecture, SQLite WAL native integration, Mutex Lock Guard, and GNOME Adaptive Glassmorphic UI.
