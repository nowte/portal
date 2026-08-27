// Rust (src-tauri) DTO'larının TS karşılıkları. Bkz. portal-core::model.

export interface Host {
  id: string;
  label: string;
  address: string;
  port: number;
  username?: string | null;
  identity_id?: string | null;
  folder_id?: string | null;
  jump_host_id?: string | null;
  forward_agent?: boolean;
  auto_connect?: boolean;
  tags?: string[];
  note?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id?: string | null;
}

export interface Bootstrap {
  theme: string;
  onboarded: boolean;
  locked: boolean;
  profile: string | null;
  // Aktif profilde kurtarma cümlesi tanımlı mı (kilit ekranı recovery yolunu göstersin mi).
  has_recovery: boolean;
  device_label: string;
  // Pencere kapatılınca tepsiye insin mi (Settings ▸ Appearance ▸ Window).
  minimize_to_tray: boolean;
  // Vault şifreli mi → kimlik "hatırlanabilir" mi (profilsiz modda vault düz metin).
  can_remember: boolean;
  // Terminal yazı boyutu (px) — uygulama geneli, Ctrl +/- ile değişir.
  terminal_font_size: number;
  // Monitör düşüp kalkınca masaüstü bildirimi gönderilsin mi.
  notify_uptime: boolean;
  hosts: Host[];
  folders: Folder[];
}

export interface Snippet {
  id: string;
  label: string;
  command: string;
  host_id?: string | null;
}

// ── Uptime monitörü ────────────────────────────────────
export type MonitorTarget =
  | { kind: "http"; url: string; expect_status?: number | null; contains?: string | null }
  | { kind: "tcp"; host: string; port: number };

export interface Monitor {
  id: string;
  label: string;
  target: MonitorTarget;
  interval_secs: number;
  timeout_secs: number;
  enabled: boolean;
  host_id?: string | null;
}

export interface CheckResult {
  monitor_id: string;
  // Unix saniye (UTC).
  at: number;
  up: boolean;
  latency_ms?: number | null;
  status?: number | null;
  error?: string | null;
  // TLS sertifikasının bitiş anı (unix saniye) — yalnız ayakta olan https hedeflerde.
  cert_expires_at?: number | null;
}

export interface DayStat {
  // Gün numarası: unix saniye / 86400 (UTC).
  day: number;
  up: number;
  down: number;
  latency_sum_ms: number;
}

export type MonitorState = "unknown" | "up" | "down";

export interface MonitorSummary {
  monitor: Monitor;
  state: MonitorState;
  last: CheckResult | null;
  today: DayStat;
  days: DayStat[];
  recent: CheckResult[];
  // Sertifikanın bitişine kalan gün (https değilse null).
  certDays: number | null;
  // Uyarı düzeyi — eşikler ÇEKİRDEKTE (portal_core::cert), burada yalnız çizilir.
  certAlert: "warn" | "crit" | null;
}

// Form → Rust (monitor_from). Boş label hedeften türetilir.
export interface MonitorInput {
  label: string;
  kind: "http" | "tcp";
  target: string;
  port: number | null;
  expectStatus: number | null;
  // Yanıt gövdesinde aranan metin (boşsa gövdeye bakılmaz).
  contains: string | null;
  intervalSecs: number;
  timeoutSecs: number;
  enabled: boolean;
  hostId: string | null;
}

// ── Profil / senkron (Faz 3-C) ─────────────────────────
export interface ProfileInfo {
  id: string;
  name: string;
  lockedWithPassword: boolean;
  active: boolean;
}

// Senkron durumu (şifre çözülmeden zarf başlığından okunur).
export interface SyncInfo {
  dir: string | null;
  label: string | null;
  localUpdated: number | null;
  localDevice: string | null;
  remoteUpdated: number | null;
  remoteDevice: string | null;
}

export interface SyncResult {
  message: string;
  locked: boolean;
}

// Bağlanma-anı kimliği. `remember` YOKSA sır yalnız bellekte kalır (uygulama
// kapanınca gider). `remember: true` ise ŞİFRELİ VAULT'a yazılır — başka hiçbir yere.
export type Auth =
  | { kind: "password"; password: string; remember?: boolean }
  | { kind: "key"; path: string; passphrase?: string; remember?: boolean };

// ── SFTP / yerel dosya ─────────────────────────────────
export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  // Son değişiklik, unix saniye — sunucu göndermezse null.
  modified: number | null;
}
export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  // Gizli mi (Windows HIDDEN özniteliği ya da nokta ile başlayan ad).
  hidden: boolean;
}
export interface LocalListing {
  path: string;
  parent: string | null;
  entries: LocalEntry[];
}

// ── Oturum olayları (Rust → web, portal://ssh|sftp|metrics/{id}) ──
export type ShellMsg =
  | { type: "hostKey"; host: string; port: number; keyType: string; fingerprint: string; changed: boolean }
  | { type: "connected" }
  | { type: "output"; data: string } // base64
  | { type: "disconnected"; message: string }
  | { type: "error"; message: string };

export type SftpMsg =
  | { type: "hostKey"; host: string; port: number; keyType: string; fingerprint: string; changed: boolean }
  | { type: "ready" }
  | { type: "listing"; path: string; entries: RemoteEntry[] }
  | { type: "listError"; path: string; message: string }
  | {
      type: "transferQueued";
      id: number;
      kind: "upload" | "download";
      name: string;
      // Kaynak + hedef: başarısız transfer aynı argümanlarla yeniden kurulur.
      local: string;
      remote: string;
      total: number;
    }
  | { type: "transferProgress"; id: number; transferred: number }
  | { type: "transferDone"; id: number }
  | { type: "transferFailed"; id: number; message: string }
  | { type: "transferCancelled"; id: number }
  | { type: "remoteContent"; path: string; text: string }
  | { type: "editError"; path: string; message: string }
  | { type: "writeDone"; path: string }
  | { type: "error"; message: string };

export interface ProcInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}
export interface DiskInfo {
  filesystem: string;
  mount: string;
  usedKb: number;
  totalKb: number;
  pct: number;
}
export interface Metrics {
  cpuPct: number;
  memUsedKb: number;
  memTotalKb: number;
  memPct: number;
  diskUsedKb: number;
  diskTotalKb: number;
  diskPct: number;
  netRxBps: number;
  netTxBps: number;
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  processes: number;
  uptime: string;
  topProcesses: ProcInfo[];
  disks: DiskInfo[];
}

export type MetricsMsg =
  | { type: "hostKey"; host: string; port: number; keyType: string; fingerprint: string; changed: boolean }
  | { type: "update"; metrics: Metrics }
  | { type: "error"; message: string };

export interface SessionInfo {
  id: number;
  kind: string;
  hostId: string;
}

/** Monitör durum değişimi — uygulama içi duyuru (portal://monitor-changed). */
export interface MonitorChanged {
  title: string;
  body: string;
  down: boolean;
}
