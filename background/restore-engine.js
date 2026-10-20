/**
 * RestoreEngine — เปิดแท็บจำไว้ (หลับ) กลับเข้า browser ตามคำสั่งผู้ใช้ (SOT v3.0.0 §6)
 *
 * กลไกหลัก:
 *  1. เลือกหน้าต่างเป้าหมาย: หน้าต่างที่โฟกัสล่าสุด (ไม่ incognito) — ถ้าไม่มีเลยสร้างหน้าต่างใหม่
 *  2. พบ live group ชื่อเดียวกันอยู่ในหน้าต่างนั้น → แทรกแท็บเข้ากลุ่มเดิม; ไม่พบ → สร้างกลุ่มใหม่ (ชื่อ+สีจาก record)
 *  3. diff ตาม L11: URL ที่เปิดอยู่แล้วในหน้าต่างนั้น — ข้าม
 *  4. เปิดทีละแท็บแบบ staggered (STAGGER_MS): create → group → (setColor ครั้งเดียวต่อกลุ่มใหม่) → discard
 *     ยึดหลัก Q5: discard ทุกแท็บรวมแท็บแรกเสมอ — ไม่มีแท็บ active-mounted
 *     กันแท็บว่าง "Untitled": รอ navigation เริ่มจริง (tabs.onUpdated / RESTORE_COMMIT_MS) ก่อน discard
 *     แล้วตรวจ URL บนแท็บซ้ำ — หลุดที่ไหนก็ยิง tabs.update ตั้ง URL จริงกลับให้เสมอ
 *  5. ตรวจหน้าต่างเป้าหมายยังมีชีวิตก่อนแต่ละแท็บ — หลุดกลางทาง → หยุด + รายงาน failed (ไม่สร้างหน้าต่างซ้ำเอง)
 */

import { TIMINGS } from "../shared/constants.js";
import { normalizeUrl, isIgnoredUrl } from "./url-sanitizer.js";

const TAB_ID_NONE = -1;

export class RestoreEngine {
  /**
   * @param {object} deps
   * @param {typeof chrome} deps.chrome
   * @param {import("./group-store.js").GroupStore} deps.store
   * @param {(ms: number) => Promise<void>} [deps.sleep] inject สำหรับเทส (default จริง)
   * @param {number} [deps.commitTimeoutMs] เวลาสูงสุดรอ navigation เริ่มก่อน discard (inject เพื่อเทส)
   */
  constructor({
    chrome,
    store,
    sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)),
    commitTimeoutMs = TIMINGS.RESTORE_COMMIT_MS
  }) {
    this.#chrome = chrome;
    this.#store = store;
    this.#sleep = sleep;
    this.#commitTimeoutMs = Math.max(0, commitTimeoutMs);
    this.#busyNames = new Set();
    // ลง listener ตั้งแต่ construct (SW boot, synchronous) — create ใน fake/จริงยิง onUpdated sync
    // ตอน create จนจับ commit signal ได้ก่อน #waitForCommit เริ่มรอ
    this.#ensureCommitListener();
  }

  #chrome;
  #store;
  #sleep;
  #busyNames;
  #commitTimeoutMs;
  #commitArmed = false;
  /** แท็บที่เห็น onUpdated ล่าสุด (tabId → tick) — เทียบลำดับ event แทนนาฬิกาจริง (กันเวลาเดินส่าย) */
  #commitSeen = new Map();
  #commitWaiters = new Map(); // tabId → Set<() => void>
  #updatedTick = 0;

  /**
   * เปิดแท็บหลับของกลุ่มหนึ่งก้อน
   * @param {object} req
   * @param {string} req.name  ชื่อกลุ่ม (identity ตรงตัว)
   * @param {string[]} [req.urls] รายการ URL ที่เลือก (key ของ record); ไม่ส่ง/[] = เปิดทั้งหมดที่หลับ
   * @returns {Promise<{ok: true, opened: number, skipped: number, createdWindow: boolean}
   *                  | {ok: false, error: string}>}
   */
  async openTabs({ name, urls }) {
    if (!this.#store.getGroups()[name]) return { ok: false, error: "no-record" };
    if (this.#busyNames.has(name)) return { ok: false, error: "busy" };
    this.#busyNames.add(name);
    const createdIds = []; // v3.1 — แท็บที่ restore สร้างจริง (mark ใน finally แม้ window หลุดกลางทาง)

    try {
      const target = await this.#pickTargetWindow();
      if (!target) return { ok: false, error: "no-window" };
      const { windowId, createdWindow } = target;

      // L11 — ตัด URL ที่เปิดอยู่แล้วในหน้าต่างเป้าหมาย (ไม่ใช่เฉพาะในกลุ่ม)
      const windowTabs = await this.#chrome.tabs.query({ windowId });
      const openUrls = new Set();
      for (const t of windowTabs) {
        const norm = normalizeUrl(t.url || t.pendingUrl || "");
        if (norm) openUrls.add(norm);
      }

      // กลุ่มที่มีชีวิตชื่อเดียวกันอยู่ในหน้าต่างเป้าหมาย? (เทียบชื่อแบบ exact)
      // — เตรียมจากทั้ง tabGroups ในหน้าต่างนั้น
      const groupsInWindow = (await this.#chrome.tabGroups.query({ windowId })) ?? [];
      const existingGroup = groupsInWindow.find(g => (g.title ?? "").trim() === name);
      let groupId = existingGroup?.id ?? null;

      const record = this.#store.getGroups()[name];
      const plan = this.#planTargets(record, urls, openUrls);
      let opened = 0;

      for (const [index, entry] of plan.entries()) {
        if (index > 0) await this.#sleep(TIMINGS.STAGGER_MS);

        // ยืนยันหน้าต่างยังอยู่ก่อนสร้างแท็บ (SOT §6 — ไม่สร้าง window แทนเอง)
        try {
          await this.#chrome.windows.get(windowId);
        } catch {
          return { ok: true, opened, skipped: this.#lastSkipped + (plan.length - opened), createdWindow };
        }

        // create → (ยืนยัน URL บนแท็บ) → group → (ตั้งชื่อ/สีเฉพาะกลุ่มใหม่) → รอ commit → discard (ทุกแท็บ รวมแท็บแรก)
        const sinceTick = this.#updatedTick;
        const created = await this.#chrome.tabs.create({
          windowId,
          url: entry.url,
          active: false,
          pinned: false
        });
        createdIds.push(created.id);
        // mark ทันทีต่อแท็บ (ธง restoredTabIds/s ใน binding ต้องพร้อมก่อน event ของแท็บนี้ถูกประมวลผล)
        // — ใน finally ยัง mark รวมทั้งชุดอีกรอบ idempotent สำหรับกรณี flow ขาดกลางทาง
        this.#store.markRestoredTabs([created.id]);
        await this.#ensurePendingUrl(created, entry.url);

        if (groupId === null) {
          groupId = await this.#chrome.tabs.group({ tabIds: [created.id], createProperties: { windowId } });
          await this.#chrome.tabGroups.update(groupId, { title: name, color: record.color });
        } else {
          await this.#chrome.tabs.group({ tabIds: [created.id], groupId });
        }

        // กันแท็บว่าง "Untitled" — discard ตอน navigation ยังไม่เริ่ม = ยกเลิกการโหลด
        // (เห็น onUpdated ของแท็บนี้ตั้งแต่ก่อน create แล้ว → คืนทันที ไม่รอจริง)
        await this.#waitForCommit(created.id, sinceTick);
        await this.#chrome.tabs.discard(created.id);

        // ตรวจซ้ำหลัง discard: ถ้าเบราว์เซอร์ทำ URL หลุด (ไม่มี url/pendingUrl ทั้งคู่) — ตั้งกลับให้เป็นแผนสุดท้าย
        try {
          const finalTab = await this.#chrome.tabs.get(created.id);
          if (finalTab && isIgnoredUrl(finalTab.url || finalTab.pendingUrl || "")) {
            await this.#chrome.tabs.update(created.id, { url: entry.url });
          }
        } catch { /* แท็บหายไปแล้ว — ไม่มีอะไรจะกู้ */ }

        opened += 1;
      }

      return { ok: true, opened, skipped: this.#lastSkipped + (plan.length - opened), createdWindow };
    } catch (err) {
      return { ok: false, error: err?.message ? String(err.message).slice(0, 120) : "restore-failed" };
    } finally {
      this.#busyNames.delete(name);
      // v3.1 — ธง origin 'restored': ปิดแท็บพวกนี้เอง = record คงอยู่ (ไม่ลบคลังที่ผู้ใช้ขอไว้)
      if (createdIds.length) this.#store.markRestoredTabs(createdIds);
    }
  }

  /** กำหนดลำดับเป้าหมาย: urls ที่ผู้ใช้เลือก, หรือทั้งหมดที่หลับเรียงตาม order (L6: idle เท่านั้น) */
  #planTargets(record, urlList, openUrls) {
    const plan = [];
    let skipped = 0;

    const idleTabUrls = urlList?.length
      ? urlList.filter(u => u in record.tabs)
      : Object.values(record.tabs)
          .filter(t => t.liveCount === 0)
          .sort((a, b) => a.order - b.order)
          .map(t => t.url);

    const requestedUrls = urlList?.length
      ? urlList
      : idleTabUrls;

    for (const url of requestedUrls) {
      const key = normalizeUrl(url);
      if (!key || isIgnoredUrl(key)) { skipped += 1; continue; } // URL ว่าง/privileged — ห้ามลง create (ไม่มีทางได้แท็บเปล่า)
      const recordTab = record.tabs[key];
      if (!recordTab) { skipped += 1; continue; }      // ไม่มี record — ไม่ใช่แท็บที่ระบบจำไว้
      if (recordTab.liveCount > 0) { skipped += 1; continue; } // ตื่นอยู่แล้ว — ไม่เปิดซ้ำ
      if (openUrls.has(key)) { skipped += 1; continue; }      // เปิดอยู่แล้วในหน้าต่างนี้ (L11)
      plan.push(recordTab);
    }
    this.#lastSkipped = skipped;
    return plan;
  }

  /** แท็บที่ Edge คืนมาต้องอุ้ม URL จริง (pendingUrl หรือ url) — ถ้าว่าง สั่ง tabs.update ตั้ง URL ตั้งแต่ตอนแรก */
  async #ensurePendingUrl(created, url) {
    if (!created || typeof created.id !== "number") return;
    try {
      const gotUrl = String(created.pendingUrl ?? created.url ?? "");
      if (isIgnoredUrl(gotUrl)) {
        await this.#chrome.tabs.update(created.id, { url });
      }
    } catch { /* update ล้มเหลว — flow เดิมยังพยายาม discard/ตรวจซ้ำ */ }
  }

  /** ลง listener onUpdated ครั้งเดียวต่อ instance (มีชีวิตตลอด engine — เก็บ tick แท็บทุกตัวที่มี event) */
  #ensureCommitListener() {
    if (this.#commitArmed) return;
    this.#commitArmed = true;
    this.#chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (!changeInfo || (changeInfo.status === undefined && changeInfo.url === undefined && changeInfo.title === undefined)) return;
      this.#updatedTick += 1;
      this.#commitSeen.set(String(tabId), this.#updatedTick);
      const waiters = this.#commitWaiters.get(tabId);
      if (waiters) {
        this.#commitWaiters.delete(tabId);
        for (const settle of waiters) settle(); // navigation เริ่มจริงแล้ว — discard ได้โดยไม่ง้อ timeout
      }
    });
  }

  /**
   * รอ navigation ของแท็บเริ่มจริง (เห็น onUpdated ตั้งแต่ sinceTick เป็นต้นไป)
   * timeout คืน false — caller จะ discard ตามแผนเดิม (ไม่บล็อก restore นานเกิน)
   */
  async #waitForCommit(tabId, sinceTick = -1) {
    this.#ensureCommitListener();
    const seen = this.#commitSeen.get(String(tabId));
    if (seen !== undefined && seen >= sinceTick) return true;
    return new Promise(resolve => {
      const list = this.#commitWaiters.get(tabId) ?? new Set();
      const waiter = () => {
        const cur = this.#commitWaiters.get(tabId);
        if (cur) { cur.delete(waiter); }
        resolve(true);
      };
      list.add(waiter);
      this.#commitWaiters.set(tabId, list);
      globalThis.setTimeout(() => {
        if (this.#commitWaiters.get(tabId)?.delete(waiter)) resolve(false);
      }, this.#commitTimeoutMs);
    });
  }

  #lastSkipped = 0;

  async #pickTargetWindow() {
    const c = this.#chrome;
    let windowId = null;

    try {
      const last = await c.windows.getLastFocused();
      if (last && !last.incognito) windowId = last.id;
    } catch { /* ไม่มีหน้าต่างโฟกัส */ }

    if (windowId === null) {
      const all = (await c.windows.getAll({})) ?? [];
      const normal = all.find(w => !w.incognito);
      if (normal) windowId = normal.id;
    }

    if (windowId === null) {
      // ไม่มีหน้าต่างเลย — สร้างเอง (ผู้ใช้กดปุ่มเปิดถือเป็นอนุญาต)
      const created = await c.windows.create({ focused: false });
      return { windowId: created.id, createdWindow: true };
    }
    return { windowId, createdWindow: false };
  }

  /** เผื่อ debug/เทส: จำนวนที่ถูกข้ามล่าสุด */
  get lastSkipped() {
    return this.#lastSkipped;
  }
}

export { TAB_ID_NONE };
