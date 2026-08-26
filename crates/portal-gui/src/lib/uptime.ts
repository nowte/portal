// Uptime özetlerinin TEK abonelik noktası: panel, Home ve StatusBar aynı veriyi
// buradan okur. Üç yerde ayrı fetch + listen kurulsaydı üçü farklı anlarda
// tazelenir ve "Home 2 down derken panel 1 down" görünürdü.

import { useCallback, useEffect, useState } from "react";
import { listMonitors, onMonitorsChanged, onUptime } from "./ipc";
import type { MonitorSummary } from "./types";

/** Monitör özetleri + kontrol/liste olaylarında otomatik tazeleme. */
export function useMonitors(): { monitors: MonitorSummary[]; refresh: () => void } {
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);

  const refresh = useCallback(() => {
    void listMonitors()
      .then(setMonitors)
      .catch(() => setMonitors([]));
  }, []);

  useEffect(() => {
    refresh();
    const off = [onUptime(refresh), onMonitorsChanged(refresh)];
    return () => {
      for (const p of off) void p.then((f) => f());
    };
  }, [refresh]);

  return { monitors, refresh };
}

/** Kesintide olan monitörler (Home uyarısı + StatusBar sayacı). */
export function downMonitors(monitors: MonitorSummary[]): MonitorSummary[] {
  return monitors.filter((m) => m.monitor.enabled && m.state === "down");
}

/** Hedefin tek satırlık gösterimi (form dışında her yerde). */
export function targetText(m: MonitorSummary): string {
  const t = m.monitor.target;
  return t.kind === "http" ? t.url : `${t.host}:${t.port}`;
}

/** Sertifikası uyarı eşiğini geçen monitörler (eşik ÇEKİRDEKTE hesaplanır). */
export function certWarnings(monitors: MonitorSummary[]): MonitorSummary[] {
  return monitors.filter((m) => m.monitor.enabled && m.certAlert !== null);
}

/** Sertifikanın kalan ömrü — tek cümle, her yüzeyde aynı. */
export function certText(days: number): string {
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  if (days < 0) return `expired ${n} ${unit} ago`;
  if (days === 0) return "expires today";
  return `expires in ${n} ${unit}`;
}

/** Uptime yüzdesi — kontrol yoksa çizgi (0% yazmak yanıltıcı olurdu). */
export function pctText(up: number, down: number): string {
  const total = up + down;
  if (total === 0) return "—";
  return `${((up / total) * 100).toFixed(total < 100 ? 1 : 2)}%`;
}

/** Gün numarasını (unix/86400) sabit biçimde yazar — makine diline dönmesin. */
export function dayText(day: number): string {
  const d = new Date(day * 86_400_000);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getUTCMonth()];
  return `${month} ${d.getUTCDate()}`;
}

/** Kontrol anını "2m ago" gibi yazar (mutlak saat locale'e bağımlı olurdu). */
export function agoText(at: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}
