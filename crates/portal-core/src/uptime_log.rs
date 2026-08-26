//! Uptime kontrol geçmişi: son kontroller (ring) + günlük özetler.
//!
//! Vault'un aksine bu dosya **sır taşımaz** ve sürekli büyür; bu yüzden vault'a
//! değil `<data_dir>/uptime.json`'a yazılır (vault her mutasyonda yeniden
//! şifrelenip yazılır — dakikada bir gelen kontrol sonucu için uygun değil).
//!
//! Ölçek tavanı: monitör başına son [`RECENT_CAP`] ham kontrol + [`DAY_CAP`]
//! günlük özet, tek JSON dosyası olarak tümü belleğe yüklenir. Yüzlerce monitör
//! ya da saniyelik aralık gerekirse buranın SQLite'a taşınması gerekir.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::MonitorId;
use crate::persist;

/// Monitör başına saklanan ham kontrol sayısı (grafik + son olaylar listesi için).
pub const RECENT_CAP: usize = 500;
/// Monitör başına saklanan günlük özet sayısı (~13 ay).
pub const DAY_CAP: usize = 400;

/// Bir gündeki saniye sayısı — gün numarası = unix saniye / bu (UTC).
const SECS_PER_DAY: u64 = 86_400;

/// Tek bir kontrolün sonucu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckResult {
    /// Hangi monitöre ait.
    pub monitor_id: MonitorId,
    /// Kontrol anı (unix saniye, UTC).
    pub at: u64,
    /// Hedef ayakta mı.
    pub up: bool,
    /// Yanıt süresi (ms); bağlanılamadıysa `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u32>,
    /// HTTP durum kodu (yalnız HTTP hedeflerde).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Başarısızlık nedeni (kullanıcıya gösterilir).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// TLS sertifikasının bitiş anı (unix saniye) — yalnız ayakta olan https
    /// hedeflerde okunur. Eski kayıtlarda yok → `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_expires_at: Option<u64>,
}

impl CheckResult {
    /// Sertifikanın bitişine kalan gün; sertifika okunmadıysa `None`.
    #[must_use]
    pub fn cert_days_left(&self, now: u64) -> Option<i64> {
        self.cert_expires_at
            .map(|expires_at| crate::cert::days_left(expires_at, now))
    }
}

/// Bir günün özeti (ham kontroller ring'den düşse de kalır).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DayStat {
    /// Gün numarası: unix saniye / 86400 (UTC). UI tarihe kendisi çevirir.
    pub day: u64,
    /// Başarılı kontrol sayısı.
    pub up: u32,
    /// Başarısız kontrol sayısı.
    pub down: u32,
    /// Başarılı kontrollerin toplam gecikmesi (ms) — ortalama için.
    pub latency_sum_ms: u64,
}

impl DayStat {
    /// O günün uptime yüzdesi (kontrol yoksa 0).
    #[must_use]
    pub fn uptime_pct(&self) -> f64 {
        pct(self.up, self.up + self.down)
    }

    /// Başarılı kontrollerin ortalama gecikmesi (ms); yoksa `None`.
    #[must_use]
    pub fn avg_latency_ms(&self) -> Option<u32> {
        if self.up == 0 {
            None
        } else {
            u32::try_from(self.latency_sum_ms / u64::from(self.up)).ok()
        }
    }
}

fn pct(part: u32, total: u32) -> f64 {
    if total == 0 {
        0.0
    } else {
        f64::from(part) / f64::from(total) * 100.0
    }
}

/// Bir monitörün o anki durumu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorState {
    /// Henüz kontrol edilmedi.
    #[default]
    Unknown,
    /// Ayakta.
    Up,
    /// Kesinti.
    Down,
}

/// Tek bir monitörün geçmişi.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorHistory {
    /// Son kontroller, eskiden yeniye (en fazla [`RECENT_CAP`]).
    pub recent: Vec<CheckResult>,
    /// Günlük özetler, eskiden yeniye (en fazla [`DAY_CAP`]).
    pub days: Vec<DayStat>,
}

impl MonitorHistory {
    /// O anki durum. **Tek bir başarısız kontrol Down saymaz**: geçici bir ağ
    /// hıçkırığı kesinti gibi görünmesin diye iki ardışık hata aranır. İlk
    /// kontrol başarısızsa (karşılaştıracak öncesi yok) doğrudan Down.
    #[must_use]
    pub fn state(&self) -> MonitorState {
        let mut back = self.recent.iter().rev();
        match back.next() {
            None => MonitorState::Unknown,
            Some(last) if last.up => MonitorState::Up,
            Some(_) => match back.next() {
                Some(prev) if prev.up => MonitorState::Up,
                _ => MonitorState::Down,
            },
        }
    }

    /// Son kontrol (varsa).
    #[must_use]
    pub fn last(&self) -> Option<&CheckResult> {
        self.recent.last()
    }

    /// En son OKUNABİLEN sertifika bitişi. Son kontrolde bakılmaz: hedef
    /// düştüğünde sertifika uyarısı da kaybolurdu, oysa bilgi hâlâ geçerli.
    #[must_use]
    pub fn cert_expires_at(&self) -> Option<u64> {
        self.recent.iter().rev().find_map(|c| c.cert_expires_at)
    }
}

/// Tüm monitörlerin geçmişi — `<data_dir>/uptime.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UptimeLog {
    /// Monitör kimliği → geçmiş.
    pub monitors: HashMap<MonitorId, MonitorHistory>,
}

impl UptimeLog {
    /// Dosyadan yükler; dosya yoksa (ya da bozuksa) boş geçmişle başlar.
    ///
    /// Bozuk dosya hata değildir: geçmiş kaybı can sıkıcıdır ama uygulamayı
    /// açılamaz hâle getirmemeli.
    #[must_use]
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = persist::read_bytes(path) else {
            return Self::default();
        };
        match serde_json::from_slice(&bytes) {
            Ok(log) => log,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "uptime geçmişi okunamadı");
                Self::default()
            }
        }
    }

    /// Geçmişi atomik olarak diske yazar.
    ///
    /// # Errors
    /// Serileştirme veya yazma başarısız olursa hata döner.
    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = serde_json::to_vec(self)?;
        persist::atomic_write(path, &bytes)
    }

    /// Bir kontrol sonucunu kaydeder (ring'e ekler + gününü günceller).
    pub fn record(&mut self, result: CheckResult) {
        let day = result.at / SECS_PER_DAY;
        let history = self.monitors.entry(result.monitor_id).or_default();

        match history.days.last_mut() {
            Some(stat) if stat.day == day => bump(stat, &result),
            _ => {
                let mut stat = DayStat {
                    day,
                    ..DayStat::default()
                };
                bump(&mut stat, &result);
                history.days.push(stat);
                if history.days.len() > DAY_CAP {
                    history.days.remove(0);
                }
            }
        }

        history.recent.push(result);
        if history.recent.len() > RECENT_CAP {
            let excess = history.recent.len() - RECENT_CAP;
            history.recent.drain(..excess);
        }
    }

    /// Silinen monitörlerin geçmişini atar.
    pub fn retain_only(&mut self, keep: &[MonitorId]) {
        self.monitors.retain(|id, _| keep.contains(id));
    }

    /// Bir monitörün geçmişi (yoksa `None`).
    #[must_use]
    pub fn history(&self, id: MonitorId) -> Option<&MonitorHistory> {
        self.monitors.get(&id)
    }
}

fn bump(stat: &mut DayStat, result: &CheckResult) {
    if result.up {
        stat.up += 1;
        stat.latency_sum_ms += u64::from(result.latency_ms.unwrap_or(0));
    } else {
        stat.down += 1;
    }
}

/// Şu anki unix zamanı (saniye). Saat 1970 öncesine alınmışsa 0 döner (panik yok).
#[must_use]
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn result(id: MonitorId, at: u64, up: bool) -> CheckResult {
        CheckResult {
            monitor_id: id,
            at,
            up,
            latency_ms: up.then_some(100),
            status: up.then_some(200),
            error: (!up).then(|| "connection refused".to_string()),
            cert_expires_at: None,
        }
    }

    #[test]
    fn single_failure_is_not_down_yet() {
        let id = MonitorId::new();
        let mut history = MonitorHistory::default();
        assert_eq!(history.state(), MonitorState::Unknown);

        history.recent.push(result(id, 1, true));
        assert_eq!(history.state(), MonitorState::Up);

        // Tek hata: henüz Down değil (flap koruması).
        history.recent.push(result(id, 2, false));
        assert_eq!(history.state(), MonitorState::Up);

        // İkinci ardışık hata: artık Down.
        history.recent.push(result(id, 3, false));
        assert_eq!(history.state(), MonitorState::Down);

        // Toparlandı.
        history.recent.push(result(id, 4, true));
        assert_eq!(history.state(), MonitorState::Up);
    }

    #[test]
    fn cert_expiry_survives_an_outage() {
        let id = MonitorId::new();
        let mut history = MonitorHistory::default();
        let mut ok = result(id, 1, true);
        ok.cert_expires_at = Some(2_000_000_000);
        history.recent.push(ok);
        // Hedef düştü: bu kontrolde sertifika okunmadı, ama bilgi kaybolmamalı.
        history.recent.push(result(id, 2, false));

        assert_eq!(history.cert_expires_at(), Some(2_000_000_000));
        assert_eq!(
            history.recent[0].cert_days_left(2_000_000_000 - 10 * 86_400),
            Some(10)
        );
        assert_eq!(history.recent[1].cert_days_left(1), None);
    }

    #[test]
    fn first_check_failing_is_down_immediately() {
        let id = MonitorId::new();
        let mut history = MonitorHistory::default();
        history.recent.push(result(id, 1, false));
        assert_eq!(history.state(), MonitorState::Down);
    }

    #[test]
    fn ring_drops_oldest_beyond_cap() {
        let id = MonitorId::new();
        let mut log = UptimeLog::default();
        for i in 0..(RECENT_CAP as u64 + 10) {
            log.record(result(id, i, true));
        }
        let history = log.history(id).unwrap();
        assert_eq!(history.recent.len(), RECENT_CAP);
        // En eski 10 düştü; ilk kayıt artık at=10.
        assert_eq!(history.recent[0].at, 10);
    }

    #[test]
    fn day_stats_accumulate_and_split_by_day() {
        let id = MonitorId::new();
        let mut log = UptimeLog::default();
        // 1. gün: 3 up, 1 down. 2. gün: 1 up.
        log.record(result(id, SECS_PER_DAY, true));
        log.record(result(id, SECS_PER_DAY + 60, true));
        log.record(result(id, SECS_PER_DAY + 120, true));
        log.record(result(id, SECS_PER_DAY + 180, false));
        log.record(result(id, SECS_PER_DAY * 2, true));

        let days = &log.history(id).unwrap().days;
        assert_eq!(days.len(), 2);
        assert_eq!((days[0].up, days[0].down), (3, 1));
        assert_eq!(days[0].uptime_pct(), 75.0);
        assert_eq!(days[0].avg_latency_ms(), Some(100));
        assert_eq!((days[1].up, days[1].down), (1, 0));
    }

    #[test]
    fn empty_day_reports_zero_not_nan() {
        let stat = DayStat::default();
        assert_eq!(stat.uptime_pct(), 0.0);
        assert_eq!(stat.avg_latency_ms(), None);
    }

    #[test]
    fn save_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("uptime.json");
        let id = MonitorId::new();
        let mut log = UptimeLog::default();
        log.record(result(id, 1_700_000_000, false));
        log.save(&path).unwrap();

        assert_eq!(UptimeLog::load(&path), log);
    }

    #[test]
    fn missing_or_corrupt_file_yields_empty_log() {
        let dir = tempdir().unwrap();
        assert_eq!(
            UptimeLog::load(&dir.path().join("yok.json")),
            UptimeLog::default()
        );

        let bad = dir.path().join("bozuk.json");
        std::fs::write(&bad, b"{ bu json degil").unwrap();
        assert_eq!(UptimeLog::load(&bad), UptimeLog::default());
    }

    #[test]
    fn retain_only_drops_removed_monitors() {
        let keep = MonitorId::new();
        let gone = MonitorId::new();
        let mut log = UptimeLog::default();
        log.record(result(keep, 1, true));
        log.record(result(gone, 1, true));
        log.retain_only(&[keep]);
        assert!(log.history(keep).is_some());
        assert!(log.history(gone).is_none());
    }
}
