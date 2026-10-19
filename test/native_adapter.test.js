import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NativeAdapter } from "../background/storage/native-adapter.js";

class MockFallback {
  constructor(data) { this.data = data; this.saved = []; }
  async save(schema) {
    this.data = structuredClone(schema);
    this.saved.push(structuredClone(schema));
  }
  async loadAll() { return this.data; }
  async checkHealth() {
    return { connected: true, driver: "chrome_storage", path: "chrome.storage.local", dbSize: 123 };
  }
}

async function withChrome(mock, fn) {
  const original = globalThis.chrome;
  globalThis.chrome = mock;
  try {
    await fn();
  } finally {
    if (original === undefined) delete globalThis.chrome;
    else globalThis.chrome = original;
  }
}

describe("NativeAdapter fallback and settings", () => {
  test("treats an empty native-host callback as a failed operation", async () => {
    await withChrome({ runtime: {
      lastError: undefined,
      sendNativeMessage(_host, _message, callback) { callback(undefined); }
    } }, async () => {
      const adapter = new NativeAdapter(new MockFallback(null));
      const response = await adapter.sendNativeMessage({ action: "LOAD_STATE" });
      assert.equal(response.success, false);
      assert.match(response.error, /no response/i);
      assert.equal(adapter.isConnected, false);
    });
  });

  test("honors explicit chrome_storage mode without contacting the native host", async () => {
    const localState = {
      version: "2.3.0",
      activeWindows: { work: { windowUuid: "work", tabs: [] } },
      closedWindows: {},
      settings: { storageDriver: "chrome_storage", autoRestoreOnStartup: false }
    };
    const fallback = new MockFallback(localState);
    let nativeCalls = 0;

    await withChrome({ runtime: {
      sendNativeMessage() { nativeCalls++; }
    } }, async () => {
      const adapter = new NativeAdapter(fallback);
      assert.equal(await adapter.loadAll(), localState);
      const health = await adapter.checkHealth();
      assert.equal(health.driver, "chrome_storage");
      assert.equal(health.connected, true);
      assert.equal(nativeCalls, 0);
    });
  });

  test("preserves local settings and migrates a populated mirror when native SQLite is empty", async () => {
    const localState = {
      version: "2.3.0",
      activeWindows: {
        work: {
          windowUuid: "work",
          isClosed: false,
          lastUpdated: 10,
          tabs: [{ url: "https://example.com", title: "Example", pinned: false, index: 0 }]
        }
      },
      closedWindows: {},
      previousSessionBackup: null,
      recoveryCheckpoints: [{ timestamp: 10, totalTabs: 1, totalWindows: 1, windows: [] }],
      recoveryAlert: null,
      skipNextRecoveryLossCheck: false,
      settings: { storageDriver: "auto", autoRestoreOnStartup: false, lazyRestore: false }
    };
    const fallback = new MockFallback(localState);
    const nativeMessages = [];

    await withChrome({ runtime: {
      lastError: undefined,
      sendNativeMessage(_host, message, callback) {
        nativeMessages.push(message);
        if (message.action === "LOAD_STATE") {
          callback({
            success: true,
            data: { version: "2.2.0", activeWindows: {}, closedWindows: {}, previousSessionBackup: null },
            dbPath: "/tmp/tabs.sqlite",
            dbSize: 1
          });
        } else if (message.action === "SAVE_STATE") {
          callback({ success: true, dbPath: "/tmp/tabs.sqlite", dbSize: 10 });
        } else {
          callback({ success: true, dbPath: "/tmp/tabs.sqlite", dbSize: 10 });
        }
      }
    } }, async () => {
      const adapter = new NativeAdapter(fallback);
      const loaded = await adapter.loadAll();

      assert.equal(loaded.activeWindows.work.tabs[0].url, "https://example.com");
      assert.equal(loaded.settings.autoRestoreOnStartup, false);
      assert.equal(loaded.settings.lazyRestore, false);
      assert.equal(loaded.recoveryCheckpoints.length, 1);
      assert.ok(nativeMessages.some(message => message.action === "SAVE_STATE"), "local state should seed an empty native database");
      assert.equal(adapter.isConnected, true);
    });
  });

  test("skips redundant SQLite writes for checkpoint-only and settings-only changes", async () => {
    const fallback = new MockFallback(null);
    let nativeSaveCount = 0;
    const adapter = new NativeAdapter(fallback);
    adapter.sendNativeMessage = async message => {
      if (message.action === "SAVE_STATE") nativeSaveCount++;
      return { success: true, dbPath: "/tmp/tabs.sqlite", dbSize: 10 };
    };
    const schema = {
      version: "2.3.0",
      activeWindows: { work: { windowUuid: "work", tabs: [{ url: "https://example.com", index: 0 }] } },
      closedWindows: {},
      previousSessionBackup: null,
      recoveryCheckpoints: [],
      recoveryAlert: null,
      skipNextRecoveryLossCheck: false,
      settings: { storageDriver: "auto", autoRestoreOnStartup: true }
    };

    await adapter.save(schema);
    await adapter.save({
      ...schema,
      recoveryCheckpoints: [{ timestamp: 123 }],
      settings: { ...schema.settings, autoRestoreOnStartup: false }
    });

    assert.equal(nativeSaveCount, 1, "SQLite stores browser snapshots, not local-only settings/checkpoints");
    assert.equal(fallback.saved.length, 2, "local mirror must still persist the changed checkpoint/settings");
  });

  test("prefers newer local windows and merges archives when native SQLite is stale", async () => {
    const localState = {
      version: "2.3.0",
      activeWindows: {
        work: {
          windowUuid: "work", isClosed: false, lastUpdated: 20,
          tabs: [{ url: "https://new.example", title: "New", index: 0 }]
        }
      },
      closedWindows: {
        archive: {
          windowUuid: "archive", isClosed: true, closedAt: 30, lastUpdated: 15,
          tabs: [{ url: "https://archive.example", title: "Archive", index: 0 }]
        }
      },
      previousSessionBackup: null,
      recoveryCheckpoints: [],
      settings: { storageDriver: "auto" }
    };
    const fallback = new MockFallback(localState);
    const adapter = new NativeAdapter(fallback);
    let savedNativePayload = null;
    adapter.sendNativeMessage = async message => {
      if (message.action === "LOAD_STATE") {
        return {
          success: true,
          data: {
            version: "2.2.0",
            activeWindows: {
              work: {
                windowUuid: "work", isClosed: false, lastUpdated: 10,
                tabs: [{ url: "https://old.example", title: "Old", index: 0 }]
              }
            },
            closedWindows: {},
            previousSessionBackup: null
          }
        };
      }
      if (message.action === "SAVE_STATE") savedNativePayload = message.payload;
      return { success: true };
    };

    const loaded = await adapter.loadAll();
    assert.equal(loaded.activeWindows.work.tabs[0].url, "https://new.example");
    assert.equal(loaded.closedWindows.archive.tabs[0].url, "https://archive.example");
    assert.ok(savedNativePayload, "stale native SQLite should be repaired from the merged state");
    assert.ok(savedNativePayload.closedWindows.archive);
  });

  test("merges local settings when native SQLite already has browser state", async () => {
    const fallback = new MockFallback({
      settings: { storageDriver: "sqlite_native", autoRestoreOnStartup: false },
      recoveryCheckpoints: [{ timestamp: 20 }],
      recoveryAlert: null,
      skipNextRecoveryLossCheck: true
    });

    await withChrome({ runtime: {
      lastError: undefined,
      sendNativeMessage(_host, message, callback) {
        if (message.action === "LOAD_STATE") {
          callback({
            success: true,
            data: {
              version: "2.2.0",
              activeWindows: { work: { windowUuid: "work", tabs: [] } },
              closedWindows: {},
              previousSessionBackup: null
            }
          });
        } else {
          callback({ success: true });
        }
      }
    } }, async () => {
      const adapter = new NativeAdapter(fallback);
      const loaded = await adapter.loadAll();
      assert.equal(loaded.settings.autoRestoreOnStartup, false);
      assert.equal(loaded.settings.storageDriver, "sqlite_native");
      assert.equal(loaded.recoveryCheckpoints.length, 1);
      assert.equal(loaded.skipNextRecoveryLossCheck, true);
    });
  });
});
