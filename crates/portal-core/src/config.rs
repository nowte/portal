//! Hassas olmayan uygulama konfigürasyonu (`config.toml`).
//!
//! İnsan-okur, hassas veri içermez (tema, aktif profil referansı, telemetri).
//! Hassas veri vault'a gider. Bkz. docs/ARCHITECTURE.md §5.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::{Profile, ProfileId};
use crate::persist;

/// Uygulama konfigürasyonu.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Aktif tema (varsayılan Black).
    pub theme: Theme,
    /// Son kullanılan/aktif profil referansı.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile: Option<ProfileId>,
    /// Telemetri (varsayılan kapalı, opt-in). Bkz. docs/ARCHITECTURE.md §1.
    pub telemetry_enabled: bool,
    /// İlk-çalıştırma onboarding sihirbazı tamamlandı/atlandı mı.
    pub onboarded: bool,
    /// Pencere kapatılınca uygulama sistem tepsisine insin (kapanmasın).
    /// Kapalıyken (varsayılan) kapatma uygulamadan çıkar ve uptime kontrolleri durur.
    pub minimize_to_tray: bool,
    /// BYOS senkron hedef klasörü — şifreli vault buraya kopyalanır (yoksa senkron kapalı).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_dir: Option<std::path::PathBuf>,
    /// Terminal yazı boyutu (px). Host başına değil, uygulama geneli — bir kez
    /// ayarlanır, her terminalde geçerlidir. Yoksa varsayılan
    /// [`crate::store::TERM_FONT_DEFAULT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_font_size: Option<u8>,
    /// Bir monitör düşünce/geri gelince masaüstü bildirimi gönderilsin mi.
    /// Yoksa AÇIK sayılır — bildirim istemeyen kapatır, isteyen ayar aramaz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify_uptime: Option<bool>,
    /// Yerel profillerin **hassas olmayan** indeksi (ad, kilit bayrakları). Her profilin
    /// asıl verisi kendi şifreli `vault.portal`'ındadır; ama bu indeks kilit açılmadan
    /// okunabilmeli (hangi profil var, parola gerekir mi). Bkz. docs/ARCHITECTURE.md §5.
    /// TOML "array of tables" olması için struct'ta EN SONDA durmalı.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<Profile>,
}

impl Config {
    /// Konfigi dosyadan yükler; dosya yoksa varsayılanı döndürür (yazmaz).
    ///
    /// # Errors
    /// Dosya okunamazsa veya geçersiz TOML ise hata döner.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = persist::read_string(path)?;
        let config = toml::from_str(&text)?;
        Ok(config)
    }

    /// Konfigi TOML olarak atomik yazar (üst dizini oluşturur).
    ///
    /// # Errors
    /// Serileştirme veya yazma başarısız olursa hata döner.
    pub fn save(&self, path: &Path) -> Result<()> {
        let text = toml::to_string_pretty(self)?;
        persist::atomic_write(path, text.as_bytes())
    }
}

/// Monokrom temalar (docs/DESIGN.md §3). Hepsi siyah/beyaz/gri.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Neredeyse-siyah (varsayılan).
    #[default]
    Black,
    /// Yumuşak koyu gri.
    Graphite,
    /// Açık — Notion/Vercel beyaz-gri.
    Paper,
    /// Saf siyah-beyaz.
    Contrast,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_is_black_no_profile_no_telemetry() {
        let config = Config::default();
        assert_eq!(config.theme, Theme::Black);
        assert_eq!(config.active_profile, None);
        assert!(!config.telemetry_enabled);
    }

    #[test]
    fn missing_file_yields_default_without_writing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let config = Config::load(&path).unwrap();
        assert_eq!(config, Config::default());
        assert!(!path.exists(), "load yalnızca okur, yazmaz");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("config.toml");

        let profile = Profile::new("work", "alex-laptop");
        let config = Config {
            theme: Theme::Paper,
            active_profile: Some(profile.id),
            telemetry_enabled: true,
            onboarded: true,
            minimize_to_tray: true,
            sync_dir: Some(std::path::PathBuf::from("/backups/portal")),
            terminal_font_size: Some(16),
            notify_uptime: Some(false),
            profiles: vec![profile],
        };

        config.save(&path).unwrap();
        assert!(path.exists());
        assert_eq!(Config::load(&path).unwrap(), config);
    }

    #[test]
    fn profiles_index_roundtrips_as_toml() {
        // Profil indeksi plaintext TOML "array of tables" olarak yazılıp okunmalı.
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::default();
        config.profiles.push(Profile::new("work", "alex-laptop"));
        config
            .profiles
            .push(Profile::new("personal", "alex-laptop"));
        config.save(&path).unwrap();

        let text = persist::read_string(&path).unwrap();
        assert!(text.contains("[[profiles]]"), "got:\n{text}");
        assert_eq!(Config::load(&path).unwrap(), config);
    }

    #[test]
    fn theme_serializes_lowercase() {
        let toml = toml::to_string(&Config::default()).unwrap();
        assert!(toml.contains("theme = \"black\""), "got:\n{toml}");
    }
}
