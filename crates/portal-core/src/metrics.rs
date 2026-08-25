//! Sistem izleme: SSH exec ile hafif komutlar → `/proc` parse → metrikler.
//!
//! MVP'de ajan gerektirmez (docs/ARCHITECTURE.md §7). Tek bir kabuk komutu iki
//! `/proc` örneği (CPU% ve ağ hızı deltası için) + statik okumaları toplar; parse
//! saf fonksiyonlarda (test edilebilir). Kimlik/host-key ön adımı `ssh::establish`.

use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc as tokio_mpsc;

use crate::ssh::{
    establish, exec_collect, Endpoint, Established, HostKeyInfo, HostKeyResponder, HostKeySink,
};

/// İki `/proc` örneği + statik okumaları etiketli satırlar hâlinde toplayan komut.
const METRIC_CMD: &str = r#"S1=$(grep '^cpu ' /proc/stat); N1=$(cat /proc/net/dev); sleep 1; S2=$(grep '^cpu ' /proc/stat); N2=$(cat /proc/net/dev); echo "CPU1 $S1"; echo "CPU2 $S2"; echo "$N1" | sed 's/^/NET1 /'; echo "$N2" | sed 's/^/NET2 /'; grep -E 'MemTotal|MemAvailable' /proc/meminfo | sed 's/^/MEM /'; df -kP / | tail -1 | sed 's/^/DISK /'; echo "LOAD $(cat /proc/loadavg)"; echo "CORES $(nproc 2>/dev/null || echo 1)"; echo "PROCS $(ls -1 /proc 2>/dev/null | grep -cE '^[0-9]+$')"; echo "UPTIME $(uptime -p 2>/dev/null || uptime)""#;

/// Bir örnekleme sonucu sistem metrikleri.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metrics {
    /// CPU kullanımı (%).
    pub cpu_pct: f64,
    /// Kullanılan bellek (KB).
    pub mem_used_kb: u64,
    /// Toplam bellek (KB).
    pub mem_total_kb: u64,
    /// Kullanılan disk (KB, `/`).
    pub disk_used_kb: u64,
    /// Toplam disk (KB, `/`).
    pub disk_total_kb: u64,
    /// Ağ giriş hızı (bayt/sn).
    pub net_rx_bps: u64,
    /// Ağ çıkış hızı (bayt/sn).
    pub net_tx_bps: u64,
    /// Yük ortalaması (1/5/15 dk).
    pub load: (f64, f64, f64),
    /// CPU çekirdek sayısı.
    pub cores: u32,
    /// Süreç sayısı.
    pub processes: u64,
    /// Çalışma süresi (insan-okur).
    pub uptime: String,
}

impl Metrics {
    /// Bellek kullanımı (%).
    #[must_use]
    pub fn mem_pct(&self) -> f64 {
        pct(self.mem_used_kb, self.mem_total_kb)
    }

    /// Disk kullanımı (%).
    #[must_use]
    pub fn disk_pct(&self) -> f64 {
        pct(self.disk_used_kb, self.disk_total_kb)
    }
}

fn pct(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64) * 100.0
    }
}

/// İzleme oturumundan UI'ye olaylar.
pub enum MetricsEvent {
    /// Bilinmeyen host anahtarı (öğretme katmanı).
    HostKey(HostKeyInfo, HostKeyResponder),
    /// Yeni metrik örneği.
    Update(Box<Metrics>),
    /// Hata.
    Error(String),
}

/// UI'nin tuttuğu izleme oturum tanıtıcısı. Drop → durdurur.
pub struct MetricsSession {
    event_rx: std_mpsc::Receiver<MetricsEvent>,
    // Drop olunca runner'daki `stop_rx.recv()` None döner → döngü biter.
    _stop_tx: tokio_mpsc::UnboundedSender<()>,
}

impl MetricsSession {
    /// Bekleyen bir olayı alır (bloklamaz).
    #[must_use]
    pub fn try_event(&self) -> Option<MetricsEvent> {
        self.event_rx.try_recv().ok()
    }
}

impl crate::ssh::SshRuntime {
    /// Yeni bir izleme oturumu başlatır (bloklamaz). ~2.5 sn'de bir günceller.
    #[must_use]
    pub fn connect_metrics(&self, endpoint: Endpoint) -> MetricsSession {
        let (event_tx, event_rx) = std_mpsc::channel();
        let (stop_tx, stop_rx) = tokio_mpsc::unbounded_channel();
        let task_tx = event_tx.clone();
        self.handle().spawn(async move {
            if let Err(err) = run_metrics(endpoint, task_tx.clone(), stop_rx).await {
                let _ = task_tx.send(MetricsEvent::Error(err));
            }
        });
        MetricsSession {
            event_rx,
            _stop_tx: stop_tx,
        }
    }
}

async fn run_metrics(
    endpoint: Endpoint,
    event_tx: std_mpsc::Sender<MetricsEvent>,
    mut stop_rx: tokio_mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let hk_tx = event_tx.clone();
    let on_unknown_key: HostKeySink = Arc::new(move |info, responder| {
        let _ = hk_tx.send(MetricsEvent::HostKey(info, responder));
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
        match exec_collect(&handle, METRIC_CMD).await {
            Ok(output) => {
                let metrics = parse_metrics(&output);
                let _ = event_tx.send(MetricsEvent::Update(Box::new(metrics)));
            }
            Err(e) => {
                let _ = event_tx.send(MetricsEvent::Error(e));
            }
        }
        // ~1.5 sn bekle (komut zaten 1 sn örnekleme yapıyor) veya dur.
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

/// Etiketli komut çıktısından metrikleri ayrıştırır (saf; test edilebilir).
#[must_use]
pub fn parse_metrics(output: &str) -> Metrics {
    let mut m = Metrics::default();
    let mut cpu1 = None;
    let mut cpu2 = None;
    let mut net1: Vec<&str> = Vec::new();
    let mut net2: Vec<&str> = Vec::new();
    let (mut mem_total, mut mem_avail) = (0u64, 0u64);

    for line in output.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("CPU1 ") {
            cpu1 = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("CPU2 ") {
            cpu2 = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("NET1 ") {
            net1.push(rest);
        } else if let Some(rest) = line.strip_prefix("NET2 ") {
            net2.push(rest);
        } else if let Some(rest) = line.strip_prefix("MEM ") {
            if let Some((label, kb)) = parse_meminfo_line(rest) {
                if label == "MemTotal" {
                    mem_total = kb;
                } else if label == "MemAvailable" {
                    mem_avail = kb;
                }
            }
        } else if let Some(rest) = line.strip_prefix("DISK ") {
            if let Some((used, total)) = parse_df_line(rest) {
                m.disk_used_kb = used;
                m.disk_total_kb = total;
            }
        } else if let Some(rest) = line.strip_prefix("LOAD ") {
            m.load = parse_loadavg(rest);
        } else if let Some(rest) = line.strip_prefix("CORES ") {
            m.cores = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("PROCS ") {
            m.processes = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("UPTIME ") {
            m.uptime = rest.trim().to_string();
        }
    }

    m.mem_total_kb = mem_total;
    m.mem_used_kb = mem_total.saturating_sub(mem_avail);

    if let (Some(a), Some(b)) = (cpu1, cpu2) {
        m.cpu_pct = parse_cpu_percent(&a, &b);
    }
    let (rx, tx) = parse_net_rate(&net1, &net2, 1);
    m.net_rx_bps = rx;
    m.net_tx_bps = tx;

    m
}

/// İki `cpu ` satırından kullanım yüzdesi.
#[must_use]
pub fn parse_cpu_percent(cpu1: &str, cpu2: &str) -> f64 {
    let (b1, t1) = cpu_busy_total(cpu1);
    let (b2, t2) = cpu_busy_total(cpu2);
    let dt = t2.saturating_sub(t1);
    let db = b2.saturating_sub(b1);
    if dt == 0 {
        0.0
    } else {
        (db as f64 / dt as f64) * 100.0
    }
}

fn cpu_busy_total(line: &str) -> (u64, u64) {
    // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter(|t| *t != "cpu")
        .filter_map(|t| t.parse().ok())
        .collect();
    let total: u64 = nums.iter().sum();
    // idle = idle(3) + iowait(4)
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    (total.saturating_sub(idle), total)
}

/// İki net/dev örneğinden (lo hariç) rx/tx bayt hızı (bayt/sn).
#[must_use]
pub fn parse_net_rate(net1: &[&str], net2: &[&str], secs: u64) -> (u64, u64) {
    let (rx1, tx1) = net_totals(net1);
    let (rx2, tx2) = net_totals(net2);
    let secs = secs.max(1);
    (
        rx2.saturating_sub(rx1) / secs,
        tx2.saturating_sub(tx1) / secs,
    )
}

fn net_totals(lines: &[&str]) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in lines {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo" || iface.is_empty() {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|t| t.parse().ok())
            .collect();
        // rx bytes = alan 0, tx bytes = alan 8
        rx += nums.first().copied().unwrap_or(0);
        tx += nums.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

fn parse_meminfo_line(line: &str) -> Option<(String, u64)> {
    let (label, rest) = line.split_once(':')?;
    let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
    Some((label.trim().to_string(), kb))
}

fn parse_df_line(line: &str) -> Option<(u64, u64)> {
    // "filesystem 1k-blocks used available use% mount"
    let f: Vec<&str> = line.split_whitespace().collect();
    let total: u64 = f.get(1)?.parse().ok()?;
    let used: u64 = f.get(2)?.parse().ok()?;
    Some((used, total))
}

fn parse_loadavg(line: &str) -> (f64, f64, f64) {
    let f: Vec<f64> = line
        .split_whitespace()
        .take(3)
        .filter_map(|t| t.parse().ok())
        .collect();
    (
        f.first().copied().unwrap_or(0.0),
        f.get(1).copied().unwrap_or(0.0),
        f.get(2).copied().unwrap_or(0.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_from_two_samples() {
        // t1: total=100 (idle 90) → busy 10; t2: total=200 (idle 140) → busy 60.
        // dbusy=50, dtotal=100 → 50%.
        let a = "cpu  10 0 0 90 0 0 0 0 0 0";
        let b = "cpu  40 0 20 140 0 0 0 0 0 0";
        let pct = parse_cpu_percent(a, b);
        assert!((pct - 50.0).abs() < 0.01, "got {pct}");
    }

    #[test]
    fn net_rate_sums_non_lo() {
        let n1 = [
            "eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0",
            "lo: 999 0 0 0 0 0 0 0 999 0",
        ];
        let n2 = [
            "eth0: 3000 0 0 0 0 0 0 0 1500 0 0 0 0 0 0 0",
            "lo: 9999 0 0 0 0 0 0 0 9999 0",
        ];
        let (rx, tx) = parse_net_rate(&n1, &n2, 1);
        assert_eq!(rx, 2000); // 3000-1000
        assert_eq!(tx, 1000); // 1500-500
    }

    #[test]
    fn parses_full_output() {
        let out = "\
CPU1 cpu  100 0 50 850 0 0 0 0 0 0
CPU2 cpu  200 0 100 1400 0 0 0 0 0 0
NET1 eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
NET2 eth0: 6000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0
MEM MemTotal:       8000000 kB
MEM MemAvailable:   2000000 kB
DISK /dev/sda1 100000000 41000000 59000000 41% /
LOAD 0.18 0.09 0.05 1/234 5678
CORES 4
PROCS 142
UPTIME up 18 days, 4 hours";
        let m = parse_metrics(out);
        assert_eq!(m.mem_total_kb, 8_000_000);
        assert_eq!(m.mem_used_kb, 6_000_000);
        assert!((m.mem_pct() - 75.0).abs() < 0.01);
        assert_eq!(m.disk_total_kb, 100_000_000);
        assert_eq!(m.disk_used_kb, 41_000_000);
        assert_eq!(m.cores, 4);
        assert_eq!(m.processes, 142);
        assert_eq!(m.load, (0.18, 0.09, 0.05));
        assert_eq!(m.uptime, "up 18 days, 4 hours");
        assert_eq!(m.net_rx_bps, 5000); // 6000-1000
        assert_eq!(m.net_tx_bps, 3000); // 5000-2000
        assert!(m.cpu_pct > 0.0);
    }
}
