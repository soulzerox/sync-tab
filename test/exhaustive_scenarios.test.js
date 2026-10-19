import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { DiffEngine, calculateMissingTabs } from "../background/diff-engine.js";
import { normalizeUrl, sanitizeTitle, isIgnoredUrl } from "../background/url-sanitizer.js";

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

describe("Exhaustive Multi-Scenario & Stress Test Matrix", () => {
  test("Scenario 1: High-Speed Event Storm Debounce Coalescing (100 rapid events -> 1 write)", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    // Initial state
    await stateManager.syncActiveWindows([{ id: 1, tabs: [{ url: "https://init.com", title: "Init" }] }], true);
    assert.equal(storage.saveCount, 1);

    // Simulate 100 rapid tab events arriving within 10ms (non-immediate hot debounce)
    for (let i = 0; i < 100; i++) {
      stateManager.syncActiveWindows([{
        id: 1,
        tabs: Array.from({ length: i + 1 }, (_, j) => ({ url: `https://site.com/${j}`, title: `Tab ${j}` }))
      }], false);
    }

    // Wait for the 400ms debounce timer to settle
    await new Promise(r => setTimeout(r, 450));

    // Save count must be exactly 2 (1 initial immediate + 1 coalesced debounced write)
    assert.equal(storage.saveCount, 2, `Expected 2 writes, got ${storage.saveCount}`);
    const uuid = stateManager.windowIdToUuid.get(1);
    assert.equal(stateManager.activeWindows[uuid].tabs.length, 100);
  });

  test("Scenario 2: Multi-Monitor Dual Display Window Bounds Topology", async () => {
    const storage = new MockStorageAdapter();
    const stateManager = new StateManager(storage);

    const multiMonitorWindows = [
      {
        id: 101,
        left: -1920, // Secondary monitor on the left
        top: 0,
        width: 1920,
        height: 1080,
        state: "maximized",
        tabs: [{ url: "https://monitor-left.com", title: "Left Display" }]
      },
      {
        id: 102,
        left: 0, // Primary 4K monitor
        top: 0,
        width: 3840,
        height: 2160,
        state: "normal",
        tabs: [{ url: "https://monitor-main.com", title: "Main Display" }]
      }
    ];

    await stateManager.syncActiveWindows(multiMonitorWindows, true);
    const uuid1 = stateManager.windowIdToUuid.get(101);
    const uuid2 = stateManager.windowIdToUuid.get(102);

    assert.equal(stateManager.activeWindows[uuid1].bounds.left, -1920);
    assert.equal(stateManager.activeWindows[uuid2].bounds.width, 3840);

    // Export / Import round-trip with negative coordinates
    const json = stateManager.exportData("json");
    const newSM = new StateManager(storage);
    await newSM.importData(json);
    assert.ok(json.includes("-1920"));
  });

  test("Scenario 3: 2000+ Character URL with 20+ Tracking Parameters Stripping", () => {
    const marketingParams = [
      "utm_source=facebook",
      "utm_medium=cpc",
      "utm_campaign=summer_sale_2026",
      "utm_term=smart+browser+sync",
      "utm_content=banner_top",
      "fbclid=IwAR3xQ8Xn4C3yGZq5vYl7zQk3tK9j6kR",
      "gclid=Cj0KCQjwgJ64BhCFARIsAId_iMr",
      "msclkid=9f8e7d6c5b4a",
      "mc_eid=1234567890",
      "igshid=abcdef123456",
      "_hsenc=p2ANqtz-9"
    ];

    const businessParams = [
      "product_id=987654",
      "category=developer_tools",
      "sort=featured",
      "page=3",
      "view_mode=grid"
    ];

    const longPath = "very/deep/nested/category/structure/for/enterprise/application/suite/".repeat(5);
    const rawUrl = `https://enterprise.shop.example.com/${longPath}?${businessParams.join("&")}&${marketingParams.join("&")}`;

    const normalized = normalizeUrl(rawUrl, true);

    // Verify all tracking params are stripped
    marketingParams.forEach(p => {
      const key = p.split("=")[0];
      assert.ok(!normalized.includes(`${key}=`), `Should not contain tracking param ${key}`);
    });

    // Verify all business params are retained
    businessParams.forEach(p => {
      assert.ok(normalized.includes(p), `Must preserve business query param ${p}`);
    });
  });

  test("Scenario 4: Partial Tab Selection Restore with Group Scoping", async () => {
    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);

    const uuid = "partial-group-win";
    sm.closedWindows[uuid] = {
      windowUuid: uuid,
      isClosed: true,
      lastUpdated: 1000,
      tabs: [
        { url: "https://tab0.com", title: "Tab 0", index: 0, group: { title: "Work", color: "blue" } },
        { url: "https://tab1.com", title: "Tab 1", index: 1, group: { title: "Work", color: "blue" } },
        { url: "https://tab2.com", title: "Tab 2", index: 2, group: { title: "Personal", color: "green" } },
        { url: "https://tab3.com", title: "Tab 3", index: 3, group: { title: "Personal", color: "green" } }
      ]
    };

    // User selects only tab 0 and tab 2
    const targetTabs = [sm.closedWindows[uuid].tabs[0], sm.closedWindows[uuid].tabs[2]];
    const missing = calculateMissingTabs(targetTabs, [], true);

    assert.equal(missing.length, 2);
    assert.equal(missing[0].url, "https://tab0.com");
    assert.equal(missing[0].group.title, "Work");
    assert.equal(missing[1].url, "https://tab2.com");
    assert.equal(missing[1].group.title, "Personal");
  });

  test("Scenario 5: Blank Tab Cleanup Simulation on Restore", async () => {
    let createdTabs = [];
    let closedTabs = [];

    globalThis.chrome = {
      // @ts-ignore
      tabs: {
        create: async (props) => {
          const tab = { id: 100 + createdTabs.length, ...props };
          createdTabs.push(tab);
          return tab;
        },
        remove: async (tabId) => {
          closedTabs.push(tabId);
        }
      }
    };

    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);
    const engine = new DiffEngine(sm);

    const tabsToRestore = [
      { url: "https://github.com", title: "GitHub" },
      { url: "https://microsoft.com", title: "Microsoft" }
    ];

    // Restore into window 1 where tab 50 is a blank new tab (edge://newtab)
    await engine.executeRestore(tabsToRestore, 1, 50, true, true);

    assert.equal(createdTabs.length, 2);
    // Tab 50 must have been removed
    assert.ok(closedTabs.includes(50), "Blank new tab must be closed automatically");
  });

  test("Scenario 6: UUID Topology and Cross-Window Drag & Drop Simulation", async () => {
    const storage = new MockStorageAdapter();
    const sm = new StateManager(storage);

    // Initial state: Window A (id: 1) with Tab 1, Window B (id: 2) with Tab 2
    await sm.syncActiveWindows([
      { id: 1, tabs: [{ url: "https://tab1.com", title: "Tab 1" }] },
      { id: 2, tabs: [{ url: "https://tab2.com", title: "Tab 2" }] }
    ], true);

    const uuidA = sm.windowIdToUuid.get(1);
    const uuidB = sm.windowIdToUuid.get(2);

    assert.equal(sm.activeWindows[uuidA].tabs.length, 1);
    assert.equal(sm.activeWindows[uuidB].tabs.length, 1);

    // User drags Tab 1 from Window A into Window B
    await sm.syncActiveWindows([
      { id: 1, tabs: [] }, // Window A now empty or closed
      { id: 2, tabs: [{ url: "https://tab2.com", title: "Tab 2" }, { url: "https://tab1.com", title: "Tab 1" }] }
    ], true);

    assert.equal(sm.activeWindows[uuidA].tabs.length, 0);
    assert.equal(sm.activeWindows[uuidB].tabs.length, 2);
    assert.equal(sm.activeWindows[uuidB].tabs[1].url, "https://tab1.com");
  });
});
