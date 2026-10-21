#!/usr/bin/env python3
"""
สร้างชุดไอคอน SyncTab (icons/icon-16/32/48/128.png) จาก master 512px

คอนเซ็ปต์ "กองแท็บในกลุ้ม":
- rail แนวตั้งซ้าย = ตัวคลุมแท็บกลุ้ม (tab group)
- 3 แถบแท็บซ้อนกัน — ความทึบไล่ลึก/กลาง/หน้า
- แถบหน้าสุด "ตื่น" ติดจุดเขียว (live)

สียึด design-system popup (--accent Edge blue family)
เรียก: python3 scripts/make-icons.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageOps

S = 512
GRAD_TOP = (47, 149, 224)     # #2F95E0 — บนสว่าง
GRAD_BOTTOM = (0, 90, 158)    # #005A9E — ล่างเข้ม
WHITE = (255, 255, 255)
GREEN = (74, 222, 128)        # จุด "ตื่น"
RADIUS = int(S * 0.225)


def build_master() -> Image.Image:
    # พื้นหลัง gradient แนวตั้ง (linear_gradient: 0 = แถวบน)
    grad = Image.linear_gradient("L").resize((S, S))
    bg = ImageOps.colorize(grad, black=GRAD_TOP, white=GRAD_BOTTOM).convert("RGBA")

    # เลเยอร์เงา + แท่งแท็บ (rail + 3 แถบ)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    adraw = ImageDraw.Draw(art)

    bars = [  # (x1, y1, x2, y2, alpha) — อ่านรายละเอียดได้แม้ย่อเหลือ 16px
        (92, 112, 136, 462, 150),    # rail กลุ้ม
        (160, 136, 400, 212, 115),   # แถบหลังสุด (ระเบิดจาง)
        (160, 254, 448, 330, 155),   # แถบกลาง
        (160, 370, 424, 466, 255),   # แถบหน้าสุด (แท็บตื่น)
    ]
    for x1, y1, x2, y2, alpha in bars:
        r = min(x2 - x1, y2 - y1) // 2
        sdraw.rounded_rectangle([x1, y1 + 12, x2, y2 + 12], radius=r, fill=(2, 30, 55, 90))
        adraw.rounded_rectangle([x1, y1, x2, y2], radius=r, fill=WHITE + (alpha,))

    # จุด "ตื่น" บนแถบหน้าสุด (ให้จริงเฉพาะขนาด >= 32 — 16px มันกลืนอยู่ดี)
    adraw.ellipse([356, 394, 404, 442], fill=GREEN + (255,))

    flat = bg.copy()
    flat.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
    flat.alpha_composite(art)

    # ตัดโค้งมุม (ทำ alpha = mask)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)
    return Image.composite(flat, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)


def main() -> None:
    master = build_master()
    for size in (128, 48, 32, 16):
        step = S if size >= 64 else 64  # ผ่านขั้นกลาง 64px กันเกิด aliasing เวลาย่อแรง
        small = master.resize((step, step), Image.LANCZOS)
        if step != size:
            small = small.resize((size, size), Image.LANCZOS)
        small.save(f"icons/icon-{size}.png", optimize=True)
        print(f"icons/icon-{size}.png  {size}x{size}")


if __name__ == "__main__":
    main()
