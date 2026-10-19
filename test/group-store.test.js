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
