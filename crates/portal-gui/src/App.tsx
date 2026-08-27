import { useCallback, useEffect, useState } from "react";
import { PortalProvider, usePortal } from "./context";
import { TopBar } from "./components/TopBar";
import { IconBar } from "./components/IconBar";
import { StatusBar } from "./components/StatusBar";
import { Notices } from "./components/Notices";
import { LoadingScreen } from "./components/LoadingScreen";
import { Onboarding } from "./components/Onboarding";
import { UnlockScreen } from "./components/UnlockScreen";
import { ContextMenu } from "./components/ContextMenu";
import { CommandPalette } from "./components/CommandPalette";
import { AuthDialog } from "./components/AuthDialog";
import { Settings } from "./components/Settings";
import { SnippetsManager } from "./components/SnippetsManager";
import { About } from "./components/About";
import { openServerSearch } from "./components/ServerSearch";
import { DockLayout } from "./dock/DockLayout";
import { resetLayout, toggleSidebar } from "./dock/dock";
import { checkOnLaunch } from "./lib/update";

// loading → reveal (loading solar + app belirir, çapraz geçiş) → done (loading kalkar)
type Phase = "loading" | "reveal" | "done";

function Shell() {
  const { ready, onboarded, locked, boot } = usePortal();
  const [phase, setPhase] = useState<Phase>("loading");

  // Güncelleme kontrolü YALNIZ kilit açıldıktan sonra: onboarding/kilit ekranı
  // ağa çıkmaz. Oturumda bir kez (checkOnLaunch kendi bayrağını tutar).
  useEffect(() => {
    if (ready && onboarded && !locked) checkOnLaunch(boot?.check_updates ?? false);
  }, [ready, onboarded, locked, boot?.check_updates]);

  const startReveal = useCallback(() => setPhase("reveal"), []);

  useEffect(() => {
    if (phase !== "reveal") return;
    // Loading çıkışı (--dur-exit 140ms) bitince ekranı unmount et. Uygulama
    // girişi (280ms) onun üstünde çakışır → çapraz geçiş, boş kare yok.
    const t = setTimeout(() => setPhase("done"), 160);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        resetLayout();
      } else if (k === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (k === "f") {
        // Ctrl+F HER ZAMAN yutulur: yutulmazsa WebView2 kendi (Edge'in) sayfa-içi
        // arama çubuğunu açar ve Portal'ın içinde bir tarayıcı kutusu belirir.
        // Tauri v2 wry'ın `with_browser_accelerator_keys` ayarını dışarı vermiyor,
        // yani bunu kapatmanın tek yolu tuşu burada tüketmek.
        e.preventDefault();
        // Terminal kendi aramasını kendisi açar (TerminalPanel, xterm kancası) —
        // olay oradan da buraya kabarır, iki arama birden açılmasın.
        if ((e.target as HTMLElement | null)?.closest?.(".term-wrap")) return;
        // Modal açıkken arkasındaki popover'ı açmak anlamsız; tuş yine de yutuldu.
        if (document.querySelector(".overlay")) return;
        openServerSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Gate: yükleme bitince onboarding / kilit / uygulama arasında seç.
  const showApp = !ready || (onboarded && !locked);

  return (
    <>
      {phase !== "done" && <LoadingScreen onDone={startReveal} fading={phase === "reveal"} />}

      {ready && !onboarded && <Onboarding />}
      {ready && onboarded && locked && <UnlockScreen />}

      {showApp && (
        <div className={"app" + (phase === "loading" ? " app-hidden" : " app-enter")}>
          <TopBar />
          <div className="body">
            <IconBar />
            <DockLayout />
            <Notices />
          </div>
          <StatusBar />
        </div>
      )}

      <ContextMenu />
      <CommandPalette />
      <AuthDialog />
      <Settings />
      <SnippetsManager />
      <About />
    </>
  );
}

export default function App() {
  return (
    <PortalProvider>
      <Shell />
    </PortalProvider>
  );
}
