/**
 * Pure helpers สำหรับ popup (render ด้าน view) — เทสด้วย node ได้ (SOT §9 T12)
 * ไม่แตะ chrome API — รับ state และคืนโครงข้อมูล view
 */

import { THEME_VALUES } from "./messages.js";

/**
 * เรียงการ์ดล่าสุดก่อน (updatedAt) — Mockup: "sort by recent activity"
 * @returns {Array<{name: string, record: object}>}
 */
export function sortGroupCards(groups, now = Date.now()) {
  return Object.entries(groups ?? {})
    .map(([name, record]) => ({ name, record }))
    .sort((a, b) => (b.record?.updatedAt ?? 0) - (a.record?.updatedAt ?? 0) || a.name.localeCompare(b.name));
}

/**
 * กรองการ์ดด้วย substring (เคสไม่สน): ชื่อกลุ่ม / title แท็บ / URL
 * @param {string} query
 */
export function filterGroupCards(groups, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return sortGroupCards(groups);
  return sortGroupCards(groups).filter(card => {
    if (card.name.toLowerCase().includes(q)) return true;
    return Object.values(card.record.tabs ?? {}).some(
      t => (t.title ?? "").toLowerCase().includes(q) || (t.url ?? "").toLowerCase().includes(q)
    );
  });
}

/** แบ่งแท็บของกลุ่มเป็น ตื่น/หลับ ตาม liveCount (ตื่น = liveCount > 0) */
export function splitTabsByState(record) {
  const live = [];
  const idle = [];
  for (const tab of Object.values(record?.tabs ?? {})) {
    (tab.liveCount > 0 ? live : idle).push(tab);
  }
  live.sort((a, b) => a.order - b.order);
  idle.sort((a, b) => a.order - b.order);
  return { live, idle };
}

/** สถิติ header (pills): N กลุ่ม / N แท็บ / N ตื่น */
export function buildStats(groups) {
  let tabs = 0;
  let awake = 0;
  let liveGroups = 0;
  const cards = sortGroupCards(groups);
  for (const [name, record] of Object.entries(groups ?? {})) {
    tabs += Object.keys(record.tabs ?? {}).length;
    awake += Object.values(record.tabs ?? {}).filter(t => t.liveCount > 0).length;
    if ((record.liveWindowIds ?? []).length > 0) liveGroups += 1;
  }
  return { groups: cards.length, tabs, awake, liveGroups };
}

/** "ซิงก์ล่าสุด X ก่อน" — รูปแบบอ่านง่ายภาษาไทย */
export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return "เมื่อสักครู่";
  if (seconds < 60) return `${seconds} วินาทีก่อน`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} นาทีก่อน`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ชั่วโมงก่อน`;
  return `${Math.floor(hours / 24)} วันก่อน`;
}

/** ธีมจริงที่ใช้ render: auto → ตาม prefers-color-scheme */
export function resolveTheme(storePreference, prefersDark = true) {
  if (storePreference === THEME_VALUES.DARK) return "dark";
  if (storePreference === THEME_VALUES.LIGHT) return "light";
  return prefersDark ? "dark" : "light";
}

/** ข้อความ confirm ลบกลุ่ม (SOT §7) */
export function groupDeleteConfirmMessage(name, tabsCount, isLive) {
  const base = `ลบ ${tabsCount} แท็บที่จำไว้ของกลุ่ม "${name}" ออกจากคลัง (แท็บจริงบนเบราว์เซอร์ไม่ถูกแตะ)`;
  if (!isLive) return base;
  return `${base}\n⚠ กลุ่มนี้ยังเปิดอยู่บนเบราว์เซอร์ — ข้อมูลจะถูก mirror กลับเข้ามาทันทีที่มีการเปลี่ยนแปลงแท็บในกลุ่ม`;
}
