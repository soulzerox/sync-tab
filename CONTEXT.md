# CONTEXT — คลังศัพท์โดเมนของ SyncTab (Group Sync)

> ไฟล์นี้คือ glossary หลักให้เอเจนต์/นักพัฒนาใช้ศัพท์ตรงกันทั้งโค้ด UI และเอกสาร
> ศัพท์ v3 เขียนตามการออกแบบ Group-Only Sync (SOT.md v3.0.0, ADR-0001)
> ห้ามใช้ศัพท์ v2 (window/archive/checkpoint) พรรณนาสิ่งใดในระบบใหม่ — ดู ADR-0001 ถ้าต้องอ้างอิงระบบเก่า

## ศัพท์หลัก

| ศัพท์ | นิยาม | ห้ามเรียกว่า / ห้ามใช้สับสนกับ |
|---|---|---|
| **Group Sync Library** ("คลัง") | ข้อมูลทั้งหมดที่ extension จำไว้ อยู่ใน `chrome.storage.local` คีย์ `groupsSync` โครงตาม schema v3 | database, store (คำ hardware), localStorage |
| **Group record** | กลุ่มตามตัวอักษรชื่อเดียว (identity = ชื่อ ตรงตัว case-sensitive); ครอบ union แท็บจากทุกหน้าต่างปัจจุบัน + แท็บจำไว้ทุกแท็บ | tab group บน browser, session, window |
| **Tab record** | แท็บหนึ่งรายการใน group record; identity = normalized URL (ต่อ 1 กลุ่มมี URL ไม่ซ้ำ); เก็บ title/favicon/order/timestamps | bookmark, tab จริงบน browser, session tab |
| **ตื่น (live)** | สถานะ tab record เมื่อ `liveCount > 0` — กำลังเปิดอยู่บน browser จริง (instance อย่างน้อย 1) | online, active window |
| **หลับ (idle)** | สถานะ tab record เมื่อ `liveCount == 0` — จำอยู่ในคลังโดย browser ไม่เปิดอยู่ | deleted, archived, "closed" |
| **Live group** | instance จริงบน browser: ชื่อกลุ่ม + group object ในหน้าต่างใดหน้าต่างหนึ่ง; 1 group record มีได้หลาย Live group ตามจำนวนหน้าต่าง | group record, "group ในคลัง" |
| **คลังมีชีวิต (live group record)** | group record ที่มี instance live อย่างน้อย 1 (badge "N หน้าต่าง" มาจากที่นี่) | อย่าเข้าใจว่า "record ไม่หลับ" — record ไม่หลับเมื่อมีแท็บตื่นเท่านั้น |
| **Mirror** | กระบวนการ event-driven: chrome events → mutation ของคลัง (browser-mirror.js) — ทิศทางเดียว browser → คลัง, ยกเว้น RENAME popup → browser | "sync 2 ทาง" (ไม่ใช่), auto-restore |
| **Reconcile** | งานเทียบสถานะทั้งชุด (startup / install / Alt+Shift+S): อ่าน browser ทั้งหมด → เขียนสถานะลงคลังให้เป๊ะ (reconcile = "สถานะเท่านั้น" ไม่เปิดแท็บเด็ดขาด) | restore, resync, backup |
| **Restore** | การเปิดแท็บจำไว้กลับเข้า browser ตามคำสั่งผู้ใช้: เติมเข้า Live group ชื่อเดียวกัน หรือสร้างกลุ่มใหม่ในหน้าต่างเป้าหมาย | sync (คำเก่า), recover, reopen |
| **เปิดแบบหลับ / Sleeping Tab** | แท็บที่ถูก create → จัดกลุ่ม → `tabs.discard()`: โชว์ favicon/title แต่ไม่โหลดเนื้อหาจนกว่าจะถูกคลิก | lazy load, suspended (คำเก่า), sleeping ใน Edge UI ✓ |
| **Trans group** | กลุ่มที่ถูกสร้างบน browser แล้วถูกปิดทิ้งไปก่อนจะมีแท็บ web ตัวจริงอย่างน้อย 1 — ไม่เข้าคลัง (L9) | "กลุ่มว่าง" |
| **Normalized URL** | URL ที่ผ่าน url-sanitizer: ฟิลเตอร์ scheme พิเศษและทำรูปแบบให้เทียบเท่ากัน — ฐานให้ dedupe ของ record | ตัด utm (ไม่ทำ — การสันดาปพารามิเตอร์ติดตามเป็น feature ของระบบเก่าที่ถูกถอด) |
| **Full rescan** | คำสั่งผู้ใช้ (Alt+Shift+S) เรียก reconcile รอบใหม่ด้วยตนเอง | auto scan, alarm (มีเฉพาะ event-driven) |

## ประวัติการถอดรื้อ (สั้น)

ระบบเดิม (v2) ซิงก์ "หน้าต่างทั้งตัว + แท็บทั้งหมด" ลง snapshot/window archive แล้วถอดรื้อทั้งชุดเมื่อ 20 ต.ค. 2026 — เหตุผล: โมเดล window ไม่ตรงงานผู้ใช้, ต้นทุนซับซ้อนสูง (native host + crash reconciliation), และผู้ใช้ต้องการจำเฉพาะ **แท็บที่อยู่ในกลุ่มและกลุ่มมีชื่อเท่านั้น** — รายละเอียด "ทำอะไรไปแล้ว ทิ้งอะไรไว้" อยู่ใน ADR-0001 และ `docs/history/SOT-v2.3.0-window-sync.md`

## กติกาการตั้งชื่อต่อไป

- โมดูลบนใช้คำตามแผนของ SOT §3 (mirror / store / restore ฯลฯ) — คำใหม่ควรมาจากตารางด้านบนก่อนเสมอ
- หากศัพท์เดิมถูกใช้ในสองความหมาย (เช่น "แท็บ" ลอยระหว่าง tab record กับ tab จริงบน browser) — ให้แก้ศัพท์เดิมให้เี้มอบเงื่อนทางเดียวก่อนเขียนเพิ่มเติม
