/**
 * State Manager Module (Deep Module)
 * Manages Window Topology, UUID Persistence, Hot Debounce, 0ms Close Flush,
 * Startup Reconciliation, and Garbage Collection.
 */

import {
  STORAGE_VERSION,
  TIMINGS,
  THRESHOLDS,
  DEFAULT_SETTINGS
} from "../shared/constants.js";
import { dedupeTabsByUrl, isBlacklistedUrl, isIgnoredUrl, normalizeBlacklistDomain, normalizeUrl, sanitizeTitle } from "./url-sanitizer.js";
import { extractGroupData } from "./group-manager.js";
import { getTabGroupKey } from "../shared/tab-group-clustering.js";

function normalizeSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const normalized = { ...DEFAULT_SETTINGS, ...source };
  // This legacy option was never wired to an automatic-sync control.
  delete normalized.autoSync;

  if (!["auto", "chrome_storage", "sqlite_native"].includes(normalized.storageDriver)) {
    normalized.storageDriver = DEFAULT_SETTINGS.storageDriver;
  }
  for (const key of ["autoRestoreOnStartup", "lazyRestore", "autoCleanBlankNewTab", "stripTrackingParams"]) {
    if (typeof normalized[key] !== "boolean") normalized[key] = DEFAULT_SETTINGS[key];
  }
  const retention = Number(normalized.maxClosedWindowsRetention);
  normalized.maxClosedWindowsRetention = Number.isFinite(retention) && retention >= 1
    ? Math.min(THRESHOLDS.MAX_CLOSED_WINDOWS_RETENTION, Math.floor(retention))
    : DEFAULT_SETTINGS.maxClosedWindowsRetention;
  if (typeof normalized.sqliteDbPath !== "string" || normalized.sqliteDbPath.length > 4096) {
    normalized.sqliteDbPath = DEFAULT_SETTINGS.sqliteDbPath;
  }
  normalized.blacklistDomains = Array.isArray(normalized.blacklistDomains)
    ? [...new Set(normalized.blacklistDomains
      .map(normalizeBlacklistDomain)
      .filter(domain => domain.length > 0 && domain.length <= 253))]
      .slice(0, 100)
    : [...DEFAULT_SETTINGS.blacklistDomains];
  return normalized;
}

/** Compare persisted window content without treating observation time as a change. */
function sameWindowState(left, right) {
  if (!left || !right) return false;
  const { lastUpdated: _leftUpdated, ...leftState } = left;
  const { lastUpdated: _rightUpdated, ...rightState } = right;
  return JSON.stringify(leftState) === JSON.stringify(rightState);
}

export class StateManager {
  /**
   * @param {import("./storage/storage-adapter.js").StorageAdapter} storageAdapter
   */
  constructor(storageAdapter) {
    /** @type {import("./storage/storage-adapter.js").StorageAdapter} */
    this.storage = storageAdapter;

    /** @type {Record<string, import("../shared/types.js").WindowData>} */
    this.activeWindows = {};

    /** @type {Record<string, import("../shared/types.js").WindowData>} */
    this.closedWindows = {};

    /** @type {import("../shared/types.js").PreviousSessionBackup | undefined} */
    this.previousSessionBackup = undefined;

    /** @type {import("../shared/types.js").RecoveryCheckpoint[]} */
    this.recoveryCheckpoints = [];

    /** @type {import("../shared/types.js").RecoveryAlert|null} */
    this.recoveryAlert = null;

    /** @type {boolean} */
    this.skipNextRecoveryLossCheck = false;

    /** @type {import("../shared/types.js").ExtensionSettings} */
    this.settings = { ...DEFAULT_SETTINGS };

    /** @type {Map<number, string>} Maps ephemeral Chrome windowId -> persistent windowUuid */
    this.windowIdToUuid = new Map();

    /** @type {Map<string, number>} Maps persistent windowUuid -> ephemeral Chrome windowId */
    this.uuidToWindowId = new Map();

    /** @type {any} Debounce timer */
    this.debounceTimer = null;

    /** @type {boolean} Mutex lock guard for restore events */
    this.isRestoring = false;

    /** @type {boolean} Whether state has been hydrated from storage */
    this.isInitialized = false;

    /** @type {Promise<void> | null} Initialization promise */
    this.initPromise = null;

    /** @type {Promise<void>} Serializes storage writes to prevent older snapshots winning races. */
    this.persistQueue = Promise.resolve();

    /** @type {Map<string, import("../shared/types.js").TabData[]>} Preserves last non-empty tabs per window to protect against close draining */
    this.lastKnownTabs = new Map();

    // Browser session restore can briefly expose only placeholder tabs. Keep the
    // previous snapshot authoritative during that short startup reconciliation window.
    this.startupGraceUntil = 0;
  }

  /**
   * Ensures the StateManager is initialized before performing any operations.
   */
  async ensureInitialized() {
    if (this.isInitialized) return;
    if (!this.initPromise) {
      this.initPromise = this.init().catch(error => {
        // A transient storage/native-host failure must not poison this manager for
        // the rest of the service-worker lifetime; allow a later operation to retry.
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  /**
   * Initializes the StateManager by loading persisted data from storage.
   */
  async init() {
    if (this.isInitialized) return;
    const saved = await this.storage.loadAll();
    if (saved) {
      this.activeWindows = saved.activeWindows || {};
      this.closedWindows = saved.closedWindows || {};
      this.previousSessionBackup = saved.previousSessionBackup;
      this.recoveryCheckpoints = Array.isArray(saved.recoveryCheckpoints)
        ? saved.recoveryCheckpoints.slice(0, THRESHOLDS.MAX_RECOVERY_CHECKPOINTS)
        : [];
      this.recoveryAlert = saved.recoveryAlert || null;
      this.skipNextRecoveryLossCheck = Boolean(saved.skipNextRecoveryLossCheck);
      this.settings = normalizeSettings(saved.settings);

      // Repair legacy snapshots that persisted the generic placeholder before a
      // page title was available. Do not overwrite any meaningful saved title.
      const repairTabTitles = windows => {
        let changed = false;
        for (const win of Object.values(windows || {})) {
          for (const tab of win?.tabs || []) {
            if (!tab || (typeof tab.title === "string" && tab.title.trim() && tab.title.trim().toLowerCase() !== "untitled")) continue;
            const title = sanitizeTitle(tab?.title, THRESHOLDS.MAX_TITLE_LENGTH, tab?.url);
            if (tab.title !== title) {
              tab.title = title;
              changed = true;
            }
          }
        }
        return changed;
      };
      let repairedTitles = repairTabTitles(this.activeWindows);
      repairedTitles = repairTabTitles(this.closedWindows) || repairedTitles;
      if (Array.isArray(this.previousSessionBackup?.windows)) {
        repairedTitles = repairTabTitles(Object.fromEntries(
          this.previousSessionBackup.windows.map((win, index) => [String(index), win])
        )) || repairedTitles;
      }
      for (const checkpoint of this.recoveryCheckpoints) {
        if (Array.isArray(checkpoint?.windows)) {
          repairedTitles = repairTabTitles(Object.fromEntries(
            checkpoint.windows.map((win, index) => [String(index), win])
          )) || repairedTitles;
        }
      }

      if (repairedTitles) await this.persist();

      // Seed lastKnownTabs from loaded state
      for (const [uuid, win] of Object.entries(this.activeWindows)) {
        if (win.tabs && win.tabs.length > 0) {
          this.lastKnownTabs.set(uuid, [...win.tabs]);
        }
      }
      for (const [uuid, win] of Object.entries(this.closedWindows)) {
        if (win.tabs && win.tabs.length > 0 && !this.lastKnownTabs.has(uuid)) {
          this.lastKnownTabs.set(uuid, [...win.tabs]);
        }
      }
    }
    this.isInitialized = true;
  }

  /**
   * Gets or generates a persistent UUID for a given ephemeral Chrome windowId.
   * @param {number} windowId
   * @returns {string}
   */
  getOrCreateWindowUuid(windowId) {
    if (this.windowIdToUuid.has(windowId)) {
      return /** @type {string} */ (this.windowIdToUuid.get(windowId));
    }

    const newUuid = crypto.randomUUID();
    this.bindWindowId(windowId, newUuid);
    return newUuid;
  }

  /**
   * Binds a browser-session window ID to an extension-owned persistent UUID.
   * @param {number} windowId
   * @param {string} uuid
   */
  bindWindowId(windowId, uuid) {
    const priorUuid = this.windowIdToUuid.get(windowId);
    if (priorUuid && priorUuid !== uuid) this.uuidToWindowId.delete(priorUuid);
    const priorWindowId = this.uuidToWindowId.get(uuid);
    if (priorWindowId !== undefined && priorWindowId !== windowId) this.windowIdToUuid.delete(priorWindowId);
    this.windowIdToUuid.set(windowId, uuid);
    this.uuidToWindowId.set(uuid, windowId);
  }

  /**
   * Returns the current browser-session ID mapping for chrome.storage.session.
   * @returns {Record<string, string>}
   */
  getWindowIdMappings() {
    return Object.fromEntries(Array.from(this.windowIdToUuid.entries(), ([id, uuid]) => [String(id), uuid]));
  }

  /**
   * Rehydrates window identity after an MV3 worker restart, then matches any
   * unmapped live windows to saved active snapshots by URL overlap.
   * @param {any[]} liveWindows
   * @param {Record<string, string>} [mappings]
   */
  restoreWindowIdMappings(liveWindows = [], mappings = {}) {
    this.windowIdToUuid.clear();
    this.uuidToWindowId.clear();
    const liveById = new Map((liveWindows || []).filter(win => Number.isInteger(win?.id)).map(win => [win.id, win]));
    const unboundLiveIds = new Set(liveById.keys());
    const claimedUuids = new Set();

    for (const [rawId, uuid] of Object.entries(mappings || {})) {
      const windowId = Number(rawId);
      if (!Number.isInteger(windowId) || !liveById.has(windowId) || !this.activeWindows[uuid] || claimedUuids.has(uuid)) continue;
      this.bindWindowId(windowId, uuid);
      unboundLiveIds.delete(windowId);
      claimedUuids.add(uuid);
    }

    const savedWindows = Object.entries(this.activeWindows)
      .filter(([uuid]) => !claimedUuids.has(uuid))
      .map(([uuid, data]) => ({ uuid, data }));

    for (const windowId of unboundLiveIds) {
      const live = liveById.get(windowId);
      const liveUrls = new Set((live?.tabs || [])
        .map(tab => tab.url || tab.pendingUrl)
        .filter(url => url && !isIgnoredUrl(url))
        .map(url => normalizeUrl(url, this.settings.stripTrackingParams)));
      let bestIndex = -1;
      let bestScore = 0;
      savedWindows.forEach((saved, index) => {
        const score = (saved.data.tabs || []).reduce((count, tab) => {
          const url = normalizeUrl(tab.url, this.settings.stripTrackingParams);
          return count + (liveUrls.has(url) ? 1 : 0);
        }, 0);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        const [saved] = savedWindows.splice(bestIndex, 1);
        this.bindWindowId(windowId, saved.uuid);
        claimedUuids.add(saved.uuid);
      }
    }
  }

  /** Persists the browser-session mapping so it survives service-worker suspension. */
  async persistWindowIdMappings() {
    if (typeof chrome === "undefined" || !chrome.storage?.session?.set) return;
    try {
      await chrome.storage.session.set({ windowUuidMappings: this.getWindowIdMappings() });
    } catch (err) {
      console.warn("[SyncTab] Could not persist window identity mapping:", err);
    }
  }

  /**
   * Reconciles state on browser startup or after a crash.
   * Any active window in storage not present in the live session is moved to closedWindows.
   * If autoRestoreOnStartup is enabled, restores previous session tabs into the live session.
   * @param {any[]} liveWindows
   * @param {Map<number, any>} [groupMap]
   * @param {import("./diff-engine.js").DiffEngine} [diffEngine]
   */
  async reconcileStartup(liveWindows = [], groupMap = new Map(), diffEngine = null) {
    await this.ensureInitialized();
    const now = Date.now();
    this.startupGraceUntil = now + 10_000;

    // Closed-window history is user-managed recovery data, never session input.
    // Only the last active snapshot or the dedicated rolling backup can resume.
    const previousSessionWindows = Object.values(this.activeWindows).map(win => ({
      ...win,
      // An empty array is truthy; explicitly fall back to the last known non-empty snapshot.
      tabs: dedupeTabsByUrl(
        win.tabs?.length ? win.tabs : (this.lastKnownTabs.get(win.windowUuid) || []),
        this.settings.stripTrackingParams
      )
    }));
    if (previousSessionWindows.length === 0 && this.previousSessionBackup?.windows?.length) {
      previousSessionWindows.push(...this.previousSessionBackup.windows
        .filter(win => win.tabs?.length && win.isClosed !== true)
        .map(win => ({ ...win, tabs: dedupeTabsByUrl(win.tabs, this.settings.stripTrackingParams) })));
    }

    for (const winData of previousSessionWindows) {
      if (!winData.tabs?.length) continue;
      this.closedWindows[winData.windowUuid] = {
        ...winData,
        isClosed: true,
        closedAt: winData.closedAt || winData.lastUpdated || now
      };
    }

    if (previousSessionWindows.length > 0) {
      const totalTabs = previousSessionWindows.reduce((acc, win) => acc + (win.tabs?.length || 0), 0);
      this.previousSessionBackup = {
        timestamp: now,
        triggerReason: "crash_recovery",
        totalWindows: previousSessionWindows.length,
        totalTabs,
        windows: previousSessionWindows
      };
    }

    // New browser session: old browser IDs are invalid, but the UUIDs stay stable.
    this.activeWindows = {};
    this.windowIdToUuid.clear();
    this.uuidToWindowId.clear();
    this.pruneClosedWindows();

    // Resume snapshots into matching Edge-restored windows before creating windows.
    const resumedUuids = new Set();
    if (previousSessionWindows.length > 0 && liveWindows?.length > 0) {
      const autoRestore = this.settings.autoRestoreOnStartup !== false && Boolean(diffEngine);
      const availableWindows = liveWindows.filter(win => win?.id && !win.incognito);
      const pendingSnapshots = [...previousSessionWindows].sort((a, b) => (b.tabs?.length || 0) - (a.tabs?.length || 0));

      for (const snapshot of pendingSnapshots) {
        let targetIndex = -1;
        let bestScore = 0;
        for (let i = 0; i < availableWindows.length; i++) {
          const score = this.countSharedUrls(snapshot.tabs || [], availableWindows[i].tabs || []);
          if (score > bestScore) {
            bestScore = score;
            targetIndex = i;
          }
        }

        // Only auto-restore is allowed to claim a blank window without URL evidence.
        if (targetIndex < 0 && autoRestore && availableWindows.length > 0) targetIndex = 0;
        let targetWindow = targetIndex >= 0 ? availableWindows.splice(targetIndex, 1)[0] : null;

        if (!targetWindow && autoRestore && typeof chrome !== "undefined" && chrome.windows?.create) {
          try {
            const createOptions = { url: "about:blank", focused: false };
            if (snapshot.bounds?.left !== undefined) createOptions.left = snapshot.bounds.left;
            if (snapshot.bounds?.top !== undefined) createOptions.top = snapshot.bounds.top;
            if (snapshot.bounds?.width !== undefined) createOptions.width = snapshot.bounds.width;
            if (snapshot.bounds?.height !== undefined) createOptions.height = snapshot.bounds.height;
            targetWindow = await chrome.windows.create(createOptions);
          } catch (winErr) {
            console.warn("[SyncTab] Failed to create secondary window for restore:", winErr);
          }
        }

        if (!targetWindow?.id) continue;
        this.bindWindowId(targetWindow.id, snapshot.windowUuid);
        if (!autoRestore) {
          resumedUuids.add(snapshot.windowUuid);
          continue;
        }
        try {
          const result = await diffEngine.syncWindowToActive(snapshot.windowUuid, targetWindow.id);
          if (result.success) resumedUuids.add(snapshot.windowUuid);
        } catch (restoreErr) {
          console.warn("[SyncTab] Auto-restore on startup failed:", restoreErr);
        }
      }

    }

    // 4. Sync live windows for the new session and persist
    if (typeof chrome !== "undefined" && chrome.windows && chrome.windows.getAll) {
      try {
        const currentLive = await chrome.windows.getAll({ populate: true });
        await this.syncActiveWindows(currentLive, true, groupMap);
      } catch {
        await this.syncActiveWindows(liveWindows, true, groupMap);
      }
    } else {
      await this.syncActiveWindows(liveWindows, true, groupMap);
    }
    for (const uuid of resumedUuids) delete this.closedWindows[uuid];
    if (previousSessionWindows.length > 0) await this.persist();
    await this.persistWindowIdMappings();
  }

  /** Counts normalized URL overlap between a saved and live window. */
  countSharedUrls(savedTabs, liveTabs) {
    const liveUrls = new Set((liveTabs || [])
      .map(tab => tab.url || tab.pendingUrl)
      .filter(url => url && !isIgnoredUrl(url))
      .map(url => normalizeUrl(url, this.settings.stripTrackingParams)));
    const savedUrls = new Set((savedTabs || [])
      .map(tab => tab.url)
      .filter(url => url && !isIgnoredUrl(url))
      .map(url => normalizeUrl(url, this.settings.stripTrackingParams)));
    let count = 0;
    for (const url of savedUrls) if (liveUrls.has(url)) count++;
    return count;
  }

  /**
   * Transforms raw Chrome tabs & window into clean WindowData.
   * @param {any} win
   * @param {string} uuid
   * @param {Map<number, any>} [groupMap]
   * @returns {import("../shared/types.js").WindowData}
   */
  transformWindowData(win, uuid, groupMap = new Map()) {
    const existing = this.activeWindows[uuid] || this.closedWindows[uuid];
    const customName = existing?.customName;
    const isPinnedTemplate = existing?.isPinnedTemplate;

    const tabs = [];
    let index = 0;

    for (const tab of win.tabs || []) {
      const rawUrl = tab.url || tab.pendingUrl;
      if (!rawUrl || isIgnoredUrl(rawUrl) || isBlacklistedUrl(rawUrl, this.settings.blacklistDomains)) continue;

      const groupData = tab.groupId && tab.groupId > 0 && groupMap.has(tab.groupId)
        ? extractGroupData(groupMap.get(tab.groupId))
        : undefined;

      tabs.push({
        url: normalizeUrl(rawUrl, this.settings.stripTrackingParams),
        title: sanitizeTitle(tab.title, THRESHOLDS.MAX_TITLE_LENGTH, rawUrl),
        favIconUrl: tab.favIconUrl || "",
        pinned: Boolean(tab.pinned),
        index: index++,
        group: groupData
      });
    }

    let uniqueTabs = dedupeTabsByUrl(tabs, this.settings.stripTrackingParams);
    const rawTabs = win.tabs || [];
    const transientOnly = rawTabs.length > 0 && rawTabs.every(tab => {
      const url = tab.url || tab.pendingUrl;
      const lowerUrl = typeof url === "string" ? url.toLowerCase() : "";
      return !url || url === "about:blank" || lowerUrl.startsWith("edge://newtab") || lowerUrl.startsWith("chrome://newtab");
    });

    // Edge may emit onCreated/onUpdated before its session-restored URLs are
    // available. Do not let a temporary new-tab placeholder erase the saved
    // website list while startup reconciliation is still settling.
    if (
      uniqueTabs.length === 0 &&
      transientOnly &&
      Date.now() < this.startupGraceUntil &&
      Array.isArray(existing?.tabs) && existing.tabs.length > 0
    ) {
      uniqueTabs = existing.tabs.map(tab => ({ ...tab }));
    }

    if (uniqueTabs.length > 0) {
      this.lastKnownTabs.set(uuid, [...uniqueTabs]);
    } else if (rawTabs.length > 0 && Date.now() >= this.startupGraceUntil) {
      // After startup settles, an internal-only window may be recorded as empty.
      this.lastKnownTabs.delete(uuid);
    }

    return {
      windowUuid: uuid,
      customName,
      isClosed: false,
      isPinnedTemplate,
      lastUpdated: Date.now(),
      bounds: {
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        state: win.state
      },
      tabs: uniqueTabs
    };
  }

  /**
   * Syncs current live windows to activeWindows state with debounce or instant write.
   * @param {any[]} liveWindows
   * @param {boolean} [immediate=false]
   * @param {Map<number, any>} [groupMap]
   */
  async syncActiveWindows(liveWindows, immediate = false, groupMap = new Map()) {
    if (this.isRestoring) return; // Suppress during restoration
    await this.ensureInitialized();
    if (!Array.isArray(liveWindows)) return;

    // An empty/partial browser query must not erase the last known session. Explicit
    // windows.onRemoved handling owns intentional cleanup, and startup reconciliation
    // clears activeWindows before syncing its authoritative snapshot.
    const hasRegularWindow = liveWindows.some(win => win?.id && !win.incognito);
    if (!hasRegularWindow && Object.keys(this.activeWindows).length > 0) {
      console.warn("[SyncTab] Ignoring empty live-window sample to protect saved tabs");
      return;
    }

    const doSync = async () => {
      const previousMappings = JSON.stringify(this.getWindowIdMappings());
      const previousActive = this.activeWindows;
      const newActive = {};
      let stateChanged = false;

      for (const win of liveWindows) {
        if (!win.id || win.incognito) continue; // Skip incognito
        const uuid = this.getOrCreateWindowUuid(win.id);
        const transformed = this.transformWindowData(win, uuid, groupMap);
        const previous = previousActive[uuid];
        if (sameWindowState(previous, transformed)) {
          // Keep the prior object and timestamp when the observable browser state is unchanged.
          newActive[uuid] = previous;
        } else {
          newActive[uuid] = transformed;
          stateChanged = true;
        }
      }

      if (Object.keys(previousActive).length !== Object.keys(newActive).length) {
        stateChanged = true;
      }
      this.activeWindows = newActive;

      const mappingsChanged = previousMappings !== JSON.stringify(this.getWindowIdMappings());
      if (stateChanged) await this.persist();
      if (mappingsChanged) await this.persistWindowIdMappings();
    };

    if (immediate) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      await doSync();
    } else {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;
        try {
          await doSync();
        } catch (error) {
          console.warn("[SyncTab] Debounced state sync failed:", error);
        }
      }, TIMINGS.HOT_DEBOUNCE_MS);
    }
  }

  /**
   * Captures a bounded, independently persisted recovery checkpoint from a complete live query.
   * A large drop relative to the newest trusted checkpoint freezes rotation until acknowledged.
   * @param {any[]} liveWindows
   * @param {Map<number, any>} [groupMap]
   * @param {number} [timestamp]
   * @returns {Promise<{saved: boolean, suspectedLoss: boolean, checkpoint?: any}>}
   */
  async captureRecoveryCheckpoint(liveWindows = [], groupMap = new Map(), timestamp = Date.now(), options = {}) {
    await this.ensureInitialized();
    if (this.isRestoring || this.recoveryAlert) {
      return { saved: false, suspectedLoss: Boolean(this.recoveryAlert) };
    }

    const windows = [];
    for (const win of liveWindows || []) {
      if (!win?.id || win.incognito) continue;
      const uuid = this.getOrCreateWindowUuid(win.id);
      const snapshot = this.transformWindowData(win, uuid, groupMap);
      if (snapshot.tabs.length > 0) {
        windows.push({
          windowUuid: snapshot.windowUuid,
          customName: snapshot.customName,
          isClosed: false,
          lastUpdated: timestamp,
          tabs: snapshot.tabs.map(tab => ({
            url: tab.url,
            pinned: tab.pinned,
            index: tab.index,
            ...(tab.group ? { group: { ...tab.group } } : {})
          }))
        });
      }
    }
    const totalTabs = windows.reduce((sum, win) => sum + win.tabs.length, 0);
    const fingerprint = JSON.stringify(windows.map(win => ({
      windowUuid: win.windowUuid,
      tabs: win.tabs.map(tab => ({
        url: tab.url,
        pinned: tab.pinned,
        index: tab.index,
        group: tab.group || null
      }))
    })));
    const newest = this.recoveryCheckpoints[0];

    if (!options.skipLossCheck && !this.skipNextRecoveryLossCheck && newest) {
      const tabIdentity = (win, tab) => `${win.windowUuid}\u0000${normalizeUrl(tab.url, this.settings.stripTrackingParams)}`;
      const previousTabIdentities = new Set((newest.windows || []).flatMap(win =>
        (win.tabs || []).map(tab => tabIdentity(win, tab))
      ));
      const currentTabIdentities = new Set(windows.flatMap(win =>
        win.tabs.map(tab => tabIdentity(win, tab))
      ));
      const lostTabs = Array.from(previousTabIdentities).filter(identity => !currentTabIdentities.has(identity)).length;
      const lossFraction = previousTabIdentities.size > 0 ? lostTabs / previousTabIdentities.size : 0;
      if (
        lostTabs >= THRESHOLDS.SUSPECTED_TAB_LOSS_MINIMUM ||
        lossFraction >= THRESHOLDS.SUSPECTED_TAB_LOSS_FRACTION
      ) {
        this.recoveryAlert = {
          detectedAt: timestamp,
          lostTabs,
          previousTabCount: newest.totalTabs,
          currentTabCount: totalTabs,
          checkpointTimestamp: newest.timestamp
        };
        await this.persist();
        return { saved: false, suspectedLoss: true };
      }
    }

    // Empty samples never become checkpoints, but can still trigger a suspected-loss alert.
    if (windows.length === 0 || totalTabs === 0) return { saved: false, suspectedLoss: false };

    if (newest?.fingerprint === fingerprint) {
      newest.lastVerifiedAt = timestamp;
      this.skipNextRecoveryLossCheck = false;
      await this.persist();
      return { saved: false, suspectedLoss: false, checkpoint: newest };
    }

    const checkpoint = {
      timestamp,
      lastVerifiedAt: timestamp,
      totalWindows: windows.length,
      totalTabs,
      fingerprint,
      windows
    };
    this.recoveryCheckpoints.unshift(checkpoint);
    this.recoveryCheckpoints = this.recoveryCheckpoints.slice(0, THRESHOLDS.MAX_RECOVERY_CHECKPOINTS);
    this.skipNextRecoveryLossCheck = false;
    await this.persist();
    return { saved: true, suspectedLoss: false, checkpoint };
  }

  /** Accepts that the current reduced tab set was intentional and resumes checkpoint rotation. */
  async acknowledgeRecoveryAlert() {
    await this.ensureInitialized();
    this.recoveryAlert = null;
    this.skipNextRecoveryLossCheck = true;
    await this.persist();
    return true;
  }

  /**
   * Handles window close event immediately (0ms flush) and archives to closedWindows.
   * @param {number} windowId
   * @param {any[]} remainingLiveWindows
   */
  async onWindowRemoved(windowId, remainingLiveWindows) {
    await this.ensureInitialized();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;

    const uuid = this.windowIdToUuid.get(windowId);
    let closedWin = null;
    if (uuid && this.activeWindows[uuid]) {
      const existingTabs = this.activeWindows[uuid].tabs || [];
      const finalTabs = dedupeTabsByUrl(existingTabs.length > 0
        ? existingTabs
        : (this.lastKnownTabs.get(uuid) || []), this.settings.stripTrackingParams);

      closedWin = {
        ...this.activeWindows[uuid],
        tabs: finalTabs,
        isClosed: true,
        closedAt: Date.now()
      };

      if (closedWin.tabs.length > 0) {
        this.closedWindows[uuid] = closedWin;
      }
      delete this.activeWindows[uuid];
    }

    this.windowIdToUuid.delete(windowId);
    if (uuid) {
      this.uuidToWindowId.delete(uuid);
      this.lastKnownTabs.delete(uuid);
    }
    await this.persistWindowIdMappings();

    // The session backup contains the final tracked live window only, never old archive entries.
    const hasRemainingRegularWindow = Array.isArray(remainingLiveWindows) &&
      remainingLiveWindows.some(win => win && !win.incognito && win.type !== "devtools");
    if (!hasRemainingRegularWindow) {
      await this.onLastWindowClose(closedWin);
    } else {
      this.pruneClosedWindows();
      await this.persist();
    }
  }

  /**
   * Captures rolling backup when the last window is closing.
   */
  async onLastWindowClose(lastWindow = null) {
    const allWindows = lastWindow?.tabs?.length
      ? [{ ...lastWindow, isClosed: false }]
      : [];

    const totalTabs = allWindows.reduce((acc, w) => acc + (w.tabs ? w.tabs.length : 0), 0);

    this.previousSessionBackup = {
      timestamp: Date.now(),
      triggerReason: "last_window_close",
      totalWindows: allWindows.length,
      totalTabs,
      windows: allWindows
    };

    this.activeWindows = {};
    this.pruneClosedWindows();
    await this.persist();
  }

  /**
   * Keeps the newest closed windows within the total archive retention limit.
   * Pinned templates count toward the same limit.
   */
  pruneClosedWindows() {
    const configuredLimit = Number(this.settings.maxClosedWindowsRetention);
    const maxLimit = Math.max(1, Math.min(
      THRESHOLDS.MAX_CLOSED_WINDOWS_RETENTION,
      Number.isFinite(configuredLimit) && configuredLimit > 0
        ? Math.floor(configuredLimit)
        : THRESHOLDS.MAX_CLOSED_WINDOWS_RETENTION
    ));
    for (const windowData of Object.values(this.closedWindows)) {
      windowData.tabs = dedupeTabsByUrl(windowData.tabs || [], this.settings.stripTrackingParams);
    }

    const newestFirst = Object.entries(this.closedWindows).sort((a, b) => {
      const timeA = Number(a[1].closedAt || a[1].lastUpdated || 0);
      const timeB = Number(b[1].closedAt || b[1].lastUpdated || 0);
      return timeB - timeA;
    });

    const uniqueNewestFirst = [];
    const duplicateBySignature = new Map();
    for (const [uuid, windowData] of newestFirst) {
      const tabs = windowData.tabs || [];
      const signature = tabs.length === 0 ? null : JSON.stringify({
        name: String(windowData.customName || "").trim().toLowerCase(),
        tabs: tabs.map(tab => [
          normalizeUrl(tab.url, this.settings.stripTrackingParams),
          tab.group ? getTabGroupKey(tab.group) : "",
          Boolean(tab.pinned)
        ])
      });
      const existing = signature ? duplicateBySignature.get(signature) : null;
      if (existing) {
        existing[1].isPinnedTemplate = Boolean(existing[1].isPinnedTemplate || windowData.isPinnedTemplate);
        continue;
      }
      uniqueNewestFirst.push([uuid, windowData]);
      if (signature) duplicateBySignature.set(signature, [uuid, windowData]);
    }

    this.closedWindows = Object.fromEntries(uniqueNewestFirst.slice(0, maxLimit));
    for (const [uuid] of uniqueNewestFirst.slice(maxLimit)) {
      delete this.closedWindows[uuid];
    }

    // Bound the fallback tab cache to currently active windows plus retained archives.
    const retainedUuids = new Set([
      ...Object.keys(this.activeWindows),
      ...Object.keys(this.closedWindows)
    ]);
    for (const uuid of this.lastKnownTabs.keys()) {
      if (!retainedUuids.has(uuid)) this.lastKnownTabs.delete(uuid);
    }
  }

  /**
   * Renames a window by UUID.
   * @param {string} uuid
   * @param {string} newName
   * @returns {Promise<boolean>}
   */
  async renameWindow(uuid, newName) {
    await this.ensureInitialized();
    const trimmed = (newName || "").trim();
    if (this.activeWindows[uuid]) {
      this.activeWindows[uuid].customName = trimmed || undefined;
      await this.persist();
      return true;
    }
    if (this.closedWindows[uuid]) {
      this.closedWindows[uuid].customName = trimmed || undefined;
      await this.persist();
      return true;
    }
    return false;
  }

  /**
   * Deletes a closed window from the archive.
   * (Active windows cannot be deleted here to avoid Re-sync Loop).
   * @param {string} uuid
   * @returns {Promise<boolean>}
   */
  async deleteClosedWindow(uuid) {
    await this.ensureInitialized();
    if (this.closedWindows[uuid]) {
      delete this.closedWindows[uuid];
      if (!this.activeWindows[uuid]) this.lastKnownTabs.delete(uuid);
      await this.persist();
      return true;
    }
    return false;
  }

  /**
   * Deletes a specific tab from a closed window archive.
   * @param {string} uuid
   * @param {number} tabIndex
   * @returns {Promise<boolean>}
   */
  async deleteClosedTab(uuid, tabIndex) {
    await this.ensureInitialized();
    const win = this.closedWindows[uuid];
    if (!win || !win.tabs || tabIndex < 0 || tabIndex >= win.tabs.length) {
      return false;
    }

    win.tabs.splice(tabIndex, 1);
    // Re-index remaining tabs and keep the fallback cache consistent with the edited archive.
    win.tabs.forEach((tab, i) => {
      tab.index = i;
    });
    if (win.tabs.length > 0) this.lastKnownTabs.set(uuid, win.tabs.map(tab => ({ ...tab })));
    else this.lastKnownTabs.delete(uuid);

    if (win.tabs.length === 0 && !win.isPinnedTemplate) {
      delete this.closedWindows[uuid];
    }

    await this.persist();
    return true;
  }

  /**
   * Toggles pinned template status for a closed window.
   * @param {string} uuid
   * @returns {Promise<boolean>}
   */
  async togglePinTemplate(uuid) {
    await this.ensureInitialized();
    const win = this.closedWindows[uuid] || this.activeWindows[uuid];
    if (!win) return false;

    win.isPinnedTemplate = !win.isPinnedTemplate;
    await this.persist();
    return true;
  }

  /**
   * Triggers a manual snapshot checkpoint backup.
   * @returns {Promise<import("../shared/types.js").PreviousSessionBackup>}
   */
  async triggerManualBackup() {
    await this.ensureInitialized();
    // Snapshot by value so later edits to live window objects cannot mutate the backup.
    const allWindows = Object.values(this.activeWindows).map(win => ({
      ...win,
      tabs: (win.tabs || []).map(tab => ({
        ...tab,
        ...(tab.group ? { group: { ...tab.group } } : {})
      }))
    }));

    const totalTabs = allWindows.reduce((acc, w) => acc + (w.tabs ? w.tabs.length : 0), 0);

    this.previousSessionBackup = {
      timestamp: Date.now(),
      triggerReason: "manual_checkpoint",
      totalWindows: allWindows.length,
      totalTabs,
      windows: allWindows
    };

    await this.persist();
    return this.previousSessionBackup;
  }

  /**
   * Updates settings.
   * @param {Partial<import("../shared/types.js").ExtensionSettings>} newSettings
   */
  async updateSettings(newSettings) {
    await this.ensureInitialized();
    this.settings = normalizeSettings({ ...this.settings, ...newSettings });
    this.pruneClosedWindows();
    await this.persist();
  }

  /**
   * Exports full state or markdown list.
   * @param {"json" | "markdown"} format
   * @returns {string}
   */
  exportData(format) {
    if (format === "json") {
      return JSON.stringify(this.getFullSchema(), null, 2);
    }

    // Markdown format
    const lines = [`# SyncTab Export — ${new Date().toLocaleString()}`, ""];
    const exportWindows = (title, wins) => {
      lines.push(`## ${title}`);
      for (const win of Object.values(wins)) {
        const name = win.customName || `Window (${win.windowUuid.slice(0, 8)})`;
        lines.push(`### ${name} (${win.tabs.length} tabs)`);
        for (const tab of win.tabs) {
          lines.push(`- [${tab.title || "Untitled"}](${tab.url})`);
        }
        lines.push("");
      }
    };

    exportWindows("Active Windows", this.activeWindows);
    exportWindows("Closed Windows Archive", this.closedWindows);
    return lines.join("\n");
  }

  /**
   * Imports JSON data into storage.
   * @param {string} jsonString
   * @returns {Promise<boolean>}
   */
  async importData(jsonString) {
    await this.ensureInitialized();
    if (typeof jsonString !== "string" || jsonString.length > 10 * 1024 * 1024) return false;

    // Import is transactional in memory as well as in storage. If validation or
    // persistence fails, keep the previous usable state intact.
    const previous = {
      settings: this.settings,
      closedWindows: this.closedWindows,
      recoveryCheckpoints: this.recoveryCheckpoints,
      recoveryAlert: this.recoveryAlert,
      lastKnownTabs: new Map(this.lastKnownTabs)
    };
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;

      const supportedKeys = ["activeWindows", "closedWindows", "previousSessionBackup", "recoveryCheckpoints", "recoveryAlert", "settings"];
      if (!supportedKeys.some(key => Object.hasOwn(parsed, key))) return false;

      if (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) {
        this.settings = normalizeSettings({ ...this.settings, ...parsed.settings });
      }

      // Imported snapshots must never overwrite the live browser mirror. Treat all
      // imported windows (including exported active windows and rolling-backup windows)
      // as recoverable archive entries so the user can restore them explicitly.
      const importedWindows = {};
      const importWindow = (win, fallbackUuid) => {
        if (!win || typeof win !== "object" || Array.isArray(win) || !Array.isArray(win.tabs)) return;
        const sourceUuid = typeof win.windowUuid === "string" && win.windowUuid
          ? win.windowUuid
          : (typeof fallbackUuid === "string" && fallbackUuid ? fallbackUuid : crypto.randomUUID());
        const uuid = this.activeWindows[sourceUuid] ? crypto.randomUUID() : sourceUuid;
        const tabs = dedupeTabsByUrl(
          win.tabs.filter(tab => tab && typeof tab.url === "string" && !isIgnoredUrl(tab.url)),
          this.settings.stripTrackingParams
        );
        if (tabs.length === 0) return;
        importedWindows[uuid] = {
          ...win,
          windowUuid: uuid,
          isClosed: true,
          closedAt: Number(win.closedAt || win.lastUpdated) || Date.now(),
          tabs
        };
      };

      if (parsed.closedWindows && typeof parsed.closedWindows === "object" && !Array.isArray(parsed.closedWindows)) {
        for (const [uuid, win] of Object.entries(parsed.closedWindows)) importWindow(win, uuid);
      }
      if (parsed.activeWindows && typeof parsed.activeWindows === "object" && !Array.isArray(parsed.activeWindows)) {
        for (const [uuid, win] of Object.entries(parsed.activeWindows)) importWindow(win, uuid);
      }
      if (Array.isArray(parsed.previousSessionBackup?.windows)) {
        for (const win of parsed.previousSessionBackup.windows) importWindow(win, win?.windowUuid);
      }
      this.closedWindows = { ...this.closedWindows, ...importedWindows };

      if (Array.isArray(parsed.recoveryCheckpoints)) {
        this.recoveryCheckpoints = parsed.recoveryCheckpoints
          .filter(checkpoint => checkpoint && typeof checkpoint === "object" && Array.isArray(checkpoint.windows))
          .slice(0, THRESHOLDS.MAX_RECOVERY_CHECKPOINTS);
      }
      if (Object.hasOwn(parsed, "recoveryAlert")) {
        this.recoveryAlert = parsed.recoveryAlert && typeof parsed.recoveryAlert === "object"
          ? parsed.recoveryAlert
          : null;
      }

      this.pruneClosedWindows();
      await this.persist();
      return true;
    } catch {
      this.settings = previous.settings;
      this.closedWindows = previous.closedWindows;
      this.recoveryCheckpoints = previous.recoveryCheckpoints;
      this.recoveryAlert = previous.recoveryAlert;
      this.lastKnownTabs = previous.lastKnownTabs;
      return false;
    }
  }

  /**
   * Returns current full schema.
   * @returns {import("../shared/types.js").SyncedStorageSchema}
   */
  getFullSchema() {
    return {
      version: STORAGE_VERSION,
      activeWindows: this.activeWindows,
      closedWindows: this.closedWindows,
      previousSessionBackup: this.previousSessionBackup,
      recoveryCheckpoints: this.recoveryCheckpoints,
      recoveryAlert: this.recoveryAlert,
      skipNextRecoveryLossCheck: this.skipNextRecoveryLossCheck,
      settings: this.settings
    };
  }

  /**
   * Persists current state through the storage adapter.
   */
  async persist() {
    // Serialize writes: overlapping browser events must not let an older save finish last.
    const save = this.persistQueue.catch(() => {}).then(() => this.storage.save(this.getFullSchema()));
    this.persistQueue = save;
    await save;
  }
}
