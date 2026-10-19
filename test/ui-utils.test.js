/**
 * ui-utils unit tests (node --test) — SOT §9 T12 (pure helpers ของ popup)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortGroupCards,
  filterGroupCards,
  splitTabsByState,
  buildStats,
  formatRelativeTime,
  resolveTheme,
  groupDeleteConfirmMessage
} from "../shared/ui-utils.js";

function state() {
  return {
    "งาน A": {
      color: "blue", createdAt: 1, updatedAt: 100, liveWindowIds: [],
      tabs: { "https://a/1": { url: "https://a/1", title: "รายงาน", order: 1, liveCount: 0 } }
    },
    "งาน B": {
      color: "red", createdAt: 2, updatedAt: 300, liveWindowIds: [1],
      tabs: {
        "https://b/1": { url: "https://b/1", title: "Live View", order: 0, liveCount: 2 },
        "https://b/2": { url: "https://b/2", title: "sleeping", order: 2, liveCount: 0 }
      }
    },
    "z ส่วนตัว": {
      color: "grey", createdAt: 3, updatedAt: 200, liveWindowIds: [],
      tabs: { "https://z/1": { url: "https://z/1", title: "docs", order: 0, liveCount: 0 } }
    }
  };
}

test("sortGroupCards: เรียงตาม updatedAt ล่าสุดก่อน (ชนกันเรียงชื่อ)", () => {
  const cards = sortGroupCards(state());
  assert.deepEqual(cards.map(c => c.name), ["งาน B", "z ส่วนตัว", "งาน A"]);
});

test("filterGroupCards: ค้นจากชื่อกลุ่ม / title / URL ได้ และคงลำดับเดิม", () => {
  const groups = state();
  assert.deepEqual(filterGroupCards(groups, "งาน").map(c => c.name), ["งาน B", "งาน A"]);
  assert.deepEqual(filterGroupCards(groups, "รายงาน").map(c => c.name), ["งาน A"]);
  assert.deepEqual(filterGroupCards(groups, "https://z").map(c => c.name), ["z ส่วนตัว"]);
  assert.deepEqual(filterGroupCards(groups, "LIVE v").map(c => c.name), ["งาน B"], "ไม่สนตัวเล็กใหญ่");
  assert.deepEqual(filterGroupCards(groups, "ไม่มีจริง").map(c => c.name), []);
  assert.deepEqual(filterGroupCards(groups, "   ").map(c => c.name), ["งาน B", "z ส่วนตัว", "งาน A"], "ว่าง = ทั้งหมด");
});

test("splitTabsByState: ตื่น/หลับ แยกกันและเรียงตาม order", () => {
  const { live, idle } = splitTabsByState(state()["งาน B"]);
  assert.deepEqual(live.map(t => t.url), ["https://b/1"]);
  assert.deepEqual(idle.map(t => t.url), ["https://b/2"]);
});

test("buildStats: นับกลุ่ม / แท็บ / ตื่น / กลุ่ม live", () => {
  assert.deepEqual(buildStats(state()), { groups: 3, tabs: 4, awake: 1, liveGroups: 1 });
  assert.deepEqual(buildStats({}), { groups: 0, tabs: 0, awake: 0, liveGroups: 0 });
});

test("formatRelativeTime: ขั้นบันไดคำอ่านไทย", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 2_000, now), "เมื่อสักครู่");
  assert.equal(formatRelativeTime(now - 40_000, now), "40 วินาทีก่อน");
  assert.equal(formatRelativeTime(now - 90_000, now), "1 นาทีก่อน");
  assert.equal(formatRelativeTime(now - 7_200_000, now), "2 ชั่วโมงก่อน");
  assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), "3 วันก่อน");
  assert.equal(formatRelativeTime(null, now), null);
});

test("resolveTheme: ธีมที่บันทึกไว้มาก่อน, auto ตามระบบ", () => {
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("auto", true), "dark");
  assert.equal(resolveTheme("auto", false), "light");
  assert.equal(resolveTheme(undefined, false), "light", "ค่าเริ่มไม่ระบุ = auto");
});

test("groupDeleteConfirmMessage: เตือนเพิ่มเมื่อกลุ่มยัง live", () => {
  const idleMsg = groupDeleteConfirmMessage("งาน A", 4, false);
  assert.ok(idleMsg.includes('งาน A'));
  assert.ok(idleMsg.includes("4 แท็บ"));
  assert.ok(!idleMsg.includes("⚠"));
  const liveMsg = groupDeleteConfirmMessage("งาน B", 2, true);
  assert.ok(liveMsg.includes("⚠"));
  assert.ok(liveMsg.includes("ยังเปิดอยู่"));
});
