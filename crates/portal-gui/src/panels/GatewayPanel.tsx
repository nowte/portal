// Gateway — bir host'un sade dilli karşılama kartı (DESIGN §12.6): durum + user@ip +
// meta çipleri + büyük Connect/Files/Monitor + saved commands (tek-tık). Bağlantıyı
// açmaz; ilgili document sekmesini açar (Terminal/Files/Monitor kendi bağlanır).

import { useCallback, useEffect, useState } from "react";
import { FolderTree, Gauge, Pencil, Plus, Terminal as TerminalIcon, Trash2, Zap } from "lucide-react";
import { usePortal } from "../context";
import { hostSnippets, onSnippetsChanged, removeSnippet } from "../lib/ipc";
import { openFiles, openMonitor, openTerminal } from "../dock/dock";
import { openSnippets } from "../components/SnippetsManager";
import { setGuideTopic } from "../lib/guide";
import type { Snippet } from "../lib/types";

export function GatewayPanel({ hostId }: { hostId: string }) {
  const { hosts, hostState } = usePortal();
  const host = hosts.find((h) => h.id === hostId);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const st = hostState(hostId);

  useEffect(() => setGuideTopic("gateway"), []);

  const load = useCallback(() => {
    void hostSnippets(hostId).then(setSnippets).catch(() => undefined);
  }, [hostId]);

  // İlk yükle + başka yerde (yönetici) değişince tazele.
  useEffect(() => {
    load();
    let un: (() => void) | undefined;
    void onSnippetsChanged(load).then((u) => (un = u));
    return () => un?.();
  }, [load]);

  if (!host) {
    return <div className="panelbody gw-gone">This server no longer exists.</div>;
  }

  const who = host.username ? `${host.username}@${host.address}` : host.address;
  const title = who;
  // Sekme başlığı host ADIYLA kurulur ("Zeus — Terminal", mockup tabstrip). 

  return (
    <div className="gw-body" onPointerDown={() => setGuideTopic("gateway")}>
      <section className="gw">
        <div className="gw-head">
          <div className="gw-id">
            <span className="gw-status">
              <span
                className={
                  "dot " + (st === "connected" ? "on" : st === "connecting" ? "connecting" : "off")
                }
              />{" "}
              {st === "connected"
                ? "Connected"
                : st === "connecting"
                  ? "Connecting…"
                  : "Not connected"}
            </span>
            <h1>{host.label}</h1>
            <div className="gw-who mono">
              {who}
              {host.port !== 22 ? `:${host.port}` : ""}
            </div>
          </div>
        </div>

        <div className="gw-chips">
          <span className="chip lit">
            <span className="k">Port</span>
            <span className="v mono">{host.port}</span>
          </span>
          <span className="chip lit">
            <span className="k">Auth</span>
            <span className="v">{host.identity_id ? "Saved identity" : "Ask on connect"}</span>
          </span>
          {host.forward_agent && (
            <span className="chip lit">
              <span className="k">Agent</span>
              <span className="v">Forwarded</span>
            </span>
          )}
          {host.tags && host.tags.length > 0 && (
            <span className="chip lit">
              <span className="k">Tags</span>
              <span className="v">{host.tags.join(", ")}</span>
            </span>
          )}
        </div>

        <div className="gw-actions">
          <button
            className={"gw-act primary" + (st === "connected" ? " calm" : "")}
            onClick={() => openTerminal(hostId, title)}
          >
            <TerminalIcon size={20} strokeWidth={1.75} />
            <span className="gw-act-t">Connect</span>
            <span className="gw-act-s">Open an interactive shell</span>
          </button>
          <button className="gw-act" onClick={() => openFiles(hostId, title)}>
            <FolderTree size={20} strokeWidth={1.75} />
            <span className="gw-act-t">Files</span>
            <span className="gw-act-s">Browse &amp; transfer (SFTP)</span>
          </button>
          <button className="gw-act" onClick={() => openMonitor(hostId, title)}>
            <Gauge size={20} strokeWidth={1.75} />
            <span className="gw-act-t">Monitor</span>
            <span className="gw-act-s">Live CPU · RAM · disk</span>
          </button>
        </div>

        <div className="block">
          <h3>
            <Zap size={16} strokeWidth={1.75} /> Saved commands
            <span className="more">{snippets.length}</span>
            <button
              className="blk-add"
              title="Add a saved command"
              onClick={() => openSnippets({ newForHost: hostId })}
            >
              <Plus size={16} strokeWidth={2} /> New
            </button>
          </h3>
          {snippets.length === 0 ? (
            <div className="empty">
              No saved commands for this host yet. Press <b>New</b> to add a one-click command (like{" "}
              <b>restart nginx</b>) — scope it to this server or make it global.
            </div>
          ) : (
            snippets.map((s) => (
              <div className="li snip lit" key={s.id}>
                <button
                  className="snip-go"
                  title="Run in a new terminal"
                  onClick={() => openTerminal(hostId, title, s.command)}
                >
                  <span className="snip-run">
                    <Zap size={16} strokeWidth={2} />
                  </span>
                  <div className="min0">
                    <div className="nm">{s.label}</div>
                    <div className="ip mono">
                      <span className="c">{s.command.trim().split(/\s+/)[0]}</span>
                      {s.command.trim().slice(s.command.trim().split(/\s+/)[0].length)}
                    </div>
                  </div>
                </button>
                <span className="tag">{s.host_id ? "host" : "global"}</span>
                <div className="snip-tools">
                  <button className="snm-ic" title="Edit" onClick={() => openSnippets({ editId: s.id })}>
                    <Pencil size={16} strokeWidth={1.75} />
                  </button>
                  <button
                    className="snm-ic"
                    title="Remove"
                    onClick={() => void removeSnippet(s.id)}
                  >
                    <Trash2 size={16} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
