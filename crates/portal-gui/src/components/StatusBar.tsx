// Durum çubuğu (mockup 01-global-shell): solda düzen ipucu + kısayol, sağda
// mono teknik segmentler ve seçili host'un canlı bağlantı durumu.

import { GripVertical } from "lucide-react";
import { StateIcon } from "./StateIcon";
import { usePortal } from "../context";
import { resetLayout, showSide } from "../dock/dock";
import { downMonitors, useMonitors } from "../lib/uptime";

export function StatusBar() {
  const { selectedHost, hosts, hostState } = usePortal();
  const { monitors } = useMonitors();
  const host = hosts.find((h) => h.id === selectedHost);
  const st = host ? hostState(host.id) : "offline";
  const down = downMonitors(monitors);

  return (
    <footer className="statusbar">
      {/* Kalıcı kabukta onboarding ipucu — GK1 gereği silinmedi, kademesi düştü. */}
      <span className="hint">
        <GripVertical size={16} strokeWidth={1.75} />
        Panels are draggable &amp; resizable — drag a tab to dock
      </span>
      <span className="sb-div">·</span>
      <button onClick={resetLayout}>
        <span className="kbd-i">Ctrl</span>
        <span className="kbd-i">K</span>
        reset layout
      </button>

      <span className="sp" />

      {/* Kesinti varsa göster, yoksa hiç render etme (sıfırlı sayaç gürültüdür). */}
      {down.length > 0 && (
        <>
          <button onClick={() => showSide("uptime")} title="Open Uptime">
            {/* Düşen monitörün simgesi TEK yerden gelir (StateIcon): burada
                ayrı bir kırmızı nokta duruyordu, aynı olayın dördüncü gösterimi
                oluyordu ve biçim taşımıyordu — yalnız renk. */}
            <StateIcon state="down" />
            <span className="sb-mono">
              {down.length} down
            </span>
          </button>
          <span className="sb-div">·</span>
        </>
      )}

      <span className="sb-mono sb-tech">UTF-8</span>
      <span className="sb-div sb-tech">·</span>
      <span className="sb-mono sb-tech">xterm-256color</span>
      <span className="sb-div sb-tech">·</span>
      {host ? (
        <span className="sb-seg">
          <span
            className={
              "dot " + (st === "connected" ? "on" : st === "connecting" ? "connecting" : "off")
            }
          />
          <span className="sb-mono">
            {host.label.trim() || host.address} · SSH · {host.address}
          </span>
        </span>
      ) : (
        <span className="sb-mono">
          {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </span>
      )}
    </footer>
  );
}
