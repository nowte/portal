// Oturum köprüsü: portal-core'un senkron olay kanallarını (SshEvent/SftpEvent/
// MetricsEvent) webview'e Tauri emit ile stream eder. Bkz. docs/ARCHITECTURE.md §3.1.
//
// portal-core oturum tanıtıcıları `Send` ama `!Sync`'tir (içlerinde std mpsc Receiver
// var) → her oturum TEK bir OS thread'inde yaşar: o thread `try_event()` ile olayları
// çeker + komut kanalından girdi/resize/iptal alır (TUI'nin pump döngüsünün aynısı).
// Komut göndericileri (Sender) registry'de tutulur; komut handler'ları oradan yollar.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use portal_core::model::HostId;
use portal_core::{
    Host, SftpEvent, SftpSession, SshEvent, SshSession, SystemEvent, SystemSession, TransferKind,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Bir oturuma (poll thread'ine) gönderilen komut. Her thread yalnız kendi türüne
/// uygun varyantları işler; gerisini yok sayar.
pub enum GuiCmd {
    /// Shell'e girdi baytları.
    Input(Vec<u8>),
    /// PTY yeniden boyutlandır.
    Resize { cols: u16, rows: u16 },
    /// Host-key kararı (kabul/ret) — bekleyen responder'a iletilir.
    HostKey(bool),
    /// SFTP: dizin listele.
    List(String),
    /// SFTP: yükle (yerel → uzak).
    Upload { local: PathBuf, remote: String },
    /// SFTP: indir (uzak → yerel).
    Download { remote: String, local: PathBuf },
    /// SFTP: transfer iptal.
    Cancel(u64),
    /// SFTP: uzak dizin oluştur.
    Mkdir(String),
    /// SFTP: uzak dosya/dizini yeniden adlandır (taşı).
    Rename { from: String, to: String },
    /// SFTP: uzak dosyayı sil.
    RemoveFile(String),
    /// SFTP: uzak (boş) dizini sil.
    RemoveDir(String),
    /// Oturumu kapat (thread biter).
    Close,
}

/// Registry'de tutulan oturum kaydı: poll thread'ine komut göndericisi + metadata.
pub struct SessionHandle {
    /// Poll thread'ine komut kanalı.
    pub cmd_tx: Sender<GuiCmd>,
    /// Oturum türü ("shell" / "files" / "monitor") — tanı/görünüm için.
    pub kind: &'static str,
    /// Ait olduğu host.
    pub host_id: HostId,
}

/// Açık oturumların kayıt defteri (AppState içinde Mutex arkasında).
#[derive(Default)]
pub struct Registry {
    /// id → kayıt.
    pub sessions: HashMap<u64, SessionHandle>,
    /// Sıradaki oturum kimliği.
    pub next_id: u64,
}

// ── Bir host'tan Endpoint kur (doğrudan bağlantı; jump = GUI v1.1) ────────────

/// Bir host + toplanan kimlikten doğrudan bir `Endpoint` kurar. Jump host GUI
/// v1.1'e ertelendi (lean çekirdek pivotu) → burada daima doğrudan bağlanılır.
#[must_use]
pub fn endpoint_for(
    host: &Host,
    auth: portal_core::AuthChoice,
    known_hosts: PathBuf,
) -> portal_core::Endpoint {
    portal_core::Endpoint {
        host: host.address.clone(),
        port: host.port,
        username: host.username.clone().unwrap_or_else(|| "root".to_string()),
        auth,
        known_hosts_path: known_hosts,
        jump: None,
        forward_agent: host.forward_agent,
    }
}

// ── Olay yükleri (webview'e Tauri emit) ──────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ShellMsg {
    HostKey {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        changed: bool,
    },
    Connected,
    /// Ham shell çıktısı, base64 (UTF-8 sınırı bozulmasın diye baytlar korunur).
    Output {
        data: String,
    },
    Disconnected {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize, Clone)]
struct EntryDto {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SftpMsg {
    HostKey {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        changed: bool,
    },
    Ready,
    Listing {
        path: String,
        entries: Vec<EntryDto>,
    },
    ListError {
        path: String,
        message: String,
    },
    TransferQueued {
        id: u64,
        kind: String,
        name: String,
        total: u64,
    },
    TransferProgress {
        id: u64,
        transferred: u64,
    },
    TransferDone {
        id: u64,
    },
    TransferFailed {
        id: u64,
        message: String,
    },
    TransferCancelled {
        id: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcDto {
    pid: u32,
    user: String,
    cpu: f64,
    mem: f64,
    command: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskDto {
    filesystem: String,
    mount: String,
    used_kb: u64,
    total_kb: u64,
    pct: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MetricsPayload {
    cpu_pct: f64,
    mem_used_kb: u64,
    mem_total_kb: u64,
    mem_pct: f64,
    disk_used_kb: u64,
    disk_total_kb: u64,
    disk_pct: f64,
    net_rx_bps: u64,
    net_tx_bps: u64,
    load1: f64,
    load5: f64,
    load15: f64,
    cores: u32,
    processes: u64,
    uptime: String,
    top_processes: Vec<ProcDto>,
    disks: Vec<DiskDto>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum MetricsMsg {
    HostKey {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        changed: bool,
    },
    Update {
        metrics: MetricsPayload,
    },
    Error {
        message: String,
    },
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ── Poll thread'leri (her oturum türü için bir tane) ──────────────────────────

/// Shell oturumunu süren thread: olayları `portal://ssh/{id}` kanalına yayar,
/// girdi/resize/host-key/kapat komutlarını işler.
pub fn spawn_shell(app: AppHandle, id: u64, session: SshSession, cmd_rx: Receiver<GuiCmd>) {
    let channel = format!("portal://ssh/{id}");
    thread::spawn(move || {
        // Bekleyen host-key yanıtlayıcısı (kullanıcı kararına kadar tutulur). Tip
        // çıkarımla adlandırılır (portal_core::ssh::HostKeyResponder dışa aktarılmamış).
        let mut pending_hk = None;
        loop {
            let mut idle = true;
            while let Some(ev) = session.try_event() {
                idle = false;
                match ev {
                    SshEvent::HostKey(info, responder) => {
                        pending_hk = Some(responder);
                        emit(
                            &app,
                            &channel,
                            ShellMsg::HostKey {
                                host: info.host,
                                port: info.port,
                                key_type: info.key_type,
                                fingerprint: info.fingerprint,
                                changed: info.changed,
                            },
                        );
                    }
                    SshEvent::Connected => emit(&app, &channel, ShellMsg::Connected),
                    SshEvent::Output(bytes) => {
                        emit(&app, &channel, ShellMsg::Output { data: b64(&bytes) });
                    }
                    SshEvent::Disconnected(message) => {
                        emit(&app, &channel, ShellMsg::Disconnected { message });
                    }
                    SshEvent::Error(message) => emit(&app, &channel, ShellMsg::Error { message }),
                }
            }
            match cmd_rx.try_recv() {
                Ok(GuiCmd::Input(bytes)) => session.send_input(&bytes),
                Ok(GuiCmd::Resize { cols, rows }) => session.resize(cols, rows),
                Ok(GuiCmd::HostKey(accept)) => {
                    if let Some(r) = pending_hk.take() {
                        r.respond(accept);
                    }
                }
                Ok(GuiCmd::Close) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    session.close();
                    break;
                }
                _ => {}
            }
            if idle {
                thread::sleep(Duration::from_millis(6));
            }
        }
    });
}

/// SFTP oturumunu süren thread: `portal://sftp/{id}` kanalına yayar; liste/transfer/
/// iptal/host-key/kapat komutlarını işler.
pub fn spawn_files(app: AppHandle, id: u64, session: SftpSession, cmd_rx: Receiver<GuiCmd>) {
    let channel = format!("portal://sftp/{id}");
    thread::spawn(move || {
        let mut pending_hk = None;
        loop {
            let mut idle = true;
            while let Some(ev) = session.try_event() {
                idle = false;
                match ev {
                    SftpEvent::HostKey(info, responder) => {
                        pending_hk = Some(responder);
                        emit(
                            &app,
                            &channel,
                            SftpMsg::HostKey {
                                host: info.host,
                                port: info.port,
                                key_type: info.key_type,
                                fingerprint: info.fingerprint,
                                changed: info.changed,
                            },
                        );
                    }
                    SftpEvent::Ready => emit(&app, &channel, SftpMsg::Ready),
                    SftpEvent::Listing { path, entries } => {
                        let entries = entries
                            .into_iter()
                            .map(|e| EntryDto {
                                name: e.name,
                                is_dir: e.is_dir,
                                is_symlink: e.is_symlink,
                                size: e.size,
                            })
                            .collect();
                        emit(&app, &channel, SftpMsg::Listing { path, entries });
                    }
                    SftpEvent::ListError { path, message } => {
                        emit(&app, &channel, SftpMsg::ListError { path, message });
                    }
                    SftpEvent::TransferQueued {
                        id: tid,
                        kind,
                        name,
                        total,
                    } => emit(
                        &app,
                        &channel,
                        SftpMsg::TransferQueued {
                            id: tid,
                            kind: match kind {
                                TransferKind::Upload => "upload",
                                TransferKind::Download => "download",
                            }
                            .to_string(),
                            name,
                            total,
                        },
                    ),
                    SftpEvent::TransferProgress {
                        id: tid,
                        transferred,
                    } => emit(
                        &app,
                        &channel,
                        SftpMsg::TransferProgress {
                            id: tid,
                            transferred,
                        },
                    ),
                    SftpEvent::TransferDone { id: tid } => {
                        emit(&app, &channel, SftpMsg::TransferDone { id: tid });
                    }
                    SftpEvent::TransferFailed { id: tid, message } => {
                        emit(&app, &channel, SftpMsg::TransferFailed { id: tid, message });
                    }
                    SftpEvent::TransferCancelled { id: tid } => {
                        emit(&app, &channel, SftpMsg::TransferCancelled { id: tid });
                    }
                    // Yerinde uzak-düzenleme GUI'de henüz yok (P6-C/ileri) → yok say.
                    SftpEvent::RemoteContent { .. } | SftpEvent::WriteDone { .. } => {}
                    SftpEvent::Error(message) => emit(&app, &channel, SftpMsg::Error { message }),
                }
            }
            match cmd_rx.try_recv() {
                Ok(GuiCmd::List(path)) => session.list(&path),
                Ok(GuiCmd::Upload { local, remote }) => session.upload(local, remote),
                Ok(GuiCmd::Download { remote, local }) => session.download(remote, local),
                Ok(GuiCmd::Cancel(tid)) => session.cancel(tid),
                Ok(GuiCmd::Mkdir(path)) => session.mkdir(path),
                Ok(GuiCmd::Rename { from, to }) => session.rename(from, to),
                Ok(GuiCmd::RemoveFile(path)) => session.remove_file(path),
                Ok(GuiCmd::RemoveDir(path)) => session.remove_dir(path),
                Ok(GuiCmd::HostKey(accept)) => {
                    if let Some(r) = pending_hk.take() {
                        r.respond(accept);
                    }
                }
                Ok(GuiCmd::Close) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    session.close();
                    break;
                }
                _ => {}
            }
            if idle {
                thread::sleep(Duration::from_millis(6));
            }
        }
    });
}

/// Sistem oturumunu süren thread: `portal://metrics/{id}` kanalına metrik + top süreç +
/// disk listesi yayar (portal-core `SystemSession`).
pub fn spawn_system(app: AppHandle, id: u64, session: SystemSession, cmd_rx: Receiver<GuiCmd>) {
    let channel = format!("portal://metrics/{id}");
    thread::spawn(move || {
        let mut pending_hk = None;
        loop {
            let mut idle = true;
            while let Some(ev) = session.try_event() {
                idle = false;
                match ev {
                    SystemEvent::HostKey(info, responder) => {
                        pending_hk = Some(responder);
                        emit(
                            &app,
                            &channel,
                            MetricsMsg::HostKey {
                                host: info.host,
                                port: info.port,
                                key_type: info.key_type,
                                fingerprint: info.fingerprint,
                                changed: info.changed,
                            },
                        );
                    }
                    SystemEvent::Update(r) => {
                        let m = &r.metrics;
                        let metrics = MetricsPayload {
                            cpu_pct: m.cpu_pct,
                            mem_used_kb: m.mem_used_kb,
                            mem_total_kb: m.mem_total_kb,
                            mem_pct: m.mem_pct(),
                            disk_used_kb: m.disk_used_kb,
                            disk_total_kb: m.disk_total_kb,
                            disk_pct: m.disk_pct(),
                            net_rx_bps: m.net_rx_bps,
                            net_tx_bps: m.net_tx_bps,
                            load1: m.load.0,
                            load5: m.load.1,
                            load15: m.load.2,
                            cores: m.cores,
                            processes: m.processes,
                            uptime: m.uptime.clone(),
                            top_processes: r
                                .processes
                                .iter()
                                .map(|p| ProcDto {
                                    pid: p.pid,
                                    user: p.user.clone(),
                                    cpu: p.cpu,
                                    mem: p.mem,
                                    command: p.command.clone(),
                                })
                                .collect(),
                            disks: r
                                .disks
                                .iter()
                                .map(|d| DiskDto {
                                    filesystem: d.filesystem.clone(),
                                    mount: d.mount.clone(),
                                    used_kb: d.used_kb,
                                    total_kb: d.total_kb,
                                    pct: d.pct(),
                                })
                                .collect(),
                        };
                        emit(&app, &channel, MetricsMsg::Update { metrics });
                    }
                    SystemEvent::Error(message) => {
                        emit(&app, &channel, MetricsMsg::Error { message });
                    }
                }
            }
            match cmd_rx.try_recv() {
                Ok(GuiCmd::HostKey(accept)) => {
                    if let Some(r) = pending_hk.take() {
                        r.respond(accept);
                    }
                }
                Ok(GuiCmd::Close) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                _ => {}
            }
            if idle {
                thread::sleep(Duration::from_millis(40));
            }
        }
    });
}

fn emit<S: Serialize + Clone>(app: &AppHandle, channel: &str, payload: S) {
    let _ = app.emit(channel, payload);
}

// ── Yerel dosya sistemi (This PC paneli) ─────────────────────────────────────

/// Yerel dizin listesi (Files panelinin "This PC" tarafı).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    /// Normalize edilmiş mutlak yol.
    pub path: String,
    /// Üst dizin (kök ise None).
    pub parent: Option<String>,
    /// Girişler.
    pub entries: Vec<LocalEntry>,
}

/// Yerel bir dosya/dizin girişi.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    /// Ad.
    pub name: String,
    /// Tam yol.
    pub path: String,
    /// Dizin mi.
    pub is_dir: bool,
    /// Boyut (bayt).
    pub size: u64,
}

/// Bir yerel dizini listeler (sıralı: önce klasörler). Yol boşsa kullanıcı home'u.
pub fn list_local(path: &str) -> Result<LocalListing, String> {
    let dir = if path.trim().is_empty() {
        local_home_path()
    } else {
        PathBuf::from(path)
    };
    let mut entries: Vec<LocalEntry> = Vec::new();
    let read =
        std::fs::read_dir(&dir).map_err(|e| format!("Couldn't open {}: {e}", dir.display()))?;
    for item in read.flatten() {
        let meta = item.metadata();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        entries.push(LocalEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir,
            size,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(LocalListing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Kullanıcı home dizini (Files "This PC" başlangıcı).
#[must_use]
pub fn local_home() -> String {
    local_home_path().to_string_lossy().into_owned()
}

fn local_home_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}
