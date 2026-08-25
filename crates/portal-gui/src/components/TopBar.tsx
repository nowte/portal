import { BookOpen, ChevronDown, LifeBuoy, PanelLeft, Search } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePortal } from "../context";
import { openGuide, toggleSidebar } from "../dock/dock";
import { TopMenu } from "./TopMenu";
import { ServerSearch } from "./ServerSearch";
import { openCommandPalette } from "./CommandPalette";
import { openSettings } from "./Settings";
import { openAbout } from "./About";
import { APP_VERSION } from "../lib/version";

// Native titlebar kapalı (decorations:false). Sürükleme yalnız butonsuz alanlarda
// (brand / workspace / spacer) → data-tauri-drag-region; butonlar hep tıklanır.
//
// getCurrentWindow() modül kapsamında çağrılırsa Tauri DIŞINDA (vite tarayıcı
// önizlemesi) import anında patlar ve TÜM uygulama render edilmez. Tıklama anına
// ertelendi: Tauri'de davranış aynı, tarayıcıda kabuk yine de çizilir.
const win = () => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
};

// Pencere kontrollerinin glifleri lucide'dan GELMEZ. Sebep ölçü: lucide'ın
// üç ikonu aynı 16px kutuda çok farklı büyüklükte çiziliyor — `Minus` 9.3px
// genişliğinde bir çizgi, `X` 8×8, `Square` ise 12×12. Yan yana konunca
// maximize diğer ikisinin yarı yarıya üstünde duruyordu.
//
// Bunlar zaten ikon değil, PENCERE ÇERÇEVESİ glifleri (DESIGN §23.12: pencere
// kontrolleri platformun dilindedir). Windows'ta üçü de aynı 10×10 kutuda,
// 1px hairline çizilir; burada da öyle — üçü tek metrikten doğuyor.
const GLYPH = { viewBox: "0 0 10 10", width: 10, height: 10, fill: "none",
  stroke: "currentColor", strokeWidth: 1, shapeRendering: "crispEdges" } as const;

export function TopBar() {
  const { boot } = usePortal();
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        {/* Gerçek marka varlığı, CSS mask olarak (§24.2). Elle çizilmiş SVG
            kopyası YOK — o kopya iki ayrı plaka çiziyordu, mark ise tek parça. */}
        <span className="mark tb-mark" role="img" aria-label="Portal" />
      </div>

      <div className="tb-tools">
        <TopMenu />
        <button
          className="tb-btn"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          onClick={() => toggleSidebar()}
        >
          <PanelLeft size={16} strokeWidth={1.75} />
        </button>
        <ServerSearch />
      </div>

      <button className="tb-ws" title="Profile & workspace" onClick={() => openSettings("profiles")}>
        {boot?.profile ? (
          <>
            <b>{boot.profile}</b>
            <span className="tb-lbl">· workspace</span>
          </>
        ) : (
          <span className="tb-lbl">local · no account</span>
        )}
        <ChevronDown size={16} strokeWidth={1.75} />
      </button>
      <span className="tb-ver" data-tauri-drag-region>
        {APP_VERSION}
      </span>

      <div className="tb-spacer" data-tauri-drag-region />

      <button className="palette-btn" title="Command palette" onClick={openCommandPalette}>
        <Search size={16} strokeWidth={1.75} />
        <span className="ph">Search or run a command…</span>
        <span className="kbd">
          <b>⇧⇧</b>
        </span>
      </button>

      <div className="tb-spacer" data-tauri-drag-region />

      <div className="tb-right">
        {/* Docs → Guide raili (ürünün öğretme katmanı, gerçek dokümantasyon
            yüzeyi). Support → yerel teşhis + hata bildirme adresi. İkisi de
            artık gerçekten bir yere gidiyor; ölü kontrol kalmadı. */}
        <button className="tb-btn" title="Open the Guide rail" onClick={() => openGuide()}>
          <BookOpen size={16} strokeWidth={1.75} />
          <span className="tb-lbl">Docs</span>
        </button>
        <button className="tb-btn" title="Diagnostics & reporting a bug" onClick={() => openAbout("support")}>
          <LifeBuoy size={16} strokeWidth={1.75} />
          <span className="tb-lbl">Support</span>
        </button>

        {/* Tema seçimi yalnız Ayarlar > Appearance'ta. Üst şeritte ikinci bir
            seçici tutmak aynı kararı iki yere dağıtıyordu. */}

        {/* Pencere kontrolleri — Windows konvansiyonu: geniş dikdörtgen hedef,
            ikon, close hover'da --red. Basış scale'i YOK: pencere kenarındaki
            kontrolün küçülmesi hatalı görünür. */}
        <div className="wctrls">
          <button className="wc" title="Minimize" aria-label="Minimize" onClick={() => win()?.minimize()}>
            <svg {...GLYPH}>
              <path d="M0 5h10" />
            </svg>
          </button>
          <button
            className="wc"
            title="Maximize"
            aria-label="Maximize"
            onClick={() => win()?.toggleMaximize()}
          >
            <svg {...GLYPH}>
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          </button>
          <button className="wc wc-close" title="Close" aria-label="Close" onClick={() => win()?.close()}>
            <svg {...GLYPH}>
              <path d="M0 0l10 10M10 0L0 10" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
