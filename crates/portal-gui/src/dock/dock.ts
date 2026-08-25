// dockview düzen motoru köprüsü: TEK kalıcı düzen + reset (DESIGN §12.2).
// api modül-kapsamında tutulur → icon bar / top bar prop-drilling'siz erişir.
//
// İKİ KATMANLI MİMARİ: dış dock (Home + her sunucu için bir "server" sayfası) ve her
// sunucu sayfasının İÇİNDE ikinci bir dockview (ServerWorkspace) — Gateway/Terminal/
// Files/Monitor orada yaşar ve kullanıcı onları içeride sola/sağa taşır.
//
// İç dock'ta sürükle-bırak bir dönem çalışmıyordu; sebebi dockview DEĞİL, bizim
// CSS'imizdi: sunucu sayfası `renderer:"always"` olduğu için iç dock, dış dock'un
// `.dv-render-overlay` katmanının içinde yaşıyor. O katmana `pointer-events:none`
// verilince iç dock'un TÜM drop hedefleri isabet testinden düşüyordu. Kural
// kaldırıldı; ayrıntı styles.css'teki uyarıda. Buraya bir daha eklenmemeli.
//
// SABİT YANLAR: Hosts (sol) ve Guide (sağ) sabit genişlikte kalır; panel açılıp
// kapanınca ya da pencere büyüyünce boşluğu SADECE merkez yutar.

import type { DockviewApi } from "dockview-react";
import { recordActivity } from "../lib/local";
import { followGuideTopic, topicOfPanel } from "../lib/guide";

let api: DockviewApi | null = null;
// v4: düz mimari. v3 kayıtları artık var olmayan "server" bileşenini içerdiği için
// okunmaz — açılışta bir kez temizlenir.
const KEY = "portal.layout.v4";
// DİKKAT: "portal.srvlayout.v1:" burada OLMAMALI — iç dock düzenleri o önekte tutulur.
const LEGACY_KEYS = ["portal.layout.v3"];
// Kapatma düğmesiz sekme kullanan sabit paneller.
const FIXED_PANELS = ["home", "hosts", "uptime", "guide"];

// SOL YUVA: icon bar'dan açılan araç panelleri TEK bir sütunda yaşar. İkisi de
// aynı anda açık olabilir (sekme olarak yan yana) — biri öbürünü kapatmaz.
// Kapatma yolu icon bar'dır: aynı simgeye tekrar basmak o paneli kapatır,
// Home ise sütunun tamamını kapatır.
const SIDE_SLOT = ["hosts", "uptime"] as const;
type SideId = (typeof SIDE_SLOT)[number];
const SIDE_TITLE: Record<SideId, string> = { hosts: "Hosts", uptime: "Uptime" };

// Yan genişlikler: varsayılan sabit, ama kullanıcı sash'ı sürüklerse ÖLÇÜSÜ
// KORUNUR (Ctrl+K varsayılana döndürür). Ölçüm yalnız kullanıcı hareketinden
// alınır: `applying` bayrağı bizim kendi yeniden boyutlandırmalarımız sırasında
// ölçüm almayı kapatır — yoksa dockview'ün yeniden dağıtımını kullanıcı ölçüsü
// sanıp sol sütun kendi kendine büyüyordu.
const desired = { hosts: 240, guide: 300 };
let applying = false;

/** Sürükleme stratejisi: Tauri/WebView2'de HTML5 DnD güvenilmez (native drag-drop
 *  handler olayları yutar) → pointer olaylarıyla sürükle. dockview'ün ilk sınıf
 *  seçeneği; ek kütüphane gerekmez. */
export const DND_STRATEGY = "pointer" as const;

// Sürüklerken köke `dv-dragging` sınıfı: overlay katmanını isabet testinden çıkarır
// (styles.css) ve "tutuyorum" animasyonunu tetikler. Pointer modunda `dragstart`
// ATEŞLENMEZ, bu yüzden dockview'ün kendi olayına bağlanıyoruz.
let dndEndInstalled = false;
function wireDragClass(a: DockviewApi): void {
  const on = () => document.documentElement.classList.add("dv-dragging");
  const off = () => document.documentElement.classList.remove("dv-dragging");
  a.onWillDragPanel(on);
  a.onWillDragGroup(on);
  if (dndEndInstalled) return;
  dndEndInstalled = true;
  for (const ev of ["pointerup", "pointercancel", "dragend", "drop"]) {
    document.addEventListener(ev, off, true);
  }
}

// Sekme şeridinin BOŞ alanından (`.dv-void-container`) grubu sürüklemeyi kapat.
// dockview o boşluğu bir tutamak yapıyor ve tutunca "Multiple Panels" hayaleti
// çıkıyor; boşluk tutamak gibi görünmüyor, öyle davranmamalı. Panel yine
// SEKMESİNDEN sürüklenir.
//
// Neden CSS `pointer-events:none` değil: o zaman boşluk isabet testinden de
// düşüyor ve şeride BIRAKMA çalışmıyor (dockview hedefi `elementsFromPoint`
// ile arar). Burada yalnız sürüklemenin BAŞLAMASI engelleniyor — eleman drop
// hedefi olarak yerinde kalıyor.
let voidGuardInstalled = false;
function blockVoidDrag(): void {
  if (voidGuardInstalled) return;
  voidGuardInstalled = true;
  const stop = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t?.classList.contains("dv-void-container")) e.stopPropagation();
  };
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("mousedown", stop, true);
  document.addEventListener("dragstart", stop, true);
}

// Guide rail'ini AKTİF panele bağla. Kaynak tek: dock'un kendisi. Panellerin
// `onPointerDown` ile konu bildirmesi yalnız TIKLAMAYI yakalıyordu; sekmeyle
// geçiş, komut paleti, "Gateway → Files" gibi yollar rail'i eski konuda
// bırakıyordu.
function followActive(a: DockviewApi): void {
  const sync = () => {
    const id = a.activePanel?.id;
    // Sunucu sayfası aktifse konu İÇ dock'un aktif pane'inden gelir.
    if (id?.startsWith("srv:")) {
      const inner = serverApis.get(id.slice(4));
      const t = topicOfPanel(inner?.activePanel?.id);
      if (t) followGuideTopic(t);
      return;
    }
    const t = topicOfPanel(id);
    if (t) followGuideTopic(t);
  };
  a.onDidActivePanelChange(() => {
    sync();
    notifySide();
  });
  a.onDidLayoutChange(() => {
    sync();
    notifySide();
  });
  sync();
}

// Sol sütunda ÖNDE duran panel değişince haber ver. Icon bar aktif işaretini
// buradan sürer; kendi tıklamasından tahmin ederse yanılıyor (Hosts'un üstüne
// Uptime sekmesi gelince Hosts hâlâ basılı görünüyordu).
const sideListeners = new Set<() => void>();
function notifySide(): void {
  sideListeners.forEach((l) => l());
}

/** Sol sütunun ön sekmesi değiştiğinde çağrılır; abonelikten çıkma döner. */
export function subscribeSide(cb: () => void): () => void {
  sideListeners.add(cb);
  return () => {
    sideListeners.delete(cb);
  };
}

/** Sol sütunda ÖNDE duran araç paneli (sütun kapalıysa null).
 *
 *  `api.activeGroup` DEĞİL: o, odaklanmış grubu verir — kullanıcı Home'a
 *  tıkladığında sol sütunun ön sekmesi değişmediği hâlde null dönerdi. */
export function frontSide(): SideId | null {
  for (const id of SIDE_SLOT) {
    const panel = api?.getPanel(id) as unknown as
      | { group?: { activePanel?: { id?: string } } }
      | undefined;
    const front = panel?.group?.activePanel?.id;
    if (front && (SIDE_SLOT as readonly string[]).includes(front)) return front as SideId;
  }
  return null;
}

export function bindApi(a: DockviewApi): void {
  api = a;
  wireDragClass(a);
  blockVoidDrag();
  followActive(a);
  window.removeEventListener("resize", onWinResize);
  window.addEventListener("resize", onWinResize);
}

// --- yan genişlik yardımcıları (dockview tipleri eksik → güvenli erişim) ------

function groupOf(id: string): { api?: { width?: number; setSize?: (e: { width?: number }) => void }; width?: number } | undefined {
  const p = api?.getPanel(id) as unknown as { group?: { api?: { width?: number; setSize?: (e: { width?: number }) => void }; width?: number } } | undefined;
  return p?.group;
}
function sideWidth(id: string): number | undefined {
  const g = groupOf(id);
  const w = g?.api?.width ?? g?.width;
  return typeof w === "number" ? w : undefined;
}
function setSideWidth(id: string, width: number): void {
  groupOf(id)?.api?.setSize?.({ width });
}

/** Yanları sabit genişliğe getir (merkez artan alanı yutar). Sol yuvada hangi
 *  panel varsa o ölçülür; yoksa sütun zaten yoktur. */
function reassertSides(): void {
  if (!api) return;
  const open = SIDE_SLOT.find((id) => api?.getPanel(id));
  if (open) setSideWidth(open, desired.hosts);
  if (api.getPanel("guide")) setSideWidth("guide", desired.guide);
}

/** Bir düzen mutasyonunu sar: mutasyon → yanları sabitle (kullanıcı-ölçü yakalamayı sus). */
function op(mutate: () => void): void {
  applying = true;
  mutate();
  reassertSides();
  notifySide();
  // dockview mutasyondan sonra kendi dağıtımını yapıyor; iki kare boyunca
  // ısrar etmezsek sol sütun o dağıtımda kayıyor.
  requestAnimationFrame(() => {
    reassertSides();
    requestAnimationFrame(() => {
      reassertSides();
      applying = false;
    });
  });
}

function onWinResize(): void {
  applying = true;
  requestAnimationFrame(() => {
    reassertSides();
    requestAnimationFrame(() => {
      applying = false;
    });
  });
}

/** Kullanıcı bir sash'ı sürüklediyse yeni yan genişliğini hatırla (DockLayout çağırır). */
export function captureSideWidths(): void {
  // Kullanıcı sash'ı sürükledi mi? Yeni ölçüyü hatırla — bir daha panel açılıp
  // kapandığında o ölçüye dönülür. Ctrl+K varsayılana çevirir (`resetLayout`).
  //
  // ⚠️ Burada genişlik SET ETME. Bu fonksiyon dockview'ün düzen-değişti olayına
  // bağlıdır; set etmek yeni bir düzen olayı doğurur, sonsuz döngüye girer ve
  // webview kilitlenir (yaşandı). Burada yalnız OKUNUR.
  if (applying || !api) return;
  const front = SIDE_SLOT.find((id) => api?.getPanel(id));
  const side = front ? sideWidth(front) : undefined;
  const guide = sideWidth("guide");
  if (typeof side === "number" && side > 120) desired.hosts = side;
  if (typeof guide === "number" && guide > 120) desired.guide = guide;
}

function homeRef(direction: "left" | "right") {
  return api?.getPanel("home") ? { referencePanel: "home", direction } : undefined;
}

function addGuide(): void {
  api?.addPanel({
    id: "guide",
    component: "guide",
    tabComponent: "plain",
    title: "Guide",
    position: homeRef("right"),
    initialWidth: desired.guide,
  });
}

/** Varsayılan düzen: yalnızca Home (merkez, tam alan). */
export function buildDefaultLayout(): void {
  if (!api) return;
  api.addPanel({ id: "home", component: "home", tabComponent: "plain", title: "Home" });
}

/** Home sayfasını aç/odakla (icon bar Home → doğrudan home page). */
export function openHome(): void {
  if (!api) return;
  op(() => {
    const p = api?.getPanel("home");
    if (p) p.focus();
    else api?.addPanel({ id: "home", component: "home", tabComponent: "plain", title: "Home" });
  });
}

/** Tek bir monitörün sayfasını merkeze aç/odakla (host sayfası gibi). */
export function openMonitorPage(monitorId: string, title: string): void {
  if (!api) return;
  op(() => {
    const existing = api?.getPanel(`up:${monitorId}`);
    if (existing) {
      existing.focus();
      return;
    }
    api?.addPanel({
      id: `up:${monitorId}`,
      component: "monitorpage",
      tabComponent: "doctab",
      title,
      params: { monitorId },
      position: centralPosition(),
    });
  });
}

/** Sol yuvada açık olan araç panelleri. */
function openSides(): SideId[] {
  return SIDE_SLOT.filter((id) => api?.getPanel(id));
}

/** Yuvada açık olan (varsa ilk) panel — icon bar aktif işaretini sürer. */
export function openSide(): SideId | null {
  return openSides()[0] ?? null;
}

/** Bir araç panelini sol yuvaya getir/odakla. Öteki açıksa onun yanına sekme olur. */
export function showSide(id: SideId): void {
  if (!api) return;
  op(() => {
    const existing = api?.getPanel(id);
    if (existing) {
      existing.focus();
      return;
    }
    const sibling = SIDE_SLOT.find((other) => other !== id && api?.getPanel(other));
    api?.addPanel({
      id,
      component: id,
      tabComponent: "plain",
      title: SIDE_TITLE[id],
      position: sibling
        ? { referencePanel: sibling, direction: "within" }
        : homeRef("left"),
      ...(sibling ? {} : { initialWidth: desired.hosts }),
    });
  });
}

/** Icon bar davranışı: panel açık VE önde ise kapat, değilse aç/öne getir.
 *  (Arkadaki sekmeye basmak onu kapatmaz — önce öne getirir.) */
export function toggleSide(id: SideId): void {
  const panel = api?.getPanel(id);
  if (panel && frontSide() === id) {
    op(() => panel.api.close());
    return;
  }
  showSide(id);
}

/** Sidebar'ı (Hosts) aç/odakla. */
export function openSidebar(): void {
  showSide("hosts");
}

/** Sol sütunu tamamen kapat (Home'a geçince). */
export function closeSidebar(): void {
  if (!api) return;
  op(() => {
    for (const id of openSides()) api?.getPanel(id)?.api.close();
  });
}

/** Sütunu aç/kapat (top bar panel-toggle / Ctrl+B). Boşsa Hosts ile açılır. */
export function toggleSidebar(): void {
  if (openSides().length > 0) closeSidebar();
  else showSide("hosts");
}

/** Guide (öğretme) panelini aç/odakla. */
export function openGuide(): void {
  if (!api) return;
  op(() => {
    const p = api?.getPanel("guide");
    if (p) p.focus();
    else addGuide();
  });
}

/** Guide panelini aç/kapat (Help menüsü / context menü). */
export function toggleGuide(): void {
  if (!api) return;
  op(() => {
    const p = api?.getPanel("guide");
    if (p) p.api.close();
    else addGuide();
  });
}

/** Eski sürümlerin düzen kayıtlarını bir kez temizle (uyumsuz bileşen adları içerir). */
function purgeLegacyKeys(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (LEGACY_KEYS.some((p) => k === p || k.startsWith(p))) localStorage.removeItem(k);
    }
  } catch {
    // sessizce geç
  }
}

/** Kayıtlı düzeni geri yükle; yoksa/bozuksa varsayılanı (yalnız Home) kur. */
export function restoreOrBuild(): void {
  if (!api) return;
  purgeLegacyKeys();
  const saved = localStorage.getItem(KEY);
  if (saved) {
    try {
      const layout = JSON.parse(saved);
      const panels = layout?.panels;
      if (panels && typeof panels === "object") {
        for (const id of FIXED_PANELS) {
          if (panels[id]) panels[id].tabComponent = "plain";
        }
        // Not: oturum pane'leri İÇ dock'ta yaşar; onların "soğuk açılışta otomatik
        // bağlanma" koruması ServerWorkspace'in geri yüklemesinde uygulanır.
      }
      api.fromJSON(layout);
      captureSideWidths();
      return;
    } catch {
      // bozuk düzen → varsayılana düş
    }
  }
  buildDefaultLayout();
}

// ── Sunucu sayfaları + iç dock ───────────────────────────────────────────────
// Her sunucu dış dock'ta TEK bir sayfadır (srv:{hostId}). Sayfanın içi iç içe bir
// dockview'dir (ServerWorkspace): Gateway + Terminal + Files + Monitor pane'lerini
// taşır — kullanıcı orada istediği gibi sola/sağa yerleştirir.
//
// KEEPALIVE: hem sayfa hem iç pane'ler `renderer: "always"` → başka sekmeye
// geçilince unmount olup oturum ÖLMESİN.

let seq = 0;

// ServerWorkspace mount olunca iç dock api'sini kaydeder; açılış istekleri yönlenir.
const serverApis = new Map<string, DockviewApi>();
const pendingOpens = new Map<string, Array<(dock: DockviewApi) => void>>();

/** ServerWorkspace hazır olunca iç dock'unu kaydeder + bekleyen açılışları işler. */
export function registerServerDock(hostId: string, dock: DockviewApi): void {
  serverApis.set(hostId, dock);
  wireDragClass(dock);
  const q = pendingOpens.get(hostId);
  if (q) {
    pendingOpens.delete(hostId);
    q.forEach((fn) => fn(dock));
  }
  // İç dock'un aktif pane'i de Guide'ı sürer (Gateway ⇄ Terminal ⇄ Files ⇄ Monitor).
  const syncInner = () => {
    if (api?.activePanel?.id !== `srv:${hostId}`) return;
    const t = topicOfPanel(dock.activePanel?.id);
    if (t) followGuideTopic(t);
  };
  dock.onDidActivePanelChange(syncInner);
  syncInner();
}
export function unregisterServerDock(hostId: string): void {
  serverApis.delete(hostId);
  pendingOpens.delete(hostId);
}

/** Dış dock'un merkez grubu (Home'un yanı). */
function centralPosition() {
  const anchor = api?.getPanel("home")
    ? "home"
    : api?.panels.map((p) => p.id).find((id) => id !== "hosts" && id !== "guide");
  return anchor ? { referencePanel: anchor, direction: "within" as const } : undefined;
}

/** Sunucu sayfasını (srv:{hostId}) aç/odakla; yoksa dış dock'a ekler. */
export function openServerPage(hostId: string, title: string): void {
  if (!api) return;
  op(() => {
    const existing = api?.getPanel(`srv:${hostId}`);
    if (existing) {
      existing.focus();
      return;
    }
    api?.addPanel({
      id: `srv:${hostId}`,
      component: "server",
      title,
      params: { hostId },
      tabComponent: "srvtab",
      // Home'a geçince iç dock unmount olup oturumlar ölmesin.
      renderer: "always",
      position: centralPosition() as never,
    });
  });
}

/** İç dock hazırsa çalıştır; değilse sayfayı aç + kuyruğa al (ready olunca çalışır). */
function withServerDock(hostId: string, title: string, fn: (dock: DockviewApi) => void): void {
  const dock = serverApis.get(hostId);
  if (dock) {
    fn(dock);
    api?.getPanel(`srv:${hostId}`)?.focus();
    return;
  }
  if (!pendingOpens.has(hostId)) pendingOpens.set(hostId, []);
  pendingOpens.get(hostId)?.push(fn);
  openServerPage(hostId, title);
}

/** İç dock'a bir pane ekle; Gateway'in SAĞINA yerleşir, kullanıcı sonra taşır. */
function addPane(
  dock: DockviewApi,
  id: string,
  component: string,
  title: string,
  hostId: string,
  params: Record<string, unknown>,
) {
  const existing = dock.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  const gw = dock.getPanel(`gw:${hostId}`);
  dock.addPanel({
    id,
    component,
    title,
    params,
    tabComponent: "pane",
    renderer: "always",
    position: (gw ? { referencePanel: gw.id, direction: "right" } : undefined) as never,
  });
}

/** Sunucu sayfasını aç (içinde Gateway pane'i olur). */
export function openGateway(hostId: string, title: string): void {
  recordActivity(hostId, "gateway");
  openServerPage(hostId, title);
}

/** Sunucu sayfasında yeni bir Terminal pane'i (birden çok olabilir). */
export function openTerminal(hostId: string, title: string, command?: string): void {
  recordActivity(hostId, "terminal");
  seq += 1;
  const id = `term:${seq}`;
  withServerDock(hostId, title, (dock) =>
    addPane(dock, id, "terminal", "Terminal", hostId, { hostId, command }),
  );
}

/** Sunucu sayfasında Files (SFTP) pane'i. */
export function openFiles(hostId: string, title: string): void {
  recordActivity(hostId, "files");
  seq += 1;
  const id = `files:${seq}`;
  withServerDock(hostId, title, (dock) => addPane(dock, id, "files", "Files", hostId, { hostId }));
}

/** Sunucu sayfasında uzak bir metin dosyası için editör pane'i.
 *  SFTP oturumunu AÇAN Files paneliyle paylaşır (ikinci bağlantı açmaz) — bu yüzden
 *  `sessionId` parametre olarak geçer. Aynı dosya iki kez açılmaz (id yola bağlı). */
export function openEditor(hostId: string, title: string, sessionId: number, path: string): void {
  const id = `edit:${sessionId}:${path}`;
  withServerDock(hostId, title, (dock) =>
    addPane(dock, id, "editor", baseNameOf(path), hostId, { hostId, sessionId, path }),
  );
}

/** Editörü DIŞ dock'ta yüzen bir pencereye taşır.
 *
 *  ⚠️ İÇ dock'ta yüzdürmek işe yaramaz: sunucu sayfası `renderer:"always"` ile
 *  açıldığı için iç dock `.dv-render-overlay` katmanının içinde yaşar ve o katman
 *  `overflow: hidden` taşır (yuvarlak alt köşeler için). Yüzen pencere o kırpmaya
 *  takılıp panelin dışına çıkamıyor, "bir şeylerin altında kalıyor" görünüyordu.
 *  Dış dock kırpılmaz — pencere gerçekten her şeyin üstünde durur. */
export function floatEditor(hostId: string, sessionId: number, path: string): void {
  // İç dock'taki kopyayı kapat: aynı dosya iki yerde açık kalmasın.
  serverApis.get(hostId)?.getPanel(`edit:${sessionId}:${path}`)?.api.close();
  const id = `floatedit:${sessionId}:${path}`;
  const existing = api?.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api?.addPanel({
    id,
    component: "editor",
    title: baseNameOf(path),
    params: { hostId, sessionId, path, floating: true },
    // Başlık şeridi: dosya adı + kapatma (×) — dockview'ün boş varsayılanı değil.
    tabComponent: "doctab",
    floating: { width: 760, height: 520 },
  });
}

function baseNameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Sunucu sayfasında Monitor pane'i. */
export function openMonitor(hostId: string, title: string): void {
  recordActivity(hostId, "monitor");
  seq += 1;
  const id = `monitor:${seq}`;
  withServerDock(hostId, title, (dock) =>
    addPane(dock, id, "monitor", "Monitor", hostId, { hostId }),
  );
}

// ── Sunucu sayfasının İÇ düzeni ──────────────────────────────────────────────
// İki katmanlı hatırlama: bellek (aynı çalışma → kimlik önbelleği dolu, sessiz
// yeniden bağlanma) + localStorage (yeniden başlatma → `restored` işaretiyle
// otomatik bağlanma YOK, pane "Connect" düğmesiyle bekler).
const SRV_KEY = "portal.srvlayout.v1:";
const liveLayouts = new Map<string, unknown>();

/** İç dock düzenini hem belleğe hem diske yaz (ServerWorkspace her değişimde çağırır). */
export function persistServerLayout(hostId: string, json: unknown): void {
  liveLayouts.set(hostId, json);
  try {
    localStorage.setItem(SRV_KEY + hostId, JSON.stringify(json));
  } catch {
    // sessizce geç (kota vb.)
  }
}

/** Kayıtlı iç düzeni getir. cold=true → diskten geldi (otomatik bağlanma yok). */
export function loadServerLayout(hostId: string): { json: unknown; cold: boolean } | null {
  const live = liveLayouts.get(hostId);
  if (live) return { json: live, cold: false };
  try {
    const raw = localStorage.getItem(SRV_KEY + hostId);
    if (raw) return { json: JSON.parse(raw), cold: true };
  } catch {
    // bozuk kayıt → varsayılan düzene düş
  }
  return null;
}

export function persist(): void {
  if (!api) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(api.toJSON()));
  } catch {
    // sessizce geç (kota vb.)
  }
}

/** Kaydı temizle ve varsayılana (yalnız Home) dön. */
export function resetLayout(): void {
  if (!api) return;
  localStorage.removeItem(KEY);
  purgeLegacyKeys();
  // "Reset layout" her şeyi sıfırlar: sunucu sayfalarının İÇ düzenleri de gitmeli,
  // yoksa sayfayı bir daha açtığında eski yerleşim geri gelirdi.
  liveLayouts.clear();
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(SRV_KEY)) localStorage.removeItem(k);
    }
  } catch {
    // sessizce geç
  }
  desired.hosts = 240;
  desired.guide = 300;
  api.clear();
  buildDefaultLayout();
}
