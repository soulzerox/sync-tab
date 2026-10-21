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
  /**
   * รอ commit จริง (title ถูกตั้ง / status complete) สูงสุดกี่ ms ก่อน discard:
   * - changeInfo.url / {status:"loading"} มาก่อนเสมอ — นับผิด = discard ยกเลิกโหลดกลางทาง = แท็บว่าง/Untitled
   * - หน้าช้าไม่ตั้ง title ภายในนี้ → fallback discard (ยอมเสี่ยงบางหน้า)
   * (timeout นี้เป็น fallback — ได้ event ก่อนแล้วคืนทันที)
   * v3.4 — 350 → 1000 → 3000 (ประสบการณ์: หน้า Cloudflare/หนัก > 1s ยังไม่มี title = Untitled)
   * (จำกัดที่ 3000 — flow sequential ต่อแท็บ, 20 แท็บ × 5s จะกด popup ค้างนาน)
   */
  RESTORE_COMMIT_MS: 3000,
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
 * v3.1 — ตัด query-param ที่เปลี่ยนทุกเที่ยว/ทำหน้าซ้ำออกก่อนจับคู่ record:
 * `__cf_chl*` (Cloudflare challenge token ต่างกันทุกเซสชัน), `utm_*`, และ click-ids ทั่วไป
 * หน้าเดียวกันแต่ token ต่างกันจะถือเป็น normalized URL เดียวกัน (จบปัญหา record ซ้ำ)
 * (คง signature normalizeUrl(url, false) ไว้เหมือนเดิม)
 */
export const TRACKING_PARAM_PREFIXES = Object.freeze([
  "__cf_chl",
  "utm_",
  "fbclid",
  "gclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_eid",
  "yclid"
]);

/**
 * v3.5 — query-param ที่เป็นสถานะภายในหน้า (SPA) ไม่ใช่ตัวระบุเอกสาร:
 * `draftId` (OpenCode draft), `tab` (แท็บย่อยในหน้าเดียวกัน) → หน้าเดียวกันถือ key เดียว
 * ยังแยก session id ใน path ออกตามเดิม (คนละบทสนทนาจริง ๆ)
 */
export const VOLATILE_PARAM_NAMES = Object.freeze(["draftId", "tab"]);

/** ทิศทางธีม popup (บันทึกใน schema.themepreference) */
export const THEME_PREFERENCES = Object.freeze(["dark", "light", "auto"]);
