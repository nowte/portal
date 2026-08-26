// Terminal — xterm.js ↔ russh PTY (portal-core). Girdi: xterm onData → send_input.
// Çıktı: portal://ssh/{id} Output(base64) → term.write. Resize: FitAddon → resize_pty.
// Renkler shell'in GERÇEK ANSI'sidir (monokrom kural yalnız Portal chrome'u için).

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowUp, ExternalLink, X } from "lucide-react";
import { usePortal } from "../context";
import { setGuideTopic } from "../lib/guide";
import { requestAuth } from "../components/AuthDialog";
import { HostKeyModal, type HostKeyReq } from "../components/HostKeyModal";
import {
  closeSession,
  connectShell,
  forgetCreds,
  hostIsCached,
  hostKeyDecision,
  onShell,
  openExternal,
  resizePty,
  sendInput,
} from "../lib/ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";

type Phase = "idle" | "connecting" | "connected" | "closed" | "error";

// base64 → Uint8Array (UTF-8 sınırı bozulmasın diye baytlar korunur).
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Arama vurgusu — terminalin İÇİ (§7.5) Portal paletinin dışındadır, ama burada
// da renk tek taşıyıcı değil: aktif eşleşme ayrıca beyaz çerçeveyle ayrılır.
// Zeminler koyu tutulur; xterm metni üstüne kendi ANSI rengiyle çizer.
const FIND_DECORATIONS = {
  matchBackground: "#2e2e2e",
  matchBorder: "#5a5a5a",
  matchOverviewRuler: "#5a5a5a",
  activeMatchBackground: "#525252",
  activeMatchBorder: "#ffffff",
  activeMatchColorOverviewRuler: "#ffffff",
};

// deferConnect: düzen diskten geri yüklendiğinde true. Pane yerinde durur ama
// kendiliğinden bağlanmaz — açılışta arka arkaya parola diyaloğu çıkmasın diye
// kullanıcı "Connect"e basana kadar bekler.
export function TerminalPanel({
  hostId,
  paneId,
  command,
  deferConnect,
}: {
  hostId: string;
  /** Dock pane kimliği — bağlantı durumu sekmede bunun üzerinden görünür. */
  paneId?: string;
  command?: string;
  deferConnect?: boolean;
}) {
  const { hosts, reportConn, dropConn, termFontSize, nudgeTermFont } = usePortal();
  const host = hosts.find((h) => h.id === hostId);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const findInRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const commandRef = useRef(command);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [hostKey, setHostKey] = useState<HostKeyReq | null>(null);
  // Bir kez bağlanmış mıydık → ekranda korunacak çıktı var. O andan sonra kopma
  // ve yeniden deneme ekranı KAPLAMAZ; ince bir şerit olur, çıktı okunur kalır.
  const [hadOutput, setHadOutput] = useState(false);
  // Arama kutusu (Ctrl+F) — açık mı, ne aranıyor, kaçıncı eşleşmedeyiz.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState({ index: -1, count: 0 });
  // Tıklanan bağlantı — ONAY olmadan açılmaz (sunucudan gelen metin, güvenilmez).
  const [linkUrl, setLinkUrl] = useState<string | null>(null);

  useEffect(() => setGuideTopic("terminal"), []);

  const connect = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !host) return;
    fit.fit();
    setMessage("");
    setPhase("connecting");
    connectedRef.current = false;

    const cached = await hostIsCached(hostId);
    let auth;
    if (!cached) {
      const a = await requestAuth(host);
      if (!a) {
        setPhase("idle");
        return;
      }
      auth = a;
    }

    try {
      const id = await connectShell(hostId, term.cols, term.rows, auth);
      sessionRef.current = id;
      reportConn(id, hostId, "shell", "connecting", paneId);
      const unlisten = await onShell(id, (m) => {
        switch (m.type) {
          case "hostKey":
            setHostKey(m);
            break;
          case "connected":
            connectedRef.current = true;
            setPhase("connected");
            setHadOutput(true);
            reportConn(id, hostId, "shell", "connected", paneId);
            term.focus();
            if (commandRef.current) {
              void sendInput(id, `${commandRef.current}\n`);
              commandRef.current = undefined;
            }
            break;
          case "output":
            term.write(decode(m.data));
            break;
          case "disconnected":
            setPhase("closed");
            setMessage(m.message);
            reportConn(id, hostId, "shell", "closed", paneId);
            term.write(`\r\n\x1b[90m— ${m.message} —\x1b[0m\r\n`);
            break;
          case "error":
            if (!connectedRef.current) void forgetCreds(hostId);
            setPhase("error");
            reportConn(id, hostId, "shell", "error", paneId);
            setMessage(m.message);
            break;
        }
      });
      // Dinleyici temizliğini session'a bağla.
      unlistenRef.current = unlisten;
    } catch (e) {
      setPhase("error");
      setMessage(String(e));
    }
  }, [host, hostId, paneId, reportConn]);

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // xterm kurulum + ilk bağlanış (bir kez).
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      // styles.css'teki --mono ile aynı kalmalı; xterm CSS değişkeni okuyamadığı
      // için tek kopya burada. --mono değişirse burası da değişir.
      fontFamily: '"Commit Mono", ui-monospace, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Portal chrome monokrom; shell'in kendi ANSI renkleri korunur.
      theme: { background: "#000000", foreground: "#ededed", cursor: "#ededed" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Bağlantıyı KENDİMİZ açmayız: uzak sunucunun bastığı bir metin sessizce
    // tarayıcı açamaz. Tıklama yalnız onay diyaloğunu getirir (P8 #4).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        setLinkUrl(uri);
      }),
    );
    term.open(hostRef.current);
    // WebGL renderer: yoğun çıktıda (log tail, top) DOM renderer'dan belirgin hızlı.
    // Bağlam kaybında ya da WebGL yoksa sessizce DOM renderer'a düş (F9).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL kullanılamıyor → DOM renderer ile devam.
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    const hitsSub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setHits({ index: resultIndex, count: resultCount }),
    );

    // Ctrl+F arama · Ctrl +/- yazı boyutu · Ctrl+0 sıfırla. `false` dönmek tuşu
    // shell'e GÖNDERMEZ; preventDefault ayrıca WebView2'nin kendi yakınlaştırmasını
    // durdurur (Ctrl+- orada sayfayı küçültüyordu).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const hit = (fn: () => void) => {
        e.preventDefault();
        fn();
        return false;
      };
      switch (e.key) {
        case "f":
        case "F":
          return hit(() => setFindOpen(true));
        case "+":
        case "=":
          return hit(() => nudgeTermFont(1));
        case "-":
        case "_":
          return hit(() => nudgeTermFont(-1));
        case "0":
          return hit(() => nudgeTermFont());
        default:
          return true;
      }
    });

    // Girdi → shell.
    const dataSub = term.onData((data) => {
      const id = sessionRef.current;
      if (id != null) void sendInput(id, data);
    });
    // Fit sonrası boyut değişince PTY'yi güncelle.
    const resizeSub = term.onResize(({ cols, rows }) => {
      const id = sessionRef.current;
      if (id != null) void resizePty(id, cols, rows);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // panel gizliyken 0 boyut → yok say
      }
    });
    ro.observe(hostRef.current);

    // Geri yüklenen pane bağlanmaz; "idle" kalır → overlay'de Connect düğmesi.
    if (!deferConnect) void connect();

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      hitsSub.dispose();
      if (unlistenRef.current) unlistenRef.current();
      const id = sessionRef.current;
      if (id != null) {
        void closeSession(id);
        dropConn(id);
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Yazı boyutu uygulamanın genelinde tek değer: başka bir terminalde Ctrl++
  // yapmak buradakini de büyütür. Boyut değişince sütun/satır sayısı da değişir.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = termFontSize;
    try {
      fit.fit();
    } catch {
      // panel gizliyken 0 boyut → yok say
    }
  }, [termFontSize]);

  // Arama kutusu açılınca odak oraya; kapanınca terminale geri döner.
  useEffect(() => {
    if (findOpen) findInRef.current?.focus();
    else {
      searchRef.current?.clearDecorations();
      setHits({ index: -1, count: 0 });
      termRef.current?.focus();
    }
  }, [findOpen]);

  const find = useCallback((q: string, back = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!q) {
      search.clearDecorations();
      setHits({ index: -1, count: 0 });
      return;
    }
    const opts = { decorations: FIND_DECORATIONS };
    if (back) search.findPrevious(q, opts);
    else search.findNext(q, opts);
  }, []);

  // Yazarken canlı ara; findNext imleci ileri taşımasın diye aynı konumdan başlat
  // (xterm `incremental` ile eşleşmeyi genişletir, atlamaz).
  const onQuery = (q: string) => {
    setQuery(q);
    const search = searchRef.current;
    if (!search) return;
    if (!q) {
      search.clearDecorations();
      setHits({ index: -1, count: 0 });
      return;
    }
    search.findNext(q, { decorations: FIND_DECORATIONS, incremental: true });
  };

  const openLink = async () => {
    if (!linkUrl) return;
    const url = linkUrl;
    setLinkUrl(null);
    try {
      await openExternal(url);
    } catch (e) {
      setMessage(String(e));
    }
  };

  const decide = (accept: boolean) => {
    const id = sessionRef.current;
    setHostKey(null);
    if (id != null) void hostKeyDecision(id, accept);
    if (!accept) {
      setPhase("error");
      setMessage("Host key rejected.");
    }
  };

  const retry = () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const id = sessionRef.current;
    if (id != null) {
      void closeSession(id);
      // Eski oturumun kaydı kalırsa sekmedeki işaret yeni bağlantıyı değil onu gösterir.
      dropConn(id);
    }
    sessionRef.current = null;
    commandRef.current = command;
    void connect();
  };

  const hitLabel = hits.count > 0 ? `${hits.index + 1}/${hits.count}` : "no match";

  return (
    <div className="term-wrap" onPointerDown={() => setGuideTopic("terminal")}>
      <div ref={hostRef} className="term-host" />

      {/* Arama (Ctrl+F) — TERMİNALE AİT bir şerit (§7.5 adası), Portal'ın form
          dili değil: mono, siyah zemin, `/` istemi (less/vim'deki arama işareti).
          Rengini temadan değil beyazın alfasından alır — bkz. styles.css. */}
      {findOpen && (
        <div className="term-chip term-find" role="search">
          <span className="term-find-p" aria-hidden="true">
            /
          </span>
          <input
            ref={findInRef}
            className="term-find-in"
            value={query}
            placeholder="find in output"
            aria-label="Find in terminal output"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setFindOpen(false);
              } else if (e.key === "Enter") {
                e.preventDefault();
                find(query, e.shiftKey);
              }
            }}
          />
          <span className="term-find-n" aria-live="polite">
            {query ? hitLabel : ""}
          </span>
          <button
            className="term-find-b"
            aria-label="Previous match"
            disabled={!query}
            onClick={() => find(query, true)}
          >
            <ArrowUp size={16} strokeWidth={1.75} />
          </button>
          <button
            className="term-find-b"
            aria-label="Next match"
            disabled={!query}
            onClick={() => find(query)}
          >
            <ArrowDown size={16} strokeWidth={1.75} />
          </button>
          <button
            className="term-find-b"
            aria-label="Close search"
            onClick={() => setFindOpen(false)}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {/* İlk bağlanış: ekranda korunacak bir şey yok → kaplayan kart. */}
      {!hadOutput && phase !== "connected" && !hostKey && (
        <div className="term-overlay">
          {phase === "connecting" ? (
            <div className="term-status">
              <span className="st" />
              Connecting…
            </div>
          ) : (
            <div className="term-card">
              {/* Hata: duz-dilli baslik ustte, ham teknik metin altta (§12e desen 3). */}
              {phase === "error" && (
                <div className="term-err">
                  <span className="mk" />
                  <span>
                    Couldn&apos;t open a shell on this server.
                    {message && <span className="raw">{message}</span>}
                  </span>
                </div>
              )}
              <button className="btn-primary" onClick={retry}>
                <span>{phase === "error" ? "Retry" : "Connect"}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bir kez bağlandıysak çıktı KORUNUR: kopma ekranı kaplamaz, altta şerit
          olur. Yeniden bağlanmak tek tık; eski çıktı yerinde durur. */}
      {hadOutput && phase !== "connected" && (
        <div className="term-chip term-bar" role="status">
          <span className="term-bar-t">
            {phase === "connecting"
              ? "Reconnecting…"
              : message || (phase === "error" ? "Connection failed." : "Disconnected.")}
          </span>
          {phase !== "connecting" && (
            <button className="term-btn" onClick={retry}>
              Reconnect
            </button>
          )}
        </div>
      )}

      {/* Dış bağlantı ONAY olmadan açılmaz: URL uzak sunucunun çıktısından geldi. */}
      {linkUrl && (
        <div
          className="overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setLinkUrl(null)}
        >
          <div className="dialog" role="dialog" aria-label="Open link">
            <div className="dlg-head">
              <span className="dlg-title">
                <span className="dlg-ic-wrap">
                  <ExternalLink size={16} strokeWidth={1.75} />
                </span>
                Open this link in your browser?
              </span>
            </div>
            <p className="dlg-sub">
              This address came from the server&apos;s output, not from Portal. Check it
              before you open it — Portal will hand it to your default browser as-is.
            </p>
            <div className="dlg-body">
              <div className="term-link">{linkUrl}</div>
            </div>
            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => setLinkUrl(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={openLink}>
                <span>Open</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {hostKey && <HostKeyModal req={hostKey} onDecision={decide} />}
    </div>
  );
}
