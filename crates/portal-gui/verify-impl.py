#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Redesign implementasyon denetleyicisi (REDESIGN-PLAN.md > IMPLEMENTASYON).

DESIGN.md'nin olculebilir kurallarini gercek kod uzerinde dogrular:
  §5.2  boslugu 8px izgarasindan olmayan token disi deger
  §6    uc yaricap disinda bir deger
  §7.1  alti boyut disinda bir font-size / 11px alti metin
  §7.2  font-weight 700
  §7.3  UPPERCASE + letter-spacing mikro etiket
  §8    16/20 disinda ikon boyutu, 1.75 disinda stroke (adlandirilmis istisnalar haric)
  §1.1  isik kenarinin ust disinda bir kenarda olmasi
  §11   ease-in kullanimi, 240ms ustu gecis, yasak ozelliklerin animasyonu
  §15   birden fazla prefers-reduced-motion blogu
  GK3   §1/§3 disinda sabit ms / cubic-bezier
  GK2   palete yeni hex eklenmesi

Kullanim:  python verify-impl.py        (crates/portal-gui icinden)
Cikis   :  0 = temiz, 1 = bulgu var
"""
import io
import os
import re
import sys

CSS = os.path.join("src", "styles.css")
TSX_DIRS = [os.path.join("src", "components"), os.path.join("src", "panels"),
            os.path.join("src", "dock"), "src"]

FS_OK = {"11px", "12px", "14px", "18px", "24px", "34px", "inherit", "0"}
RADIUS_OK = {"8px", "10px", "14px", "50%", "inherit", "0", "20px", "2px"}
SPACING_OK = {"0", "1px", "2px", "4px", "8px", "16px", "24px", "40px", "64px", "auto"}
ICON_OK = {"16", "20"}
# §8 adlandirilmis istisnalar: yon oklari ve tik (16px'te ince kalir),
# §8 istisna: uPlot sparkline cizgisi 1.5 (grafik cizgisi ikon degildir).
STROKE_OK = {"1.75", "2", "3"}

findings = []


def add(kind, where, detail):
    findings.append((kind, where, detail))


def check_css():
    raw = io.open(CSS, encoding="utf-8").read()
    # Cok satirli /* ... */ yorumlarini satir sayisini bozmadan bosluga cevir:
    # aksi halde aciklama metnindeki "300ms" ya da "ease-in" bulgu sayilir.
    src = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), raw, flags=re.S)
    lines = src.split("\n")

    # Katman sinirlari — GK3 icin: sabit sure/egri yalniz §1 ve §3'te yasar.
    i_token = raw.index("/* ══ 1. TOKEN")
    i_base = raw.index("/* ══ 2. TEMEL")
    i_motion = raw.index("/* ══ 3. MOTION")
    i_prim = raw.index("/* ══ 4. PRIMITIVE")

    def layer_of(pos):
        if pos < i_base:
            return "1-TOKEN"
        if pos < i_motion:
            return "2-TEMEL"
        if pos < i_prim:
            return "3-MOTION"
        return "4+"

    pos = 0
    for n, line in enumerate(lines, 1):
        here = pos
        pos += len(line) + 1
        code = line.split("/*")[0]
        if not code.strip():
            continue
        L = layer_of(here)

        # §7.1 font-size
        for m in re.finditer(r"font-size:\s*([^;}]+)", code):
            v = m.group(1).strip()
            if v.startswith("var(--fs-") or v in FS_OK:
                continue
            add("§7.1", "styles.css:%d" % n, "izin verilmeyen font-size: " + v)

        # §7.2 agirlik tavani 600
        for m in re.finditer(r"font-weight:\s*(\d+)", code):
            if int(m.group(1)) > 600:
                add("§7.2", "styles.css:%d" % n, "font-weight " + m.group(1))

        # §6 yaricap
        for m in re.finditer(r"border-radius:\s*([^;}]+)", code):
            v = m.group(1).strip()
            if "var(--r-" in v or v in RADIUS_OK:
                continue
            add("§6", "styles.css:%d" % n, "izin verilmeyen border-radius: " + v)

        # §7.3 UPPERCASE tracked mikro etiket
        if "text-transform: uppercase" in code:
            add("§7.3", "styles.css:%d" % n, "UPPERCASE etiket")

        # §5.2 — 8px taban izgarasi. Adlandirilmis istisnalar §5.3'te:
        # mikro-inset (2px) ve optik duzeltme (4px); ayrica 1px dikisler.
        for m in re.finditer(r"(?<![\w-])(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:\s*([^;}]+)", code):
            for v in m.group(1).split():
                v = v.strip()
                if v.startswith("var(") or v.startswith("calc(") or v.startswith("min(") or v.startswith("-"):
                    continue
                if v in SPACING_OK or v == "!important" or v == "*":
                    continue
                if re.match(r"^\d+(\.\d+)?(vh|vw|%|em|ch)$", v):
                    continue
                add("§5.2", "styles.css:%d" % n, "izgara disi bosluk: " + v)

        # §11 ease-in (ease-in-out ve --ease-in-out haric)
        if re.search(r"\bease-in\b(?!-out)", code):
            add("§11.5", "styles.css:%d" % n, "ease-in")

        # §11.4 yasak ozelliklerin gecisi/animasyonu
        m = re.search(r"transition:\s*([^;}]+)", code)
        if m:
            for prop in ("width", "height", "top", "left", "box-shadow", "margin", "padding"):
                if re.search(r"(^|[\s,])" + prop + r"\s", m.group(1)):
                    add("§11.4", "styles.css:%d" % n, "gecis: " + prop)

        # GK3 — sabit sure / egri
        if L not in ("1-TOKEN", "3-MOTION"):
            for m in re.finditer(r"(?<![\w-])(\d+)ms", code):
                add("GK3", "styles.css:%d" % n, "token disi sure: %sms" % m.group(1))
            if "cubic-bezier" in code:
                add("GK3", "styles.css:%d" % n, "token disi cubic-bezier")

        # §1 — isik kenari modeli KALDIRILDI. Yuzeyler yalniz zemin kademesiyle
        # ayrisir; ne kenarlik ne 1px isik serit geri gelmemeli.
        if re.search(r"border-(?:top|bottom|left|right):\s*1px solid var\(--primary\)", code):
            add("§1", "styles.css:%d" % n, "yuzeye isik kenarligi cizilmis")
        if "--lit-" in code:
            add("§1", "styles.css:%d" % n, "--lit-* token'i geri gelmis")
        # Icerik yuzeyinde `border` yasak; yapisal dikis token'lari serbest.
        m = re.search(r"(?<![\w-])border:\s*1px solid ([^;}]+)", code)
        if m and not re.search(r"--(border|border-soft|edge)\b", m.group(1)):
            add("§1", "styles.css:%d" % n, "icerik yuzeyinde border: " + m.group(1).strip())

    # §15 tek reduced-motion kapisi
    gates = src.count("@media (prefers-reduced-motion")
    if gates != 1:
        add("§15", "styles.css", "%d adet reduced-motion blogu (tam 1 olmali)" % gates)

    # §3 disinda @keyframes yok
    for m in re.finditer(r"@keyframes", src):
        if not (i_motion <= m.start() < i_prim):
            n = src[: m.start()].count("\n") + 1
            add("GK3", "styles.css:%d" % n, "@keyframes §3 disinda")

    # GK2 — palete yeni hex. Izinli hex'ler: 4 temanin token tanimlari + siyah.
    allowed = set()
    for block in re.findall(r":root[^{]*\{([^}]*)\}", src[:i_base]):
        allowed.update(h.lower() for h in re.findall(r"#[0-9a-fA-F]{3,8}", block))
    allowed.update({"#000", "#000000", "#fff", "#ffffff"})
    for m in re.finditer(r"#[0-9a-fA-F]{3,8}", src[i_base:]):
        if m.group(0).lower() not in allowed:
            n = src[: i_base + m.start()].count("\n") + 1
            add("GK2", "styles.css:%d" % n, "palet disi hex: " + m.group(0))


def check_tsx():
    seen = set()
    for d in TSX_DIRS:
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".tsx"):
                continue
            path = os.path.join(d, fn)
            if path in seen:
                continue
            seen.add(path)
            src = io.open(path, encoding="utf-8").read()
            for n, line in enumerate(src.split("\n"), 1):
                for m in re.finditer(r"size=\{(\d+)\}", line):
                    if m.group(1) not in ICON_OK:
                        add("§8", "%s:%d" % (path, n), "ikon boyutu " + m.group(1))
                for m in re.finditer(r"strokeWidth=\{([\d.]+)\}", line):
                    if m.group(1) not in STROKE_OK:
                        add("§8", "%s:%d" % (path, n), "stroke " + m.group(1))


def main():
    check_css()
    check_tsx()
    if not findings:
        print("verify-impl: 0 bulgu — temiz.")
        return 0
    for kind, where, detail in findings:
        print("%-6s %-34s %s" % (kind, where, detail))
    print("\nverify-impl: %d bulgu." % len(findings))
    return 1


if __name__ == "__main__":
    sys.exit(main())
