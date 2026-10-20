/**
 * DebugLog — บันทึกการทำงานของ extension แบบละเอียด (ring buffer + console)
 *
 * ที่มา: ผู้ใช้รายงาน "เปิดแล้วได้แท็บว่าง Untitled แต่ extension บอกว่า alive — ต้องกดเปิด 2-3 ครั้ง"
 * ต้องมีร่องรอยครบทุกขั้น (restore flow / mirror events / store mutations) เพื่อวินิจฉัยโดยไม่ต้องเดา
 *
 * ใช้:
 *  - ring buffer ในหน่วยความจำ SW (1000 รายการล่าสุด) — อ่านจาก SW devtools: __syncTabLogs.getLogs()
 *  - หรือ RPC GET_DEBUG_LOGS จาก popup devtools
 *  - console.debug เปิด/ปิดด้วย enableConsole (SW เปิดค่าเริ่มต้น — ปิดเมื่อเสถียร)
 * dbg() ต้องไม่มีวันโยนข้อผิดพลาดใส่ flow หลัก
 */

const CAP = 1000;
const buf = [];
let consoleOn = false;

/** บันทึกเหตุการณ์หนึ่งบรรทัด — scope = โมดูล (restore/mirror/store), msg = เหตุการณ์, data = บริบท */
export function dbg(scope, msg, data) {
  try {
    buf.push({ t: Date.now(), scope, msg, data });
    if (buf.length > CAP) buf.splice(0, buf.length - CAP);
    if (consoleOn) console.debug(`[SyncTab ${scope}] ${msg}`, data ?? "");
  } catch { /* log ห้ามทำให้ flow หลักพังเด็ดขาด */ }
}

/** เปิด/ปิด mirror ไป console.debug — SW เปิดค่าเริ่มต้นระหว่างกำลัง debug; ปิดเมื่อเสถียร */
export function enableConsole(on = true) {
  consoleOn = Boolean(on);
}

/** อ่าน log ทั้งหมด (copy ล่าสุด CAP รายการ) */
export function getLogs() {
  return buf.slice();
}

export function clearLogs() {
  buf.length = 0;
}
