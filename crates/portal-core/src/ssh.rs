//! russh tabanlı SSH oturumu (PTY + interaktif shell).
//!
//! Tüm async burada durur; UI (portal-tui) yalnızca sync [`SshSession`] tanıtıcısını
//! kullanır — tokio UI'ye sızmaz. Terminal emülasyonu (vt-parse) UI'de yapılır;
//! bu katman yalnızca ham bayt borusu + PTY kontrolüdür (docs/ARCHITECTURE.md §7).
//!
//! Faz 1-B: tek interaktif shell. Kimlik bilgisi (şifre/anahtar) bağlanma anında
//! toplanır, kalıcı DEĞİL (vault Faz 2). known_hosts güveni diske yazılır.

use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handler};
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::{mpsc as tokio_mpsc, oneshot};

/// PTY boyutu (sütun × satır).
#[derive(Debug, Clone, Copy)]
pub struct PtySize {
    /// Sütun sayısı.
    pub cols: u16,
    /// Satır sayısı.
    pub rows: u16,
}

/// Bağlanma anında toplanan kimlik doğrulama seçimi (kalıcı değil).
///
/// Sırlar (şifre/passphrase) bellekte kalırken tutulur ama **drop anında sıfırlanır**
/// (`ZeroizeOnDrop`) — böylece `cached_creds`'ten bir kayıt silinince ya da uygulama
/// kapanınca bellekte iz kalmaz (P6-D #2). Yol sır değildir, sıfırlanmaz.
#[derive(Clone, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub enum AuthChoice {
    /// Şifre.
    Password(String),
    /// Özel anahtar dosyası (+ opsiyonel passphrase).
    KeyFile {
        /// Anahtar dosyasının yolu (sır değil → sıfırlanmaz).
        #[zeroize(skip)]
        path: PathBuf,
        /// Passphrase (varsa).
        passphrase: Option<String>,
    },
}

/// Bir jump host (bastion) üzerinden atlama bilgisi (P5e).
#[derive(Clone)]
pub struct JumpHop {
    /// Bastion adresi.
    pub host: String,
    /// Bastion portu.
    pub port: u16,
    /// Bastion kullanıcı adı.
    pub username: String,
    /// Bastion kimlik doğrulaması.
    pub auth: AuthChoice,
}

/// Bir host'a bağlanmak için gereken kimlik/adres bilgisi (shell/sftp/metrics ortak).
#[derive(Clone)]
pub struct Endpoint {
    /// Host adresi.
    pub host: String,
    /// Port.
    pub port: u16,
    /// Kullanıcı adı.
    pub username: String,
    /// Kimlik doğrulama.
    pub auth: AuthChoice,
    /// known_hosts dosya yolu.
    pub known_hosts_path: PathBuf,
    /// Üzerinden atlanacak jump host; boşsa doğrudan bağlanılır (P5e).
    pub jump: Option<JumpHop>,
    /// Yerel ssh-agent'ı bu host'a forward et (yalnız güvenilen host).
    pub forward_agent: bool,
}

/// Bir interaktif shell oturumu için parametreler.
pub struct ConnectParams {
    /// Bağlantı bilgisi.
    pub endpoint: Endpoint,
    /// Başlangıç PTY boyutu.
    pub pty: PtySize,
}

/// Bilinmeyen (ya da DEĞİŞMİŞ) host anahtarı bilgisi — öğretme katmanı için.
#[derive(Debug, Clone)]
pub struct HostKeyInfo {
    /// Host.
    pub host: String,
    /// Port.
    pub port: u16,
    /// Anahtar tipi, ör. "ssh-ed25519".
    pub key_type: String,
    /// SHA256 fingerprint, ör. "SHA256:...".
    pub fingerprint: String,
    /// `true` = host daha önce güvenilmişti ama anahtar **DEĞİŞTİ** (olası MITM) →
    /// bilinmeyen anahtardan farklı, güçlü bir uyarı gösterilmeli. `false` = ilk
    /// kez görülen bilinmeyen host (P6-D #5).
    pub changed: bool,
}

/// Host anahtarı kararını (kabul/ret) handshake'e geri ileten yanıtlayıcı.
pub struct HostKeyResponder {
    tx: oneshot::Sender<bool>,
}

impl HostKeyResponder {
    /// Kararı ilet: `true` = güven (known_hosts'a yazılır), `false` = reddet.
    pub fn respond(self, accept: bool) {
        let _ = self.tx.send(accept);
    }
}

/// Oturumdan UI'ye akan olaylar.
pub enum SshEvent {
    /// İlk bağlanışta bilinmeyen host anahtarı — kullanıcıya sorulmalı.
    HostKey(HostKeyInfo, HostKeyResponder),
    /// Shell açıldı; oturum hazır.
    Connected,
    /// Shell çıktısı (ham baytlar).
    Output(Vec<u8>),
    /// Oturum normal şekilde kapandı (sebep/çıkış).
    Disconnected(String),
    /// Hata (bağlanamadı, kimlik reddi, vb.).
    Error(String),
}

enum SessionInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// UI'nin tuttuğu oturum tanıtıcısı. Drop → oturumu kapatır.
pub struct SshSession {
    input_tx: tokio_mpsc::UnboundedSender<SessionInput>,
    event_rx: std_mpsc::Receiver<SshEvent>,
    cancel: Cancel,
}

impl SshSession {
    /// Bekleyen bir olayı (varsa) alır; bloklamaz.
    #[must_use]
    pub fn try_event(&self) -> Option<SshEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Shell'e girdi baytları gönderir.
    pub fn send_input(&self, bytes: &[u8]) {
        let _ = self.input_tx.send(SessionInput::Data(bytes.to_vec()));
    }

    /// PTY'yi yeniden boyutlandırır.
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.input_tx.send(SessionInput::Resize { cols, rows });
    }

    /// Oturumu kapatır. Henüz bağlanmadıysa el sıkışmayı da keser.
    pub fn close(&self) {
        self.cancel.fire();
        let _ = self.input_tx.send(SessionInput::Close);
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// SSH oturumlarını süren tokio runtime'ı. Uygulama başına bir tane.
pub struct SshRuntime {
    rt: tokio::runtime::Runtime,
}

impl SshRuntime {
    /// Çok iş parçacıklı bir runtime kurar.
    ///
    /// # Errors
    /// Runtime kurulamazsa I/O hatası döner.
    pub fn new() -> std::io::Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Self { rt })
    }

    /// Yeni bir interaktif shell oturumu başlatır (bloklamaz).
    #[must_use]
    pub fn connect(&self, params: ConnectParams) -> SshSession {
        let (event_tx, event_rx) = std_mpsc::channel();
        let (input_tx, input_rx) = tokio_mpsc::unbounded_channel();
        let task_tx = event_tx.clone();
        let cancel = Cancel::default();
        let task_cancel = cancel.clone();
        self.rt.spawn(async move {
            if let Err(err) = run_session(params, task_tx.clone(), input_rx, task_cancel).await {
                let _ = task_tx.send(SshEvent::Error(err));
            }
        });
        SshSession {
            input_tx,
            event_rx,
            cancel,
        }
    }

    /// Runtime tanıtıcısı (diğer oturum türleri task spawn'lamak için).
    pub(crate) fn handle(&self) -> &tokio::runtime::Handle {
        self.rt.handle()
    }

    /// Bir private key'i çalışan ssh-agent'a ekler (bloklar; hızlı işlem).
    ///
    /// Agent'a bağlanma platforma göre değişir (Windows: OpenSSH named pipe;
    /// Unix: `SSH_AUTH_SOCK`). Canlı davranış gerçek bir agent gerektirdiği için
    /// doğrulaması kullanıcının manuel adımıdır.
    ///
    /// # Errors
    /// Anahtar yüklenemez, agent'a ulaşılamaz veya ekleme reddedilirse mesaj döner.
    pub fn add_key_to_agent(
        &self,
        key_path: &std::path::Path,
        passphrase: Option<&str>,
    ) -> Result<(), String> {
        let resolved = expand_home(key_path);
        let key = load_secret_key(&resolved, passphrase)
            .map_err(|e| format!("Couldn't load key at {}: {e}", resolved.display()))?;
        self.rt.block_on(add_identity_to_agent(&key))
    }
}

/// Verilen anahtarı platforma uygun ssh-agent'a ekler.
async fn add_identity_to_agent(key: &russh::keys::PrivateKey) -> Result<(), String> {
    use russh::keys::agent::client::AgentClient;

    #[cfg(windows)]
    let mut agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
        .await
        .map_err(|e| format!("Couldn't reach the SSH agent — is it running? ({e})"))?;
    #[cfg(unix)]
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| format!("Couldn't reach the SSH agent — is SSH_AUTH_SOCK set? ({e})"))?;
    #[cfg(not(any(windows, unix)))]
    return Err("SSH agent isn't supported on this platform".to_string());

    #[cfg(any(windows, unix))]
    {
        agent
            .add_identity(key, &[])
            .await
            .map_err(|e| format!("Couldn't add key to agent: {e}"))?;
        Ok(())
    }
}

/// Bilinmeyen host anahtarını kullanıcıya soran geri çağırım. Her oturum türü
/// (shell/sftp/metrics) bunu kendi olay akışına yönlendirir; establish() paylaşılır.
pub(crate) type HostKeySink = Arc<dyn Fn(HostKeyInfo, HostKeyResponder) + Send + Sync>;

pub(crate) struct ClientHandler {
    on_unknown_key: HostKeySink,
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        ) {
            // Bilinen ve eşleşen anahtar → güvenilir.
            Ok(true) => Ok(true),
            // Bilinmeyen host → kullanıcıya sor (öğretme katmanı).
            Ok(false) => {
                let info = HostKeyInfo {
                    host: self.host.clone(),
                    port: self.port,
                    key_type: server_public_key.algorithm().to_string(),
                    fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                    changed: false,
                };
                let (tx, rx) = oneshot::channel();
                (self.on_unknown_key)(info, HostKeyResponder { tx });
                let accept = rx.await.unwrap_or(false);
                if accept {
                    let _ = learn_known_hosts_path(
                        &self.host,
                        self.port,
                        server_public_key,
                        &self.known_hosts_path,
                    );
                }
                Ok(accept)
            }
            // Kayıtlı ama FARKLI anahtar → olası MITM. Sessizce reddetme; kullanıcıya
            // GÜÇLÜ, ayrı bir uyarı göster (changed=true, P6-D #5). Bu turda in-app
            // yeniden-güvenme YOK → kullanıcı uyarıyı görsün diye beklenir ama bağlantı
            // güvenli varsayılan olarak yine reddedilir.
            Err(russh::keys::Error::KeyChanged { .. }) => {
                let info = HostKeyInfo {
                    host: self.host.clone(),
                    port: self.port,
                    key_type: server_public_key.algorithm().to_string(),
                    fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                    changed: true,
                };
                let (tx, rx) = oneshot::channel();
                (self.on_unknown_key)(info, HostKeyResponder { tx });
                let _ = rx.await; // karar ne olursa olsun reddedilir; yalnız uyarı görülsün
                Ok(false)
            }
            // known_hosts okuma/ayrıştırma hatası → reddet.
            Err(_) => Ok(false),
        }
    }
}

/// `~` / `~/...` yolunu kullanıcının home dizinine göre çözer. Diğer yollar aynen
/// kalır. (SSH kullanıcıları anahtarı sıkça `~/.ssh/id_ed25519` olarak yazar.)
pub(crate) fn expand_home(path: &std::path::Path) -> PathBuf {
    let s = path.to_string_lossy();
    let Some(rest) = s.strip_prefix('~') else {
        return path.to_path_buf();
    };
    // Yalnız "~" veya "~/…" / "~\…" — "~user" desteklenmez.
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
        return path.to_path_buf();
    }
    let Some(home) = home_dir() else {
        return path.to_path_buf();
    };
    let rest = rest.trim_start_matches(['/', '\\']);
    if rest.is_empty() {
        home
    } else {
        home.join(rest)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Kurulmuş bir bağlantı. `handle` hedef sunucu; `_jump` varsa bastion bağlantısıdır
/// ve hedef yaşadıkça açık kalmalıdır (drop edilirse tünel kapanır).
pub(crate) struct Established {
    pub handle: client::Handle<ClientHandler>,
    /// Jump host bağlantısı; hedef yaşadıkça açık kalması için tutulur (okunmaz).
    pub _jump: Option<client::Handle<ClientHandler>>,
}

/// Bağlanma sırasında el sıkışmayı yarıda kesen iptal bileti.
///
/// Oturum kapatma komutu normalde komut kanalından gelir, ama bağlanma bitene kadar
/// o kanal HENÜZ OKUNMUYOR: thread TCP/auth bekliyor. Windows'ta ulaşılamayan bir
/// host ~21 sn, bir jump host arkasında 120 sn'ye kadar sürer — kullanıcı o süre
/// boyunca beklemeye mahkum kalırdı. İptal bu yüzden ayrı bir kanaldan gelir.
#[derive(Clone, Default)]
pub(crate) struct Cancel(Arc<tokio::sync::Notify>);

impl Cancel {
    /// İptali tetikler.
    pub(crate) fn fire(&self) {
        // `notify_one` izni SAKLAR: iptal beklemeye başlanmadan önce gelse de yakalanır.
        self.0.notify_one();
    }

    /// İptal gelene kadar bekler.
    async fn wait(&self) {
        self.0.notified().await;
    }
}

/// [`establish`] — ama kullanıcı iptal ederse el sıkışmayı beklemeden `None` döner.
/// shell/sftp/metrics üçü de bunu kullanır: iptal tek yerde tanımlı.
pub(crate) async fn establish_or_cancel(
    endpoint: &Endpoint,
    on_unknown_key: HostKeySink,
    cancel: &Cancel,
) -> Result<Option<Established>, String> {
    tokio::select! {
        r = establish(
            &endpoint.host,
            endpoint.port,
            &endpoint.username,
            &endpoint.auth,
            &endpoint.known_hosts_path,
            on_unknown_key,
            endpoint.jump.as_ref(),
        ) => r.map(Some),
        () = cancel.wait() => Ok(None),
    }
}

/// Bağlanır (host-key + kimlik doğrulama) ve hazır bir bağlantı döndürür. `jump`
/// verilirse önce bastion'a bağlanır, oradan hedefe `direct-tcpip` açar ve o akış
/// üzerinden ikinci bir SSH el sıkışması yapar (ProxyJump). shell/sftp/metrics/tünel
/// ortak ön adımı — kod tekrarını önler.
pub(crate) async fn establish(
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthChoice,
    known_hosts_path: &std::path::Path,
    on_unknown_key: HostKeySink,
    jump: Option<&JumpHop>,
) -> Result<Established, String> {
    let config = Arc::new(client::Config::default());

    let Some(jump) = jump else {
        // Doğrudan bağlantı.
        let handle = connect_and_auth(
            config,
            host,
            port,
            username,
            auth,
            known_hosts_path,
            on_unknown_key,
        )
        .await?;
        return Ok(Established {
            handle,
            _jump: None,
        });
    };

    // 1) Bastion'a bağlan + doğrula.
    let bastion = connect_and_auth(
        config.clone(),
        &jump.host,
        jump.port,
        &jump.username,
        &jump.auth,
        known_hosts_path,
        on_unknown_key.clone(),
    )
    .await
    .map_err(|e| format!("Jump host: {e}"))?;

    // 2) Bastion üzerinden hedefe bir kanal aç.
    let channel = bastion
        .channel_open_direct_tcpip(host.to_string(), u32::from(port), "127.0.0.1", 0)
        .await
        .map_err(|e| format!("Couldn't reach {host}:{port} through the jump host: {e}"))?;

    // 3) Kanal akışı üzerinden hedefe ikinci bir SSH el sıkışması.
    let target_handler = ClientHandler {
        on_unknown_key,
        host: host.to_string(),
        port,
        known_hosts_path: known_hosts_path.to_path_buf(),
    };
    let connect_fut = client::connect_stream(config, channel.into_stream(), target_handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(120), connect_fut).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => return Err(format!("Couldn't connect through the jump host: {e}")),
        Err(_) => return Err("Connection through the jump host timed out.".to_string()),
    };

    // 4) Hedefte kimlik doğrula.
    authenticate(&mut handle, username, auth).await?;
    Ok(Established {
        handle,
        _jump: Some(bastion),
    })
}

/// Doğrudan (adres üzerinden) bağlanır, host-key + kimlik doğrular.
async fn connect_and_auth(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthChoice,
    known_hosts_path: &std::path::Path,
    on_unknown_key: HostKeySink,
) -> Result<client::Handle<ClientHandler>, String> {
    let handler = ClientHandler {
        on_unknown_key,
        host: host.to_string(),
        port,
        known_hosts_path: known_hosts_path.to_path_buf(),
    };

    // Bağlantı için cömert bir üst sınır (backstop). Handshake, host-key onayının
    // beklendiği `check_server_key`'i de içerdiğinden bu süre kullanıcının ilk
    // bağlanışta fingerprint'i okuma süresini de kapsar. Ulaşılamayan host'u OS'in
    // TCP zaman aşımı (Windows'ta ~21 sn) zaten daha önce düşürür.
    let connect_fut = client::connect(config, (host, port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(120), connect_fut).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            return Err(format!(
                "Couldn't connect: {e} — check the address and port."
            ));
        }
        Err(_) => {
            return Err("Connection timed out — is the server reachable?".to_string());
        }
    };
    authenticate(&mut handle, username, auth).await?;
    Ok(handle)
}

/// Bir açık bağlantıda kimlik doğrular (şifre / anahtar dosyası).
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    auth: &AuthChoice,
) -> Result<(), String> {
    let authed = match auth {
        AuthChoice::Password(pw) => handle
            .authenticate_password(username, pw.clone())
            .await
            .map_err(|e| format!("The server refused the sign-in attempt: {e}. Check the username, and the password or key file you picked."))?
            .success(),
        AuthChoice::KeyFile { path, passphrase } => {
            let resolved = expand_home(path);
            let key = load_secret_key(&resolved, passphrase.as_deref())
                .map_err(|e| format!("Couldn't load key at {}: {e}", resolved.display()))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(username, key)
                .await
                .map_err(|e| format!("The server refused the sign-in attempt: {e}. Check the username, and the password or key file you picked."))?
                .success()
        }
    };
    if !authed {
        return Err("Authentication rejected — check the username, password, or key.".to_string());
    }
    Ok(())
}

/// Verilen bağlantıda tek bir komut çalıştırıp stdout+stderr çıktısını toplar.
/// (Sistem izleme metriklerini çekmek için.)
pub(crate) async fn exec_collect(
    handle: &client::Handle<ClientHandler>,
    command: &str,
) -> Result<String, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Signed in, but the server wouldn't open a session channel: {e}. It may be out of sessions or restricted by sshd config — try again, or check the server's MaxSessions."))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("Couldn't run command: {e}"))?;

    let mut out: Vec<u8> = Vec::new();
    let (mut read, _write) = channel.split();
    loop {
        match read.wait().await {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                out.extend_from_slice(&data);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

async fn run_session(
    params: ConnectParams,
    event_tx: std_mpsc::Sender<SshEvent>,
    mut input_rx: tokio_mpsc::UnboundedReceiver<SessionInput>,
    cancel: Cancel,
) -> Result<(), String> {
    // Host-key olayını bu oturumun akışına yönlendir.
    let hk_tx = event_tx.clone();
    let on_unknown_key: HostKeySink = Arc::new(move |info, responder| {
        let _ = hk_tx.send(SshEvent::HostKey(info, responder));
    });

    // İptal edildiyse sessizce biter: kullanıcı zaten vazgeçti, hata göstermeyiz.
    let Some(Established { handle, _jump }) =
        establish_or_cancel(&params.endpoint, on_unknown_key, &cancel).await?
    else {
        return Ok(());
    };

    // Kanal + PTY + shell.
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Signed in, but the server wouldn't open a session channel: {e}. It may be out of sessions or restricted by sshd config — try again, or check the server's MaxSessions."))?;
    // Agent forwarding (yalnız güvenilen host): isteği shell'den önce yap.
    if params.endpoint.forward_agent {
        let _ = channel.agent_forward(true).await;
    }
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(params.pty.cols),
            u32::from(params.pty.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("The server refused to give this session a terminal: {e}. Accounts limited to SFTP-only usually can't open a shell — use the Files panel instead."))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("The server wouldn't start a shell for this account: {e}. Check that the account has a login shell (not /usr/sbin/nologin)."))?;

    let _ = event_tx.send(SshEvent::Connected);

    let (mut read, write) = channel.split();

    loop {
        tokio::select! {
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    let _ = event_tx.send(SshEvent::Output(data.to_vec()));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let _ = event_tx.send(SshEvent::Output(data.to_vec()));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    let _ = event_tx.send(SshEvent::Disconnected(
                        format!("Session closed (exit code {exit_status})"),
                    ));
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    let _ = event_tx.send(SshEvent::Disconnected("Session closed".to_string()));
                    break;
                }
                Some(_) => {}
            },
            input = input_rx.recv() => match input {
                Some(SessionInput::Data(bytes)) => {
                    if write.data_bytes(bytes).await.is_err() {
                        break;
                    }
                }
                Some(SessionInput::Resize { cols, rows }) => {
                    let _ = write
                        .window_change(u32::from(cols), u32::from(rows), 0, 0)
                        .await;
                }
                Some(SessionInput::Close) | None => {
                    let _ = write.eof().await;
                    let _ = handle
                        .disconnect(Disconnect::ByApplication, "", "en")
                        .await;
                    break;
                }
            },
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::path::Path;
    use std::time::Instant;

    // Gerçek çalışan ssh-agent gerektirir → CI'de çalışmaz; agent'ı olan makinede elle:
    //   cargo test -p portal-core add_generated_key_to_agent -- --ignored --nocapture
    #[test]
    #[ignore = "gerçek çalışan ssh-agent gerektirir (elle çalıştır)"]
    fn add_generated_key_to_agent() {
        let dir = tempfile::tempdir().unwrap();
        let gen =
            crate::keys::generate_ed25519(dir.path(), "portal_agent_test", "portal@test", None)
                .unwrap();
        let rt = SshRuntime::new().unwrap();
        rt.add_key_to_agent(&gen.private_path, None).unwrap();
    }

    #[test]
    fn expand_home_resolves_tilde() {
        // "~" olmayan yollar aynen kalır.
        let plain = Path::new("/etc/ssh/key");
        assert_eq!(expand_home(plain), PathBuf::from("/etc/ssh/key"));

        // "~/…" home'a göre çözülür (test için HOME ayarla).
        std::env::set_var("HOME", "/home/tester");
        std::env::remove_var("USERPROFILE");
        assert_eq!(
            expand_home(Path::new("~/.ssh/id_ed25519")),
            PathBuf::from("/home/tester/.ssh/id_ed25519")
        );
        // "~user" desteklenmez → aynen kalır.
        assert_eq!(
            expand_home(Path::new("~alex/key")),
            PathBuf::from("~alex/key")
        );
    }

    /// Kapalı bir porta bağlanmak, runtime + kanal + hata yolunu uçtan uca
    /// doğrular (sunucu gerekmez): `SshEvent::Error` gelmelidir.
    #[test]
    fn connect_to_closed_port_emits_error() {
        // Boş bir port al, dinleyiciyi kapat → port artık kapalı.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let rt = SshRuntime::new().unwrap();
        let session = rt.connect(ConnectParams {
            endpoint: Endpoint {
                host: "127.0.0.1".to_string(),
                port,
                username: "nobody".to_string(),
                auth: AuthChoice::Password("x".to_string()),
                known_hosts_path: std::env::temp_dir().join("portal-test-known_hosts"),
                jump: None,
                forward_agent: false,
            },
            pty: PtySize { cols: 80, rows: 24 },
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got_error = false;
        while Instant::now() < deadline {
            match session.try_event() {
                Some(SshEvent::Error(_)) => {
                    got_error = true;
                    break;
                }
                Some(_) => {}
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        assert!(got_error, "kapalı porta bağlanınca Error beklenir");
    }

    /// Bağlanma SÜRERKEN `close()` çağrılırsa oturum el sıkışmayı beklemeden
    /// biter. Dinleyici bağlantıyı kabul eder ama SSH sürüm satırını hiç
    /// göndermez → el sıkışma asılı kalır (gerçek hayatta: erişilemeyen host,
    /// Windows'ta ~21 sn). İptal çalışmazsa bu test zaman aşımına düşer.
    #[test]
    fn close_during_handshake_ends_the_session() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Kabul edilen soketi tut: kapatılırsa el sıkışma kendiliğinden hata verir
        // ve test iptali değil, kopmayı ölçerdi.
        let held = std::thread::spawn(move || listener.accept().map(|(sock, _)| sock));

        let rt = SshRuntime::new().unwrap();
        let session = rt.connect(ConnectParams {
            endpoint: Endpoint {
                host: "127.0.0.1".to_string(),
                port,
                username: "nobody".to_string(),
                auth: AuthChoice::Password("x".to_string()),
                known_hosts_path: std::env::temp_dir().join("portal-test-known_hosts"),
                jump: None,
                forward_agent: false,
            },
            pty: PtySize { cols: 80, rows: 24 },
        });

        // El sıkışmanın gerçekten başlamasını bekle, sonra iptal et.
        std::thread::sleep(Duration::from_millis(300));
        session.close();

        // Görev bitince olay göndericisi düşer → kanal kopar. Hata YAYILMAMALI:
        // kullanıcı vazgeçti, ekrana kırmızı bir şey basmak yanlış olur.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut ended = false;
        while Instant::now() < deadline {
            match session.try_event() {
                Some(SshEvent::Error(m)) => panic!("iptalde hata beklenmez: {m}"),
                Some(_) => {}
                None => {
                    if matches!(
                        session.event_rx.try_recv(),
                        Err(std_mpsc::TryRecvError::Disconnected)
                    ) {
                        ended = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        drop(held);
        assert!(ended, "close() el sıkışmayı kesmeli, oturum bitmeli");
    }
}
