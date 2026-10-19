import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  STORAGE_VERSION,
  TIMINGS,
  THRESHOLDS,
  CHROMIUM_TAB_GROUP_COLORS,
  DEFAULT_SETTINGS,
  IGNORED_URL_PREFIXES
} from "../shared/constants.js";
import { MESSAGE_TYPES } from "../shared/messages.js";

describe("Phase 1: Foundation & Contracts Test Suite", () => {
  test("Constants have correct types and values according to SOT", () => {
    assert.equal(STORAGE_VERSION, "2.3.0");
    assert.equal(TIMINGS.HOT_DEBOUNCE_MS, 400);
    assert.equal(TIMINGS.CLOSE_FLUSH_MS, 0);
    assert.equal(TIMINGS.RESTORE_SETTLE_MS, 600);
    assert.equal(TIMINGS.MICRO_CHUNK_DELAY_MS, 200);
    assert.equal(THRESHOLDS.MICRO_CHUNK_SIZE, 1);
    assert.equal(THRESHOLDS.MAX_TITLE_LENGTH, 500);
    assert.equal(THRESHOLDS.MAX_CLOSED_WINDOWS_RETENTION, 5);
    assert.equal(THRESHOLDS.MAX_RECOVERY_CHECKPOINTS, 5);
    assert.equal(THRESHOLDS.SUSPECTED_TAB_LOSS_MINIMUM, 5);
    assert.equal(THRESHOLDS.SUSPECTED_TAB_LOSS_FRACTION, 0.5);
    assert.equal(CHROMIUM_TAB_GROUP_COLORS.length, 9);
    assert.ok(CHROMIUM_TAB_GROUP_COLORS.includes("blue"));
    assert.ok(CHROMIUM_TAB_GROUP_COLORS.includes("grey"));
  });

  test("Default settings match requirements", () => {
    assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "autoSync"), false);
    assert.equal(DEFAULT_SETTINGS.lazyRestore, true);
    assert.equal(DEFAULT_SETTINGS.storageDriver, "auto");
    assert.equal(DEFAULT_SETTINGS.maxClosedWindowsRetention, 5);
    assert.equal(DEFAULT_SETTINGS.stripTrackingParams, true);
  });

  test("Ignored URL prefixes include privileged and internal schemes", () => {
    assert.ok(IGNORED_URL_PREFIXES.includes("edge://"));
    assert.ok(IGNORED_URL_PREFIXES.includes("chrome://"));
    assert.ok(IGNORED_URL_PREFIXES.includes("devtools://"));
    assert.ok(IGNORED_URL_PREFIXES.includes("about:blank"));
  });

  test("Message Types are frozen and contain all required RPC actions", () => {
    assert.ok(Object.isFrozen(MESSAGE_TYPES));
    assert.equal(MESSAGE_TYPES.GET_STATE, "GET_STATE");
    assert.equal(MESSAGE_TYPES.SYNC_WINDOW_TO_ACTIVE, "SYNC_WINDOW_TO_ACTIVE");
    assert.equal(MESSAGE_TYPES.DELETE_CLOSED_WINDOW, "DELETE_CLOSED_WINDOW");
    assert.equal(MESSAGE_TYPES.DELETE_CLOSED_TAB, "DELETE_CLOSED_TAB");
    assert.equal(MESSAGE_TYPES.RENAME_WINDOW, "RENAME_WINDOW");
    assert.equal(MESSAGE_TYPES.TOGGLE_PIN_TEMPLATE, "TOGGLE_PIN_TEMPLATE");
    assert.equal(MESSAGE_TYPES.TEST_NATIVE_CONNECTION, "TEST_NATIVE_CONNECTION");
    assert.equal(MESSAGE_TYPES.TRIGGER_MANUAL_BACKUP, "TRIGGER_MANUAL_BACKUP");
    assert.equal(MESSAGE_TYPES.RESTORE_RECOVERY_CHECKPOINT, "RESTORE_RECOVERY_CHECKPOINT");
    assert.equal(MESSAGE_TYPES.ACKNOWLEDGE_RECOVERY_ALERT, "ACKNOWLEDGE_RECOVERY_ALERT");
  });

  test("manifest.json is valid Manifest V3 with minimal permissions", () => {
    const manifestPath = path.join(process.cwd(), "manifest.json");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, "2.3.0");
    assert.ok(manifest.permissions.includes("tabs"));
    assert.ok(manifest.permissions.includes("tabGroups"));
    assert.ok(manifest.permissions.includes("storage"));
    assert.ok(manifest.permissions.includes("unlimitedStorage"));
    assert.ok(manifest.permissions.includes("nativeMessaging"));
    assert.ok(!manifest.permissions.includes("<all_urls>"), "Must not request broad <all_urls> permission");
    assert.equal(manifest.background.type, "module");
    assert.ok(manifest.key, "Deterministic key must be present");
  });
});
