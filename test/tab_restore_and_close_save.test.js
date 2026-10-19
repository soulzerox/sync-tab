import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine } from "../background/diff-engine.js";

class MockStorageAdapter {
  constructor() {
    this.data = null;
    this.saveCount = 0;
  }
  async save(schema) {
    this.data = JSON.parse(JSON.stringify(schema));
    this.saveCount++;
  }
  async loadAll() {
    return this.data;
  }
  async checkHealth() {
    return { connected: true, driver: "mock", path: "memory", dbSize: 0 };
  }
}

describe("Tab Restore & Browser Close Save Test Suite", () => {
  test("1. Tab Drain Protection: Window close preserves tabs even if tabs were drained before onWindowRemoved", async () => {
    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);

    // Initial state: Window 1 has 3 tabs
    await sm.syncActiveWindows([
      {
        id: 1,
        tabs: [
          { url: "https://tab1.com", title: "Tab 1" },
          { url: "https://tab2.com", title: "Tab 2" },
          { url: "https://tab3.com", title: "Tab 3" }
        ]
      }
    ], true);

    const uuid = sm.windowIdToUuid.get(1);
    assert.ok(uuid);
    assert.equal(sm.activeWindows[uuid].tabs.length, 3);

    // Simulate tab draining right before window remove (e.g. tabs.onRemoved without isWindowClosing)
    sm.activeWindows[uuid].tabs = [];

    // Now window is removed
    await sm.onWindowRemoved(1, []);

    // Closed archive must have preserved the 3 tabs via lastKnownTabs fallback!
    assert.ok(sm.closedWindows[uuid], "Window must be archived into closedWindows");
    assert.equal(sm.closedWindows[uuid].tabs.length, 3, "All 3 tabs must be retained from lastKnownTabs");
    assert.equal(sm.closedWindows[uuid].tabs[0].url, "https://tab1.com");

    // Also previousSessionBackup must have the 3 tabs
    assert.ok(sm.previousSessionBackup);
    assert.equal(sm.previousSessionBackup.totalTabs, 3);
  });

  test("2. UUID Protection: New empty window does not hijack existing active window with tabs", async () => {
    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);

    // Window from prior session loaded into activeWindows
    const oldUuid = "old-session-win-uuid";
    sm.activeWindows[oldUuid] = {
      windowUuid: oldUuid,
      customName: "My Previous Work",
      isClosed: false,
      lastUpdated: 1000,
      tabs: [{ url: "https://github.com", title: "GitHub" }]
    };

    // A brand new window (id: 999) arrives on browser startup
    const assignedUuid = sm.getOrCreateWindowUuid(999);

    // Must NOT reuse oldUuid because oldUuid has tabs!
    assert.notEqual(assignedUuid, oldUuid, "Must generate new UUID and not hijack previous window with tabs");
    assert.equal(sm.activeWindows[oldUuid].tabs.length, 1, "Old window tabs remain intact");
  });

  test("3. Auto-Restore on Startup: Automatically restores previous session tabs into the live window", async () => {
    let createdTabs = [];
    let closedTabs = [];
    let discardedTabs = [];

    globalThis.chrome = {
      // @ts-ignore
      tabs: {
        query: async () => [
          { id: 10, url: "edge://newtab", title: "New Tab" }
        ],
        create: async (props) => {
          const tab = { id: 100 + createdTabs.length, ...props };
          createdTabs.push(tab);
          return tab;
        },
        discard: async (tabId) => {
          discardedTabs.push(tabId);
          return createdTabs.find((tab) => tab.id === tabId);
        },
        remove: async (tabId) => {
          closedTabs.push(tabId);
        }
      },
      windows: {
        getAll: async () => [
          { id: 1, tabs: [{ id: 10, url: "edge://newtab" }] }
        ]
      }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    // Simulate prior session in activeWindows
    sm.activeWindows["session-win-1"] = {
      windowUuid: "session-win-1",
      customName: "Work Window",
      isClosed: false,
      lastUpdated: 1000,
      tabs: [
        { url: "https://github.com", title: "GitHub" },
        { url: "https://stackoverflow.com", title: "StackOverflow" }
      ]
    };

    // Live window opened by browser with blank newtab
    const liveWindows = [{ id: 1, tabs: [{ id: 10, url: "edge://newtab" }] }];

    await sm.reconcileStartup(liveWindows, new Map(), engine);

    // Previous tabs should have been created in the browser
    assert.equal(createdTabs.length, 2, "Must create 2 restored tabs");
    assert.equal(createdTabs[0].url, "https://github.com", "First restored tab URL");
    assert.equal(createdTabs[1].url, "https://stackoverflow.com", "Second restored tab URL");
    assert.deepEqual(discardedTabs, [100, 101], "Tabs must be discarded after creation");

    // The initial blank tab must be closed automatically
    assert.ok(closedTabs.includes(10), "Initial blank tab must be closed");

    // A successfully resumed logical window must not also appear as a closed archive.
    assert.equal(sm.closedWindows["session-win-1"], undefined);
    assert.ok(sm.activeWindows["session-win-1"]);
  });

  test("4. Edge Continue Where Left Off: Does not duplicate tabs that are already open on startup", async () => {
    let createdTabs = [];

    globalThis.chrome = {
      // @ts-ignore
      tabs: {
        query: async () => [
          { id: 101, url: "https://github.com", title: "GitHub" },
          { id: 102, url: "https://stackoverflow.com", title: "StackOverflow" }
        ],
        create: async (props) => {
          const tab = { id: 200 + createdTabs.length, ...props };
          createdTabs.push(tab);
          return tab;
        }
      },
      windows: {
        getAll: async () => [
          {
            id: 1,
            tabs: [
              { id: 101, url: "https://github.com", title: "GitHub" },
              { id: 102, url: "https://stackoverflow.com", title: "StackOverflow" }
            ]
          }
        ]
      }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    sm.activeWindows["session-win-1"] = {
      windowUuid: "session-win-1",
      isClosed: false,
      lastUpdated: 1000,
      tabs: [
        { url: "https://github.com", title: "GitHub" },
        { url: "https://stackoverflow.com", title: "StackOverflow" }
      ]
    };

    const liveWindows = [
      {
        id: 1,
        tabs: [
          { id: 101, url: "https://github.com", title: "GitHub" },
          { id: 102, url: "https://stackoverflow.com", title: "StackOverflow" }
        ]
      }
    ];

    await sm.reconcileStartup(liveWindows, new Map(), engine);

    // Since Edge already had the tabs open, 0 new tabs must be created
    assert.equal(createdTabs.length, 0, "No duplicate tabs should be created");
  });

  test("Closed archive history is not included in the previous-session restore backup", async () => {
    const sm = new StateManager(new MockStorageAdapter());
    sm.closedWindows["older-closed-window"] = {
      windowUuid: "older-closed-window",
      isClosed: true,
      closedAt: 10,
      tabs: [{ url: "https://old.example", title: "Old", index: 0 }]
    };

    await sm.syncActiveWindows([{
      id: 1,
      tabs: [{ url: "https://current.example", title: "Current" }]
    }], true);
    const currentUuid = sm.windowIdToUuid.get(1);
    await sm.onWindowRemoved(1, []);

    assert.deepEqual(
      sm.previousSessionBackup.windows.map((win) => win.windowUuid),
      [currentUuid]
    );
  });

  test("Closing a window after its last eligible tab was intentionally closed does not resurrect stale tabs", async () => {
    const sm = new StateManager(new MockStorageAdapter());

    await sm.syncActiveWindows([{
      id: 1,
      tabs: [{ url: "https://closed.example", title: "Closed" }]
    }], true);
    const uuid = sm.windowIdToUuid.get(1);

    // The browser keeps an internal new-tab page after the user closes the last regular tab.
    await sm.syncActiveWindows([{
      id: 1,
      tabs: [{ id: 2, url: "edge://newtab", title: "New tab" }]
    }], true);
    await sm.onWindowRemoved(1, []);

    assert.equal(sm.closedWindows[uuid], undefined);
    assert.equal(sm.previousSessionBackup.totalTabs, 0);
  });

  test("A persisted session mapping keeps the extension UUID through service-worker rehydration", async () => {
    const storage = new MockStorageAdapter();
    const firstWorker = new StateManager(storage);
    await firstWorker.syncActiveWindows([{
      id: 42,
      tabs: [{ url: "https://stable.example", title: "Stable" }]
    }], true);
    const stableUuid = firstWorker.windowIdToUuid.get(42);
    await firstWorker.renameWindow(stableUuid, "Main workspace");
    const sessionMappings = firstWorker.getWindowIdMappings();

    const restartedWorker = new StateManager(storage);
    await restartedWorker.ensureInitialized();
    restartedWorker.restoreWindowIdMappings([{ id: 42 }], sessionMappings);
    await restartedWorker.syncActiveWindows([{
      id: 42,
      tabs: [{ url: "https://stable.example", title: "Stable" }]
    }], true);

    assert.equal(restartedWorker.windowIdToUuid.get(42), stableUuid);
    assert.equal(restartedWorker.activeWindows[stableUuid].customName, "Main workspace");
  });

  test("Startup does not treat an old closed archive as the previous browser session", async () => {
    let createdTabs = [];
    globalThis.chrome = {
      tabs: {
        query: async () => [{ id: 1, url: "edge://newtab" }],
        create: async (props) => {
          const tab = { id: createdTabs.length + 10, ...props };
          createdTabs.push(tab);
          return tab;
        }
      },
      windows: { getAll: async () => [{ id: 1, tabs: [{ id: 1, url: "edge://newtab" }] }] }
    };

    const sm = new StateManager(new MockStorageAdapter());
    sm.closedWindows["older-closed-window"] = {
      windowUuid: "older-closed-window",
      isClosed: true,
      closedAt: 10,
      tabs: [{ url: "https://old.example", title: "Old", index: 0 }]
    };

    await sm.reconcileStartup([{ id: 1, tabs: [{ id: 1, url: "edge://newtab" }] }], new Map(), new DiffEngine(sm));

    assert.deepEqual(createdTabs, []);
  });

  test("Startup ignores legacy closed-archive entries copied into an old session backup", async () => {
    let createdTabs = [];
    globalThis.chrome = {
      tabs: {
        query: async () => [{ id: 1, url: "edge://newtab" }],
        create: async (props) => {
          const tab = { id: createdTabs.length + 10, ...props };
          createdTabs.push(tab);
          return tab;
        }
      },
      windows: { getAll: async () => [{ id: 1, tabs: [{ id: 1, url: "edge://newtab" }] }] }
    };

    const sm = new StateManager(new MockStorageAdapter());
    sm.previousSessionBackup = {
      timestamp: Date.now(),
      triggerReason: "manual_checkpoint",
      totalWindows: 1,
      totalTabs: 1,
      windows: [{
        windowUuid: "legacy-closed",
        isClosed: true,
        tabs: [{ url: "https://old.example", title: "Old", index: 0 }]
      }]
    };

    await sm.reconcileStartup([{ id: 1, tabs: [{ id: 1, url: "edge://newtab" }] }], new Map(), new DiffEngine(sm));

    assert.deepEqual(createdTabs, []);
  });

  test("Startup matches saved extension UUIDs to Edge-restored windows by their tabs", async () => {
    const createdTabs = [];
    const liveWindows = [
      { id: 20, tabs: [{ id: 2, url: "https://beta.example" }] },
      { id: 10, tabs: [{ id: 1, url: "https://alpha.example" }] }
    ];
    globalThis.chrome = {
      tabs: {
        query: async ({ windowId } = {}) => windowId === undefined
          ? liveWindows.flatMap(win => (win.tabs || []).map(tab => ({ ...tab, windowId: win.id })))
          : liveWindows.find(win => win.id === windowId)?.tabs || [],
        create: async (props) => {
          const tab = { id: 100 + createdTabs.length, ...props };
          createdTabs.push(tab);
          return tab;
        },
        discard: async () => {},
        remove: async () => {}
      },
      windows: { getAll: async () => liveWindows }
    };

    const sm = new StateManager(new MockStorageAdapter());
    sm.activeWindows = {
      "extension-window-alpha": {
        windowUuid: "extension-window-alpha",
        customName: "Alpha",
        isClosed: false,
        tabs: [{ url: "https://alpha.example", title: "Alpha", index: 0 }]
      },
      "extension-window-beta": {
        windowUuid: "extension-window-beta",
        customName: "Beta",
        isClosed: false,
        tabs: [{ url: "https://beta.example", title: "Beta", index: 0 }]
      }
    };

    await sm.reconcileStartup(liveWindows, new Map(), new DiffEngine(sm));

    assert.equal(sm.windowIdToUuid.get(10), "extension-window-alpha");
    assert.equal(sm.windowIdToUuid.get(20), "extension-window-beta");
    assert.equal(sm.activeWindows["extension-window-alpha"].customName, "Alpha");
    assert.equal(sm.activeWindows["extension-window-beta"].customName, "Beta");
    assert.deepEqual(createdTabs, []);
    assert.equal(sm.closedWindows["extension-window-alpha"], undefined);
    assert.equal(sm.closedWindows["extension-window-beta"], undefined);
  });

  test("Startup preserves extension UUIDs for matched Edge windows even when auto-restore is disabled", async () => {
    const liveWindows = [{ id: 31, tabs: [{ id: 1, url: "https://stable.example" }] }];
    globalThis.chrome = {
      tabs: { query: async () => liveWindows[0].tabs },
      windows: { getAll: async () => liveWindows }
    };
    const sm = new StateManager(new MockStorageAdapter());
    sm.settings.autoRestoreOnStartup = false;
    sm.activeWindows["persistent-main"] = {
      windowUuid: "persistent-main",
      customName: "Main workspace",
      isClosed: false,
      tabs: [{ url: "https://stable.example", title: "Stable", index: 0 }]
    };

    await sm.reconcileStartup(liveWindows, new Map(), new DiffEngine(sm));

    assert.equal(sm.windowIdToUuid.get(31), "persistent-main");
    assert.equal(sm.activeWindows["persistent-main"].customName, "Main workspace");
    assert.equal(sm.closedWindows["persistent-main"], undefined);
  });
});
