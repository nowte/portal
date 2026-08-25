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
    // `stopPropagation` ile keser → buraya hiç gelmez, yani ikisi aynı anda
    // açılmaz. Buraya gelen her olay "boş alana sağ tık" demektir.
    const close = () => setPos(null);
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
