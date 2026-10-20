/**
 * GroupStore — seam เดียวของระบบ (SOT v3.0.0 §3)
 *
 * คลังกลุ่มทั้งหมดของ extension: อ่าน/เขียน chrome.storage.local ผ่าน storage area
 * ที่ inject เข้ามา (production = chrome.storage.local, test = fake object)
 *
 * แนวคิดหลัก: "สถานะบน browser คือ graph ของ event, คลังคือ projection"
 * - mirror ส่ง `applyLiveMap(liveMap)` ทุกครั้งที่ browser state 别名เปลี่ยน → store diff กับ record เดิม
 *   (ids, timestamps, สถานะ ตื่น/หลับ, rename-merge → ถูก encapsulate อยู่ที่นี่ทั้งหมด)
 * - popup จัดการผ่านชุดคำสั่งชัด ๆ: rename/deleteGroup/deleteTab
 */

import {
  STORAGE_KEY,
  SCHEMA_VERSION,
  LEGACY_STORAGE_KEYS,
  TIMINGS,
  CHROMIUM_GROUP_COLORS,
  DEFAULT_GROUP_COLOR,
  THEME_PREFERENCES
} from "../shared/constants.js";
import { normalizeUrl, sanitizeTitle } from "./url-sanitizer.js";

const VALID_COLORS = new Set(CHROMIUM_GROUP_COLORS);

function validColor(color) {
  return typeof color === "string" && VALID_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}

/**
 * MV3 service worker ของ Chromium หลายบิลด์ (รวม Edge):
 * ฟังก์ชัน platform แบบ WebIDL เมื่อถูกเก็บ reference แล้วเรียกแบบ detach (ไม่มี receiver)
 * จะโยน TypeError: Illegal invocation — กติกาฉบับนี้: เรียกผ่าน `globalThis.x(...)` เสมอ
 * (member expression มี receiver = global ตลอด ไม่มีทางพัง)
 */
const CLONE = value => globalThis.structuredClone(value);

function nextOrder(record) {
  let max = -1;
  for (const tab of Object.values(record.tabs)) {
    if (tab.order > max) max = tab.order;
  }
  return max + 1;
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class GroupStore {
  /**
   * @param {object} opts
   * @param {{ get(key):Promise, set(obj):Promise, remove(keys):Promise, clear():Promise }} opts.storage
   *        chrome.storage.local-compatible area (production) หรือ fake (test)
   * @param {() => number} [opts.now]
   * @param {number} [opts.saveDelayMs] debounce ก่อน persist (test ส่ง 0)
   * @param {typeof setTimeout} [opts.setTimeoutFn] inject เพื่อเทส (default ผ่าน globalThis — กัน Illegal invocation ใน Edge SW)
   * @param {typeof clearTimeout} [opts.clearTimeoutFn]
   */
  constructor({ storage, now = Date.now, saveDelayMs = TIMINGS.SAVE_BATCH_MS, setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeoutFn = id => globalThis.clearTimeout(id) }) {
    this.#storage = storage;
    this.#now = now;
    this.#saveDelayMs = saveDelayMs;
    this.#setTimeoutFn = setTimeoutFn;
    this.#clearTimeoutFn = clearTimeoutFn;
  }

  #storage;
  #now;
  #saveDelayMs;
  #setTimeoutFn;
  #clearTimeoutFn;
  #schema = null;
  #saveTimer = null;
  #pendingPersist = null;

  /** โหลด schema + migration จากระบบ v2 (ล้างหมด — SOT §8) */
  async init() {
    const all = await this.#storage.get(null);
    const existing = all?.[STORAGE_KEY];
    let migrated = false;

    const hasLegacy = LEGACY_STORAGE_KEYS.some(key => key in (all ?? {}));

    if (existing && existing.version === SCHEMA_VERSION && typeof existing.groups === "object" && existing.groups !== null) {
      this.#schema = existing;
      // แค่กัน key เก่าทิ้งค้าง
      if (hasLegacy) {
        await this.#storage.remove(LEGACY_STORAGE_KEYS);
        migrated = true;
      }
      // v3.0.1 — key คลังเดิมอาจยังติด fragment (#hash): ยก key ใหม่ + รวมตัวซ้ำ
      this.#renormalizeStoredTabs();
    } else {
      // อะไรก็ตามที่ไม่ใช่ v3 — ล้างทั้ง area แล้วสร้าง schema ใหม่ (ระบบเก่าไม่ import)
      this.#schema = { version: SCHEMA_VERSION, groups: {}, themePreference: undefined, lastScanAt: undefined, migrationNoticeAt: undefined, migrationAckAt: undefined };
      await this.#storage.clear();
      migrated = hasLegacy || Boolean(existing);
      await this.#storage.set({ [STORAGE_KEY]: this.#schema });
    }

    this.#migratedFlag = migrated;
    return migrated;
  }

  #migratedFlag = false;

  /** true เมื่อ init() ครั้งล่าสุดเป็นการล้าง/ย้ายจากระบบเก่า — service worker ใช้ตั้ง migrationNoticeAt */
  get migrated() {
    return this.#migratedFlag;
  }

  /** service worker กัน race: mirror events มาก่อน init เสร็จ — ยังไม่พร้อมให้ตัด decision ไปเลย */
  get ready() {
    return this.#schema !== null;
  }

  /** Snapshot ทั้งหมด (deep copy — กัน caller แก้ข้อมูลภายใน) */
  snapshot() {
    return CLONE(this.#schema);
  }

  /** Snapshot เฉพาะกลุ่ม (Record<name, GroupRecord>) */
  getGroups() {
    return CLONE(this.#schema.groups);
  }

  get themePreference() {
    return this.#schema?.themePreference ?? "dark";
  }

  setTheme(theme) {
    if (!THEME_PREFERENCES.includes(theme)) return;
    if (this.#schema.themePreference === theme) return;
    this.#schema.themePreference = theme;
    this.#scheduleSave();
  }

  /**
   * เทียบ "สถานะ live ของ browser" กับคลัง แล้วปรับ record ให้ตรง (mirror ตัวเดียวเรียก)
   *
   * liveMap: Record<name, {
   *   color?: GroupColor,
   *   windowIds?: number[],
   *   tabs: Record<normUrl, { title?: string, favIconUrl?: string, count: number }>
   * }>
   * (name ที่ว่าง/blank ถูกกรองที่ mirror; ที่นี่ถือว่าเป็น "แท็บที่ตื่นอยู่จริง")
   */
  applyLiveMap(liveMap, { markScan = false } = {}) {
    if (typeof liveMap !== "object" || liveMap === null) return;
    const groups = this.#schema.groups;
    let changed = false;

    for (const name of Object.keys(liveMap)) {
      const live = liveMap[name];
      if (!live || typeof live !== "object" || !name) continue;

      let record = groups[name];
      if (!record) {
        record = groups[name] = { name, color: validColor(live.color), createdAt: this.#now(), updatedAt: this.#now(), liveWindowIds: [], tabs: {} };
        changed = true;
      }

      if (live.color && validColor(live.color) !== record.color) {
        record.color = validColor(live.color);
        record.updatedAt = this.#now();
        changed = true;
      }

      const windowIds = [...(live.windowIds ?? [])].sort((a, b) => a - b);
      if (!arraysEqual(record.liveWindowIds, windowIds)) {
        record.liveWindowIds = windowIds;
        record.updatedAt = this.#now();
        changed = true;
      }

      const seenUrls = new Set();
      for (const tabUrl of Object.keys(live.tabs ?? {})) {
        const info = live.tabs[tabUrl];
        if (!info || typeof info !== "object") continue;
        const key = normalizeUrl(tabUrl);
        if (!key || !Number.isFinite(info.count) || info.count < 1) continue;
        seenUrls.add(key);
        changed = this.#mergeLiveTab(record, key, info) || changed;
      }

      for (const key of Object.keys(record.tabs)) {
        if (seenUrls.has(key)) continue;
        changed = this.#retireTab(record, key) || changed;
      }
    }

    // กลุ่มที่ตกออกจาก liveMap ทั้งตัว — ปิดสถานะตื่นของทุกแท็บ (ยังคง record เพื่อเปิดกลับได้)
    for (const name of Object.keys(groups)) {
      if (name in liveMap) continue;
      const record = groups[name];
      for (const key of Object.keys(record.tabs)) {
        changed = this.#retireTab(record, key) || changed;
      }
    }

    changed = this.#gcEmptyGroups() || changed;

    if (markScan) {
      this.#schema.lastScanAt = this.#now();
      changed = true;
    }
    if (changed) this.#scheduleSave();
  }

  /**
   * ซิงก์สถานะ live ต่อแท็บ single (robust ใช้ mirror สั่งบ่อย) —
   * normalize URL, เก็บ timestamp, เลขค่า count ต้องมาจาก session registry (กัน double-count)
   */
  #mergeLiveTab(record, key, info) {
    let tab = record.tabs[key];
    const title = sanitizeTitle(info.title, undefined, key);

    if (!tab) {
      tab = record.tabs[key] = {
        url: key,
        title,
        favIconUrl: info.favIconUrl || undefined,
        order: nextOrder(record),
        addedAt: this.#now(),
        lastLiveAt: this.#now(),
        closedAt: undefined,
        liveCount: info.count
      };
      record.updatedAt = this.#now();
      return true;
    }

    let changed = false;

    if (tab.liveCount !== info.count) {
      tab.liveCount = info.count;
      tab.lastLiveAt = this.#now();
      if (tab.closedAt !== undefined) {
        tab.closedAt = undefined; // แท็บกลับมาตื่น ล้าง closedAt
      }
      changed = true;
    }

    const titleChanged = Boolean(title) && title !== tab.title;
    const faviconChanged = Boolean(info.favIconUrl) && info.favIconUrl !== tab.favIconUrl;
    if (titleChanged) tab.title = title;
    if (faviconChanged) tab.favIconUrl = info.favIconUrl;
    if (titleChanged || faviconChanged) {
      changed = true;
    }
    if (changed) record.updatedAt = this.#now();
    return changed;
  }

  #retireTab(record, key) {
    const tab = record.tabs[key];
    if (!tab || tab.liveCount === 0) return false;
    tab.liveCount = 0;
    tab.closedAt = this.#now();
    record.updatedAt = this.#now();
    return true;
  }

  #gcEmptyGroups() {
    let changed = false;
    for (const name of Object.keys(this.#schema.groups)) {
      const record = this.#schema.groups[name];
      if (Object.keys(record.tabs).length === 0) {
        delete this.#schema.groups[name];
        changed = true;
      }
    }
    return changed;
  }

  /** เปลี่ยนชื่อกลุ่ม (tabs ทาง extension; tabGroups.update ทำที่ mirror) — ถ้าชื่อใหม่มี record อยู่แล้ว → union merge (SOT L7) */
  renameGroup(oldName, newName) {
    if (typeof oldName !== "string" || typeof newName !== "string") return;
    if (!oldName || !newName || oldName === newName) return;

    const groups = this.#schema.groups;
    const oldRecord = groups[oldName];
    if (!oldRecord) return; // ยังไม่มี record อะไรจับอยู่ — ให้ applyLiveMap จัดต่อ

    const target = groups[newName];
    const now = this.#now();

    if (!target) {
      oldRecord.name = newName;
      oldRecord.updatedAt = now;
      groups[newName] = oldRecord;
    } else {
      // union merge: คง meta ฝั่ง target, เติมสิ่งที่ตก, liveCount เก็บสูงสุด,
      // แท็บจาก record เดิมได้ order ใหม่ต่อท้าย (nextOrder แล้วไม่ชนกับ target)
      const mergedTabs = { ...target.tabs };
      let order = Math.max(nextOrder(target), nextOrder(oldRecord));
      for (const [key, tab] of Object.entries(oldRecord.tabs)) {
        const existingTab = mergedTabs[key];
        mergedTabs[key] = existingTab
          ? {
              ...existingTab,
              favIconUrl: existingTab.favIconUrl || tab.favIconUrl,
              title: existingTab.title && existingTab.lastLiveAt ? existingTab.title : (tab.title || existingTab.title),
              liveCount: Math.max(existingTab.liveCount, tab.liveCount)
            }
          : { ...tab, order: order++ };
      }
      const merged = {
        name: newName,
        color: oldRecord.updatedAt > target.updatedAt ? oldRecord.color : target.color,
        createdAt: Math.min(oldRecord.createdAt, target.createdAt),
        updatedAt: now,
        liveWindowIds: [...new Set([...(oldRecord.liveWindowIds ?? []), ...(target.liveWindowIds ?? [])])].sort((a, b) => a - b),
        tabs: mergedTabs
      };
      groups[newName] = merged;
    }

    delete groups[oldName];
    this.#scheduleSave();
  }

  /** ลบกลุ่มทั้งตัวออกจากคลัง (ไม่แตะ browser) */
  deleteGroup(name) {
    if (name in this.#schema.groups) {
      delete this.#schema.groups[name];
      this.#scheduleSave();
    }
  }

  /** ลบแท็บรายตัว (record idle — แท็บตื่นไม่รับลบจาก popup ฝั่ง mirror กรอง) */
  deleteTab(name, url) {
    return this.deleteTabs(name, [url]);
  }

  /**
   * ลบแท็บในคลังหลายรายการในครั้งเดียว (input = recorded key หรือ raw url — normalize ก่อนจับคู่ key,
   * แท็บจริงบนเบราว์เซอร์ไม่ถูกแตะ) — GC กลุ่มว่างตาม L8; คืน { removed, groupDeleted }
   */
  deleteTabs(name, urls) {
    const record = this.#schema.groups[name];
    if (!record || !Array.isArray(urls)) return { removed: 0, groupDeleted: false };

    let removed = 0;
    for (const url of new Set(urls.map(String))) {
      const key = normalizeUrl(url) || String(url);
      if (key in record.tabs) {
        delete record.tabs[key];
        removed += 1;
      }
    }
    if (removed === 0) return { removed: 0, groupDeleted: false };

    record.updatedAt = this.#now();
    let groupDeleted = false;
    // L8 — ถ้าไม่มีแท็บเหลือเลย ลบกลุ่มทิ้ง (ไม่มีค่าให้จำ)
    if (Object.keys(record.tabs).length === 0) {
      delete this.#schema.groups[name];
      groupDeleted = true;
    }
    this.#scheduleSave();
    return { removed, groupDeleted };
  }

  /**
   * v3.0.1 — ยก key แท็บให้ตรง normalize ปัจจุบัน (ตัด fragment #hash) แล้วรวมรายการซ้ำเข้า key เดิม
   * แก้ปัญหา "หน้าเดียวกัน hash ต่างกัน ถูกจำแยกกัน" — ฐาน dedupe คือ Normalized URL
   * idempotent: key ที่ normalize แล้วจะเข้าเงื่อนไขไม่ได้อีก (boot รอบถัดไปเงียบ)
   * @returns {boolean} true เมื่อข้อมูลเปลี่ยน
   */
  #renormalizeStoredTabs() {
    let changed = false;
    for (const record of Object.values(this.#schema.groups)) {
      for (const [key, tab] of Object.entries(record.tabs)) {
        const norm = normalizeUrl(key) || key;
        if (norm === key) continue;

        changed = true;
        delete record.tabs[key];
        const twin = record.tabs[norm];
        record.tabs[norm] = twin
          ? {
              // รวมข้อมูล: เก็บฝั่ง key ปกติเป็นใหญ่ เติมเฉพาะช่องที่ฝั่งนั้นว่าง
              ...twin,
              favIconUrl: twin.favIconUrl || tab.favIconUrl,
              title: twin.title || tab.title,
              addedAt: Math.min(twin.addedAt ?? tab.addedAt ?? 0, tab.addedAt ?? twin.addedAt ?? 0),
              lastLiveAt: Math.max(twin.lastLiveAt ?? 0, tab.lastLiveAt ?? 0),
              closedAt: twin.closedAt && tab.closedAt ? Math.max(twin.closedAt, tab.closedAt) : (twin.closedAt ?? tab.closedAt),
              liveCount: Math.max(twin.liveCount, tab.liveCount),
              order: Math.min(twin.order ?? tab.order ?? 0, tab.order ?? twin.order ?? 0)
            }
          : { ...tab, url: norm };
        record.updatedAt = this.#now();
      }
    }
    // แท็บถูก "ย้าย" ไม่ใช่ "ลบ" — กลุ่มว่างไม่เกิดขึ้นจาก merge ข้าม GC
    if (changed) this.#scheduleSave();
    return changed;
  }

  /** ปัดค่าเวลา scan ล่าสุด (ธง footer ของ popup) */
  markScan() {
    this.#schema.lastScanAt = this.#now();
    this.#scheduleSave();
  }

  /** บอก popup ว่าให้โชว์ toast migration ครั้งแรก (หลังจากนั้นระบุ ackAt แล้วไม่โชว์อีก) */
  markMigrationNotice() {
    if (this.#schema.migrationNoticeAt) return;
    this.#schema.migrationNoticeAt = this.#now();
    this.#scheduleSave();
  }

  consumeMigrationNotice() {
    if (!this.#schema.migrationNoticeAt) return false;
    if (this.#schema.migrationAckAt) return false;
    this.#schema.migrationAckAt = this.#now();
    this.#scheduleSave();
    return true;
  }

  #scheduleSave() {
    if (this.#saveTimer !== null) return; // debounce รวม event burst
    this.#pendingPersist = new Promise(resolve => {
      const run = async () => {
        try {
          await this.#storage.set({ [STORAGE_KEY]: this.#schema });
        } catch {
          // storage ล้ม: ยอมปล่อย — คลังใช้ pending schema อยู่
        }
        this.#saveTimer = null;
        resolve();
      };
      this.#saveTimer = this.#setTimeoutFn(run, this.#saveDelayMs);
    });
  }

  /** กันเขียนเมื่อ service worker จะตายหรือตอนเทส — await ให้เพิ่มเก็บข้อมูลไปแน่นอน */
  async flush() {
    if (this.#pendingPersist) await this.#pendingPersist;
    this.#pendingPersist = null;
    return this.#schema ? CLONE(this.#schema) : null;
  }
}
