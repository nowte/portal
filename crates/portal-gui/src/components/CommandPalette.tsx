// Komut paleti (DESIGN §12.10): ⇧⇧ (çift Shift) ya da top bar butonu → fuzzy arama;
// ↑↓ gez · ↵ çalıştır · esc kapat. Seçili satır beyaz-üstüne-siyah.
//
// P6-A iskeleti: yalnız GERÇEK aksiyonlar bağlıdır (düzen/görünüm + host seçimi).
// Connect/Files/Monitor host fiilleri Gateway/Terminal geldiğinde (Faz 3-B) eklenir.

import { useEffect, useMemo, useRef, useState } from "react";
import { useModal } from "../lib/modal";
import { ArrowDown, ArrowUp, CornerDownLeft, Search } from "lucide-react";
import { usePortal } from "../context";
import {
  openFiles,
  openGuide,
  openHome,
  openMonitor,
  openTerminal,
  resetLayout,
  showSide,
  toggleGuide,
  toggleSidebar,
} from "../dock/dock";
import { openAddHost } from "../panels/HostsPanel";
import { pinGuideTopic } from "../lib/guide";

interface Cmd {
  group: string; // .k etiketi (Layout/View/Go/Host)
  title: string; // .nm
  arg?: string; // .arg (— açıklama)
  run: () => void;
}

// Butonun paleti açması için modül-düzeyi köprü (prop-drilling'siz).
let externalOpen: (() => void) | null = null;
export function openCommandPalette(): void {
  externalOpen?.();
}

export function CommandPalette() {
  const { hosts, selectHost } = usePortal();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Sabit komutlar (hepsi P6-A'da gerçek) + her host için "git" komutu.
  const commands = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { group: "Layout", title: "Reset layout", arg: "— restore default", run: resetLayout },
      { group: "View", title: "Toggle Guide rail", run: toggleGuide },
      { group: "View", title: "Toggle sidebar", run: toggleSidebar },
      { group: "Go", title: "Home", arg: "— homepage & dashboard", run: openHome },
      {
        group: "Hosts",
        title: "Add a server",
        arg: "— opens the form, ready to type",
        run: () => {
          showSide("hosts");
          openAddHost();
        },
      },
      {
        group: "Help",
        title: "Keyboard shortcuts",
        arg: "— open the Guide rail",
        run: () => {
          openGuide();
          pinGuideTopic("keys");
        },
      },
    ];
    const hostCmds: Cmd[] = hosts.flatMap((h) => {
      const title = `${h.username ? `${h.username}@` : ""}${h.address}`;
      return [
        {
          group: "Connect",
          title: h.label,
          arg: "— open a shell",
          run: () => {
            selectHost(h.id);
            openTerminal(h.id, title);
          },
        },
        {
          group: "Files",
          title: h.label,
          arg: "— browse SFTP",
          run: () => {
            selectHost(h.id);
            openFiles(h.id, title);
          },
        },
        {
          group: "Monitor",
          title: h.label,
          arg: "— live metrics",
          run: () => {
            selectHost(h.id);
            openMonitor(h.id, title);
          },
        },
      ];
    });
    return [...base, ...hostCmds];
  }, [hosts, selectHost]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) =>
      `${c.group} ${c.title} ${c.arg ?? ""}`.toLowerCase().includes(s),
    );
  }, [commands, q]);

  // Sonuç değişince seçimi başa çek (out-of-range olmasın).
  useEffect(() => {
    setIdx(0);
  }, [q]);

  // Butonun çağıracağı açıcıyı kaydet.
  useEffect(() => {
    externalOpen = () => {
      setQ("");
      setIdx(0);
      setOpen(true);
    };
    return () => {
      externalOpen = null;
    };
  }, []);

  // ⇧⇧ (çift Shift) global kısayolu. Araya başka tuş girerse sayaç sıfırlanır
  // (böylece büyük harf yazarken —Shift+H, Shift+E— yanlışlıkla açılmaz).
  useEffect(() => {
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !e.repeat) {
        const t = Date.now();
        if (t - last < 400) {
          last = 0;
          externalOpen?.();
        } else {
          last = t;
        }
      } else if (e.key !== "Shift") {
        last = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Esc + odak tuzağı + odak iadesi: lib/modal.ts (tek kaynak).
  useModal(boxRef, () => setOpen(false), open);

  // Açıkken: gezinme/çalıştır. Input odaklan.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    const onKey = (e: KeyboardEvent) => {
      // Esc lib/modal.ts'te (tek kaynak) — burada yalnız gezinme ve çalıştırma.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const c = results[idx];
        if (c) {
          c.run();
          setOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, results, idx]);

  if (!open) return null;

  const pick = (c: Cmd) => {
    c.run();
    setOpen(false);
  };

  return (
    // overlay-instant: paletin KENDİSİ animasyonsuzdur. ⇧⇧ ile günde yüzlerce kez
    // açılır; klavyeyle başlatılan bir aksiyonun animasyonu arayüzü yavaş ve kopuk
    // hissettirir. Yalnız scrim çok kısa bir fade alır (sert siyah geçiş olmasın).
    <div
      className="overlay overlay-instant"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="pal-in">
          <Search size={16} strokeWidth={1.75} />
          {/* Combobox deseni: satırlar odak ALMAZ (ok tuşlarıyla gezilir), o
              yüzden ekran okuyucuya seçili satır aria-activedescendant ile
              bildirilir — yoksa arayüzde hiçbir şey olmuyormuş gibi görünür. */}
          <input
            ref={inputRef}
            placeholder="Type a command or host…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={results.length ? `pal-i-${idx}` : undefined}
            aria-label="Type a command or host"
          />
        </div>
        <div className="pal-list" id="pal-list" role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <div className="pal-empty">No commands match.</div>
          ) : (
            results.map((c, i) => (
              <div
                key={`${c.group}:${c.title}:${i}`}
                id={`pal-i-${i}`}
                role="option"
                aria-selected={i === idx}
                className={"pal-i" + (i === idx ? " sel" : "")}
                onMouseMove={() => i !== idx && setIdx(i)}
                onClick={() => pick(c)}
              >
                <span className="k">{c.group}</span>
                <span className="nm">{c.title}</span>
                {c.arg ? <span className="arg">{c.arg}</span> : null}
              </div>
            ))
          )}
        </div>
        <div className="pal-foot">
          <span>
            <b className="pal-k">
              <ArrowUp size={16} strokeWidth={1.75} />
              <ArrowDown size={16} strokeWidth={1.75} />
            </b>{" "}
            navigate
          </span>
          <span>
            <b className="pal-k">
              <CornerDownLeft size={16} strokeWidth={1.75} />
            </b>{" "}
            run
          </span>
          <span>
            <b>esc</b> close
          </span>
        </div>
      </div>
    </div>
  );
}
