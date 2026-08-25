import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { resetLayout, toggleGuide, toggleSidebar } from "../dock/dock";

// Varsayılan WebView sağ-tık menüsünü tamamen değiştirir (kendi monokrom menümüz).
interface Pos {
  x: number;
  y: number;
}

export function ContextMenu() {
  const [pos, setPos] = useState<Pos | null>(null);

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
    };
    // Panel menüleri (host satırı, uzak dosya) kendi `contextmenu` olaylarını
    // `stopPropagation` ile keser → `onCtx` (kabarma) onlarda hiç çalışmaz, yani
    // bu menü panel menüsüyle birlikte AÇILMAZ. Ama zaten açıksa da kapanmıyordu →
    // ekranda iki menü. Bu yüzden kapatma YAKALAMA fazında dinlenir: her sağ tıkta
    // önce kapanır, boş alana tıklandıysa `onCtx` aynı olayda yeniden açar.
    const close = () => setPos(null);
    window.addEventListener("contextmenu", close, true);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onEsc);
    };
  }, []);

  if (!pos) return null;

  const run = (fn: () => void) => {
    fn();
    setPos(null);
  };

  // Menüyü ekran içinde tut.
  const style: CSSProperties = {
    left: Math.min(pos.x, window.innerWidth - 214),
    top: Math.min(pos.y, window.innerHeight - 170),
  };

  // ⚠️ `document.body`'ye portal: `position: fixed` bir üst elemanda transform /
  // filter / contain / container-type varsa ONA göre konumlanır — menü tıklanan
  // yerden uzakta çıkıyordu. Portal ata zincirini tamamen atlar ve menü her
  // şeyin üstünde kalır (kullanıcı bulgusu).
  return createPortal(
    <div className="ctx" style={style}>
      <button className="ctx-item" onClick={() => run(toggleSidebar)}>
        Toggle sidebar <span className="sc">Ctrl B</span>
      </button>
      <button className="ctx-item" onClick={() => run(toggleGuide)}>
        Toggle Guide
      </button>
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={() => run(resetLayout)}>
        Reset layout <span className="sc">Ctrl K</span>
      </button>
      <button className="ctx-item" onClick={() => run(() => window.location.reload())}>
        Reload
      </button>
    </div>,
    document.body,
  );
}
