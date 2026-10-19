import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";

class MockStorageAdapter {
  constructor(data = null) { this.data = data; }
  async save(schema) { this.data = JSON.parse(JSON.stringify(schema)); }
  async loadAll() { return this.data; }
  async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
}

describe("Startup transient-tab protection", () => {
  test("does not overwrite saved website tabs when startup only exposes a new-tab placeholder", async () => {
    const savedWindow = {
      windowUuid: "saved-window",
      customName: "Work",
      isClosed: false,
      lastUpdated: 1_000,
      tabs: [
        { url: "https://github.com", title: "GitHub", pinned: false, index: 0 },
        { url: "https://stackoverflow.com", title: "Stack Overflow", pinned: false, index: 1 }
      ]
    };
    const storage = new MockStorageAdapter({
      version: "2.3.0",
      activeWindows: { "saved-window": savedWindow },
      closedWindows: {},
      recoveryCheckpoints: [],
      settings: { autoRestoreOnStartup: false }
    });
    const manager = new StateManager(storage);
    await manager.ensureInitialized();

    manager.settings.autoRestoreOnStartup = true;
    await manager.reconcileStartup([
      { id: 7, tabs: [{ id: 70, url: "edge://newtab", title: "New tab", status: "complete" }] }
    ], new Map(), { syncWindowToActive: async () => ({ success: true }) });

    assert.deepEqual(
      manager.activeWindows["saved-window"]?.tabs.map(tab => tab.url),
      ["https://github.com", "https://stackoverflow.com"],
      "a transient startup placeholder must not replace the last saved website snapshot"
    );
  });

  test("checkpoint fingerprint changes when tab order changes", async () => {
    const manager = new StateManager(new MockStorageAdapter());
    const first = [{ id: 1, tabs: [
      { url: "https://one.example", title: "One" },
      { url: "https://two.example", title: "Two" }
    ] }];
    const reordered = [{ id: 1, tabs: [
      { url: "https://two.example", title: "Two" },
      { url: "https://one.example", title: "One" }
    ] }];

    await manager.captureRecoveryCheckpoint(first, new Map(), 1_000);
    const result = await manager.captureRecoveryCheckpoint(reordered, new Map(), 61_000);

    assert.equal(result.saved, true, "tab order is part of the recoverable browser state");
    assert.deepEqual(manager.recoveryCheckpoints[0].windows[0].tabs.map(tab => tab.url), [
      "https://two.example", "https://one.example"
    ]);
  });
});
