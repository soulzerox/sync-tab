/**
 * SyncTab Group Sync v3 — Service Worker (SOT v3.0.0 §3)
 *
 * โครง: ลงทะเบียน chrome listeners แบบ synchronous ตอน service worker ตื่น (MV3)
 * แล้วทั้งหมดวิ่งผ่าน: BrowserMirror (event→state), GroupStore (seam), RestoreEngine (เปิดกลับ)
 * Message router (typed RPC, SOT §4) — response ทุกตัว { ok: true, ... } | { ok: false, error }
 */

import { MSG } from "../shared/messages.js";
import { GroupStore } from "./group-store.js";
import { BrowserMirror } from "./browser-mirror.js";
import { RestoreEngine } from "./restore-engine.js";

const API = self.chrome;

const store = new GroupStore({ storage: API.storage.local });
const mirror = new BrowserMirror({ chrome: API, store });
const restore = new RestoreEngine({ chrome: API, store });

// ลงทะเบียน event listeners ทันที (กฎ MV3: sync ระหว่าง first tick ของ SW)
// attach() จะเรียก reconcile() ตามหลัง (ครอบ startup ทุกเคส: install/update/wake)
mirror.attach();

// init รอบเดียวต่อ SW lifetime — onMessage ตัวไหนมาก่อนก็รอ waiter นี้ (กัน init ซ้อนกัน)
const initWaiter = store.init()
  .then(async migrated => {
    if (migrated) store.markMigrationNotice(); // SOT §8 — toast ครั้งแรกใน popup
    else await mirror.reconcile();             // normal wake — ตรวจสถานะเท่านั้น (L10 ไม่เปิดแท็บ)
  })
  .catch(async () => {
    await mirror.reconcile();
  });

initWaiter.catch(() => { /* โยนไปที่ .catch ด้านบนแล้ว */ });

API.runtime.onInstalled.addListener(() => {
  void initWaiter.then(() => mirror.reconcile()).catch(() => { /* noop */ });
});

API.runtime.onStartup.addListener(() => {
  void initWaiter.then(() => mirror.reconcile()).catch(() => { /* noop */ });
});

// ------------------------------------------------------------------
// Message router
// ------------------------------------------------------------------
API.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: String(err?.message ?? err).slice(0, 160) }));
  return true; // ตอบแบบ async
});

async function handleMessage(msg) {
  if (!msg || typeof msg.type !== "string") return { ok: false, error: "bad-message" };

  switch (msg.type) {
    case MSG.GET_STATE: {
      await ensureStoreReady();
      mirror.flushSync();          // กลืน pending event burst ให้ state ทันสมัยสุด
      await store.flush();
      const snapshot = store.snapshot();
      return {
        ok: true,
        version: snapshot.version,
        groups: snapshot.groups,
        themePreference: snapshot.themePreference ?? "dark",
        lastScanAt: snapshot.lastScanAt ?? null,
        showMigrationNotice: store.consumeMigrationNotice()
      };
    }

    case MSG.OPEN_TABS: {
      await ensureStoreReady();
      const { groupName, urls } = msg.payload ?? {};
      if (typeof groupName !== "string" || !Array.isArray(urls)) return { ok: false, error: "bad-payload" };
      const result = await restore.openTabs({ name: groupName, urls });
      if (result.ok) scheduleScanAfterRestore(); // ให้ mirror จับแท็บที่เพิ่ง restore ชัวร์ (แม้ event มายังไม่ครบ)
      return { ...result, type: MSG.OPEN_TABS };
    }

    case MSG.DELETE_GROUP: {
      await ensureStoreReady();
      const { groupName } = msg.payload ?? {};
      if (typeof groupName !== "string") return { ok: false, error: "bad-payload" };
      store.deleteGroup(groupName);
      await store.flush();
      return { ok: true };
    }

    case MSG.DELETE_TAB: {
      await ensureStoreReady();
      const { groupName, url } = msg.payload ?? {};
      if (typeof groupName !== "string" || typeof url !== "string") return { ok: false, error: "bad-payload" };
      store.deleteTab(groupName, url);
      await store.flush();
      return { ok: true };
    }

    case MSG.DELETE_TABS: {
      await ensureStoreReady();
      const { groupName, urls } = msg.payload ?? {};
      if (typeof groupName !== "string" || !Array.isArray(urls)) return { ok: false, error: "bad-payload" };
      const result = store.deleteTabs(groupName, urls);
      await store.flush();
      return { ok: true, ...result };
    }

    case MSG.RENAME_GROUP: {
      await ensureStoreReady();
      const { groupName, newName } = msg.payload ?? {};
      if (typeof groupName !== "string" || typeof newName !== "string" || !newName.trim()) {
        return { ok: false, error: "bad-payload" };
      }
      store.renameGroup(groupName, newName.trim());
      await renameLiveGroups(groupName, newName.trim()); // สองทาง — L7 (chrome API side)
      await store.flush();
      return { ok: true };
    }

    case MSG.SET_THEME: {
      await ensureStoreReady();
      const { theme } = msg.payload ?? {};
      store.setTheme(theme);
      await store.flush();
      return { ok: true, theme: store.themePreference };
    }

    default:
      return { ok: false, error: "unknown-message" };
  }
}

async function ensureStoreReady() {
  await initWaiter; // boot ประกาศ waiter ไว้แล้ว — ข้อความที่มาก่อน init จบก็รอที่เดียวกัน
}

/** หลัง restore เปิดแท็บ — เดิน mirror อีกหน เพื่อไม่ให้สถานะค้างหลับเทยๆ หาก title event ยังไม่ยิง */
function scheduleScanAfterRestore() {
  globalThis.setTimeout(() => {   // ผ่าน globalThis — กัน Illegal invocation (Edge SW)
    mirror.flushSync();
  }, 1_200);
}

/** tabGroups ที่มีชีวิตในเบราว์เซอร์ — ตามชื่อเดิม เปลี่ยน title ตามคำสั่ง rename (สองทาง) */
async function renameLiveGroups(oldName, newName) {
  try {
    const groups = await API.tabGroups.query({});
    for (const g of groups) {
      if ((g.title ?? "").trim() === oldName && g.title !== newName) {
        await API.tabGroups.update(g.id, { title: newName });
      }
    }
  } catch {
    /* ประเมินว่า tabGroups API หรือกรุ๊ปหายไปก่อนเงียบ ๆ — record ย้ายแล้ว */
  }
}
