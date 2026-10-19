import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StorageAdapter } from "../background/storage/storage-adapter.js";
import { LocalAdapter } from "../background/storage/local-adapter.js";
import { NativeAdapter } from "../background/storage/native-adapter.js";

describe("Phase 3: Storage Adapters Suite", () => {
  test("StorageAdapter base class throws if methods are not implemented", async () => {
    const base = new StorageAdapter();
    await assert.rejects(async () => await base.save(/** @type {any} */ ({})), /must be implemented/);
    await assert.rejects(async () => await base.loadAll(), /must be implemented/);
    await assert.rejects(async () => await base.checkHealth(), /must be implemented/);
  });

  test("LocalAdapter graceful fallback in Node environment", async () => {
    const local = new LocalAdapter();
    const health = await local.checkHealth();
    assert.equal(health.connected, true);
    assert.ok(health.driver.startsWith("chrome_storage"));
  });

  test("NativeAdapter falls back to LocalAdapter when native messaging host is absent", async () => {
    const local = new LocalAdapter();
    const native = new NativeAdapter(local);

    // Testing without Chrome environment
    const health = await native.checkHealth();
    assert.equal(health.connected, false);
    assert.equal(health.driver, "chrome_storage");
    assert.ok(health.error);
  });

  test("NativeAdapter properly handles save and load fallback without crashing", async () => {
    const local = new LocalAdapter();
    const native = new NativeAdapter(local);

    const testSchema = /** @type {any} */ ({
      version: "2.2.0",
      activeWindows: {},
      closedWindows: {},
      settings: { storageDriver: "auto" }
    });

    // Save and load should not throw
    await assert.doesNotReject(async () => await native.save(testSchema));
    const loaded = await native.loadAll();
    assert.equal(loaded, null); // Null in mock environment
  });
});
