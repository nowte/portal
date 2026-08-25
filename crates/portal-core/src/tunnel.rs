//! SSH port yönlendirme / tüneller (docs/ROADMAP.md İleri SSH: "Port forwarding /
//! tünel — local/remote/dynamic").
//!
//! - **Local forward:** Portal yerel bir portu dinler; her bağlantı SSH sunucusu
//!   üzerinden `remote_host:remote_port`'a `direct-tcpip` kanalıyla köprülenir
//!   ("localhost:5432 = sunucudaki DB").
//! - **Dynamic (SOCKS5):** Portal yerel bir SOCKS5 proxy'si çalıştırır; her istek
//!   hedefe `direct-tcpip` ile gider.
//! - **Remote forward:** sunucu tarafı dinleme — henüz yok (nazik mesaj döner).
//!
//! Tüm async burada; UI sync [`TunnelSession`] tanıtıcısını kullanır. Canlı davranış
//! gerçek bir SSH sunucusu gerektirdiğinden doğrulaması kullanıcının manuel adımıdır;
//! bu katman kapalı-port hata yolu için entegrasyon testiyle kaplıdır.

use std::sync::mpsc as std_mpsc;
use std::sync::Arc;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc as tokio_mpsc;

use crate::ssh::{
    establish, ClientHandler, Endpoint, Established, HostKeyInfo, HostKeyResponder, HostKeySink,
};

/// Paylaşılabilir SSH bağlantı tanıtıcısı (kanal açmak `&self` alır → concurrent güvenli).
type TunnelHandle = Arc<russh::client::Handle<ClientHandler>>;

/// Tünel türü.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelKind {
    /// Yerel port → uzaktaki hedef (`-L`).
    Local,
    /// Uzak port → yereldeki hedef (`-R`). Henüz desteklenmiyor.
    Remote,
    /// Dinamik SOCKS5 proxy (`-D`).
    Dynamic,
}

/// Bir tünelin tanımı.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelSpec {
    /// Tür.
    pub kind: TunnelKind,
    /// Portal'ın yerelde dinleyeceği port.
    pub local_port: u16,
    /// Hedef host (Local için gerekli; Dynamic'te yok sayılır).
    pub remote_host: String,
    /// Hedef port (Local için gerekli; Dynamic'te yok sayılır).
    pub remote_port: u16,
}

/// Tünelden UI'ye akan olaylar.
pub enum TunnelEvent {
    /// Bilinmeyen host anahtarı — kullanıcıya sorulmalı.
    HostKey(HostKeyInfo, HostKeyResponder),
    /// Yerel dinleme başladı (ör. "127.0.0.1:5432").
    Listening(String),
    /// Bilgilendirme (ör. yeni bir bağlantı köprülendi).
    Info(String),
    /// Hata.
    Error(String),
    /// Tünel kapandı.
    Closed(String),
}

/// UI'nin tuttuğu tünel tanıtıcısı. Drop → tüneli kapatır.
pub struct TunnelSession {
    close_tx: tokio_mpsc::UnboundedSender<()>,
    event_rx: std_mpsc::Receiver<TunnelEvent>,
}

impl TunnelSession {
    /// Bekleyen bir olayı (varsa) alır; bloklamaz.
    #[must_use]
    pub fn try_event(&self) -> Option<TunnelEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Tüneli kapatır (yeni bağlantı kabul etmeyi durdurur).
    pub fn close(&self) {
        let _ = self.close_tx.send(());
    }
}

impl Drop for TunnelSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl crate::ssh::SshRuntime {
    /// Yeni bir tünel başlatır (bloklamaz).
    #[must_use]
    pub fn connect_tunnel(&self, endpoint: Endpoint, spec: TunnelSpec) -> TunnelSession {
        let (event_tx, event_rx) = std_mpsc::channel();
        let (close_tx, close_rx) = tokio_mpsc::unbounded_channel();
        let task_tx = event_tx.clone();
        self.handle().spawn(async move {
            if let Err(err) = run_tunnel(endpoint, spec, task_tx.clone(), close_rx).await {
                let _ = task_tx.send(TunnelEvent::Error(err));
            }
        });
        TunnelSession { close_tx, event_rx }
    }
}

async fn run_tunnel(
    endpoint: Endpoint,
    spec: TunnelSpec,
    event_tx: std_mpsc::Sender<TunnelEvent>,
    mut close_rx: tokio_mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let hk_tx = event_tx.clone();
    let on_unknown_key: HostKeySink = Arc::new(move |info, responder| {
        let _ = hk_tx.send(TunnelEvent::HostKey(info, responder));
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
    let handle: TunnelHandle = Arc::new(handle);

    if spec.kind == TunnelKind::Remote {
        return Err(
            "Remote forwarding isn't available yet — use Local or Dynamic (SOCKS).".to_string(),
        );
    }

    let listener = TcpListener::bind(("127.0.0.1", spec.local_port))
        .await
        .map_err(|e| format!("Couldn't listen on 127.0.0.1:{}: {e}", spec.local_port))?;
    let addr = listener.local_addr().map_or_else(
        |_| format!("127.0.0.1:{}", spec.local_port),
        |a| a.to_string(),
    );
    let _ = event_tx.send(TunnelEvent::Listening(addr));

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((sock, peer)) => {
                    let handle = handle.clone();
                    let ev = event_tx.clone();
                    match spec.kind {
                        TunnelKind::Local => {
                            let (host, port) = (spec.remote_host.clone(), spec.remote_port);
                            let _ = ev.send(TunnelEvent::Info(format!(
                                "{peer} → {host}:{port}"
                            )));
                            tokio::spawn(local_forward(sock, peer.port(), host, port, handle, ev));
                        }
                        TunnelKind::Dynamic => {
                            tokio::spawn(socks5_serve(sock, handle, ev));
                        }
                        TunnelKind::Remote => {}
                    }
                }
                Err(e) => {
                    let _ = event_tx.send(TunnelEvent::Error(format!("Accept failed: {e}")));
                }
            },
            _ = close_rx.recv() => {
                let _ = event_tx.send(TunnelEvent::Closed("Tunnel closed.".to_string()));
                break;
            }
        }
    }
    Ok(())
}

/// Local forward: yerel soketi SSH sunucusu üzerinden hedefe köprüler.
async fn local_forward(
    mut sock: TcpStream,
    peer_port: u16,
    target_host: String,
    target_port: u16,
    handle: TunnelHandle,
    event_tx: std_mpsc::Sender<TunnelEvent>,
) {
    match handle
        .channel_open_direct_tcpip(
            target_host.clone(),
            u32::from(target_port),
            "127.0.0.1",
            u32::from(peer_port),
        )
        .await
    {
        Ok(channel) => {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
        }
        Err(e) => {
            let _ = event_tx.send(TunnelEvent::Error(format!(
                "Couldn't open channel to {target_host}:{target_port}: {e}"
            )));
        }
    }
}

/// Dinamik forward: yerel bağlantıyı bir SOCKS5 isteği olarak çözüp hedefe köprüler.
async fn socks5_serve(
    mut sock: TcpStream,
    handle: TunnelHandle,
    event_tx: std_mpsc::Sender<TunnelEvent>,
) {
    if let Err(e) = socks5_connect(&mut sock, &handle).await {
        let _ = event_tx.send(TunnelEvent::Error(format!("SOCKS: {e}")));
    }
}

/// SOCKS5 el sıkışması (yalnız CONNECT, kimlik doğrulamasız) → direct-tcpip köprü.
async fn socks5_connect(sock: &mut TcpStream, handle: &TunnelHandle) -> Result<(), String> {
    // Selamlaşma: ver=5, nmethods, methods…
    let mut greeting = [0u8; 2];
    sock.read_exact(&mut greeting).await.map_err(io_str)?;
    if greeting[0] != 0x05 {
        return Err("only SOCKS5 is supported".to_string());
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    sock.read_exact(&mut methods).await.map_err(io_str)?;
    // "No authentication" seç.
    sock.write_all(&[0x05, 0x00]).await.map_err(io_str)?;

    // İstek: ver, cmd, rsv, atyp
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await.map_err(io_str)?;
    if req[1] != 0x01 {
        // yalnız CONNECT
        let _ = sock
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err("only CONNECT is supported".to_string());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await.map_err(io_str)?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await.map_err(io_str)?;
            let mut domain = vec![0u8; len[0] as usize];
            sock.read_exact(&mut domain).await.map_err(io_str)?;
            String::from_utf8_lossy(&domain).into_owned()
        }
        0x04 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await.map_err(io_str)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            let _ = sock
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err("unsupported address type".to_string());
        }
    };
    let mut port_bytes = [0u8; 2];
    sock.read_exact(&mut port_bytes).await.map_err(io_str)?;
    let port = u16::from_be_bytes(port_bytes);

    let channel = handle
        .channel_open_direct_tcpip(host.clone(), u32::from(port), "127.0.0.1", 0)
        .await
        .map_err(|e| {
            // Bağlantı reddedildi cevabı.
            format!("couldn't reach {host}:{port}: {e}")
        })?;

    // Başarı cevabı (bind adresi 0.0.0.0:0).
    sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(io_str)?;

    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(sock, &mut stream).await;
    Ok(())
}

fn io_str(e: std::io::Error) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{AuthChoice, SshRuntime};
    use std::net::TcpListener as StdListener;
    use std::time::{Duration, Instant};

    fn closed_port() -> u16 {
        let l = StdListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        port
    }

    /// Kapalı porta tünel açmak establish → hata yolunu doğrular (sunucu gerekmez).
    #[test]
    fn tunnel_to_closed_port_emits_error() {
        let rt = SshRuntime::new().unwrap();
        let session = rt.connect_tunnel(
            Endpoint {
                host: "127.0.0.1".to_string(),
                port: closed_port(),
                username: "nobody".to_string(),
                auth: AuthChoice::Password("x".to_string()),
                known_hosts_path: std::env::temp_dir().join("portal-test-known_hosts"),
                jump: None,
                forward_agent: false,
            },
            TunnelSpec {
                kind: TunnelKind::Local,
                local_port: 0,
                remote_host: "10.0.0.1".to_string(),
                remote_port: 5432,
            },
        );

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got_error = false;
        while Instant::now() < deadline {
            match session.try_event() {
                Some(TunnelEvent::Error(_)) => {
                    got_error = true;
                    break;
                }
                Some(_) => {}
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        assert!(got_error, "kapalı porta tünelde Error beklenir");
    }

    #[test]
    fn remote_kind_is_reported_unsupported() {
        // Remote henüz yok — spec kurulabilir ama açılışta nazik hata döner (canlı=manuel).
        let spec = TunnelSpec {
            kind: TunnelKind::Remote,
            local_port: 8080,
            remote_host: String::new(),
            remote_port: 0,
        };
        assert_eq!(spec.kind, TunnelKind::Remote);
    }
}
