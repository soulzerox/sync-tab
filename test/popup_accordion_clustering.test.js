import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../background/state-manager.js";
import { clusterTabsByGroup } from "../shared/tab-group-clustering.js";

describe("Popup Tab Group Clustering & Window Renaming Test Suite", () => {
  test("1. Correctly clusters tabs by Group Title & Color and separates ungrouped tabs", () => {
    const rawTabs = [
      { url: "https://a.com", title: "Tab A", index: 0, group: { title: "Work", color: "blue" } },
      { url: "https://b.com", title: "Tab B", index: 1, group: { title: "Work", color: "blue" } },
      { url: "https://c.com", title: "Tab C", index: 2, group: { title: " work ", color: "red" } },
      { url: "https://d.com", title: "Tab D", index: 3, group: { title: "Personal", color: "pink" } },
      { url: "https://e.com", title: "Tab E", index: 4 }, // ungrouped
      { url: "https://f.com", title: "Tab F", index: 5, group: { title: "", color: "yellow" } } // color-only group
    ];

    const { groups, ungrouped } = clusterTabsByGroup(rawTabs);

    assert.equal(groups.length, 3, "Same-name groups merge even when their colors differ");
    assert.equal(ungrouped.length, 1, "Should have 1 ungrouped tab");

    // Group 1: Work
    assert.equal(groups[0].title, "Work");
    assert.equal(groups[0].color, "blue");
    assert.equal(groups[0].tabs.length, 3);

    // Group 2: Personal
    assert.equal(groups[1].title, "Personal");
    assert.equal(groups[1].color, "pink");
    assert.equal(groups[1].tabs.length, 1);

    // Group 3: Untitled (Yellow)
    assert.equal(groups[2].title, "Untitled Group");
    assert.equal(groups[2].color, "yellow");
    assert.equal(groups[2].tabs.length, 1);

    // Ungrouped
    assert.equal(ungrouped[0].title, "Tab E");
  });

  test("2. StateManager supports custom renaming for both Active and Closed windows", async () => {
    const mockStorage = {
      save: async () => {},
      loadAll: async () => ({
        version: "2.2.0",
        activeWindows: {
          "active-win-1": {
            windowUuid: "active-win-1",
            tabs: [{ url: "https://test.com", title: "Test", index: 0 }]
          }
        },
        closedWindows: {
          "closed-win-1": {
            windowUuid: "closed-win-1",
            tabs: [{ url: "https://closed.com", title: "Closed", index: 0 }]
          }
        }
      })
    };

    const sm = new StateManager(mockStorage);
    await sm.init();

    // 1. Rename Active Window
    const activeRenamed = await sm.renameWindow("active-win-1", "🚀 My Work Window");
    assert.equal(activeRenamed, true);
    assert.equal(sm.activeWindows["active-win-1"].customName, "🚀 My Work Window");

    // 2. Rename Closed Window
    const closedRenamed = await sm.renameWindow("closed-win-1", "📚 Research Archive");
    assert.equal(closedRenamed, true);
    assert.equal(sm.closedWindows["closed-win-1"].customName, "📚 Research Archive");

    // 3. Reset custom name with whitespace
    await sm.renameWindow("active-win-1", "   ");
    assert.equal(sm.activeWindows["active-win-1"].customName, undefined);
  });
});
