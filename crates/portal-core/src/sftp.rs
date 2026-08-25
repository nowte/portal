//! SFTP oturumu (russh-sftp): uzak listeleme + parçalı transfer (ilerleme/iptal).
//!
//! Yalnız UZAK taraf burada; yerel dosya listeleme UI'de (std::fs). Kimlik/host-key
//! ön adımı [`crate::ssh::establish`] ile paylaşılır. Her transfer kendi SFTP kanalını
//! açar (aynı bağlantı üzerinde), böylece büyük transfer sırasında listeleme/iptal akar.
//!
//! Faz 2-A: bağlantı özellik-başına (P5 multiplexing bunu tek bağlantıya indirir).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;

use russh_sftp::client::SftpSession as RawSftp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc as tokio_mpsc;

use crate::ssh::{establish, Established, HostKeyInfo, HostKeyResponder, HostKeySink};

const CHUNK: usize = 32 * 1024;
const PROGRESS_STEP: u64 = 128 * 1024;

/// Bir dizindeki dosya/dizin girişi (uzak taraf).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Dosya/dizin adı.
    pub name: String,
    /// Dizin mi.
    pub is_dir: bool,
    /// Sembolik bağlantı mı.
    pub is_symlink: bool,
    /// Boyut (bayt).
    pub size: u64,
}

/// Transfer yönü.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferKind {
    /// Yerel → uzak.
    Upload,
    /// Uzak → yerel.
    Download,
}

/// Transfer kimliği.
pub type TransferId = u64;

/// SFTP oturumundan UI'ye olaylar.
pub enum SftpEvent {
    /// Bilinmeyen host anahtarı (öğretme katmanı).
    HostKey(HostKeyInfo, HostKeyResponder),
    /// SFTP hazır.
    Ready,
    /// Dizin listesi.
    Listing {
        /// Listelenen yol.
        path: String,
        /// Girişler.
        entries: Vec<FileEntry>,
    },
    /// Listeleme hatası.
    ListError {
        /// Yol.
        path: String,
        /// Hata.
        message: String,
    },
    /// Transfer kuyruğa alındı.
    TransferQueued {
        /// Kimlik.
        id: TransferId,
        /// Yön.
        kind: TransferKind,
        /// Görünen ad.
        name: String,
        /// Toplam bayt (0 = bilinmiyor).
        total: u64,
    },
    /// Transfer ilerlemesi.
    TransferProgress {
        /// Kimlik.
        id: TransferId,
        /// Aktarılan bayt.
        transferred: u64,
    },
    /// Transfer tamamlandı.
    TransferDone {
        /// Kimlik.
        id: TransferId,
    },
    /// Transfer başarısız.
    TransferFailed {
        /// Kimlik.
        id: TransferId,
        /// Hata.
        message: String,
    },
    /// Transfer iptal edildi.
    TransferCancelled {
        /// Kimlik.
        id: TransferId,
    },
    /// Uzak dosya içeriği (yerinde düzenleme için).
    RemoteContent {
        /// Yol.
        path: String,
        /// İçerik.
        bytes: Vec<u8>,
    },
    /// Uzak dosya yazıldı.
    WriteDone {
        /// Yol.
        path: String,
    },
    /// Genel hata.
    Error(String),
}

enum SftpCommand {
    List(String),
    Upload { local: PathBuf, remote: String },
    Download { remote: String, local: PathBuf },
    Cancel(TransferId),
    ReadRemote(String),
    WriteRemote { path: String, bytes: Vec<u8> },
    Mkdir(String),
    Rename { from: String, to: String },
    RemoveFile(String),
    RemoveDir(String),
    Close,
}

/// UI'nin tuttuğu SFTP oturum tanıtıcısı (senkron). Drop → kapatır.
pub struct SftpSession {
    cmd_tx: tokio_mpsc::UnboundedSender<SftpCommand>,
    event_rx: std_mpsc::Receiver<SftpEvent>,
}

impl SftpSession {
    /// Bekleyen bir olayı alır (bloklamaz).
    #[must_use]
    pub fn try_event(&self) -> Option<SftpEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Uzak dizini listeler.
    pub fn list(&self, path: &str) {
        let _ = self.cmd_tx.send(SftpCommand::List(path.to_string()));
    }

    /// Yerel dosyayı uzağa yükler.
    pub fn upload(&self, local: PathBuf, remote: String) {
        let _ = self.cmd_tx.send(SftpCommand::Upload { local, remote });
    }

    /// Uzak dosyayı yerele indirir.
    pub fn download(&self, remote: String, local: PathBuf) {
        let _ = self.cmd_tx.send(SftpCommand::Download { remote, local });
    }

    /// Bir transferi iptal eder.
    pub fn cancel(&self, id: TransferId) {
        let _ = self.cmd_tx.send(SftpCommand::Cancel(id));
    }

    /// Uzak dosyayı okur (yerinde düzenleme için).
    pub fn read_remote(&self, path: &str) {
        let _ = self.cmd_tx.send(SftpCommand::ReadRemote(path.to_string()));
    }

    /// Uzak dosyayı yazar (düzenleme kaydı).
    pub fn write_remote(&self, path: String, bytes: Vec<u8>) {
        let _ = self.cmd_tx.send(SftpCommand::WriteRemote { path, bytes });
    }

    /// Uzak dizin oluşturur. Başarıda üst dizin yeniden listelenir.
    pub fn mkdir(&self, path: String) {
        let _ = self.cmd_tx.send(SftpCommand::Mkdir(path));
    }

    /// Uzak dosya/dizini yeniden adlandırır (taşır).
    pub fn rename(&self, from: String, to: String) {
        let _ = self.cmd_tx.send(SftpCommand::Rename { from, to });
    }

    /// Uzak dosyayı siler.
    pub fn remove_file(&self, path: String) {
        let _ = self.cmd_tx.send(SftpCommand::RemoveFile(path));
    }

    /// Uzak (boş) dizini siler.
    pub fn remove_dir(&self, path: String) {
        let _ = self.cmd_tx.send(SftpCommand::RemoveDir(path));
    }

    /// Oturumu kapatır.
    pub fn close(&self) {
        let _ = self.cmd_tx.send(SftpCommand::Close);
    }
}

impl Drop for SftpSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl crate::ssh::SshRuntime {
    /// Yeni bir SFTP oturumu başlatır (bloklamaz).
    #[must_use]
    pub fn connect_sftp(&self, endpoint: crate::ssh::Endpoint) -> SftpSession {
        let (event_tx, event_rx) = std_mpsc::channel();
        let (cmd_tx, cmd_rx) = tokio_mpsc::unbounded_channel();
        let task_tx = event_tx.clone();
        self.handle().spawn(async move {
            if let Err(err) = run_sftp(endpoint, task_tx.clone(), cmd_rx).await {
                let _ = task_tx.send(SftpEvent::Error(err));
            }
        });
        SftpSession { cmd_tx, event_rx }
    }
}

async fn run_sftp(
    endpoint: crate::ssh::Endpoint,
    event_tx: std_mpsc::Sender<SftpEvent>,
    mut cmd_rx: tokio_mpsc::UnboundedReceiver<SftpCommand>,
) -> Result<(), String> {
    let hk_tx = event_tx.clone();
    let on_unknown_key: HostKeySink = Arc::new(move |info, responder| {
        let _ = hk_tx.send(SftpEvent::HostKey(info, responder));
    });

    let Established { handle, _jump } = establish(
        &endpoint.host,
        endpoint.port,
        &endpoint.username,
        &endpoint.auth,
        &endpoint.known_hosts_path,
        on_unknown_key,
        endpoint.jump.as_ref(),
    )
    .await?;

    let sftp = open_sftp(&handle).await?;
    let _ = event_tx.send(SftpEvent::Ready);

    let mut cancels: HashMap<TransferId, Arc<AtomicBool>> = HashMap::new();
    let mut next_id: TransferId = 1;

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SftpCommand::List(path) => send_listing(&sftp, path, &event_tx).await,
            SftpCommand::Upload { local, remote } => {
                let id = next_id;
                next_id += 1;
                let total = tokio::fs::metadata(&local)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                let name = file_name(&remote);
                let _ = event_tx.send(SftpEvent::TransferQueued {
                    id,
                    kind: TransferKind::Upload,
                    name,
                    total,
                });
                match open_sftp(&handle).await {
                    Ok(xfer) => {
                        let cancel = Arc::new(AtomicBool::new(false));
                        cancels.insert(id, cancel.clone());
                        let etx = event_tx.clone();
                        tokio::spawn(async move {
                            upload_task(xfer, local, remote, id, cancel, etx).await;
                        });
                    }
                    Err(e) => {
                        let _ = event_tx.send(SftpEvent::TransferFailed { id, message: e });
                    }
                }
            }
            SftpCommand::Download { remote, local } => {
                let id = next_id;
                next_id += 1;
                let total = sftp
                    .metadata(remote.clone())
                    .await
                    .ok()
                    .and_then(|m| m.size)
                    .unwrap_or(0);
                let name = file_name(&remote);
                let _ = event_tx.send(SftpEvent::TransferQueued {
                    id,
                    kind: TransferKind::Download,
                    name,
                    total,
                });
                match open_sftp(&handle).await {
                    Ok(xfer) => {
                        let cancel = Arc::new(AtomicBool::new(false));
                        cancels.insert(id, cancel.clone());
                        let etx = event_tx.clone();
                        tokio::spawn(async move {
                            download_task(xfer, remote, local, id, cancel, etx).await;
                        });
                    }
                    Err(e) => {
                        let _ = event_tx.send(SftpEvent::TransferFailed { id, message: e });
                    }
                }
            }
            SftpCommand::Cancel(id) => {
                if let Some(flag) = cancels.get(&id) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            SftpCommand::ReadRemote(path) => match sftp.read(path.clone()).await {
                Ok(bytes) => {
                    let _ = event_tx.send(SftpEvent::RemoteContent { path, bytes });
                }
                Err(e) => {
                    let _ = event_tx.send(SftpEvent::Error(format!("Read failed: {e}")));
                }
            },
            SftpCommand::WriteRemote { path, bytes } => {
                match sftp.write(path.clone(), &bytes).await {
                    Ok(()) => {
                        let _ = event_tx.send(SftpEvent::WriteDone { path });
                    }
                    Err(e) => {
                        let _ = event_tx.send(SftpEvent::Error(format!("Write failed: {e}")));
                    }
                }
            }
            // Dosya işlemleri: başarıda üst dizini tazele; hatada (yeni varyant eklemeden,
            // TUI'yi bozmamak için) o dizin için ListError yayınla (UI'de yıkıcı olmayan
            // satır-içi uyarı olarak görünür).
            SftpCommand::Mkdir(path) => match sftp.create_dir(path.clone()).await {
                Ok(()) => send_listing(&sftp, parent_of(&path), &event_tx).await,
                Err(e) => op_error(&event_tx, &path, format!("Couldn't create folder: {e}")),
            },
            SftpCommand::Rename { from, to } => match sftp.rename(from.clone(), to.clone()).await {
                Ok(()) => send_listing(&sftp, parent_of(&to), &event_tx).await,
                Err(e) => op_error(&event_tx, &from, format!("Couldn't rename: {e}")),
            },
            SftpCommand::RemoveFile(path) => match sftp.remove_file(path.clone()).await {
                Ok(()) => send_listing(&sftp, parent_of(&path), &event_tx).await,
                Err(e) => op_error(&event_tx, &path, format!("Couldn't delete: {e}")),
            },
            SftpCommand::RemoveDir(path) => match sftp.remove_dir(path.clone()).await {
                Ok(()) => send_listing(&sftp, parent_of(&path), &event_tx).await,
                Err(e) => op_error(&event_tx, &path, format!("Couldn't delete folder: {e}")),
            },
            SftpCommand::Close => break,
        }
    }
    Ok(())
}

/// Bir uzak dizini listeler ve `Listing`/`ListError` yayınlar. Boş yol = home (".").
/// List komutu ve dosya-işlemi başarıları bunu paylaşır (kod tekrarı yok).
async fn send_listing(sftp: &RawSftp, path: String, event_tx: &std_mpsc::Sender<SftpEvent>) {
    let query = if path.is_empty() {
        ".".to_string()
    } else {
        path.clone()
    };
    let dir = match sftp.read_dir(query.clone()).await {
        Ok(d) => d,
        Err(e) => {
            let _ = event_tx.send(SftpEvent::ListError {
                path,
                message: e.to_string(),
            });
            return;
        }
    };
    let base = query.trim_end_matches('/');
    let mut entries: Vec<FileEntry> = Vec::new();
    for e in dir {
        let ft = e.file_type();
        let name = e.file_name();
        let is_symlink = ft.is_symlink();
        let mut is_dir = ft.is_dir();
        // Bazı SFTP sunucuları readdir yanıtında izin/tip bitlerini göndermez → tip
        // "Other" gelir ve klasör dosya gibi görünürdü. Belirsiz kalırsa stat ile çöz
        // (OpenSSH bitleri gönderir → bu yol hiç çalışmaz, ek maliyet yok).
        if !is_dir && !is_symlink && !ft.is_file() {
            let full = if base == "." {
                name.clone()
            } else {
                format!("{base}/{name}")
            };
            if let Ok(meta) = sftp.metadata(full).await {
                is_dir = meta.is_dir();
            }
        }
        let size = e.metadata().size.unwrap_or(0);
        entries.push(FileEntry {
            name,
            is_dir,
            is_symlink,
            size,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    let _ = event_tx.send(SftpEvent::Listing { path, entries });
}

/// Bir dosya-işlemi hatasını, etkilenen ögenin ÜST dizinine bağlı yıkıcı-olmayan bir
/// `ListError` olarak yayınlar (fatal `Error` değil → UI listeyi kaybetmez).
fn op_error(event_tx: &std_mpsc::Sender<SftpEvent>, target: &str, message: String) {
    let _ = event_tx.send(SftpEvent::ListError {
        path: parent_of(target),
        message,
    });
}

/// Home-göreli bir yolun üst dizini ("foo/bar/x" → "foo/bar"; "x" → "").
fn parent_of(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(i) => trimmed[..i].to_string(),
        None => String::new(),
    }
}

/// Verilen bağlantı üzerinde yeni bir SFTP alt-sistem kanalı açar.
async fn open_sftp(
    handle: &russh::client::Handle<crate::ssh::ClientHandler>,
) -> Result<RawSftp, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Couldn't open channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Couldn't start the SFTP subsystem: {e}"))?;
    RawSftp::new(channel.into_stream())
        .await
        .map_err(|e| format!("Couldn't establish the SFTP session: {e}"))
}

async fn upload_task(
    sftp: RawSftp,
    local: PathBuf,
    remote: String,
    id: TransferId,
    cancel: Arc<AtomicBool>,
    etx: std_mpsc::Sender<SftpEvent>,
) {
    let mut local_file = match tokio::fs::File::open(&local).await {
        Ok(f) => f,
        Err(e) => {
            let _ = etx.send(SftpEvent::TransferFailed {
                id,
                message: format!("Couldn't open local file: {e}"),
            });
            return;
        }
    };
    let mut remote_file = match sftp.create(remote).await {
        Ok(f) => f,
        Err(e) => {
            let _ = etx.send(SftpEvent::TransferFailed {
                id,
                message: format!("Couldn't create remote file: {e}"),
            });
            return;
        }
    };
    copy_loop(&mut local_file, &mut remote_file, id, &cancel, &etx).await;
}

async fn download_task(
    sftp: RawSftp,
    remote: String,
    local: PathBuf,
    id: TransferId,
    cancel: Arc<AtomicBool>,
    etx: std_mpsc::Sender<SftpEvent>,
) {
    let mut remote_file = match sftp.open(remote).await {
        Ok(f) => f,
        Err(e) => {
            let _ = etx.send(SftpEvent::TransferFailed {
                id,
                message: format!("Couldn't open remote file: {e}"),
            });
            return;
        }
    };
    let mut local_file = match tokio::fs::File::create(&local).await {
        Ok(f) => f,
        Err(e) => {
            let _ = etx.send(SftpEvent::TransferFailed {
                id,
                message: format!("Couldn't create local file: {e}"),
            });
            return;
        }
    };
    copy_loop(&mut remote_file, &mut local_file, id, &cancel, &etx).await;
}

/// Parçalı kopyalama; iptal bayrağını kontrol eder, ilerleme yayınlar.
async fn copy_loop<R, W>(
    reader: &mut R,
    writer: &mut W,
    id: TransferId,
    cancel: &AtomicBool,
    etx: &std_mpsc::Sender<SftpEvent>,
) where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = etx.send(SftpEvent::TransferCancelled { id });
            return;
        }
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = etx.send(SftpEvent::TransferFailed {
                    id,
                    message: format!("Read error: {e}"),
                });
                return;
            }
        };
        if let Err(e) = writer.write_all(&buf[..n]).await {
            let _ = etx.send(SftpEvent::TransferFailed {
                id,
                message: format!("Write error: {e}"),
            });
            return;
        }
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            let _ = etx.send(SftpEvent::TransferProgress {
                id,
                transferred: done,
            });
        }
    }
    if writer.flush().await.is_err() {
        let _ = etx.send(SftpEvent::TransferFailed {
            id,
            message: "Flush error".to_string(),
        });
        return;
    }
    let _ = etx.send(SftpEvent::TransferProgress {
        id,
        transferred: done,
    });
    let _ = etx.send(SftpEvent::TransferDone { id });
}

/// Bir yoldan (uzak veya yerel) son bileşeni (dosya adı) döndürür.
fn file_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return path.to_string();
    }
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_extracts_last_component() {
        assert_eq!(file_name("/srv/app/.env"), ".env");
        assert_eq!(file_name("C:\\Users\\a\\file.txt"), "file.txt");
        assert_eq!(file_name("plain"), "plain");
        assert_eq!(file_name("/trailing/"), "trailing");
    }

    #[test]
    fn parent_of_derives_containing_dir() {
        assert_eq!(parent_of("foo/bar/item"), "foo/bar");
        assert_eq!(parent_of("item"), "");
        assert_eq!(parent_of("foo/"), "");
        assert_eq!(parent_of("a/b/"), "a");
        assert_eq!(parent_of(""), "");
    }
}
