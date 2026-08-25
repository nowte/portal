// Uptime durum simgesi — up / down / henüz bilinmiyor.
//
// Neden nokta değil de simge: nokta yalnız RENKLE konuşuyordu (§9 noktanın
// yanına bir halka koyuyor ama biçim aynı kalıyor). Burada biçim de değişiyor —
// tik / ünlem / kesikli daire — yani ekran siyah-beyaz basılsa bile durum
// okunur. Renk hâlâ var, ama tek taşıyıcı değil.

import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import type { MonitorState } from "../lib/types";

export function StateIcon({
  state,
  enabled = true,
  size = 16,
}: {
  state: MonitorState;
  enabled?: boolean;
  size?: 16 | 20;
}) {
  if (!enabled) {
    return (
      <CircleDashed className="st-i st-off" size={size} strokeWidth={1.75} aria-label="Paused" />
    );
  }
  if (state === "up") {
    return <CircleCheck className="st-i st-up" size={size} strokeWidth={1.75} aria-label="Up" />;
  }
  if (state === "down") {
    return <CircleAlert className="st-i st-down" size={size} strokeWidth={1.75} aria-label="Down" />;
  }
  return (
    <CircleDashed className="st-i st-off" size={size} strokeWidth={1.75} aria-label="Not checked yet" />
  );
}
