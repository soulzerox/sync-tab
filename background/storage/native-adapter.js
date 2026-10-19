/**
 * Native SQLite Storage Adapter
 * Communicates with Python Native Messaging Host over Stdio to persist to SQLite on Ubuntu Linux.
 * Includes automatic fallback to LocalAdapter if the Native Host is disconnected.
 */

import { StorageAdapter } from "./storage-adapter.js";
import { LocalAdapter } from "./local-adapter.js";
import { DEFAULT_SETTINGS, NATIVE_MESSAGING, STORAGE_VERSION } from "../../shared/constants.js";

function windowRevision(win) {
  return Math.max(Number(win?.lastUpdated) || 0, Number(win?.closedAt) || 0);
}

function windowSignature(win) {
  return JSON.stringify({
    customName: win?.customName || "",
    isClosed: Boolean(win?.isClosed),
    isPinnedTemplate: Boolean(win?.isPinnedTemplate),
    closedAt: Number(win?.closedAt) || 0,
    lastUpdated: Number(win?.lastUpdated) || 0,
    tabs: (Array.isArray(win?.tabs) ? win.tabs : []).map(tab => [
      tab?.url || "",
      tab?.title || "Untitled",
      tab?.favIconUrl || "",
      Boolean(tab?.pinned),
      Number.isInteger(tab?.index) ? tab.index : 0,
      tab?.group ? [
        tab.group.title || "",
        tab.group.color || "grey",
        Boolean(tab.group.collapsed)
      ] : null
    ])
  });
}

function mergeWindowState(nativeData, localState) {
  const chosen = new Map();
  const addWindows = (windows, source) => {
    for (const [uuid, win] of Object.entries(windows || {})) {
      const prior = chosen.get(uuid);
      if (!prior || windowRevision(win) >= windowRevision(prior.win)) {
        chosen.set(uuid, { win, source });
      }
    }
  };

  addWindows(nativeData?.activeWindows, "native");
  addWindows(nativeData?.closedWindows, "native");
  // Local mirror is written before native SQLite. On timestamp ties it wins, while
  // a demonstrably newer native revision still wins over a stale local copy.
  addWindows(localState?.activeWindows, "local");
  addWindows(localState?.closedWindows, "local");

  const activeWindows = {};
  const closedWindows = {};
  for (const [uuid, entry] of chosen) {
    const win = { ...entry.win, windowUuid: entry.win.windowUuid || uuid };
    if (win.isClosed) closedWindows[uuid] = win;
    else activeWindows[uuid] = win;
  }

  const previousSessionBackup = localState && Object.hasOwn(localState, "previousSessionBackup")
    ? localState.previousSessionBackup
    : (nativeData?.previousSessionBackup ?? null);

  const merged = {
    ...nativeData,
    version: STORAGE_VERSION,
    activeWindows,
    closedWindows,
    previousSessionBackup,
    settings: localState?.settings || nativeData?.settings || { ...DEFAULT_SETTINGS },
    recoveryCheckpoints: localState?.recoveryCheckpoints || [],
    recoveryAlert: localState?.recoveryAlert || null,
    skipNextRecoveryLossCheck: Boolean(localState?.skipNextRecoveryLossCheck)
  };

  const nativeSignatures = new Map();
  for (const [uuid, win] of Object.entries(nativeData?.activeWindows || {})) nativeSignatures.set(uuid, windowSignature(win));
  for (const [uuid, win] of Object.entries(nativeData?.closedWindows || {})) nativeSignatures.set(uuid, windowSignature(win));
  const mergedSignatures = new Map();
  for (const [uuid, win] of Object.entries(activeWindows)) mergedSignatures.set(uuid, windowSignature(win));
  for (const [uuid, win] of Object.entries(closedWindows)) mergedSignatures.set(uuid, windowSignature(win));
  const needsNativeRepair = nativeSignatures.size !== mergedSignatures.size ||
    Array.from(mergedSignatures).some(([uuid, signature]) => nativeSignatures.get(uuid) !== signature);

  return { merged, needsNativeRepair };
}

export class NativeAdapter extends StorageAdapter {
  /**
   * @param {LocalAdapter} [fallbackAdapter]
   */
  constructor(fallbackAdapter = new LocalAdapter()) {
    super();
    this.fallback = fallbackAdapter;
    this.hostName = NATIVE_MESSAGING.HOST_NAME;
    this.isConnected = false;
    this.lastDbPath = NATIVE_MESSAGING.DEFAULT_DB_PATH;
    this.lastDbSize = 0;
    this.lastNativePayloadFingerprint = null;
  }

  /**
   * Sends a native JSON message to Python host with Promise wrapper.
   * @param {any} message
   * @returns {Promise<any>}
   */
  async sendNativeMessage(message) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendNativeMessage) {
      return { success: false, error: "Native messaging API unavailable in this environment" };
    }

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(this.hostName, message, (response) => {
          if (chrome.runtime.lastError) {
            this.isConnected = false;
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else if (!response || typeof response !== "object") {
            this.isConnected = false;
            // A missing native response is not a successful operation; treating it
            // as success can suppress retries and leave SQLite stale.
            resolve({ success: false, error: "Native host returned no response" });
          } else {
            this.isConnected = true;
            resolve(response);
          }
        });
      } catch (err) {
        this.isConnected = false;
        resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /**
   * Saves schema to Native SQLite and falls back to local storage.
   * @param {import("../../shared/types.js").SyncedStorageSchema} schema
   */
  async save(schema) {
    // Always mirror to local storage for fast in-memory hydration
    await this.fallback.save(schema);

    // If native driver is enabled/active, dispatch to SQLite host
    if (schema.settings?.storageDriver !== "chrome_storage") {
      // Recovery snapshots live in the extension's local mirror to keep the
      // Native Messaging payload bounded; loadAll merges these fields back.
      const {
        recoveryCheckpoints,
        recoveryAlert,
        skipNextRecoveryLossCheck,
        settings,
        ...nativeSchema
      } = schema;
      // Settings and recovery metadata live in chrome.storage.local; the SQLite schema
      // does not persist them. Avoid rewriting every SQLite row for checkpoint-only changes.
      const fingerprint = JSON.stringify(nativeSchema);
      if (this.isConnected && fingerprint === this.lastNativePayloadFingerprint) return;

      const response = await this.sendNativeMessage({
        action: "SAVE_STATE",
        payload: nativeSchema
      });

      if (response && response.success) {
        this.isConnected = true;
        this.lastNativePayloadFingerprint = fingerprint;
        this.lastDbPath = response.dbPath || this.lastDbPath;
        this.lastDbSize = response.dbSize || this.lastDbSize;
      } else {
        this.isConnected = false;
      }
    }
  }

  /**
   * Loads state from Native SQLite or falls back to local storage.
   * @returns {Promise<import("../../shared/types.js").SyncedStorageSchema | null>}
   */
  async loadAll() {
    const localState = await this.fallback.loadAll();

    // The local driver is an explicit setting, not a fallback condition.
    if (localState?.settings?.storageDriver === "chrome_storage") {
      this.isConnected = false;
      return localState;
    }

    const nativeResponse = await this.sendNativeMessage({ action: "LOAD_STATE" });
    if (nativeResponse && nativeResponse.success && nativeResponse.data && typeof nativeResponse.data === "object") {
      this.isConnected = true;
      this.lastDbPath = nativeResponse.dbPath || this.lastDbPath;
      this.lastDbSize = nativeResponse.dbSize || this.lastDbSize;

      const nativeData = nativeResponse.data;
      const nativeHasState = Object.keys(nativeData.activeWindows || {}).length > 0 ||
        Object.keys(nativeData.closedWindows || {}).length > 0 ||
        Boolean(nativeData.previousSessionBackup);
      const localHasState = Boolean(localState) && (
        Object.keys(localState.activeWindows || {}).length > 0 ||
        Object.keys(localState.closedWindows || {}).length > 0 ||
        Boolean(localState.previousSessionBackup) ||
        (Array.isArray(localState.recoveryCheckpoints) && localState.recoveryCheckpoints.length > 0)
      );

      // First connection or a wiped native DB must not erase a populated local mirror.
      if (!nativeHasState && localHasState) {
        await this.save(localState);
        return localState;
      }

      const { merged, needsNativeRepair } = mergeWindowState(nativeData, localState);
      if (needsNativeRepair) {
        // Reconcile partial native failures without discarding either source's windows.
        // The local mirror is updated first; a failed SQLite repair remains recoverable.
        await this.save(merged);
      }
      return merged;
    }

    // Native host unavailable/corrupt: use the local mirror without replacing it with an empty schema.
    this.isConnected = false;
    return localState;
  }

  /**
   * Checks the health and connection status of Native SQLite.
   * @returns {Promise<{ connected: boolean, driver: string, path: string, dbSize: number, error?: string }>}
   */
  async checkHealth() {
    const localState = await this.fallback.loadAll();
    if (localState?.settings?.storageDriver === "chrome_storage") {
      this.isConnected = false;
      const localHealth = await this.fallback.checkHealth();
      return { ...localHealth, connected: true, driver: "chrome_storage" };
    }

    const res = await this.sendNativeMessage({ action: "PING" });
    if (res && res.success) {
      this.isConnected = true;
      this.lastDbPath = res.dbPath || this.lastDbPath;
      this.lastDbSize = res.dbSize || this.lastDbSize;

      return {
        connected: true,
        driver: "sqlite_native",
        path: this.lastDbPath,
        dbSize: this.lastDbSize
      };
    }

    // Fallback info
    const localHealth = await this.fallback.checkHealth();
    return {
      connected: false,
      driver: "chrome_storage",
      path: localHealth.path,
      dbSize: localHealth.dbSize,
      error: res?.error || "Native Host not connected"
    };
  }
}
