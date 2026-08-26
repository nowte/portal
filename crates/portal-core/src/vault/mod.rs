//! Profil domain verisi (host'lar, klasörler, kimlikler, snippet'ler, monitörler).
//!
//! Bu, bir profilin **şifre çözülmüş** (bellekteki) içeriğidir.
//!
//! - **Faz 0–1:** [`Vault::save`]/[`Vault::load`] içeriği düz metin JSON olarak
//!   diske yazar/okur — kripto yok (geriye dönük / geçiş için korunur).
//! - **Faz 2-B (P4):** aynı serileştirilmiş baytlar, I/O sınırında şifrelenir
//!   ([`Vault::save_encrypted`]/[`Vault::load_encrypted`] — Argon2id +
//!   XChaCha20-Poly1305, bkz. [`crypto`]). Bellekteki şekil aynı kaldığı için bu
//!   katmanın üstündeki hiçbir kod değişmez.
//!
//! Bkz. docs/ARCHITECTURE.md §5.

pub mod crypto;
pub mod keystore;
pub mod recovery;

use std::path::Path;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::Result;
use crate::model::{Folder, Host, Identity, Monitor, Snippet, StoredSecret};
use crate::persist;
use crypto::{OpenKey, SealKey, VaultCipher};

/// Bir profilin şifre çözülmüş domain verisi.
///
/// Not: profil **indeksi** (ad/kilit bayrakları) burada değil, hassas olmayan
/// [`crate::Config`]'tedir — kilit açılmadan okunabilmesi için. Bu yapı yalnızca
/// tek bir profilin gizli içeriğidir.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Vault {
    /// Klasörler (gruplama ağacı).
    pub folders: Vec<Folder>,
    /// Kimlik doğrulama kayıtları.
    pub identities: Vec<Identity>,
    /// Kaydedilmiş host'lar.
    pub hosts: Vec<Host>,
    /// Kaydedilmiş komutlar.
    pub snippets: Vec<Snippet>,
    /// Uptime monitörleri (site/port kontrolleri).
    pub monitors: Vec<Monitor>,
    /// Host başına saklanan bağlanma sırları ("Remember" işaretliyse).
    /// `default`: eski vault'lar bu alan olmadan da açılır.
    #[serde(default)]
    pub secrets: Vec<StoredSecret>,
}

impl Vault {
    /// Vault'ı düz metin JSON olarak dosyadan yükler; dosya yoksa boş bir vault döner.
    ///
    /// Yalnızca şifresiz/eski vault'lar içindir; şifreli için [`Vault::load_encrypted`].
    ///
    /// # Errors
    /// Dosya okunamazsa veya geçersiz JSON ise hata döner.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            tracing::debug!(path = %path.display(), "vault dosyası yok; boş vault ile başlanıyor");
            return Ok(Self::default());
        }
        let bytes = persist::read_bytes(path)?;
        let vault = serde_json::from_slice(&bytes)?;
        tracing::debug!(path = %path.display(), "vault yüklendi");
        Ok(vault)
    }

    /// Vault'ı düz metin JSON olarak diske atomik yazar.
    ///
    /// Yalnızca şifresiz/eski vault'lar içindir; şifreli için [`Vault::save_encrypted`].
    ///
    /// # Errors
    /// Serileştirme veya yazma başarısız olursa hata döner.
    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(self)?;
        persist::atomic_write(path, &bytes)?;
        tracing::debug!(path = %path.display(), "vault kaydedildi");
        Ok(())
    }

    /// Vault'ı şifreli zarf olarak diske atomik yazar (Argon2id + XChaCha20-Poly1305).
    ///
    /// `keys` bu vault'u açabilecek anahtar sarımlarıdır (parola/keyring/recovery);
    /// en az biri gerekir. `updated_at_ms` BYOS çakışma çözümünün zaman damgasıdır
    /// ([`crypto::now_millis`]). Serileştirilmiş düz metin bellek içinde sıfırlanır.
    ///
    /// # Errors
    /// Serileştirme, kripto ya da yazma başarısız olursa hata döner.
    pub fn save_encrypted(
        &self,
        path: &Path,
        keys: &[SealKey<'_>],
        device_label: &str,
        updated_at_ms: u64,
    ) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(self)?);
        let sealed = crypto::seal(&plaintext, keys, device_label, updated_at_ms)?;
        persist::atomic_write(path, &sealed)?;
        tracing::debug!(path = %path.display(), "şifreli vault kaydedildi");
        Ok(())
    }

    /// Şifreli vault'ı dosyadan açar.
    ///
    /// # Errors
    /// Dosya okunamaz/bozuksa veya anahtar/parola yanlışsa hata döner.
    pub fn load_encrypted(path: &Path, key: OpenKey<'_>) -> Result<Self> {
        let bytes = persist::read_bytes(path)?;
        let plaintext = crypto::open(&bytes, key)?;
        let vault = serde_json::from_slice(plaintext.as_slice())?;
        tracing::debug!(path = %path.display(), "şifreli vault açıldı");
        Ok(vault)
    }

    /// Var olan bir cipher oturumuyla şifreli yazar (anahtar sarımları korunur).
    ///
    /// Store'un her mutasyonda kullandığı yol: bir kez açılan [`VaultCipher`] ile
    /// yalnızca payload yeniden şifrelenir; parola/keyring/recovery sarımları aynen kalır.
    ///
    /// # Errors
    /// Serileştirme, kripto ya da yazma başarısız olursa hata döner.
    pub fn save_with_cipher(
        &self,
        path: &Path,
        cipher: &VaultCipher,
        device_label: &str,
        updated_at_ms: u64,
    ) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(self)?);
        let sealed = cipher.seal(&plaintext, device_label, updated_at_ms)?;
        persist::atomic_write(path, &sealed)?;
        tracing::debug!(path = %path.display(), "şifreli vault kaydedildi (cipher)");
        Ok(())
    }

    /// Şifreli dosyayı açar; hem cipher oturumunu hem çözülmüş veriyi döndürür.
    ///
    /// Store açılış/kilit-açma yolu: dönen [`VaultCipher`] sonraki kayıtlarda saklanır.
    ///
    /// # Errors
    /// Dosya okunamaz/bozuksa veya anahtar/parola yanlışsa hata döner.
    pub fn unlock(path: &Path, key: OpenKey<'_>) -> Result<(VaultCipher, Self)> {
        let bytes = persist::read_bytes(path)?;
        let (cipher, plaintext) = VaultCipher::unlock(&bytes, key)?;
        let vault = serde_json::from_slice(plaintext.as_slice())?;
        tracing::debug!(path = %path.display(), "şifreli vault açıldı (cipher)");
        Ok((cipher, vault))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AuthMethod, HostId};
    use tempfile::tempdir;

    fn sample_vault() -> Vault {
        let folder = Folder::new("prod");
        let identity = Identity::new("alex-laptop", AuthMethod::Agent);

        let mut host = Host::new("prod-web", "203.0.113.10");
        host.folder_id = Some(folder.id);
        host.identity_id = Some(identity.id);
        host.username = Some("deploy".into());
        host.tags = vec!["web".into()];

        let mut snippet = Snippet::new("restart nginx", "sudo systemctl restart nginx");
        snippet.host_id = Some(host.id);

        let mut monitor = Monitor::new(
            "site",
            crate::model::MonitorTarget::Http {
                url: "https://example.com".into(),
                expect_status: Some(200),
                contains: None,
            },
        );
        monitor.host_id = Some(host.id);
        let host_id_for_secret = host.id;

        Vault {
            folders: vec![folder],
            identities: vec![identity],
            hosts: vec![host],
            snippets: vec![snippet],
            monitors: vec![monitor],
            secrets: vec![StoredSecret {
                host_id: host_id_for_secret,
                key_path: None,
                secret: "sample-secret".into(),
            }],
        }
    }

    #[test]
    fn missing_file_yields_empty_vault() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.portal");
        assert_eq!(Vault::load(&path).unwrap(), Vault::default());
        assert!(!path.exists());
    }

    #[test]
    fn save_then_load_roundtrips_all_models() {
        let dir = tempdir().unwrap();
        let path = dir
            .path()
            .join("profiles")
            .join("work")
            .join("vault.portal");

        let vault = sample_vault();
        vault.save(&path).unwrap();
        assert!(path.exists());

        let loaded = Vault::load(&path).unwrap();
        assert_eq!(loaded, vault);
    }

    #[test]
    fn empty_vault_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.portal");
        let vault = Vault::default();
        vault.save(&path).unwrap();
        assert_eq!(Vault::load(&path).unwrap(), vault);
    }

    #[test]
    fn references_between_models_survive_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.portal");

        let vault = sample_vault();
        vault.save(&path).unwrap();
        let loaded = Vault::load(&path).unwrap();

        // Host, klasör ve kimlik referansları korunmalı.
        let host = &loaded.hosts[0];
        assert_eq!(host.folder_id, Some(loaded.folders[0].id));
        assert_eq!(host.identity_id, Some(loaded.identities[0].id));
        assert_eq!(loaded.snippets[0].host_id, Some(host.id));
        // Var olmayan referans üretilmediğinden emin ol.
        assert_ne!(host.id, HostId::new());
    }

    #[test]
    fn encrypted_roundtrips_with_password() {
        let dir = tempdir().unwrap();
        let path = dir
            .path()
            .join("profiles")
            .join("work")
            .join("vault.portal");

        let vault = sample_vault();
        vault
            .save_encrypted(&path, &[SealKey::Password("hunter2")], "alex-laptop", 42)
            .unwrap();
        assert!(path.exists());

        let loaded = Vault::load_encrypted(&path, OpenKey::Password("hunter2")).unwrap();
        assert_eq!(loaded, vault);
    }

    #[test]
    fn encrypted_wrong_password_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.portal");
        sample_vault()
            .save_encrypted(&path, &[SealKey::Password("right")], "dev", 1)
            .unwrap();
        assert!(Vault::load_encrypted(&path, OpenKey::Password("wrong")).is_err());
    }

    #[test]
    fn encrypted_file_has_no_plaintext_secrets() {
        // Kabul denetimi: diskte düz metin hassas veri YOK.
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.portal");
        sample_vault()
            .save_encrypted(&path, &[SealKey::Password("pw")], "dev", 1)
            .unwrap();

        let on_disk = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&on_disk);
        assert!(!text.contains("203.0.113.10"), "host adresi sızdı");
        assert!(!text.contains("deploy"), "kullanıcı adı sızdı");
        assert!(!text.contains("restart nginx"), "snippet sızdı");
    }
}
