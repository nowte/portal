// Monitör durum değişiminin uygulama içi bildirimi — sağ altta, durum
// çubuğunun üstünde.
//
// Kural: Portal'a BAKIYORSAN haber burada verilir; başka yerdeysen (ya da
// uygulama tepside gizliyse) Rust ayrıca sistem bildirimini gönderir — sistem
// toast'ı ekranı kesen bir jesttir, sen zaten bakarken atmanın anlamı yok.
// Bkz. main.rs `notify_state_change`.
//
// ROZET: görev çubuğu/tepsi ikonundaki kırmızı sayı buradaki şerit sayısının
// AYNISIDIR — Rust'ta ayrı bir sayaç yok. Şerit gidince rozet de gider. Bu
// yüzden şeridin süresi pencere odakta değilken DURUR: yoksa sen masanda
// yokken hem şerit hem rozet söner ve döndüğünde hiçbir iz kalmazdı.
//
// BİRİKME: çok bildirim gelince köşe yukarı doğru büyümez, DESTE olur — en yeni
// önde, eskiler arkasında gölge katman. Desteye tıklayınca hepsi açılır. Sekiz
// sunucu birden düşerse sekiz şerit ekranı yemez; bir şerit + "+7" durur.
//
// Yeni bir tasarım dili açmıyor: overlay katmanının gövdesi (panel yüzeyi +
// gölge + --r-m) ve §3'ün mevcut `p-rise` keyframe'i.

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { StateIcon } from "./StateIcon";
import * as ipc from "../lib/ipc";
import { showSide } from "../dock/dock";
import type { MonitorChanged } from "../lib/types";

/** Bildirim kaç ms sonra kendiliğinden gider — kalıcı kayıt zaten Uptime
 *  panelinde ve durum çubuğundaki "N down" sayacında (§9: tek taşıyıcı yok). */
const LINGER = 9000;

/** Bellekte tutulan en fazla bildirim. Deste açıldığında gösterilecek olanlar
 *  bunlar; üstü birikirse en ESKİSİ düşer. */
const KEEP = 6;

/** Destede görünen katman: ön kart + arkasında en fazla iki gölge. Üçten
 *  fazlası gölge olarak da okunmuyor, yalnız bulanıklık ekliyor. */
const LAYERS = 3;

/** Çıkış süresi §1'deki --dur-exit'ten okunur — TS'te ikinci bir 140 yazmak
 *  token'la sessizce ayrışırdı (DESIGN: tüm süreler yalnız §1'de). */
function exitMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--dur-exit").trim();
  return Number.parseFloat(v) || 140;
}

type Seen = MonitorChanged & { key: number; bornAt: number; leaving?: boolean };

function NoteBody({
  note,
  extra,
  onDismiss,
}: {
  note: Seen;
  extra: number;
  onDismiss: () => void;
}) {
  // Deste kapalıyken kartın kendisi "aç" düğmesidir; içindeki iki eylem onu
  // tetiklememeli, yoksa kapatmaya basınca deste de açılır.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="note-row">
      {/* Biçim de konuşuyor: renk tek taşıyıcı değil (§9). */}
      <StateIcon state={note.down ? "down" : "up"} />
      <span className="note-t">
        <b>{note.title}</b>
        <span className="note-s">{note.body}</span>
      </span>
      {extra > 0 && <span className="note-n">+{extra}</span>}
      <button className="btn-primary" onClick={stop(() => showSide("uptime"))}>
        <span>Open Uptime</span>
      </button>
      <button className="dlg-x" aria-label="Dismiss" title="Dismiss" onClick={stop(onDismiss)}>
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function Notices() {
  const [notes, setNotes] = useState<Seen[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /// Süpürücünün okuduğu güncel liste — zamanlayıcının içinden state okumak
  /// için (effect'i her şerit değişiminde yeniden kurmadan).
  const notesRef = useRef<Seen[]>([]);
  notesRef.current = notes;

  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  // İki fazlı çıkış: önce `leaving` (CSS animasyonu), sonra gerçek kaldırma.
  // Tek fazda kaldırsaydık şerit animasyonsuz kaybolurdu.
  const retire = useCallback((key: number) => {
    setNotes((n) => n.map((x) => (x.key === key ? { ...x, leaving: true } : x)));
    timers.current.push(
      setTimeout(() => setNotes((n) => n.filter((x) => x.key !== key)), exitMs()),
    );
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    void ipc.onMonitorChanged((m) => {
      setNotes((n) => {
        const next = [...n, { ...m, key: Date.now() + Math.random(), bornAt: Date.now() }];
        const live = next.filter((x) => !x.leaving);
        // Taşanlar (en eskiler) hemen çıkışa; sayım yalnız DURAN şeritler
        // üzerinden, zaten gitmekte olanı ikinci kez saymayalım.
        for (const old of live.slice(0, Math.max(0, live.length - KEEP))) {
          timers.current.push(setTimeout(() => retire(old.key), 0));
        }
        return next;
      });
    }).then((f) => (off = f));
    return () => {
      off?.();
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, [retire]);

  // Süre dolumu tek süpürücüyle: her şerit için ayrı zamanlayıcı yerine tek
  // yerden bakılır. İKİ durumda durur:
  //   · deste açıkken — kullanıcı okumak için açtıysa şeritlerin altından
  //     kayması sinir bozucu olurdu;
  //   · pencere odakta DEĞİLKEN — sen masanda yokken sönerlerse döndüğünde
  //     ne şerit ne rozet kalır, yani "ekranda yokken haber ver" ölür.
  //
  // ⚠️ Süresi dolanlar setNotes'un İÇİNDEN taranmaz. Öyle yazılmıştı ve
  // güncelleyici saf olmadığı için (içinden yine setNotes çağrılıyordu) React
  // dönen dizi aynı referans olunca render'ı atlıyor, `leaving` sınıfı DOM'a
  // hiç yazılmadan 140ms sonraki kaldırma tetikleniyordu: şerit ANIMASYONSUZ
  // kayboluyordu. Liste ref'ten okunur, `retire` güncelleyicinin dışında çağrılır.
  useEffect(() => {
    if (open || !focused) return;
    const t = setInterval(() => {
      const now = Date.now();
      for (const x of notesRef.current) {
        if (!x.leaving && now - x.bornAt > LINGER) retire(x.key);
      }
    }, 500);
    return () => clearInterval(t);
  }, [open, focused, retire]);

  // Deste kapanınca herkese taze süre: açıkken beklemiş şeritler kapanır
  // kapanmaz topluca kaybolmasın.
  const collapse = useCallback(() => {
    setOpen(false);
    setNotes((n) => n.map((x) => ({ ...x, bornAt: Date.now() })));
  }, []);

  const live = notes.filter((n) => !n.leaving);

  // Görev çubuğu/tepsi rozeti destenin sayısını AYNEN taşır — ayrı bir sayaç
  // tutulsaydı biri sönerken öteki yapışırdı.
  useEffect(() => {
    void ipc.setAlertBadge(live.length).catch(() => undefined);
  }, [live.length]);
  // Son şerit de gidince deste kendini kapatır; bir sonraki bildirim yine
  // kapalı gelir.
  useEffect(() => {
    if (live.length === 0 && open) setOpen(false);
  }, [live.length, open]);

  if (notes.length === 0) return null;

  if (open) {
    return (
      <div className="notes">
        <div className="deck open">
          <button className="note-less" onClick={collapse}>
            Show less
          </button>
          {/* En yeni ÜSTTE — destenin ön kartıyla aynı sıra. */}
          {[...notes].reverse().map((n) => (
            <div key={n.key} className={"note" + (n.leaving ? " leaving" : "")} role="status">
              <NoteBody note={n} extra={0} onDismiss={() => retire(n.key)} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Ön kart `live`'dan DEĞİL `notes`'tan seçilir: kapatılan kart, çıkış
  // animasyonu bitene kadar yerinde kalmalı. `live` kullanılırsa yerine anında
  // bir alttaki geçer ve çıkış hiç görünmez.
  const front = notes[notes.length - 1];
  const shadows = Math.min(live.length, LAYERS) - 1;

  return (
    <div className="notes">
      <div
        className="deck"
        role="button"
        tabIndex={0}
        aria-label={live.length > 1 ? `Show all ${live.length} alerts` : undefined}
        onClick={() => live.length > 1 && setOpen(true)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && live.length > 1) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {/* Gölge katmanlar: içeriksiz, yalnız yüzey. Ön kartın kutusunu birebir
            kaplayıp yukarı kayarlar — okunacak bir şey taşımadıkları için
            ekran okuyucudan da gizliler. */}
        {Array.from({ length: shadows }, (_, i) => (
          <div key={i} className="note note-shadow" data-i={i + 1} aria-hidden="true" />
        ))}
        {/* `key` ŞART: onsuz React yeni bildirimde aynı düğümü tekrar kullanır,
            yalnız metni değiştirir ve giriş animasyonu bir daha hiç oynamaz. */}
        <div
          key={front.key}
          className={"note note-front" + (front.leaving ? " leaving" : "")}
          role="status"
        >
          <NoteBody
            note={front}
            extra={Math.max(0, live.length - 1)}
            onDismiss={() => retire(front.key)}
          />
        </div>
      </div>
    </div>
  );
}
