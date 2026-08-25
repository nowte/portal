#!/usr/bin/env python3
"""Uygulama ikonlarını marka markından üretir (DESIGN §24.2, §24.3).

Neden script: ikonların kaynağı TEK olsun. Mark değişirse burayı çalıştır,
15 PNG'yi elle düzenleme. Çıktı `icon-source.png` → `npm run tauri icon` ile
tüm boyutlara açılır.

Paketleme ikonu, uygulama içindeki markın aksine, ŞEFFAF DEĞİL: koyu bir levha
üstünde beyaz mark. Gerekçe: şeffaf siyah mark koyu Windows taskbar'ında
görünmez oluyordu ve mark kendi kutusunun %12'sini doldurduğu için masaüstünde
diğer uygulamaların yanında küçük duruyordu.

Kullanım:
    python make-icons.py && cd ../.. && npm run tauri icon src-tauri/icons/icon-source.png
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
PLATE = (10, 10, 10, 255)  # --bg (#0a0a0a) — Black teması tabanı
RADIUS = int(SIZE * 0.22)  # Windows/macOS yuvarlak-kare oranı
MARK_H = int(SIZE * 0.60)  # mark yüksekliği; kalan %40 clear-space (§24.2)

here = Path(__file__).parent
mark = Image.open(here / "../../src/assets/portal-mark-white.png").convert("RGBA")

# Markı kendi alpha sınırına kırp — kaynak varlıkta çepeçevre boşluk var.
mark = mark.crop(mark.getchannel("A").getbbox())
mark = mark.resize(
    (round(MARK_H * mark.width / mark.height), MARK_H), Image.LANCZOS
)

icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(icon).rounded_rectangle(
    (0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=PLATE
)
icon.alpha_composite(mark, ((SIZE - mark.width) // 2, (SIZE - mark.height) // 2))
icon.save(here / "icon-source.png")
print(f"icon-source.png yazıldı ({SIZE}px, mark {mark.width}x{mark.height})")
