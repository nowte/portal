import { type ComponentProps, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { bindApi, captureSideWidths, DND_STRATEGY, openGateway, persist, restoreOrBuild } from "./dock";
import { usePortal } from "../context";
import { hostIsCached } from "../lib/ipc";
import type { Host } from "../lib/types";
import { HostsPanel } from "../panels/HostsPanel";
import { HomePanel } from "../panels/HomePanel";
import { GuidePanel } from "../panels/GuidePanel";
import { UptimePanel } from "../panels/UptimePanel";
import { MonitorPage } from "../panels/MonitorPage";
import { ServerWorkspace } from "./ServerWorkspace";
import { EditorPanel } from "../panels/EditorPanel";
import { TabClose } from "../components/TabClose";

// DIŞ dock: sabit paneller (Home/Hosts/Guide) + her sunucu için TEK "server" sayfası.
// Gateway/Terminal/Files/Monitor o sayfanın İÇİNDE (ServerWorkspace) yaşar.
const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  hosts: () => <HostsPanel />,
  home: () => <HomePanel />,
  guide: () => <GuidePanel />,
  uptime: () => <UptimePanel />,
  monitorpage: (p: IDockviewPanelProps) => <MonitorPage monitorId={p.params.monitorId as string} />,
  server: (p: IDockviewPanelProps) => <ServerWorkspace hostId={p.params.hostId as string} />,
  // Yüzen editör DIŞ dock'ta yaşar (iç dock `overflow:hidden` ile kırpılıyor).
  editor: (p: IDockviewPanelProps) => (
    <EditorPanel
      hostId={p.params.hostId as string}
      sessionId={p.params.sessionId as number}
      path={p.params.path as string}
      floating
    />
  ),
};

// Sabit paneller (Home/Hosts/Guide) için kapatma (×) düğmesi OLMAYAN "plain" sekme.
// Sunucu sayfaları "srvtab": user@ip başlığı + × (sayfayı ve içindeki tüm oturumları kapatır).
const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  plain: (p: IDockviewPanelHeaderProps) => (
    <div className="dv-default-tab">
      <span className="dv-default-tab-content">{p.api.title}</span>
    </div>
  ),
  // Belge sekmesi: başlık + kapatma. Monitör sayfaları bunu kullanır; dockview'ün
  // kendi varsayılan sekmesi farklı boyutta bir kapatma işareti çiziyordu.
  doctab: (p: IDockviewPanelHeaderProps) => (
    <div className="dv-srv-tab" title={p.api.title}>
      <span className="dv-srv-tab-t">{p.api.title}</span>
      <TabClose title="Close" onClose={() => p.api.close()} />
    </div>
  ),
  srvtab: (p: IDockviewPanelHeaderProps) => (
    <div className="dv-srv-tab" title={p.api.title}>
      <span className="dv-srv-tab-t">{p.api.title}</span>
      <TabClose title="Close server (closes its sessions)" onClose={() => p.api.close()} />
    </div>
  ),
};

function hostTitle(h: Host): string {
  return h.username ? `${h.username}@${h.address}` : h.address;
}

export function DockLayout() {
  const { hosts } = usePortal();
  // "Keep connected" AÇILIŞTA da çalışsın: bugüne kadar yalnız sunucu SAYFASI
  // açılınca tetikleniyordu, yani uygulamayı açan kişi hâlâ elle tıklamak
  // zorundaydı (kullanıcı bulgusu).
  //
  // ⚠️ Ama kimliği OLMAYAN host'u açılışta bağlamaya kalkma: her biri parola
  // diyaloğu açar, AuthDialog eşzamanlı ikinci isteği reddeder ve geri kalanı
  // sessizce başarısız olur. Yalnız kimliği hazır olanlar (bellek önbelleği ya
  // da vault'ta saklanmış sır) otomatik bağlanır; diğerlerinin sayfası açılmaz.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || hosts.length === 0) return;
    started.current = true;
    void (async () => {
      for (const h of hosts.filter((x) => x.auto_connect)) {
        if (await hostIsCached(h.id).catch(() => false)) {
          openGateway(h.id, hostTitle(h));
        }
      }
    })();
  }, [hosts]);

  const onReady = (event: DockviewReadyEvent) => {
    bindApi(event.api);
    restoreOrBuild();
    event.api.onDidLayoutChange(() => {
      captureSideWidths();
      persist();
    });
  };

  // TİPLİ proplar — cast YOK. (Yanlış yazılan bir prop `as unknown as` ile sessizce
  // yutulur; bu tam olarak `dndStrategy`'de başımıza geldi.)
  const dockProps: ComponentProps<typeof DockviewReact> = {
    // Tauri/WebView2'de HTML5 DnD güvenilmez → pointer tabanlı sürükleme (bkz. dock.ts).
    dndStrategy: DND_STRATEGY,
    components,
    tabComponents,
    onReady,
  };

  // proportionalLayout: false → container büyüyünce yanlar sabit kalır, merkez büyür.
  // Runtime seçeneği; public tipte YOK, bu yüzden yalnız O cast'leniyor.
  const runtimeOnly = { proportionalLayout: false } as unknown as Partial<
    ComponentProps<typeof DockviewReact>
  >;

  // Tema class'ı + --dv override'ları wrapper'da (bkz. styles.css .dockhost).
  return (
    <div className="dockhost dockview-theme-abyss">
      <DockviewReact {...dockProps} {...runtimeOnly} />
    </div>
  );
}
