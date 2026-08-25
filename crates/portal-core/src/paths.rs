//! Platforma özgü konfig/veri dizinlerini çözer.
//!
//! `directories` crate ile her OS'ta doğru yeri bulur:
//! - Linux:   `~/.config/portal`,          `~/.local/share/portal`
//! - macOS:   `~/Library/Application Support/co.nowtes.portal`
//! - Windows: `%APPDATA%\nowtes\portal`
//!
//! Bkz. docs/ARCHITECTURE.md §5.

use std::path::PathBuf;

use directories::ProjectDirs;

use crate::error::{Error, Result};
use crate::model::ProfileId;

/// Portal'ın kullandığı taban dizinler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// Hassas olmayan konfig dizini (config.toml burada).
    pub config_dir: PathBuf,
    /// Veri dizini (profiller/vault burada).
    pub data_dir: PathBuf,
}

impl Paths {
    /// Platforma göre dizinleri çözer.
    ///
    /// # Errors
    /// Home dizini gibi temel bir konum belirlenemezse [`Error::NoProjectDirs`].
    pub fn resolve() -> Result<Self> {
        let dirs = ProjectDirs::from("co", "nowtes", "portal").ok_or(Error::NoProjectDirs)?;
        Ok(Self {
            config_dir: dirs.config_dir().to_path_buf(),
            data_dir: dirs.data_dir().to_path_buf(),
        })
    }

    /// Belirtilen taban dizinlerden `Paths` kurar (test/özel kurulum için).
    #[must_use]
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            config_dir,
            data_dir,
        }
    }

    /// `config.toml` tam yolu.
    #[must_use]
    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    /// Tüm profillerin bulunduğu dizin.
    #[must_use]
    pub fn profiles_dir(&self) -> PathBuf {
        self.data_dir.join("profiles")
    }

    /// Belirli bir profilin dizini.
    #[must_use]
    pub fn profile_dir(&self, profile: ProfileId) -> PathBuf {
        self.profiles_dir().join(profile.to_string())
    }

    /// Henüz profil seçilmeden önce kullanılan varsayılan vault dosyası.
    ///
    /// Geçici: profil sistemi + şifreleme Faz 2'de gelince veri
    /// `profiles/<profil>/vault.portal` altına taşınacak.
    #[must_use]
    pub fn default_vault_file(&self) -> PathBuf {
        self.data_dir.join("vault.portal")
    }

    /// Portal'ın ürettiği SSH anahtarlarının bulunduğu dizin (`<data>/keys`).
    ///
    /// Kullanıcının `~/.ssh`'ına dokunmaz; Portal kendi anahtarlarını burada tutar.
    #[must_use]
    pub fn keys_dir(&self) -> PathBuf {
        self.data_dir.join("keys")
    }

    /// Portal'ın yönettiği known_hosts dosyası.
    ///
    /// Kullanıcının `~/.ssh/known_hosts`'una dokunmadan güveni burada tutar
    /// (mevcut kurulumu içe aktarma P5'te ele alınır).
    #[must_use]
    pub fn known_hosts_file(&self) -> PathBuf {
        self.data_dir.join("known_hosts")
    }

    /// Uptime kontrol geçmişi (`<data>/uptime.json`).
    ///
    /// Sir tasimaz ve sik yazilir; vault'ta degil duz JSON olarak burada.
    #[must_use]
    pub fn uptime_file(&self) -> PathBuf {
        self.data_dir.join("uptime.json")
    }

    /// Bir profile ait şifreli vault dosyası (`vault.portal`).
    #[must_use]
    pub fn vault_file(&self, profile: ProfileId) -> PathBuf {
        self.profile_dir(profile).join("vault.portal")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_platform_dirs() {
        let paths = Paths::resolve().expect("standart bir ortamda dizinler çözülmeli");
        assert!(paths.config_file().ends_with("config.toml"));
        assert!(paths.profiles_dir().ends_with("profiles"));
    }

    #[test]
    fn vault_path_is_under_profile_dir() {
        let paths = Paths::new(PathBuf::from("/cfg"), PathBuf::from("/data"));
        let profile = ProfileId::new();
        let vault = paths.vault_file(profile);
        assert!(vault.ends_with("vault.portal"));
        assert!(vault.starts_with(paths.profile_dir(profile)));
    }
}
