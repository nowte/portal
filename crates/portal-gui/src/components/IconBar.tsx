import { useEffect, useState } from "react";
import { Activity, Code, Home, Server, Settings, User, type LucideIcon } from "lucide-react";
import { closeSidebar, frontSide, openHome, subscribeSide, toggleSide } from "../dock/dock";
import { openSettings } from "./Settings";
import { openSnippets } from "./SnippetsManager";

interface NavItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  badge?: number;
}

// v1.0 lean çekirdek: yalnız gerçekten bir yere giden öğeler. Tunnels/Keys/Docker/
// Terminals/Files (global nav) v1.1'e ertelendi — ölü ikon bırakılmaz.
const TOP: NavItem[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "hosts", label: "Hosts", Icon: Server },
  { id: "snippets", label: "Snippets", Icon: Code },
  { id: "uptime", label: "Uptime", Icon: Activity },
];

const BOTTOM: NavItem[] = [
  { id: "profile", label: "Profile", Icon: User },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function IconBar() {
  // Aktif işaret TAHMİN EDİLMEZ, dock'tan okunur: Hosts açıkken Uptime sekmesi
  // öne gelince Hosts simgesi basılı kalıyordu.
  const [active, setActive] = useState<string>(() => frontSide() ?? "home");

  useEffect(() => subscribeSide(() => setActive(frontSide() ?? "home")), []);

  const click = (it: NavItem) => {
    // Home: sol yuvayı tamamen kapat (tam genişlik home görünümü).
    if (it.id === "home") {
      openHome();
      closeSidebar();
      setActive("home");
      return;
    }
    // Araç panelleri TEK yuvada yaşar: aynı simgeye tekrar basmak kapatır,
    // öbürüne basmak yerine geçirir. Aktif işaret gerçekten açık olanı gösterir.
    if (it.id === "hosts" || it.id === "uptime") {
      toggleSide(it.id); // aktif işaret aboneliğinden gelir
      return;
    }
    setActive(it.id);
    if (it.id === "snippets") openSnippets();
    else if (it.id === "settings") openSettings("appearance");
    else if (it.id === "profile") openSettings("profiles");
  };

  const render = (it: NavItem) => {
    const Icon = it.Icon;
    return (
      <button
        key={it.id}
        className="ico"
        title={it.label}
        aria-label={it.label}
        aria-current={active === it.id ? "page" : undefined}
        onClick={() => click(it)}
      >
        <Icon size={20} strokeWidth={1.75} />
        {it.badge ? <span className="badge">{it.badge}</span> : null}
      </button>
    );
  };

  return (
    <nav className="iconbar" aria-label="Sections">
      {TOP.map(render)}
      <div className="ib-sp" />
      {BOTTOM.map(render)}
    </nav>
  );
}
