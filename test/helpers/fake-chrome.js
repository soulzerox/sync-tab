/**
 * Fake chrome environment for node --test — แทน chrome (tabs/tabGroups/windows/storage)
 * รองรับทั้ง event-style handlers ที่ BrowserMirror จับ และ call-sequence ของ RestoreEngine
 * (บันทึกลำดับคำสั่งลง fake.__ops เพื่อ assert create → group → update → discard)
 *
 * อนุสัญญาเลข id: seed ที่ผู้ทดสอบสร้างใช้ id 100 ขึ้นไป; fake generate ตัวใหม่เริ่มจาก 1
 */

import { STORAGE_KEY } from "../../shared/constants.js";

/**
 * @param {object} [seed]
 * @param {Array<{
 *   id?: number, incognito?: boolean, focused?: boolean,
 *   groups?: Array<{ id?: number, title?: string, color?: string, collapsed?: boolean }>,
 *   tabs?: Array<{ id?: number, url?: string, title?: string, favIconUrl?: string, groupId?: number, active?: boolean, pinned?: boolean }>
 * }>} [seed.windows]
 */
export function createFakeChrome(seed = {}) {
  let nextId = 1;

  const windows = new Map();
  const tabs = new Map();
  const groups = new Map();
  const ops = [];


  const listeners = {
    tabs: { onCreated: [], onUpdated: [], onRemoved: [], onMoved: [], onAttached: [], onDetached: [] },
    tabGroups: { onCreated: [], onUpdated: [], onRemoved: [] },
    windows: { onCreated: [], onRemoved: [], onFocusChanged: [] },
    runtime: { onInstalled: [], onStartup: [] },
    commands: { onCommand: [] }
  };

  const withListener = (target, name) => ({
    addListener: fn => target[name].push(fn),
    removeListener: fn => {
      const i = target[name].indexOf(fn);
      if (i >= 0) target[name].splice(i, 1);
    }
  });

  const fake = {
    __ops: ops,
    __state: { windows, tabs, groups },
    listeners,
    lastFocusedWindowId: null,

    // ---------- chrome.tabs ----------
    tabs: {
      /** ผู้ทดสอบเลือก windowId ชัด ๆ — restore engine ต้องส่งมาเสมอ */
      create: async createProperties => {
        const id = nextId++;
        const windowId = createProperties.windowId;
        if (!windows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        const tab = {
          id,
          windowId,
          groupId: -1,
          url: createProperties.url ?? "",
          // จำลอง Edge จริง: ตอน create แท็บยังไม่ commit URL — url ว่าง, pendingUrl มีค่า
          pendingUrl: createProperties.url ?? "",
          title: createProperties.url ?? "New Tab",
          favIconUrl: "",
          active: Boolean(createProperties.active),
          pinned: Boolean(createProperties.pinned),
          incognito: windows.get(windowId)?.incognito ?? false,
          discarded: false,
          status: "loading"
        };
        tabs.set(id, tab);
        ops.push({ fn: "tabs.create", args: { ...createProperties } });
        // ลำดับ event แบบ Edge จริง (sync เพื่อให้เทส deterministic):
        // 1) loading ไม่มี url (Edge ยิงแบบนี้ก่อน — ถ้านับเป็น commit = discard ยกเลิกโหลด = แท็บว่าง Untitled)
        // 2) loading + url (navigation เริ่ม) 3) title (document title ตั้งแล้ว — strip ไม่ Untitled) 4) complete
        for (const fn of listeners.tabs.onUpdated) {
          fn(id, { status: "loading" }, { ...tab });
        }
        if (tab.pendingUrl) {
          tab.url = tab.pendingUrl;
          for (const fn of listeners.tabs.onUpdated) {
            fn(id, { status: "loading", url: tab.url }, { ...tab });
          }
          for (const fn of listeners.tabs.onUpdated) {
            fn(id, { title: tab.title }, { ...tab });
          }
          tab.status = "complete";
          for (const fn of listeners.tabs.onUpdated) {
            fn(id, { status: "complete" }, { ...tab });
          }
        }
        return { ...tab };
      },
      /** options: { tabIds, groupId } หรือ { tabIds, createProperties: { windowId } } */
      group: async options => {
        const { tabIds } = options;
        let gid;
        if (options.groupId) {
          gid = options.groupId;
          if (!groups.has(gid)) throw new Error(`No group with id: ${gid}`);
        } else {
          gid = nextId++;
          groups.set(gid, {
            id: gid,
            title: options.createProperties?.title ?? "",
            color: options.createProperties?.color ?? "grey",
            collapsed: false,
            windowId: options.createProperties?.windowId
          });
        }
        for (const tid of tabIds) {
          const t = tabs.get(tid);
          if (!t) throw new Error(`No tab with id: ${tid}`);
          t.groupId = gid;
        }
        ops.push({ fn: "tabs.group", args: { tabIds: [...tabIds], groupId: options.groupId ?? null, createProperties: options.createProperties ?? null } });
        return gid;
      },
      discard: async tabId => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        t.discarded = true;
        t.status = "complete";
        ops.push({ fn: "tabs.discard", args: { tabId } });
      },
      get: async tabId => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        return { ...t };
      },
      query: async (queryInfo = {}) => {
        return [...tabs.values()]
          .filter(t => (queryInfo.windowId === undefined ? true : t.windowId === queryInfo.windowId))
          .filter(t => (queryInfo.groupId === undefined ? true : t.groupId === queryInfo.groupId))
          .map(t => ({ ...t }));
      },
      update: async (tabId, properties) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(t, properties);
        ops.push({ fn: "tabs.update", args: { tabId, ...properties } });
        return { ...t };
      },
      remove: async tabIds => {
        for (const id of [].concat(tabIds)) {
          tabs.delete(id);
          ops.push({ fn: "tabs.remove", args: { tabIds: id } });
        }
      },
      ungroup: async tabIds => {
        for (const id of [].concat(tabIds)) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
      },
      onCreated: withListener(listeners.tabs, "onCreated"),
      onUpdated: withListener(listeners.tabs, "onUpdated"),
      onRemoved: withListener(listeners.tabs, "onRemoved"),
      onMoved: withListener(listeners.tabs, "onMoved"),
      onAttached: withListener(listeners.tabs, "onAttached"),
      onDetached: withListener(listeners.tabs, "onDetached")
    },

    // ---------- chrome.tabGroups ----------
    tabGroups: {
      query: async (queryInfo = {}) => {
        return [...groups.values()]
          .filter(g => (queryInfo.windowId === undefined ? true : g.windowId === queryInfo.windowId))
          .filter(g => (queryInfo.title === undefined ? true : g.title === queryInfo.title))
          .map(g => ({ ...g }));
      },
      update: async (groupId, updateProperties) => {
        const g = groups.get(groupId);
        if (!g) throw new Error(`No group with id: ${groupId}`);
        if (updateProperties.title !== undefined) g.title = updateProperties.title;
        if (updateProperties.color !== undefined) g.color = updateProperties.color;
        if (updateProperties.collapsed !== undefined) g.collapsed = updateProperties.collapsed;
        ops.push({ fn: "tabGroups.update", args: { groupId, ...updateProperties } });
        return { ...g };
      },
      onCreated: withListener(listeners.tabGroups, "onCreated"),
      onUpdated: withListener(listeners.tabGroups, "onUpdated"),
      onRemoved: withListener(listeners.tabGroups, "onRemoved")
    },

    // ---------- chrome.windows ----------
    windows: {
      create: async createProperties => {
        const id = nextId++;
        const win = { id, incognito: Boolean(createProperties?.incognito), focused: Boolean(createProperties?.focused), lastFocusedAt: 1 };
        windows.set(id, win);
        ops.push({ fn: "windows.create", args: createProperties ?? {} });
        return { ...win };
      },
      get: async windowId => {
        const w = windows.get(windowId);
        if (!w) throw new Error(`No window with id: ${windowId}`);
        return { ...w };
      },
      getAll: async (queryInfo = {}) => {
        const result = [];
        for (const w of windows.values()) {
          const win = { id: w.id, incognito: w.incognito, focused: w.focused };
          if (queryInfo.populate) {
            win.tabs = [...tabs.values()].filter(t => t.windowId === w.id).map(t => ({ ...t }));
          }
          result.push(win);
        }
        return result;
      },
      getLastFocused: async () => {
        let best = null;
        for (const w of windows.values()) {
          if (!best || (w.focused ? (best.focused ? w.lastFocusedAt > best.lastFocusedAt : true) : !best.focused ? w.lastFocusedAt > best.lastFocusedAt : false)) {
            best = w;
          }
        }
        if (!best) throw new Error("No last-focused window");
        return { ...best };
      },
      remove: async windowId => {
        for (const t of [...tabs.values()]) if (t.windowId === windowId) tabs.delete(t.id);
        for (const g of [...groups.values()]) if (g.windowId === windowId) groups.delete(g.id);
        windows.delete(windowId);
      },
      onCreated: withListener(listeners.windows, "onCreated"),
      onRemoved: withListener(listeners.windows, "onRemoved"),
      onFocusChanged: withListener(listeners.windows, "onFocusChanged")
    },

    runtime: {
      lastError: null,
      onInstalled: withListener(listeners.runtime, "onInstalled"),
      onStartup: withListener(listeners.runtime, "onStartup"),
      id: "fake-extension-id"
    },

    commands: { onCommand: withListener(listeners.commands, "onCommand") },

    storage: {
      local: (() => {
        const data = new Map();
        return {
          data,
          get: async keys => {
            if (keys === null) return Object.fromEntries(data);
            if (typeof keys === "string") return data.has(keys) ? { [keys]: data.get(keys) } : {};
            if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => data.has(k)).map(k => [k, data.get(k)]));
            return Object.fromEntries(Object.keys(keys).filter(k => data.has(k)).map(k => [k, data.get(k)]));
          },
          set: async obj => {
            for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
          },
          remove: async keys => {
            const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
            for (const k of list) data.delete(k);
          },
          clear: async () => data.clear()
        };
      })()
    }
  };

  // โหลด seed หลังประกาศ fake เสร็จ (กันการอ้าง objet ก่อนเวลา)
  for (const w of seed.windows ?? []) {
    const wid = w.id ?? nextId++;
    windows.set(wid, { id: wid, incognito: Boolean(w.incognito), focused: Boolean(w.focused), lastFocusedAt: w.focused ? 2 : 1 });
    if (w.focused) fake.lastFocusedWindowId = wid;
    for (const g of w.groups ?? []) {
      const gid = g.id ?? nextId++;
      groups.set(gid, { id: gid, title: g.title ?? "", color: g.color ?? "grey", collapsed: Boolean(g.collapsed), windowId: wid });
    }
    for (const t of w.tabs ?? []) {
      const tabId = t.id ?? nextId++;
      tabs.set(tabId, {
        id: tabId,
        windowId: wid,
        groupId: t.groupId ?? -1,
        url: t.url ?? "",
        title: t.title ?? "",
        favIconUrl: t.favIconUrl ?? "",
        active: Boolean(t.active),
        pinned: Boolean(t.pinned),
        incognito: Boolean(w.incognito),
        discarded: Boolean(t.discarded), // v3.1 — seed แท็บเปิดค้างแบบ Edge Sleeping Tabs ได้ (discarded=true)
        status: "complete"
      });
    }
  }

  return fake;
}

/** สร้าง Tab object แบบอย่างที่ Edge แนบมาใน events (ผู้ทดสอบยิงเข้า mirror handlers) */
export function tabEvent({ id, url, title = "T", favIconUrl = "f.png", groupId = -1, windowId = 1, incognito = false, discarded = false, pinned = false, active = false, status = "complete" }) {
  return { id, url, title, favIconUrl, groupId, windowId, incognito, discarded, pinned, active, status, index: 0 };
}

export { STORAGE_KEY };
