import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { usePortal } from "../context";
import markSrc from "../assets/portal-mark-black.png";
import { APP_VERSION } from "../lib/version";

// Açılış yükleme ekranı.
//
// Gösterge = markın KENDİSİ: mark iki dilimli bir geçit, içinden yavaş bir ışık
// bandı geçer (styles.css → .loading-mark). Ayrı çubuk/spinner YOK.
//
// Dürüstlük kuralı (F22): sahte adım yok. Eskiden 4 adım 150ms'de bir ilerliyordu
// ve bunun 3'ü gerçek işe bağlı değildi — kaldırıldı. Ekran tek şeyi bekler:
// core'un gerçekten hazır olması (`ready`).
//
// Zamanlama:
//   0–280ms      hiçbir gösterge yok → hızlı açılışta "yükleniyor" hiç görünmez
//   280ms        ışık bandı + durum metni belirir
//   4000ms       sabır eşiği: açıklama + "show details" (log) belirir
//   ready olunca çıkış (140ms), uygulama girişi (280ms) üstüne biner
const INDICATOR_DELAY = 280;
const PATIENCE_AFTER = 4000;
// Titreme kalkanı: core 60ms'de hazırsa ekranı bir kare gösterip söndürmek
// açmamaktan kötüdür. Sahte ilerleme değil — yalnızca alt sınır.
const MIN_VISIBLE = 320;

// Mark CSS mask olarak basılır: maske yalnız alpha kanalını kullanır, renk
// --text'ten gelir → dört temada da doğru (DESIGN §24.2, filter/invert yok).
const brandVars = { "--mark-src": `url(${markSrc})` } as React.CSSProperties;

export function LoadingScreen({ onDone, fading }: { onDone: () => void; fading: boolean }) {
  const { ready } = usePortal();
  const [showIndicator, setShowIndicator] = useState(false);
  const [patient, setPatient] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setShowIndicator(true), INDICATOR_DELAY);
    const t2 = setTimeout(() => setPatient(true), PATIENCE_AFTER);
    const t3 = setTimeout(() => setMinElapsed(true), MIN_VISIBLE);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  // Core hazır + alt sınır geçti → çıkış. Yapay bekleme yok.
  useEffect(() => {
    if (ready && minElapsed) onDone();
  }, [ready, minElapsed, onDone]);

  return (
    <div className={"loading" + (fading ? " loading-out" : "")} style={brandVars}>
      <div className="loading-center">
        <div className="loading-mark" aria-hidden="true">
          <span className="rest" />
          <span className="beam" />
        </div>

        <div className="loading-statusrow">
          <span className="loading-status" data-show={showIndicator ? "1" : "0"} role="status">
            Starting…
          </span>
        </div>

        <div className="loading-patience" data-show={patient ? "1" : "0"}>
          <p>Still starting. The first launch after an update takes longer.</p>
          <button
            className="loading-term-toggle lit"
            aria-expanded={logOpen}
            tabIndex={patient ? 0 : -1}
            onClick={() => setLogOpen((o) => !o)}
          >
            {logOpen ? "hide details" : "show details"}
          </button>
          {logOpen && (
            <div className="loading-term">
              <div className="lt">
                <span className="pr">$</span> portal --boot
              </div>
              <div className="lt">
                <Check className="ok" size={16} strokeWidth={1.75} /> window created
              </div>
              <div className="lt">
                <Check className="ok" size={16} strokeWidth={1.75} /> config loaded
              </div>
              <div className="lt">
                <span className="pr">·</span> opening vault…
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="loading-version mono">{APP_VERSION}</div>
    </div>
  );
}
