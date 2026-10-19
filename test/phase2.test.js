import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isBlacklistedUrl, isIgnoredUrl, normalizeBlacklistDomain, normalizeUrl, sanitizeTitle } from "../background/url-sanitizer.js";
import { sanitizeGroupColor, extractGroupData } from "../background/group-manager.js";
import { StateManager } from "../background/state-manager.js";
import { clusterTabsByGroup } from "../shared/tab-group-clustering.js";

// Mock Storage Adapter for Unit Testing
class MockStorageAdapter {
  constructor() {
    this.data = null;
    this.savedCount = 0;
  }
  async save(schema) {
    this.data = JSON.parse(JSON.stringify(schema));
    this.savedCount++;
  }
  async loadAll() {
    return this.data;
  }
  async checkHealth() {
    return { connected: true, driver: "mock", path: "memory", dbSize: 0 };
  }
}

describe("Phase 2: URL Sanitizer & Group Manager", () => {
  test("clusterTabsByGroup merges groups with the same normalized title despite color differences", () => {
    const { groups, ungrouped } = clusterTabsByGroup([
      { url: "https://one.example", group: { title: " Work ", color: "blue" } },
      { url: "https://two.example", group: { title: "work", color: "red" } }
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs.length, 2);
    assert.deepEqual(ungrouped, []);
  });

  test("blacklist domains match exact hosts and subdomains but not lookalikes", () => {
    assert.equal(normalizeBlacklistDomain(" *.Example.COM "), "example.com");
    assert.equal(isBlacklistedUrl("https://example.com/private", ["example.com"]), true);
    assert.equal(isBlacklistedUrl("https://docs.example.com/page", ["example.com"]), true);
    assert.equal(isBlacklistedUrl("https://notexample.com/page", ["example.com"]), false);
    assert.equal(isBlacklistedUrl("https://example.org/page", ["example.com"]), false);
  });

  test("isIgnoredUrl filters privileged and invalid protocols", () => {
    assert.equal(isIgnoredUrl("edge://settings"), true);
    assert.equal(isIgnoredUrl("chrome://flags"), true);
    assert.equal(isIgnoredUrl("chrome-extension://12345/popup.html"), true);
    assert.equal(isIgnoredUrl("devtools://devtools/bundled/inspector.html"), true);
    assert.equal(isIgnoredUrl("about:blank"), true);
    assert.equal(isIgnoredUrl("javascript:alert(1)"), true);
    assert.equal(isIgnoredUrl("data:text/html,unsafe"), true);
    assert.equal(isIgnoredUrl("blob:https://example.com/id"), true);
    assert.equal(isIgnoredUrl(""), true);
    assert.equal(isIgnoredUrl(null), true);
    assert.equal(isIgnoredUrl("https://github.com"), false);
    assert.equal(isIgnoredUrl("http://localhost:3000"), false);
  });

  test("normalizeUrl strips marketing tracking parameters while preserving real query params", () => {
    const raw = "https://example.com/product?id=123&utm_source=twitter&utm_medium=social&fbclid=abcdef";
    const normalized = normalizeUrl(raw, true);
    assert.equal(normalized, "https://example.com/product?id=123");

    const noTracking = "https://example.com/path/";
    assert.equal(normalizeUrl(noTracking, true), "https://example.com/path");
  });

  test("sanitizeTitle truncates extra long titles defensively", () => {
    const shortTitle = "GitHub - Edge Tab Sync";
    assert.equal(sanitizeTitle(shortTitle), "GitHub - Edge Tab Sync");

    const longTitle = "A".repeat(600);
    const sanitized = sanitizeTitle(longTitle, 500);
    assert.equal(sanitized.length, 501); // 500 chars + ellipsis
    assert.ok(sanitized.endsWith("…"));

    assert.equal(sanitizeTitle(""), "Untitled");
    assert.equal(sanitizeTitle(null), "Untitled");
    assert.equal(sanitizeTitle("", undefined, "https://www.example.com/article/hello-world"), "example.com — hello world");
    assert.equal(sanitizeTitle("Untitled", undefined, "https://docs.example.com/"), "docs.example.com");
    assert.equal(sanitizeTitle("Real page title", undefined, "https://example.com/"), "Real page title");
  });

  test("sanitizeGroupColor enforces 9 Chromium colors with grey fallback", () => {
    assert.equal(sanitizeGroupColor("blue"), "blue");
    assert.equal(sanitizeGroupColor("RED"), "red");
    assert.equal(sanitizeGroupColor("invalidColor"), "grey");
    assert.equal(sanitizeGroupColor(null), "grey");
  });

  test("extractGroupData converts raw group correctly", () => {
    const rawGroup = { title: " Research ", color: "cyan", collapsed: true };
    const extracted = extractGroupData(rawGroup);
    assert.deepEqual(extracted, {
      title: "Research",
      color: "cyan",
      collapsed: true
    });
    assert.equal(extractGroupData(null), undefined);
  });
});

describe("Phase 2: State Manager Topology & Lifecycles", () => {
  /** @type {MockStorageAdapter} */
  let mockStorage;
  /** @type {StateManager} */
  let stateManager;

  beforeEach(() => {
    mockStorage = new MockStorageAdapter();
    stateManager = new StateManager(mockStorage);
  });

  test("Repairs legacy Untitled tab records from their URLs without overwriting real titles", async () => {
    mockStorage.data = {
      version: "2.3.0",
      activeWindows: {
        active: {
          windowUuid: "active",
          tabs: [
            { url: "https://www.example.com/article/hello-world", title: "Untitled" },
            { url: "https://docs.example.com/", title: "A real saved title" }
          ]
        }
      },
      closedWindows: {
        closed: {
          windowUuid: "closed",
          isClosed: true,
          tabs: [{ url: "https://news.example.org/story/123", title: "" }]
        }
      },
      settings: {}
    };

    await stateManager.ensureInitialized();

    assert.equal(stateManager.activeWindows.active.tabs[0].title, "example.com — hello world");
    assert.equal(stateManager.activeWindows.active.tabs[1].title, "A real saved title");
    assert.equal(stateManager.closedWindows.closed.tabs[0].title, "news.example.org — 123");
    assert.equal(mockStorage.savedCount, 1);
    assert.equal(mockStorage.data.activeWindows.active.tabs[0].title, "example.com — hello world");
  });

  test("Retries initialization after a transient storage read failure", async () => {
    let calls = 0;
    const flakyStorage = {
      async loadAll() {
        calls++;
        if (calls === 1) throw new Error("temporary storage failure");
        return { version: "2.3.0", activeWindows: {}, closedWindows: {}, settings: {} };
      },
      async save() {},
      async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
    };
    const manager = new StateManager(flakyStorage);

    await assert.rejects(manager.ensureInitialized(), /temporary storage failure/);
    await manager.ensureInitialized();

    assert.equal(calls, 2);
    assert.equal(manager.isInitialized, true);
  });

  test("Rolls back an import in memory when persistence fails", async () => {
    const storage = {
      async loadAll() {
        return {
          version: "2.3.0",
          activeWindows: {},
          closedWindows: {},
          settings: { storageDriver: "auto", autoRestoreOnStartup: true }
        };
      },
      async save() { throw new Error("disk unavailable"); },
      async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
    };
    const manager = new StateManager(storage);
    await manager.ensureInitialized();
    const originalSettings = manager.settings;
    const ok = await manager.importData(JSON.stringify({
      settings: { autoRestoreOnStartup: false },
      activeWindows: {
        imported: { windowUuid: "imported", tabs: [{ url: "https://imported.example", title: "Imported" }] }
      }
    }));

    assert.equal(ok, false);
    assert.equal(manager.settings, originalSettings);
    assert.equal(manager.settings.autoRestoreOnStartup, true);
    assert.deepEqual(manager.closedWindows, {});
  });

  test("Drops the legacy autoSync setting while loading older saved state", async () => {
    mockStorage.data = {
      version: "2.2.0",
      activeWindows: {},
      closedWindows: {},
      settings: { autoSync: true }
    };

    await stateManager.ensureInitialized();

    assert.equal(Object.hasOwn(stateManager.settings, "autoSync"), false);
  });

  test("Maintains persistent UUID across ephemeral window IDs", () => {
    const uuid1 = stateManager.getOrCreateWindowUuid(101);
    const uuid1Again = stateManager.getOrCreateWindowUuid(101);
    const uuid2 = stateManager.getOrCreateWindowUuid(102);

    assert.equal(uuid1, uuid1Again);
    assert.notEqual(uuid1, uuid2);
  });

  test("Syncs active window tabs and ignores internal URLs", async () => {
    const liveWindows = [
      {
        id: 101,
        left: 100,
        top: 100,
        width: 1200,
        height: 800,
        tabs: [
          { url: "https://github.com", title: "GitHub", pinned: true },
          { url: "edge://settings", title: "Settings" }, // Should be ignored
          { url: "https://news.ycombinator.com", title: "Hacker News" },
          { url: "https://example.com/quick-start", title: "" }
        ]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    const active = Object.values(stateManager.activeWindows);

    assert.equal(active.length, 1);
    assert.equal(active[0].tabs.length, 3);
    assert.equal(active[0].tabs[0].url, "https://github.com");
    assert.equal(active[0].tabs[0].pinned, true);
    assert.equal(active[0].tabs[1].url, "https://news.ycombinator.com");
    assert.equal(active[0].tabs[2].title, "example.com — quick start");
  });

  test("Imports full backups into recoverable archives without overwriting live windows", async () => {
    stateManager.activeWindows.live = {
      windowUuid: "live",
      isClosed: false,
      lastUpdated: 100,
      tabs: [{ url: "https://current.example", title: "Current", index: 0 }]
    };
    const imported = {
      version: "2.3.0",
      activeWindows: {
        live: {
          windowUuid: "live",
          isClosed: false,
          lastUpdated: 50,
          tabs: [
            { url: "https://backup.example", title: "Backup", index: 0 },
            { url: "javascript:alert(1)", title: "Unsafe", index: 1 }
          ]
        }
      },
      closedWindows: {},
      settings: {
        storageDriver: "invalid-driver",
        maxClosedWindowsRetention: 99,
        blacklistDomains: [" EXAMPLE.COM ", 12]
      }
    };

    assert.equal(await stateManager.importData(JSON.stringify(imported)), true);
    assert.equal(stateManager.activeWindows.live.tabs[0].url, "https://current.example");
    const importedArchive = Object.values(stateManager.closedWindows).find(win =>
      win.tabs.some(tab => tab.url === "https://backup.example")
    );
    assert.ok(importedArchive, "exported active-window tabs should be available for manual recovery");
    assert.equal(importedArchive.isClosed, true);
    assert.deepEqual(importedArchive.tabs.map(tab => tab.url), ["https://backup.example"]);
    assert.notEqual(importedArchive.windowUuid, "live", "import must not collide with a currently active UUID");
    assert.equal(stateManager.settings.storageDriver, "auto");
    assert.equal(stateManager.settings.maxClosedWindowsRetention, 5);
    assert.deepEqual(stateManager.settings.blacklistDomains, ["example.com"]);
  });

  test("Rejects malformed or unrecognized import data", async () => {
    assert.equal(await stateManager.importData("[]"), false);
    assert.equal(await stateManager.importData("{}"), false);
    assert.equal(await stateManager.importData("{not json"), false);
  });

  test("Excludes blacklisted domains from active snapshots", async () => {
    stateManager.settings.blacklistDomains = ["example.com"];
    await stateManager.syncActiveWindows([{
      id: 103,
      tabs: [
        { url: "https://example.com/private", title: "Private", pinned: false },
        { url: "https://docs.example.com", title: "Subdomain", pinned: false },
        { url: "https://notexample.com", title: "Lookalike", pinned: false },
        { url: "https://safe.example.org", title: "Safe", pinned: false }
      ]
    }], true);
    const uuid = stateManager.windowIdToUuid.get(103);
    assert.deepEqual(stateManager.activeWindows[uuid].tabs.map(tab => tab.url), [
      "https://notexample.com",
      "https://safe.example.org"
    ]);
  });

  test("Does not erase active tabs when a browser query returns an empty sample", async () => {
    await stateManager.syncActiveWindows([{
      id: 101,
      tabs: [{ url: "https://github.com", title: "GitHub", pinned: false }]
    }], true);
    const uuid = stateManager.windowIdToUuid.get(101);
    const savedCount = mockStorage.savedCount;

    await stateManager.syncActiveWindows([], true);

    assert.equal(stateManager.activeWindows[uuid].tabs[0].url, "https://github.com");
    assert.equal(mockStorage.savedCount, savedCount);
  });

  test("Skips storage writes when a browser snapshot has not changed", async () => {
    const liveWindows = [{
      id: 101,
      left: 10,
      top: 20,
      width: 1200,
      height: 800,
      state: "normal",
      tabs: [{ url: "https://github.com", title: "GitHub", pinned: false }]
    }];

    await stateManager.syncActiveWindows(liveWindows, true);
    const firstSaveCount = mockStorage.savedCount;
    await stateManager.syncActiveWindows(liveWindows, true);

    assert.equal(firstSaveCount, 1);
    assert.equal(mockStorage.savedCount, firstSaveCount, "unchanged tab snapshots should not trigger storage/native writes");
  });

  test("Dedupes equivalent tab URLs while capturing an active window", async () => {
    await stateManager.syncActiveWindows([{
      id: 101,
      tabs: [
        { url: "https://example.com/", title: "First" },
        { url: "https://example.com", title: "Duplicate" },
        { url: "https://other.example", title: "Other" }
      ]
    }], true);

    const active = Object.values(stateManager.activeWindows)[0];
    assert.deepEqual(active.tabs.map((tab) => tab.url), [
      "https://example.com", "https://other.example"
    ]);
    assert.equal(active.tabs[0].title, "First", "Keep the first tab when URLs normalize to the same value");
  });

  test("Manual backup is an immutable snapshot, not aliases to live state", async () => {
    await stateManager.syncActiveWindows([{
      id: 104,
      customName: "Before",
      tabs: [{ url: "https://backup.example", title: "Before", pinned: false }]
    }], true);
    const uuid = stateManager.windowIdToUuid.get(104);
    await stateManager.renameWindow(uuid, "Before");
    const backup = await stateManager.triggerManualBackup();

    stateManager.activeWindows[uuid].customName = "After";
    stateManager.activeWindows[uuid].tabs[0].title = "After";

    assert.equal(backup.windows[0].customName, "Before");
    assert.equal(backup.windows[0].tabs[0].title, "Before");
  });

  test("onWindowRemoved performs 0ms instant flush and moves window to closed archive", async () => {
    const liveWindows = [
      {
        id: 101,
        tabs: [{ url: "https://github.com", title: "GitHub" }]
      },
      {
        id: 102,
        tabs: [{ url: "https://google.com", title: "Google" }]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    const uuid101 = stateManager.windowIdToUuid.get(101);

    // Remove window 101 while window 102 remains open
    await stateManager.onWindowRemoved(101, [{ id: 102 }]);

    assert.equal(stateManager.activeWindows[uuid101], undefined);
    assert.ok(stateManager.closedWindows[uuid101]);
    assert.equal(stateManager.closedWindows[uuid101].isClosed, true);
    assert.equal(stateManager.closedWindows[uuid101].tabs[0].url, "https://github.com");
  });

  test("Last window close captures rolling session backup", async () => {
    const liveWindows = [
      {
        id: 101,
        tabs: [{ url: "https://github.com", title: "GitHub" }]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    // Remove last remaining window
    await stateManager.onWindowRemoved(101, []);

    assert.ok(stateManager.previousSessionBackup);
    assert.equal(stateManager.previousSessionBackup.triggerReason, "last_window_close");
    assert.equal(stateManager.previousSessionBackup.totalTabs, 1);
  });

  test("Can selectively delete a tab from closed window archive", async () => {
    const liveWindows = [
      {
        id: 101,
        tabs: [
          { url: "https://github.com", title: "GitHub" },
          { url: "https://google.com", title: "Google" }
        ]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    const uuid101 = stateManager.windowIdToUuid.get(101);
    await stateManager.onWindowRemoved(101, [{ id: 102 }]);

    // Delete tab at index 0 (GitHub)
    const success = await stateManager.deleteClosedTab(uuid101, 0);
    assert.equal(success, true);
    assert.equal(stateManager.closedWindows[uuid101].tabs.length, 1);
    assert.equal(stateManager.closedWindows[uuid101].tabs[0].url, "https://google.com");
  });

  test("Can delete an entire closed window archive", async () => {
    const liveWindows = [
      {
        id: 101,
        tabs: [{ url: "https://github.com", title: "GitHub" }]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    const uuid101 = stateManager.windowIdToUuid.get(101);
    await stateManager.onWindowRemoved(101, [{ id: 102 }]);

    const success = await stateManager.deleteClosedWindow(uuid101);
    assert.equal(success, true);
    assert.equal(stateManager.closedWindows[uuid101], undefined);
  });

  test("Archive retention keeps only the newest entries, including pinned templates", async () => {
    stateManager.settings.maxClosedWindowsRetention = 2;

    // Create a mix of pinned and regular archives; pinning does not bypass the total cap.
    const u1 = "uuid-1", u2 = "uuid-2", u3 = "uuid-3";
    stateManager.closedWindows[u1] = {
      windowUuid: u1,
      isClosed: true,
      closedAt: 1000,
      isPinnedTemplate: true, // Pinned template!
      lastUpdated: 1000,
      tabs: [{ url: "https://w1.com", title: "W1", pinned: false, index: 0 }]
    };
    stateManager.closedWindows[u2] = {
      windowUuid: u2,
      isClosed: true,
      closedAt: 2000,
      isPinnedTemplate: false,
      lastUpdated: 2000,
      tabs: [{ url: "https://w2.com", title: "W2", pinned: false, index: 0 }]
    };
    stateManager.closedWindows[u3] = {
      windowUuid: u3,
      isClosed: true,
      closedAt: 3000,
      isPinnedTemplate: false,
      lastUpdated: 3000,
      tabs: [{ url: "https://w3.com", title: "W3", pinned: false, index: 0 }]
    };

    // Add 4th unpinned window
    const u4 = "uuid-4";
    stateManager.closedWindows[u4] = {
      windowUuid: u4,
      isClosed: true,
      closedAt: 4000,
      isPinnedTemplate: false,
      lastUpdated: 4000,
      tabs: [{ url: "https://w4.com", title: "W4", pinned: false, index: 0 }]
    };

    stateManager.pruneClosedWindows();

    // Both older entries are pruned, regardless of their pin status.
    assert.equal(stateManager.closedWindows[u1], undefined);
    assert.equal(stateManager.closedWindows[u2], undefined);
    assert.ok(stateManager.closedWindows[u3]);
    assert.ok(stateManager.closedWindows[u4]);
  });

  test("Changing archive retention immediately prunes to the new limit", async () => {
    for (let i = 1; i <= 4; i++) {
      stateManager.closedWindows[`window-${i}`] = {
        windowUuid: `window-${i}`,
        closedAt: i * 1000,
        lastUpdated: i * 1000,
        tabs: [{ url: `https://site-${i}.example`, title: `Site ${i}`, pinned: false, index: 0 }]
      };
    }

    await stateManager.updateSettings({ maxClosedWindowsRetention: 2 });

    assert.deepEqual(Object.keys(stateManager.closedWindows).sort(), ["window-3", "window-4"]);
  });

  test("Legacy retention values cannot exceed the hard five-window cap", () => {
    stateManager.settings.maxClosedWindowsRetention = 30;
    for (let i = 1; i <= 7; i++) {
      stateManager.closedWindows[`window-${i}`] = {
        windowUuid: `window-${i}`,
        closedAt: i * 1000,
        lastUpdated: i * 1000,
        tabs: [{ url: `https://site-${i}.example`, title: `Site ${i}`, pinned: false, index: 0 }]
      };
    }

    stateManager.pruneClosedWindows();

    assert.deepEqual(Object.keys(stateManager.closedWindows).sort(), [
      "window-3", "window-4", "window-5", "window-6", "window-7"
    ]);
  });

  test("Pruning dedupes URLs inside each archived window and reindexes tabs", () => {
    stateManager.closedWindows["archive-1"] = {
      windowUuid: "archive-1",
      closedAt: 1000,
      lastUpdated: 1000,
      tabs: [
        { url: "https://example.com/", title: "Keep", index: 0 },
        { url: "https://example.com", title: "Duplicate", index: 1 },
        { url: "https://other.example", title: "Other", index: 2 }
      ]
    };

    stateManager.pruneClosedWindows();

    assert.deepEqual(
      stateManager.closedWindows["archive-1"].tabs.map(({ url, title, index }) => ({ url, title, index })),
      [
        { url: "https://example.com/", title: "Keep", index: 0 },
        { url: "https://other.example", title: "Other", index: 1 }
      ]
    );
  });

  test("Pruning merges duplicate archive snapshots while preserving differently named windows", () => {
    const tabs = [{ url: "https://same.example", title: "Same", pinned: false, index: 0 }];
    stateManager.closedWindows = {
      "older-copy": {
        windowUuid: "older-copy",
        isClosed: true,
        closedAt: 100,
        tabs: structuredClone(tabs)
      },
      "newer-copy": {
        windowUuid: "newer-copy",
        isClosed: true,
        closedAt: 200,
        isPinnedTemplate: true,
        tabs: structuredClone(tabs)
      },
      "named-window": {
        windowUuid: "named-window",
        customName: "Different workspace",
        isClosed: true,
        closedAt: 150,
        tabs: structuredClone(tabs)
      }
    };

    stateManager.pruneClosedWindows();

    assert.deepEqual(Object.keys(stateManager.closedWindows).sort(), ["named-window", "newer-copy"]);
    assert.equal(stateManager.closedWindows["newer-copy"].isPinnedTemplate, true);
  });
});
