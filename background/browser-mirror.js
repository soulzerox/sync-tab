/**
 * BrowserMirror — แปลง chrome events → สถานะใน GroupStore แบบ real-time (SOT v3.0.0 §3)
 *
 * โครงสร้างข้อมูลในหน่วยความจำ (session-scoped, ไม่ persist):
 *   #groupsByGroupId: groupId → { windowId, name, color }
 *   #tabsByTabId:     tabId   → { groupId, windowId, url (normalized), title, favIconUrl }
 *
 * จุดรวมสรุปสถานะ: "rebuild liveMap จาก registry แล้วส่งเข้า GroupStore.applyLiveMap"
 * store เป็นคน diff กับข้อมูลเดิมและ persist เองทั้งหมด (timestamps/Rename-merge — อยู่ใน store)
 *
 * นอกขอบเขตการ sync (SOT §2 L1) — ไม่ถูกจับ: แท็บที่ไม่มี group, group ไม่มีชื่อ,
 * URL พิเศษ/ว่าง, แท็บในหน้าต่าง incognito
 */

import { isIgnoredUrl, normalizeUrl, sanitizeTitle } from "./url-sanitizer.js";
import { DEFAULT_GROUP_COLOR, CHROMIUM_GROUP_COLORS, TIMINGS } from "../shared/constants.js";

const VALID_COLORS = new Set(CHROMIUM_GROUP_COLORS);
const TAB_ID_NONE = -1;

export class BrowserMirror {
  /**
   * @param {object} deps
   * @param {typeof chrome} deps.chrome  production = global chrome, test = fake chrome
   * @param {import("./group-store.js").GroupStore} deps.store
   * @param {number} [deps.emitDebounceMs] รวม event burst ก่อน rebuild (เทสใส่ 0)
   */
  constructor({ chrome, store, emitDebounceMs = TIMINGS.SAVE_BATCH_MS }) {
    this.#chrome = chrome;
    this.#store = store;
    this.#emitDebounceMs = emitDebounceMs;
  }

  #chrome;
  #store;
  #emitDebounceMs;
  #groupsByGroupId = new Map();
  #tabsByTabId = new Map();
  #incognitoWindows = new Set();
  #emitTimer = null;

  // ------------------------------------------------------------------
  // Attach — ต้องเรียกแบบ synchronous ตอน service worker เริ่ม (MV3 rules)
  // ------------------------------------------------------------------
  attach() {
    const c = this.#chrome;
    c.tabs.onCreated.addListener((tab) => this.#safe(() => this.handleTabCreated(tab)));
    c.tabs.onUpdated.addListener((tabId, changeInfo, tab) => this.#safe(() => this.handleTabUpdated(tabId, changeInfo, tab)));
    c.tabs.onRemoved.addListener((tabId, removeInfo) => this.#safe(() => this.handleTabRemoved(tabId, removeInfo)));
    c.tabs.onAttached.addListener((tabId, info) => this.#safe(() => this.handleTabAttached(tabId, info)));
    c.tabs.onDetached.addListener((tabId, info) => this.#safe(() => this.handleTabDetached(tabId, info)));
    c.tabGroups.onCreated.addListener((group) => this.#safe(() => this.handleGroupCreated(group)));
    c.tabGroups.onUpdated.addListener((group) => this.#safe(() => this.handleGroupUpdated(group)));
    c.tabGroups.onRemoved.addListener((group) => this.#safe(() => this.handleGroupRemoved(group)));
    c.windows.onRemoved.addListener((windowId) => this.#safe(() => this.handleWindowRemoved(windowId)));
    return this.reconcile();
  }

  /** event ใด ๆ พัง ไม่ปล่อยให้ service worker ตายทั้งตัว */
  #safe(fn) {
    Promise.resolve().then(fn).catch(() => { /* step เดียวล้มเหลว — ทำงานต่อ */ });
  }

  // ------------------------------------------------------------------
  // Reconcile — สร้าง registry ใหม่จากสถานะ browser จริงทั้งชุด (startup/install/rescan)
  // ------------------------------------------------------------------
  async reconcile() {
    const c = this.#chrome;
    const [windows, allGroups] = await Promise.all([
      c.windows.getAll({ populate: true }),
      c.tabGroups.query({})
    ]);

    this.#resetRegistries();
    for (const w of windows) {
      if (w.incognito) this.#incognitoWindows.add(w.id);
    }
    for (const g of allGroups) {
      if (this.#incognitoWindows.has(g.windowId)) continue;
      const name = (g.title ?? "").trim();
      if (!name) continue;
      this.#groupsByGroupId.set(g.id, { windowId: g.windowId, name, color: validColor(g.color) });
    }
    for (const w of windows) {
      if (w.incognito) continue;
      for (const t of w.tabs ?? []) this.#tryRegisterTab(t);
    }
    this.#syncNow({ markScan: true });
  }

  #resetRegistries() {
    this.#groupsByGroupId.clear();
    this.#tabsByTabId.clear();
    this.#incognitoWindows.clear();
  }

  // ------------------------------------------------------------------
  // Event handlers (เทสเรียกตรง ๆ ตามชื่อ signature ของ chrome)
  // ------------------------------------------------------------------
  handleTabCreated(tab) {
    if (!tab) return;
    if (tab.incognito || this.#incognitoWindows.has(tab.windowId)) return;
    this.#tryRegisterTab(tab);
    this.#scheduleEmit();
  }

  handleTabUpdated(tabId, changeInfo, tab) {
    if (typeof tabId !== "number" && typeof tabId !== "string") return;

    if (!tab) {
      // rare — Edge ให้ tab แนบมาพร้อม onUpdated; ถ้าไม่มีจริง ดึงเอง
      void this.#resolveAndTrack(tabId);
      return;
    }

    if (tab.incognito || this.#incognitoWindows.has(tab.windowId)) {
      this.#forgetTab(tabId);
      this.#scheduleEmit();
      return;
    }

    const prev = this.#tabsByTabId.get(tabId);
    const nextGroupId = changeInfo?.groupId ?? tab.groupId;

    // ลากแท็บออกจากกลุ่ม (L6): groupId ตก -1 → หลุดขอบเขต sync
    if (prev && typeof nextGroupId === "number" && nextGroupId === TAB_ID_NONE) {
      this.#forgetTab(tabId);
      this.#scheduleEmit();
      return;
    }

    if (tab.discarded && !prev) return; // แท็บหลับที่ไม่เคยจับ — ไม่สร้าง record จากแท็บหลับลอย ๆ
    if (tab.discarded) return; // แท็บหลับไม่จัดการ title/favicon ใหม่ (SOT §6)

    this.#tryRegisterTab(tab);
    this.#scheduleEmit();
  }

  handleTabRemoved(tabId, removeInfo) {
    if (removeInfo?.windowId && this.#incognitoWindows.has(removeInfo.windowId)) return;
    this.#forgetTab(tabId);
    this.#scheduleEmit();
  }

  handleTabAttached(tabId, info) {
    if (!info) return;
    if (this.#incognitoWindows.has(info.newWindowId)) this.#forgetTab(tabId);
    void this.#resolveAndTrack(tabId);
    this.#scheduleEmit();
  }

  handleTabDetached(tabId, info) {
    if (!info) return;
    // แท็บออกจากหน้าต่างเดิม — ปล่อยจาก live ก่อน (attach จะรับกลับถ้าเข้ากลุ่มตั้งชื่อ)
    this.#forgetTab(tabId);
    this.#scheduleEmit();
  }

  handleGroupCreated(group) {
    if (!group) return;
    const name = (group.title ?? "").trim();
    if (!name) {
      this.#groupsByGroupId.delete(group.id);
    } else {
      this.#groupsByGroupId.set(group.id, { windowId: group.windowId, name, color: validColor(group.color) });
    }
    this.#scheduleEmit();
  }

  handleGroupUpdated(group) {
    if (!group) return;
    const name = (group.title ?? "").trim();
    const prevName = this.#groupsByGroupId.get(group.id)?.name ?? "";

    if (name && prevName && prevName !== name) {
      this.#store.renameGroup(prevName, name); // L7 — ย้าย record ก่อน rebuild
    }

    if (!name) {
      // กลุ่มเสียชื่อ — ถอดออกจากขอบเขต sync (แท็บยังอยู่ก็ไม่จับ)
      this.#groupsByGroupId.delete(group.id);
    } else {
      this.#groupsByGroupId.set(group.id, { windowId: group.windowId, name, color: validColor(group.color) });
    }
    this.#scheduleEmit();
  }

  handleGroupRemoved(group) {
    if (!group) return;
    this.#groupsByGroupId.delete(group.id);
    for (const [tabId, entry] of [...this.#tabsByTabId]) {
      if (entry.groupId === group.id) this.#forgetTab(tabId);
    }
    this.#scheduleEmit();
  }

  handleWindowRemoved(windowId) {
    if (this.#incognitoWindows.delete(windowId)) {
      this.#scheduleEmit();
      return;
    }
    for (const [tabId, entry] of [...this.#tabsByTabId]) {
      if (entry.windowId === windowId) this.#forgetTab(tabId);
    }
    let touched = false;
    for (const [groupId, g] of [...this.#groupsByGroupId]) {
      if (g.windowId === windowId) {
        this.#groupsByGroupId.delete(groupId);
        touched = true;
      }
    }
    if (touched) this.#scheduleEmit();
  }

  // ------------------------------------------------------------------
  // Registration helpers
  // ------------------------------------------------------------------
  async #resolveAndTrack(tabId) {
    try {
      const t = await this.#chrome.tabs.get(tabId);
      if (t) {
        if (t.incognito || this.#incognitoWindows.has(t.windowId)) this.#forgetTab(tabId);
        else this.#tryRegisterTab(t);
      }
      this.#scheduleEmit();
    } catch {
      this.#forgetTab(tabId);
      this.#scheduleEmit();
    }
  }

  /** พยายามลงทะเบียนแท็บตามเงื่อนไข L1 — คืน true เมื่ออยู่ในขอบเขต sync */
  #tryRegisterTab(t) {
    if (!t || typeof t.id !== "number") return false;
    if (t.incognito || this.#incognitoWindows.has(t.windowId)) return false;
    const url = normalizeUrl(t.url);
    if (!url || isIgnoredUrl(t.url)) return false;
    if (typeof t.groupId !== "number" || t.groupId === TAB_ID_NONE) return false;
    if (t.discarded && !this.#tabsByTabId.has(t.id)) return false;

    this.#tabsByTabId.set(t.id, {
      groupId: t.groupId,
      windowId: t.windowId,
      url,
      title: sanitizeTitle(t.title, undefined, url),
      favIconUrl: t.favIconUrl || undefined
    });

    // กลุ่มหายไปจาก registry (rare — group event ทำงานก่อน tab event แต่บางแท็บรับก่อน)
    if (!this.#groupsByGroupId.has(t.groupId)) this.#rememberGroupFromTab(t);
    return true;
  }

  /** ลงทะเบียนกลุ่มแบบ lazy (เติมชื่อ/สีจาก tabGroups จริง — ผิดเพี้ยนไม่มี record ตามมา) */
  #rememberGroupFromTab(tab) {
    void this.#chrome.tabGroups.query({})
      .then(all => {
        const g = all?.find(gx => gx.id === tab.groupId);
        if (!g) return;
        const name = (g.title ?? "").trim();
        if (!name) return;
        this.#groupsByGroupId.set(g.id, { windowId: g.windowId ?? tab.windowId, name, color: validColor(g.color) });
        this.#scheduleEmit();
      })
      .catch(() => { /* group หายไปก่อน query — แท็บลอยไม่จับ */ });
  }

  #forgetTab(tabId) {
    this.#tabsByTabId.delete(tabId);
  }

  // ------------------------------------------------------------------
  // Rebuild → store (ผลลัพธ์เดียวทั้งคลาส)
  // ------------------------------------------------------------------
  #buildLiveMap() {
    const live = new Map();
    for (const entry of this.#tabsByTabId.values()) {
      const g = this.#groupsByGroupId.get(entry.groupId);
      const name = g?.name ?? "";
      if (!name) continue; // unnamed — ไม่จับ
      let seat = live.get(name);
      if (!seat) {
        seat = { color: g.color, windowIds: [], tabs: {} };
        live.set(name, seat);
      }
      const wid = g.windowId ?? entry.windowId;
      if (!seat.windowIds.includes(wid)) seat.windowIds.push(wid);
      const tabEntry = seat.tabs[entry.url];
      if (tabEntry) {
        tabEntry.count += 1;
      } else {
        seat.tabs[entry.url] = { title: entry.title, favIconUrl: entry.favIconUrl, count: 1 };
      }
    }
    return live;
  }

  /** rebuild → เขียนเข้าคลัง (store diff + persist เอง) */
  #syncNow({ markScan = false } = {}) {
    if (!this.#store.ready) return; // init ยังไม่จบ — ข้าม (event หลัง init จะสร้างครบเอง)
    this.#store.applyLiveMap(Object.fromEntries(this.#buildLiveMap()), { markScan });
  }

  #scheduleEmit() {
    if (this.#emitTimer !== null) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.#syncNow();
    }, this.#emitDebounceMs);
  }

  /** บังคับ rebuild ทันที (ใช้หลัง popup ทำงานกับ record ที่ต้องการสถานะล่าสุด) */
  flushSync() {
    if (this.#emitTimer !== null) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#syncNow();
  }

  /** สถิติ registry (debug/เทส) */
  get registryStats() {
    return { groups: this.#groupsByGroupId.size, tabs: this.#tabsByTabId.size };
  }
}

function validColor(color) {
  return typeof color === "string" && VALID_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}
