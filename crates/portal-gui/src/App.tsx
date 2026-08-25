import { useCallback, useEffect, useState } from "react";
import { PortalProvider, usePortal } from "./context";
import { TopBar } from "./components/TopBar";
import { IconBar } from "./components/IconBar";
import { StatusBar } from "./components/StatusBar";
import { LoadingScreen } from "./components/LoadingScreen";
import { Onboarding } from "./components/Onboarding";
import { UnlockScreen } from "./components/UnlockScreen";
import { ContextMenu } from "./components/ContextMenu";
import { CommandPalette } from "./components/CommandPalette";
import { AuthDialog } from "./components/AuthDialog";
import { Settings } from "./components/Settings";
import { SnippetsManager } from "./components/SnippetsManager";
import { About } from "./components/About";
import { DockLayout } from "./dock/DockLayout";
import { resetLayout, toggleSidebar } from "./dock/dock";

// loading → reveal (loading solar + app belirir, çapraz geçiş) → done (loading kalkar)
type Phase = "loading" | "reveal" | "done";

function Shell() {
  const { ready, onboarded, locked } = usePortal();
  const [phase, setPhase] = useState<Phase>("loading");

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
