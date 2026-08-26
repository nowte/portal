// Terminal — xterm.js ↔ russh PTY (portal-core). Girdi: xterm onData → send_input.
// Çıktı: portal://ssh/{id} Output(base64) → term.write. Resize: FitAddon → resize_pty.
// Renkler shell'in GERÇEK ANSI'sidir (monokrom kural yalnız Portal chrome'u için).

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
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
  const { hosts, reportConn, dropConn } = usePortal();
  const host = hosts.find((h) => h.id === hostId);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const commandRef = useRef(command);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [hostKey, setHostKey] = useState<HostKeyReq | null>(null);

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

  return (
    <div className="term-wrap" onPointerDown={() => setGuideTopic("terminal")}>
      <div ref={hostRef} className="term-host" />
      {phase !== "connected" && phase !== "closed" && !hostKey && (
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
      {phase === "closed" && (
        <div className="term-overlay">
          <div className="term-card">
            <div className="term-dim">{message || "Session closed."}</div>
            <button className="btn-primary" onClick={retry}>
              <span>Reconnect</span>
            </button>
          </div>
        </div>
      )}
      {hostKey && <HostKeyModal req={hostKey} onDecision={decide} />}
    </div>
  );
}
