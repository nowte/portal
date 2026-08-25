//! Kütüphane hata sınırı.
//!
//! Çekirdek `thiserror` kullanır; binary kenarı (portal-tui) bunu `anyhow` ile
//! sarar. Bkz. docs/ARCHITECTURE.md §9.

use std::path::PathBuf;

use thiserror::Error;

/// Çekirdek boyunca kullanılan kısayol `Result`.
pub type Result<T> = std::result::Result<T, Error>;

/// Portal çekirdeğinin döndürebileceği tüm hatalar.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// Bir dosya yolunda I/O hatası; yol bağlamı korunur.
    #[error("I/O hatası: {path}")]
    Io {
        /// Hataya yol açan dosya/dizin yolu.
        path: PathBuf,
        /// Altta yatan I/O hatası.
        #[source]
        source: std::io::Error,
    },

    /// TOML serileştirme (config yazma) hatası.
    #[error("TOML yazılamadı")]
    TomlSerialize(#[from] toml::ser::Error),

    /// TOML ayrıştırma (config okuma) hatası.
    #[error("TOML ayrıştırılamadı")]
    TomlParse(#[from] toml::de::Error),

    /// JSON (de)serileştirme hatası — vault kalıcılığı.
    #[error("JSON (de)serileştirilemedi")]
    Json(#[from] serde_json::Error),

    /// Vault şifreleme/çözme hatası (yanlış parola, bozuk dosya vb.).
    #[error("{0}")]
    Crypto(#[from] crate::vault::crypto::CryptoError),

    /// OS keyring/kasa erişilemedi (parolasız mod). Kullanıcıya dönük → İngilizce.
    #[error("OS keyring unavailable: {0}")]
    Keyring(String),

    /// Vault kilitli — yazma/okuma öncesi kilit açılmalı (parola gerekir).
    #[error("vault is locked; unlock it first")]
    VaultLocked,

    /// SSH anahtar işlemi hatası (üret/oku/şifrele). Kullanıcıya dönük → İngilizce.
    #[error("{0}")]
    Key(String),

    /// BYOS senkron kurulum/işlem hatası. Kullanıcıya dönük → İngilizce.
    #[error("{0}")]
    Sync(String),

    /// Platforma özgü veri/konfig dizinleri çözülemedi (ör. home dizini yok).
    #[error("Portal için platform dizinleri belirlenemedi")]
    NoProjectDirs,
}

impl Error {
    /// Bir I/O hatasını, hangi yolda oluştuğu bağlamıyla sarar.
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
