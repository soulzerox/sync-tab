# ADR-0001 — ถอดรื้อระบบ Window-Snapshot Sync ทั้งชุด แล้วเปลี่ยนเป็น Group-Only Sync

> วันที่: 2026-10-20
> สถานะ: Accepted
> ผู้ตัดสิน: เจ้าของโปรเจกต์ (ผ่าน grilling รอบสนทนาใน session 20/10/2026)
> -----

## บริบท (Context)

ระบบ v2.3.0 (นิยามเดิม: `docs/history/SOT-v2.3.0-window-sync.md`) ซิงก์และกู้คืน "หน้าต่าง" ทั้งตัว: windowUuid topology, active-windows read-only mirror, closed-window archive (จำกัด 5 หน้าต่าง + pinned template), naming window, recovery checkpoints 5 ชุดต่อนาที + suspected-loss alert, previousSessionBackup, import/export, และ persistence ผ่าน Native Messaging Host + SQLite WAL (`native_host.py` ~14KB + setup script + python tests)

ปัญหาที่ตรวจพบผ่านการใช้งานจริง:
1. **ไม่ตรงงานผู้ใช้:** สิ่งที่ผู้ใช้ต้องการคือ "กลุ่มที่ตั้งชื่อไว้" — ไม่ใช่หน้าต่าง; แท็บนอกกลุ่มคือพื้นที่งานรายวันซึ่งไร้ประโยชน์ในการจำ
2. **Auto-restore ตอนเปิด browser กระแทกทรัพยากร:** แท็บถูกเรียกเปิดแทบพร้อมกันตอนบูต (sleeping tab ยังเข้าถึงจุยีคือไม่ได้ช่วยลด burst ได้จริงเมื่อรวมกับ auto-restore ของ v2)
3. **ซับซ้อนเกินงาน:** service worker มี tabGroup permission แต่ช่วงพฤติกรรมรอบ tab group ต้องผูกกับ snapshot model ทั้งหน้าต่าง — เกิดงาน reconcile/crash-diff ซ้อนกันหลายชั้น
4. **Native host เป็นภาระ:** Python process คู่บ้านคู่ตัว, deploy ล้างง่ายกับ store listing, protocol limit 1MB, double source of truth ระหว่าง chrome.storage กับ SQLite

## การตัดสินใจ (Decision)

ตัดสินใจ **ลบระบบ window-sync ทั้งชุดใน v3** แล้วเปลี่ยนโมเดลเป็น Group-Only Sync:
คลังเดียว (`chrome.storage.local`) บันทึก **เฉพาะแท็บใน tab group ที่มีชื่อ**, จัดการด้วย mirror logic ใน service worker, ไม่มี process ภายนอก extension — ผู้ใช้เป็นคนสั่ง restore ทุกครั้งใน popup และแท็บที่เท่าจอดออกจากการเปิดคือแบบ discarded ทั้งหมด

สิ่งที่ **ถูก** ลบ: window UUID + active/closed windows + naming + archive + pinned template, recovery checkpoints + alert + alarm scheduler, previousSessionBackup, manual backup/bookmark export/import, settings modal (ส่วน staying กลายเป็น บใหม่), Native Adapter + SQLite + native_host กับ manifest `nativeMessaging`, Python test suite, recovery messages/pop sections

สิ่งที่ **เก็บมา**: `tabs`/`tabGroups`/`storage`/`storage` permission, URL sanitizer, สีกลุ่ม (sanitize ตระกูล Chromium), sleeping-tab creation flow (create → group → setColor → discard), message RPC unidirectional, node --test runner

## ทางเลือกที่พิจารณา (Alternatives)

1. **คง Native SQLite host เป็น persistence สำรอง** — ผ่าน: คลังกลุ่มเป็นข้อมูลขนาดเล็กมากจน chrome.storage พอเกินใช้, ขณะที่ native host แลกมาด้วย double source of truth, protocol limit, และสคริปต์ deploy ที่ต้องรักษาเพิ่มทุกเปลี่ยนแปลงนิยาม schema
2. **รวม ungrouped tabs เข้า sync (ไม่มีกลุ่มก็จำ)** — ผ่าน: จุดต่างสำคัญของโปรเจกต์คือความจำเฉพาะกลิ่นกลุ่มที่จัดไว้; แท็บลอยนอกกลุ่มคือพื้นที่งานข้ามวันซึ่งถ้าจับมาหมดจะทำให้คลังปนเปื้อนและกลายเป็นขยะที่น่าใช้
3. **เพิ่ม auto-restore บางส่วนตอนบูต** — ผ่าน: ตรงข้อกังวลใหญ่ของผู้ใช้ (กระแทกทรัพยากรตอนเปิดเครื่อง); ตรวจทานแล้วมีข้อเท็จจริงว่า Edge มี session restore ทำเองในเบราว์เซอร์อยู่แล้ว extension ไม่ควรแข่งบทบาทเดียวกัน — ที่ตกลงคือผู้ใช้กดเองทุกครั้งจาก popup

## ผลตามมา (Consequences)

**ได้:** ตรรกะ background ลดมากที่สุด; ข้อมูลระบุชัดว่า "จำอะไรไว้" ด้วยชื่อกลุ่มตรงตัว; กลุ่มชื่อเดียวกันข้ามหน้าต่างถือเป็นกลุ่มเดียว; มีเพียง seam เดียว (GroupStore) ให้เทสด้วย fake chrome + `node --test` ได้ครบ; popup เรียบง่ายตรงงาน
**เสีย:** ไม่มี crash-recovery สำหรับแท็บที่ไม่ได้อยู่ในกลุ่ม (หายจริงเมื่อ Edge crash ก่อนบันทึก session); ไม่มีการซิงก์ข้ามเครื่อง/ข้าม device; ข้อมูลทั้งหมดผูกกับ profile เดียวของ browser เครื่องเดียว

## กันหมูย้อนหลัง (guard)

ใครเสนอ "กลับมามี window backup / checkpoint / native host อีกครั้ง" ต้องเขียน ADR ใหม่พร้อมเหตุผลที่โค่นปัจจัย 4 ข้อในหัว Context ก่อน — เปิดรับได้เฉพาะเมื่อ requirement "sync ข้ามเครื่อง" หรือ "กู้แท็บนอกกลุ่ม" กลับมาเป็นโจทย์จริงของผู้ใช้
