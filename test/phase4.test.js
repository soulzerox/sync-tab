import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateMissingTabs, DiffEngine } from "../background/diff-engine.js";
import { StateManager } from "../background/state-manager.js";

// Mock Storage Adapter
class MockStorageAdapter {
  constructor() { this.data = null; }
  async save(s) { this.data = s; }
  async loadAll() { return this.data; }
  async checkHealth() { return { connected: true, driver: "mock", path: "m", dbSize: 0 }; }
}

describe("Phase 4: URL Set Diff Engine & Missing Tab Matcher", () => {
  test("Accurately finds missing tabs when none are open", () => {
    const targetTabs = [
      { url: "https://github.com", title: "GitHub", pinned: false, index: 0 },
      { url: "https://google.com", title: "Google", pinned: false, index: 1 }
    ];
    const liveTabs = [];

    const missing = calculateMissingTabs(targetTabs, liveTabs);
    assert.equal(missing.length, 2);
    assert.equal(missing[0].url, "https://github.com");
    assert.equal(missing[1].url, "https://google.com");
  });

  test("Returns empty array when all tabs are already open (Zero CPU Cost)", () => {
    const targetTabs = [
      { url: "https://github.com", title: "GitHub", pinned: false, index: 0 },
      { url: "https://google.com", title: "Google", pinned: false, index: 1 }
    ];
    const liveTabs = [
      { url: "https://github.com" },
      { url: "https://google.com" }
    ];

    const missing = calculateMissingTabs(targetTabs, liveTabs);
    assert.equal(missing.length, 0);
  });

  test("Never restores duplicate normalized URLs from an archive", () => {
    // Three archived copies of one URL must represent one tab.
    const targetTabs = [
      { url: "https://google.com", title: "Google 1", pinned: false, index: 0 },
      { url: "https://google.com", title: "Google 2", pinned: false, index: 1 },
      { url: "https://google.com", title: "Google 3", pinned: false, index: 2 }
    ];

    const liveTabs = [
      { url: "https://google.com" }
    ];

    const missing = calculateMissingTabs(targetTabs, liveTabs);
    assert.equal(missing.length, 0);
  });

  test("Returns only one tab per URL when no copies are open", () => {
    const targetTabs = [
      { url: "https://google.com", title: "Google 1", pinned: false, index: 0 },
      { url: "https://google.com/", title: "Google 2", pinned: false, index: 1 },
      { url: "https://example.com", title: "Example", pinned: false, index: 2 }
    ];

    const missing = calculateMissingTabs(targetTabs, []);

    assert.deepEqual(missing.map((tab) => tab.url), [
      "https://google.com", "https://example.com"
    ]);
  });

  test("Diff engine handles URL tracking parameters correctly", () => {
    const targetTabs = [
      { url: "https://example.com/item?id=50&utm_source=fb", title: "Item", pinned: false, index: 0 }
    ];
    const liveTabs = [
      { url: "https://example.com/item?id=50" } // Same target, without tracking
    ];

    const missing = calculateMissingTabs(targetTabs, liveTabs, true);
    assert.equal(missing.length, 0, "Should match despite tracking param differences");
  });

  test("syncWindowToActive filters by selected indices when specified", async () => {
    const createdUrls = [];
    globalThis.chrome = {
      tabs: {
        query: async () => [],
        create: async (props) => {
          createdUrls.push(props.url);
          return { id: createdUrls.length, ...props };
        },
        discard: async (tabId) => ({ id: tabId })
      }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    const uuid = "closed-win-1";
    sm.closedWindows[uuid] = {
      windowUuid: uuid,
      isClosed: true,
      lastUpdated: 100,
      tabs: [
        { url: "https://tab1.com", title: "Tab 1", pinned: false, index: 0 },
        { url: "https://tab2.com", title: "Tab 2", pinned: false, index: 1 },
        { url: "https://tab3.com", title: "Tab 3", pinned: false, index: 2 }
      ]
    };

    // Restore only index 1 (Tab 2)
    const result = await engine.syncWindowToActive(uuid, 999, [1]);
    assert.equal(result.success, true);
    assert.deepEqual(createdUrls, ["https://tab2.com"]);
    assert.equal(result.restoredCount, 1);
  });

  test("syncWindowToActive restores no tabs when selection is explicitly empty", async () => {
    const createdUrls = [];
    globalThis.chrome = {
      tabs: {
        query: async () => [],
        create: async (props) => {
          createdUrls.push(props.url);
          return { id: createdUrls.length, ...props };
        }
      }
    };

    const sm = new StateManager(new MockStorageAdapter());
    const engine = new DiffEngine(sm);
    sm.closedWindows["empty-selection"] = {
      windowUuid: "empty-selection",
      isClosed: true,
      tabs: [
        { url: "https://one.example", title: "One", index: 0 },
        { url: "https://two.example", title: "Two", index: 1 }
      ]
    };

    const result = await engine.syncWindowToActive("empty-selection", 7, []);

    assert.equal(result.success, true);
    assert.equal(result.restoredCount, 0);
    assert.deepEqual(createdUrls, []);
  });

  test("syncWindowToActive rejects a second restore before the first query resolves", async () => {
    const createdUrls = [];
    let resolveFirstQuery;
    let queryCount = 0;
    globalThis.chrome = {
      tabs: {
        query: async () => {
          queryCount++;
          if (queryCount === 1) {
            return await new Promise((resolve) => { resolveFirstQuery = resolve; });
          }
          return [];
        },
        create: async (props) => {
          createdUrls.push(props.url);
          return { id: createdUrls.length, ...props };
        }
      }
    };

    const sm = new StateManager(new MockStorageAdapter());
    const engine = new DiffEngine(sm);
    sm.closedWindows["restore-lock"] = {
      windowUuid: "restore-lock",
      isClosed: true,
      tabs: [{ url: "https://one.example", title: "One", index: 0 }]
    };

    const firstRestore = engine.syncWindowToActive("restore-lock", 7);
    const secondRestore = await engine.syncWindowToActive("restore-lock", 7);
    resolveFirstQuery([]);
    const firstResult = await firstRestore;

    assert.equal(secondRestore.success, false);
    assert.match(secondRestore.error, /progress/i);
    assert.equal(firstResult.restoredCount, 1);
    assert.deepEqual(createdUrls, ["https://one.example"]);
  });
});
