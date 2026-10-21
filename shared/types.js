/**
 * Type definitions (JSDoc) — SyncTab Group Sync v3
 * Specification: SOT v3.0.0 §2 Data Model
 */

/**
 * @typedef {"grey"|"blue"|"red"|"yellow"|"green"|"pink"|"purple"|"cyan"|"orange"} GroupColor
 */

/**
 * แท็บหนึ่งรายการในคลัง (identity = normalized URL; liveCount > 0 = ตื่น, 0 = หลับ)
 * @typedef {object} TabRecord
 * @property {string} url            key + identity (normalized)
 * @property {string} title
 * @property {string} [favIconUrl]
 * @property {number} order          ลำดับ restore (ลำดับการถูกเห็นครั้งแรก)
 * @property {number} addedAt        epoch ms ครั้งแรกที่ถูกบันทึก
 * @property {number} [lastLiveAt]   epoch ms ล่าสุดที่เป็น live
 * @property {number} [closedAt]     epoch ms ล่าสุดที่ flip จาก live -> idle
 * @property {number} liveCount      จำนวน instance ที่กำลังเปิด (รวมหลายหน้าต่าง/แท็บซ้ำ)
 */

/**
 * กลุ่มหนึ่งก้อนในคลัง (identity = ชื่อกลุ่มตรงตัว case-sensitive)
 * @typedef {object} GroupRecord
 * @property {string} name
 * @property {GroupColor} color        สีล่าสุดที่เห็นจาก browser
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number[]} liveWindowIds  windowIds (session-scoped) ที่มี live group ชื่อนี้
 * @property {Record<string, TabRecord>} tabs  key = normalized URL
 */

/**
 * Schema เดี่ยวของคลังใน chrome.storage.local (key: groupsSync)
 * @typedef {object} StorageSchema
 * @property {3} version
 * @property {Record<string, GroupRecord>} groups key = ชื่อกลุ่ม
 * @property {"dark"|"light"|"auto"} [themePreference]
 * @property {number} [lastScanAt]
 * @property {number} [migrationNoticeAt]
 */

/** Payload ที่ popup ได้รับจาก GET_STATE */
export {};
