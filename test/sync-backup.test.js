/**
 * SyncBackup unit tests (node --test) — เงาสำรองไป chrome.storage.sync (§เก็บข้อมูลให้รอด)
 * ครอบ: write→read roundtrip (chunk), ตัด chunk เก่า, throttle, noop เมื่อไม่มี sync,
 * ข้อมูลเสีย → null, GroupStore กู้ข้ามเครื่องเฉพาะตอน local ว่างจริง
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncBackup, BACKUP_META_KEY } from "../background/sync-backup.js";
import { GroupStore } from "../background/group-store.js";
import { STORAGE_KEY } from "../shared/constants.js";

/** fake storage แบบพื้น ๆ (ใช้ได้ทั้ง local/sync ของเทสนี้) */
function fakeArea({ fail = false } = {}) {
  const data = new Map();
  return {
    __data: data,
    get: async keys => {
      if (fail) throw new Error("QUOTA_BYTES quota exceeded");
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    set: async obj => {
      if (fail) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.parse(JSON.stringify(v)));
    },
    remove: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) data.delete(k);
    },
    clear: async () => { data.clear(); }
  };
}

function demoSchema() {
  return {
    version: 3,
    groups: {
      "A": {
        name: "A", color: "blue", createdAt: 10, updatedAt: 10, liveWindowIds: [],
        tabs: {
          "https://a.example/1": { url: "https://a.example/1", title: "หนึ่ง".repeat(50), order: 0, addedAt: 10, lastLiveAt: 10, liveCount: 0 },
          "https://a.example/2": { url: "https://a.example/2", title: "สอง", order: 1, addedAt: 11, lastLiveAt: 11, liveCount: 1 }
        }
      },
      "B": {
        name: "B", color: "red", createdAt: 12, updatedAt: 12, liveWindowIds: [],
        tabs: { "https://b.example/x": { url: "https://b.example/x", title: "เอ็กซ์", order: 0, addedAt: 12, lastLiveAt: 12, liveCount: 0 } }
      }
    },
    liveTabs: {}, restoredTabIds: {}
  };
}

test("write → read roundtrip (chunk เล็ก ๆ หลายชิ้น) — กลุ่มครบ, title ถูกย่อ, liveCount รีเซ็ต", async () => {
  const sync = fakeArea();
  const backup = new SyncBackup({ syncStorage: sync, chunkChars: 100, minIntervalMs: 0 });
  const wrote = await backup.writeSoon(demoSchema(), { force: true });
  assert.equal(wrote, true);

  const keys = [...sync.__data.keys()];
  assert.ok(keys.includes(BACKUP_META_KEY), "มีเมตา");
  assert.ok(keys.filter(k => k.startsWith("groupsSyncBackup#")).length > 1, "แตกเป็นหลาย chunk");

  const schema = await backup.read();
  assert.ok(schema, "อ่านกลับได้");
  assert.equal(schema.version, 3);
  assert.deepEqual(Object.keys(schema.groups).sort(), ["A", "B"]);
  assert.equal(schema.groups.A.tabs["https://a.example/1"].title.length, 60, "title ย่อตาม TITLE_MAX");
  assert.equal(schema.groups.A.tabs["https://a.example/2"].liveCount, 0, "กู้เป็น idle เสมอ");
  assert.equal(schema.groups.A.tabs["https://a.example/1"].order, 0, "ตัว order คืนตามลำดับเดิม");
  assert.deepEqual(schema.liveTabs, {});
});

test("เขียนชุดเล็กลงทับชุดใหญ่ → ล้าง chunk เก่าส่วนเกิน (กันอ่านต่อยาวเกิน)", async () => {
  const sync = fakeArea();
  const backup = new SyncBackup({ syncStorage: sync, chunkChars: 60, minIntervalMs: 0 });
  await backup.writeSoon(demoSchema(), { force: true });
  const before = [...sync.__data.keys()].filter(k => k.startsWith("groupsSyncBackup#")).length;
  assert.ok(before > 2);

  const small = { version: 3, groups: { "A": demoSchema().groups.A }, liveTabs: {}, restoredTabIds: {} };
  await backup.writeSoon(small, { force: true });
  const after = [...sync.__data.keys()].filter(k => k.startsWith("groupsSyncBackup#")).length;
  assert.ok(after < before, "chunk เกินถูกถอด");

  const schema = await backup.read();
  assert.deepEqual(Object.keys(schema.groups), ["A"], "อ่านชุดใหม่ครบถ้วน");
});

test("throttle: เรียกถี่ → ข้าม (คืน false); force → เขียนทันที", async () => {
  const sync = fakeArea();
  let t = 1_000_000;
  const backup = new SyncBackup({ syncStorage: sync, now: () => t, minIntervalMs: 300_000 });
  assert.equal(await backup.writeSoon(demoSchema()), true, "ครั้งแรกเขียน");

  const setCount = () => [...sync.__data.values()].length;
  const snap = setCount();
  assert.equal(await backup.writeSoon(demoSchema()), false, "ครั้งที่สองติด throttle → ข้าม");
  assert.equal(setCount(), snap, "ไม่มีการเขียนเพิ่ม");

  assert.equal(await backup.writeSoon(demoSchema(), { force: true }), true, "force ข้าม throttle ได้");
});

test("ไม่มี sync storage → write/read เป็น no-op ไม่พัง; sync ดับกลางคัน → write คืน false", async () => {
  const none = new SyncBackup({ syncStorage: null });
  assert.equal(await none.writeSoon(demoSchema()), false);
  assert.equal(await none.read(), null);

  const bad = new SyncBackup({ syncStorage: fakeArea({ fail: true }) });
  assert.equal(await bad.writeSoon(demoSchema(), { force: true }), false, "quota เต็ม/ดับ → false ไม่ throw");
  assert.equal(await bad.read(), null);
});

test("read: เมตาขาดชิ้น / JSON เสีย → null (ไม่คืนของครึ่ง ๆ)", async () => {
  const sync = fakeArea();
  const backup = new SyncBackup({ syncStorage: sync, chunkChars: 80, minIntervalMs: 0 });
  await backup.writeSoon(demoSchema(), { force: true });

  const chunks = [...sync.__data.keys()].filter(k => k.startsWith("groupsSyncBackup#"));
  await sync.remove(chunks[chunks.length - 1]); // แกะชิ้นท้ายออก
  assert.equal(await backup.read(), null, "chunk หาย → null");

  const sync2 = fakeArea();
  await sync2.set({ [BACKUP_META_KEY]: { v: 1, at: 1, n: 1 }, "groupsSyncBackup#0": { i: 0, d: "{เสียครึ่ง" } });
  assert.equal(await new SyncBackup({ syncStorage: sync2 }).read(), null, "JSON เสีย → null");
});

test("GroupStore.init: local ว่างจริง + มีเงาสำรอง sync → กู้กลับ (ไม่ยิง wipe notice)", async () => {
  const local = fakeArea();
  const sync = fakeArea();
  let t = 5_000;
  const writer = new SyncBackup({ syncStorage: sync, minIntervalMs: 0 });
  await writer.writeSoon(demoSchema(), { force: true });

  const store = new GroupStore({
    storage: local, now: () => ++t, saveDelayMs: 0,
    backup: new SyncBackup({ syncStorage: sync })
  });
  const migrated = await store.init();
  assert.equal(migrated, false, "ไม่ใช่ wipe — ไม่ติดธง migrated");

  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap.groups).sort(), ["A", "B"], "กู้กลุ่มครบ");
  assert.ok(snap.restoredFromSyncAt > 0, "ประทับเวลากู้");
  assert.equal(store.consumeRestoredSyncNotice(), true, "popup ได้ toast หนเดียว");
  assert.equal(store.consumeRestoredSyncNotice(), false, "consume แล้วไม่ยิงซ้ำ");
});

test("GroupStore.init: local มี v3 อยู่แล้ว → ไม่แตะเงาสำรอง (ไม่เขียนทับของใหม่กว่า)", async () => {
  const local = fakeArea();
  const sync = fakeArea();
  const current = { version: 3, groups: { "ของตอนนี้": { name: "ของตอนนี้", color: "grey", createdAt: 9, updatedAt: 9, liveWindowIds: [], tabs: {} } }, liveTabs: {}, restoredTabIds: {} };
  await local.set({ [STORAGE_KEY]: current });
  await new SyncBackup({ syncStorage: sync, minIntervalMs: 0 }).writeSoon(demoSchema(), { force: true });

  const store = new GroupStore({ storage: local, now: () => 1, saveDelayMs: 0, backup: new SyncBackup({ syncStorage: sync }) });
  await store.init();
  assert.deepEqual(Object.keys(store.snapshot().groups), ["ของตอนนี้"], "ของ local ใหม่กว่าชนะ");
  assert.equal(store.consumeRestoredSyncNotice(), false, "ไม่มี toast กู้");
});

test("GroupStore.init: เจอ key ระบบเก่า (v2) → เดิน wipe เดิม ไม่กู้เงาสำรองทับ", async () => {
  const local = fakeArea();
  const sync = fakeArea();
  await local.set({ closedWindows: [] }); // legacy key จริงตัวหนึ่ง
  await new SyncBackup({ syncStorage: sync, minIntervalMs: 0 }).writeSoon(demoSchema(), { force: true });

  const store = new GroupStore({ storage: local, now: () => 1, saveDelayMs: 0, backup: new SyncBackup({ syncStorage: sync }) });
  const migrated = await store.init();
  assert.equal(migrated, true, "wipe v2 ยังได้ migrated");
  assert.deepEqual(Object.keys(store.snapshot().groups), [], "คลังเริ่มเปล่าตามกฎเดิม");
});
