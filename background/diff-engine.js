/**
 * Smart Diff & Restore Engine Module
 * Implements URL-Set Diffing, Edge Sleeping Tabs (tabs.discard),
 * Staggered Tab Creation, and Scoped Tab Group Reconstruction.
 */

import { TIMINGS, THRESHOLDS } from "../shared/constants.js";
import { isIgnoredUrl, normalizeUrl } from "./url-sanitizer.js";
import { getTabGroupKey, normalizeGroupTitle } from "../shared/tab-group-clustering.js";

/**
 * Pure normalized URL-set diff matcher.
 * Calculates which tabs from targetTabs are missing in currentLiveTabs.
 * Returns at most one tab per normalized URL.
 *
 * @param {import("../shared/types.js").TabData[]} targetTabs
 * @param {any[]} currentLiveTabs
 * @param {boolean} [stripTracking=true]
 * @returns {import("../shared/types.js").TabData[]}
 */
export function calculateMissingTabs(targetTabs, currentLiveTabs, stripTracking = true) {
  if (!targetTabs || targetTabs.length === 0) return [];

  const openUrls = new Set();
  for (const liveTab of currentLiveTabs || []) {
    if (!liveTab.url || isIgnoredUrl(liveTab.url)) continue;
    openUrls.add(normalizeUrl(liveTab.url, stripTracking));
  }

  // Deduplicate target URLs as well as URLs already present in the browser.
  const seenTargetUrls = new Set();
  const missingTabs = [];
  for (const targetTab of targetTabs) {
    if (!targetTab.url || isIgnoredUrl(targetTab.url)) continue;
    const norm = normalizeUrl(targetTab.url, stripTracking);
    if (seenTargetUrls.has(norm)) continue;
    seenTargetUrls.add(norm);
    if (!openUrls.has(norm)) missingTabs.push(targetTab);
  }

  return missingTabs;
}

export class DiffEngine {
  /**
   * @param {import("./state-manager.js").StateManager} stateManager
   */
  constructor(stateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Syncs tabs from a target closed window (or active window snapshot) into the specified active window.
   * @param {string} targetUuid
   * @param {number} activeWindowId
   * @param {number[]} [selectedIndices] Optional indices if only restoring subset
   * @returns {Promise<{ success: boolean, restoredCount: number, error?: string }>}
   */
  async syncWindowToActive(targetUuid, activeWindowId, selectedIndices) {
    const targetWin = this.stateManager.closedWindows[targetUuid] || this.stateManager.activeWindows[targetUuid];
    if (!targetWin || !targetWin.tabs || targetWin.tabs.length === 0) {
      return { success: false, restoredCount: 0, error: "Target window not found or has no tabs" };
    }
    return this.syncTabsToActive(targetWin.tabs, activeWindowId, selectedIndices);
  }

  /** Adds missing tabs from a recovery checkpoint into the selected live window. */
  async syncRecoveryCheckpointToActive(checkpointTimestamp, activeWindowId) {
    const checkpoint = this.stateManager.recoveryCheckpoints.find(item => item.timestamp === checkpointTimestamp);
    if (!checkpoint) {
      return { success: false, restoredCount: 0, error: "Recovery checkpoint not found" };
    }
    const tabs = (checkpoint.windows || []).flatMap(win => win.tabs || []);
    if (tabs.length === 0) {
      return { success: false, restoredCount: 0, error: "Recovery checkpoint has no tabs" };
    }
    return this.syncTabsToActive(tabs, activeWindowId);
  }

  /**
   * Shared additive restore path for archived windows and session checkpoints.
   * @param {import("../shared/types.js").TabData[]} targetTabs
   * @param {number} activeWindowId
   * @param {number[]} [selectedIndices]
   */
  async syncTabsToActive(targetTabs, activeWindowId, selectedIndices) {
    if (this.stateManager.isRestoring) {
      return { success: false, restoredCount: 0, error: "A restore is already in progress" };
    }

    // Acquire the global restore lock before any asynchronous query/diff work.
    this.stateManager.isRestoring = true;
    let restorationStarted = false;
    try {
      if (!targetTabs || targetTabs.length === 0) {
        return { success: false, restoredCount: 0, error: "Target snapshot has no tabs" };
      }

      let tabsToConsider = targetTabs;
      if (Array.isArray(selectedIndices)) {
        const indexSet = new Set(selectedIndices);
        tabsToConsider = targetTabs.filter((_, idx) => indexSet.has(idx));
      }

      // Get current live tabs in the active window.
      let currentTabs = [];
      let targetWindowTabs = [];
      let blankTabIdToClose = null;
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
        currentTabs = (await chrome.tabs.query({})).filter(tab => !tab.incognito);
        targetWindowTabs = currentTabs.filter(tab => tab.windowId === activeWindowId);
        // Lightweight test/mocked contexts may omit windowId; real browser tabs always include it.
        if (targetWindowTabs.length === 0 && currentTabs.some(tab => !Number.isInteger(tab.windowId))) {
          targetWindowTabs = currentTabs;
        }

        if (
          targetWindowTabs.length === 1 &&
          targetWindowTabs[0].id &&
          (!targetWindowTabs[0].url || targetWindowTabs[0].url === "about:blank" || targetWindowTabs[0].url.startsWith("edge://newtab") || targetWindowTabs[0].url.startsWith("chrome://newtab"))
        ) {
          blankTabIdToClose = targetWindowTabs[0].id;
        }
      }

      const missingTabs = calculateMissingTabs(
        tabsToConsider,
        currentTabs,
        this.stateManager.settings.stripTrackingParams
      );

      if (missingTabs.length === 0) {
        return { success: true, restoredCount: 0 };
      }

      restorationStarted = true;
      const restoreResult = await this.executeRestore(
        missingTabs,
        activeWindowId,
        blankTabIdToClose,
        this.stateManager.settings.lazyRestore,
        this.stateManager.settings.autoCleanBlankNewTab
      );
      if (restoreResult.restoredCount === 0) {
        return {
          success: false,
          restoredCount: 0,
          error: restoreResult.errors[0] || "Could not create any of the missing tabs"
        };
      }
      return {
        success: true,
        restoredCount: restoreResult.restoredCount,
        failedCount: restoreResult.failedCount
      };
    } catch (err) {
      return {
        success: false,
        restoredCount: 0,
        error: err instanceof Error ? err.message : String(err)
      };
    } finally {
      if (restorationStarted) {
        await new Promise(resolve => setTimeout(resolve, TIMINGS.RESTORE_SETTLE_MS));
      }
      this.stateManager.isRestoring = false;
      if (restorationStarted && typeof chrome !== "undefined" && chrome.windows && chrome.windows.getAll) {
        try {
          const [live, groups] = await Promise.all([
            chrome.windows.getAll({ populate: true }),
            chrome.tabGroups?.query ? chrome.tabGroups.query({}) : Promise.resolve([])
          ]);
          const groupMap = new Map((groups || []).map(group => [group.id, group]));
          await this.stateManager.syncActiveWindows(live, true, groupMap);
        } catch (syncErr) {
          console.warn("[SyncTab] Could not capture state after restore:", syncErr);
        }
      }
    }
  }

  /**
   * Creates tabs at a steady pace, merges/rebuilds groups, and cleans up blank tabs.
   * @param {import("../shared/types.js").TabData[]} tabs
   * @param {number} windowId
   * @param {number | null} blankTabIdToClose
   * @param {boolean} lazyRestore
   * @param {boolean} autoCleanBlankNewTab
   * @returns {Promise<{restoredCount: number, failedCount: number, errors: string[]}>}
   */
  async executeRestore(tabs, windowId, blankTabIdToClose, lazyRestore, autoCleanBlankNewTab) {
    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.create) {
      return { restoredCount: 0, failedCount: tabs.length, errors: ["Browser tab API unavailable"] };
    }

    const groupMap = new Map(); // normalized group name -> { metadata, tabIds: [] }
    const tabsToDiscard = [];
    let restoredCount = 0;
    let failedCount = 0;
    const errors = [];

    const existingGroupByName = new Map();
    if (typeof chrome.tabGroups !== "undefined" && chrome.tabGroups.query) {
      try {
        const existingGroups = await chrome.tabGroups.query({ windowId });
        for (const group of existingGroups || []) {
          const nameKey = normalizeGroupTitle(group.title);
          if (nameKey && !existingGroupByName.has(nameKey)) {
            existingGroupByName.set(nameKey, group);
          }
        }
      } catch (groupQueryErr) {
        console.warn("[SyncTab] Could not query existing Tab Groups:", groupQueryErr);
      }
    }

    // Open one tab per interval to keep restore CPU usage smooth.
    const chunkSize = THRESHOLDS.MICRO_CHUNK_SIZE;
    for (let i = 0; i < tabs.length; i += chunkSize) {
      const chunk = tabs.slice(i, i + chunkSize);

      for (const tab of chunk) {
        if (!tab.url) {
          failedCount++;
          errors.push("Tab URL is missing");
          continue;
        }
        try {
          const createProps = {
            windowId,
            url: tab.url,
            active: false,
            pinned: Boolean(tab.pinned)
          };

          const createdTab = await chrome.tabs.create(createProps);
          if (!createdTab) throw new Error("Browser did not return the created tab");
          restoredCount++;

          if (lazyRestore && createdTab.id) tabsToDiscard.push(createdTab.id);

          // Merge tabs with the same normalized group name, even when archived colors differ.
          if (tab.group && tab.group.color && createdTab?.id) {
            const groupTitle = String(tab.group.title || "").trim();
            const groupKey = getTabGroupKey(tab.group);
            if (!groupMap.has(groupKey)) {
              groupMap.set(groupKey, {
                metadata: { ...tab.group, title: groupTitle },
                tabIds: []
              });
            }
            groupMap.get(groupKey).tabIds.push(createdTab.id);
          }
        } catch (tabErr) {
          failedCount++;
          errors.push(tabErr instanceof Error ? tabErr.message : String(tabErr));
          console.warn(`[SyncTab] Could not create tab ${tab.url}:`, tabErr);
        }
      }

      // Interleave tab creation with a short pause to avoid a CPU-heavy burst.
      if (i + chunkSize < tabs.length) {
        await new Promise(r => setTimeout(r, TIMINGS.MICRO_CHUNK_DELAY_MS));
      }
    }

    // Rebuild Tab Groups scoped to windowId
    if (typeof chrome.tabGroups !== "undefined" && chrome.tabs.group) {
      const liveTabIds = typeof chrome.tabs.query === "function"
        ? new Set((await chrome.tabs.query({ windowId })).map(tab => tab.id))
        : null;

      for (const item of groupMap.values()) {
        const tabIds = liveTabIds
          ? item.tabIds.filter(tabId => liveTabIds.has(tabId))
          : item.tabIds;
        if (tabIds.length > 0) {
          try {
            const nameKey = normalizeGroupTitle(item.metadata.title);
            const existingGroup = nameKey ? existingGroupByName.get(nameKey) : undefined;
            const groupOptions = existingGroup
              ? { tabIds, groupId: existingGroup.id }
              : { tabIds, createProperties: { windowId } };
            const newGroupId = await chrome.tabs.group(groupOptions);
            if (!existingGroup) {
              await chrome.tabGroups.update(newGroupId, {
                title: item.metadata.title,
                color: item.metadata.color,
                collapsed: Boolean(item.metadata.collapsed)
              });
            }
          } catch (groupErr) {
            console.warn("[SyncTab] Could not rebuild Tab Group:", groupErr);
          }
        }
      }
    }

    // Keep tab IDs live through group reconstruction, then discard them for lazy restore.
    if (chrome.tabs.discard) {
      for (const tabId of tabsToDiscard) {
        try {
          await chrome.tabs.discard(tabId);
        } catch (discardErr) {
          console.warn(`[SyncTab] Restored tab but could not discard it (tab ${tabId}):`, discardErr);
        }
      }
    }

    // Clean up blank tab if needed
    if (autoCleanBlankNewTab && blankTabIdToClose !== null) {
      try {
        await chrome.tabs.remove(blankTabIdToClose);
      } catch {
        // Tab might already be closed, ignore
      }
    }

    return { restoredCount, failedCount, errors };
  }
}
