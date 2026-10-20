/**
 * BrowserMirror unit tests (node --test) — SOT §9: T1–T8 ฐานหลัก (L1–L8 + reconcile)
 * + ชุด v3.1 ต่อยอด (L13–L17: ปิดเอง/เลื่อนตาม/แท็บหลับแบบ Edge)
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

// ------------------------------------------------------------------
// v3.2 — แก้จากข้อมูลจริงใน Edge: URL ใหม่มากับ changeInfo (ไม่ใช่ tab.url),
// แท็บที่ scan เจอ (r=1) ต้องเลื่อน record ตามแท็บได้, แท็บใหม่ใช้ pendingUrl
// ------------------------------------------------------------------

test("v3.2: URL ใหม่มากับ changeInfo (Edge ส่ง tab.url ยังเป็นค่าเก่า) → binding + record เดินตามแท็บ", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน F", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 407, url: "https://f/old", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.equal(store.liveBinding(407)?.urlKey, "https://f/old");

  // Edge จริง: changeInfo.url = URL ใหม่, tab.url = ค่าเก่า (ยังไม่ commit)
  mirror.handleTabUpdated(407, { url: "https://f/new", status: "loading" }, { ...tabEvent({ id: 407, url: "https://f/old", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  await store.flush();

  const tabs = store.snapshot().groups["งาน F"]?.tabs ?? {};
  assert.deepEqual(Object.keys(tabs), ["https://f/new"], "แถวเก่าต้องถูกย้าย ไม่ใช่ค้างเป็นซ้ำ");
  assert.equal(store.liveBinding(407)?.urlKey, "https://f/new", "binding เดินตามแท็บ");
});

test("v3.2: แท็บที่ reconcile เจอครั้งแรก (origin r=1) แล้วเปลี่ยนหน้า → record เดินตาม (ไม่ค้างซ้ำ)", async () => {
  const { store, mirror } = harness({
    windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน G", color: "blue" }], tabs: [{ id: 108, url: "https://g/old", groupId: 100 }] }]
  });
  await store.init();
  await mirror.reconcile();
  assert.equal(store.liveBinding(108)?.restored, true, "scan ครั้งแรก = origin ป้องกัน (r=1)");

  mirror.handleTabUpdated(108, { url: "https://g/new", status: "loading" }, { ...tabEvent({ id: 108, url: "https://g/old", groupId: 100, windowId: 101 }) });
  mirror.flushSync();
  await store.flush();

  const tabs = store.snapshot().groups["งาน G"]?.tabs ?? {};
  assert.deepEqual(Object.keys(tabs), ["https://g/new"], "r=1 เดิมข้ามการเลื่อน = เห็นเป็นแท็บซ้ำ (บั๊กจริงจากข้อมูล Edge)");
  assert.equal(store.liveBinding(108)?.urlKey, "https://g/new");
});

test("v3.2: แท็บใหม่ที่ Edge ส่งมา url ว่างแต่มี pendingUrl → จับได้เลย", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน H", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 409, url: "", groupId: 300, windowId: 101 }), pendingUrl: "https://h/page" });
  mirror.flushSync();

  const tabs = store.snapshot().groups["งาน H"]?.tabs ?? {};
  assert.ok(tabs["https://h/page"], "pendingUrl คือตัวตนของแท็บระหว่างโหลด");
  assert.equal(store.liveBinding(409)?.urlKey, "https://h/page");
});

test("v3.2: แท็บเปลี่ยนหน้าโดยมีแท็บอื่นใช้ URL เดิมอยู่ → แถวเดิมคง (count ลด) แถวใหม่ได้ record", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน I", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 410, url: "https://i/p", groupId: 300, windowId: 101 }) });
  mirror.handleTabCreated({ ...tabEvent({ id: 411, url: "https://i/p", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.equal(store.snapshot().groups["งาน I"].tabs["https://i/p"].liveCount, 2);

  mirror.handleTabUpdated(410, { url: "https://i/q", status: "loading" }, { ...tabEvent({ id: 410, url: "https://i/p", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  await store.flush();

  const tabs = store.snapshot().groups["งาน I"].tabs;
  assert.equal(tabs["https://i/p"].liveCount, 1, "แท็บอื่นยังใช้ URL เดิม — แถวเดิมคงชีวิต");
  assert.ok(tabs["https://i/q"], "แท็บที่เปลี่ยนหน้ามี record ตัวเอง");
});

// ------------------------------------------------------------------
// L17 (v3.1) — แท็บหลับแบบ Edge Sleeping Tabs (`discarded=true` แต่ยังเปิดค้างใน strip)
// ------------------------------------------------------------------

test("L17: Edge sleeping-tab เปิดค้าง + reconcile (SW restart) → นับเป็นตื่น ไม่หลับผิดสถานะ", async () => {
  const { store, mirror } = harness({
    windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน S", color: "blue" }], tabs: [{ id: 110, url: "https://nov.example/writer", groupId: 100, discarded: true }] }]
  });
  await store.init();
  seedIdleRecord(store, "งาน S", "https://nov.example/writer"); // แถวหลับที่ผู้ใช้เคยจำไว้
  await store.flush();

  await mirror.reconcile(); // SW ตื่นใหม่ — แท็บที่ Edge นอนเองยังอยู่จริง
  const row = store.snapshot().groups["งาน S"].tabs["https://nov.example/writer"];
  assert.equal(row.liveCount, 1, "แท็บเปิดค้างใน strip = ตื่นตามจริง (bug เดิม: กลายเป็น 'จำไว้ (หลับ)' ซ้ำกับแท็บที่เห็นใน Edge)");
  assert.deepEqual(store.snapshot().groups["งาน S"].liveWindowIds, [101]);
});

test("L17: แท็บผลจาก restore (ธง s) คงหลับ — event loading ของ flow เองไม่ผุดเป็นตื่น", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();
  seedIdleRecord(store, "งาน R", "https://r.example"); // แถวต้นทางที่ผู้ใช้กด restore จากมัน
  await store.flush();

  // โครงจังหวะจริงของ restore: mark ทันทีหลัง create (create event เองไม่มี url → ไม่ลงทะเบียน)
  // แล้ว event onUpdated {status:"loading", url} ของแท็บที่สร้าง เข้า mirror แบบ awake (discarded=false)
  store.markRestoredTabs([403]);
  mirror.handleGroupCreated({ id: 300, title: "งาน R", color: "blue", windowId: 101 });
  mirror.handleTabUpdated(403, { status: "loading", url: "https://r.example" }, { ...tabEvent({ id: 403, url: "https://r.example", groupId: 300, windowId: 101 }) });
  mirror.handleTabUpdated(403, {}, { ...tabEvent({ id: 403, url: "https://r.example", groupId: 300, windowId: 101, discarded: true }) });
  mirror.flushSync();

  const row = store.snapshot().groups["งาน R"]?.tabs["https://r.example"];
  assert.ok(row, "แถวต้นทางคงอยู่");
  assert.equal(row.liveCount, 0, "แท็บที่ restore เอง = หลับตาม design (§6) — liveCount ไม่ขยับ");
  const bind = store.liveBinding(403);
  assert.equal(bind?.restored, true, "ธง r ปิดไม่ลบ (L13)");
  assert.equal(bind?.sleeping, true, "ธง s บอกว่ายังเป็นแท็บหลับผลจาก restore");
});

test("L17: ผู้ใช้กดตื่นแท็บที่ restore ไว้ → ถอนธง s แล้วนับเป็นตื่นตามจริง", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();
  seedIdleRecord(store, "งาน R", "https://r.example");
  await store.flush();

  store.markRestoredTabs([403]);
  mirror.handleGroupCreated({ id: 300, title: "งาน R", color: "blue", windowId: 101 });
  mirror.handleTabUpdated(403, { status: "loading", url: "https://r.example" }, { ...tabEvent({ id: 403, url: "https://r.example", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.equal(store.snapshot().groups["งาน R"].tabs["https://r.example"].liveCount, 0);

  // ผู้ใช้คลิกแท็บหลับที่เพิ่ง restore → Edge นอนค้างแล้วตื่น (discarded=false) + โหลดหน้า
  mirror.handleTabUpdated(403, { status: "complete", title: "Woke" }, { ...tabEvent({ id: 403, url: "https://r.example", title: "Woke", favIconUrl: "w.png", groupId: 300, windowId: 101 }) });
  mirror.flushSync();

  const row = store.snapshot().groups["งาน R"].tabs["https://r.example"];
  assert.equal(row.liveCount, 1, "ผู้ใช้เอาไปใช้จริง = ตื่น");
  assert.equal(row.title, "Woke");
  const bind = store.liveBinding(403);
  assert.equal(bind?.sleeping, false, "ธง s ถูกถอน — นับตามจริงจากนี้ไป");
  assert.equal(bind?.restored, true, "ธง r คงอยู่ — ปิดทีหลังยังหลับไม่ลบ (L13)");
});

test("L17: Edge นอนแท็บตื่นภายหลัง → ยังนับตื่น + ไม่หมุน title/favicon", async () => {
  const { store, mirror } = harness();
  await store.init();
  await mirror.attach();

  mirror.handleGroupCreated({ id: 300, title: "งาน E", color: "blue", windowId: 101 });
  mirror.handleTabCreated({ ...tabEvent({ id: 404, url: "https://e.example", title: "จริง", favIconUrl: "a.png", groupId: 300, windowId: 101 }) });
  mirror.flushSync();
  assert.equal(store.snapshot().groups["งาน E"].tabs["https://e.example"].liveCount, 1);

  // Edge sleeping-tab: onUpdated มาพร้อม discarded=true (title/favicon ในหน่วยความจำไม่น่าเชื่อ)
  mirror.handleTabUpdated(404, {}, { ...tabEvent({ id: 404, url: "https://e.example", title: "ข้อมูลค้างของ Edge", favIconUrl: "stale.png", groupId: 300, windowId: 101, discarded: true }) });
  mirror.flushSync();

  const row = store.snapshot().groups["งาน E"].tabs["https://e.example"];
  assert.equal(row.liveCount, 1, "ยังเปิดค้างจริง = ตื่น (L17)");
  assert.equal(row.title, "จริง", "แท็บหลับไม่หมุน title (§6)");
});

test("L17: แท็บที่ผู้ใช้กดตื่นแล้ว SW ตายก่อน persist ธง → reconcile กู้เป็นตื่น (ถอนธง s จากสถานะจริง)", async () => {
  const { store, mirror } = harness({
    windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน W", color: "blue" }], tabs: [{ id: 120, url: "https://w/1", groupId: 100, discarded: false }] }]
  });
  await store.init();
  seedIdleRecord(store, "งาน W", "https://w/1");
  store.setLiveBinding(120, { groupName: "งาน W", urlKey: "https://w/1" }); // binding จากการจับเดิม
  store.markRestoredTabs([120]);                 // ธงค้างจาก restore เก่า — แต่ตอนนี้แท็บตื่นจริง (ผู้ใช้กดแล้ว, save ธงถอนหายไปกับ SW)
  await store.flush();
  assert.equal(store.liveBinding(120)?.sleeping, true, "จุดเริ่ม: ธง s ค้างจาก restore เก่า");
  assert.equal(store.isRestoredTab(120), true);

  await mirror.reconcile();
  const row = store.snapshot().groups["งาน W"].tabs["https://w/1"];
  assert.equal(row.liveCount, 1, "แท็บตื่นจริง → นับตึนแม้ธง s เพิ่งถูกถอน");
  assert.equal(store.liveBinding(120)?.sleeping, false, "ธง s ถูกถอนโดย reconcile");
  assert.equal(store.liveBinding(120)?.restored, true, "ธง r คงอยู่ — ปิดทีหลังยังหลับไม่ลบ (L13)");
});

test("L17: reconcile prune ไม่ตัด binding/ธงของแท็บที่ยังเปิดค้างแต่ registry ตั้งใจไม่คิดเป็นตื่น", async () => {
  const { store, mirror } = harness({
    windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน P", color: "blue" }], tabs: [{ id: 110, url: "https://p/1", groupId: 100, discarded: true }] }]
  });
  await store.init();
  store.markRestoredTabs([110]); // ธง restore ของแท็บที่ยังเปิดอยู่ (flow จบไปแล้ว SW ตายก่อนจับ event)
  await mirror.reconcile();

  const bind = store.liveBinding(110);
  assert.ok(bind, "แท็บยังเปิดจริง — ห้าม prune binding ทิ้ง");
  assert.equal(bind?.restored, true);
  assert.equal(bind?.sleeping, true, "ธง s ติดตาม binding ที่สร้างตอน reconcile");
  assert.equal(store.snapshot().groups["งาน P"], undefined, "แท็บผลจาก restore ไม่ถูกจับเป็นตื่น");

  // control: แท็บที่ปิดไปจริง (ไม่ใช่แค่ไม่ถูกจับ) — binding ตัดด้วย prune ตามเดิม
  store.setLiveBinding(999, { groupName: "งาน P", urlKey: "https://p/1" });
  await mirror.reconcile(); // รอบเดียวพอ — reconcile รอบถัดไป prune id 999 (ไม่อยู่ใน windows)
  assert.equal(store.liveBinding(999), null, "prune เฉพาะแท็บที่หายไปจริง");
});
