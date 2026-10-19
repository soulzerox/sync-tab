import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine } from "../background/diff-engine.js";
import { NativeAdapter } from "../background/storage/native-adapter.js";

class MockStorageAdapter {
  constructor() { this.data = null; }
  async save(schema) { this.data = JSON.parse(JSON.stringify(schema)); }
  async loadAll() { return this.data; }
  async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
}

const tabs = count => Array.from({ length: count }, (_, i) => ({
  url: `https://example.com/${i}`,
  title: `Tab ${i}`
}));

describe("Recovery checkpoints", () => {
  test("captures stable non-empty snapshots and deduplicates unchanged checkpoints", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    const live = [{ id: 1, tabs: tabs(3) }];

    const first = await manager.captureRecoveryCheckpoint(live, new Map(), 1_000);
    const duplicate = await manager.captureRecoveryCheckpoint(live, new Map(), 61_000);

    assert.equal(first.saved, true);
    assert.equal(duplicate.saved, false);
    assert.equal(manager.recoveryCheckpoints.length, 1);
    assert.equal(manager.recoveryCheckpoints[0].totalTabs, 3);
    assert.equal(manager.recoveryCheckpoints[0].lastVerifiedAt, 61_000);
  });

  test("ignores empty captures and keeps the last trusted checkpoint", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(3) }], new Map(), 1_000);

    const empty = await manager.captureRecoveryCheckpoint([{ id: 1, tabs: [{ url: "edge://newtab" }] }], new Map(), 61_000);

    assert.equal(empty.saved, false);
    assert.equal(manager.recoveryCheckpoints.length, 1);
    assert.equal(manager.recoveryCheckpoints[0].totalTabs, 3);
  });

  test("retains only five checkpoints, newest first", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    for (let i = 1; i <= 7; i++) {
      const live = [{ id: 1, tabs: tabs(i) }];
      await manager.captureRecoveryCheckpoint(live, new Map(), i * 60_000);
    }

    assert.equal(manager.recoveryCheckpoints.length, 5);
    assert.deepEqual(manager.recoveryCheckpoints.map(item => item.totalTabs), [7, 6, 5, 4, 3]);
  });

  test("detects a suspected mass loss and freezes trusted checkpoint rotation until acknowledged", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(10) }], new Map(), 1_000);

    const result = await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(4) }], new Map(), 61_000);

    assert.equal(result.saved, false);
    assert.equal(manager.recoveryCheckpoints.length, 1);
    assert.equal(manager.recoveryAlert.lostTabs, 6);
    assert.equal(manager.recoveryAlert.previousTabCount, 10);
    assert.equal(manager.recoveryAlert.currentTabCount, 4);

    const nextMinute = await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(2) }], new Map(), 121_000);
    assert.equal(nextMinute.saved, false);
    assert.equal(manager.recoveryCheckpoints.length, 1);
    assert.equal(manager.recoveryCheckpoints[0].timestamp, 1_000);
    assert.equal(manager.recoveryCheckpoints[0].totalTabs, 10);
    assert.equal(manager.recoveryAlert.checkpointTimestamp, 1_000);

    manager.acknowledgeRecoveryAlert();
    const acknowledgedState = await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(4) }], new Map(), 181_000);

    assert.equal(acknowledgedState.saved, true);
    assert.equal(manager.recoveryAlert, null);
    assert.equal(manager.recoveryCheckpoints.length, 2);
  });

  test("does not report an intentional whole-window close as accidental mass loss", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(10) }], new Map(), 1_000);

    const remaining = await manager.captureRecoveryCheckpoint(
      [{ id: 1, tabs: tabs(4) }],
      new Map(),
      61_000,
      { skipLossCheck: true }
    );

    assert.equal(remaining.suspectedLoss, false);
    assert.equal(manager.recoveryAlert, null);
    assert.equal(manager.recoveryCheckpoints[0].totalTabs, 4);
  });

  test("detects mass loss when either the absolute count or the percentage threshold is met", async () => {
    const byCount = new StateManager(new MockStorageAdapter());
    await byCount.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(20) }], new Map(), 1_000);
    const countOnly = await byCount.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(15) }], new Map(), 61_000);
    assert.equal(countOnly.suspectedLoss, true, "five missing URLs must alert even below 50%");

    const byFraction = new StateManager(new MockStorageAdapter());
    await byFraction.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(8) }], new Map(), 1_000);
    const fractionOnly = await byFraction.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(4) }], new Map(), 61_000);
    assert.equal(fractionOnly.suspectedLoss, true, "50% loss must alert even below five URLs");
  });

  test("does not flag a small drop, but flags every previous URL missing from an empty live window", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(8) }], new Map(), 1_000);

    const smallDrop = await manager.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(7) }], new Map(), 61_000);
    assert.equal(smallDrop.suspectedLoss, false);
    assert.equal(manager.recoveryCheckpoints.length, 2);

    const emptyWindow = await manager.captureRecoveryCheckpoint([
      { id: 1, tabs: [{ url: "edge://newtab", title: "New tab" }] }
    ], new Map(), 121_000);
    assert.equal(emptyWindow.suspectedLoss, true);
    assert.equal(manager.recoveryAlert.lostTabs, 7);
    assert.equal(manager.recoveryCheckpoints.length, 2);
  });

  test("persists checkpoints and a pending loss alert across worker rehydration", async () => {
    const storage = new MockStorageAdapter();
    const firstWorker = new StateManager(storage);
    await firstWorker.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(10) }], new Map(), 1_000);
    await firstWorker.captureRecoveryCheckpoint([{ id: 1, tabs: tabs(3) }], new Map(), 61_000);

    const restartedWorker = new StateManager(storage);
    await restartedWorker.ensureInitialized();

    assert.equal(restartedWorker.recoveryCheckpoints.length, 1);
    assert.equal(restartedWorker.recoveryCheckpoints[0].totalTabs, 10);
    assert.equal(restartedWorker.recoveryAlert.lostTabs, 7);
  });

  test("keeps checkpoint history when native SQLite loads its legacy state shape", async () => {
    const localState = {
      recoveryCheckpoints: [{ timestamp: 1, totalTabs: 9, windows: [] }],
      recoveryAlert: { lostTabs: 6 },
      skipNextRecoveryLossCheck: true
    };
    const adapter = new NativeAdapter({ loadAll: async () => localState });
    adapter.sendNativeMessage = async () => ({
      success: true,
      data: { version: "2.2.0", activeWindows: { live: {} }, closedWindows: {} }
    });

    const loaded = await adapter.loadAll();

    assert.equal(loaded.version, "2.3.0");
    assert.deepEqual(loaded.recoveryCheckpoints, localState.recoveryCheckpoints);
    assert.deepEqual(loaded.recoveryAlert, localState.recoveryAlert);
    assert.equal(loaded.skipNextRecoveryLossCheck, true);
  });

  test("keeps checkpoint ring in local storage instead of sending it in the native payload", async () => {
    let localSaved;
    let nativeMessage;
    const adapter = new NativeAdapter({
      save: async schema => { localSaved = schema; },
      loadAll: async () => null
    });
    adapter.sendNativeMessage = async message => {
      nativeMessage = message;
      return { success: true, dbPath: "/tmp/tabs.sqlite" };
    };
    const schema = {
      version: "2.3.0",
      activeWindows: {},
      closedWindows: {},
      recoveryCheckpoints: [{ timestamp: 1, windows: [] }],
      recoveryAlert: null,
      skipNextRecoveryLossCheck: false,
      settings: { storageDriver: "auto" }
    };

    await adapter.save(schema);

    assert.equal(localSaved, schema);
    assert.equal(nativeMessage.payload.recoveryCheckpoints, undefined);
    assert.equal(nativeMessage.payload.recoveryAlert, undefined);
  });

  test("restores only missing checkpoint URLs and rebuilds their saved group", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    manager.settings.lazyRestore = false;
    manager.settings.autoCleanBlankNewTab = false;
    manager.recoveryCheckpoints = [{
      timestamp: 50_000,
      totalWindows: 1,
      totalTabs: 3,
      windows: [{ tabs: [
        { url: "https://already-open.example", title: "Open", index: 0 },
        { url: "https://recover.example/1", title: "Recover 1", index: 1, group: { title: "Reading", color: "blue", collapsed: true } },
        { url: "https://recover.example/1", title: "Duplicate", index: 2, group: { title: "Reading", color: "blue", collapsed: true } },
        { url: "https://recover.example/2", title: "Recover 2", index: 3, group: { title: "Reading", color: "blue", collapsed: true } }
      ] }]
    }];

    const created = [];
    const grouped = [];
    const updatedGroups = [];
    let nextId = 2;
    const liveTabs = [{ id: 1, url: "https://already-open.example" }];
    globalThis.chrome = {
      tabs: {
        query: async () => liveTabs,
        create: async props => {
          const tab = { id: nextId++, ...props };
          created.push(tab);
          liveTabs.push(tab);
          return tab;
        },
        group: async ({ tabIds }) => { grouped.push(...tabIds); return 9; },
        discard: async () => {}
      },
      tabGroups: {
        query: async () => [],
        update: async (id, properties) => updatedGroups.push({ id, properties })
      }
    };

    const result = await new DiffEngine(manager).syncRecoveryCheckpointToActive(50_000, 7);

    assert.equal(result.success, true);
    assert.equal(result.restoredCount, 2);
    assert.deepEqual(created.map(tab => tab.url), ["https://recover.example/1", "https://recover.example/2"]);
    assert.deepEqual(grouped, [2, 3]);
    assert.deepEqual(updatedGroups, [{ id: 9, properties: { title: "Reading", color: "blue", collapsed: true } }]);
  });

  test("does not restore a checkpoint URL already open in a different Edge window", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    manager.settings.lazyRestore = false;
    manager.settings.autoCleanBlankNewTab = false;
    manager.recoveryCheckpoints = [{
      timestamp: 70_000,
      windows: [{ tabs: [
        { url: "https://already-open.example", title: "Already open", index: 0 },
        { url: "https://missing.example", title: "Missing", index: 1 }
      ] }]
    }];
    const liveTabs = [
      { id: 1, windowId: 1, url: "https://current.example" },
      { id: 2, windowId: 2, url: "https://already-open.example" }
    ];
    const created = [];
    globalThis.chrome = {
      tabs: {
        query: async () => liveTabs,
        create: async props => {
          const tab = { id: 3 + created.length, windowId: 1, ...props };
          created.push(tab);
          liveTabs.push(tab);
          return tab;
        },
        discard: async () => {}
      }
    };

    const result = await new DiffEngine(manager).syncRecoveryCheckpointToActive(70_000, 1);

    assert.equal(result.success, true);
    assert.equal(result.restoredCount, 1);
    assert.deepEqual(created.map(tab => tab.url), ["https://missing.example"]);
  });

});
