/**
 * SyncTab Popup UI Controller (High-Performance 60 FPS View & Intent Dispatcher)
 * Features: Visual Tab Group Clustering, Window Accordion Collapse/Expand,
 * Inline Window Renaming, Scroll Position Retention, and Event Delegation.
 */

import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  formatArchiveTimestamp,
  sortClosedWindowsNewestFirst
} from "../shared/closed-window-order.js";
import { clusterTabsByGroup } from "../shared/tab-group-clustering.js";
import { titleFromUrl } from "../background/url-sanitizer.js";

// DOM References
const activeWindowsList = document.getElementById("active-windows-list");
const closedWindowsList = document.getElementById("closed-windows-list");
const recoveryCheckpointsList = document.getElementById("recovery-checkpoints-list");
const recoveryCheckpointCount = document.getElementById("recovery-checkpoint-count");
const recoveryAlert = document.getElementById("recovery-alert");
const recoveryAlertCopy = document.getElementById("recovery-alert-copy");
const btnRestoreAlertCheckpoint = document.getElementById("btn-restore-alert-checkpoint");
const btnDismissRecoveryAlert = document.getElementById("btn-dismiss-recovery-alert");
const activeWindowCount = document.getElementById("active-window-count");
const closedWindowCount = document.getElementById("closed-window-count");
const btnCollapseAllActive = document.getElementById("btn-collapse-all-active");
const btnCollapseAllClosed = document.getElementById("btn-collapse-all-closed");

const searchInput = document.getElementById("search-input");
const clearSearchBtn = document.getElementById("btn-clear-search");

// Storage status elements
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const setupGuideBox = document.getElementById("setup-guide-box");
const btnCopyCmd = document.getElementById("btn-copy-cmd");
const btnTestConnection = document.getElementById("btn-test-connection");

// Action buttons
const btnManualBackup = document.getElementById("btn-manual-backup");
const btnExportMenu = document.getElementById("btn-export-menu");
const btnSettingsToggle = document.getElementById("btn-settings-toggle");

// Modals
const settingsModal = document.getElementById("settings-modal");
const exportModal = document.getElementById("export-modal");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnCloseExport = document.getElementById("btn-close-export");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnExportJson = document.getElementById("btn-export-json");
const btnExportMd = document.getElementById("btn-export-md");
const importFileInput = document.getElementById("import-file-input");

// Settings form inputs
const setAutoRestore = document.getElementById("set-auto-restore");
const setLazyRestore = document.getElementById("set-lazy-restore");
const setAutoClean = document.getElementById("set-auto-clean");
const setStripTracking = document.getElementById("set-strip-tracking");
const setRetention = document.getElementById("set-retention");
const setBlacklistDomains = document.getElementById("set-blacklist-domains");

// In-Memory UI State
let currentState = null;
let loadStateRequestId = 0;
let currentSearchQuery = "";
const selectedTabsMap = new Map(); // uuid -> Set<number>
const collapsedWindows = new Set(); // Set of window UUIDs
const collapsedGroups = new Set();  // Set of `${windowUuid}_${groupKey}`
let isActivelyEditing = false;
let searchDebounceTimer = null;

/**
 * Displays a non-blocking toast notification.
 * @param {string} message
 */
function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2400);
}

/**
 * Sends a typed RPC message to background service worker.
 * @param {string} type
 * @param {any} [payload]
 * @returns {Promise<any>}
 */
async function sendBackgroundMessage(type, payload = {}) {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    return { success: false, error: "Extension API unavailable" };
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ success: false, error: runtimeError.message || "Extension request failed" });
        return;
      }
      resolve(response || { success: false, error: "No response from background service worker" });
    });
  });
}

/**
 * Fetches state from background and renders UI with scroll position retention.
 */
async function loadState() {
  if (isActivelyEditing) return; // Prevent disrupting active inline typing

  const scrollContainer = document.querySelector(".content-scroll");
  const prevScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  const requestId = ++loadStateRequestId;
  const res = await sendBackgroundMessage(MESSAGE_TYPES.GET_STATE);
  // Multiple UI actions/storage notifications can overlap. Ignore an older response
  // so stale state never overwrites a more recent render.
  if (requestId !== loadStateRequestId) return;
  if (res && res.success && res.data) {
    currentState = res.data;
    pruneUiState(currentState);
    renderStatus(currentState.nativeStatus);
    renderActiveWindows(currentState.activeWindows);
    renderRecoveryCheckpoints(currentState.recoveryCheckpoints, currentState.recoveryAlert);
    renderClosedWindows(currentState.closedWindows);
    populateSettings(currentState.settings);

    if (currentSearchQuery) {
      applyLiveSearchFilter();
    }

    // Restore exact scroll position to eliminate bouncing to top
    if (scrollContainer) {
      scrollContainer.scrollTop = prevScrollTop;
    }
  }
}

/** Drop UI-only selections/collapse keys for windows and tabs that no longer exist. */
function pruneUiState(state) {
  const active = Object.values(state?.activeWindows || {});
  const closed = Object.values(state?.closedWindows || {});
  const allWindows = [...active, ...closed];
  const validUuids = new Set(allWindows.map(win => win.windowUuid));
  const validClosedTabs = new Map(closed.map(win => [
    win.windowUuid,
    new Set((win.tabs || []).map((tab, index) => Number.isInteger(tab.index) ? tab.index : index))
  ]));
  const validGroupIds = new Set();

  for (const win of allWindows) {
    for (const group of clusterTabsByGroup(win.tabs || []).groups) {
      validGroupIds.add(`${win.windowUuid}_${group.key}`);
    }
  }
  for (const uuid of collapsedWindows) {
    if (!validUuids.has(uuid)) collapsedWindows.delete(uuid);
  }
  for (const groupId of collapsedGroups) {
    if (!validGroupIds.has(groupId)) collapsedGroups.delete(groupId);
  }
  for (const [uuid, selected] of selectedTabsMap) {
    const validIndices = validClosedTabs.get(uuid);
    if (!validIndices) {
      selectedTabsMap.delete(uuid);
      continue;
    }
    for (const index of selected) {
      if (!validIndices.has(index)) selected.delete(index);
    }
    if (selected.size === 0) selectedTabsMap.delete(uuid);
  }
}

function formatCheckpointTime(timestamp, lastVerifiedAt = timestamp) {
  const date = new Date(timestamp);
  const ageMinutes = Math.max(0, Math.floor((Date.now() - lastVerifiedAt) / 60_000));
  const age = ageMinutes < 1 ? "checked just now"
    : ageMinutes < 60 ? `checked ${ageMinutes} minute${ageMinutes === 1 ? "" : "s"} ago`
      : `checked ${Math.floor(ageMinutes / 60)} hour${Math.floor(ageMinutes / 60) === 1 ? "" : "s"} ago`;
  return `${date.toLocaleString()} · ${age}`;
}

function renderRecoveryCheckpoints(checkpoints = [], alert = null) {
  const items = Array.isArray(checkpoints) ? checkpoints : [];
  recoveryCheckpointCount.textContent = String(items.length);
  recoveryCheckpointsList.innerHTML = "";
  if (items.length === 0) {
    recoveryCheckpointsList.innerHTML = '<div class="empty-state">No recovery checkpoints yet</div>';
  } else {
    const fragment = document.createDocumentFragment();
    items.forEach(checkpoint => {
      const card = document.createElement("div");
      card.className = "recovery-checkpoint-card";
      card.innerHTML = `
        <div class="recovery-checkpoint-meta">
          <strong>${escapeHtml(formatCheckpointTime(checkpoint.timestamp, checkpoint.lastVerifiedAt))}</strong>
          <span>${Number(checkpoint.totalTabs) || 0} tabs · ${Number(checkpoint.totalWindows) || 0} windows</span>
        </div>
        <button class="btn-secondary btn-sm" data-action="restore-recovery" data-timestamp="${Number(checkpoint.timestamp)}">Restore missing tabs</button>
      `;
      fragment.appendChild(card);
    });
    recoveryCheckpointsList.appendChild(fragment);
  }

  recoveryAlert.classList.toggle("hidden", !alert);
  if (alert) {
    recoveryAlertCopy.textContent = `SyncTab noticed ${alert.lostTabs} tabs missing (${alert.currentTabCount} now, ${alert.previousTabCount} in the last safe checkpoint). The checkpoint list is being held until you restore or dismiss this notice.`;
    btnRestoreAlertCheckpoint.dataset.timestamp = String(alert.checkpointTimestamp);
  }
}

/**
 * Updates status banner indicator.
 */
function renderStatus(status) {
  if (!status) return;

  if (status.connected && status.driver === "sqlite_native") {
    statusDot.className = "dot dot-green";
    statusText.textContent = `🟢 SQLite Drive: Connected (${status.path})`;
    setupGuideBox.classList.add("hidden");
  } else {
    statusDot.className = "dot dot-yellow";
    statusText.textContent = "🟡 Local Storage Mode (SQLite Bridge Not Connected)";
    setupGuideBox.classList.remove("hidden");
  }
}

const DEFAULT_FAVICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
);

/**
 * Builds a tab row element.
 */
function createTabRowElement(tab, windowUuid, isEditable) {
  const row = document.createElement("div");
  row.className = "tab-row";
  const tabIndex = Number.isInteger(tab.index) ? tab.index : 0;
  row.dataset.tabIndex = String(tabIndex);
  row.dataset.windowUuid = windowUuid;
  row.dataset.searchText = `${tab.title || ""} ${tab.url || ""}`.toLowerCase();

  const isChecked = selectedTabsMap.get(windowUuid)?.has(tabIndex) || false;
  const checkboxHtml = isEditable
    ? `<input type="checkbox" class="tab-select" data-uuid="${escapeHtml(windowUuid)}" data-idx="${tabIndex}" ${isChecked ? "checked" : ""}>`
    : "";

  const deleteBtnHtml = isEditable
    ? `<button class="btn-tab-delete" data-action="delete-tab" data-uuid="${escapeHtml(windowUuid)}" data-idx="${tabIndex}" title="Remove tab">✕</button>`
    : "";

  const rawFavicon = tab.favIconUrl || "";
  const faviconUrl = rawFavicon.startsWith("http") || rawFavicon.startsWith("data:")
    ? escapeHtml(rawFavicon)
    : DEFAULT_FAVICON;

  row.innerHTML = `
    <div class="tab-info">
      ${checkboxHtml}
      <img class="tab-favicon" src="${faviconUrl}" alt="">
      <span class="tab-title" title="${escapeHtml(tab.title)} — ${escapeHtml(tab.url)}">${escapeHtml(typeof tab.title === "string" && tab.title.trim() && tab.title.trim().toLowerCase() !== "untitled" ? tab.title : titleFromUrl(tab.url))}</span>
      ${tab.pinned ? '<span class="tab-tag tag-pinned">Pinned</span>' : ""}
    </div>
    ${deleteBtnHtml}
  `;

  return row;
}

/**
 * Builds the clustered tab group DOM structure inside a window body.
 */
function buildWindowBodyFragment(win, isClosed) {
  const container = document.createElement("div");
  container.className = "window-body";

  const { groups, ungrouped } = clusterTabsByGroup(win.tabs);

  // 1. Render Grouped Tab Buckets
  for (const group of groups) {
    const groupKeyId = `${win.windowUuid}_${group.key}`;
    const isGroupCollapsed = collapsedGroups.has(groupKeyId);

    const groupBox = document.createElement("div");
    groupBox.className = `tab-group-box color-${group.color}${isGroupCollapsed ? " collapsed" : ""}`;
    groupBox.dataset.groupKey = groupKeyId;

    groupBox.innerHTML = `
      <div class="tab-group-header" data-action="toggle-group" data-group-id="${escapeHtml(groupKeyId)}">
        <div class="group-left">
          <span class="group-dot"></span>
          <span class="group-title">${escapeHtml(group.title)}</span>
          <span class="group-badge">${group.tabs.length}</span>
        </div>
        <span class="group-chevron">▾</span>
      </div>
      <div class="group-body"></div>
    `;

    const groupBody = groupBox.querySelector(".group-body");
    for (const tab of group.tabs) {
      groupBody.appendChild(createTabRowElement(tab, win.windowUuid, isClosed));
    }

    container.appendChild(groupBox);
  }

  // 2. Render Ungrouped Tabs
  if (ungrouped.length > 0) {
    for (const tab of ungrouped) {
      container.appendChild(createTabRowElement(tab, win.windowUuid, isClosed));
    }
  }

  return container;
}

/**
 * Renders Active Windows (Read-Only Mirror with Accordion & Rename).
 */
function renderActiveWindows(activeMap) {
  const wins = Object.values(activeMap || {});
  activeWindowCount.textContent = String(wins.length);
  activeWindowsList.innerHTML = "";

  if (wins.length === 0) {
    activeWindowsList.innerHTML = '<div class="empty-state">No active windows detected</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  wins.forEach((win, idx) => {
    const isCollapsed = collapsedWindows.has(win.windowUuid);
    const card = document.createElement("div");
    card.className = `window-card${isCollapsed ? " collapsed" : ""}`;
    card.dataset.windowUuid = win.windowUuid;

    const defaultName = `Active Window ${idx + 1}`;
    const name = win.customName || defaultName;

    card.innerHTML = `
      <div class="window-card-header" data-action="toggle-window" data-uuid="${escapeHtml(win.windowUuid)}">
        <div class="win-title-area">
          <span class="chevron-icon">▾</span>
          <span class="win-title-text" data-action="toggle-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Click header to collapse/expand">${escapeHtml(name)}</span>
          <button class="btn-rename-trigger" data-action="rename-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Rename Window">✏️</button>
          <span class="badge badge-primary">${win.tabs.length} tabs</span>
        </div>
      </div>
    `;

    card.appendChild(buildWindowBodyFragment(win, false));
    fragment.appendChild(card);
  });

  activeWindowsList.appendChild(fragment);
}

/**
 * Renders Closed Windows Archive (Editable, Groups, Pinned Templates, Accordion).
 */
function renderClosedWindows(closedMap) {
  const wins = sortClosedWindowsNewestFirst(Object.values(closedMap || {}));
  closedWindowCount.textContent = String(wins.length);
  closedWindowsList.innerHTML = "";

  if (wins.length === 0) {
    closedWindowsList.innerHTML = '<div class="empty-state">No closed windows in archive</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  wins.forEach((win, idx) => {
    const isCollapsed = collapsedWindows.has(win.windowUuid);
    const card = document.createElement("div");
    card.className = `window-card${isCollapsed ? " collapsed" : ""}`;
    card.dataset.windowUuid = win.windowUuid;

    const defaultName = `Closed Window ${idx + 1}`;
    const name = win.customName || defaultName;
    const pinIcon = win.isPinnedTemplate ? "📌" : "📍";
    const pinTitle = win.isPinnedTemplate ? "Pinned Template (may be pruned by archive limit)" : "Pin as Template";
    const archiveTimestamp = formatArchiveTimestamp(win);

    card.innerHTML = `
      <div class="window-card-header" data-action="toggle-window" data-uuid="${escapeHtml(win.windowUuid)}">
        <div class="win-title-area">
          <span class="chevron-icon">▾</span>
          <span class="win-title-copy">
            <span class="win-title-text" data-action="toggle-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Click header to collapse/expand">${escapeHtml(name)}</span>
            <span class="archive-time" title="วันที่และเวลาที่ปิดหน้าต่าง">${escapeHtml(archiveTimestamp)}</span>
          </span>
          <button class="btn-rename-trigger" data-action="rename-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Rename Window">✏️</button>
          <span class="badge badge-secondary">${win.tabs.length} tabs</span>
        </div>
        <div class="win-actions">
          <button class="icon-btn btn-pin" data-action="toggle-pin" data-uuid="${escapeHtml(win.windowUuid)}" title="${pinTitle}">${pinIcon}</button>
          <button class="btn-sync" data-action="sync-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Sync missing tabs to current window">🔄 Sync</button>
          <button class="icon-btn btn-delete-win" data-action="delete-window" data-uuid="${escapeHtml(win.windowUuid)}" title="Delete Window Archive">🗑️</button>
        </div>
      </div>
    `;

    card.appendChild(buildWindowBodyFragment(win, true));
    fragment.appendChild(card);
  });

  closedWindowsList.appendChild(fragment);
}

// -------------------------------------------------------------
// High-Performance Delegated Event Handling (Zero Event Thrashing)
// -------------------------------------------------------------

function handleWindowListEvents(e, isClosedList) {
  const target = e.target;

  // 1. Rename Trigger (Clicking ✏️)
  const renameBtn = target.closest('[data-action="rename-window"]');
  if (renameBtn) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = renameBtn.dataset.uuid;
    startInlineRename(uuid, renameBtn);
    return;
  }

  // 2. Pin Template
  const pinBtn = target.closest('[data-action="toggle-pin"]');
  if (pinBtn) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = pinBtn.dataset.uuid;
    sendBackgroundMessage(MESSAGE_TYPES.TOGGLE_PIN_TEMPLATE, { windowUuid: uuid }).then(() => {
      showToast("Template status updated");
      loadState();
    });
    return;
  }

  // 3. Sync Window
  const syncBtn = target.closest('[data-action="sync-window"]');
  if (syncBtn) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = syncBtn.dataset.uuid;
    triggerSyncWindow(uuid);
    return;
  }

  // 4. Delete Window Archive
  const deleteWinBtn = target.closest('[data-action="delete-window"]');
  if (deleteWinBtn) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = deleteWinBtn.dataset.uuid;
    if (confirm("Delete this closed window archive?")) {
      sendBackgroundMessage(MESSAGE_TYPES.DELETE_CLOSED_WINDOW, { windowUuid: uuid }).then(() => {
        showToast("Window archive deleted");
        loadState();
      });
    }
    return;
  }

  // 5. Delete Single Tab
  const deleteTabBtn = target.closest('[data-action="delete-tab"]');
  if (deleteTabBtn) {
    e.preventDefault();
    e.stopPropagation();
    const uuid = deleteTabBtn.dataset.uuid;
    const tabIndex = parseInt(deleteTabBtn.dataset.idx, 10);
    sendBackgroundMessage(MESSAGE_TYPES.DELETE_CLOSED_TAB, { windowUuid: uuid, tabIndex }).then(() => {
      showToast("Tab removed from archive");
      loadState();
    });
    return;
  }

  // 6. Tab Group Accordion Toggle
  const groupHeader = target.closest('[data-action="toggle-group"]');
  if (groupHeader) {
    e.preventDefault();
    e.stopPropagation();
    const groupId = groupHeader.dataset.groupId;
    const groupBox = groupHeader.closest(".tab-group-box");
    if (groupBox) {
      if (collapsedGroups.has(groupId)) {
        collapsedGroups.delete(groupId);
        groupBox.classList.remove("collapsed");
      } else {
        collapsedGroups.add(groupId);
        groupBox.classList.add("collapsed");
      }
    }
    return;
  }

  // 7. Window Card Accordion Toggle (Clicking anywhere on the header)
  const cardHeader = target.closest(".window-card-header");
  if (cardHeader) {
    e.preventDefault();
    e.stopPropagation();
    const card = cardHeader.closest(".window-card");
    const uuid = card?.dataset.windowUuid;
    if (uuid && card) {
      if (collapsedWindows.has(uuid)) {
        collapsedWindows.delete(uuid);
        card.classList.remove("collapsed");
      } else {
        collapsedWindows.add(uuid);
        card.classList.add("collapsed");
      }
    }
  }
}

// Attach Event Delegation on Containers
activeWindowsList.addEventListener("click", (e) => handleWindowListEvents(e, false));
closedWindowsList.addEventListener("click", (e) => handleWindowListEvents(e, true));

// Tab Selection Change Delegation
closedWindowsList.addEventListener("change", (e) => {
  if (e.target.classList.contains("tab-select")) {
    const uuid = e.target.dataset.uuid;
    const idx = parseInt(e.target.dataset.idx, 10);
    if (!selectedTabsMap.has(uuid)) {
      selectedTabsMap.set(uuid, new Set());
    }
    const set = selectedTabsMap.get(uuid);
    if (e.target.checked) set.add(idx);
    else set.delete(idx);
  }
});

/**
 * Handles inline custom window renaming.
 */
function startInlineRename(uuid, element) {
  const card = element.closest(".window-card");
  const titleTextSpan = card?.querySelector(".win-title-text");
  if (!titleTextSpan) return;

  isActivelyEditing = true;
  const currentTitle = titleTextSpan.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "win-title-input";
  input.value = currentTitle;

  let renameCancelled = false;
  const saveRename = async () => {
    isActivelyEditing = false;
    if (renameCancelled) {
      input.replaceWith(titleTextSpan);
      return;
    }
    const newName = input.value.trim();
    if (newName && newName !== currentTitle) {
      const updatedSpan = document.createElement("span");
      updatedSpan.className = "win-title-text";
      updatedSpan.dataset.action = "toggle-window";
      updatedSpan.dataset.uuid = uuid;
      updatedSpan.title = "Click header to collapse/expand";
      updatedSpan.textContent = newName;
      input.replaceWith(updatedSpan);

      const result = await sendBackgroundMessage(MESSAGE_TYPES.RENAME_WINDOW, {
        windowUuid: uuid,
        newName
      });
      if (result?.success) {
        showToast(`Window renamed to "${newName}"`);
        await loadState();
      } else {
        showToast("Could not save the new window name");
        await loadState();
      }
    } else {
      input.replaceWith(titleTextSpan);
    }
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("mouseup", (e) => e.stopPropagation());

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      input.blur();
    } else if (e.key === "Escape") {
      renameCancelled = true;
      isActivelyEditing = false;
      input.replaceWith(titleTextSpan);
    }
  });

  input.addEventListener("blur", saveRename, { once: true });
  titleTextSpan.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * Restores missing tabs from an archive window to active window.
 */
async function triggerSyncWindow(uuid) {
  if (typeof chrome !== "undefined" && chrome.windows) {
    let winId = null;
    if (chrome.windows.getCurrent) {
      const currentWin = await chrome.windows.getCurrent();
      winId = currentWin?.id || null;
    }
    if (!winId && chrome.windows.getLastFocused) {
      const focusedWin = await chrome.windows.getLastFocused();
      winId = focusedWin?.id || null;
    }

    if (!winId) {
      showToast("❌ Could not identify active window");
      return;
    }

    const selected = selectedTabsMap.get(uuid);
    const selectedIndices = selected ? Array.from(selected) : undefined;

    const res = await sendBackgroundMessage(MESSAGE_TYPES.SYNC_WINDOW_TO_ACTIVE, {
      targetUuid: uuid,
      activeWindowId: winId,
      selectedIndices
    });

    if (res && res.success) {
      const partial = res.failedCount ? ` (${res.failedCount} failed)` : "";
      showToast(`✅ Restored ${res.restoredCount} missing tabs${partial}`);
      loadState();
    } else {
      showToast(`❌ Restore failed: ${res?.error || "Unknown error"}`);
    }
  }
}

async function triggerRestoreRecoveryCheckpoint(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || typeof chrome === "undefined" || !chrome.windows) return;
  let winId = null;
  if (chrome.windows.getCurrent) {
    const currentWin = await chrome.windows.getCurrent();
    winId = currentWin?.id || null;
  }
  if (!winId && chrome.windows.getLastFocused) {
    const focusedWin = await chrome.windows.getLastFocused();
    winId = focusedWin?.id || null;
  }
  if (!winId) {
    showToast("❌ Could not identify active window");
    return;
  }

  const result = await sendBackgroundMessage(MESSAGE_TYPES.RESTORE_RECOVERY_CHECKPOINT, {
    timestamp: Number(timestamp),
    activeWindowId: winId
  });
  if (result?.success) {
    showToast(`✅ Restored ${result.restoredCount || 0} missing tabs from checkpoint`);
    await loadState();
  } else {
    showToast(`❌ Restore failed: ${result?.error || "Unknown error"}`);
  }
}

recoveryCheckpointsList.addEventListener("click", event => {
  const button = event.target.closest('[data-action="restore-recovery"]');
  if (button) triggerRestoreRecoveryCheckpoint(button.dataset.timestamp);
});

btnRestoreAlertCheckpoint.addEventListener("click", () => {
  triggerRestoreRecoveryCheckpoint(btnRestoreAlertCheckpoint.dataset.timestamp);
});

btnDismissRecoveryAlert.addEventListener("click", async () => {
  const result = await sendBackgroundMessage(MESSAGE_TYPES.ACKNOWLEDGE_RECOVERY_ALERT);
  if (result?.success) {
    showToast("Current tabs accepted; checkpoint rotation resumed");
    await loadState();
  }
});

// -------------------------------------------------------------
// Live Search Filtering (0ms DOM Class Toggling)
// -------------------------------------------------------------

function applyLiveSearchFilter() {
  const query = currentSearchQuery.toLowerCase();
  const allRows = document.querySelectorAll(".tab-row");

  allRows.forEach((row) => {
    const text = row.dataset.searchText || "";
    const matches = query === "" || text.includes(query);
    row.classList.toggle("search-hidden", !matches);
  });

  // Auto-expand cards with matching tabs during search
  if (query) {
    document.querySelectorAll(".window-card").forEach((card) => {
      const hasVisibleTabs = card.querySelector(".tab-row:not(.search-hidden)");
      card.classList.toggle("search-hidden", !hasVisibleTabs);
      if (hasVisibleTabs) {
        card.classList.remove("collapsed");
      }
    });
  } else {
    document.querySelectorAll(".window-card").forEach((card) => {
      card.classList.remove("search-hidden");
      const uuid = card.dataset.windowUuid;
      card.classList.toggle("collapsed", collapsedWindows.has(uuid));
    });
  }
}

searchInput.addEventListener("input", (e) => {
  currentSearchQuery = e.target.value.trim();
  clearSearchBtn.classList.toggle("hidden", currentSearchQuery === "");

  if (searchDebounceTimer) cancelAnimationFrame(searchDebounceTimer);
  searchDebounceTimer = requestAnimationFrame(() => {
    applyLiveSearchFilter();
  });
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  currentSearchQuery = "";
  clearSearchBtn.classList.add("hidden");
  applyLiveSearchFilter();
});

// Toggle All Collapse/Expand
btnCollapseAllActive.addEventListener("click", () => {
  const cards = activeWindowsList.querySelectorAll(".window-card");
  const anyOpen = Array.from(cards).some(c => !c.classList.contains("collapsed"));
  cards.forEach(c => {
    const uuid = c.dataset.windowUuid;
    if (anyOpen) {
      c.classList.add("collapsed");
      if (uuid) collapsedWindows.add(uuid);
    } else {
      c.classList.remove("collapsed");
      if (uuid) collapsedWindows.delete(uuid);
    }
  });
});

btnCollapseAllClosed.addEventListener("click", () => {
  const cards = closedWindowsList.querySelectorAll(".window-card");
  const anyOpen = Array.from(cards).some(c => !c.classList.contains("collapsed"));
  cards.forEach(c => {
    const uuid = c.dataset.windowUuid;
    if (anyOpen) {
      c.classList.add("collapsed");
      if (uuid) collapsedWindows.add(uuid);
    } else {
      c.classList.remove("collapsed");
      if (uuid) collapsedWindows.delete(uuid);
    }
  });
});

// -------------------------------------------------------------
// Setup Guide & OS Switcher
// -------------------------------------------------------------

const osCommands = {
  linux: 'python3 "$HOME/Documents/Src Code/sync tab/native-host/install.py"',
  mac: 'python3 "$HOME/Documents/Src Code/sync tab/native-host/install.py"',
  win: 'python "%USERPROFILE%\\Documents\\Src Code\\sync tab\\native-host\\install.py"'
};

function initOsTabs() {
  const osTabs = document.querySelectorAll(".os-tab-btn");
  const cmdText = document.getElementById("setup-cmd-text");
  if (!osTabs.length || !cmdText) return;

  const ua = navigator.userAgent.toLowerCase();
  let defaultOs = "linux";
  if (ua.includes("win")) defaultOs = "win";
  else if (ua.includes("mac")) defaultOs = "mac";

  const setOs = (osKey) => {
    osTabs.forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-os") === osKey);
    });
    cmdText.textContent = osCommands[osKey] || osCommands.linux;
  };

  setOs(defaultOs);

  osTabs.forEach(btn => {
    btn.addEventListener("click", () => {
      const os = btn.getAttribute("data-os");
      if (os) setOs(os);
    });
  });
}

btnCopyCmd.addEventListener("click", async () => {
  const text = document.getElementById("setup-cmd-text").textContent;
  try {
    await navigator.clipboard.writeText(text);
    btnCopyCmd.textContent = "✅ Copied!";
    setTimeout(() => { btnCopyCmd.textContent = "📋 Copy"; }, 2000);
    showToast("Command copied to clipboard!");
  } catch {
    showToast("Failed to copy automatically");
  }
});

btnTestConnection.addEventListener("click", async () => {
  btnTestConnection.textContent = "Testing...";
  const res = await sendBackgroundMessage(MESSAGE_TYPES.TEST_NATIVE_CONNECTION);
  btnTestConnection.textContent = "🔄 Test Connection";
  if (res && res.success && res.data?.connected) {
    showToast("🟢 Connected to SQLite Database successfully!");
    loadState();
  } else {
    const err = res?.data?.error || "Native Host not detected";
    showToast(`🟡 ${err} (Tip: Click Reload 🔄 in edge://extensions)`);
  }
});

// Manual Snapshot Backup Button
btnManualBackup.addEventListener("click", async () => {
  const res = await sendBackgroundMessage(MESSAGE_TYPES.TRIGGER_MANUAL_BACKUP);
  if (res && res.success) {
    showToast(`💾 Snapshot Backup Created (${res.data?.totalTabs || 0} tabs)`);
  }
});

// Modals
btnSettingsToggle.addEventListener("click", () => settingsModal.classList.remove("hidden"));
btnCloseSettings.addEventListener("click", () => settingsModal.classList.add("hidden"));

btnExportMenu.addEventListener("click", () => exportModal.classList.remove("hidden"));
btnCloseExport.addEventListener("click", () => exportModal.classList.add("hidden"));

// Save Settings
btnSaveSettings.addEventListener("click", async () => {
  const payload = {
    autoRestoreOnStartup: setAutoRestore ? setAutoRestore.checked : true,
    lazyRestore: setLazyRestore.checked,
    autoCleanBlankNewTab: setAutoClean.checked,
    stripTrackingParams: setStripTracking.checked,
    blacklistDomains: (setBlacklistDomains?.value || "")
      .split(/\r?\n/)
      .map(domain => domain.trim())
      .filter(Boolean)
      .slice(0, 100),
    maxClosedWindowsRetention: Math.max(1, Math.min(5, parseInt(setRetention.value, 10) || 5))
  };

  await sendBackgroundMessage(MESSAGE_TYPES.UPDATE_SETTINGS, payload);
  settingsModal.classList.add("hidden");
  showToast("Settings updated successfully");
  loadState();
});

// Export JSON
btnExportJson.addEventListener("click", async () => {
  const res = await sendBackgroundMessage(MESSAGE_TYPES.EXPORT_DATA, { format: "json" });
  if (res && res.success && res.data) {
    downloadFile(`synctab-backup-${Date.now()}.json`, res.data, "application/json");
    showToast("JSON Backup Downloaded");
  }
});

// Export Markdown
btnExportMd.addEventListener("click", async () => {
  const res = await sendBackgroundMessage(MESSAGE_TYPES.EXPORT_DATA, { format: "markdown" });
  if (res && res.success && res.data) {
    downloadFile(`synctab-export-${Date.now()}.md`, res.data, "text/markdown");
    showToast("Markdown List Downloaded");
  }
});

// Import JSON
importFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Avoid reading an unexpectedly large backup into popup memory and sending it
  // through extension messaging. Normal exports are far smaller than this limit.
  const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
  if (file.size > MAX_IMPORT_BYTES) {
    showToast("❌ Backup file is too large (maximum 10 MB)");
    importFileInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const content = evt.target?.result;
    if (typeof content === "string") {
      const res = await sendBackgroundMessage(MESSAGE_TYPES.IMPORT_DATA, { jsonContent: content });
      if (res && res.success) {
        showToast("✅ Backup imported successfully!");
        exportModal.classList.add("hidden");
        loadState();
      } else {
        showToast("❌ Failed to import backup file");
      }
    }
  };
  reader.readAsText(file);
});

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Let the browser begin the download before releasing its object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function populateSettings(settings) {
  if (!settings) return;
  if (setAutoRestore) setAutoRestore.checked = settings.autoRestoreOnStartup !== false;
  setLazyRestore.checked = Boolean(settings.lazyRestore);
  setAutoClean.checked = Boolean(settings.autoCleanBlankNewTab);
  setStripTracking.checked = Boolean(settings.stripTrackingParams);
  if (setBlacklistDomains) setBlacklistDomains.value = Array.isArray(settings.blacklistDomains)
    ? settings.blacklistDomains.join("\n")
    : "";
  setRetention.value = String(Math.max(1, Math.min(5, settings.maxClosedWindowsRetention || 5)));
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Initial Load
document.addEventListener("DOMContentLoaded", () => {
  initOsTabs();
  loadState();
});

let storageChangeDebounce = null;
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && !isActivelyEditing) {
      if (storageChangeDebounce) clearTimeout(storageChangeDebounce);
      storageChangeDebounce = setTimeout(() => {
        loadState();
      }, 1000);
    }
  });
}

// Global capture error listener for failed favicons (CSP-compliant, zero inline handlers)
window.addEventListener(
  "error",
  (e) => {
    if (e.target && e.target.tagName === "IMG" && e.target.classList.contains("tab-favicon")) {
      e.target.src = DEFAULT_FAVICON;
    }
  },
  true
);
