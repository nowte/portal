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
    #[error("Couldn't read or write {path}: {source}. Check the file still exists and that Portal is allowed to write there.")]
    Io {
        /// Hataya yol açan dosya/dizin yolu.
        path: PathBuf,
        /// Altta yatan I/O hatası.
        #[source]
        source: std::io::Error,
    },

    /// TOML serileştirme (config yazma) hatası.
    #[error(
        "Couldn't save Portal's settings file: {0}. Close anything else editing it and try again."
    )]
    TomlSerialize(#[from] toml::ser::Error),

    /// TOML ayrıştırma (config okuma) hatası.
    #[error("Portal's settings file is damaged and couldn't be read: {0}. Delete config.toml in Portal's data folder to start from defaults.")]
    TomlParse(#[from] toml::de::Error),

    /// JSON (de)serileştirme hatası — vault kalıcılığı.
    #[error("Portal couldn't read its vault contents: {0}. If this keeps happening, restore vault.portal.bak from Portal's data folder.")]
    Json(#[from] serde_json::Error),

    /// Vault şifreleme/çözme hatası (yanlış parola, bozuk dosya vb.).
    #[error("{0}")]
    Crypto(#[from] crate::vault::crypto::CryptoError),

    /// OS keyring/kasa erişilemedi (parolasız mod). Kullanıcıya dönük → İngilizce.
    #[error("OS keyring unavailable: {0}")]
    Keyring(String),

    /// Vault kilitli — yazma/okuma öncesi kilit açılmalı (parola gerekir).
    #[error("This profile is locked. Unlock it with your password before changing anything.")]
    VaultLocked,

    /// Sır saklanmak istendi ama vault ŞİFRELİ DEĞİL (profil yok → düz metin JSON).
    /// Sırrı oraya yazmak "diskte düz metin hassas veri yok" iddiasını çiğnerdi.
    #[error("Set up a profile password before Portal can remember credentials.")]
    SecretsNeedEncryptedVault,

    /// SSH anahtar işlemi hatası (üret/oku/şifrele). Kullanıcıya dönük → İngilizce.
    #[error("{0}")]
    Key(String),

    /// BYOS senkron kurulum/işlem hatası. Kullanıcıya dönük → İngilizce.
    #[error("{0}")]
    Sync(String),

    /// Güncelleme kontrolü (ağ/yanıt) hatası. Kullanıcıya dönük → İngilizce.
    #[error("{0}")]
    Update(String),

    /// Platforma özgü veri/konfig dizinleri çözülemedi (ör. home dizini yok).
    #[error("Portal couldn't work out where to keep its data on this machine. Check that your user profile folder is reachable.")]
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
