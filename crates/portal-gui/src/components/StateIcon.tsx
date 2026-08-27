// Uptime durum simgesi — up / down / henüz bilinmiyor.
//
// Neden nokta değil de simge: nokta yalnız RENKLE konuşuyordu (§9 noktanın
// yanına bir halka koyuyor ama biçim aynı kalıyor). Burada SİLUET de değişiyor:
// daire-tik / ÜÇGEN / kesikli daire — ekran siyah-beyaz basılsa bile durum
// okunur. Renk hâlâ var, ama tek taşıyıcı değil.
//
// Down neden üçgen: önce CircleAlert'tı ve up da CircleCheck olduğu için ikisi
// de DAİREYDİ — 16px'te siluet ayırt etmiyor, geriye yalnız renk kalıyordu,
// yani bu dosyanın kendi iddiası tutmuyordu. Ayrıca Home'un "Attention needed"
// listesi düşen monitör için zaten TriangleAlert çiziyordu (HomePanel), yani
// aynı durumun iki simgesi vardı. Üçgene geçmek ikisini de kapatıyor ve
// CircleAlert'ı tek işine bırakıyor: satır içi hata (ErrorNote).

import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import type { MonitorState } from "../lib/types";

// `label`: aynı üç biçim bağlantı durumu için de kullanılır (dock sekmesi) — orada
// "Up/Down" yanlış sözcük olurdu, "Connected/Couldn't connect" doğrusu.
export function StateIcon({
  state,
  enabled = true,
  size = 16,
  label,
}: {
  state: MonitorState;
  enabled?: boolean;
  size?: 16 | 20;
  label?: string;
}) {
  if (!enabled) {
    return (
      <CircleDashed
        className="st-i st-off"
        size={size}
        strokeWidth={1.75}
        aria-label={label ?? "Paused"}
      />
    );
  }
  if (state === "up") {
    return (
      <CircleCheck
        className="st-i st-up"
        size={size}
        strokeWidth={1.75}
        aria-label={label ?? "Up"}
      />
    );
  }
  if (state === "down") {
    return (
      <TriangleAlert
        className="st-i st-down"
        size={size}
        strokeWidth={1.75}
        aria-label={label ?? "Down"}
      />
    );
  }
  return (
    <CircleDashed
      className="st-i st-off"
      size={size}
      strokeWidth={1.75}
      aria-label={label ?? "Not checked yet"}
    />
  );
}
