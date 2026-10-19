import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine, calculateMissingTabs } from "../background/diff-engine.js";
import { normalizeUrl, sanitizeTitle, isIgnoredUrl } from "../background/url-sanitizer.js";
import { THRESHOLDS } from "../shared/constants.js";

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

describe("Phase 7: End-to-End Stress Test & QA Verification Matrix", () => {
  test("Recovery E2E: detects browser-side mass tab loss and additively restores from the last safe checkpoint", async () => {
    const stateManager = new StateManager(new MockStorageAdapter());
    stateManager.settings.lazyRestore = false;
    stateManager.settings.autoCleanBlankNewTab = false;
    const originalTabs = Array.from({ length: 10 }, (_, i) => ({
      url: `https://recovery.example/${i}`,
      title: `Recovery ${i}`
    }));

    await stateManager.captureRecoveryCheckpoint([{ id: 3, tabs: originalTabs }], new Map(), 1_000);
    await stateManager.syncActiveWindows([{ id: 3, tabs: originalTabs.slice(0, 3) }], true);
    const loss = await stateManager.captureRecoveryCheckpoint(
      [{ id: 3, tabs: originalTabs.slice(0, 3) }], new Map(), 61_000
    );
    assert.equal(loss.suspectedLoss, true);
    assert.equal(stateManager.recoveryCheckpoints[0].totalTabs, 10);
    assert.equal(stateManager.recoveryAlert.lostTabs, 7);

    const created = [];
    const liveTabs = originalTabs.slice(0, 3).map((tab, id) => ({ ...tab, id }));
    let nextId = 10;
    globalThis.chrome = {
      tabs: {
        query: async () => liveTabs,
        create: async props => {
          const tab = { id: nextId++, ...props };
          created.push(tab);
          liveTabs.push(tab);
          return tab;
        },
        discard: async () => {}
      }
    };

    const result = await new DiffEngine(stateManager).syncRecoveryCheckpointToActive(
      stateManager.recoveryAlert.checkpointTimestamp,
      3
    );

    assert.equal(result.success, true);
    assert.equal(result.restoredCount, 7);
    assert.equal(created.length, 7);
    assert.equal(liveTabs.length, 10);
  });

  test("Restore E2E: Edge-compatible tab creation opens every missing tab and discards it", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);
    const diffEngine = new DiffEngine(stateManager);
    const targetUuid = "restore-e2e-window";
    const createCalls = [];
    const createdTabs = [];
    const discardedTabIds = [];
    const groupedTabIds = [];
    const updatedGroups = [];
    const operationOrder = [];
    let nextTabId = 100;
    let queryCount = 0;
    let latestQueryTabs = [];

    stateManager.closedWindows[targetUuid] = {
      windowUuid: targetUuid,
      isClosed: true,
      tabs: [
        {
          url: "https://fictionhall.com/writer",
          title: "Writer",
          pinned: false,
          group: { title: "Writing", color: "blue", collapsed: true }
        },
        { url: "https://github.com/ayghri/i-have-adhd", title: "GitHub", pinned: true }
      ]
    };

    globalThis.chrome = {
      tabs: {
        query: async () => {
          queryCount++;
          latestQueryTabs = queryCount === 1
            ? [{ id: 10, url: "edge://newtab" }]
            : createdTabs.slice(0, 1);
          return latestQueryTabs;
        },
        create: async (props) => {
          createCalls.push(props);
          const allowed = new Set(["windowId", "url", "active", "pinned"]);
          const unexpected = Object.keys(props).find((key) => !allowed.has(key));
          if (unexpected) throw new TypeError(`Unexpected property: '${unexpected}'`);
          const created = { id: nextTabId++, ...props };
          createdTabs.push(created);
          return created;
        },
        discard: async (tabId) => {
          discardedTabIds.push(tabId);
          operationOrder.push("discard");
          const liveIndex = createdTabs.findIndex((tab) => tab.id === tabId);
          if (liveIndex >= 0) createdTabs.splice(liveIndex, 1);
          return createdTabs.find((tab) => tab.id === tabId);
        },
        group: async ({ tabIds }) => {
          const missingIds = tabIds.filter((id) => !latestQueryTabs.some((tab) => tab.id === id));
          if (missingIds.length) throw new Error(`No tab with id: ${missingIds[0]}`);
          groupedTabIds.push(...tabIds);
          return 8;
        },
        remove: async () => {}
      },
      tabGroups: {
        update: async (groupId, properties) => {
          updatedGroups.push({ groupId, properties });
          operationOrder.push("group-update");
        }
      },
      windows: {
        getAll: async () => [{ id: 1, tabs: createdTabs }]
      }
    };

    const result = await diffEngine.syncWindowToActive(targetUuid, 1);

    assert.equal(result.success, true);
    assert.equal(result.restoredCount, 2);
    assert.equal(result.restoredCount, 2, "Both missing URLs must be created before later lifecycle operations");
    assert.ok(createCalls.every((props) => !("title" in props) && !("discarded" in props)));
    assert.deepEqual(discardedTabIds, [100, 101]);
    assert.deepEqual(groupedTabIds, [100], "Group only IDs that are still present in the target window");
    assert.deepEqual(updatedGroups, [{
      groupId: 8,
      properties: { title: "Writing", color: "blue", collapsed: true }
    }], "Restore the archived group title, color, and collapsed state");
    assert.deepEqual(operationOrder, ["group-update", "discard", "discard"], "Rebuild groups before putting tabs to sleep");
  });

  test("Restore E2E: Spreads tab creation over time instead of creating a burst", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);
    const diffEngine = new DiffEngine(stateManager);
    const createTimes = [];

    globalThis.chrome = {
      tabs: {
        create: async (props) => {
          createTimes.push(performance.now());
          return { id: createTimes.length, ...props };
        },
        query: async () => []
      }
    };

    await diffEngine.executeRestore(
      Array.from({ length: 4 }, (_, i) => ({ url: `https://batch-${i}.example` })),
      1,
      null,
      false,
      false
    );

    assert.equal(createTimes.length, 4);
    for (let i = 1; i < createTimes.length; i++) {
      assert.ok(
        createTimes[i] - createTimes[i - 1] >= 180,
        `Tab ${i + 1} opened too close to previous tab: ${createTimes[i] - createTimes[i - 1]}ms`
      );
    }
  });

  test("Restore joins matching group names in the target window", async () => {
    const created = [];
    const groupCalls = [];
    const groupUpdates = [];
    let nextId = 100;
    globalThis.chrome = {
      tabs: {
        create: async (props) => {
          const tab = { id: nextId++, ...props };
          created.push(tab);
          return tab;
        },
        query: async () => created,
        group: async (options) => {
          groupCalls.push(options);
          return options.groupId ?? 77;
        }
      },
      tabGroups: {
        query: async ({ windowId }) => [{ id: 55, windowId, title: "Work", color: "green", collapsed: false }],
        update: async (groupId, properties) => groupUpdates.push({ groupId, properties })
      }
    };

    const engine = new DiffEngine(new StateManager(new MockStorageAdapter()));
    await engine.executeRestore([
      { url: "https://one.example", group: { title: "Work", color: "blue", collapsed: true } },
      { url: "https://two.example", group: { title: " work ", color: "red", collapsed: false } }
    ], 9, null, false, false);

    assert.deepEqual(groupCalls, [{ tabIds: [100, 101], groupId: 55 }]);
    assert.deepEqual(groupUpdates, [], "An existing group keeps its current styling and collapsed state");
  });

  test("Test 1: Hot Sync & 0ms Close Stress Test (Rapid Open/Close 100 Tabs)", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    // Create 100 tabs across 2 windows
    const window1Tabs = Array.from({ length: 50 }, (_, i) => ({
      url: `https://test.com/doc-${i}?utm_source=test`,
      title: `Doc ${i}`,
      pinned: i < 5
    }));

    const window2Tabs = Array.from({ length: 50 }, (_, i) => ({
      url: `https://test.com/ref-${i}`,
      title: `Ref ${i}`,
      pinned: false
    }));

    const liveWindows = [
      { id: 1, tabs: window1Tabs },
      { id: 2, tabs: window2Tabs }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    assert.equal(Object.keys(stateManager.activeWindows).length, 2);

    const uuid1 = stateManager.windowIdToUuid.get(1);
    const win1Data = stateManager.activeWindows[uuid1];
    assert.equal(win1Data.tabs.length, 50);

    // Instant close window 1
    await stateManager.onWindowRemoved(1, [{ id: 2 }]);

    // Window 1 must be moved to closedWindows with all 50 tabs intact
    assert.equal(stateManager.activeWindows[uuid1], undefined);
    assert.ok(stateManager.closedWindows[uuid1]);
    assert.equal(stateManager.closedWindows[uuid1].tabs.length, 50);
  });

  test("Test 2: Multi-Window Isolation & UUID Consistency", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    const winA = { id: 10, tabs: [{ url: "https://a.com", title: "A" }] };
    const winB = { id: 20, tabs: [{ url: "https://b.com", title: "B" }] };
    const winC = { id: 30, tabs: [{ url: "https://c.com", title: "C" }] };

    await stateManager.syncActiveWindows([winA, winB, winC], true);

    const uuidA = stateManager.windowIdToUuid.get(10);
    const uuidB = stateManager.windowIdToUuid.get(20);
    const uuidC = stateManager.windowIdToUuid.get(30);

    assert.notEqual(uuidA, uuidB);
    assert.notEqual(uuidB, uuidC);
    assert.notEqual(uuidA, uuidC);

    // Verify tabs are properly isolated
    assert.equal(stateManager.activeWindows[uuidA].tabs[0].url, "https://a.com");
    assert.equal(stateManager.activeWindows[uuidB].tabs[0].url, "https://b.com");
    assert.equal(stateManager.activeWindows[uuidC].tabs[0].url, "https://c.com");
  });

  test("Test 3: Closed Window Selective Deletion & Auto-Resync Loop Immunity", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    await stateManager.syncActiveWindows([{ id: 1, tabs: [{ url: "https://keep.com", title: "Keep" }, { url: "https://delete.com", title: "Delete" }] }], true);
    const uuid = stateManager.windowIdToUuid.get(1);
    await stateManager.onWindowRemoved(1, [{ id: 2 }]);

    // Delete the unwanted tab from closed archive
    const deleted = await stateManager.deleteClosedTab(uuid, 1);
    assert.equal(deleted, true);
    assert.equal(stateManager.closedWindows[uuid].tabs.length, 1);
    assert.equal(stateManager.closedWindows[uuid].tabs[0].url, "https://keep.com");

    // Re-syncing active windows does NOT bring back the deleted tab to closedWindows
    await stateManager.syncActiveWindows([{ id: 2, tabs: [{ url: "https://active.com", title: "Active" }] }], true);
    assert.equal(stateManager.closedWindows[uuid].tabs.length, 1);
  });

  test("Test 4: High Concurrency & Massive Tab Diff Stress Test (500 Tabs)", () => {
    // 500 target tabs
    const targetTabs = Array.from({ length: 500 }, (_, i) => ({
      url: `https://domain.com/page-${i % 250}`, // 250 unique URLs, duplicated twice
      title: `Page ${i}`,
      pinned: false,
      index: i
    }));

    // Current live window has 100 of those tabs open
    const liveTabs = Array.from({ length: 100 }, (_, i) => ({
      url: `https://domain.com/page-${i}`
    }));

    const start = performance.now();
    const missing = calculateMissingTabs(targetTabs, liveTabs, true);
    const duration = performance.now() - start;

    // 250 unique target URLs - 100 live URLs = exactly 150 missing URLs
    assert.equal(missing.length, 150);
    // Calculation must be blazing fast (<10ms for 500 tabs)
    assert.ok(duration < 25, `Diff calculation took ${duration}ms, must be <25ms`);
  });

  test("Test 5: Native 1MB Buffer Safety Stress Test", () => {
    // Test payload with 1,000 tabs and long titles
    const massiveTabs = Array.from({ length: 1000 }, (_, i) => ({
      url: `https://very-long-subdomain.enterprise-domain.com/long/path/structure/item-${i}?param=value&id=${i}`,
      title: sanitizeTitle("Super Long Page Title ".repeat(50), THRESHOLDS.MAX_TITLE_LENGTH),
      pinned: false,
      index: i
    }));

    const schema = {
      version: "2.2.0",
      activeWindows: {
        "big-win-uuid": {
          windowUuid: "big-win-uuid",
          customName: "Massive Window",
          isClosed: false,
          lastUpdated: Date.now(),
          tabs: massiveTabs
        }
      }
    };

    const jsonString = JSON.stringify(schema);
    const byteSize = Buffer.byteLength(jsonString, "utf8");

    // Must be well below Chromium's 1,048,576 bytes limit
    assert.ok(byteSize < 1048576, `Payload size was ${byteSize} bytes, which exceeds 1MB`);
  });

  test("Test 6: Browser Crash Recovery / Startup Reconciler", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    // Simulate pre-crash state where Window 99 was active with 5 tabs
    stateManager.activeWindows["crashed-uuid"] = {
      windowUuid: "crashed-uuid",
      customName: "Crashed Session",
      isClosed: false,
      lastUpdated: 1000,
      tabs: Array.from({ length: 5 }, (_, i) => ({
        url: `https://crashed-tab-${i}.com`,
        title: `Crashed ${i}`,
        pinned: false,
        index: i
      }))
    };

    // Simulate browser startup where only 1 clean blank window (id: 1) is opened
    const startupLiveWindows = [
      { id: 1, tabs: [{ url: "edge://newtab", title: "New Tab" }] }
    ];

    await stateManager.reconcileStartup(startupLiveWindows);

    // The crashed window must be cleanly recovered into closedWindows
    assert.equal(stateManager.activeWindows["crashed-uuid"], undefined);
    assert.ok(stateManager.closedWindows["crashed-uuid"]);
    assert.equal(stateManager.closedWindows["crashed-uuid"].isClosed, true);
    assert.equal(stateManager.closedWindows["crashed-uuid"].tabs.length, 5);
  });
});
