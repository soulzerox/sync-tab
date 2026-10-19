/**
 * Global Constants & Configurations for Browser Tab Sync Extension
 * Target: Microsoft Edge on Ubuntu Linux OS (Manifest V3)
 * Specification: SOT v2.3.0
 */

export const STORAGE_VERSION = "2.3.0";

export const TIMINGS = {
  HOT_DEBOUNCE_MS: 400,          // Debounce time for live tab update events
  CLOSE_FLUSH_MS: 0,             // Synchronous flush on window/tab close
  RESTORE_SETTLE_MS: 600,        // Settle delay after massive restore before un-guarding
  MICRO_CHUNK_DELAY_MS: 200      // Pause between restored tabs to smooth CPU usage
};

export const THRESHOLDS = {
  MICRO_CHUNK_SIZE: 1,            // Restore tabs individually instead of opening bursts
  MAX_TITLE_LENGTH: 500,         // Prevent payload > 1MB Native buffer overflow
  MAX_CLOSED_WINDOWS_RETENTION: 5, // Hard cap for all archived windows, including pinned templates
  MAX_RECOVERY_CHECKPOINTS: 5,
  SUSPECTED_TAB_LOSS_MINIMUM: 5,
  SUSPECTED_TAB_LOSS_FRACTION: 0.5
};

export const RECOVERY_CHECKPOINT_ALARM = "synctab-recovery-checkpoint";

export const NATIVE_MESSAGING = {
  HOST_NAME: "com.synctab.native",
  DEFAULT_DB_PATH: "~/.local/share/sync-tab/tabs.sqlite"
};

/** @type {readonly import("./types.js").TabGroupColor[]} */
export const CHROMIUM_TAB_GROUP_COLORS = Object.freeze([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

export const DEFAULT_TAB_GROUP_COLOR = "grey";

export const IGNORED_URL_PREFIXES = Object.freeze([
  "edge://",
  "chrome://",
  "chrome-extension://",
  "devtools://",
  "about:blank",
  "view-source:",
  "javascript:",
  "data:",
  "blob:"
]);

export const TRACKING_PARAM_PREFIXES = Object.freeze([
  "utm_",
  "fbclid",
  "gclid",
  "mc_eid",
  "_ga",
  "msclkid",
  "igshid",
  "_hsenc",
  "_openstat",
  "yclid",
  "wickedid"
]);

export const DEFAULT_SETTINGS = Object.freeze({
  autoRestoreOnStartup: true, // Auto-restore previous session tabs on browser startup
  storageDriver: "auto", // "auto" | "chrome_storage" | "sqlite_native"
  sqliteDbPath: "~/.local/share/sync-tab/tabs.sqlite",
  lazyRestore: true,     // discarded: true (Edge Sleeping Tabs)
  autoCleanBlankNewTab: true,
  maxClosedWindowsRetention: 5,
  stripTrackingParams: true,
  blacklistDomains: []
});
