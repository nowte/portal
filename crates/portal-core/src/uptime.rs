//! Uptime kontrol motoru: monitörleri periyodik olarak yoklar, sonucu UI'ye
//! [`UptimeEvent`] olarak verir.
//!
//! Mimarî: [`metrics`](crate::metrics)/[`ssh`](crate::ssh) ile aynı desen — tüm
//! iş kendi thread'inde döner, UI senkron [`UptimeService::try_event`] ile okur.
//! Burada tokio yok; kontroller blocking ([`ureq`] + [`std::net::TcpStream`]),
//! çünkü dakikada bir atılan birkaç istek için async çalışma zamanı fazlalık.
//!
//! Kontroller döngüyü BLOKLAMAZ: sırası gelen her monitör kendi kısa ömürlü
//! thread'inde yoklanır, sonucu [`Cmd::Done`] olarak geri gönderir. Aynı anda en
//! fazla [`MAX_CONCURRENT`] kontrol koşar — zaman aşımına düşen bir monitör
//! diğerlerini geciktirmez, ama yüz monitör yüz thread de açmaz.

use std::collections::{HashMap, HashSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crate::cert;
use crate::model::{Monitor, MonitorId, MonitorTarget};
use crate::uptime_log::{now_unix, CheckResult};

/// Komut kanalı boşken thread'in uyanma sıklığı (sıra gelen monitör bu hassasiyetle bulunur).
const TICK: Duration = Duration::from_millis(500);

/// Aynı anda koşabilecek kontrol sayısı. Yavaş bir hedef en fazla bir yuva tutar.
const MAX_CONCURRENT: usize = 4;

/// İzleme thread'inden UI'ye olaylar.
#[derive(Debug, Clone)]
pub enum UptimeEvent {
    /// Bir monitör kontrol edildi.
    Checked(CheckResult),
}

/// UI'den izleme thread'ine komutlar.
enum Cmd {
    /// Monitör listesini baştan yükle (ekleme/silme/düzenlemeden sonra).
    Reload(Vec<Monitor>),
    /// Bir monitörü hemen kontrol et (aralığı bekleme).
    CheckNow(MonitorId),
    /// Bir kontrol thread'i bitti (yuvayı boşalt, sonucu yay).
    Done(CheckResult),
    /// Thread'i durdur.
    Stop,
}

/// Arka planda dönen uptime izleyici.
pub struct UptimeService {
    cmd_tx: Sender<Cmd>,
    event_rx: Receiver<UptimeEvent>,
    handle: Option<thread::JoinHandle<()>>,
}

impl UptimeService {
    /// İzleyiciyi başlatır. Etkin monitörler ilk turda hemen kontrol edilir.
    #[must_use]
    pub fn start(monitors: Vec<Monitor>) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        // Kontrol thread'leri sonucu bu kanaldan geri yollar → döngü hemen uyanır.
        let done_tx = cmd_tx.clone();
        let handle = thread::spawn(move || run(monitors, &cmd_rx, &done_tx, &event_tx));
        Self {
            cmd_tx,
            event_rx,
            handle: Some(handle),
        }
    }

    /// Bekleyen bir olayı alır; yoksa `None` (bloklamaz).
    #[must_use]
    pub fn try_event(&self) -> Option<UptimeEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Monitör listesini günceller (thread durmuşsa sessizce yok sayılır).
    pub fn reload(&self, monitors: Vec<Monitor>) {
        let _ = self.cmd_tx.send(Cmd::Reload(monitors));
    }

    /// Bir monitörü sıradan çıkarıp hemen kontrol ettirir.
    pub fn check_now(&self, id: MonitorId) {
        let _ = self.cmd_tx.send(Cmd::CheckNow(id));
    }
}

impl Drop for UptimeService {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Stop);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// İzleme döngüsü: sırası gelen monitörleri kontrole yollar, dönen sonucu yayar.
fn run(
    mut monitors: Vec<Monitor>,
    cmd_rx: &Receiver<Cmd>,
    done_tx: &Sender<Cmd>,
    event_tx: &Sender<UptimeEvent>,
) {
    // Monitör → bir sonraki kontrol zamanı. Listede olmayan kimlikler temizlenir.
    let mut due: HashMap<MonitorId, Instant> = HashMap::new();
    // Şu an kontrolü koşan monitörler: ikinci kez yollanmasınlar.
    let mut running: HashSet<MonitorId> = HashSet::new();

    loop {
        match cmd_rx.recv_timeout(TICK) {
            Ok(Cmd::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Cmd::Reload(next)) => {
                due.retain(|id, _| next.iter().any(|m| m.id == *id));
                monitors = next;
            }
            Ok(Cmd::CheckNow(id)) => {
                due.insert(id, Instant::now());
            }
            Ok(Cmd::Done(result)) => {
                running.remove(&result.monitor_id);
                // Bir sonraki tur kontrolün BİTİŞİNDEN sayılır (yavaş hedef üst üste
                // binmez). Aradan silinmiş monitörün kaydı geri gelmesin.
                if let Some(m) = monitors.iter().find(|m| m.id == result.monitor_id) {
                    let wait = Duration::from_secs(u64::from(m.interval_secs.max(1)));
                    due.insert(m.id, Instant::now() + wait);
                }
                if event_tx.send(UptimeEvent::Checked(result)).is_err() {
                    return; // UI gitti.
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        let now = Instant::now();
        for monitor in &monitors {
            if running.len() >= MAX_CONCURRENT {
                break;
            }
            if !monitor.enabled || running.contains(&monitor.id) {
                continue;
            }
            if *due.entry(monitor.id).or_insert(now) > now {
                continue;
            }
            running.insert(monitor.id);
            let monitor = monitor.clone();
            let done_tx = done_tx.clone();
            thread::spawn(move || {
                let _ = done_tx.send(Cmd::Done(check_once(&monitor)));
            });
        }
    }
}

/// Bir monitörü bir kez kontrol eder (bloklar; çağıran thread'i meşgul eder).
#[must_use]
pub fn check_once(monitor: &Monitor) -> CheckResult {
    let started = Instant::now();
    let (up, status, error) = match &monitor.target {
        MonitorTarget::Http {
            url,
            expect_status,
            contains,
        } => check_http(
            url,
            *expect_status,
            contains.as_deref(),
            monitor.timeout_secs,
        ),
        MonitorTarget::Tcp { host, port } => (
            true,
            None,
            check_tcp(host, *port, monitor.timeout_secs).err(),
        ),
    };
    let up = up && error.is_none();
    let elapsed = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);

    // Sertifika yalnız AYAKTA olan https hedeflerde okunur: hedef zaten
    // cevap vermiyorsa ikinci bir zaman aşımını beklemenin faydası yok.
    // Tavan: ayakta olan her https kontrolü fazladan bir TLS el sıkışması
    // yapar. Bitiş tarihi günlerce değişmediği için bu sonuç ileride
    // önbelleklenebilir; ölçülen maliyet bunu gerektirmedi.
    let cert_expires_at = match &monitor.target {
        MonitorTarget::Http { url, .. } if up => cert::expires_at(url, monitor.timeout_secs),
        _ => None,
    };

    CheckResult {
        monitor_id: monitor.id,
        at: now_unix(),
        up,
        latency_ms: up.then_some(elapsed),
        status,
        error,
        cert_expires_at,
    }
}

/// HTTP(S) GET; yanıt kodu beklenene uymuyorsa (ya da `contains` gövdede
/// bulunmuyorsa) hata metni döner.
fn check_http(
    url: &str,
    expect: Option<u16>,
    contains: Option<&str>,
    timeout_secs: u32,
) -> (bool, Option<u16>, Option<String>) {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(u64::from(timeout_secs.max(1)))))
        // Durum kodunu hata olarak DEĞİL, veri olarak istiyoruz: 500 de bir cevaptır
        // ve kullanıcıya "got 500" diye gösterilir.
        .http_status_as_error(false)
        .user_agent("Portal/1.0 uptime monitor")
        .build();
    let agent: ureq::Agent = config.into();

    match agent.get(url).call() {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let ok = match expect {
                Some(want) => status == want,
                None => status < 400,
            };
            if !ok {
                let error = match expect {
                    Some(want) => format!("Expected HTTP {want}, got {status}"),
                    None => format!("HTTP {status}"),
                };
                return (false, Some(status), Some(error));
            }
            // Gövde yalnız aranacak bir metin varsa indirilir.
            let Some(needle) = contains else {
                return (true, Some(status), None);
            };
            match response.body_mut().read_to_string() {
                Ok(body) if body.contains(needle) => (true, Some(status), None),
                Ok(_) => (
                    false,
                    Some(status),
                    // 200 döndü ama içerik yanlış: kullanıcı ARADIĞINI görsün.
                    Some(format!(
                        "HTTP {status} but the page didn't contain {needle:?}"
                    )),
                ),
                Err(e) => (
                    false,
                    Some(status),
                    Some(format!(
                        "Couldn't read the page: {}",
                        friendly(&e.to_string())
                    )),
                ),
            }
        }
        Err(e) => (false, None, Some(friendly(&e.to_string()))),
    }
}

/// Ham TCP bağlantısı; açılamıyorsa hata metni döner.
fn check_tcp(host: &str, port: u16, timeout_secs: u32) -> Result<(), String> {
    let timeout = Duration::from_secs(u64::from(timeout_secs.max(1)));
    let mut addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Couldn't resolve {host}: {e}"))?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("Couldn't resolve {host}: no address found"))?;
    TcpStream::connect_timeout(&addr, timeout)
        .map(|_| ())
        .map_err(|e| friendly(&e.to_string()))
}

/// Kütüphane hatasını kullanıcıya gösterilebilir tek satıra indirger.
fn friendly(message: &str) -> String {
    let first = message.lines().next().unwrap_or(message).trim();
    let mut text = first.to_string();
    if let Some(rest) = text.strip_prefix("io: ") {
        text = rest.to_string();
    }
    if text.is_empty() {
        "Check failed".to_string()
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Tek bir isteğe sabit gövdeyle cevap veren mini HTTP sunucusu; portunu döner.
    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().take(1).flatten() {
                // İstek okunmadan cevap yazmak bazı yığınlarda RST'ye yol açar.
                let _ = stream.read(&mut [0u8; 1024]);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK
Content-Length: {}
Connection: close

{body}",
                    body.len()
                );
                let _ = stream.flush();
            }
        });
        port
    }

    /// Yerel mini sunucuyu hedefleyen bir monitör (opsiyonel anahtar kelimeyle).
    fn http_monitor(port: u16, contains: Option<&str>) -> Monitor {
        let mut monitor = Monitor::new(
            "test",
            MonitorTarget::Http {
                url: format!("http://127.0.0.1:{port}/"),
                expect_status: None,
                contains: contains.map(str::to_string),
            },
        );
        monitor.timeout_secs = 5;
        monitor
    }

    #[test]
    fn keyword_found_in_body_is_up() {
        let port = serve_once("<html>all systems healthy</html>");
        let result = check_once(&http_monitor(port, Some("healthy")));
        assert!(result.up, "eşleşen sayfa up olmalı: {:?}", result.error);
    }

    #[test]
    fn keyword_missing_is_down_even_with_200() {
        let port = serve_once("<html>under maintenance</html>");
        let result = check_once(&http_monitor(port, Some("healthy")));
        assert!(!result.up, "eşleşmeyen sayfa 200 dönse de down olmalı");
        assert_eq!(result.status, Some(200));
        let error = result.error.unwrap();
        // Hata ARANAN metni göstermeli, yoksa kullanıcı neyi düzelteceğini bilemez.
        assert!(
            error.contains("healthy"),
            "hata aranan metni göstermeli: {error}"
        );
    }

    #[test]
    fn without_a_keyword_the_body_is_not_checked() {
        let port = serve_once("<html>under maintenance</html>");
        let result = check_once(&http_monitor(port, None));
        assert!(result.up);
    }

    #[test]
    fn plain_http_has_no_certificate() {
        let port = serve_once("ok");
        assert_eq!(check_once(&http_monitor(port, None)).cert_expires_at, None);
    }

    fn tcp_monitor(host: &str, port: u16) -> Monitor {
        let mut monitor = Monitor::new(
            "test",
            MonitorTarget::Tcp {
                host: host.to_string(),
                port,
            },
        );
        monitor.timeout_secs = 2;
        monitor
    }

    #[test]
    fn open_port_is_up() {
        // Geçici bir dinleyici aç: ağ/dış dünya gerekmez.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let result = check_once(&tcp_monitor("127.0.0.1", port));
        assert!(result.up, "açık port up olmalı: {:?}", result.error);
        assert!(result.latency_ms.is_some());
        assert!(result.error.is_none());
    }

    #[test]
    fn closed_port_is_down_with_reason() {
        // Dinleyiciyi kapat → port artık kapalı.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };

        let result = check_once(&tcp_monitor("127.0.0.1", port));
        assert!(!result.up);
        assert!(result.latency_ms.is_none());
        assert!(
            result.error.is_some(),
            "hata nedeni kullanıcıya gösterilmeli"
        );
    }

    #[test]
    fn unresolvable_host_is_down() {
        let result = check_once(&tcp_monitor("portal.invalid.", 443));
        assert!(!result.up);
        assert!(result.error.unwrap().starts_with("Couldn't resolve"));
    }

    #[test]
    fn disabled_monitors_are_never_checked() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut monitor = tcp_monitor("127.0.0.1", port);
        monitor.enabled = false;

        let service = UptimeService::start(vec![monitor]);
        thread::sleep(Duration::from_millis(300));
        assert!(service.try_event().is_none());
    }

    #[test]
    fn service_checks_on_start_and_reports() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let monitor = tcp_monitor("127.0.0.1", port);
        let id = monitor.id;

        let service = UptimeService::start(vec![monitor]);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = None;
        while Instant::now() < deadline && seen.is_none() {
            if let Some(UptimeEvent::Checked(result)) = service.try_event() {
                seen = Some(result);
            } else {
                thread::sleep(Duration::from_millis(20));
            }
        }

        let result = seen.expect("başlangıçta bir kontrol yapılmalı");
        assert_eq!(result.monitor_id, id);
        assert!(result.up);
    }

    #[test]
    fn slow_monitor_does_not_block_the_others() {
        // Yavaş hedef: bağlantıyı KABUL eder ama yanıt vermez → istek zaman aşımına
        // düşene kadar (10 sn) bir yuvayı tutar. Sıralı bir döngüde diğer dört
        // monitör de bu kadar beklerdi.
        let stalled = TcpListener::bind("127.0.0.1:0").unwrap();
        let stalled_port = stalled.local_addr().unwrap().port();
        thread::spawn(move || {
            let _open: Vec<_> = stalled.incoming().take(1).filter_map(Result::ok).collect();
            thread::sleep(Duration::from_secs(15));
        });
        let mut slow = Monitor::new(
            "slow",
            MonitorTarget::Http {
                url: format!("http://127.0.0.1:{stalled_port}/"),
                expect_status: None,
                contains: None,
            },
        );
        slow.timeout_secs = 10;

        // Dört hızlı monitör: açık bir port, anında cevap.
        let fast_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let fast_port = fast_listener.local_addr().unwrap().port();
        let mut monitors = vec![slow];
        let fast_ids: Vec<MonitorId> = (0..4)
            .map(|_| {
                let m = tcp_monitor("127.0.0.1", fast_port);
                let id = m.id;
                monitors.push(m);
                id
            })
            .collect();

        let service = UptimeService::start(monitors);
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut seen: Vec<MonitorId> = Vec::new();
        while Instant::now() < deadline && seen.len() < fast_ids.len() {
            if let Some(UptimeEvent::Checked(result)) = service.try_event() {
                assert!(result.up, "hızlı monitör up olmalı: {:?}", result.error);
                seen.push(result.monitor_id);
            } else {
                thread::sleep(Duration::from_millis(10));
            }
        }
        // Dördü de 1 sn içinde sonuçlandı — yavaş olan kimseyi bloklamadı.
        // (MAX_CONCURRENT 4 olduğu için dördüncüsü ancak bir yuva boşalınca gider:
        // yuvanın geri dönüşü de burada ölçülür.)
        for id in &fast_ids {
            assert!(seen.contains(id), "1 sn içinde sonuçlanmayan monitör var");
        }
    }

    #[test]
    fn friendly_takes_first_line() {
        assert_eq!(friendly("io: refused\nbacktrace"), "refused");
        assert_eq!(friendly("   "), "Check failed");
    }
}
