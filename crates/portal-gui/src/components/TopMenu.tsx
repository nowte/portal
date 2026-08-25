import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { openGuide, resetLayout, toggleGuide, toggleSidebar } from "../dock/dock";
import { openAbout } from "./About";

// ≡ menü: View / Help dropdown'ı. Dışarı tıkla / Esc kapatır.
export function TopMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <div className="dd-wrap" ref={ref}>
      <button
        className={"tb-btn" + (open ? " on" : "")}
        title="Menu"
        aria-label="Menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Menu size={16} strokeWidth={1.75} />
      </button>
      {open && (
        <div className="menu-dd" role="menu">
          <div className="dd-label">View</div>
          <button className="dd-item" onClick={() => run(toggleSidebar)}>
            Toggle sidebar <span className="sc">Ctrl B</span>
          </button>
          <button className="dd-item" onClick={() => run(resetLayout)}>
            Reset layout <span className="sc">Ctrl K</span>
          </button>
          <button className="dd-item" onClick={() => run(toggleGuide)}>
            Toggle Guide
          </button>
          <div className="dd-sep" />
          <div className="dd-label">Help</div>
          {/* Documentation = Guide raili: ürünün öğretme katmanı burada yaşıyor
              (portal-core::teaching). Ayrı bir "docs sitesi" yok, olduğunu ima
              etmek de yanlış olurdu. */}
          <button className="dd-item" onClick={() => run(openGuide)}>
            Documentation
          </button>
          <button className="dd-item" onClick={() => run(() => openAbout("about"))}>
            About Portal
          </button>
        </div>
      )}
    </div>
  );
}
