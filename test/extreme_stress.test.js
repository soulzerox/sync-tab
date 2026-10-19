import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine, calculateMissingTabs } from "../background/diff-engine.js";
import { normalizeUrl, sanitizeTitle } from "../background/url-sanitizer.js";

class MockStorageAdapter {
  constructor() { this.data = null; }
  async save(schema) { this.data = JSON.parse(JSON.stringify(schema)); }
  async loadAll() { return this.data; }
  async checkHealth() { return { connected: true, driver: "mock", path: "memory", dbSize: 0 }; }
}

describe("Phase 8: Extreme Edge Cases & Boundary Stress Testing", () => {
  test("1. Handles Multi-byte Unicode, Thai, Chinese, Emoji in Titles and URLs", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    const unicodeTabs = [
      {
        url: "https://th.wikipedia.org/wiki/ปัญญาประดิษฐ์",
        title: "🧠 ปัญญาประดิษฐ์ — วิกิพีเดีย (ไทย)",
        pinned: true
      },
      {
        url: "https://ja.wikipedia.org/wiki/人工知能",
        title: "人工知能 - Wikipedia (日本語)",
        pinned: false
      },
      {
        url: "https://example.com/🚀/special-path?query=✨ทดสอบ✨",
        title: "🌟 Emoji & Thai Query Page",
        pinned: false
      }
    ];

    await stateManager.syncActiveWindows([{ id: 1, tabs: unicodeTabs }], true);
    const uuid = stateManager.windowIdToUuid.get(1);
    const savedWin = stateManager.activeWindows[uuid];

    assert.equal(savedWin.tabs.length, 3);
    assert.equal(savedWin.tabs[0].title, "🧠 ปัญญาประดิษฐ์ — วิกิพีเดีย (ไทย)");
    assert.equal(savedWin.tabs[1].title, "人工知能 - Wikipedia (日本語)");

    // Export and Import roundtrip with Unicode
    const json = stateManager.exportData("json");
    const newSM = new StateManager(storage);
    const imported = await newSM.importData(json);

    assert.equal(imported, true);
    assert.ok(json.includes("ปัญญาประดิษฐ์"));
  });

  test("2. Resilient against Malformed and Corrupted JSON Import", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    assert.equal(await stateManager.importData("invalid json {{ {"), false);
    assert.equal(await stateManager.importData(""), false);
    assert.equal(await stateManager.importData("null"), false);
    assert.equal(await stateManager.importData("12345"), false);
    assert.equal(await stateManager.importData("[]"), false); // Valid JSON, but not a valid backup schema
  });

  test("3. Massive GC Retention caps all windows at five, including pinned templates", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);
    stateManager.settings.maxClosedWindowsRetention = 20;

    // Create 100 closed windows, with 10 pinned templates scattered
    for (let i = 0; i < 100; i++) {
      const u = `uuid-${i}`;
      const isPinned = i % 10 === 0; // 0, 10, 20, 30, 40, 50, 60, 70, 80, 90 (10 pinned)
      stateManager.closedWindows[u] = {
        windowUuid: u,
        customName: `Window ${i}`,
        isClosed: true,
        isPinnedTemplate: isPinned,
        closedAt: 1000 + i,
        lastUpdated: 1000 + i,
        tabs: [{ url: `https://site-${i}.com`, title: `Site ${i}`, pinned: false, index: 0 }]
      };
    }

    stateManager.pruneClosedWindows();

    const remaining = Object.values(stateManager.closedWindows);
    const pinnedRemaining = remaining.filter(w => w.isPinnedTemplate);
    const unpinnedRemaining = remaining.filter(w => !w.isPinnedTemplate);

    assert.equal(remaining.length, 5);
    assert.deepEqual(remaining.map((win) => win.windowUuid).sort(), [
      "uuid-95", "uuid-96", "uuid-97", "uuid-98", "uuid-99"
    ]);
    assert.equal(pinnedRemaining.length + unpinnedRemaining.length, 5);
  });

  test("4. High Volume Concurrent Operations (Zero Race Conditions)", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    // Create initial window
    await stateManager.syncActiveWindows([{ id: 1, tabs: [{ url: "https://init.com", title: "Init" }] }], true);
    const uuid = stateManager.windowIdToUuid.get(1);

    // Dispatch 50 concurrent async operations
    const promises = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        promises.push(stateManager.renameWindow(uuid, `Concurrent Name ${i}`));
      } else {
        promises.push(stateManager.togglePinTemplate(uuid));
      }
    }

    const results = await Promise.all(promises);
    assert.equal(results.length, 50);
    assert.ok(results.every(r => r === true));
    assert.ok(stateManager.activeWindows[uuid]);
  });
});
