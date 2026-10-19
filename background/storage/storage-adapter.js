/**
 * Storage Adapter Interface (Seam Architecture)
 * Defines the contract for all storage drivers (Local Chrome Storage vs Native SQLite).
 */

export class StorageAdapter {
  /**
   * Saves the entire SyncedStorageSchema to persistent storage.
   * @param {import("../../shared/types.js").SyncedStorageSchema} schema
   * @returns {Promise<void>}
   */
  async save(schema) {
    throw new Error("StorageAdapter.save() must be implemented by subclass");
  }

  /**
   * Loads the full SyncedStorageSchema from persistent storage.
   * @returns {Promise<import("../../shared/types.js").SyncedStorageSchema | null>}
   */
  async loadAll() {
    throw new Error("StorageAdapter.loadAll() must be implemented by subclass");
  }

  /**
   * Checks the health and connection status of the storage backend.
   * @returns {Promise<{ connected: boolean, driver: string, path: string, dbSize: number, error?: string }>}
   */
  async checkHealth() {
    throw new Error("StorageAdapter.checkHealth() must be implemented by subclass");
  }
}
