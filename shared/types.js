/**
 * JSDoc Type Definitions for Browser Tab Sync Extension
 * @typedef {"grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"} TabGroupColor
 *
 * @typedef {Object} WindowBounds
 * @property {number} [left]
 * @property {number} [top]
 * @property {number} [width]
 * @property {number} [height]
 * @property {"normal" | "minimized" | "maximized" | "fullscreen"} [state]
 *
 * @typedef {Object} TabGroupData
 * @property {string} title
 * @property {TabGroupColor} color
 * @property {boolean} collapsed
 *
 * @typedef {Object} TabData
 * @property {string} url
 * @property {string} title
 * @property {string} [favIconUrl]
 * @property {boolean} pinned
 * @property {number} index
 * @property {TabGroupData} [group]
 *
 * @typedef {Object} WindowData
 * @property {string} windowUuid
 * @property {string} [customName]
 * @property {boolean} isClosed
 * @property {boolean} [isPinnedTemplate]
 * @property {number} [closedAt]
 * @property {number} lastUpdated
 * @property {WindowBounds} [bounds]
 * @property {TabData[]} tabs
 *
 * @typedef {Object} PreviousSessionBackup
 * @property {number} timestamp
 * @property {"last_window_close" | "browser_shutdown" | "crash_recovery" | "manual_checkpoint"} triggerReason
 * @property {number} totalWindows
 * @property {number} totalTabs
 * @property {WindowData[]} windows
 *
 * @typedef {Object} RecoveryCheckpoint
 * @property {number} timestamp
 * @property {number} lastVerifiedAt
 * @property {number} totalWindows
 * @property {number} totalTabs
 * @property {string} fingerprint
 * @property {WindowData[]} windows
 *
 * @typedef {Object} RecoveryAlert
 * @property {number} detectedAt
 * @property {number} lostTabs
 * @property {number} previousTabCount
 * @property {number} currentTabCount
 * @property {number} checkpointTimestamp
 *
 * @typedef {Object} ExtensionSettings
 * @property {boolean} [autoRestoreOnStartup]
 * @property {"auto" | "chrome_storage" | "sqlite_native"} storageDriver
 * @property {string} sqliteDbPath
 * @property {boolean} lazyRestore
 * @property {boolean} autoCleanBlankNewTab
 * @property {number} maxClosedWindowsRetention
 * @property {boolean} stripTrackingParams
 * @property {string[]} blacklistDomains
 *
 * @typedef {Object} SyncedStorageSchema
 * @property {string} version
 * @property {Record<string, WindowData>} activeWindows
 * @property {Record<string, WindowData>} closedWindows
 * @property {PreviousSessionBackup} [previousSessionBackup]
 * @property {RecoveryCheckpoint[]} recoveryCheckpoints
 * @property {RecoveryAlert|null} recoveryAlert
 * @property {ExtensionSettings} settings
 */

export {};
