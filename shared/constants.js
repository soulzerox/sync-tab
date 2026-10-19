/**
 * Global Constants & Configuration — SyncTab Group Sync (v3)
 * Target: Microsoft Edge on Ubuntu Linux OS (Manifest V3)
 * Specification: SOT v3.0.0 (Group-Only Sync)
 */

/** Key ของคลังเดียวใน chrome.storage.local (SOT §2.1) */
export const STORAGE_KEY = "groupsSync";

/** เวอร์ชัน schema ปัจจุบัน (ใช้ตรวจ migration จาก v2 -> v3) */
export const SCHEMA_VERSION = 3;

/** Keys ของระบบ v2 ที่จะถูกล้างตอน migration (SOT §8) */
export const LEGACY_STORAGE_KEYS = Object.freeze([
  "activeWindows",
  "closedWindows",
  "previousSessionBackup",
  "recoveryCheckpoints",
  "recoveryAlert",
  "skipNextRecoveryLossCheck",
  "settings"
]);

export const TIMINGS = {
  /** เว้นจังหวะระหว่างแท็บที่ restore (create → group → setColor → discard) */
  STAGGER_MS: 120,
  /** batch เขียน chrome.storage.local ต่อ event burst */
  SAVE_BATCH_MS: 80
};

export const THRESHOLDS = {
  MAX_TITLE_LENGTH: 500
};

/** @type {readonly import("./types.js").GroupColor[]} */
export const CHROMIUM_GROUP_COLORS = Object.freeze([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

export const DEFAULT_GROUP_COLOR = "grey";

/** Prefixes ที่ไม่มีสิทธิ์เข้าคลัง (SOT L1 — ผ่าน url-sanitizer.isIgnoredUrl) */
export const IGNORED_URL_PREFIXES = Object.freeze([
  "edge://",
  "chrome://",
  "chrome-extension://",
  "devtools://",
  "about:blank",
  "view-source:",
  "javascript:",
  "data:",
  "blob:"
]);

/**
 * v3 ไม่ตัด tracking params เป็น feature (ระบบเก่าถอด setting นี้)
 * แต่คง export ไว้เพื่อให้ normalizeUrl(url, false) ยังประพฤติเหมือนเดิม
 */
export const TRACKING_PARAM_PREFIXES = Object.freeze([]);

/** ทิศทางธีม popup (บันทึกใน schema.themepreference) */
export const THEME_PREFERENCES = Object.freeze(["dark", "light", "auto"]);
