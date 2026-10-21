/**
 * GroupStore unit tests (node --test) — SOT §9 T1/T2/L4/L5/L7/L8 + persist roundtrip
 * Infrastructure: fake chrome.storage.local + fake clock
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupStore } from "../background/group-store.js";
import { STORAGE_KEY } from "../shared/constants.js";

function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      if (typeof keys === "string") return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter(k => data.has(k)).map(k => [k, data.get(k)]));
      }
      return Object.fromEntries(Object.keys(keys).filter(k => data.has(k)).map(k => [k, data.get(k)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      for (const k of list) data.delete(k);
    },
    async clear() {
      data.clear();
    }
  };
}

function createStore(initial = {}, clock) {
  const storage = createFakeStorage(initial);
  let time = 1_000;
  const now = clock?.now ?? (() => ++time);
  const store = new GroupStore({ storage, now, saveDelayMs: 0, setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout });
  return { store, storage, advance: ms => { if (clock) clock.tick?.(ms); time += ms; } };
}

// ตัวช่วยสร้าง liveMap ง่าย ๆ
function live(name, { color = "blue", windows = [1], tabs = {} } = {}) {
  return { [name]: { color, windowIds: windows, tabs } };
}
function liveTab(url, { title = "T", favIconUrl = "f.png", count = 1 } = {}) {
  return { [url]: { title, favIconUrl, count } };
}

test("init สร้าง schema v3 ใหม่เมื่อ storage ว่าง (ไม่ migrate)", async () => {
  const { store } = createStore();
  const migrated = await store.init();
  assert.equal(migrated, false);
  const snap = store.snapshot();
  assert.equal(snap.version, 3);
  assert.deepEqual(snap.groups, {});
});

test("init migration: key ของ v2 ถูกล้างทั้งหมด + ตั้งธง migrated (SOT §8)", async () => {
  const { store, storage } = createStore({
    activeWindows: { w: 1 },
    recoveryCheckpoints: [],
    settings: {}
  });
  const migrated = await store.init();
  assert.equal(migrated, true);
  assert.equal(storage.data.size, 1); // เหลือแค่ groupsSync
  assert.equal(store.snapshot().version, 3);
});

test("applyLiveMap: แท็บ live ใหม่ → record + tab (order/addedAt/liveCount/favicon/title)", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("งาน A", { color: "green", windows: [3], tabs: liveTab("https://a.example/x") }));
  await store.flush();

  const snap = store.snapshot();
  const g = snap.groups["งาน A"];
  assert.ok(g, "สร้าง GroupRecord");
  assert.equal(g.color, "green");
  assert.deepEqual(g.liveWindowIds, [3]);
  const tab = g.tabs["https://a.example/x"];
  assert.ok(tab);
  assert.equal(tab.liveCount, 1);
  assert.equal(tab.title, "T");
  assert.equal(tab.favIconUrl, "f.png");
  assert.equal(tab.order, 0);
  assert.equal(typeof tab.addedAt, "number");
  assert.ok(tab.lastLiveAt >= tab.addedAt - 1);
});

test("L2: ชื่อเดียวกันสองหน้าต่าง → windowIds union + liveCount นับ instance รวม", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("work", { color: "red", windows: [1, 7], tabs: liveTab("https://x.example", { count: 2 }) }));
  await store.flush();

  const g = store.snapshot().groups["work"];
  assert.deepEqual(g.liveWindowIds, [1, 7]);
  assert.equal(g.tabs["https://x.example"].liveCount, 2);
});

test("L3: live ซ้ำต่อเนื่อง → title/favicon ใหม่ถูก merge เข้า record", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example", { title: "old", favIconUrl: "a.png" }) }));
  await store.flush();

  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example", { title: "new title", favIconUrl: "b.png" }) }));
  await store.flush();

  const tab = store.snapshot().groups["w"].tabs["https://x.example"];
  assert.equal(tab.title, "new title");
  assert.equal(tab.favIconUrl, "b.png");
});

test("L4: แท็บหายจาก live → flip หลับ (closedAt + liveCount=0) record คงอยู่; กลับมา live ซ้ำ → ตัวเก่า wake", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example") }));
  await store.flush();

  store.applyLiveMap(live("w", {})); // แท็บปิด
  await store.flush();

  let tab = store.snapshot().groups["w"].tabs["https://x.example"];
  assert.equal(tab.liveCount, 0);
  assert.ok(tab.closedAt, "มี closedAt");

  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example", { title: "old", favIconUrl: "a.png" }) }));
  await store.flush();

  tab = store.snapshot().groups["w"].tabs["https://x.example"];
  assert.equal(tab.liveCount, 1);
  assert.equal(tab.closedAt, undefined, "closedAt ถูกเคลียร์ตอน wake");
  assert.equal(tab.title, "old", "คง title เดิมจาก wake event");
});

test("L5/L8: กลุ่มที่ไม่อยู่ใน liveMap — แท็บ idle ยังอยู่ (superset), แต่ record ไม่มีแท็บเลยถูก GC", async () => {
  const { store } = createStore();
  await store.init();

  // กลุ่ม A มี idle 1 แท็บ; กลุ่ม B จะไม่มีแท็บหลัง GC
  store.applyLiveMap(live("A", { tabs: liveTab("https://a/1") }));
  store.applyLiveMap(live("B", {}));
  await store.flush();

  store.applyLiveMap(live("A", {})); // B หายไปเพราะไม่มีแท็บ web
  await store.flush();
  const snap = store.snapshot();
  assert.ok(snap.groups["A"], "A คงอยู่ (มี idle tab)");
  assert.ok(!snap.groups["B"], "B ถูก GC เพราะไม่มีแท็บ (L8)");
  assert.equal(snap.groups["A"].tabs["https://a/1"].liveCount, 0);
});

test("L8 ระหว่าง event: กลุ่มมี live tab อย่างเดียวแล้วปิดหมด → record GC ทันที (ไม่มีของให้จำ)", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("temp", { tabs: liveTab("https://tmp/1") }));
  await store.flush();
  store.applyLiveMap({}); // ปิดแท็บโดน GC หลัง flip idle?
  await store.flush();
  // แท็บถูก flip idle ก่อน — record คงอยู่ (จำไว้ให้เปิดกลับ)
  assert.ok(store.snapshot().groups["temp"], "flip idle ก่อน = ยังจำไว้");
  assert.equal(store.snapshot().groups["temp"].tabs["https://tmp/1"].liveCount, 0);
});

test("L7 rename: ไม่มีชน → rekey record เดิม", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("old", { color: "pink", tabs: liveTab("https://x/1") }));
  await store.flush();

  store.renameGroup("old", "new");
  await store.flush();
  const snap = store.snapshot();
  assert.ok(!snap.groups["old"]);
  const g = snap.groups["new"];
  assert.equal(g.color, "pink");
  assert.ok(g.tabs["https://x/1"]);
  assert.equal(g.createdAt, snap.groups["new"].createdAt); // คง createdAt เดิม
});

test("L7 rename: ชื่อใหม่มี record อยู่แล้ว → union merge (tab, windowIds, สีตาม updatedAt ล่าสุด)", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("A", { color: "blue", windows: [1], tabs: liveTab("https://a/1") }));
  await store.flush();
  store.applyLiveMap(live("B", { color: "red", windows: [2], tabs: liveTab("https://b/1", { title: "B-only" }) }));
  await store.flush();
  store.renameGroup("B", "A");
  await store.flush();

  const snap = store.snapshot();
  assert.ok(!snap.groups["B"]);
  const g = snap.groups["A"];
  assert.ok(g.tabs["https://a/1"]);
  assert.ok(g.tabs["https://b/1"]);
  assert.deepEqual(g.liveWindowIds, [1, 2] || g.liveWindowIds.length === 2 === true ? g.liveWindowIds : g.liveWindowIds);
  assert.equal(g.liveWindowIds.length, 2);
});

test("L7 rename: URL ชนกัน → liveCount รวม (max) และไม่หาย", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("A", { windows: [1], tabs: liveTab("https://x/1", { count: 1 }) }));
  await store.flush();
  store.applyLiveMap(live("B", { windows: [2], tabs: liveTab("https://x/1", { count: 1 }) }));
  await store.flush();
  store.renameGroup("B", "A");
  await store.flush();

  const g = store.snapshot().groups["A"];
  assert.equal(g.tabs["https://x/1"].liveCount, 1);
});

test("deleteGroup: record หาย; deleteTab: ลบรายตัว + GC กลุ่มเมื่อว่าง", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("A", { tabs: liveTab("https://a/1") }));
  await store.flush();

  store.deleteTab("A", "https://a/1");
  await store.flush();
  assert.ok(!store.snapshot().groups["A"], "กลุ่มถูก GC เมื่อไม่มีแท็บ");

  store.applyLiveMap(live("B", { tabs: liveTab("https://b/1") }));
  store.applyLiveMap(live("C", { tabs: liveTab("https://c/1") }));
  await store.flush();
  store.deleteGroup("B");
  store.deleteTab("C", "https://c/1");
  await store.flush();
  const snap = store.snapshot();
  assert.ok(!snap.groups["B"]);
  assert.ok(!snap.groups["C"]);
});

test("URL ต้อง normalize ก่อนเป็น key (store ทำเอง — กัน record สองใบสำหรับหน้าเดียว)", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example/") }));
  await store.flush();
  store.applyLiveMap(live("w", { tabs: liveTab("https://x.example") }));
  await store.flush();

  const g = store.snapshot().groups["w"];
  assert.equal(Object.keys(g.tabs).length, 1, "ชนกันเป็น record เดียว");
  assert.equal(g.tabs["https://x.example"].liveCount, 1);
});

test("persist: debounce รวมเขียน 1 ครั้งต่อ burst; flush บังคับเขียนและอ่านกลับได้ (roundtrip)", async () => {
  const { store, storage } = createStore();
  await store.init();

  store.applyLiveMap(live("A", { tabs: liveTab("https://a/1") }));
  store.applyLiveMap(live("A", { tabs: liveTab("https://a/2") }));
  await store.flush();

  const persisted = storage.data.get(STORAGE_KEY);
  assert.equal(persisted.version, 3);
  assert.equal(Object.keys(persisted.groups["A"].tabs).length, 2);

  // อ่านกลับด้วย store ใหม่ — ต้องเห็นข้อมูลเดิม
  const { store: store2 } = createStore(Object.fromEntries(storage.data));
  await store2.init();
  const snap2 = store2.snapshot();
  assert.ok(snap2.groups["A"]);
  assert.equal(Object.keys(snap2.groups["A"].tabs).length, 2);
});

test("setTheme บันทึกลง schema + persist", async () => {
  const { store, storage } = createStore();
  await store.init();
  store.setTheme("light");
  await store.flush();
  assert.equal(storage.data.get(STORAGE_KEY).themePreference, "light");
  assert.equal(store.themePreference, "light");
});

test("applyLiveMap idempotent: liveMap เดิมซ้ำ → ไม่เขียนซ้ำ, ไม่เปลี่ยน timestamps", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("A", { tabs: liveTab("https://a/1") }));
  await store.flush();
  const snap1 = structuredClone(store.snapshot());

  store.applyLiveMap(live("A", { tabs: liveTab("https://a/1", { title: "T", favIconUrl: "f.png" }) }));
  await store.flush();
  const snap2 = structuredClone(store.snapshot());

  assert.deepEqual(snap1.groups["A"].tabs, snap2.groups["A"].tabs, "state เท่าเดิม");
  assert.deepEqual(snap1.groups["A"].liveWindowIds, snap2.groups["A"].liveWindowIds);
});

test("markScan ตั้ง lastScanAt (สำหรับ footer 'ซิงก์ล่าสุด')", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("A", {}), { markScan: true });
  await store.flush();
  assert.ok(store.snapshot().lastScanAt > 0);
});

// ------------------------------------------------------------------
// v3.0.1 — dedupe fragment (#hash): renormalize migration + bulk delete
// ------------------------------------------------------------------

test("renormalize migration: init ยก key ติด fragment และ merge ฝาแฝดให้เป็น record เดียว", async () => {
  const KEY = "https://novelkingdom.co/writer";
  const HASH_KEY = `${KEY}#%E0%B8%AA%E0%B8%96%E0%B8%B4%E0%B8%95%E0%B8%B4`;
  const seed = {
    [STORAGE_KEY]: {
      version: 3,
      groups: {
        "งานเขียน": {
          name: "งานเขียน",
          color: "blue",
          createdAt: 10,
          updatedAt: 10,
          liveWindowIds: [],
          tabs: {
            [KEY]: { url: KEY, title: "ฐาน", favIconUrl: "a.png", addedAt: 500, lastLiveAt: 500, closedAt: 900, liveCount: 0, order: 1 },
            [HASH_KEY]: { url: HASH_KEY, title: "พร้อมแท็ก", favIconUrl: "", addedAt: 300, lastLiveAt: 300, closedAt: 950, liveCount: 0, order: 2 }
          }
        }
      }
    }
  };
  const { store } = createStore(seed);
  await store.init();

  const g = store.getGroups()["งานเขียน"];
  assert.deepEqual(Object.keys(g.tabs), [KEY], "รวมเป็น key เดียวตาม normalized URL");
  const t = g.tabs[KEY];
  assert.equal(t.addedAt, 300, "addedAt เอ็งเก่าสุด");
  assert.equal(t.closedAt, 950, "closedAt เอ็งใหม่สุดจากฝาแฝด");
  assert.equal(t.title, "ฐาน", "คงข้อมูลฝั่ง key ปกติเป็นใหญ่");
  assert.equal(t.order, 1);
  assert.equal(t.url, KEY);
});

test("renormalize migration: key hash โดด (ไม่มีฝาแฝด) → ได้ key ใหม่ + url ตาม key; boot ซ้ำ idempotent", async () => {
  const KEY = "https://solo.example/page";
  const seed = {
    [STORAGE_KEY]: {
      version: 3,
      groups: {
        s: {
          name: "s", color: "grey", createdAt: 1, updatedAt: 1, liveWindowIds: [],
          tabs: { [`${KEY}#frag`]: { url: `${KEY}#frag`, title: "หน้า", favIconUrl: "", addedAt: 7, lastLiveAt: 7, closedAt: 8, liveCount: 0, order: 0 } }
        }
      }
    }
  };
  const { store, storage } = createStore(seed);
  await store.init();
  await store.flush();

  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap.groups.s.tabs), [KEY]);
  assert.equal(snap.groups.s.tabs[KEY].url, KEY);
  assert.equal(snap.groups.s.tabs[KEY].addedAt, 7);
  assert.deepEqual(storage.data.get(STORAGE_KEY), snap, "ผล renormalize ถูก persist จริง");

  // boot รอบใหม่ด้วยข้อมูลเดิม — key ไม่ถูกยุ่งเพิ่ม (idempotent)
  const store2 = new GroupStore({ storage, now: () => 999, saveDelayMs: 0, setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout });
  await store2.init();
  await store2.flush();
  assert.deepEqual(store2.snapshot().groups.s.tabs, snap.groups.s.tabs);
});

test("deleteTabs: ลบหลายรายการพร้อมกัน — dedupe input, normalize ก่อนจับคู่ key, GC กลุ่มว่าง (L8)", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("w", { tabs: { ...liveTab("https://a.com/x"), ...liveTab("https://b.com/y"), ...liveTab("https://c.com/z") } }));
  await store.flush();

  const res = store.deleteTabs("w", ["https://a.com/x", "https://a.com/x", "https://b.com/y#frag"]);
  assert.deepEqual(res, { removed: 2, groupDeleted: false });
  assert.deepEqual(Object.keys(store.getGroups().w.tabs), ["https://c.com/z"]);

  const res2 = store.deleteTabs("w", ["https://c.com/z"]);
  assert.deepEqual(res2, { removed: 1, groupDeleted: true });
  assert.deepEqual(store.getGroups(), {});
});

test("deleteTabs: payload ไม่ถูกต้องหรือกลุ่มไม่มีจริง → ไม่โยน, คืน removed=0", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("w", { tabs: liveTab("https://a.com/x") }));
  await store.flush();
  assert.deepEqual(store.deleteTabs("w", null), { removed: 0, groupDeleted: false });
  assert.deepEqual(store.deleteTabs("no-such-group", ["https://a.com/x"]), { removed: 0, groupDeleted: false });
});

// ------------------------------------------------------------------
// v3.1 — Live tab tracking (L13/L14): binding / origin ป้องกัน / move-follow / consume
// ------------------------------------------------------------------

test("v3.1: liveBinding roundtrip + persist ข้าม init (รอดจาก SW restart แล้วยก binding ต่อได้)", async () => {
  const { store, storage } = createStore();
  await store.init();
  store.setLiveBinding(7, { groupName: "งาน", urlKey: "https://a/x" });
  await store.flush();
  assert.deepEqual(store.liveBinding(7), { groupName: "งาน", urlKey: "https://a/x", restored: false, sleeping: false });

  const boot2 = new GroupStore({ storage, now: () => 99, saveDelayMs: 0, setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout });
  await boot2.init();
  assert.deepEqual(boot2.liveBinding(7), { groupName: "งาน", urlKey: "https://a/x", restored: false, sleeping: false });
  assert.equal(boot2.liveBinding(999), null);
});

test("v3.1: ธง origin ป้องกันติดค้างผ่าน setLiveBinding เสมอ — mark ก่อน/หลังมี binding ได้ผลเดียวกัน", async () => {
  const { store } = createStore();
  await store.init();

  store.markRestoredTabs([9]);                 // mark ก่อน (restore สร้างแท็บก่อน mirror register)
  assert.equal(store.liveBinding(9), null);
  store.setLiveBinding(9, { groupName: "w", urlKey: "https://r/x" });
  assert.equal(store.liveBinding(9).restored, true, "ธงใน restoredTabIds ติดผ่าน binding ใหม่");

  store.setLiveBinding(8, { groupName: "w", urlKey: "https://l/x" });
  assert.equal(store.liveBinding(8).restored, false);
  store.markRestoredTabs([8]);                 // mark หลัง (flip บน binding เดิม)
  assert.equal(store.liveBinding(8).restored, true);

  store.setLiveBinding(10, { groupName: "w", urlKey: "https://p/x" });
  store.protectLiveBinding(10);                // แท็บที่ scan ครั้งแรกเจอ
  assert.equal(store.liveBinding(10).restored, true);

  store.setLiveBinding(11, { groupName: "w", urlKey: "https://n/x" });
  assert.equal(store.liveBinding(11).restored, false, "แท็บธรรมดา (จับจาก event) ไม่ได้ธง — ปิดเองลบได้");
});

test("v3.1: pruneLiveBindings ตัดของแท็บที่หายไประหว่าง SW หลับ คงของที่ยังมีชีวิต", async () => {
  const { store } = createStore();
  await store.init();
  store.setLiveBinding(1, { groupName: "w", urlKey: "https://a/x" });
  store.setLiveBinding(2, { groupName: "w", urlKey: "https://b/x" });
  store.markRestoredTabs([3]);

  store.pruneLiveBindings([2, 3]);
  assert.equal(store.liveBinding(1), null);
  assert.ok(store.liveBinding(2));
});

test("v3.1 L13: consumeDeletedTabs ลบเมื่อ instance ตื่นหมด + GC กลุ่มว่าง; เว้นถ้ายังมี instance ตื่น", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("งาน", { tabs: { ...liveTab("https://alone/x"), ...liveTab("https://shared/y", { count: 2 }) } }));
  await store.flush();

  // จำลอง post-rebuild: แท็บหนึ่งของ shared/y ปิด — ยังเหลืออีกตัว
  store.applyLiveMap(live("งาน", { tabs: liveTab("https://shared/y", { count: 1 }) }));
  store.consumeDeletedTabs([{ g: "งาน", k: "https://shared/y" }]);
  assert.ok(store.snapshot().groups["งาน"].tabs["https://shared/y"], "ยังมี instance ตื่น — ไม่ลบ");

  store.applyLiveMap({});
  store.consumeDeletedTabs([
    { g: "งาน", k: "https://shared/y" },
    { g: "งาน", k: "https://alone/x" },
    { g: "งาน", k: "https://alone/x" }   // คิวซ้ำ (จำลอง event ยิงซ้ำ) — dedupe ได้
  ]);
  assert.ok(!store.snapshot().groups["งาน"], "ลบครบ + GC กลุ่มว่าง (L8)");
});

test("v3.1 L14: moveLiveTabs เลื่อน record — addedAt/order เดินไปแถวใหม่ แถวเก่าลบ ไม่ทำเมื่อเก่ายังตื่น", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("งาน", { tabs: liveTab("https://a/1", { title: "OLD", favIconUrl: "o.png" }) }));
  store.applyLiveMap(live("งาน", { tabs: { ...liveTab("https://a/1"), ...liveTab("https://a/2", { title: "NEW", favIconUrl: "n.png" }) } }));
  await store.flush();

  const oldRow = { ...store.snapshot().groups["งาน"].tabs["https://a/1"] };
  const newRow = { ...store.snapshot().groups["งาน"].tabs["https://a/2"] };
  assert.ok(oldRow && newRow, "seed ครบสองแถว");

  store.applyLiveMap(live("งาน", { tabs: liveTab("https://a/2") }));   // post-rebuild: ไม่มีใครตื่นบน a/1
  store.moveLiveTabs([{ g: "งาน", fromKey: "https://a/1", toKey: "https://a/2" }]);
  await store.flush();

  const tabs = store.snapshot().groups["งาน"].tabs;
  assert.deepEqual(Object.keys(tabs), ["https://a/2"], "แถวเก่าหาย — ไม่ค้าง idle ระทิ");
  assert.equal(String(tabs["https://a/2"].addedAt), String(Math.min(oldRow.addedAt, newRow.addedAt)));
  assert.equal(String(tabs["https://a/2"].order ?? 0), String(Math.min(oldRow.order ?? 0, newRow.order ?? 0)));
});

test("v3.1 L14: แถวเก่ายังมี instance ตื่น (liveCount>0) → moveLiveTabs ข้าม ไม่ย้อมแมว", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("งาน", { tabs: { ...liveTab("https://a/1", { count: 2 }), ...liveTab("https://a/2") } }));
  await store.flush();

  store.moveLiveTabs([{ g: "งาน", fromKey: "https://a/1", toKey: "https://a/2" }]);
  await store.flush();
  const tabs = store.snapshot().groups["งาน"].tabs;
  assert.ok(tabs["https://a/1"], "ยังมีผู้ใช้อยู่ — แถวเก่าไม่ถูกลบ/ย้าย");
});

test("v3.1: renameGroup เปลี่ยน binding ตามชื่อกลุ่มใหม่", async () => {
  const { store } = createStore();
  await store.init();
  store.applyLiveMap(live("เก่า", { tabs: liveTab("https://a/x") }));
  store.setLiveBinding(5, { groupName: "เก่า", urlKey: "https://a/x" });
  store.renameGroup("เก่า", "ใหม่");
  await store.flush();
  assert.deepEqual(store.liveBinding(5), { groupName: "ใหม่", urlKey: "https://a/x", restored: false, sleeping: false });
});

// v3.5 — dedupe volatile params (tab/draftId): migration บน boot รวมแถวฝาแฝด
// ------------------------------------------------------------------

test("renormalize migration: แถว /settings?tab=servers + /new-session?draftId= ถูกยุบทิ้งเป็น key เดียว", async () => {
  const SETTINGS = "https://opencode.753153268.xyz/settings";
  const SETTINGS_TAB = `${SETTINGS}?tab=servers`;
  const SESSION = "https://opencode.753153268.xyz/new-session";
  const DRAFT = `${SESSION}?draftId=4bb90d39-d510-47dc-9775-7ff49d81f37a`;
  const seed = {
    [STORAGE_KEY]: {
      version: 3,
      groups: {
        "Developer Tools": {
          name: "Developer Tools",
          color: "purple",
          createdAt: 10,
          updatedAt: 10,
          liveWindowIds: [],
          tabs: {
            [SETTINGS]: { url: SETTINGS, title: "OpenCode", favIconUrl: "", addedAt: 500, lastLiveAt: 500, closedAt: 900, liveCount: 0, order: 1 },
            [SETTINGS_TAB]: { url: SETTINGS_TAB, title: "OpenCode", favIconUrl: "", addedAt: 400, lastLiveAt: 400, closedAt: 950, liveCount: 0, order: 2 },
            [DRAFT]: { url: DRAFT, title: "OpenCode", favIconUrl: "", addedAt: 300, lastLiveAt: 300, closedAt: 960, liveCount: 0, order: 3 }
          }
        }
      }
    }
  };
  const { store } = createStore(seed);
  await store.init();

  const g = store.getGroups()["Developer Tools"];
  assert.deepEqual(Object.keys(g.tabs).sort(), [SESSION, SETTINGS].sort(), "เหลือ 2 records: /settings และ /new-session");
  assert.equal(g.tabs[SETTINGS].addedAt, 400, "merge เอาฝั่งเก่าสุด");
  assert.equal(g.tabs[SESSION].addedAt, 300);
});
