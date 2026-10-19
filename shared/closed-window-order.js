/**
 * Orders archived windows from newest to oldest without mutating the input.
 * Uses lastUpdated for legacy entries that do not have a closedAt timestamp.
 * @param {Array<{closedAt?: number, lastUpdated?: number}>} windows
 * @returns {Array}
 */
export function sortClosedWindowsNewestFirst(windows = []) {
  return [...windows].sort((a, b) => {
    const timeA = Number(a.closedAt || a.lastUpdated || 0);
    const timeB = Number(b.closedAt || b.lastUpdated || 0);
    return timeB - timeA;
  });
}

/**
 * Formats the archive timestamp as a Bangkok-local date and relative age.
 * Falls back to lastUpdated for archive entries created by older versions.
 * @param {{closedAt?: number, lastUpdated?: number}} windowData
 * @param {number} [now]
 * @returns {string}
 */
export function formatArchiveTimestamp(windowData, now = Date.now()) {
  const timestamp = Number(windowData?.closedAt ?? windowData?.lastUpdated);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "ไม่ทราบวันที่ปิด";

  const absolute = new Intl.DateTimeFormat("th-TH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp));

  const ageMs = Math.max(0, now - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let relative;
  if (ageMs < minute) {
    relative = "ไม่ถึง 1 นาทีที่แล้ว";
  } else if (ageMs < hour) {
    relative = `${Math.floor(ageMs / minute)} นาทีที่แล้ว`;
  } else if (ageMs < day) {
    relative = `${Math.floor(ageMs / hour)} ชั่วโมงที่แล้ว`;
  } else {
    relative = `${Math.floor(ageMs / day)} วันที่แล้ว`;
  }

  return `${absolute} · ${relative}`;
}
