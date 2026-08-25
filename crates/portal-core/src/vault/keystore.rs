//! Makine-anahtarı kasası soyutlaması (parolasız mod için).
//!
//! Parolasız modda vault, kullanıcıdan parola istemeden, burada tutulan ham
//! 32-baytlık bir anahtarla sarılır (bkz. [`crate::vault::crypto`] keyring sarımı).
//! Anahtar **diske düz metin yazılmaz**; OS kasasında (Windows Credential Manager /
//! macOS Keychain / Linux secret-service) durur.
//!
//! Bu bir **trait**tir: test/CI gerçek OS kasasına dokunmadan [`MemoryKeyStore`]
//! ile çalışır. Gerçek OS-keyring implementasyonu P4b'de (startup kilit-açma)
//! eklenir. Bkz. docs/ARCHITECTURE.md §5.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use crate::error::{Error, Result};
use crate::model::ProfileId;

/// Anahtar uzunluğu (bayt) — [`crate::vault::crypto`] ile aynı.
pub const KEY_LEN: usize = 32;

/// Bir profilin makine-anahtarını saklayan/getiren kasa.
///
/// `Send + Sync`: `Store` bunu `Box<dyn KeyStore>` olarak tutar; GUI (Tauri) bu
/// Store'u iş parçacıkları arası paylaşılan bir `State` içinde yönetir. İki
/// implementör de zaten Send+Sync ([`MemoryKeyStore`] = `Arc<Mutex>`, [`KeyringStore`] = `String`).
pub trait KeyStore: Send + Sync {
    /// Profilin anahtarını getirir; yoksa `Ok(None)`.
    ///
    /// # Errors
    /// Kasa erişilemezse hata döner.
    fn get(&self, profile: ProfileId) -> Result<Option<[u8; KEY_LEN]>>;

    /// Profilin anahtarını saklar (varsa üzerine yazar).
    ///
    /// # Errors
    /// Kasaya yazılamazsa hata döner.
    fn set(&self, profile: ProfileId, key: &[u8; KEY_LEN]) -> Result<()>;

    /// Profilin anahtarını siler (yoksa no-op).
    ///
    /// # Errors
    /// Kasadan silinemezse hata döner.
    fn delete(&self, profile: ProfileId) -> Result<()>;
}

/// Bellek-içi kasa — testler ve headless senaryolar için.
///
/// [`Clone`] altta yatan haritayı **paylaşır** (`Arc<Mutex<…>>`): aynı kasayı iki
/// `Store` örneğine verip "uygulama yeniden açıldı" senaryosunu (anahtar kalıcı)
/// modelleyebilirsin. Süreç ömrüyle sınırlıdır; diske yazmaz.
#[derive(Debug, Clone, Default)]
pub struct MemoryKeyStore {
    keys: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<ProfileId, [u8; KEY_LEN]>>>,
}

impl MemoryKeyStore {
    /// Boş bir bellek kasası.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, profile: ProfileId) -> Result<Option<[u8; KEY_LEN]>> {
        // Kilit yalnızca bir panik sırasında zehirlenir; poison'ı temiz veriye çevir.
        let map = self.keys.lock().unwrap_or_else(|p| p.into_inner());
        Ok(map.get(&profile).copied())
    }

    fn set(&self, profile: ProfileId, key: &[u8; KEY_LEN]) -> Result<()> {
        let mut map = self.keys.lock().unwrap_or_else(|p| p.into_inner());
        map.insert(profile, *key);
        Ok(())
    }

    fn delete(&self, profile: ProfileId) -> Result<()> {
        let mut map = self.keys.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(&profile);
        Ok(())
    }
}

/// OS keyring destekli gerçek kasa (Windows Credential Manager / macOS Keychain /
/// Linux secret-service, `keyring` crate v1 API).
///
/// Anahtarı base64 metin olarak saklar (tüm platformların desteklediği en taşınabilir
/// yol). Kasa yoksa (ör. secret-service çalışmayan headless Linux) [`Error::Keyring`]
/// döner; çağıran bunu "parolasız mod kullanılamaz, parola iste" olarak yorumlar.
#[derive(Debug, Clone)]
pub struct KeyringStore {
    /// Kasa servis adı (ör. "co.nowtes.portal").
    service: String,
}

impl KeyringStore {
    /// Verilen servis adıyla bir kasa.
    #[must_use]
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// Bir profil için kasa girişi.
    fn entry(&self, profile: ProfileId) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &profile.to_string())
            .map_err(|e| Error::Keyring(e.to_string()))
    }
}

impl Default for KeyringStore {
    /// Portal'ın varsayılan servis adıyla.
    fn default() -> Self {
        Self::new("co.nowtes.portal")
    }
}

impl KeyStore for KeyringStore {
    fn get(&self, profile: ProfileId) -> Result<Option<[u8; KEY_LEN]>> {
        match self.entry(profile)?.get_password() {
            Ok(text) => {
                let bytes = STANDARD
                    .decode(text.as_bytes())
                    .map_err(|e| Error::Keyring(format!("stored key is not valid base64: {e}")))?;
                let key = <[u8; KEY_LEN]>::try_from(bytes.as_slice())
                    .map_err(|_| Error::Keyring("stored key has wrong length".into()))?;
                Ok(Some(key))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }

    fn set(&self, profile: ProfileId, key: &[u8; KEY_LEN]) -> Result<()> {
        self.entry(profile)?
            .set_password(&STANDARD.encode(key))
            .map_err(|e| Error::Keyring(e.to_string()))
    }

    fn delete(&self, profile: ProfileId) -> Result<()> {
        match self.entry(profile)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_delete_cycle() {
        let store = MemoryKeyStore::new();
        let id = ProfileId::new();
        assert_eq!(store.get(id).unwrap(), None);

        let key = [5u8; KEY_LEN];
        store.set(id, &key).unwrap();
        assert_eq!(store.get(id).unwrap(), Some(key));

        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
    }

    #[test]
    fn keys_are_per_profile() {
        let store = MemoryKeyStore::new();
        let a = ProfileId::new();
        let b = ProfileId::new();
        store.set(a, &[1u8; KEY_LEN]).unwrap();
        assert_eq!(store.get(a).unwrap(), Some([1u8; KEY_LEN]));
        assert_eq!(store.get(b).unwrap(), None);
    }

    // Gerçek OS kasasına dokunur → CI'de çalışmaz; bir kasası olan makinede elle:
    //   cargo test -p portal-core keyring_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "gerçek OS keyring gerektirir (elle çalıştır)"]
    fn keyring_roundtrip() {
        let store = KeyringStore::new("co.nowtes.portal-test");
        let id = ProfileId::new();
        assert_eq!(store.get(id).unwrap(), None);
        let key = [42u8; KEY_LEN];
        store.set(id, &key).unwrap();
        assert_eq!(store.get(id).unwrap(), Some(key));
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
    }
}
