// Monitor — canlı sistem metrikleri (MetricsEvent köprüsü: portal://metrics/{id}).
// CPU/RAM/Disk/Network stat kartları + uPlot sparkline (CPU/RAM geçmişi) + yük/çekirdek/
// süreç/uptime satırı. Ajan gerektirmez (portal-core /proc exec parser'ı).

import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePortal } from "../context";
import { setGuideTopic } from "../lib/guide";
import { requestAuth } from "../components/AuthDialog";
import { HostKeyModal, type HostKeyReq } from "../components/HostKeyModal";
import { Spark } from "../components/Spark";
import {
  closeSession,
  connectMonitor,
  forgetCreds,
  hostIsCached,
  hostKeyDecision,
  onMetrics,
} from "../lib/ipc";
import type { Metrics } from "../lib/types";
import type { UnlistenFn } from "@tauri-apps/api/event";

const HISTORY = 60;

function human(kb: number): string {
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
function rate(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}
function level(pct: number): string {
  if (pct >= 90) return "warn";
  return "ok";
}

// deferConnect: bkz. TerminalPanel — diskten geri yüklenen pane kendiliğinden bağlanmaz.
export function MonitorPanel({
  hostId,
  paneId,
  deferConnect,
}: {
  hostId: string;
  /** Dock pane kimliği — bağlantı durumu sekmede bunun üzerinden görünür. */
  paneId?: string;
  deferConnect?: boolean;
}) {
  const { hosts, reportConn, dropConn } = usePortal();
  const host = hosts.find((h) => h.id === hostId);

  const sessionRef = useRef<number | null>(null);
  const gotRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // "idle" yalnız geri yüklenen (deferConnect) pane'de görülür: bağlanmadan bekler.
  const [phase, setPhase] = useState<"idle" | "connecting" | "live" | "error">(
    deferConnect ? "idle" : "connecting",
  );
  const [message, setMessage] = useState("");
  const [hostKey, setHostKey] = useState<HostKeyReq | null>(null);
  const [m, setM] = useState<Metrics | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [netHist, setNetHist] = useState<number[]>([]);

  useEffect(() => setGuideTopic("monitor"), []);

  // Bağlanma denemesi sayacı — iptal edilen bir deneme geri döndüğünde kendi
  // oturumunu kapatır ve ekranı ezmez. Bkz. TerminalPanel (aynı desen).
  const genRef = useRef(0);

  const connect = useCallback(async () => {
    if (!host) return;
    setPhase("connecting");
    setMessage("");
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    const cached = await hostIsCached(hostId);
    if (stale()) return;
    let auth;
    if (!cached) {
      const a = await requestAuth(host);
      if (stale()) return;
      if (!a) {
        setPhase("error");
        setMessage("Cancelled — nothing was sent to the server. Press Retry when you're ready.");
        return;
      }
      auth = a;
    }
    try {
      const id = await connectMonitor(hostId, auth);
      if (stale()) {
        void closeSession(id);
        return;
      }
      sessionRef.current = id;
      reportConn(id, hostId, "monitor", "connecting", paneId);
      unlistenRef.current = await onMetrics(id, (msg) => {
        switch (msg.type) {
          case "hostKey":
            setHostKey(msg);
            break;
          case "update":
            gotRef.current = true;
            setPhase("live");
            reportConn(id, hostId, "monitor", "connected", paneId);
            setM(msg.metrics);
            setCpuHist((h) => [...h, msg.metrics.cpuPct].slice(-HISTORY));
            setMemHist((h) => [...h, msg.metrics.memPct].slice(-HISTORY));
            setNetHist((h) => [...h, msg.metrics.netRxBps].slice(-HISTORY));
            break;
          case "error":
            if (!gotRef.current) {
              void forgetCreds(hostId);
              setPhase("error");
              reportConn(id, hostId, "monitor", "error", paneId);
              setMessage(msg.message);
            }
            break;
        }
      });
    } catch (e) {
      if (stale()) return;
      setPhase("error");
      setMessage(String(e));
    }
  }, [host, hostId, paneId, reportConn]);

  useEffect(() => {
    if (!deferConnect) void connect();
    return () => {
      if (unlistenRef.current) unlistenRef.current();
      const id = sessionRef.current;
      if (id != null) {
        void closeSession(id);
        dropConn(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Terminal'dekiyle AYNI geri dönüş yolu: dinleyiciyi sök, oturumu kapat, kaydı
  // düşür (yoksa sekmedeki işaret ölü oturumu gösterir), baştan bağlan.
  const retry = () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const id = sessionRef.current;
    if (id != null) {
      void closeSession(id);
      dropConn(id);
    }
    sessionRef.current = null;
    gotRef.current = false;
    setMessage("");
    void connect();
  };

  // Bağlanmayı yarıda kes; çekirdek el sıkışmayı da keser (ssh.rs Cancel).
  const cancelConnect = () => {
    genRef.current++;
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const id = sessionRef.current;
    if (id != null) {
      void closeSession(id);
      dropConn(id);
    }
    sessionRef.current = null;
    setPhase("idle");
    // İptal edilen bir bağlanma "düzen geri yüklendi" DEĞİLDİR: idle kartı
    // kullanıcının az önce yaptığı şeyi anlatsın.
    setMessage("Cancelled before the server answered.");
  };

  const decide = (accept: boolean) => {
    const id = sessionRef.current;
    setHostKey(null);
    if (id != null) void hostKeyDecision(id, accept);
    if (!accept) {
      setPhase("error");
      setMessage(
        "You didn't trust this server's key, so Portal stopped before signing in. Retry to see the fingerprint again.",
      );
    }
  };

  return (
    <div className="panelbody" onPointerDown={() => setGuideTopic("monitor")}>
      <section className="mon">
        {phase === "idle" && (
          <div className="pane-idle">
            <div className="pane-idle-t">Monitor is ready when you are</div>
            <div className="pane-idle-s">
              {message || "Portal restored this panel's position but didn't reconnect on its own."}
            </div>
            <button className="btn-primary" onClick={() => void connect()}>
              <span>Connect</span>
            </button>
          </div>
        )}
        {phase === "connecting" && (
          /* Bağlanırken de bir çıkış var (P11): ulaşılamayan host'un zaman
             aşımını beklemek zorunda değilsin. */
          <div className="err-retry">
            <div className="mon-status">
              <span className="st" />
              Connecting to {host?.label}…
            </div>
            <button className="btn-ghost" onClick={cancelConnect}>
              Cancel
            </button>
          </div>
        )}
        {phase === "error" && (
          <div className="err-retry">
            <div className="mon-status err">
              <span className="st" />
              <span>
                Couldn&apos;t read this server&apos;s health.
                <span className="raw">{message}</span>
              </span>
            </div>
            <button className="btn-primary" onClick={retry}>
              <span>Retry</span>
            </button>
          </div>
        )}

        {phase === "connecting" && !m && (
          <div className="mon-cards">
            {["CPU", "Memory", "Disk /", "Network"].map((label) => (
              <div className="mcard" key={label}>
                <span className="u">{label}</span>
                <span className="skel skel-big" />
                <span className="skel skel-bar" />
                <span className="skel skel-foot" />
              </div>
            ))}
          </div>
        )}

        {m && (
          <>
            <div className="mon-cards">
              <div className={"mcard " + level(m.cpuPct)}>
                <span className="u">CPU</span>
                <span className={"mbig num " + level(m.cpuPct)}>
                  {m.cpuPct.toFixed(0)}%
                  {level(m.cpuPct) === "warn" && <span className="mk" />}
                </span>
                <Spark data={cpuHist} />
                <span className="mfoot">{m.cores} cores</span>
              </div>
              <div className={"mcard " + level(m.memPct)}>
                <span className="u">Memory</span>
                <span className={"mbig num " + level(m.memPct)}>
                  {m.memPct.toFixed(0)}%
                  {level(m.memPct) === "warn" && <span className="mk" />}
                </span>
                <Spark data={memHist} />
                <span className="mfoot mono">
                  {human(m.memUsedKb)} / {human(m.memTotalKb)}
                </span>
              </div>
              <div className={"mcard " + level(m.diskPct)}>
                <span className="u">Disk /</span>
                <span className={"mbig num " + level(m.diskPct)}>
                  {m.diskPct.toFixed(0)}%
                  {level(m.diskPct) === "warn" && <span className="mk" />}
                </span>
                <div className="mbar">
                  <i className={"mbar-fill " + level(m.diskPct)} style={{ transform: `scaleX(${m.diskPct / 100})` }} />
                </div>
                <span className="mfoot mono">
                  {human(m.diskUsedKb)} / {human(m.diskTotalKb)}
                </span>
              </div>
              <div className="mcard">
                <span className="u">Network</span>
                <span className="mbig num sm">
                  <ArrowDown className="mk-i" size={20} strokeWidth={1.75} /> {rate(m.netRxBps)}
                </span>
                <Spark data={netHist} />
                <span className="mfoot mono">
                  <ArrowUp className="mk-i" size={16} strokeWidth={1.75} /> {rate(m.netTxBps)}
                </span>
              </div>
            </div>

            <div className="mon-strip">
              <div className="mseg">
                <span className="u">Load</span>
                <span className="v mono">
                  {m.load1.toFixed(2)} · {m.load5.toFixed(2)} · {m.load15.toFixed(2)}
                </span>
              </div>
              <div className="mseg">
                <span className="u">Processes</span>
                <span className="v mono">{m.processes}</span>
              </div>
              <div className="mseg">
                <span className="u">Cores</span>
                <span className="v mono">{m.cores}</span>
              </div>
              <div className="mseg">
                <span className="u">Uptime</span>
                <span className="v">{m.uptime || "—"}</span>
              </div>
            </div>

            {(m.disks ?? []).length > 0 && (
              <div className="mblock">
                <div className="mblock-h">Storage</div>
                <div className="disks">
                  {m.disks.map((d) => (
                    <div className={"disk " + level(d.pct)} key={d.mount}>
                      <div className="disk-top">
                        <span className="disk-mount mono">{d.mount}</span>
                        <span className="disk-fs mono">{d.filesystem}</span>
                        <span className={"disk-pct num " + level(d.pct)}>
                          {d.pct.toFixed(0)}%
                          {level(d.pct) === "warn" && <span className="mk" />}
                        </span>
                      </div>
                      <div className="mbar">
                        <i className={"mbar-fill " + level(d.pct)} style={{ transform: `scaleX(${d.pct / 100})` }} />
                      </div>
                      <div className="disk-foot mono">
                        {human(d.usedKb)} / {human(d.totalKb)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mblock">
              <div className="mblock-h">
                Top processes <span className="mblock-sub">by CPU</span>
              </div>
              {(m.topProcesses ?? []).length === 0 ? (
                <div className="proc-empty">
                  No process data (the host's <span className="mono">ps</span> may be limited).
                </div>
              ) : (
                <table className="proc">
                  <thead>
                    <tr>
                      <th className="num">CPU%</th>
                      <th className="num">MEM%</th>
                      <th className="num">PID</th>
                      <th>User</th>
                      <th>Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.topProcesses.map((p) => (
                      <tr key={p.pid}>
                        <td className={"num " + level(p.cpu)}>
                          {p.cpu.toFixed(1)}
                          {level(p.cpu) === "warn" && <span className="mk" />}
                        </td>
                        <td className="num">{p.mem.toFixed(1)}</td>
                        <td className="num mono dim">{p.pid}</td>
                        <td className="mono dim">{p.user}</td>
                        <td className="proc-cmd mono">{p.command}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </section>
      {hostKey && <HostKeyModal req={hostKey} onDecision={decide} />}
    </div>
  );
}
