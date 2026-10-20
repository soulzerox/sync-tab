/**
 * BrowserMirror unit tests (node --test) — Sync Laws L1–L8 + reconcile (SOT §9 T1–T8)
 * ฐานเทส: fake chrome + ยิง event handlers หน้าสนิมแบบเดียวกับที่ Edge ส่งมา
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserMirror } from "../background/browser-mirror.js";
import { GroupStore } from "../background/group-store.js";
import { createFakeChrome, tabEvent } from "./helpers/fake-chrome.js";

/** harness — คืน { chrome, store, mirror } พร้อม rebuild แบบ sync เพื่อ assert state */
function harness(seed = {}) {
  const chrome = createFakeChrome(seed);
  let time = 1_000;
  const store = new GroupStore({ storage: chrome.storage.local, now: () => ++time, saveDelayMs: 0 });
  const mirror = new BrowserMirror({ chrome, store, emitDebounceMs: 0 });
  return { chrome, store, mirror };
}

/** ปลูก idle record ด้วย API ของ store เอง (live ชั่วคราวแล้ว retire) — กัน GC กินรอบ */
function seedIdleRecord(store, name, url, color = "blue") {
  store.applyLiveMap({ [name]: { color, windowIds: [], tabs: { [url]: { title: "x", favIconUrl: "", count: 1 } } } });
  store.applyLiveMap({});
}

test("L1: แท็บที่ไม่มีกลุ่ม ไม่ถูกจับ (ungrouped ไปเลย)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleTabUpdated(120, { groupId: -1 }, tabEvent({ id: 120, url: "https://x.example", groupId: -1 }));
  mirror.flushSync();

  assert.deepEqual(Object.keys(store.snapshot().groups), []);
});

test("L1: กลุ่มไม่มีชื่อ → แท็บในนั้นไม่เข้าคลัง; พอตั้งชื่อค่อยเข้า", async () => {
  const { chrome, store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 200, title: "", color: "grey", windowId: 101 });
  mirror.handleTabUpdated(130, { groupId: 200 }, tabEvent({ id: 130, url: "https://x.example", groupId: 200 }));
  mirror.flushSync();
  assert.deepEqual(Object.keys(store.snapshot().groups), [], "ยังไม่จับ");

  // Edge เรียก onUpdated เมื่อผู้ใช้ตั้งชื่อ
  mirror.handleGroupUpdated({ id: 200, title: "ที่ทำงาน", windowId: 101, color: "blue" });
  mirror.flushSync();
  await store.flush();
  const groups = store.snapshot().groups;
  assert.ok(groups["ที่ทำงาน"], "เมื่อมีชื่อจับทันที");
  assert.ok(groups["ที่ทำงาน"].tabs["https://x.example"]);
});

test("L1: URL พิเศษ (edge://) และฟ้า group (ungrouped) ไม่ถูกจับ", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 100, title: "งาน A", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 140, url: "edge://settings", groupId: 100 }) });
  mirror.handleTabCreated({ ...tabEvent({ id: 141, url: "https://ok.example", groupId: 100 }) });
  mirror.handleTabCreated({ ...tabEvent({ id: 142, url: "", groupId: 100 }) });
  mirror.flushSync();
  await store.flush();

  const g = store.snapshot().groups["งาน A"];
  assert.ok(!g?.tabs["edge://settings"], "edge:// ถูกกรอง");
  assert.ok(!g?.tabs[""], "URL ว่างถูกกรอง");
  assert.ok(g?.tabs["https://ok.example"], "URL ปกติถูกจับ");
});

test("L1: แท็บในหน้าต่าง incognito ไม่ถูกจับ (mirror จะตามกลุ่มใน incognito ได้แต่ไม่บันทึก)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  const t = tabEvent({ id: 150, url: "https://secret.example", groupId: 100, windowId: 103, incognito: true });
  mirror.handleTabCreated({ ...t });
  mirror.flushSync();
  await store.flush();

  const g = store.snapshot().groups["งาน A"];
  assert.ok(!g?.tabs["https://secret.example"], "แท็บ incognito ไม่ถูกจับ");
});

test("L3: เปิดแท็บใหม่ในกลุ่ม → record liveCount 1 ทันที (title/favicon merge เรียลไทม์)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 100, title: "งาน A", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 160, url: "https://new.example", groupId: 100, title: "New", favIconUrl: "ico.png" }) });
  mirror.flushSync();
  await store.flush();

  const tab = store.snapshot().groups["งาน A"]?.tabs["https://new.example"];
  assert.ok(tab);
  assert.equal(tab.liveCount, 1);
  assert.equal(tab.title, "New");
  assert.equal(tab.favIconUrl, "ico.png");
});

test("L4: ปิดแท็บ → flip หลับ + closedAt; ไม่ลบ record", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 110, url: "https://a.example/1", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  assert.ok(store.snapshot().groups["งาน A"].tabs["https://a.example/1"].liveCount === 1, "seed บันทึกแล้ว");

  chromeRemove({ mirror, tabId: 110 });
  mirror.flushSync();
  await store.flush();

  const tab = store.snapshot().groups["งาน A"]?.tabs["https://a.example/1"];
  assert.equal(tab.liveCount, 0);
  assert.ok(tab.closedAt > 0, "มี closedAt");
  assert.ok(store.snapshot().groups["งาน A"], "record ยังอยู่");
});

function chromeRemove({ mirror, tabId }) {
  mirror.handleTabRemoved(tabId, { windowId: 101, isWindowClosing: false });
}

test("L5: tabGroups.onRemoved ต่อ instance เดียว → instance ที่รอด of the same-name group ยัง live", async () => {
  const { store, mirror } = harness({
    windows: [
      { id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }] },
      { id: 102, groups: [{ id: 101, title: "งาน A", color: "blue" }], tabs: [{ id: 120, url: "https://a/1", groupId: 101 }, { id: 121, url: "https://a/2", groupId: 101 }] }
    ]
  });
  await store.init();
  await mirror.attach();
  assert.equal(store.snapshot().groups["งาน A"].tabs["https://a/1"].liveCount, 2, "สองหน้าต่างจับรวม");

  // ปิดแท็บทั้งหมดในหน้าต่าง 102; ตาม Edge: tabs.onRemoved แต่ละตัว, tabGroups.onRemoved ทีหลัง
  chromeRemove({ mirror, tabId: 120 });
  chromeRemove({ mirror, tabId: 121 });
  mirror.handleGroupRemoved({ id: 101, windowId: 102 });
  mirror.flushSync();
  await store.flush();

  const tab = store.snapshot().groups["งาน A"]?.tabs["https://a/1"];
  assert.equal(tab.liveCount, 1, "instance 101 ยังโสด live");
  assert.deepEqual(store.snapshot().groups["งาน A"].liveWindowIds, [101]);
});

test("L6: ลากแท็บออกจากกลุ่ม (changeInfo.groupId = -1) → flip หลับ", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();

  mirror.handleTabUpdated(110, { groupId: -1 }, ({ ...tabEvent({ id: 110, url: "https://a/1", groupId: -1 }) }));
  mirror.flushSync();
  await store.flush();

  const g = store.snapshot().groups["งาน A"];
  assert.ok(g?.tabs["https://a/1"]);
  assert.equal(g.tabs["https://a/1"].liveCount, 0);
});

test("L2: สองหน้าต่าง group ชื่อเดียวกัน → คลังคือ union เดียว", async () => {
  const { store } = await seededTwoWindows();
  const g = store.snapshot().groups["งาน A"];
  assert.equal(Object.keys(g.tabs).length, 3, "url รวมจากสองหน้าต่าง = 3 หน้า");
  assert.equal(g.tabs["https://a.example/1"].liveCount, 2, "แท็บซ้ำข้ามหน้าต่างนับ instance รวม");
  assert.deepEqual(g.liveWindowIds.sort(), [101, 102]);
});

async function seededTwoWindows() {
  const { chrome, store, mirror } = harness({
    windows: [
      { id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 110, url: "https://a.example/1", groupId: 100 }, { id: 111, url: "https://a.example/2", groupId: 100 }] },
      { id: 102, groups: [{ id: 200, title: "งาน A", color: "blue" }], tabs: [{ id: 250, url: "https://a.example/1", groupId: 200 }, { id: 251, url: "https://b.example/1", groupId: 200 }] }
    ]
  });
  await store.init();
  await mirror.reconcile();
  return { chrome, store, mirror };
}

test("L7: เปลี่ยนชื่อกลุ่มบน browser → record rekey (ไม่ idle)", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "เก่า", color: "blue" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  assert.ok(store.snapshot().groups["เก่า"]);

  mirror.handleGroupUpdated({ id: 100, title: "ใหม่", windowId: 101, color: "blue" });
  await store.flush();

  const snap = store.snapshot();
  assert.ok(!snap.groups["เก่า"]);
  assert.ok(snap.groups["ใหม่"]);
  assert.ok(snap.groups["ใหม่"].tabs["https://a/1"]);
  assert.equal(snap.groups["ใหม่"].tabs["https://a/1"].liveCount, 1);
});

test("L7: เปลี่ยนชื่อกับจับกับ record เดิมที่มีอยู่ → merge กันเอง (กลุ่มเดียวใน popup)", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน B", color: "red" }], tabs: [{ id: 110, url: "https://b/1", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  await store.flush();
  // มี record "งาน A" จำไว้ก่อนแล้ว (idle)
  seedIdleRecord(store, "งาน A", "https://a/1");
  await store.flush();

  // ผู้ใช้ rename บน browser: งาน B → งาน A
  mirror.handleGroupUpdated({ id: 100, title: "งาน A", windowId: 101, color: "red" });
  await store.flush();

  const snap = store.snapshot();
  assert.ok(!snap.groups["งาน B"]);
  const g = snap.groups["งาน A"];
  assert.ok(g.tabs["https://b/1"], "แท็บจากงาน B ย้ายมารวม");
  assert.ok(g.tabs["https://a/1"], "คง idle ที่มีอยู่เดิม");
});

test("reconcile: อ่านสถานะ browser ทั้งชุดได้ตรง (รวม windowIds/incognito/unnamed filters)", async () => {
  const { store } = await reconcileSeeded();
  const snap = store.snapshot();
  const g = snap.groups["งาน A"];
  assert.equal(Object.keys(g.tabs).length, 2, "แท็บ incognito/unnamed ไม่รวม");
  assert.equal(g.tabs["https://a/1"].liveCount, 1, "นับเฉพาะหน้าต่างปกติ");
  assert.deepEqual(g.liveWindowIds, [101]);
  assert.ok(!g.tabs["https://x/1"], "แท็บในกลุ่มไม่มีชื่อไม่ถูก track");
});

async function reconcileSeeded() {
  const { chrome, store, mirror } = harness({
    windows: [
      { id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }, { id: 102, title: "", color: "grey" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }, { id: 111, url: "https://a/2", groupId: 100 }, { id: 112, url: "https://x/1", groupId: 102 }] },
      { id: 103, incognito: true, groups: [{ id: 300, title: "งาน A", color: "blue" }], tabs: [{ id: 310, url: "https://secret/1", groupId: 300 }] }
    ]
  });
  await store.init();
  await mirror.reconcile();
  return { chrome, store, mirror };
}

test("ปิดทั้งหน้าต่าง → แท็บในกลุ่ม flip หลับทั้งก้อน (window close = หายไปจาก liveMap)", async () => {
  const { chrome, store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }, { id: 111, url: "https://a/2", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  assert.equal(store.snapshot().groups["งาน A"].tabs["https://a/1"].liveCount, 1);

  // Edge ยิง tabs.onRemoved isWindowClosing=true ต่อแท็บ แล้ว windows.onRemoved
  chrome.tabs.remove(110);
  chrome.tabs.remove(111);
  mirror.handleTabRemoved(110, { windowId: 101, isWindowClosing: true });
  mirror.handleTabRemoved(111, { windowId: 101, isWindowClosing: true });
  mirror.handleWindowRemoved(101);
  await store.flush();
  mirror.flushSync();
  await store.flush();

  const g = store.snapshot().groups["งาน A"];
  assert.equal(g.tabs["https://a/1"].liveCount, 0);
  assert.equal(g.tabs["https://a/2"].liveCount, 0);
});

test("แท็บถูกลากข้ามหน้าต่างเข้ากลุ่มที่รู้จัก (detached → attached → updated)", async () => {
  const { store, mirror } = harness({ windows: [{ id: 102, groups: [{ id: 200, title: "งาน X", color: "green" }] }] });
  await store.init();
  await mirror.attach();
  await store.flush();

  // ผู้ใช้ลากแท็บไปกลุ่ม 200 ของหน้าต่าง 102 (Edge: detached, attached, onUpdated groupId)
  mirror.handleTabDetached(130, { oldWindowId: 101, oldPosition: 0 });
  mirror.flushSync();
  await store.flush();
  mirror.handleTabAttached(130, { newWindowId: 102, newPosition: 0 });
  mirror.handleTabUpdated(130, { groupId: 200 }, { ...tabEvent({ id: 130, url: "https://moved/1", groupId: 200, windowId: 102, title: "M" }) });
  mirror.flushSync();
  await store.flush();

  const g = store.snapshot().groups["งาน X"];
  assert.equal(g?.tabs["https://moved/1"]?.liveCount, 1, "แท็บย้ายเข้ากลุ่มชื่อเดียวจริง");
});

test("rename ไม่สะเทือน records บน applyLiveMap ซ้ำ (idempotent แต่ field เดิมค่อยเป็น)", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "old", color: "blue" }], tabs: [{ id: 110, url: "https://a/1", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  await store.flush();
  const snap1 = structuredClone(store.snapshot());

  mirror.handleGroupUpdated({ id: 100, title: "new", windowId: 101, color: "blue" });
  await store.flush();
  mirror.flushSync();
  await store.flush();

  const snap2 = structuredClone(store.snapshot());
  const t1 = snap1.groups["old"]?.tabs["https://a/1"];
  const t2 = snap2.groups["new"]?.tabs["https://a/1"];
  assert.equal(t2.url, t1.url);
  assert.ok(!snap2.groups["old"], "ไม่มี duplicate ชื่อเก่า");
});

// ==================================================================
// v3.1 — L13/L14: ปิดแท็บเอง = ลบ record · ปิด window = หลับ · url เปลี่ยน = เลื่อนตาม
// ==================================================================

test("L13(v3.1): แท็บที่ mirror จับตอน live แล้วผู้ใช้ปิดเอง → record ถูกลบ + GC กลุ่มว่าง", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน B", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 400, url: "https://new.example", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.ok(store.snapshot().groups["งาน B"]?.tabs["https://new.example"], "register ครบตั้งแต่ event");

  mirror.handleTabRemoved(400, { windowId: 101, isWindowClosing: false });
  mirror.flushSync();
  await store.flush();
  assert.ok(!store.snapshot().groups["งาน B"], "record ถูกลบตามผู้ใช้ปิด (แท็บ browser ไม่ถูกแตะ)");
});

test("L13(v3.1): ปิดทั้ง window (isWindowClosing=true) → record คงอยู่เป็นหลับ (กฎเดิม)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน W", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 401, url: "https://w.example", groupId: 300, windowId: 101 }) });
  mirror.flushSync();

  mirror.handleTabRemoved(401, { windowId: 101, isWindowClosing: true });
  mirror.flushSync();
  await store.flush();
  const t = store.snapshot().groups["งาน W"]?.tabs["https://w.example"];
  assert.ok(t, "ปิด window = คง record ไว้เปิดคืนได้");
  assert.equal(t.liveCount, 0);
});

test("L13(v3.1): แท็บที่ scan ครั้งแรกเจอ (protected origin — สาเหตุกำเนิดไม่แน่) ปิดเอง → ไม่ลบ", async () => {
  const { store, mirror } = harness({ windows: [{ id: 101, groups: [{ id: 100, title: "ตอนจิ" }], tabs: [{ id: 402, url: "https://old.example", groupId: 100 }] }] });
  await store.init();
  await mirror.attach();
  assert.ok(store.snapshot().groups["ตอนจิ"]);

  mirror.handleTabRemoved(402, { windowId: 101, isWindowClosing: false });
  mirror.flushSync();
  await store.flush();
  const t = store.snapshot().groups["ตอนจิ"]?.tabs["https://old.example"];
  assert.ok(t, "protected — คง record เป็นหลับ");
  assert.equal(t.liveCount, 0);
});

test("L13(v3.1): mark restored ทีหลัง register (restore engine ยิงท้าย flow) → ปิดไม่ลบ", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน R", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 403, url: "https://r.example", groupId: 300, windowId: 101 }) });
  mirror.flushSync();

  store.markRestoredTabs([403]);   // RestoreEngine เรียกใน finally หลัง create ทุกแท็บ
  mirror.handleTabRemoved(403, { windowId: 101, isWindowClosing: false });
  mirror.flushSync();
  await store.flush();
  const t = store.snapshot().groups["งาน R"]?.tabs["https://r.example"];
  assert.ok(t, "origin restored — record คงอยู่");
  assert.equal(t.liveCount, 0);
});

test("L14(v3.1): แท็บที่ผูกไว้เปลี่ยน url → record เลื่อนตาม (แถวเก่าลบ, addedAt เดินตาม)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน C", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 404, url: "https://c/start", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  const start = store.snapshot().groups["งาน C"]?.tabs["https://c/start"];
  assert.ok(start);

  mirror.handleTabUpdated(404, {}, { ...tabEvent({ id: 404, url: "https://c/next", title: "Next", favIconUrl: "n.png", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  await store.flush();

  const tabs = store.snapshot().groups["งาน C"]?.tabs ?? {};
  assert.deepEqual(Object.keys(tabs), ["https://c/next"], "ไม่มี record ค้างบน url เดิม");
  assert.equal(tabs["https://c/next"].addedAt, start.addedAt, "อัตลักษณ์ record เดินตามแท็บ");
  assert.equal(tabs["https://c/next"].title, "Next");
});

test("L14(v3.1): url เดิมยังมีแท็บอื่นตื่นอยู่ → แถวเดิมคงอยู่ (แค่ count ลด)", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน D", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 405, url: "https://d/p", groupId: 300, windowId: 101 }) });
  mirror.handleTabCreated({ ...tabEvent({ id: 406, url: "https://d/p", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.equal(store.snapshot().groups["งาน D"].tabs["https://d/p"].liveCount, 2);

  mirror.handleTabUpdated(405, {}, { ...tabEvent({ id: 405, url: "https://d/q", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  await store.flush();
  const tabs = store.snapshot().groups["งาน D"].tabs;
  assert.equal(tabs["https://d/p"].liveCount, 1, "url เดิมยังมีชีวิต — ไม่ลบ");
  assert.ok(tabs["https://d/q"], "แท็บที่เปลี่ยนหน้ามี record ตัวเอง");
});
