/**
 * SyncTab Group Sync — popup (pure view + typed RPC, SOT v3.0.0 §7)
 * ห้ามแตะ chrome.* โดยตรง — สื่อสารผ่าน runtime messages เท่านั้น
 */

import { MSG, THEME_VALUES } from "../shared/messages.js";
import {
  filterGroupCards,
  splitTabsByState,
  buildStats,
  formatRelativeTime,
  resolveTheme,
  groupDeleteConfirmMessage
} from "../shared/ui-utils.js";

const API = chrome;

// ---------- primitives ----------
const $ = sel => document.querySelector(sel);
const listEl = $("#list");
const toastHost = $("#toast-host");

function send(message) {
  return new Promise(resolve => {
    API.runtime.sendMessage(message, response => {
      void chrome.runtime.lastError;
      resolve(response ?? { ok: false, error: "no-response" });
    });
  });
}

function toast(text, { warn = false, ms = 2500 } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (warn ? " warn" : "");
  el.textContent = text;
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add("gone");
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// escape ตัวหนังสือของผู้ใช้ทุกตำแหน่ง (title อาจมี <script> ปลอมจากหน้าเว็บก็ได้)
function esc(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML.replace(/"/g, "&quot;");
}

function letter(text) {
  for (const ch of String(text ?? "")) {
    if (/[A-Za-z0-9ก-๙]/.test(ch)) return ch.toUpperCase();
  }
  return "?";
}

const ICONS = {
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  breadcrumb: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
};

function svg(paths, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ---------- state ----------
/** @type {{ groups: Record<string, any>, themePreference: string, lastScanAt: number|null }} */
let state = { groups: {}, themePreference: THEME_VALUES.AUTO, lastScanAt: null };
let currentTheme = "dark";
let restoringGroups = new Set(); // ชื่อกลุ่มที่กำลังเปิด (busy ปุ่ม)

// ---------- theme ----------
function applyTheme(pref) {
  currentTheme = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("theme-light", currentTheme === "light");
  $("#theme-icon").innerHTML = currentTheme === "dark" ? ICONS.moon : ICONS.sun;
}

$("#theme-toggle").addEventListener("click", async () => {
  const next = currentTheme === "dark" ? THEME_VALUES.LIGHT : THEME_VALUES.DARK;
  state.themePreference = next;
  applyTheme(next);
  await send({ type: MSG.SET_THEME, payload: { theme: next } });
});

// ---------- data flow ----------
async function refresh() {
  const response = await send({ type: MSG.GET_STATE });
  if (!response?.ok) {
    toast("ขอสถานะจาก extension ไม่สำเร็จ — ลองเปิด popup ใหม่", { warn: true });
    return;
  }
  state = response;
  applyTheme(state.themePreference ?? THEME_VALUES.AUTO);
  render();
  if (state.showMigrationNotice) {
    toast("อัปเกรดเป็น Group Sync แล้ว — ข้อมูลระบบเก่า (สำรองหน้าต่าง) ถูกล้างออกแล้ว", { ms: 4000 });
  }
}

// ---------- render ----------
function render() {
  renderStats();
  renderList();
  renderFooter();
}

function renderStats() {
  const stats = buildStats(state.groups);
  $("#stat-groups").textContent = String(stats.groups);
  $("#stat-tabs").textContent = String(stats.tabs);
  $("#stat-awake").textContent = String(stats.awake);
}

function renderFooter() {
  $("#sync-time").textContent = formatRelativeTime(state.lastScanAt, Date.now()) ?? "ยังไม่สแกน";
}

function renderList() {
  const query = $("#search").value;
  const cards = filterGroupCards(state.groups, query);
  listEl.replaceChildren();

  if (cards.length === 0) {
    listEl.innerHTML = state.groups && Object.keys(state.groups).length
      ? `<div class="empty"><div class="glyph">${svg(ICONS.breadcrumb)}</div><b>ไม่พบกลุ่มที่ตรงกับคำค้น</b><small>ลองค้นจากชื่อกลุ่ม ชื่อหน้า หรือ URL</small></div>`
      : `<div class="empty"><div class="glyph">${svg(ICONS.breadcrumb)}</div><b>ยังไม่มีกลุ่มที่ถูกจับ</b><small>ลากแท็บเข้ากลุ่มที่ตั้งชื่อใน Edge เพื่อเริ่มซิงก์อัตโนมัติ</small></div>`;
    return;
  }

  for (const { name, record } of cards) {
    listEl.append(buildCard(name, record));
  }
}

function faviconCell(tab) {
  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.src = tab.favIconUrl;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => {
      const span = document.createElement("span");
      span.textContent = letter(tab.title);
      img.replaceWith(span);
    };
    const cell = document.createElement("span");
    cell.className = "favicon";
    cell.append(img);
    return cell;
  }
  const cell = document.createElement("span");
  cell.className = "favicon";
  cell.style.background = "var(--surface-2)";
  cell.style.color = "var(--muted)";
  cell.textContent = letter(tab.title);
  return cell;
}

function buildCard(name, record) {
  const details = document.createElement("details");
  details.className = "card";
  details.style.setProperty("--g", `var(--${record.color})`);

  const liveCount = Object.values(record.tabs).filter(t => t.liveCount > 0).length;
  const totalCount = Object.keys(record.tabs).length;
  const idleCount = totalCount - liveCount;
  const windowCount = (record.liveWindowIds ?? []).length;

  // ---- summary ----
  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="chev">${svg(ICONS.chev)}</span>
    <span class="chip" title="${esc(name)}">${esc(name)}</span>
    <span class="pill ${liveCount > 0 ? "live" : ""}"><b>${liveCount}</b> ตื่น / ${totalCount}</span>
    <span class="pill">${windowCount > 0 ? `${windowCount} หน้าต่าง` : "ไม่ได้เปิด"}</span>`;
  const renameBtn = document.createElement("button");
  renameBtn.className = "iconbtn rename";
  renameBtn.setAttribute("aria-label", `เปลี่ยนชื่อกลุ่ม ${name}`);
  renameBtn.title = "เปลี่ยนชื่อกลุ่ม";
  renameBtn.innerHTML = svg(ICONS.pencil);
  renameBtn.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    startRename(summary, renameBtn, name);
  });
  summary.append(renameBtn);
  details.append(summary);

  // ---- rows ----
  const { live, idle } = splitTabsByState(record);
  const sect = document.createElement("div");
  sect.className = "sect";
  if (live.length > 0) {
    sect.append(sectLabel("ตื่นอยู่บนเบราว์เซอร์", live.length));
    for (const tab of live) sect.append(buildRow(tab, { live: true, groupName: name }));
  }
  if (idle.length > 0) {
    sect.append(sectLabel(live.length > 0 ? "จำไว้ (หลับ)" : "จำไว้ (หลับ — กลุ่มปิดอยู่)", idle.length));
    for (const tab of idle) sect.append(buildRow(tab, { live: false, groupName: name }));
  }
  details.append(sect);

  // ---- actions ----
  const acts = document.createElement("div");
  acts.className = "acts";
  const selBtn = document.createElement("button");
  selBtn.className = "btn";
  selBtn.disabled = true;
  selBtn.textContent = "เปิดที่เลือก (0)";
  selBtn.addEventListener("click", () => openTabs(name, selectedUrls(details, true)));

  const delSelBtn = document.createElement("button");
  delSelBtn.className = "btn danger-sel";
  delSelBtn.hidden = true;
  delSelBtn.setAttribute("aria-label", `ลบแท็บที่เลือกออกจากกลุ่ม ${name}`);
  delSelBtn.title = "ลบแท็บที่จำไว้ที่เลือก (แท็บบนเบราว์เซอร์ไม่ถูกแตะ)";
  delSelBtn.textContent = "ลบที่เลือก (0)";
  delSelBtn.addEventListener("click", () => deleteTabsSelected(name, collectedSelection(details)));

  const allBtn = document.createElement("button");
  allBtn.className = "btn primary";
  allBtn.textContent = `เปิดทั้งหมด ${idleCount}`;
  allBtn.disabled = idleCount === 0;
  allBtn.addEventListener("click", () => openTabs(name, []));

  const delBtn = document.createElement("button");
  delBtn.className = "btn ghost-danger";
  delBtn.setAttribute("aria-label", `ลบกลุ่ม ${name} จาก extension`);
  delBtn.title = "ลบกลุ่มจากคลัง (ไม่แตะแท็บบนเบราว์เซอร์)";
  delBtn.innerHTML = svg(ICONS.trash);
  delBtn.addEventListener("click", () => deleteGroup(name, windowCount > 0));

  acts.append(selBtn, delSelBtn, allBtn, delBtn);
  details.append(acts);

  // เปลี่ยนของ checkbox → ปุ่มเปิดที่เลือก + ลบที่เลือก
  details.addEventListener("change", () => {
    const n = collectedSelection(details).length;
    selBtn.disabled = n === 0;
    selBtn.textContent = `เปิดที่เลือก (${n})`;
    delSelBtn.hidden = n === 0;
    delSelBtn.textContent = `ลบที่เลือก (${n})`;
  });

  return details;
}

function sectLabel(text, count, suffix = "") {
  const el = document.createElement("div");
  el.className = "sect-label";
  el.innerHTML = `${esc(text)} <span class="count">${count}</span>${esc(suffix)}`;
  return el;
}

const selectedUrls = (cardEl, checkedOnly) => collectedSelection(cardEl);
const collectedSelection = cardEl => [...cardEl.querySelectorAll(".cbx:checked")].map(cb => cb.dataset.url);

function buildRow(tab, { live, groupName }) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.url = tab.url;

  const cbx = document.createElement("input");
  cbx.type = "checkbox";
  cbx.className = "cbx" + (live ? " live-locked" : "");
  cbx.disabled = live;
  if (live) { cbx.setAttribute("aria-label", "แท็บที่กำลังเปิด เลือกเปิดซ้ำไม่ได้"); } else {
    cbx.dataset.url = tab.url;
    cbx.setAttribute("aria-label", `เลือกแท็บ ${tab.title}`);
  }

  row.append(cbx);
  if (live) {
    const dot = document.createElement("span");
    dot.className = "dotlive";
    row.append(dot);
  } else {
    const moon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    moon.setAttribute("viewBox", "0 0 24 24");
    moon.setAttribute("class", "moon");
    moon.innerHTML = ICONS.moon;
    row.append(moon);
  }
  row.append(faviconCell(tab));

  const t = document.createElement("div");
  t.className = "t";
  t.innerHTML = `<div class="a">${esc(tab.title || tab.url)}</div><div class="u">${esc(shortUrl(tab.url))}</div>`;
  row.append(t);

  if (!live) {
    const del = document.createElement("button");
    del.className = "del";
    del.setAttribute("aria-label", `ลบแท็บ ${tab.title}`);
    del.title = "ลบจากคลัง";
    del.innerHTML = svg(ICONS.trash);
    del.addEventListener("click", () => deleteTab(groupName, tab.url, tab.title));
    row.append(del);
  }
  return row;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host.length > 46 ? u.host : u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

// ---------- actions ----------
async function openTabs(groupName, urls) {
  const card = [...listEl.children].find(el => el.querySelector(".chip")?.textContent === groupName);
  const buttons = card ? [...card.querySelectorAll(".btn")] : [];
  buttons.forEach(b => b.classList.add("busy"));

  const response = await send({ type: MSG.OPEN_TABS, payload: { groupName, urls } });

  buttons.forEach(b => b.classList.remove("busy"));

  if (!response?.ok) {
    if (response?.error === "busy") { toast("มีการเปิดกลุ่มนี้ทำงานอยู่ — รอให้เสร็จก่อนแล้วลองอีกที"); return; }
    if (response?.error === "no-record") { toast("กลุ่มนี้ถูกลบไปแล้ว", { warn: true }); await refresh(); return; }
    toast(`เปิดไม่สำเร็จ: ${response?.error ?? "?"}`, { warn: true });
    return;
  }
  const { opened, skipped } = response;
  toast(
    opened > 0
      ? `เปิดแล้ว ${opened} แท็บ (โหมดหลับ — คลิกค่อยโหลด)` + (skipped > 0 ? ` · ข้ามที่เปิดอยู่แล้ว ${skipped}` : "")
      : "ไม่มีแท็บใหม่ที่ต้องเปิด (ตัวที่เลือกเปิดอยู่แล้ว)"
  );
  setTimeout(refresh, 900);
}

async function deleteGroup(groupName, isLive) {
  const record = state.groups[groupName];
  const tabsCount = record ? Object.keys(record.tabs).length : 0;
  const ok = window.confirm(groupDeleteConfirmMessage(groupName, tabsCount, isLive));
  if (!ok) return;
  const response = await send({ type: MSG.DELETE_GROUP, payload: { groupName } });
  if (!response?.ok) { toast(`ลบไม่สำเร็จ: ${response?.error ?? "?"}`, { warn: true }); return; }
  delete state.groups[groupName];
  render();
  toast(`ลบกลุ่ม "${groupName}" จากคลังแล้ว`);
}

async function deleteTab(groupName, url, title) {
  const response = await send({ type: MSG.DELETE_TAB, payload: { groupName, url } });
  if (!response?.ok) { toast(`ลบไม่สำเร็จ: ${response?.error ?? "?"}`, { warn: true }); return; }
  const record = state.groups[groupName];
  if (record) {
    delete record.tabs[url];
    if (Object.keys(record.tabs).length === 0) delete state.groups[groupName];
  }
  render();
  toast(`ลบแล้ว "${title}"`);
}

/** ลบแท็บที่จำไว้หลายรายการที่ tick ไว้ (IDLE เท่านั้น — แท็บตื่นไม่ถูกเลือกได้อยู่แล้ว) */
async function deleteTabsSelected(groupName, urls) {
  if (urls.length === 0) return;
  const ok = window.confirm(`ลบแท็บที่จำไว้ ${urls.length} รายการออกจากคลัง "${groupName}"?\n(แท็บบนเบราว์เซอร์ไม่ถูกแตะ)`);
  if (!ok) return;
  const response = await send({ type: MSG.DELETE_TABS, payload: { groupName, urls } });
  if (!response?.ok) { toast(`ลบไม่สำเร็จ: ${response?.error ?? "?"}`, { warn: true }); return; }
  await refresh();
  toast(`ลบแท็บที่จำไว้ ${response.removed ?? urls.length} รายการแล้ว`);
}

function startRename(summaryEl, renameBtn, groupName) {
  const chip = summaryEl.querySelector(".chip");
  if (!chip || summaryEl.querySelector(".chip-input")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "chip-input";
  input.value = groupName;
  input.setAttribute("aria-label", "ชื่อกลุ่มใหม่");
  chip.replaceWith(input);
  renameBtn.style.display = "none";
  input.focus();
  input.select();

  const restoreUI = () => {
    input.replaceWith(chip);
    renameBtn.style.display = "";
  };

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === groupName) { restoreUI(); return; }
    const response = await send({ type: MSG.RENAME_GROUP, payload: { groupName, newName } });
    if (!response?.ok) { toast(`เปลี่ยนชื่อไม่สำเร็จ: ${response?.error ?? "?"}`, { warn: true }); restoreUI(); return; }
    await refresh();
    toast(`เปลี่ยนชื่อเป็น "${newName}" แล้ว`);
  };

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") restoreUI();
    if (event.key === "Enter" || event.key === "Escape") event.preventDefault();
  });
  input.addEventListener("blur", commit);
}

// search filter
let searchTimer = null;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderList(), 120);
});

// footer timer
setInterval(renderFooter, 10_000);

refresh();
