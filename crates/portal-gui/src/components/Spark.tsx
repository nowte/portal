// Küçük uPlot sparkline (monokrom): canlı metrik geçmişi. Sabit yükseklik, genişlik
// container'a göre (ResizeObserver). Renk yok — tek çizgi + hafif alan dolgusu.
//
// Çizgi rengi TEMADAN okunur (--text). Sabit #ededed olsaydı Paper temasında
// beyaz zemine beyaz çizgi düşerdi.

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

/** Kök öğeden bir CSS değişkenini oku (uPlot canvas'a çizer, CSS var kullanamaz). */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Aktif tema adını izle — değişince sparkline yeniden kurulur. */
function useThemeName(): string {
  const [name, setName] = useState(() => document.documentElement.getAttribute("data-theme") ?? "black");
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setName(document.documentElement.getAttribute("data-theme") ?? "black"),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return name;
}

export function Spark({ data, max = 100 }: { data: number[]; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const theme = useThemeName();

  useEffect(() => {
    if (!ref.current) return;
    const stroke = cssVar("--text", "#ededed");
    const opts: uPlot.Options = {
      width: ref.current.clientWidth || 220,
      height: 46,
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: [0, max] } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke,
          width: 1.5,
          // Dolgu aynı renkten türetilir; color-mix canvas'ta çalışmadığı için
          // düşük alfalı bir katman olarak veriyoruz.
          fill: `color-mix(in srgb, ${stroke} 8%, transparent)`,
          points: { show: false },
        },
      ],
    };
    const xs = data.map((_, i) => i);
    const u = new uPlot(opts, [xs, data] as uPlot.AlignedData, ref.current);
    plotRef.current = u;
    const ro = new ResizeObserver(() => {
      if (ref.current) u.setSize({ width: ref.current.clientWidth, height: 46 });
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
    // yalnız ölçek/tema değişince yeniden kur; veri ayrı effect'te güncellenir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [max, theme]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    const xs = data.map((_, i) => i);
    u.setData([xs, data] as uPlot.AlignedData);
  }, [data]);

  return <div ref={ref} className="spark" />;
}
