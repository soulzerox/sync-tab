/**
 * Chrome Local Storage Adapter
 * Implements StorageAdapter using chrome.storage.local.
 */

import { StorageAdapter } from "./storage-adapter.js";
import { STORAGE_VERSION } from "../../shared/constants.js";

const STORAGE_KEY = "synced_tabs_state_v2";

export class LocalAdapter extends StorageAdapter {
  constructor() {
    super();
  }

  /**
   * @param {import("../../shared/types.js").SyncedStorageSchema} schema
   */
  async save(schema) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: schema });
    }
  }

  /**
   * @returns {Promise<import("../../shared/types.js").SyncedStorageSchema | null>}
   */
  async loadAll() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || null;
    }
    return null;
  }

  /**
   * @returns {Promise<{ connected: boolean, driver: string, path: string, dbSize: number }>}
   */
  async checkHealth() {
    let bytesInUse = 0;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      if (chrome.storage.local.getBytesInUse) {
        bytesInUse = await chrome.storage.local.getBytesInUse(STORAGE_KEY);
      }
      return {
        connected: true,
        driver: "chrome_storage",
        path: "chrome.storage.local",
        dbSize: bytesInUse
      };
    }

    return {
      connected: true,
      driver: "chrome_storage_mock",
      path: "memory",
      dbSize: 0
    };
  }
}
