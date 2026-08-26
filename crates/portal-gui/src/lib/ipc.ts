// portal-core komut köprüsü (Tauri invoke) + Rust→web olay dinleyicileri.
// Bkz. docs/ARCHITECTURE.md §3.1.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Auth,
  Bootstrap,
  Folder,
  Host,
  LocalListing,
  MetricsMsg,
  MonitorInput,
  MonitorSummary,
  ProfileInfo,
  SessionInfo,
  SftpMsg,
  ShellMsg,
  Snippet,
  SyncInfo,
  SyncResult,
} from "./types";

export const getBootstrap = (): Promise<Bootstrap> => invoke<Bootstrap>("get_bootstrap");
export const listHosts = (): Promise<Host[]> => invoke<Host[]>("list_hosts");
export const listFolders = (): Promise<Folder[]> => invoke<Folder[]>("list_folders");

// ── Onboarding / kilit / profil (Faz 3-C) ──────────────
export const completeOnboarding = (
  theme: string,
  profileName?: string,
  password?: string,
  recoveryPhrase?: string,
): Promise<Bootstrap> =>
  invoke<Bootstrap>("complete_onboarding", {
    theme,
    profileName: profileName ?? null,
    password: password ?? null,
    recoveryPhrase: recoveryPhrase ?? null,
  });
/** Onboarding'de gösterilecek yeni bir kurtarma cümlesi üretir (saf; durum değişmez). */
export const generateRecoveryPhrase = (): Promise<string> =>
  invoke<string>("generate_recovery_phrase");
export const unlockVault = (password: string): Promise<Bootstrap> =>
  invoke<Bootstrap>("unlock_vault", { password });
/** Kilitli profili kurtarma cümlesiyle açar (parola unutulduğunda). */
export const unlockWithRecovery = (phrase: string): Promise<Bootstrap> =>
  invoke<Bootstrap>("unlock_with_recovery", { phrase });
export const listProfiles = (): Promise<ProfileInfo[]> => invoke<ProfileInfo[]>("list_profiles");
export const switchProfile = (id: string): Promise<Bootstrap> =>
  invoke<Bootstrap>("switch_profile", { id });
export const lockNow = (): Promise<Bootstrap> => invoke<Bootstrap>("lock_now");

// ── BYOS senkron (Faz 3-C) ─────────────────────────────
export const syncGet = (): Promise<SyncInfo> => invoke<SyncInfo>("sync_get");
export const setSyncDir = (dir: string | null): Promise<void> =>
  invoke("set_sync_dir", { dir });
export const syncNow = (): Promise<SyncResult> => invoke<SyncResult>("sync_now");

export const addHost = (
  label: string,
  address: string,
  port?: number,
  username?: string,
): Promise<Host> =>
  invoke<Host>("add_host", {
    label,
    address,
    port: port ?? null,
    username: username ?? null,
  });

export const updateHost = (
  id: string,
  label: string,
  address: string,
  port?: number,
  username?: string,
): Promise<Host> =>
  invoke<Host>("update_host", {
    id,
    label,
    address,
    port: port ?? null,
    username: username ?? null,
  });

export const removeHost = (id: string): Promise<void> => invoke("remove_host", { id });
export const setHostAutoConnect = (id: string, value: boolean): Promise<Host> =>
  invoke<Host>("set_host_auto_connect", { id, value });
export const setTheme = (theme: string): Promise<void> => invoke("set_theme", { theme });

/** Host değiştiğinde (ekle/sil) Rust yayınlar; UI tazeler. */
export const onHostsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("portal://hosts-changed", () => cb());

// ── Snippets (kayıtlı komutlar) + kimlik önbelleği ─────
export const hostSnippets = (hostId: string): Promise<Snippet[]> =>
  invoke<Snippet[]>("host_snippets", { hostId });
/** Tüm kayıtlı komutlar (global + tüm host'lara özel) — Snippets yöneticisi. */
export const listSnippets = (): Promise<Snippet[]> => invoke<Snippet[]>("list_snippets");
export const addSnippet = (
  label: string,
  command: string,
  hostId?: string | null,
): Promise<Snippet> =>
  invoke<Snippet>("add_snippet", { label, command, hostId: hostId ?? null });
export const updateSnippet = (
  id: string,
  label: string,
  command: string,
  hostId?: string | null,
): Promise<Snippet> =>
  invoke<Snippet>("update_snippet", { id, label, command, hostId: hostId ?? null });
export const removeSnippet = (id: string): Promise<void> => invoke("remove_snippet", { id });
/** Kayıtlı komut değişince (ekle/düzenle/sil) Rust yayınlar; açık paneller tazeler. */
export const onSnippetsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("portal://snippets-changed", () => cb());
export const hostIsCached = (hostId: string): Promise<boolean> =>
  invoke<boolean>("host_is_cached", { hostId });
export const forgetCreds = (hostId: string): Promise<void> =>
  invoke("forget_creds", { hostId });
export const listSessions = (): Promise<SessionInfo[]> => invoke<SessionInfo[]>("list_sessions");

// ── Oturum başlatma (id döner) ─────────────────────────
export const connectShell = (
  hostId: string,
  cols: number,
  rows: number,
  auth?: Auth,
): Promise<number> =>
  invoke<number>("connect_shell", { hostId, auth: auth ?? null, cols, rows });
export const connectFiles = (hostId: string, auth?: Auth): Promise<number> =>
  invoke<number>("connect_files", { hostId, auth: auth ?? null });
export const connectMonitor = (hostId: string, auth?: Auth): Promise<number> =>
  invoke<number>("connect_monitor", { hostId, auth: auth ?? null });

// ── Oturum kontrol ─────────────────────────────────────
export const sendInput = (id: number, data: string): Promise<void> =>
  invoke("send_input", { id, data });
export const resizePty = (id: number, cols: number, rows: number): Promise<void> =>
  invoke("resize_pty", { id, cols, rows });
export const hostKeyDecision = (id: number, accept: boolean): Promise<void> =>
  invoke("host_key_decision", { id, accept });
export const closeSession = (id: number): Promise<void> => invoke("close_session", { id });

// ── SFTP ───────────────────────────────────────────────
export const sftpList = (id: number, path: string): Promise<void> =>
  invoke("sftp_list", { id, path });
export const sftpUpload = (id: number, local: string, remote: string): Promise<void> =>
  invoke("sftp_upload", { id, local, remote });
export const sftpDownload = (id: number, remote: string, local: string): Promise<void> =>
  invoke("sftp_download", { id, remote, local });
export const sftpCancel = (id: number, transferId: number): Promise<void> =>
  invoke("sftp_cancel", { id, transferId });
export const sftpMkdir = (id: number, path: string): Promise<void> =>
  invoke("sftp_mkdir", { id, path });
export const sftpRename = (id: number, from: string, to: string): Promise<void> =>
  invoke("sftp_rename", { id, from, to });
export const sftpRemove = (id: number, path: string, isDir: boolean): Promise<void> =>
  invoke("sftp_remove", { id, path, isDir });
// Gömülü editör: yanıt komuttan DEĞİL, portal://sftp/{id} olayından gelir.
export const sftpRead = (id: number, path: string): Promise<void> =>
  invoke("sftp_read", { id, path });
export const sftpWrite = (id: number, path: string, text: string): Promise<void> =>
  invoke("sftp_write", { id, path, text });

// ── Uptime monitörü ────────────────────────────────────
export const listMonitors = (): Promise<MonitorSummary[]> =>
  invoke<MonitorSummary[]>("list_monitors");
export const addMonitor = (input: MonitorInput): Promise<string> =>
  invoke<string>("add_monitor", { input });
export const updateMonitor = (id: string, input: MonitorInput): Promise<void> =>
  invoke("update_monitor", { id, input });
export const removeMonitor = (id: string): Promise<void> => invoke("remove_monitor", { id });
/** Sırasını beklemeden hemen kontrol et. */
export const checkMonitorNow = (id: string): Promise<void> =>
  invoke("check_monitor_now", { id });
/** Bir kontrol tamamlandığında Rust yayınlar; açık yüzeyler tazeler. */
export const onUptime = (cb: () => void): Promise<UnlistenFn> =>
  listen("portal://uptime", () => cb());
/** Monitör listesi değişince (ekle/düzenle/sil). */
export const onMonitorsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("portal://monitors-changed", () => cb());

/** Terminal yazı boyutu (px, uygulama geneli); çekirdek sınırlara kırpar ve
 *  kırpılmış değeri döndürür. */
export const setTerminalFontSize = (px: number): Promise<number> =>
  invoke<number>("set_terminal_font_size", { px });

/** Terminalde tıklanan bağlantıyı sistem tarayıcısında açar (yalnız http/https).
 *  Kullanıcı onayı ÇAĞIRANIN sorumluluğu — Rust tarafı yalnız şemayı doğrular. */
export const openExternal = (url: string): Promise<void> =>
  invoke("open_external", { url });

/** Pencere kapatılınca tepsiye inme ayarı. */
export const setMinimizeToTray = (enabled: boolean): Promise<void> =>
  invoke("set_minimize_to_tray", { enabled });

/** Monitör düşüp kalkınca masaüstü bildirimi gönderilsin mi. */
export const setNotifyUptime = (enabled: boolean): Promise<void> =>
  invoke("set_notify_uptime", { enabled });

// ── Yerel dosya sistemi ────────────────────────────────
export const listLocal = (path: string): Promise<LocalListing> =>
  invoke<LocalListing>("list_local", { path });
export const localHome = (): Promise<string> => invoke<string>("local_home");

// Fuzzy filtre — eşleştirme çekirdekte (portal_core::fuzzy). Uyanların indeksleri
// ÖZGÜN sırada döner: sıralamayı kullanıcı seçer, arama yalnız eler.
export const fuzzyFilter = (query: string, items: string[]): Promise<number[]> =>
  invoke<number[]>("fuzzy_filter", { query, items });

// Transfer çakışmasında önerilen adlar ("notes.txt" → "notes (1).txt"). Adlandırma
// çekirdekte; üretilenler birbirine de çarpmaz.
export const freeNames = (taken: string[], wanted: string[]): Promise<string[]> =>
  invoke<string[]>("free_names", { taken, wanted });

// ── Oturum olay akışları (portal://ssh|sftp|metrics/{id}) ──
export const onShell = (id: number, cb: (m: ShellMsg) => void): Promise<UnlistenFn> =>
  listen<ShellMsg>(`portal://ssh/${id}`, (e) => cb(e.payload));
export const onSftp = (id: number, cb: (m: SftpMsg) => void): Promise<UnlistenFn> =>
  listen<SftpMsg>(`portal://sftp/${id}`, (e) => cb(e.payload));
export const onMetrics = (id: number, cb: (m: MetricsMsg) => void): Promise<UnlistenFn> =>
  listen<MetricsMsg>(`portal://metrics/${id}`, (e) => cb(e.payload));
