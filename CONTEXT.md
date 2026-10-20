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
| **ตื่น (live)** | สถานะ tab record เมื่อ `liveCount > 0` — กำลังเปิดอยู่บน browser จริง (instance อย่างน้อย 1) — **รวมแท็บที่ Edge นอนเอง** (Edge Sleeping Tabs: `discarded=true` แต่ยังเปิดค้างใน strip — L17) | online, active window |
| **หลับ (idle)** | สถานะ tab record เมื่อ `liveCount == 0` — จำอยู่ในคลังโดย browser ไม่เปิดอยู่ (เว้นเสียแต่หลับแบบ "ผลจาก restore" ด้านล่าง) | deleted, archived, "closed" |
| **Live group** | instance จริงบน browser: ชื่อกลุ่ม + group object ในหน้าต่างใดหน้าต่างหนึ่ง; 1 group record มีได้หลาย Live group ตามจำนวนหน้าต่าง | group record, "group ในคลัง" |
| **คลังมีชีวิต (live group record)** | group record ที่มี instance live อย่างน้อย 1 (badge "N หน้าต่าง" มาจากที่นี่) | อย่าเข้าใจว่า "record ไม่หลับ" — record ไม่หลับเมื่อมีแท็บตื่นเท่านั้น |
| **Mirror** | กระบวนการ event-driven: chrome events → mutation ของคลัง (browser-mirror.js) — ทิศทางเดียว browser → คลัง, ยกเว้น RENAME popup → browser | "sync 2 ทาง" (ไม่ใช่), auto-restore |
| **Reconcile** | งานเทียบสถานะทั้งชุด (startup / install / Alt+Shift+S): อ่าน browser ทั้งหมด → เขียนสถานะลงคลังให้เป๊ะ (reconcile = "สถานะเท่านั้น" ไม่เปิดแท็บเด็ดขาด) | restore, resync, backup |
| **Restore** | การเปิดแท็บจำไว้กลับเข้า browser ตามคำสั่งผู้ใช้: เติมเข้า Live group ชื่อเดียวกัน หรือสร้างกลุ่มใหม่ในหน้าต่างเป้าหมาย | sync (คำเก่า), recover, reopen |
| **เปิดแบบหลับ / Sleeping Tab** | แท็บที่ถูก create → จัดกลุ่ม → `tabs.discard()`: โชว์ favicon/title แต่ไม่โหลดเนื้อหาจนกว่าจะถูกคลิก | lazy load, suspended (คำเก่า), sleeping ใน Edge UI ✓ |
| **Trans group** | กลุ่มที่ถูกสร้างบน browser แล้วถูกปิดทิ้งไปก่อนจะมีแท็บ web ตัวจริงอย่างน้อย 1 — ไม่เข้าคลัง (L9) | "กลุ่มว่าง" |
| **Normalized URL** | URL ที่ผ่าน url-sanitizer: ฟิลเตอร์ scheme พิเศษและทำรูปแบบให้เทียบเท่ากัน — host ตัวเล็ก, ตัด trailing slash, **ตัด fragment `#hash` ทิ้ง (v3.0.1: หน้าเดียวกัน hash ต่างกัน = record เดียวกัน)**, **ตัด query params ติดตาม (v3.1: `__cf_chl*`, `utm_*`, `fbclid`, `gclid` ฯลฯ — token เฉพาะเหตุการณ์ต่างกันต่อเซสชันแต่หน้าเดียวกัน = record เดียวกัน)** — ฐานให้ dedupe ของ record | อย่าเข้าใจว่า "ตัดพารามิเตอร์ทุกตัว" — param ทำงานจริง (เช่น `page=2`) ยังคงอยู่ |
| **Live binding (v3.1)** | การผูก tabId จริง ↔ tab record (schema `liveTabs`: {ชื่อกลุ่ม, url key, ธง origin}; persist ใน storage รอดจาก SW restart) — ทำให้ record เลื่อนตามแท็บเมื่อเปิดหน้าใหม่ (L14) และแยก "ผู้ใช้ปิดแท็บเอง" ออกจาก "ปิด window/ตาย" (L13) | uid ถาวรของ record (ไม่มีคอนเซปต์นี้ — url ยังเป็นตัวตน), map หน่วยความจำล้วน (ไม่ใช่ — persist) |
| **เงาสำรอง sync (L16)** | compact snapshot ของคลังใน `chrome.storage.sync` (ผูกบัญชีเบราว์เซอร์) เขียนอัตโนมัติทุก persist แบบ throttled — กู้เฉพาะตอน local ว่างจริง (เครื่องใหม่/ถอดแล้วติดตั้งใหม่); "ล้างแคช/ข้อมูลท่องเว็บ" ไม่แตะ storage ของ extension จึงไม่ต้องย้ายที่เก็บ | backup ข้ามไปไฟล์นอก (ไม่มี), sync 2 ทาง (ไม่ใช่ — เขียนทางเดียว local → sync) |
| **Origin ป้องกัน (`r=1`) (v3.1)** | ธงบน binding ของแท็บที่ RestoreEngine สร้าง (`restoredTabIds`) และแท็บที่ reconcile/scan เจอครั้งแรก (สาเหตุกำเนิดไม่แน่) — ปิดแท็บเหล่านี้ = record หลับเหมือน v3.0 ไม่ลบ; v3.2: `r=1` **เลื่อน record ตามแท็บได้แล้ว** (L14) — กันแถวเก่าค้างหลับคู่กับแถวใหม่ (ดูเหมือนซ้ำ) เฉพาะ `restoredTabIds` เท่านั้นที่ยังไม่เลื่อน | "แท็บทุกตัวไม่ลบ" (ไม่ใช่ — แท็บที่จับจาก event ธรรมดา ปิดเองลบจริงตาม L13) |
| **URL เหตุการณ์ (`changeInfo.url` / `pendingUrl`) (v3.2)** | แหล่ง URL จริงใน event ของ Edge: `changeInfo.url` = URL ใหม่ตอนแท็บเปลี่ยนหน้า (`tab.url` ใน event ยังเป็นค่าเก่า/ว่าง), `pendingUrl` = URL ที่แท็บกำลังจะโหลดตอนยัง commit ไม่เสร็จ (แท็บใหม่/แท็บ restore); commit จริงของ navigation = `changeInfo.url` โผล่ — `status:"loading"` มาถึงก่อนเสมอ | `tab.url` เสมอ (ไม่ใช่ — event แรกมันว่าง/เก่า → binding ไม่เดินตาม + discard ก่อนโหลด = แท็บว่าง Untitled) |
| **ธง ผลจาก restore (`s=1`) (v3.1)** | ธงบน binding ของแท็บที่ RestoreEngine สร้างมาให้**หลับ** — mirror ไม่นับเป็นตื่นใน liveMap (record ต้นทางคงหลับตาม design restore สองขั้น), **ผู้ใช้กดตื่นเอง = ถอนธง** (แท็บกลายเป็นของผู้ใช้ นับตื่นตามจริงต่อไป; ธง `r=1` คงอยู่เพื่อ L13) | ใช้ `r=1` แทนไม่ได้ — `r` ใช้กับ scan-first ด้วย จะทำแท็บหลับของ Edge จริงถูกกรองหายทั้งหมด |
| **Edge Sleeping Tabs** | ฟีเจอร์ของ Edge เอง: นอนแท็บพื้นหลังที่ไม่ได้ใช้ (`discarded=true`) โดยแท็บยังเปิดค้างใน strip — ต่างจาก "เปิดแบบหลับ" ของ extension ตรงผู้ก่อการ (Edge สั่งเอง ไม่ใช่ restore ของผู้ใช้); ทำให้ SW restart + reconcile ห้ามจัดเป็น record หลับ (ซ้ำกับแท็บที่เห็นใน Edge) | "หลับ" ในคลัง (ไม่ใช่ — เปิดค้างจริง = ตื่นตาม L17) |
| **Full rescan** | คำสั่งผู้ใช้ (Alt+Shift+S) เรียก reconcile รอบใหม่ด้วยตนเอง | auto scan, alarm (มีเฉพาะ event-driven) |

## ประวัติการถอดรื้อ (สั้น)

ระบบเดิม (v2) ซิงก์ "หน้าต่างทั้งตัว + แท็บทั้งหมด" ลง snapshot/window archive แล้วถอดรื้อทั้งชุดเมื่อ 20 ต.ค. 2026 — เหตุผล: โมเดล window ไม่ตรงงานผู้ใช้, ต้นทุนซับซ้อนสูง (native host + crash reconciliation), และผู้ใช้ต้องการจำเฉพาะ **แท็บที่อยู่ในกลุ่มและกลุ่มมีชื่อเท่านั้น** — รายละเอียด "ทำอะไรไปแล้ว ทิ้งอะไรไว้" อยู่ใน ADR-0001 และ `docs/history/SOT-v2.3.0-window-sync.md`

## กติกาการตั้งชื่อต่อไป

- โมดูลบนใช้คำตามแผนของ SOT §3 (mirror / store / restore ฯลฯ) — คำใหม่ควรมาจากตารางด้านบนก่อนเสมอ
- หากศัพท์เดิมถูกใช้ในสองความหมาย (เช่น "แท็บ" ลอยระหว่าง tab record กับ tab จริงบน browser) — ให้แก้ศัพท์เดิมให้เี้มอบเงื่อนทางเดียวก่อนเขียนเพิ่มเติม
