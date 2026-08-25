// Bir sunucu sayfasının İÇİ: iç içe (nested) dockview. Gateway + Terminal + Files +
// Monitor pane olarak burada durur; kullanıcı bu bölümde istediği gibi sola/sağa taşır.
// Açılış istekleri dock.ts'ten yönlenir (registerServerDock ile iç api paylaşılır).
//
// Sürükle-bırak burada çalışır. Bozan şey bir dönem bizim CSS'imizdi: sunucu sayfası
// `renderer:"always"` olduğu için bu iç dock, dış dock'un `.dv-render-overlay`
// katmanının İÇİNDE yaşıyor; o katmana `pointer-events:none` verilince iç dock'un tüm
// drop hedefleri isabet testinden düşüyordu. Bkz. styles.css'teki uyarı.

import { TabClose } from "../components/TabClose";
import { type ComponentProps, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  DND_STRATEGY,
  loadServerLayout,
  openTerminal,
  persistServerLayout,
  registerServerDock,
  unregisterServerDock,
} from "./dock";
import { usePortal } from "../context";
import type { Host } from "../lib/types";
import { GatewayPanel } from "../panels/GatewayPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { MonitorPanel } from "../panels/MonitorPanel";
import { EditorPanel } from "../panels/EditorPanel";

// `restored`: düzen DİSKTEN geri yüklendiğinde true. Oturum pane'leri o zaman
// kendiliğinden bağlanmaz (açılışta parola diyaloğu yağmasın) — bkz. deferConnect.
const nestedComponents: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  gateway: (p: IDockviewPanelProps) => (
    <GatewayPanel hostId={p.params.hostId as string} restored={p.params.restored === true} />
  ),
  terminal: (p: IDockviewPanelProps) => (
    <TerminalPanel
      hostId={p.params.hostId as string}
      command={p.params.command as string | undefined}
      deferConnect={p.params.restored === true}
    />
  ),
  files: (p: IDockviewPanelProps) => (
    <FilesPanel hostId={p.params.hostId as string} deferConnect={p.params.restored === true} />
  ),
  monitor: (p: IDockviewPanelProps) => (
    <MonitorPanel hostId={p.params.hostId as string} deferConnect={p.params.restored === true} />
  ),
  editor: (p: IDockviewPanelProps) => (
    <EditorPanel
      hostId={p.params.hostId as string}
      sessionId={p.params.sessionId as number}
      path={p.params.path as string}
    />
  ),
};

// Pane sekmeleri: sade başlık + kapatma (×). "panefixed" = kapatılamaz (gateway).
const nestedTabs: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  pane: (p: IDockviewPanelHeaderProps) => (
    <div className="dv-pane-tab" title={p.api.title}>
      <span className="dv-pane-tab-t">{p.api.title}</span>
      <TabClose title="Close" onClose={() => p.api.close()} />
    </div>
  ),
  panefixed: (p: IDockviewPanelHeaderProps) => (
    <div className="dv-pane-tab dv-pane-tab-fixed" title={p.api.title}>
      <span className="dv-pane-tab-t">{p.api.title}</span>
    </div>
  ),
};

function hostTitle(h: Host): string {
  return h.username ? `${h.username}@${h.address}` : h.address;
}

export function ServerWorkspace({ hostId }: { hostId: string }) {
  const { hosts } = usePortal();
  const host = hosts.find((h) => h.id === hostId);
  // onReady bir kez çalışır; güncel host'a ref ile eriş (stale closure'dan kaçın).
  const hostRef = useRef(host);
  hostRef.current = host;

  const addGateway = (dock: DockviewApi) => {
    // İlk pane: Gateway (karşılama + Connect/Files/Monitor); KAPATILAMAZ (panefixed).
    dock.addPanel({
      id: `gw:${hostId}`,
      component: "gateway",
      title: "Gateway",
      params: { hostId },
      tabComponent: "panefixed",
      renderer: "always",
    });
  };

  const onReady = (e: DockviewReadyEvent) => {
    const saved = loadServerLayout(hostId);
    let restored = false;
    if (saved) {
      try {
        // Klonla: liveLayouts'taki nesneyi ne biz değiştirelim ne de dockview bozsun.
        const json = structuredClone(saved.json) as {
          panels?: Record<string, { params?: Record<string, unknown> }>;
        };
        // Soğuk geri yükleme (diskten): pane'leri `restored` ile işaretle → mount
        // olunca KENDİLİĞİNDEN BAĞLANMAZ, "Connect" düğmesiyle bekler. Aynı çalışma
        // içindeyse işaret konmaz; kimlik önbelleği dolu, sessizce yeniden bağlanır.
        if (saved.cold && json.panels) {
          for (const p of Object.values(json.panels)) {
            if (p.params) p.params.restored = true;
          }
        }
        e.api.fromJSON(json as never);
        restored = e.api.panels.length > 0;
      } catch {
        // Bozuk/uyumsuz kayıt → varsayılan düzene düş (kullanıcı kilitlenmesin).
        restored = false;
      }
    }
    if (!restored) {
      e.api.clear();
      addGateway(e.api);
    } else if (!e.api.getPanel(`gw:${hostId}`)) {
      // Gateway kapatılamaz olmalı; kayıtta yoksa geri koy.
      addGateway(e.api);
    }

    registerServerDock(hostId, e.api);
    // Her düzen değişikliğinde (sürükleme dahil) yerleşimi hatırla.
    e.api.onDidLayoutChange(() => persistServerLayout(hostId, e.api.toJSON()));

    // "Sürekli bağlı tut": sayfa açılınca otomatik bir shell aç (Gateway'in yanında).
    // Geri yüklenen düzende zaten terminal varsa ikincisini açma.
    const h = hostRef.current;
    if (h?.auto_connect && !e.api.panels.some((p) => p.id.startsWith("term:"))) {
      openTerminal(hostId, hostTitle(h));
    }
  };

  useEffect(() => () => unregisterServerDock(hostId), [hostId]);

  // Tipli proplar — cast yok (yanlış yazılan prop sessizce yutulmasın).
  const dockProps: ComponentProps<typeof DockviewReact> = {
    // Tauri/WebView2'de HTML5 DnD güvenilmez → pointer tabanlı sürükleme (bkz. dock.ts).
    dndStrategy: DND_STRATEGY,
    components: nestedComponents,
    tabComponents: nestedTabs,
    onReady,
  };
  // Public tipte olmayan tek runtime seçeneği ayrı geçirilir.
  const runtimeOnly = { proportionalLayout: false } as unknown as Partial<
    ComponentProps<typeof DockviewReact>
  >;

  return (
    <div className="srv-dock dockview-theme-abyss">
      <DockviewReact {...dockProps} {...runtimeOnly} />
    </div>
  );
}
