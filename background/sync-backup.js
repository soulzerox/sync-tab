/**
 * SyncBackup — เงาสำรอง (แบบย่อ) ของคลังไปยัง chrome.storage.sync
 *
 * เหตุ: chrome.storage.local ไม่เคยโดน "ล้างแคช/ข้อมูลการท่องเว็บ" — จุดอ่อนจริงคือ
 * "ถอด extension แล้วติดตั้งใหม่", ล้างทั้ง profile, หรือเครื่องใหม่ (local ผูก profile เครื่องเดียว)
 * เงาสำรองนี้ผูกกับบัญชีที่ซิงก์ของเบราว์เซอร์ (Microsoft/Google) → กู้กลับได้ใน 3 เคสนั้น
 *
 * ข้อจำกัด API storage.sync: 1 key ≤ 8192 bytes, รวม ≤ 102400 bytes, ≤ 512 key
 * → เขียนแบบ compact + ตัด chunk ทีละชิ้น ≤ CHUNK_CHARS แล้วค่อยวางเมตาไว้ท้ายสุด
 * (meta ท้ายสุด: กันอ่านกลางคันระหว่างเขียน แล้วเจอ meta ใหม่ + chunk เก่า)
 */

import { SCHEMA_VERSION } from "../shared/constants.js";

const BACKUP_META_KEY = "groupsSyncBackup";
const CHUNK_PREFIX = "groupsSyncBackup#";

/** ขนาดสูงสุดของ d ต่อ chunk (อักขระ — JSON ASCII เกือบ 1 ตัวอักษร/ไบต์ เหลือช่องจาก 8192) */
const CHUNK_CHARS = 6800;
/** เงื่อนไขกันยิงถี่: เดิมล่าสุดยังเขียนมา < นี้ → ข้าม (เว้น force) */
const THROTTLE_MS = 5 * 60 * 1000;
/** กัน backing: payload รวมเกินนี้ → ข้ามเขียน (ไปไกลเกินกรณีจริงของคลังกลุ่มแท็บ) */
const MAX_PAYLOAD_CHARS = 128_000;
/** ย่อ title ในเงาสำรอง — ยาวชอบ ๆ; กู้กลับได้เก็บแค่พอจำหน้าตา */
const TITLE_MAX = 60;

export class SyncBackup {
  /**
   * @param {object} [opts]
   * @param {{ get, set, remove } | null | undefined} [opts.syncStorage] — chrome.storage.sync (ไม่มี → no-op ไม่พัง)
   * @param {() => number} [opts.now]
   * @param {number} [opts.chunkChars] inject เพื่อเทส chunking
   * @param {number} [opts.minIntervalMs] inject เพื่อเทส throttle
   */
  constructor({ syncStorage = null, now = Date.now, chunkChars = CHUNK_CHARS, minIntervalMs = THROTTLE_MS } = {}) {
    this.#sync = syncStorage ?? null;
    this.#now = now;
    this.#chunkChars = chunkChars;
    this.#minIntervalMs = minIntervalMs;
    this.#chain = Promise.resolve();
  }

  #sync;
  #now;
  #chunkChars;
  #minIntervalMs;
  #chain;            // คิวเขียนเรียงชุดเดียว — กัน set/remove ทับกันเอง
  #lastWriteAt = -Infinity;

  /** false เมื่อไม่มี sync storage (เทส/fake-chrome เก่า/extension ปิด sync) — เขียนกู้ทั้งหมด no-op */
  get available() {
    return this.#sync !== null;
  }

  /**
   * เขียนเงาสำรองของ schema — คืน true เมื่อเขียนจริง (ข้าม = throttled/noop → false)
   * @param {{ groups: Record<string, any> } | null} schema
   * @param {{ force?: boolean }} [opts]
   */
  writeSoon(schema, { force = false } = {}) {
    if (!this.#sync || !schema || typeof schema.groups !== "object" || schema.groups === null) return Promise.resolve(false);
    const t = this.#now();
    if (!force && t - this.#lastWriteAt < this.#minIntervalMs) return Promise.resolve(false);
    this.#lastWriteAt = t;
    const job = this.#chain
      .then(() => this.#writeNow(schema, t))
      .catch(() => false);
    this.#chain = job.then(() => undefined).catch(() => undefined);
    return job;
  }

  /** อ่านเงาสำรองกลับเป็นร่าง schema — เจอเสีย/ขาดชิ้น/เกินไป → null */
  async read() {
    if (!this.#sync) return null;
    try {
      const raw = await this.#sync.get(null);
      const meta = raw?.[BACKUP_META_KEY];
      if (!meta || typeof meta !== "object" || meta.v !== 1 || !Number.isInteger(meta.n) || meta.n < 1) return null;
      let json = "";
      for (let i = 0; i < meta.n; i += 1) {
        const chunk = raw?.[`${CHUNK_PREFIX}${i}`];
        if (!chunk || typeof chunk.d !== "string") return null;
        json += chunk.d;
      }
      const payload = JSON.parse(json);
      return SyncBackup.schemaFromPayload(payload, meta.at, this.#now());
    } catch {
      return null;
    }
  }

  async #writeNow(schema, at) {
    try {
      const json = JSON.stringify(SyncBackup.compact(schema));
      if (json.length > MAX_PAYLOAD_CHARS) return false; // ยักษ์ไม่ธรรมดา — ข้าม ยอมรับว่าเกินขอบเขตเงาสำรอง
      const n = Math.max(1, Math.ceil(json.length / this.#chunkChars));
      const chunks = {};
      for (let i = 0; i < n; i += 1) {
        chunks[`${CHUNK_PREFIX}${i}`] = { i, d: json.slice(i * this.#chunkChars, (i + 1) * this.#chunkChars) };
      }
      // ล้าง chunk เก่าส่วนเกินก่อน (กัน n ใหม่เล็กกว่าชุดเดิมแล้วอ่านต่อยาวเกิน)
      const raw = await this.#sync.get(null);
      const stale = Object.keys(raw ?? {}).filter(k => k.startsWith(CHUNK_PREFIX) && !(k in chunks));
      if (stale.length > 0) await this.#sync.remove(stale);
      await this.#sync.set(chunks); // ชิ้นข้อมูลก่อน
      await this.#sync.set({ [BACKUP_META_KEY]: { v: 1, at, n } }); // เมตาท้ายสุด — อ่านสำเร็จ = ชุดครบเท่านั้น
      return true;
    } catch {
      return false; // sync ปิดอยู่/quota เต็ม/ดับกลางคัน — คลัง local ยังใช้ได้ ห้ามพังตาม
    }
  }

  /**
   * ย่อ schema → payload เบา: { v, groups: { [name]: { c: color, t: [[url, title60], ...order] } } }
   * เก็บแค่พอ rebuild record idle (liveCount 0) — ไม่เก็บ favIcon/live/id ภายใน
   */
  static compact(schema) {
    const groups = {};
    for (const [name, record] of Object.entries(schema.groups ?? {})) {
      if (typeof name !== "string" || !record || typeof record.tabs !== "object") continue;
      const rows = Object.values(record.tabs ?? {})
        .filter(t => t && typeof t.url === "string" && t.url !== "")
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(t => [t.url, String(t.title ?? "").slice(0, TITLE_MAX)]);
      if (rows.length === 0) continue;
      groups[name] = { c: record.color ?? "grey", t: rows };
    }
    return { v: SCHEMA_VERSION, groups };
  }

  /**
   * แตก payload กลับเป็นร่าง schema — caller (group-store.init) ต้องเติม restoredFromSyncAt เอง
   * @param {*} payload
   * @param {number} [at] เวลากำเนิดเงาสำรอง (meta.at)
   * @param {() => number} [now]
   */
  static schemaFromPayload(payload, at, now = Date.now) {
    if (!payload || typeof payload !== "object" || typeof payload.groups !== "object" || payload.groups === null) return null;
    const stamp = Number.isFinite(at) ? at : now();
    const groups = {};
    for (const [name, pack] of Object.entries(payload.groups ?? {})) {
      if (typeof name !== "string" || !pack || !Array.isArray(pack.t)) continue;
      const tabs = {};
      let order = -1; // 0-based — ตรง convention ของ store (nextOrder เริ่ม max=-1 → 0)
      for (const row of pack.t) {
        const u = Array.isArray(row) ? row[0] : row?.url;
        const title = Array.isArray(row) ? row[1] : row?.title;
        if (typeof u !== "string" || u === "") continue;
        order += 1;
        tabs[u] = { url: u, title: String(title ?? "").slice(0, TITLE_MAX), order, addedAt: stamp, lastLiveAt: stamp, liveCount: 0 };
      }
      if (Object.keys(tabs).length === 0) continue;
      groups[name] = { name, color: typeof pack.c === "string" ? pack.c : "grey", createdAt: stamp, updatedAt: stamp, liveWindowIds: [], tabs };
    }
    if (Object.keys(groups).length === 0) return null;
    return { version: SCHEMA_VERSION, groups, liveTabs: {}, restoredTabIds: {} };
  }
}

export { BACKUP_META_KEY, CHUNK_PREFIX, CHUNK_CHARS, THROTTLE_MS };
