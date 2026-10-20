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
  #pendingDeletes = [];   // v3.1 L13 — รอลบ record (explicit close) ยิงหลัง applyLiveMap ต่อ burst
  #pendingMoves = [];     // v3.1 L14 — record เลื่อนตามแท็บที่เปลี่ยน url ยิงหลัง applyLiveMap ต่อ burst

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
      for (const t of w.tabs ?? []) {
        // แท็บตื่นจริงบน browser — ธง s (ผลจาก restore) หมดอายุทันที กู้จังหวะ SW ตายหลังผู้ใช้กดตื่นแต่ก่อน persist
        if (!t.discarded) this.#store.clearSleepingFlag(t.id);
        // v3.2 — กู้แถวค้าง: binding ชี้ URL เก่า แต่แท็บจริงเปลี่ยนหน้าไปแล้ว (เกิดตอน SW ไม่ได้รับ event)
        // → ย้าย record ตามแท็บ (L14) ไม่งั้นแถวเก่าค้างเป็น "จำไว้ (หลับ)" ซ้ำกับแท็บที่เปิดอยู่
        const bind = this.#store.liveBinding(t.id);
        const realUrl = normalizeUrl(t.url || t.pendingUrl || "");
        if (bind && realUrl && realUrl !== bind.urlKey && !this.#store.isRestoredTab(t.id)) {
          this.#pendingMoves.push({ g: bind.groupName, fromKey: bind.urlKey, toKey: realUrl, tabId: t.id });
        }
        this.#tryRegisterTab(t, true);
      }
    }
    // v3.1 — ตัด binding/ธงของแท็บที่ปิดไประหว่าง SW หลับเท่านั้น (ไม่อยู่ใน windows อีกจริง ๆ)
    // แท็บที่ยังเปิดค้างแต่ registry ตั้งใจไม่จับ (เช่น แท็บผลจาก restore ที่ต้องหลับ) — ธง origin ต้องรอด
    const aliveIds = new Set();
    for (const w of windows) {
      if (w.incognito) continue;
      for (const t of w.tabs ?? []) aliveIds.add(String(t.id));
    }
    this.#store.pruneLiveBindings([...this.#tabsByTabId.keys(), ...aliveIds]);
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
    // แท็บใหม่จาก Edge: url ยังว่างระหว่างโหลด — ใช้ pendingUrl (URL ที่จะโหลด) เป็นตัวตนชั่วคราว
    this.#tryRegisterTab(tab, false, tab.pendingUrl || "");
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

    // v3.1 — แท็บหลับ (discarded = Edge sleeping-tab: ยังเปิดค้างใน strip) ไม่หมุน title/favicon
    // แต่ต้องจับเข้า registry ให้ครบ — "แท็บหลับ = แท็บเปิดอยู่จริง" (ถ้าโดนกรองทิ้ง แท็บที่ Edge นอนเอง
    // จะหายจาก liveMap หลัง SW restart + reconcile → row ผิด ๆ กลายเป็น "จำไว้ (หลับ)" ทั้งที่เปิดอยู่)
    if (tab.discarded) {
      if (prev) {
        prev.discarded = true; // ตื่น → หลับ (Edge นอนให้เอง): คงสถานะ ไม่อัปเดตข้อมูลหน้า
        this.#scheduleEmit();
        return;
      }
      this.#tryRegisterTab(tab, false, changeInfo?.url || ""); // แท็บหลับที่ไม่เคยจับ — ยังเป็นแท็บเปิดจริงในกลุ่ม
      this.#scheduleEmit();
      return;
    }
    if (prev && prev.discarded) {
      prev.discarded = false; // ผู้ใช้กดตื่นแท็บที่หลับ (Edge sleeping / แท็บที่ restore ไว้) — กลับมาเป็นตื่นตามจริง
      this.#store.clearSleepingFlag(tabId); // ถอนธง s — แท็บผลจาก restore ที่ถูกเอาไปใช้จริง นับตื่นตั้งแต่นี้
    }

    // v3.1 L14 — แท็บที่ผูกไว้เปิดหน้าใหม่: คิว "record เลื่อนตาม" (คิดหลัง rebuild ต่อ burst)
    // URL ใหม่มาจาก changeInfo.url (Edge ส่ง URL ที่เปลี่ยนใน changeInfo — tab.url ใน event ยังเป็นค่าเก่า/ว่าง)
    // v3.2 — เลื่อนได้แม้ origin ป้องกัน (r=1 = เจอจาก scan): เดิมข้ามทุกแท็บที่ scan เจอ
    // → แถวเก่าค้างหลับ + แถวใหม่โผล่ = เห็นเป็นแท็บซ้ำ (dedupe ไม่ทำงานจริง) + binding ไม่เดินตามแท็บ
    // ยกเว้นแท็บผลจาก restore (restoredTabIds) — คงแถวเดิมไว้ให้เปิดกลับได้ตามเดิม
    const newUrl = normalizeUrl(changeInfo?.url || tab.url || "");
    if (prev && newUrl && newUrl !== prev.url) {
      const groupName = this.#groupsByGroupId.get(prev.groupId)?.name ?? "";
      const bind = this.#store.liveBinding(tabId);
      if (bind && bind.groupName === groupName && bind.urlKey === prev.url && !this.#store.isRestoredTab(tabId)) {
        this.#pendingMoves.push({ g: groupName, fromKey: prev.url, toKey: newUrl, tabId });
      }
      if (groupName) this.#store.setLiveBinding(tabId, { groupName, urlKey: newUrl });
    }

    this.#tryRegisterTab(tab, false, changeInfo?.url || "");
    this.#scheduleEmit();
  }

  handleTabRemoved(tabId, removeInfo) {
    if (removeInfo?.windowId && this.#incognitoWindows.has(removeInfo.windowId)) return;
    // อ่าน binding ก่อนลืมแท็บ — ตัวชี้ record ที่แท็บนี้ถืออยู่ (persist — รอดจาก SW ตาย)
    const bind = this.#store.liveBinding(tabId);
    // L13 — ผู้ใช้ปิดแท็บตัวเดียว (isWindowClosing=false) และแท็บไม่ใช่ origin ป้องกัน (restore/scan-first)
    if (removeInfo?.isWindowClosing !== true && bind && bind.groupName && bind.urlKey && !bind.restored) {
      this.#pendingDeletes.push({ g: bind.groupName, k: bind.urlKey });
    }
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

  /** พยายามลงทะเบียนแท็บตามเงื่อนไข L1 — คืน true เมื่ออยู่ในขอบเขต sync
   * @param {boolean} [peek] true = เจอจาก full scan (reconcile) — สาเหตุกำเนิดไม่แน่ชัด → ธงป้องกัน (ปิดไม่ลบ)
   * @param {string} [urlOverride] URL จริงจาก changeInfo/pendingUrl (แท็บใหม่ที่ url ยังว่าง) */
  #tryRegisterTab(t, peek = false, urlOverride = "") {
    if (!t || typeof t.id !== "number") return false;
    if (t.incognito || this.#incognitoWindows.has(t.windowId)) return false;
    const rawUrl = urlOverride || t.pendingUrl || t.url || "";
    const url = normalizeUrl(rawUrl);
    if (!url || isIgnoredUrl(rawUrl)) return false;
    if (typeof t.groupId !== "number" || t.groupId === TAB_ID_NONE) return false;

    // สถานะ "หลับ" ที่ registry จำไว้ (buildLiveMap คิดจากธง s ใน binding เป็นหลัก — ธงนี้ไว้ตามจับการตื่น/หลับเปลี่ยนมือ):
    //  - t.discarded = Edge Sleeping Tabs ของผู้ใช้ (เปิดค้างจริง → ยังนับเป็นตื่น)
    //  - แท็บผลจาก restore: มีธง restoredTabIds แต่ binding ยังไม่เกิด (ช่วง create→discard ของ flow เอง)
    //    → ถือหลับตั้งแต่แรก กันจังหวะ event loading ของ flow ผุดเป็นตื่นชั่วขณะ
    //  - binding เดิมมีธง s (restore ที่ผู้ใช้ยังไม่กดตื่น) → คงหลับ
    const bindBefore = this.#store.liveBinding(t.id);
    const asSleeping = Boolean(t.discarded) || Boolean(bindBefore?.sleeping) ||
      (this.#store.isRestoredTab(t.id) && !bindBefore);

    this.#tabsByTabId.set(t.id, {
      groupId: t.groupId,
      windowId: t.windowId,
      url,
      title: sanitizeTitle(t.title, undefined, url),
      favIconUrl: t.favIconUrl || undefined,
      discarded: asSleeping // ไว้จับการเปลี่ยนมือตื่น/หลับใน handleTabUpdated (liveMap ตัดสินจากธง s ของ binding)
    });

    // v3.1 — ผูก tabId ↔ record (ถ้ามี binding เดิม: url/ชื่อกลุ่มเปลี่ยนตาม, ธง origin ติดค้าง)
    const groupName = this.#groupsByGroupId.get(t.groupId)?.name;
    if (groupName && url) {
      const bind = this.#store.liveBinding(t.id);
      if (!bind) {
        this.#store.setLiveBinding(t.id, { groupName, urlKey: url });
        if (peek) this.#store.protectLiveBinding(t.id);
      } else if (bind.urlKey !== url || bind.groupName !== groupName) {
        this.#store.setLiveBinding(t.id, { groupName, urlKey: url });
      }
    }

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
        // v3.1 — แท็บของกลุ่มนี้ที่ register มาก่อนชื่อ (lazy) → เกาะ binding ตอนนี้
        for (const [tabId, entry] of this.#tabsByTabId) {
          if (entry.groupId !== g.id) continue;
          const bind = this.#store.liveBinding(tabId);
          if (!bind || bind.urlKey !== entry.url) {
            this.#store.setLiveBinding(tabId, { groupName: name, urlKey: entry.url });
          }
        }
        this.#scheduleEmit();
      })
      .catch(() => { /* group หายไปก่อน query — แท็บลอยไม่จับ */ });
  }

  /** จำนวน instance อื่น (นอกจากแท็บที่กำลังย้าย) ที่ยังใช้ URL นี้ในกลุ่มนี้ */
  #countInstances(groupName, url, exceptTabId) {
    let count = 0;
    for (const [tabId, entry] of this.#tabsByTabId) {
      if (tabId === exceptTabId) continue;
      if (entry.url !== url) continue;
      const g = this.#groupsByGroupId.get(entry.groupId);
      if ((g?.name ?? "") !== groupName) continue;
      count += 1;
    }
    return count;
  }

  #forgetTab(tabId) {
    // v3.1 — เมื่อแท็บพ้นขอบเขต/หายไป ตัด binding โดยรวมทุกเส้นทาง (removed/detach/window/group)
    if (this.#tabsByTabId.delete(tabId)) this.#store.clearLiveBinding(tabId);
  }

  // ------------------------------------------------------------------
  // Rebuild → store (ผลลัพธ์เดียวทั้งคลาส)
  // ------------------------------------------------------------------
  #buildLiveMap() {
    const live = new Map();
    for (const [tabId, entry] of this.#tabsByTabId) {
      // v3.1 L17 — แท็บผลจาก restore (ธง s ใน binding) ไม่เข้า liveMap — record ต้นทางคงหลับตาม §6
      // ไม่แคร์สถานะ discarded ปัจจุบัน เพราะช่วง create→discard ของ flow เอง อาจได้รับ event แบบ awake ก่อน mark
      // (มีเพียง "ผู้ใช้กดตื่นจริง" เท่านั้นที่ถอนธง s — handleTabUpdated เส้นตื่น)
      if (this.#store.liveBinding(tabId)?.sleeping) continue;
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

  /** rebuild → เขียนเข้าคลัง (store diff + persist เอง) แล้วรันงานคิว v3.1 ที่ต้องเกิด "หลัง" diff แล้ว */
  #syncNow({ markScan = false } = {}) {
    if (!this.#store.ready) return; // init ยังไม่จบ — ข้าม (event หลัง init จะสร้างครบเอง)
    const live = Object.fromEntries(this.#buildLiveMap());
    this.#store.applyLiveMap(live, { markScan });

    // v3.1 — เลื่อน record ตามแท็บ (L14) ก่อน แล้วค่อยลบของแท็บที่ปิดเอง (L13)
    // กรอง key ที่ยังมี instance อื่นตื่นอยู่ใน liveMap — ตัวพวกนั้นแถวยังต้องมีชีวิต
    if (this.#pendingMoves.length) {
      // v3.2 — นับ instance อื่นที่ยังใช้ URL เดิมจาก registry (liveMap ถูก rebuild หลังแท็บย้ายแล้ว → ไม่มีตัวเก่า)
      // ถ้ามี → แถวเดิมต้องคงไว้ (count ลดเองตอน diff); ไม่มี → ลบแถวเก่าได้เลย
      const moves = this.#pendingMoves.splice(0).filter(m => m.fromKey !== m.toKey).map(m => ({
        ...m,
        remaining: this.#countInstances(m.g, m.fromKey, m.tabId)
      }));
      if (moves.length) this.#store.moveLiveTabs(moves);
    }
    if (this.#pendingDeletes.length) {
      const deletes = this.#pendingDeletes.splice(0).filter(d => !live?.[d.g]?.tabs?.[d.k]);
      if (deletes.length) this.#store.consumeDeletedTabs(deletes);
    }
  }

  #scheduleEmit() {
    if (this.#emitTimer !== null) return;
    this.#emitTimer = globalThis.setTimeout(() => {   // ผ่าน globalThis — กัน Illegal invocation (Edge SW)
      this.#emitTimer = null;
      this.#syncNow();
    }, this.#emitDebounceMs);
  }

  /** บังคับ rebuild ทันที (ใช้หลัง popup ทำงานกับ record ที่ต้องการสถานะล่าสุด) */
  flushSync() {
    if (this.#emitTimer !== null) {
      globalThis.clearTimeout(this.#emitTimer);
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
