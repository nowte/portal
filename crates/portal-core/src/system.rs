//! Zengin sistem raporu (GUI Monitor): temel metrikler + top süreçler + tüm diskler.
//!
//! TUI'nin [`crate::metrics::MetricsSession`]'ına DOKUNMADAN, paralel ve daha zengin bir
//! oturum. (TUI kaldırılınca ikisi birleştirilecek.) Temel metrikler
//! [`crate::metrics::parse_metrics`] ile YENİDEN KULLANILIR — burada yalnız süreç ve
//! disk parse'ı eklenir. Ajan gerektirmez (tek `ps`/`df`/`/proc` exec; saf parser'lar).

use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc as tokio_mpsc;

use crate::metrics::{parse_metrics, Metrics};
use crate::ssh::{
    establish, exec_collect, Endpoint, Established, HostKeyInfo, HostKeyResponder, HostKeySink,
};

/// Temel metrik örneği + top süreçler + tüm bağlı diskler.
const SYSTEM_CMD: &str = r#"S1=$(grep '^cpu ' /proc/stat); N1=$(cat /proc/net/dev); sleep 1; S2=$(grep '^cpu ' /proc/stat); N2=$(cat /proc/net/dev); echo "CPU1 $S1"; echo "CPU2 $S2"; echo "$N1" | sed 's/^/NET1 /'; echo "$N2" | sed 's/^/NET2 /'; grep -E 'MemTotal|MemAvailable' /proc/meminfo | sed 's/^/MEM /'; df -kP / | tail -1 | sed 's/^/DISK /'; echo "LOAD $(cat /proc/loadavg)"; echo "CORES $(nproc 2>/dev/null || echo 1)"; echo "PROCS $(ls -1 /proc 2>/dev/null | grep -cE '^[0-9]+$')"; echo "UPTIME $(uptime -p 2>/dev/null || uptime)"; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | sed -n '2,11p' | sed 's/^/PROC /'; df -kP -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2 | sed 's/^/DISKS /'"#;

/// Bir süreç (top listede).
#[derive(Debug, Clone, PartialEq)]
pub struct ProcInfo {
    /// Süreç kimliği.
    pub pid: u32,
    /// Sahibi (kullanıcı).
    pub user: String,
    /// CPU kullanımı (%).
    pub cpu: f64,
    /// Bellek kullanımı (%).
    pub mem: f64,
    /// Komut adı.
    pub command: String,
}

/// Bağlı bir dosya sistemi (disk).
#[derive(Debug, Clone, PartialEq)]
pub struct DiskInfo {
    /// Aygıt/dosya sistemi.
    pub filesystem: String,
    /// Bağlama noktası.
    pub mount: String,
    /// Kullanılan (KB).
    pub used_kb: u64,
    /// Toplam (KB).
    pub total_kb: u64,
}

impl DiskInfo {
    /// Doluluk (%).
    #[must_use]
    pub fn pct(&self) -> f64 {
        if self.total_kb == 0 {
            0.0
        } else {
            (self.used_kb as f64 / self.total_kb as f64) * 100.0
        }
    }
}

/// Tek bir örnekleme: temel metrikler + süreçler + diskler.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SystemReport {
    /// Temel metrikler (CPU/RAM/net/load/uptime …).
    pub metrics: Metrics,
    /// En çok CPU kullanan süreçler.
    pub processes: Vec<ProcInfo>,
    /// Bağlı diskler.
    pub disks: Vec<DiskInfo>,
}

/// Sistem oturumundan UI'ye olaylar.
pub enum SystemEvent {
    /// Bilinmeyen host anahtarı (öğretme katmanı).
    HostKey(HostKeyInfo, HostKeyResponder),
    /// Yeni örnek.
    Update(Box<SystemReport>),
    /// Hata.
    Error(String),
}

/// UI'nin tuttuğu sistem oturum tanıtıcısı. Drop → durdurur.
pub struct SystemSession {
    event_rx: std_mpsc::Receiver<SystemEvent>,
    // Drop olunca runner'daki `stop_rx.recv()` None döner → döngü biter.
    _stop_tx: tokio_mpsc::UnboundedSender<()>,
}

impl SystemSession {
    /// Bekleyen bir olayı alır (bloklamaz).
    #[must_use]
    pub fn try_event(&self) -> Option<SystemEvent> {
        self.event_rx.try_recv().ok()
    }
}

impl crate::ssh::SshRuntime {
    /// Yeni bir sistem oturumu başlatır (bloklamaz). ~2.5 sn'de bir günceller.
    #[must_use]
    pub fn connect_system(&self, endpoint: Endpoint) -> SystemSession {
        let (event_tx, event_rx) = std_mpsc::channel();
        let (stop_tx, stop_rx) = tokio_mpsc::unbounded_channel();
        let task_tx = event_tx.clone();
        self.handle().spawn(async move {
            if let Err(err) = run_system(endpoint, task_tx.clone(), stop_rx).await {
                let _ = task_tx.send(SystemEvent::Error(err));
            }
        });
        SystemSession {
            event_rx,
            _stop_tx: stop_tx,
        }
    }
}

async fn run_system(
    endpoint: Endpoint,
    event_tx: std_mpsc::Sender<SystemEvent>,
    mut stop_rx: tokio_mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let hk_tx = event_tx.clone();
    let on_unknown_key: HostKeySink = Arc::new(move |info, responder| {
        let _ = hk_tx.send(SystemEvent::HostKey(info, responder));
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

    loop {
        match exec_collect(&handle, SYSTEM_CMD).await {
            Ok(output) => {
                let _ = event_tx.send(SystemEvent::Update(Box::new(parse_system(&output))));
            }
            Err(e) => {
                let _ = event_tx.send(SystemEvent::Error(e));
            }
        }
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(1500)) => {}
            r = stop_rx.recv() => {
                if r.is_none() {
                    break;
                }
            }
        }
    }
    Ok(())
}

/// Etiketli komut çıktısından tam sistem raporunu ayrıştırır (saf; test edilebilir).
#[must_use]
pub fn parse_system(output: &str) -> SystemReport {
    SystemReport {
        metrics: parse_metrics(output),
        processes: parse_processes(output),
        disks: parse_disks(output),
    }
}

/// `PROC pid user pcpu pmem comm…` satırlarını ayrıştırır.
#[must_use]
pub fn parse_processes(output: &str) -> Vec<ProcInfo> {
    let mut out = Vec::new();
    for line in output.lines() {
        let Some(rest) = line.trim_end().strip_prefix("PROC ") else {
            continue;
        };
        let toks: Vec<&str> = rest.split_whitespace().collect();
        if toks.len() < 5 {
            continue;
        }
        out.push(ProcInfo {
            pid: toks[0].parse().unwrap_or(0),
            user: toks[1].to_string(),
            cpu: toks[2].parse().unwrap_or(0.0),
            mem: toks[3].parse().unwrap_or(0.0),
            command: toks[4..].join(" "),
        });
    }
    out
}

/// `DISKS fs 1k-blocks used avail use% mount…` satırlarını ayrıştırır (boş/0 atlanır).
#[must_use]
pub fn parse_disks(output: &str) -> Vec<DiskInfo> {
    let mut out = Vec::new();
    for line in output.lines() {
        let Some(rest) = line.trim_end().strip_prefix("DISKS ") else {
            continue;
        };
        let toks: Vec<&str> = rest.split_whitespace().collect();
        if toks.len() < 6 {
            continue;
        }
        let total_kb: u64 = toks[1].parse().unwrap_or(0);
        let used_kb: u64 = toks[2].parse().unwrap_or(0);
        if total_kb == 0 {
            continue;
        }
        out.push(DiskInfo {
            filesystem: toks[0].to_string(),
            mount: toks[5..].join(" "),
            used_kb,
            total_kb,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_top_processes() {
        let out = "\
PROC 1234 root 12.5 3.2 nginx
PROC 5678 www-data 4.0 8.1 php-fpm
PROC 42 postgres 0.0 15.0 postgres: writer process
junk line";
        let p = parse_processes(out);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].pid, 1234);
        assert_eq!(p[0].user, "root");
        assert!((p[0].cpu - 12.5).abs() < 0.01);
        assert!((p[0].mem - 3.2).abs() < 0.01);
        assert_eq!(p[0].command, "nginx");
        // Boşluklu komut korunur.
        assert_eq!(p[2].command, "postgres: writer process");
    }

    #[test]
    fn parses_all_disks_skipping_zero() {
        let out = "\
DISKS /dev/sda1 100000000 41000000 59000000 41% /
DISKS /dev/sdb1 500000000 250000000 250000000 50% /data
DISKS none 0 0 0 - /nope";
        let d = parse_disks(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].mount, "/");
        assert_eq!(d[0].total_kb, 100_000_000);
        assert_eq!(d[0].used_kb, 41_000_000);
        assert!((d[0].pct() - 41.0).abs() < 0.01);
        assert_eq!(d[1].mount, "/data");
        assert_eq!(d[1].filesystem, "/dev/sdb1");
    }

    #[test]
    fn parse_system_reuses_base_metrics() {
        let out = "\
CPU1 cpu  100 0 50 850 0 0 0 0 0 0
CPU2 cpu  200 0 100 1400 0 0 0 0 0 0
MEM MemTotal:       8000000 kB
MEM MemAvailable:   2000000 kB
DISK /dev/sda1 100000000 41000000 59000000 41% /
CORES 4
PROC 1 root 1.0 0.5 systemd
DISKS /dev/sda1 100000000 41000000 59000000 41% /";
        let r = parse_system(out);
        assert_eq!(r.metrics.mem_total_kb, 8_000_000);
        assert_eq!(r.metrics.cores, 4);
        assert_eq!(r.processes.len(), 1);
        assert_eq!(r.disks.len(), 1);
    }
}
