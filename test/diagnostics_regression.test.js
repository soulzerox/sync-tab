import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine, calculateMissingTabs } from "../background/diff-engine.js";
import { extractGroupData } from "../background/group-manager.js";

class MockStorageAdapter {
  constructor() { this.data = null; }
  async save(schema) { this.data = JSON.parse(JSON.stringify(schema)); }
  async loadAll() { return this.data; }
  async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
}

describe("Forensic Bug Fixes & Regression Test Suite", () => {
  test("Fix 1: Preserves tab groups with empty title (Color-only groups)", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    // Group with no title, only color
    const groupMap = new Map();
    groupMap.set(10, { id: 10, title: "", color: "blue", collapsed: false });

    const liveWindows = [
      {
        id: 1,
        tabs: [
          { url: "https://test.com", title: "Test", groupId: 10 }
        ]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true, groupMap);
    const uuid = stateManager.windowIdToUuid.get(1);
    const tab = stateManager.activeWindows[uuid].tabs[0];

    assert.ok(tab.group, "Group data must exist even with empty title");
    assert.equal(tab.group.title, "");
    assert.equal(tab.group.color, "blue");
  });

  test("Fix 2: Accurately captures tab.pendingUrl when tab.url is empty string during loading", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    const liveWindows = [
      {
        id: 1,
        tabs: [
          {
            url: "", // url is empty while loading
            pendingUrl: "https://github.com/microsoft/edge",
            title: "Loading GitHub..."
          }
        ]
      }
    ];

    await stateManager.syncActiveWindows(liveWindows, true);
    const uuid = stateManager.windowIdToUuid.get(1);
    const tabs = stateManager.activeWindows[uuid].tabs;

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].url, "https://github.com/microsoft/edge");
  });

  test("Fix 3: Diff Engine handles color-only tab groups during syncWindowToActive", async () => {
    globalThis.chrome = {
      tabs: {
        query: async () => [],
        create: async (props) => ({ id: 123, ...props }),
        discard: async (tabId) => ({ id: tabId })
      }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    const uuid = "closed-uuid-color-only";
    sm.closedWindows[uuid] = {
      windowUuid: uuid,
      isClosed: true,
      lastUpdated: 1000,
      tabs: [
        {
          url: "https://alpha.com",
          title: "Alpha",
          pinned: false,
          index: 0,
          group: { title: "", color: "red", collapsed: false }
        }
      ]
    };

    const res = await engine.syncWindowToActive(uuid, 1);
    assert.equal(res.success, true);
  });

  test("Restore uses only supported create properties and discards the created tab separately", async () => {
    const createCalls = [];
    const discardedTabIds = [];
    const createdTabs = [];
    const groupedTabIds = [];
    
    globalThis.chrome = {
      tabs: {
        create: async (props) => {
          createCalls.push(props);
          const allowed = new Set(["windowId", "url", "active", "pinned"]);
          const unexpected = Object.keys(props).find((key) => !allowed.has(key));
          if (unexpected) {
            throw new TypeError(`Unexpected property: '${unexpected}'`);
          }
          const created = { id: 999, ...props };
          createdTabs.push(created);
          return created;
        },
        discard: async (tabId) => {
          discardedTabIds.push(tabId);
          const liveIndex = createdTabs.findIndex((tab) => tab.id === tabId);
          if (liveIndex >= 0) createdTabs.splice(liveIndex, 1);
          return createdTabs.find((tab) => tab.id === tabId);
        },
        group: async ({ tabIds }) => {
          const missingIds = tabIds.filter((id) => !createdTabs.some((tab) => tab.id === id));
          if (missingIds.length) throw new Error(`No tab with id: ${missingIds[0]}`);
          groupedTabIds.push(...tabIds);
          return 23;
        }
      },
      tabGroups: { update: async () => {} }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    const tabsToRestore = [{
      url: "https://fallback.com",
      title: "Fallback Test",
      group: { title: "Restored", color: "blue", collapsed: false }
    }];
    const result = await engine.executeRestore(tabsToRestore, 1, null, true, false);

    assert.equal(createCalls.length, 1, "Must create the tab without retrying invalid properties");
    assert.deepEqual(Object.keys(createCalls[0]).sort(), ["active", "pinned", "url", "windowId"]);
    assert.equal(createdTabs.length, 0, "The mock browser discarded the restored tab from its live set");
    assert.deepEqual(groupedTabIds, [999], "Group assignment must happen while created tab IDs are live");
    assert.deepEqual(discardedTabIds, [999], "Sleeping state must be applied through tabs.discard");
    assert.equal(result.restoredCount, 1);
    assert.equal(result.failedCount, 0);
  });

  test("Restore reports failure when the browser rejects every tab creation", async () => {
    globalThis.chrome = {
      tabs: {
        create: async () => { throw new Error("Invalid window id"); }
      }
    };

    const sm = new StateManager(new MockStorageAdapter());
    const engine = new DiffEngine(sm);
    const result = await engine.executeRestore(
      [{ url: "https://cannot-open.example" }], 99, null, false, false
    );

    assert.equal(result.restoredCount, 0);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.errors, ["Invalid window id"]);
  });
});
