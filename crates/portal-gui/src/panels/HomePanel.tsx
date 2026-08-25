// Home — ana ekran (mockup: docs/mockups/portal-windows-gui-main.html).
// Sıra: karşılama → quick connect → 6 segmentli system band → "Attention needed"
// → alt iki kolon (Recently added / Favorites · Recent activity).
//
// Uyarılar UYDURULMAZ: yalnız gerçekten elimizde olan sinyallerden üretilir
// (kilitli vault, bağlantısı düşmüş auto-connect host'u, kesintideki monitör).
// Sinyal yoksa bölüm hiç render edilmez.

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowRight, Clock, CornerDownLeft, Database, FolderTree, Gauge, KeyRound, Lock, Server, Star, Terminal as TerminalIcon, TriangleAlert, Zap, type LucideIcon } from "lucide-react";
import { usePortal } from "../context";
import { openFiles, openGateway, openMonitor, openTerminal, showSide } from "../dock/dock";
import { openSettings } from "../components/Settings";
import { setGuideTopic } from "../lib/guide";
import {
  pruneLocal,
  relativeTime,
  toggleFavorite,
  useActivity,
  useFavorites,
  type ActivityKind,
} from "../lib/local";
import { downMonitors, targetText, useMonitors } from "../lib/uptime";
import type { Host } from "../lib/types";

function hostTitle(h: Host): string {
  return h.username ? `${h.username}@${h.address}` : h.address;
}
function initials(h: Host): string {
  return (h.label.trim() || h.address).slice(0, 2).toUpperCase();
}

// Uygulamanın açık kalma süresi (site izleme ile ilgisi yok — o Uptime panelidir).
// Saniyede bir tick'ler; kendi başına bir bileşen → yalnız bu segment yeniden
// render olur, tüm HomePanel değil.
function SessionAge() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - start) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (
    <span className="val num">
      {d}
      <small>d</small> {h}
      <small>h</small> {m}
      <small>m</small>
    </span>
  );
}

const ACT_ICON: Record<ActivityKind, LucideIcon> = {
  terminal: TerminalIcon,
  files: FolderTree,
  monitor: Activity,
  gateway: Server,
};
// Satırın title'ı: "Open opened on X" gibi bozuk cümle kurmamak için ayrı.
const ACT_TITLE: Record<ActivityKind, string> = {
  terminal: "Open a terminal on",
  files: "Browse files on",
  monitor: "Watch the health of",
  gateway: "Open",
};
const ACT_LABEL: Record<ActivityKind, string> = {
  terminal: "terminal",
  files: "files",
  monitor: "host metrics",
  gateway: "opened",
};

export function HomePanel() {
  const { hosts, boot, selectHost, hostState, onlineHosts, liveSessions } = usePortal();
  const [tab, setTab] = useState<"home" | "dash">("home");
  const [qc, setQc] = useState("");
  const [qcErr, setQcErr] = useState<string | null>(null);
  const favorites = useFavorites();
  const activity = useActivity();
  const { monitors } = useMonitors();

  useEffect(() => setGuideTopic("home"), []);
  // Silinmiş host'ların favori/etkinlik kayıtlarını temizle.
  useEffect(() => {
    pruneLocal(hosts.map((h) => h.id));
  }, [hosts]);

  const open = (h: Host) => {
    selectHost(h.id);
    openGateway(h.id, hostTitle(h));
  };

  // Bir etkinlik kaydına tıklamak, o kaydın DOĞDUĞU yüzeye geri götürür:
  // "terminal" satırı terminali, "files" satırı dosyaları açar. Kayıt neyse
  // onu göstermek, hepsini Gateway'e düşürmekten daha doğru bir geri dönüş.
  const openActivity = (a: { hostId: string; kind: ActivityKind }) => {
    const h = hostById.get(a.hostId);
    if (!h) return;
    const title = hostTitle(h);
    selectHost(h.id);
    if (a.kind === "terminal") openTerminal(h.id, title);
    else if (a.kind === "files") openFiles(h.id, title);
    else if (a.kind === "monitor") openMonitor(h.id, title);
    else openGateway(h.id, title);
  };

  // Quick connect: kayıtlı host'lar içinde eşleşeni bul → terminal aç.
  const quickConnect = () => {
    const q = qc.trim().toLowerCase();
    if (!q) return;
    const h = hosts.find((x) => {
      const who = (x.username ? `${x.username}@` : "") + x.address;
      return (
        who.toLowerCase().includes(q) ||
        x.address.toLowerCase().includes(q) ||
        x.label.toLowerCase().includes(q)
      );
    });
    if (h) {
      selectHost(h.id);
      openTerminal(h.id, hostTitle(h));
      setQc("");
      setQcErr(null);
    } else {
      setQcErr("No saved server matches — add it in Hosts first.");
    }
  };

  const greeting = useMemo(() => {
    const hr = new Date().getHours();
    return hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
  }, []);
  const dateStr = useMemo(
    () =>
      // Locale sabit: kullaniciya gorunen her sey Ingilizce (GK6).
      new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [],
  );

  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);
  const favHosts = favorites.map((id) => hostById.get(id)).filter((h): h is Host => !!h);
  // "Recently added" için gerçek bir eklenme tarihi yok → kayıt sırasının sonu
  // en yeni kabul edilir (Store host'ları eklendikleri sırada tutar).
  const recent = useMemo(() => [...hosts].reverse().slice(0, 4), [hosts]);

  // ── Gerçek sinyallerden uyarılar ────────────────────────────────────────
  const alerts = useMemo(() => {
    const out: {
      id: string;
      severity: "crit" | "warn";
      Icon: LucideIcon;
      title: string;
      sub: string;
      action: string;
      run: () => void;
    }[] = [];
    if (boot?.locked) {
      out.push({
        id: "locked",
        severity: "crit",
        Icon: Lock,
        title: "Vault is locked",
        sub: "servers can't be edited until you unlock",
        action: "Unlock",
        run: () => openSettings("profiles"),
      });
    }
    for (const m of downMonitors(monitors)) {
      out.push({
        id: `down:${m.monitor.id}`,
        severity: "crit",
        Icon: TriangleAlert,
        title: `${m.monitor.label} is down`,
        sub: m.last?.error ?? targetText(m),
        action: "Open Uptime",
        run: () => showSide("uptime"),
      });
    }
    return out;
  }, [boot?.locked, hosts, hostState, monitors, selectHost]);

  return (
    // panelbody-col: subtabs sabit kalsın, yalnız içerik kaysın (mockup düzeni).
    // Diğer paneller sade .panelbody kullanmayı sürdürür — kapsam dar tutuldu.
    <div className="panelbody panelbody-col">
      <div className="subtabs">
        <button className={"stab" + (tab === "home" ? " active" : "")} onClick={() => setTab("home")}>
          Homepage
        </button>
        <button className={"stab" + (tab === "dash" ? " active" : "")} onClick={() => setTab("dash")}>
          Dashboard
        </button>
      </div>

      {tab === "home" ? (
        <section className="home" key="home">
            {/* karşılama */}
            <div className="greet reveal reveal-1">
              <h1>{greeting}</h1>
              <div className="subgreet">
                <span className="mono">{dateStr}</span>
                <span className="sep">·</span>
                <span className="live">
                  <span className={"dot " + (onlineHosts > 0 ? "on" : "off")} />
                  {hosts.length === 0
                    ? "no servers saved yet"
                    : `${onlineHosts} of ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} connected`}
                </span>
              </div>
            </div>

            {/* quick connect */}
            <div className="qc reveal reveal-2">
              <label className="quickconnect">
                <Zap size={16} strokeWidth={1.75} />
                <input
                  placeholder="user@host  —  connect to any saved server"
                  value={qc}
                  onChange={(e) => {
                    setQc(e.target.value);
                    setQcErr(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && quickConnect()}
                />
                <span className="hintk">
                  <CornerDownLeft size={16} strokeWidth={1.75} />
                </span>
              </label>
              <button className="btn-hero" onClick={quickConnect}>
                <Zap size={16} strokeWidth={2} />
                Connect
              </button>
            </div>
            {qcErr && (
              <div className="qc-err err">
                <span>{qcErr}</span>
              </div>
            )}

            {/* system band */}
            <div className="sysband reveal reveal-3">
              <div className="sysseg lit">
                <span className="u">
                  <Clock size={16} strokeWidth={1.75} />
                  Session
                </span>
                <SessionAge />
                <span className="sub">since last launch</span>
              </div>
              <div className="sysseg lit">
                <span className="u">
                  <Database size={16} strokeWidth={1.75} />
                  Database
                </span>
                <span className="val sm">
                  <span className={"dot" + (boot?.locked ? " warn" : "")} />
                  {boot?.locked ? "Locked" : "Healthy"}
                </span>
                <span className="sub">{boot?.locked ? "unlock to edit" : "encrypted vault"}</span>
              </div>
              <div className="sysseg lit">
                <span className="u">
                  <Server size={16} strokeWidth={1.75} />
                  Hosts online
                </span>
                <span className="val num">
                  {onlineHosts} <small>/ {hosts.length}</small>
                </span>
                <span className="sub">saved servers</span>
              </div>
              <div className="sysseg lit">
                <span className="u">
                  <TerminalIcon size={16} strokeWidth={1.75} />
                  Sessions
                </span>
                <span className="val num">{liveSessions}</span>
                <span className="sub">{liveSessions === 0 ? "none open" : "open now"}</span>
              </div>
              <div className="sysseg lit">
                <span className="u">
                  <KeyRound size={16} strokeWidth={1.75} />
                  Profile
                </span>
                <span className="val sm">{boot?.profile ?? "local"}</span>
                <span className="sub">{boot?.onboarded ? "profile" : "no account"}</span>
              </div>
              <div className="sysseg lit">
                <span className="u">
                  <Gauge size={16} strokeWidth={1.75} />
                  Device
                </span>
                <span className="val sm">{boot?.device_label ?? "—"}</span>
                <span className="sub">this machine</span>
              </div>
            </div>

            {/* attention needed — yalnız gerçek sinyal varsa */}
            {alerts.length > 0 && (
              <div className="sect reveal reveal-4">
                <div className="sect-head">
                  <span className="sh">Attention needed</span>
                  <span className="cnt">
                    {alerts.length} {alerts.length === 1 ? "alert" : "alerts"}
                  </span>
                </div>
                {alerts.map((a) => {
                  const Icon = a.Icon;
                  return (
                    <div className={"alert " + a.severity} key={a.id}>
                      <span className="ai">
                        <Icon size={20} strokeWidth={1.75} />
                      </span>
                      <span className="txt">
                        <div className="at">{a.title}</div>
                        <div className="asub">{a.sub}</div>
                      </span>
                      <button className="abtn" onClick={a.run}>
                        {a.action}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* alt iki kolon */}
            <div className="lower reveal reveal-5">
              <div>
                <div className="sect">
                  <div className="sect-head">
                    <span className="sh">Recently added</span>
                    <span className="cnt">{hosts.length}</span>
                  </div>
                  {hosts.length === 0 ? (
                    <div className="empty">
                      No servers yet. Open the <b>Hosts</b> panel on the left and press{" "}
                      <b>Add Host</b> to add your first one — nothing leaves this machine.
                    </div>
                  ) : (
                    <div className="recent-list">
                      {recent.map((h) => (
                        <div
                          className="rrow lit"
                          key={h.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => open(h)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              open(h);
                            }
                          }}
                        >
                          <span className="av">{initials(h)}</span>
                          <span className="rn2">
                            <div className="rn">{h.label.trim() || h.address}</div>
                            <div className="ra">{hostTitle(h)}</div>
                          </span>
                          <button
                            className={"fav-toggle" + (favorites.includes(h.id) ? " on" : "")}
                            title={favorites.includes(h.id) ? "Remove from favorites" : "Add to favorites"}
                            aria-label="Toggle favorite"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(h.id);
                            }}
                          >
                            <Star size={16} strokeWidth={1.75} />
                          </button>
                          <span className="rt">{h.port !== 22 ? `port ${h.port}` : "ssh"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {favHosts.length > 0 && (
                  <div className="sect">
                    <div className="sect-head">
                      <span className="sh">Favorites</span>
                    </div>
                    <div className="fav-wrap">
                      {favHosts.map((h) => (
                        <button className="fav lit" key={h.id} onClick={() => open(h)}>
                          <span className="star">
                            <Star size={16} strokeWidth={1.75} />
                          </span>
                          <span className="fn">{h.label.trim() || h.address}</span>
                          <span className="fa">{h.address}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="sect">
                  <div className="sect-head">
                    <span className="sh">Recent activity</span>
                  </div>
                  {activity.length === 0 ? (
                    <div className="empty">
                      Nothing yet. Open a shell, browse files or watch a server's health and it
                      shows up here.
                    </div>
                  ) : (
                    <div className="feed">
                      {activity.slice(0, 7).map((a, i) => {
                        const h = hostById.get(a.hostId);
                        if (!h) return null;
                        const Icon = ACT_ICON[a.kind];
                        return (
                          <button
                            className="actrow"
                            key={`${a.hostId}:${a.at}:${i}`}
                            title={`${ACT_TITLE[a.kind]} ${h.label.trim() || h.address}`}
                            onClick={() => openActivity(a)}
                          >
                            <span className="ft">{relativeTime(a.at)}</span>
                            <span className="fmid">
                              <span className="fh">{h.label.trim() || h.address}</span>
                              <span className="fk">
                                <Icon size={16} strokeWidth={1.75} />
                                {ACT_LABEL[a.kind]}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
        </section>
      ) : (
        <section className="dash" key="dash">
            <div className="cards reveal reveal-1">
              <div className="card lit">
                <span className="u">Total hosts</span>
                <span className="big num">{hosts.length}</span>
                <span className="foot">saved servers</span>
              </div>
              <div className="card lit">
                <span className="u">Online</span>
                <span className="big num">{onlineHosts}</span>
                <span className="foot">
                  {onlineHosts === 0 ? "connect to measure" : "hosts connected"}
                </span>
              </div>
              <div className="card lit">
                <span className="u">Favorites</span>
                <span className="big num">{favHosts.length}</span>
                <span className="foot">{favHosts.length === 0 ? "none pinned" : "pinned"}</span>
              </div>
              <div className="card lit">
                <span className="u">Live sessions</span>
                <span className="big num">{liveSessions}</span>
                <span className="foot">{liveSessions === 0 ? "no shell open" : "open now"}</span>
              </div>
            </div>

            <div className="block reveal reveal-2">
              <h3>
                Fleet <span className="more">{hosts.length}</span>
              </h3>
              {hosts.length === 0 ? (
                <div className="empty">
                  Add a server, then connect to see live CPU / RAM / disk here.
                </div>
              ) : (
                hosts.map((h) => {
                  const st = hostState(h.id);
                  return (
                    <div
                      className={"li click lit" + (st === "offline" ? " off" : "")}
                      key={h.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => open(h)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open(h);
                        }
                      }}
                    >
                      <span
                        className={
                          "dot " +
                          (st === "connected" ? "on" : st === "connecting" ? "connecting" : "off")
                        }
                      />
                      <div className="min0">
                        <div className="nm">{h.label.trim() || h.address}</div>
                        <div className="ip">{hostTitle(h)}</div>
                      </div>
                      <span className="tag">
                        {st === "connected"
                          ? "online · connected"
                          : st === "connecting"
                            ? "connecting…"
                            : "offline · not connected"}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            <div className="sect reveal reveal-3">
              <div className="sect-head">
                <span className="sh">Recent activity</span>
                <span className="sp" />
                <button className="link" onClick={() => setTab("home")}>
                  Homepage
                  <ArrowRight size={16} strokeWidth={1.75} />
                </button>
              </div>
              {activity.length === 0 ? (
                <div className="empty">No sessions opened yet on this machine.</div>
              ) : (
                <div className="feed">
                  {activity.slice(0, 12).map((a, i) => {
                    const h = hostById.get(a.hostId);
                    if (!h) return null;
                    const Icon = ACT_ICON[a.kind];
                    return (
                      <button
                        className="actrow"
                        key={`${a.hostId}:${a.at}:${i}`}
                        title={`${ACT_TITLE[a.kind]} ${h.label.trim() || h.address}`}
                        onClick={() => openActivity(a)}
                      >
                        <span className="ft">{relativeTime(a.at)}</span>
                        <span className="fmid">
                          <span className="fh">{h.label.trim() || h.address}</span>
                          <span className="fk">
                            <Icon size={16} strokeWidth={1.75} />
                            {ACT_LABEL[a.kind]}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
        </section>
      )}
    </div>
  );
}
