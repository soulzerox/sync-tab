# Page design brief — SyncTab Group Sync popup

> หน้า popup ใช้ override นี้ทับแนวที่ได้จาก `design-system/synctab/MASTER.md`
> (MASTER ถูก persist ด้วย ui-ux-pro-max เสนอแนว teal SaaS/Enterprise Gateway ซึ่ง **ไม่ใช้** กับหน้า popup — จงใช้ token ในไฟล์นี้เท่านั้น)
> อ้างอิงภาพจริง: `design-system/synctab/pages/mockup.html` (archived 20/10/2026, ผ่าน detector 2 รอบ)

## โหมด (Operate)

ผู้ใช้เสร็จงานในไม่กี่คลิก: หากลุ่ม → ตรวจสถานะ → เลือกแท็บ → เปิดทั้งหมด/บางส่วน หรือลบ
ความสมบูรณ์มาจากความแม่นยำและการอ่านสถานะรวดเร็ว ไม่ใช่ความแปลกทางภาพ — เอาความแปลกไปใส่ที่ "ตัวสีของข้อมูล" แทน

## Token System (CSS custom properties)

### สี (ห้ามใช้สีอื่นนอกชุดนี้ — บุคลิกของหน้ามาจาก token ชุดเดียวเท่านั้น)

| Token | Dark (default) | Light | บทบาท |
|---|---|---|---|
| `--bg-base` | `#101215` | `#f4f6f8` | พื้น popup |
| `--surface` | `#181b1f` | `#ffffff` | card / header / footer |
| `--surface-2` | `#1f242a` | `#f7f9fb` | hover state ของแถว |
| `--border` | `rgba(255,255,255,.08)` | `#e4e7eb` | เส้นตีวงการ์ด |
| `--text` | `#e6e8ea` | `#1a1c1f` | ตัวหลัก |
| `--muted` | `#a7aeb6` | `#5a6068` | ตัวรอง — ≥ 4.5:1 บนพื้น surface ทั้งสองธีม |
| `--accent` | `#0078d4` | `#0078d4` | สีระบบ Edge — focus ring, search โดด, toggle |
| `--live` | `#10b981` | `#188038` | dot สถานะตื่น (เชิงความหมาย ไม่ใช้ตกแต่ง) |
| `--danger` | `#ef4444` | `#d93025` | ลบ (hover ปุ่ม 🗑 / ×) |
| 9 × `--grey…--orange` | dark pastel ชุดจริงเพื่มดูจาก mockup | ชุดเดียวกับ Chromium light | **สีประจำกลุ่ม — ใช้ผ่าน `--g` ต่อการ์ด: chip, ปุ่ม primary (mix 20–30%), checkbox accent** |

กติกาการใช้สีกลุ่ม: สีของกลุ่มคือ **ข้อมูล ไม่ใช่ของตกแต่ง** — การ์ดแต่ละใบมีชิปชื่อกลุ่ม + checkbox + ปุ่ม "เปิดทั้งหมด" ย้อมด้วยสีกลุ่มเท่านั้น; **ห้าม** มีแถบสีข้างการ์ด (left rail) เพราะลอกแบบ slop และทำซ้ำหน้าที่ชิป

### ตัวอักษร
- **ไม่โหลด webfont** — ใช้ `system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, "Noto Sans Thai", sans-serif` (ผลิตภัณฑ์ 100% offline + กัน FOUT บน GNOME)
- ขนาด: base 13px · ตัวรอง (URL, label, footer) 12px · หัวการ์ด/ชิป 13px semibold · ชื่อ popup 15px semibold
- `font-variant-numeric: tabular-nums` ทุกตำแหน่งที่โชว์ตัวเลข (pill นับแท็บ, ปุ่มเปิด n)
- Thai line-height ≥ 1.5

### โครง & รัศมี
- ความกว้าง popup เป้าหมาย 380px, สูงสูงสุด 620px, พื้นที่การ์ดเลื่อนได้ (list) หัว/ท้าย sticky
- รัศมี: popup 14 · card 11 · ปุ่ม/ชิป row hover 8 · pill 999
- เงาเดียวต่อ popup ระดับ shell (บนหน้า preview เท่านั้น — ใน extension จริงไม่ต้องเงา)
- ถึงจะเรียงอ่านซ้าย-ขวา: header ตีกลับเข้าเป็นสองฝั่ง (ชื่อซ้าย / สถิติ+toggle ขวา)

## องค์ประกอบและข้อความ (copy เป็นตัวหนังสือจาก mockup)

| องค์ประกอบ | ข้อความ/พฤติกรรม |
|---|---|
| Stat pills | "N กลุ่ม / N แท็บ / N ตื่น" — ไม่เอา separator จุดกลาง |
| Search box | placeholder "ค้นหากลุ่มหรือแท็บ…" กรองชื่อกลุ่ม + title + URL แบบ substring (ไม่ case-sensitive) |
| Group card header | chevron + ชิป(ชื่อกลุ่ม, สีกลุ่ม) + pill "x ตื่น / รวม" + pill "N หน้าต่าง" (หรือ "ไม่ได้เปิด") + ปุ่ม pencil rename |
| Section label | "ตื่นอยู่ในเบราว์เซอร์ N" / "จำไว้ (หลับ) N" |
| Live row | lockdown: checkbox จาง disabled + green dot + favicon + title/URL; ไม่มีปุ่ม ×; ไม่เลือกได้ |
| Idle row | checkbox (accent สีกลุ่ม) + moon icon จาง + favicon + title/URL + × (hover เท่านั้น) |
| Actions | "เปิดที่เลือก (n)" (disabled เมื่อ n=0) · "เปิดทั้งหมด M" (primary ย้อมสีกลุ่ม) · 🗑 ghost-danger ลบกลุ่ม |
| Footer | "ซิงก์ล่าสุด X วินาที/นาทีก่อน" ซ้าย · "แท็บนอกกลุ่มไม่ถูกจับ" ขวา |
| Empty state | "ยังไม่มีกลุ่มที่ถูกจับ — ลากแท็บเข้ากลุ่มที่ตั้งชื่อใน Edge เพื่อเริ่มซิงก์อัตโนมัติ" |
| Toast | ปิด popup ไม่ต้อง; ใช้แจ้ง "ลบแล้ว", migration notice ครั้งแรก; อยู่ 2.5 วินาที |
| Confirm ลบกลุ่ม | "ลบ N แท็บที่จำไว้ออกจากคลัง (แท็บจริงบนเบราว์เซอร์ไม่ถูกแตะ)" + เตือนเพิ่มเมื่อ group live: "กลุ่มนี้ยังเปิดอยู่บน browser — ข้อมูลจะถูก mirror กลับเข้ามาทันทีที่มีการเปลี่ยนแปลงแท็บในกลุ่ม" |

## แอนิเมชัน (sparing)
- เฉพาาะ user-trigger: accordion toggle (chevron rotate 180°, 180ms), hover bg fade 120–150ms, toast slide 200ms, ปุ่มเปิดสำเร็จ → pill ตื่นเปลี่ยนตัวเลข (อย่ามี text pulse ทำงานเอง)
- header ติดด้านบน; **ไม่มี** entrance animation ของส่วน list ตอนเปิด popup

## a11y floor (แตะไม่ได้)
- contrast ≥ 4.5:1 ทุกเพื่อ text หลัก (มีสองธีม); focus-visible ring `--accent` ทุกปุ่ม/checkbox/summary/input
- `details/summary` native accordion, checkbox เป็น input จริง, ปุ่ม icon มี `aria-label` ไทยเสมอ
- `prefers-reduced-motion: reduce` → ปิด transition ทุกตัว
- cursor:pointer ทุกจุดควบคุม; hover ต้องไม่ทำ layout ขยับ (state เปลี่ยนด้วยสี/พื้นหลังเท่านั้น)

## ห้าม (bans จาก glare review และ frontend-design)
- อย่าทำการ์ดทุกใบให้เหมือนกันจนสีกลุ่มหมดบทบาท — สี 9 ชุดคือตัวให้อัตลักษณ์การ์ดอยู่แล้ว อย่าตกแต่งเพิ่มแบบเงายัดทุกใบ
- อย่าใช้ emoji เป็นไอคอน (SVG stroke inline 14px ตาม mockup เท่านั้น)
- อย่าใส่ meta string ต่อด้วยจุดกลาง (`A · B · C`), หัวข้อแบบดา่ง `—`, หรือ left-rail สีการ์ด
- อย่าเพิ่ม settings/export/import/native banner กลับเข้าหน้า (ADR-0001 ตัดแล้ว)
