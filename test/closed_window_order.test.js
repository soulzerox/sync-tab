import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatArchiveTimestamp,
  sortClosedWindowsNewestFirst
} from "../shared/closed-window-order.js";

test("closed windows are ordered newest first using lastUpdated when closedAt is absent", () => {
  const windows = [
    { windowUuid: "older", closedAt: 100, lastUpdated: 900 },
    { windowUuid: "latest", closedAt: 300, lastUpdated: 300 },
    { windowUuid: "fallback", lastUpdated: 200 }
  ];

  assert.deepEqual(
    sortClosedWindowsNewestFirst(windows).map((win) => win.windowUuid),
    ["latest", "fallback", "older"]
  );
});

test("archive time shows the local date and relative minutes or hours using closedAt", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const formatDate = (timestamp) => new Intl.DateTimeFormat("th-TH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp));

  const minutesAgo = formatArchiveTimestamp({ closedAt: now - 12 * 60 * 1000 }, now);
  assert.equal(minutesAgo, `${formatDate(now - 12 * 60 * 1000)} · 12 นาทีที่แล้ว`);

  const hoursAgo = formatArchiveTimestamp({ closedAt: now - 3 * 60 * 60 * 1000 }, now);
  assert.equal(hoursAgo, `${formatDate(now - 3 * 60 * 60 * 1000)} · 3 ชั่วโมงที่แล้ว`);
});

test("archive time falls back to lastUpdated for legacy windows", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");

  assert.equal(
    formatArchiveTimestamp({ lastUpdated: now - 2 * 60 * 1000 }, now),
    `${new Intl.DateTimeFormat("th-TH", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(now - 2 * 60 * 1000))} · 2 นาทีที่แล้ว`
  );
});
