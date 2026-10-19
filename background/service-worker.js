/**
 * Background Service Worker (Manifest V3)
 * Entry Point: Event Listeners, Lifecycle Management, and Typed Message Router.
 */

import { MESSAGE_TYPES } from "../shared/messages.js";
import { StateManager } from "./state-manager.js";
import { DiffEngine } from "./diff-engine.js";
import { NativeAdapter } from "./storage/native-adapter.js";
import { LocalAdapter } from "./storage/local-adapter.js";
import { registerRecoveryCheckpointAlarm } from "./recovery-scheduler.js";

// Initialize Storage Adapter, StateManager, and DiffEngine
const localAdapter = new LocalAdapter();
const nativeAdapter = new NativeAdapter(localAdapter);
const stateManager = new StateManager(nativeAdapter);
const diffEngine = new DiffEngine(stateManager);

/**
 * Updates the extension toolbar badge with the total active tab count.
 */
async function updateBadge() {
  if (typeof chrome === "undefined" || !chrome.action || !chrome.action.setBadgeText) return;
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#0078D4" }); // Microsoft Edge Blue
  } catch {
    // Ignore in non-tab contexts
  }
}

/**
 * Collects Tab Groups from all open windows into a Map (groupId -> TabGroup).
 * @returns {Promise<Map<number, chrome.tabGroups.TabGroup>>}
 */
async function getTabGroupMap(strict = false) {
  const map = new Map();
  if (typeof chrome !== "undefined" && chrome.tabGroups && chrome.tabGroups.query) {
    try {
      const groups = await chrome.tabGroups.query({});
      for (const group of groups) {
        if (group.id) map.set(group.id, group);
      }
    } catch (err) {
      if (strict) throw err;
      // tabGroups permission might be restricted
    }
  } else if (strict) {
    throw new Error("Tab Groups API unavailable; checkpoint was not captured");
  }
  return map;
}

let startupPromise = null;

/**
 * Ensures startup reconciliation runs exactly once per browser session.
 * Waking up from idle within the same session bypasses reconciliation.
 * @returns {Promise<void>}
 */
async function ensureStartupReconciled() {
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    await stateManager.ensureInitialized();

    let isNewBrowserSession = false;
    let sessionData = {};
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
      try {
        sessionData = await chrome.storage.session.get(["sessionAlive", "windowUuidMappings"]);
        if (!sessionData || !sessionData.sessionAlive) {
          isNewBrowserSession = true;
          await chrome.storage.session.set({ sessionAlive: true, windowUuidMappings: {} });
        }
      } catch {
        isNewBrowserSession = true;
      }
    } else {
      isNewBrowserSession = true;
    }

    if (!isNewBrowserSession && typeof chrome !== "undefined" && chrome.windows?.getAll) {
      try {
        const liveWindows = await chrome.windows.getAll({ populate: true });
        stateManager.restoreWindowIdMappings(liveWindows, sessionData.windowUuidMappings || {});
      } catch (err) {
        console.warn("[SyncTab] Could not rehydrate window identity mapping:", err);
      }
    }

    if (isNewBrowserSession && typeof chrome !== "undefined" && chrome.windows && chrome.windows.getAll) {
      try {
        const [liveWindows, groupMap] = await Promise.all([
          chrome.windows.getAll({ populate: true }),
          getTabGroupMap()
        ]);
        await stateManager.reconcileStartup(liveWindows, groupMap, diffEngine);
        await updateBadge();
      } catch (err) {
        // Do not mark startup complete when the authoritative browser snapshot failed.
        // The next event can retry instead of permanently skipping reconciliation.
        startupPromise = null;
        console.warn("[SyncTab] Startup reconciliation error; will retry:", err);
      }
    }
  })().catch(error => {
    // Retry startup reconciliation on the next browser event after transient failures.
    startupPromise = null;
    throw error;
  });

  return startupPromise;
}

/**
 * Triggers full state sync from live browser windows.
 * @param {boolean} [immediate=false]
 */
let browserSyncPromise = null;
let browserSyncRequested = false;
let browserSyncImmediateRequested = false;

/** Serialize browser snapshots and coalesce event storms into a fresh follow-up query. */
async function syncFromBrowser(immediate = false) {
  if (typeof chrome === "undefined" || !chrome.windows || !chrome.windows.getAll) return;
  if (browserSyncPromise) {
    browserSyncRequested = true;
    browserSyncImmediateRequested ||= immediate;
    return browserSyncPromise;
  }

  browserSyncPromise = (async () => {
    let nextImmediate = immediate;
    do {
      browserSyncRequested = false;
      const useImmediate = nextImmediate || browserSyncImmediateRequested;
      browserSyncImmediateRequested = false;
      await syncFromBrowserOnce(useImmediate);
      nextImmediate = false;
    } while (browserSyncRequested);
  })();

  try {
    await browserSyncPromise;
  } finally {
    browserSyncPromise = null;
  }
}

async function syncFromBrowserOnce(immediate) {
  try {
    await ensureStartupReconciled();
    const [liveWindows, groupMap] = await Promise.all([
      chrome.windows.getAll({ populate: true }),
      getTabGroupMap()
    ]);
    await stateManager.syncActiveWindows(liveWindows, immediate, groupMap);
    await updateBadge();
  } catch (err) {
    console.warn("[SyncTab] syncFromBrowser error:", err);
  }
}

let recoveryCapturePromise = null;
let recoveryCaptureRequested = false;
let recoveryCaptureSkipLossCheckRequested = false;

/** Coalesce overlapping tab-complete/close events into one capture plus at most one follow-up. */
async function captureRecoveryCheckpointFromBrowser(skipLossCheck = false) {
  if (recoveryCapturePromise) {
    recoveryCaptureRequested = true;
    recoveryCaptureSkipLossCheckRequested ||= skipLossCheck;
    return recoveryCapturePromise;
  }

  recoveryCapturePromise = (async () => {
    let nextSkipLossCheck = skipLossCheck;
    do {
      recoveryCaptureRequested = false;
      const useSkipLossCheck = nextSkipLossCheck || recoveryCaptureSkipLossCheckRequested;
      recoveryCaptureSkipLossCheckRequested = false;
      await captureRecoveryCheckpointFromBrowserOnce(useSkipLossCheck);
      nextSkipLossCheck = false;
    } while (recoveryCaptureRequested);
  })();

  try {
    await recoveryCapturePromise;
  } finally {
    recoveryCapturePromise = null;
  }
}

async function captureRecoveryCheckpointFromBrowserOnce(skipLossCheck = false) {
  try {
    await ensureStartupReconciled();
    if (
      stateManager.isRestoring ||
      typeof chrome === "undefined" ||
      !chrome.windows?.getAll
    ) return;

    const liveWindows = await chrome.windows.getAll({ populate: true });
    if (!Array.isArray(liveWindows) || liveWindows.length === 0) return;

    let groupMap;
    try {
      groupMap = await getTabGroupMap(true);
    } catch (groupError) {
      // A missing Tab Groups API must not prevent the core tab list from being saved.
      await stateManager.syncActiveWindows(liveWindows, true, new Map());
      await updateBadge();
      console.warn("[SyncTab] Active state synced; checkpoint skipped because Tab Groups query failed:", groupError);
      return;
    }

    // Keep the active mirror fresh even during startup grace; transformWindowData
    // protects saved website tabs from temporary Edge placeholders in this period.
    await stateManager.syncActiveWindows(liveWindows, true, groupMap);
    await updateBadge();
    if (Date.now() < stateManager.startupGraceUntil) return;

    await stateManager.captureRecoveryCheckpoint(liveWindows, groupMap, Date.now(), { skipLossCheck });
  } catch (error) {
    console.warn("[SyncTab] Skipped incomplete recovery checkpoint:", error);
  }
}

registerRecoveryCheckpointAlarm(
  typeof chrome === "undefined" ? null : chrome,
  captureRecoveryCheckpointFromBrowser
);

// -------------------------------------------------------------
// Lifecycle Event Listeners
// -------------------------------------------------------------

// On Extension Installed or Updated
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(async () => {
    await ensureStartupReconciled();
    // Checkpoint capture refreshes active state too, so avoid a duplicate full sync/write.
    await captureRecoveryCheckpointFromBrowser();
  });
}

// On Browser Startup / Profile Recovery
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(async () => {
    await ensureStartupReconciled();
    await captureRecoveryCheckpointFromBrowser();
  });
}

// -------------------------------------------------------------
// Tab and Window Event Listeners
// -------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.tabs) {
  // Tab created
  chrome.tabs.onCreated.addListener(async () => {
    await ensureStartupReconciled();
    syncFromBrowser(false);
  });

  // Tab updated (filter to complete status for accurate titles & final URLs)
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status === "complete" || changeInfo.title || changeInfo.pinned !== undefined) {
      await ensureStartupReconciled();
      if (changeInfo.status === "complete") {
        // The checkpoint capture also refreshes active state; avoid a duplicate full sync/write.
        await captureRecoveryCheckpointFromBrowser();
      } else {
        syncFromBrowser(false);
      }
    }
  });

  // Tab removed (0ms instant flush)
  chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // If window is closing, do NOT drain tabs from activeWindows!
    // Allow windows.onRemoved to cleanly archive the full window.
    if (removeInfo && removeInfo.isWindowClosing) {
      return;
    }
    await ensureStartupReconciled();
    await captureRecoveryCheckpointFromBrowser();
  });

  // Tab attached to new window (Cross-Window drag & drop)
  chrome.tabs.onAttached.addListener(async () => {
    await ensureStartupReconciled();
    syncFromBrowser(true);
  });

  // Tab detached from window
  chrome.tabs.onDetached.addListener(async () => {
    await ensureStartupReconciled();
    syncFromBrowser(true);
  });

  // Tab moved within window
  chrome.tabs.onMoved.addListener(async () => {
    await ensureStartupReconciled();
    syncFromBrowser(false);
  });
}

if (typeof chrome !== "undefined" && chrome.windows) {
  // Window created
  chrome.windows.onCreated.addListener(async (win) => {
    await ensureStartupReconciled();
    if (win.id) {
      stateManager.getOrCreateWindowUuid(win.id);
      syncFromBrowser(true);
    }
  });

  // Window removed (0ms instant flush + last window backup)
  chrome.windows.onRemoved.addListener(async (windowId) => {
    await ensureStartupReconciled();
    if (chrome.windows.getAll) {
      const remaining = await chrome.windows.getAll({ populate: true });
      await stateManager.onWindowRemoved(windowId, remaining);
      await updateBadge();
      // Closing one whole window is an explicit user action, not evidence of a
      // browser tab-loss incident. Refresh the trusted baseline if other regular
      // windows remain, but preserve the previous checkpoint when the last closes.
      if (remaining.some(win => win && !win.incognito && win.type !== "devtools")) {
        await captureRecoveryCheckpointFromBrowser(true);
      }
    }
  });
}

// Keyboard shortcuts (Commands)
if (typeof chrome !== "undefined" && chrome.commands) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === "trigger_manual_backup") {
      await stateManager.triggerManualBackup();
    }
  });
}

// -------------------------------------------------------------
// Typed RPC Message Handler (Popup <-> Service Worker)
// -------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        await ensureStartupReconciled();
        if (!message || !message.type) {
          sendResponse({ success: false, error: "Invalid message payload" });
          return;
        }

        switch (message.type) {
          case MESSAGE_TYPES.GET_STATE: {
            await stateManager.ensureInitialized();
            if (Object.keys(stateManager.activeWindows || {}).length === 0 && typeof chrome !== "undefined" && chrome.windows && chrome.windows.getAll) {
              const [liveWindows, groupMap] = await Promise.all([
                chrome.windows.getAll({ populate: true }),
                getTabGroupMap()
              ]);
              await stateManager.syncActiveWindows(liveWindows, true, groupMap);
            }
            const health = await nativeAdapter.checkHealth();
            sendResponse({
              success: true,
              data: {
                ...stateManager.getFullSchema(),
                nativeStatus: health
              }
            });
            break;
          }

          case MESSAGE_TYPES.SYNC_WINDOW_TO_ACTIVE: {
            const { targetUuid, activeWindowId, selectedIndices } = message.payload || {};
            const result = await diffEngine.syncWindowToActive(targetUuid, activeWindowId, selectedIndices);
            sendResponse(result);
            break;
          }

          case MESSAGE_TYPES.RESTORE_RECOVERY_CHECKPOINT: {
            const { timestamp, activeWindowId } = message.payload || {};
            const result = await diffEngine.syncRecoveryCheckpointToActive(timestamp, activeWindowId);
            if (result.success && !result.failedCount) await stateManager.acknowledgeRecoveryAlert();
            sendResponse(result);
            break;
          }

          case MESSAGE_TYPES.ACKNOWLEDGE_RECOVERY_ALERT: {
            await stateManager.acknowledgeRecoveryAlert();
            sendResponse({ success: true });
            break;
          }

          case MESSAGE_TYPES.DELETE_CLOSED_WINDOW: {
            const { windowUuid } = message.payload || {};
            const ok = await stateManager.deleteClosedWindow(windowUuid);
            sendResponse({ success: ok });
            break;
          }

          case MESSAGE_TYPES.DELETE_CLOSED_TAB: {
            const { windowUuid, tabIndex } = message.payload || {};
            const ok = await stateManager.deleteClosedTab(windowUuid, tabIndex);
            sendResponse({ success: ok });
            break;
          }

          case MESSAGE_TYPES.RENAME_WINDOW: {
            const { windowUuid, newName } = message.payload || {};
            const ok = await stateManager.renameWindow(windowUuid, newName);
            sendResponse({ success: ok });
            break;
          }

          case MESSAGE_TYPES.TOGGLE_PIN_TEMPLATE: {
            const { windowUuid } = message.payload || {};
            const ok = await stateManager.togglePinTemplate(windowUuid);
            sendResponse({ success: ok });
            break;
          }

          case MESSAGE_TYPES.TEST_NATIVE_CONNECTION: {
            const health = await nativeAdapter.checkHealth();
            sendResponse({ success: true, data: health });
            break;
          }

          case MESSAGE_TYPES.TRIGGER_MANUAL_BACKUP: {
            const backup = await stateManager.triggerManualBackup();
            sendResponse({ success: true, data: backup });
            break;
          }

          case MESSAGE_TYPES.UPDATE_SETTINGS: {
            await stateManager.updateSettings(message.payload);
            sendResponse({ success: true, data: stateManager.settings });
            break;
          }

          case MESSAGE_TYPES.EXPORT_DATA: {
            const format = message.payload?.format || "json";
            const content = stateManager.exportData(format);
            sendResponse({ success: true, data: content, format });
            break;
          }

          case MESSAGE_TYPES.IMPORT_DATA: {
            const ok = await stateManager.importData(message.payload?.jsonContent);
            sendResponse({ success: ok });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unhandled message type: ${message.type}` });
        }
      } catch (err) {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true; // Keep message channel open for async response
  });
}
