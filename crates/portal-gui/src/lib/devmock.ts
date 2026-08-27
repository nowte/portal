// GELİŞTİRME KÖPRÜSÜ — yalnız TARAYICI önizlemesinde (vite dev) devreye girer.
//
// Neden var: `@tauri-apps/api` çağrıları `window.__TAURI_INTERNALS__` üzerinden
// gider. Tauri dışında bu nesne yoktur; `getCurrentWindow()` import anında,
// `invoke()`/`listen()` ilk çağrıda patlar → uygulama hiç çizilmez ve arayüz
// tarayıcıda gözle doğrulanamaz. Burada o nesnenin en küçük taklidi kurulur.
//
// Tauri İÇİNDE hiçbir etkisi yoktur: nesne zaten tanımlıdır, kurulum atlanır.
//
// UYDURMA VERİ YOK. Varsayılan durum BOŞTUR — sunucu yok, komut yok, profil yok.
// Böylece tarayıcıda görülen şey uygulamanın gerçek "ilk açılış" hâlidir ve
// hiçbir sahte sunucu arayüzde görünmez. Örnek veri yalnız açıkça istenirse
// gelir: `?mock=demo` (boş olmayan durumları incelemek için).

interface TauriInternals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  transformCallback: (cb: (v: unknown) => void, once?: boolean) => number;
  metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

// Olay borusunun taklidi. Tauri'de `listen()` Rust'tan gelen olayları burada
// kayıtlı geri çağrıya iletir; önizlemede iletecek Rust yok, o yüzden olayı
// elle sürebilmek gerekiyor (aşağıdaki `portalEmit`, yalnız ?mock=demo).
const cbs = new Map<number, (v: unknown) => void>();
const listeners = new Map<string, (v: unknown) => void>();
let cbSeq = 0;

const EMPTY_BOOT = {
  theme: "black",
  onboarded: true,
  locked: false,
  profile: null as string | null,
  has_recovery: false,
  device_label: "this machine",
  minimize_to_tray: false,
  // Profil yok → vault düz metin → kimlik hatırlanamaz (çekirdek reddeder).
  can_remember: false,
  terminal_font_size: 13,
  notify_uptime: true,
  hosts: [] as unknown[],
  folders: [] as unknown[],
};

const RESULTS: Record<string, unknown> = {
  get_bootstrap: { ...EMPTY_BOOT },
  list_hosts: [],
  list_folders: [],
  list_snippets: [],
  host_snippets: [],
  list_sessions: [],
  list_profiles: [],
  list_monitors: [],
  sync_get: {
    dir: null,
    label: null,
    localUpdated: null,
    localDevice: null,
    remoteUpdated: null,
    remoteDevice: null,
  },
  host_is_cached: false,
  local_home: "",
  list_local: { path: "", entries: [] },
  generate_recovery_phrase: "sample words only for the browser preview never real",
};

// Yalnız açıkça istenen incelemeler için:
//   ?mock=demo         boş olmayan durumlar (liste · komut · profil)
//   ?screen=unlock     kilit ekranı
//   ?screen=onboarding ilk kurulum sihirbazı
function applyOverrides(): void {
  const q = new URLSearchParams(location.search);
  const boot = RESULTS.get_bootstrap as Record<string, unknown>;

  if (q.get("mock") === "demo") {
    const hosts = [
      { id: "h1", label: "example-a", address: "10.0.0.5", port: 22, username: "root" },
      { id: "h2", label: "example-b", address: "10.0.0.9", port: 22, username: "ci" },
    ];
    boot.hosts = hosts;
    boot.profile = "preview";
    boot.can_remember = true; // demo profili parolalı sayılır
    // Yerel panel: sürükle-bırak ve satır davranışı tarayıcıda incelenebilsin diye
    // birkaç örnek giriş (yalnız ?mock=demo).
    RESULTS.local_home = "C:\\Users\\you";
    RESULTS.list_local = {
      path: "C:\\Users\\you\\Downloads",
      parent: "C:\\Users\\you",
      entries: [
        { name: "notes", path: "C:\\Users\\you\\Downloads\\notes", isDir: true, size: 0, modified: 1756166400, hidden: false },
        { name: "deploy.sh", path: "C:\\Users\\you\\Downloads\\deploy.sh", isDir: false, size: 1840, modified: 1756080000, hidden: false },
        { name: "archive.tar.gz", path: "C:\\Users\\you\\Downloads\\archive.tar.gz", isDir: false, size: 5242880, modified: 1755993600, hidden: false },
        // Gizli dosya anahtarının tarayıcıda da denenebilmesi için.
        { name: ".env", path: "C:\\Users\\you\\Downloads\\.env", isDir: false, size: 220, modified: 1755907200, hidden: true },
      ],
    };
    RESULTS.list_hosts = hosts;
    RESULTS.list_snippets = [
      { id: "s1", label: "restart nginx", command: "sudo systemctl restart nginx", host_id: null },
    ];
    RESULTS.host_snippets = RESULTS.list_snippets;
    RESULTS.list_profiles = [{ id: "p1", name: "preview", lockedWithPassword: true, active: true }];

    // Güncelleme şeridi + ≡ noktası tarayıcıda incelenebilsin (yalnız demo'da:
    // varsayılan önizlemede sahte "yeni sürüm var" rozeti gerçek sanılırdı).
    // Olay-güdümlü yüzeyleri (bildirim, terminal, transfer) tarayıcıda
    // sürebilmek için: portalEmit("portal://monitor-changed", { … }).
    // OTOMATİK tetiklenmez — demo ekran görüntülerine sahte uyarı düşmesin.
    (window as unknown as Record<string, unknown>).portalEmit = (
      event: string,
      payload: unknown,
    ) => listeners.get(event)?.({ event, id: 0, payload });

    // Uptime: biri ayakta, biri kesintide — iki durumu da gorebilmek icin.
    const now = Math.floor(Date.now() / 1000);
    const day = Math.floor(now / 86400);
    const series = (up: boolean, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        monitor_id: up ? "m1" : "m2",
        at: now - (n - i) * 60,
        up: up || i < n - 3,
        latency_ms: up || i < n - 3 ? 120 + ((i * 7) % 60) : null,
        status: up || i < n - 3 ? 200 : null,
        error: up || i < n - 3 ? null : "Connection refused",
      }));
    const days = (down: number) =>
      Array.from({ length: 14 }, (_, i) => ({
        day: day - 13 + i,
        up: 1400,
        down: i === 13 ? down : 0,
        latency_sum_ms: 1400 * 140,
      }));
    RESULTS.list_monitors = [
      {
        monitor: {
          id: "m1",
          label: "example.com",
          target: { kind: "http", url: "https://example.com", expect_status: null },
          interval_secs: 60,
          timeout_secs: 10,
          enabled: true,
          host_id: null,
        },
        state: "up",
        last: series(true, 40)[39],
        today: { day, up: 1400, down: 0, latency_sum_ms: 1400 * 140 },
        days: days(0),
        recent: series(true, 40),
        certDays: 12,
        certAlert: "warn",
      },
      {
        monitor: {
          id: "m2",
          label: "db port",
          target: { kind: "tcp", host: "10.0.0.9", port: 5432 },
          interval_secs: 60,
          timeout_secs: 10,
          enabled: true,
          host_id: "h2",
        },
        state: "down",
        last: series(false, 40)[39],
        today: { day, up: 1380, down: 20, latency_sum_ms: 1380 * 90 },
        days: days(20),
        recent: series(false, 40),
        certDays: null,
        certAlert: null,
      },
    ];
  }

  if (q.get("screen") === "unlock") {
    boot.locked = true;
    boot.profile = boot.profile ?? "preview";
    boot.has_recovery = true;
    RESULTS.list_profiles = [{ id: "p1", name: "preview", lockedWithPassword: true, active: true }];
  }
  if (q.get("screen") === "onboarding") boot.onboarded = false;
}

export function installDevMock(): void {
  if (window.__TAURI_INTERNALS__) return;
  applyOverrides();
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      // Ad önerisi gerçek bir Rust çağrısıdır: önizlemede istenen adı aynen ver.
      if (cmd === "free_names") {
        return Promise.resolve((args as { wanted?: string[] } | undefined)?.wanted ?? []);
      }
      // Fuzzy filtre de öyle (sabit yanıt olamaz): önizlemede her şeyi geçir,
      // filtre kutusu listeyi yutmasın.
      if (cmd === "fuzzy_filter") {
        const items = (args as { items?: string[] } | undefined)?.items ?? [];
        return Promise.resolve(items.map((_, i) => i));
      }
      // `listen()` olay adını BURADA veriyor (transformCallback bilmiyor):
      // dinleyiciyi ada bağla ki önizlemede olay-güdümlü yüzeyler de sürülebilsin.
      if (cmd === "plugin:event|listen") {
        const a = args as { event?: string; handler?: number };
        const cb = cbs.get(a.handler ?? -1);
        if (a.event && cb) listeners.set(a.event, cb);
        return Promise.resolve(a.handler ?? 0);
      }
      return Promise.resolve(RESULTS[cmd] ?? null);
    },
    transformCallback: (cb) => {
      const id = ++cbSeq;
      cbs.set(id, cb);
      return id;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  // ⚠️ `unlisten()` bunu AYRI bir global'den okur (@tauri-apps/api/event.js),
  // `__TAURI_INTERNALS__`ten değil — tipi Tauri'nin kendi bildiriminden gelir.
  // Yanlış yere konduğu sürece olay dinleyen HER bileşen unmount olurken
  // yakalanmamış bir promise hatası atıyor, konsol bunlarla dolup gerçek
  // hataları gizliyordu.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  // eslint-disable-next-line no-console
  console.info("[portal] browser preview — Tauri bridge mocked, no real data");
}
