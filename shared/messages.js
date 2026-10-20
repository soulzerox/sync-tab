/**
 * Message constants (Popup ↔ Service Worker) — SyncTab Group Sync v3
 * SOT §4: typed RPC, response ทุกเมสเสจ = { ok: true, ...payload } | { ok: false, error }
 */

export const MSG = Object.freeze({
  GET_STATE: "GET_STATE",
  OPEN_TABS: "OPEN_TABS",
  DELETE_GROUP: "DELETE_GROUP",
  DELETE_TAB: "DELETE_TAB",
  DELETE_TABS: "DELETE_TABS",
  RENAME_GROUP: "RENAME_GROUP",
  SET_THEME: "SET_THEME"
});

export const THEME_VALUES = Object.freeze({ DARK: "dark", LIGHT: "light", AUTO: "auto" });
