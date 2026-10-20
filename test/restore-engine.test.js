/**
 * RestoreEngine unit tests (node --test) — SOT §9 T9–T10
 * ปูสตาจสม: fake chrome + store มี record idle อยู่แล้ว, inject sleep สั่งจังหวะเอง
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RestoreEngine } from "../background/restore-engine.js";
import { GroupStore } from "../background/group-store.js";
import { createFakeChrome } from "./helpers/fake-chrome.js";

/** ปลูก store ที่มี idle records สำเร็จรูป */
async function storeWithIdleRecords(chrome, name, urls, color = "blue") {
  let time = 1_000;
  const store = new GroupStore({ storage: chrome.storage.local, now: () => ++time, saveDelayMs: 0 });
  await store.init();
  const liveMap = {
    [name]: {
      color,
      windowIds: [],
      tabs: Object.fromEntries(urls.map(u => [u, { title: `T-${u}`, favIconUrl: "f.png", count: 1 }]))
    }
  };
  store.applyLiveMap(liveMap);
  store.applyLiveMap({}); // retire → idle ทั้งหมด
  await store.flush();
  return store;
}

/** harness พื้นฐาน — หน้าต่างโฟกัส 101 (ไม่มีกลุ่ม) */
function harness(seed = {}) {
  const chrome = createFakeChrome(seed);
  return chrome;
}

test("เปิดทั้งหมด: ผู้ใช้กดปุ่มเมื่อไม่มีกลุ่ม live → สร้างกลุ่มใหม่ในหน้าต่างโฟกัส + create→group→setColor→discard ตามลำดับ (คง order record)", async () => {
  const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3"];
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  const store = await storeWithIdleRecords(chrome, "งาน A", urls);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.opened, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.createdWindow, false);

  // ลำดับคำสั่ง: create → group(สร้างเอง) → tabGroups.update(title,color) → discard, วนซ้ำ 3 รอบ
  const ops = chrome.__ops;
  assert.deepEqual(ops.map(o => o.fn), [
    "tabs.create", "tabs.group", "tabGroups.update", "tabs.discard",
    "tabs.create", "tabs.group", "tabs.discard",
    "tabs.create", "tabs.group", "tabs.discard"
  ]);

  // แท็บจริง: อยู่หน้าต่าง 101, กลุ่มเดียวกัน, discarded ทุกตัว, not active
  const tabObjects = [...chrome.__state.tabs.values()];
  assert.equal(tabObjects.length, 3);
  const gid = tabObjects[0].groupId;
  assert.ok(gid > 0, "ผูกกลุ่มแล้ว");
  for (const t of tabObjects) {
    assert.equal(t.groupId, gid);
    assert.equal(t.discarded, true, "หลับทุกตัว — รวมแท็บแรก");
    assert.equal(t.active, false);
    assert.equal(t.windowId, 101);
  }
  const group = chrome.__state.groups.get(gid);
  assert.equal(group.title, "งาน A");
  assert.equal(group.color, "blue");

  // order: แท็บไม่ซ้ำเรียงตาม record order (ot ผูกลำดับอยู่ใน create เอง)
  assert.deepEqual(
    tabObjects.map(t => t.url),
    ["https://a.example/1", "https://a.example/2", "https://a.example/3"]
  );
});

test("L11: URL ที่เปิดอยู่แล้วในหน้าต่างเป้าหมาย → ข้าม (ไม่เปิดซ้ำ)", async () => {
  const chrome = harness({
    windows: [{ id: 101, focused: true, tabs: [{ id: 999, url: "https://a.example/1" }] }]
  });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1", "https://a.example/2"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 1, "/2 ถูกเปิด");
  assert.equal(result.skipped, 1, "/1 ข้ามเพราะเปิดอยู่แล้ว");

  const tabObjects = [...chrome.__state.tabs.values()].filter(t => t.id !== 999);
  assert.deepEqual(tabObjects.map(t => t.url), ["https://a.example/2"]);
});

test("URL แบบไม่ normalize ตรงกันก็ชนกัน (พวก / ท้าย path)", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true, tabs: [{ id: 999, url: "https://x.example/" }] }] });
  const store = await storeWithIdleRecords(chrome, "w", ["https://x.example"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "w" });
  assert.equal(result.opened, 0);
  assert.equal(result.skipped, 1);
});

test("มี live group ชื่อเดียวกันอยู่ในหน้าต่างโฟกัส → แทรกเข้ากลุ่มเดิม (ไม่สร้างกลุ่มใหม่, ไม่ update ชื่อ/สี)", async () => {
  const chrome = harness({
    windows: [{ id: 101, focused: true, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 950, url: "https://live.example/0", groupId: 100 }] }]
  });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1", "https://a.example/2"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 2);

  const ops = chrome.__ops;
  assert.equal(ops.filter(o => o.fn === "tabs.group" && o.args.groupId === 100).length, 2, "ผูกตรง group เดิม");
  assert.equal(ops.filter(o => o.fn === "tabGroups.update").length, 0, "ไม่แตะ title/color ของ group เดิม");
});

test("live group ชื่อเดียวกันอยู่หน้าต่างอื่น (ไม่ใช่หน้าต่างโฟกัส) → สร้างกลุ่มใหม่ในหน้าต่างโฟกัส ไม่ขยับเก่า", async () => {
  const chrome = harness({
    windows: [
      { id: 101, focused: true, tabs: [{ id: 900, url: "https://blank.example" }] },
      { id: 102, groups: [{ id: 100, title: "งาน A", color: "blue" }], tabs: [{ id: 910, url: "https://elsewhere.example", groupId: 100 }] }
    ]
  });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 1);

  const tabObjects = [...chrome.__state.tabs.values()];
  const restored = tabObjects.find(t => t.url === "https://a.example/1");
  assert.equal(restored.windowId, 101, "อยู่หน้าต่างโฟกัส");

  const groupOld = chrome.__state.groups.get(100);
  assert.equal(groupOld.windowId, 102, "กลุ่มเดิมของหน้าต่าง 102 ไม่ถูกแตะ");
  const newGid = restored.groupId;
  assert.notEqual(newGid, 100, "ไม่ผูกกับกลุ่มข้างหน้าต่างอื่น");
  assert.equal(chrome.__state.groups.get(newGid).title, "งาน A");
});

test("เปิด subset จาก checkbox ที่เลือก (urls เฉพาะตัวที่เลือก, รักษาลำดับตามที่ส่ง)", async () => {
  const chrome = harness();
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A", urls: ["https://a.example/3", "https://a.example/1"] });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 2);

  const tabObjects = [...chrome.__state.tabs.values()];
  assert.deepEqual(
    tabObjects.map(t => t.url),
    ["https://a.example/3", "https://a.example/1"],
    "ลำดับตามที่ผู้ใช้เลือก"
  );
});

test("แท็บหลับไม่ถูกเปิดซ้ำเมื่อ 'เปิดทั้งหมด' (liveCount>0 ข้าม)", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  let time = 1_000;
  const store = new GroupStore({ storage: chrome.storage.local, now: () => ++time, saveDelayMs: 0 });
  await store.init();
  store.applyLiveMap({ "งาน A": { color: "blue", windowIds: [77], tabs: {
        "https://awake.example": { title: "A", favIconUrl: "", count: 1 },
        "https://sleeping.example": { title: "S", favIconUrl: "", count: 1 }
      } } });
  // retire sleeping → count 0; awake ยัง live
  store.applyLiveMap({ "งาน A": { color: "blue", windowIds: [77], tabs: { "https://awake.example": { title: "A", favIconUrl: "", count: 1 } } } });
  await store.flush();

  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });
  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 1, "เปิดเฉพาะแท็บหลับ");
  assert.deepEqual([...chrome.__state.tabs.values()].map(t => t.url), ["https://sleeping.example"]);
});

test("mutex: กดซ้ำขณะ restore กำลังรัน → busy", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1", "https://a.example/2"]);

  let releaseGate;
  const pump = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const engine = new RestoreEngine({
    chrome,
    store,
    sleep: () => new Promise(resolve => { releaseGate = resolve; })
  });

  const first = engine.openTabs({ name: "งาน A" });
  await pump(); // ให้รอบแรกวิ่งถึง sleep ตัวแรก
  assert.ok(typeof releaseGate === "function", "รอบแรกเกาะ sleep จริง");

  const second = await engine.openTabs({ name: "งาน A" });
  assert.equal(second.ok, false);
  assert.equal(second.error, "busy");

  // ปล่อยรอบแรกให้จบ
  releaseGate();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.opened, 2);
});

test("หน้าต่างเป้าหมายถูกปิดกลางทาง → หยุด, รายงาน skipped ที่เหลือ, ไม่สร้าง window มั่ว", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1", "https://a.example/2", "https://a.example/3"]);

  let calls = 0;
  const engine = new RestoreEngine({
    chrome,
    store,
    sleep: async () => {
      calls += 1;
      if (calls === 1) await chrome.windows.remove(101); // ปิดและหน้าต่างกลางทาง
    }
  });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 1, "เปิดตัวแรกได้");
  assert.equal(result.skipped, 2, "ที่เหลือถือข้าม (abort)");
  assert.equal(chrome.__ops.filter(o => o.fn === "windows.create").length, 0, "ไม่สร้าง window ใหม่กลางทาง");
});

test("ไม่มีหน้าต่างใดเลย → สร้างหน้าต่างใหม่แล้ว restore ตามปกติ", async () => {
  const chrome = harness({});
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.createdWindow, true);
  assert.equal(result.opened, 1);
});

test("กลุ่มไม่ปรากฏในคลัง → error อย่างไม่เปิดอะไร", async () => {
  const chrome = harness();
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "ไม่มีในคลัง" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no-record");
  assert.equal(chrome.__ops.length, 0);
});

test("หน้าต่างโฟกัสเป็น incognito → ใช้หน้าต่างปกติตัวอื่นแทน (ไม่ restore เข้า incognito)", async () => {
  const chrome = harness({
    windows: [
      { id: 101, incognito: true, focused: true },
      { id: 102, focused: false }
    ]
  });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  const restored = [...chrome.__state.tabs.values()].find(t => t.url === "https://a.example/1");
  assert.equal(restored.windowId, 102);
});

test("กัน URL ว่าง/privileged: แถว record ที่ URL ว่างไม่ลง create — ไม่มีแท็บเปล่า Untitled", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  // ยัด record พัง (url "") เข้าคลังตรง ๆ — จำลองข้อมูลเสีย/แถวไม่สมบูรณ์
  await chrome.storage.local.set({ groupsSync: {
    version: 3,
    groups: {
      "งาน X": {
        name: "งาน X", color: "blue", createdAt: 1, updatedAt: 1, liveWindowIds: [],
        tabs: { "": { url: "", title: "หัวเปล่า", order: 0, addedAt: 1, lastLiveAt: 1, liveCount: 0 } }
      }
    },
    liveTabs: {}, restoredTabIds: {}
  } });
  let time = 1_000;
  const store = new GroupStore({ storage: chrome.storage.local, now: () => ++time, saveDelayMs: 0 });
  await store.init();
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน X", urls: [""] });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 0);
  assert.equal(chrome.__ops.some(o => o.fn === "tabs.create"), false, "URL ว่างห้ามลง create");
});

test("เบราว์เซอร์คืนแท็บมาแบบไม่มี URL (pendingUrl/url ว่าง) → ยิง tabs.update ตั้ง URL จริงก่อน bind กลุ่ม", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = async props => {
    const t = await realCreate(props);
    return { ...t, url: "", pendingUrl: "" }; // จำลอง Edge คืนแท็บก่อนได้ URL
  };
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {} });

  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 1);

  const updates = chrome.__ops.filter(o => o.fn === "tabs.update");
  assert.ok(updates.some(u => u.args?.url === "https://a.example/1"), "ตั้ง URL จริงผ่าน tabs.update");
  assert.equal(chrome.__ops.filter(o => o.fn === "tabs.discard").length, 1, "ยังหลับเหมือนเดิม");
  const tab = [...chrome.__state.tabs.values()][0];
  assert.equal(tab.url, "https://a.example/1");
  assert.equal(tab.discarded, true);
});

test("ไม่เห็นสัญญาณ navigation เลย → timeout แล้ว discard ต่อ (restore ไม่ค้างกับหน้าโหลดช้า)", async () => {
  const chrome = harness({ windows: [{ id: 101, focused: true }] });
  const store = await storeWithIdleRecords(chrome, "งาน A", ["https://a.example/1"]);
  const engine = new RestoreEngine({ chrome, store, sleep: async () => {}, commitTimeoutMs: 1 });
  // ปิดเสียง onUpdated ระหว่าง create ชั่วคราว — จำลองหน้าที่ไม่ยิง event อะไรเลย
  const saved = [...chrome.listeners.tabs.onUpdated];
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = async props => {
    chrome.listeners.tabs.onUpdated.length = 0;
    try { return await realCreate(props); }
    finally { chrome.listeners.tabs.onUpdated.push(...saved); }
  };

  const t0 = Date.now();
  const result = await engine.openTabs({ name: "งาน A" });
  assert.equal(result.ok, true, "timeout ไม่ทำให้ restore ล้ม");
  assert.equal(result.opened, 1);
  assert.equal(chrome.__ops.filter(o => o.fn === "tabs.discard").length, 1);
  assert.ok(Date.now() - t0 < 2000, "ตัว fallback ต้องเร็ว ไม่หน่วงทั้งคิว");
});
