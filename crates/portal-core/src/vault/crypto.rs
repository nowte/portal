//! Vault zarf (envelope) şifrelemesi — saf, I/O'suz, test edilebilir.
//!
//! **Kendi kripto YOK.** Bilinen kütüphaneler:
//! - [`argon2`] (Argon2id) — parolayı/kurtarma cümlesini bir anahtar-şifreleme
//!   anahtarına (KEK) türetir.
//! - [`chacha20poly1305`] (XChaCha20-Poly1305, 24-baytlık nonce) — AEAD.
//!
//! ## Zarf modeli (tek DEK, çok anahtar sarımı)
//! Rastgele bir **veri anahtarı (DEK)** vault JSON'unu şifreler. DEK ayrı ayrı
//! *sarılır* (parola-KEK, keyring-KEK, kurtarma-KEK). Böylece parolayı sonradan
//! eklemek yalnızca yeni bir sarım demektir — payload yeniden şifrelenmez.
//!
//! Dış başlık (`version`, `updated_at`, `device_label`) **açık** durur ve
//! payload'ın AEAD *associated data*'sı olarak bağlanır: BYOS çakışma çözümü
//! (son-yazan + zaman damgası) dosyayı açmadan yapılır, başlık kurcalanırsa
//! şifre çözme başarısız olur.
//!
//! Bkz. docs/ARCHITECTURE.md §5, §6.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Zarf dosya formatının sürümü. İleride şema değişirse artırılır.
pub const FORMAT_VERSION: u32 = 1;

/// KDF/AEAD anahtar uzunluğu (bayt).
const KEY_LEN: usize = 32;
/// XChaCha20 nonce uzunluğu (bayt).
const NONCE_LEN: usize = 24;
/// Argon2 salt uzunluğu (bayt).
const SALT_LEN: usize = 16;

/// Vault kripto hataları. Kullanıcıya görünür → İngilizce, kısa, çözülebilir.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CryptoError {
    /// Şifre çözme başarısız: yanlış parola/anahtar ya da bozuk dosya.
    #[error("That password didn't open the vault. Check the password — or, if it was right, this vault file may be damaged; restore vault.portal.bak from Portal's data folder.")]
    Decrypt,
    /// Şifreleme başarısız (beklenmez).
    #[error("Portal couldn't encrypt the vault, so nothing was saved. Try the change again; if it keeps failing, restart Portal.")]
    Encrypt,
    /// Anahtar türetme (Argon2id) başarısız.
    #[error("Portal couldn't derive the vault key from your password. Close other heavy applications (this step needs memory) and try again.")]
    Kdf,
    /// Güvenli rastgelelik kaynağı yok.
    #[error("This machine's secure random source is unavailable, so Portal refused to create weak keys. Restart the machine and try again.")]
    Rng,
    /// Dosya tanınan bir Portal vault'u değil (bozuk/eski format).
    #[error("That file isn't a Portal vault. Point Portal at the vault.portal file it created, not another file in the folder.")]
    Format,
    /// Bu vault'u açacak eşleşen bir anahtar sarımı yok.
    #[error("None of this machine's saved keys open that vault. Unlock it with the profile password, or with your recovery phrase.")]
    NoMatchingKey,
}

type CryptoResult<T> = Result<T, CryptoError>;

/// Bir DEK'i sarmanın yöntemi (hangi tür anahtar).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WrapMethod {
    /// Kullanıcı parolası (Argon2id ile türetilir).
    Password,
    /// OS keyring / makine kasası (ham 32-baytlık anahtar).
    Keyring,
    /// Kurtarma cümlesi (Argon2id ile türetilir).
    Recovery,
}

/// Vault kilitlerken kullanılacak anahtar kaynağı (sarım üretimi).
#[derive(Clone, Copy)]
pub enum SealKey<'a> {
    /// Kullanıcı parolası.
    Password(&'a str),
    /// Kurtarma cümlesi.
    Recovery(&'a str),
    /// Keyring'den gelen ham anahtar.
    Keyring(&'a [u8; KEY_LEN]),
}

/// Vault açarken kullanılacak anahtar kaynağı.
#[derive(Clone, Copy)]
pub enum OpenKey<'a> {
    /// Kullanıcı parolası.
    Password(&'a str),
    /// Kurtarma cümlesi.
    Recovery(&'a str),
    /// Keyring'den gelen ham anahtar.
    Keyring(&'a [u8; KEY_LEN]),
}

impl OpenKey<'_> {
    /// Bu anahtarın hangi sarım yöntemine karşılık geldiği.
    fn method(self) -> WrapMethod {
        match self {
            OpenKey::Password(_) => WrapMethod::Password,
            OpenKey::Recovery(_) => WrapMethod::Recovery,
            OpenKey::Keyring(_) => WrapMethod::Keyring,
        }
    }
}

/// Şifre çözmeden okunabilen açık başlık (BYOS çakışma çözümü için).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// Format sürümü.
    pub version: u32,
    /// Mantıksal son-yazılma zamanı (unix ms).
    pub updated_at: u64,
    /// Yazan cihazın etiketi.
    pub device_label: String,
}

/// Diskteki zarf (JSON). İkili alanlar base64 taşınır → dosya gözle "şifreli".
#[derive(Serialize, Deserialize)]
struct Sealed {
    version: u32,
    updated_at: u64,
    device_label: String,
    wraps: Vec<Wrap>,
    #[serde(with = "b64")]
    payload_nonce: Vec<u8>,
    #[serde(with = "b64")]
    payload: Vec<u8>,
}

/// Tek bir DEK sarımı (bir anahtar yöntemi için şifreli DEK).
#[derive(Clone, Serialize, Deserialize)]
struct Wrap {
    method: WrapMethod,
    /// Argon2 salt'ı (parola/recovery için); keyring'de boş.
    #[serde(with = "b64", default, skip_serializing_if = "Vec::is_empty")]
    salt: Vec<u8>,
    #[serde(with = "b64")]
    nonce: Vec<u8>,
    /// Şifreli DEK (+ AEAD tag).
    #[serde(with = "b64")]
    dek: Vec<u8>,
}

/// Bir vault'u verilen anahtar(lar)la kilitler; serileştirilmiş zarf baytlarını döndürür.
///
/// `plaintext` tipik olarak vault JSON'udur. `updated_at_ms` çakışma çözümünde
/// kullanılan mantıksal zaman damgasıdır ([`now_millis`]).
///
/// # Errors
/// Rastgelelik/KDF/AEAD/serileştirme başarısız olursa ya da `keys` boşsa hata döner.
pub fn seal(
    plaintext: &[u8],
    keys: &[SealKey<'_>],
    device_label: &str,
    updated_at_ms: u64,
) -> CryptoResult<Vec<u8>> {
    VaultCipher::create(keys)?.seal(plaintext, device_label, updated_at_ms)
}

/// Serileştirilmiş bir zarfı verilen anahtarla açar; düz metni döndürür.
///
/// # Errors
/// Dosya bozuk, eşleşen sarım yok ya da anahtar/parola yanlışsa hata döner.
pub fn open(sealed_bytes: &[u8], key: OpenKey<'_>) -> CryptoResult<Zeroizing<Vec<u8>>> {
    let (_cipher, plain) = VaultCipher::unlock(sealed_bytes, key)?;
    Ok(plain)
}

/// Bir vault oturumunun **bellekteki** kripto durumu: veri anahtarı (DEK) + tüm
/// anahtar sarımları.
///
/// Bir kez açıldığında (parola/keyring/recovery'den herhangi biriyle) DEK ve
/// *bütün* sarımlar bellekte tutulur. Böylece:
/// - **Her kayıt** yalnızca payload'ı yeni bir nonce ile şifreler; sarımlar aynen
///   korunur → başka yöntemlerin sırrını (ör. recovery cümlesi) bilmeden yeniden
///   yazabiliriz.
/// - **Sonradan yöntem eklemek** ([`VaultCipher::add_key`]) yalnızca bilinen DEK'i
///   yeni bir KEK ile sarmaktır — payload'a dokunulmaz.
///
/// DEK kapsam dışına çıkınca [`Zeroizing`] ile sıfırlanır.
pub struct VaultCipher {
    dek: Zeroizing<[u8; KEY_LEN]>,
    wraps: Vec<Wrap>,
}

impl VaultCipher {
    /// Rastgele bir DEK üretir ve verilen anahtarlarla sarar (yeni vault).
    ///
    /// # Errors
    /// `keys` boşsa ya da rastgelelik/KDF/AEAD başarısız olursa hata döner.
    pub fn create(keys: &[SealKey<'_>]) -> CryptoResult<Self> {
        if keys.is_empty() {
            return Err(CryptoError::NoMatchingKey);
        }
        let dek = Zeroizing::new(random_bytes::<KEY_LEN>()?);
        let mut wraps = Vec::with_capacity(keys.len());
        for &key in keys {
            wraps.push(wrap_for(&dek, key)?);
        }
        Ok(Self { dek, wraps })
    }

    /// Var olan bir zarfı açar: DEK ve tüm sarımları geri kazanır; düz metni de döndürür.
    ///
    /// # Errors
    /// Dosya bozuk, eşleşen sarım yok ya da anahtar/parola yanlışsa hata döner.
    pub fn unlock(
        sealed_bytes: &[u8],
        key: OpenKey<'_>,
    ) -> CryptoResult<(Self, Zeroizing<Vec<u8>>)> {
        let sealed: Sealed =
            serde_json::from_slice(sealed_bytes).map_err(|_| CryptoError::Format)?;
        if sealed.version != FORMAT_VERSION {
            return Err(CryptoError::Format);
        }
        let want = key.method();
        let wrap = sealed
            .wraps
            .iter()
            .find(|w| w.method == want)
            .ok_or(CryptoError::NoMatchingKey)?;
        let dek = unwrap_dek(wrap, key)?;
        let aad = header_aad(sealed.version, sealed.updated_at, &sealed.device_label);
        let plain = Zeroizing::new(aead_open(
            &dek,
            &sealed.payload_nonce,
            &sealed.payload,
            &aad,
        )?);
        Ok((
            Self {
                dek,
                wraps: sealed.wraps,
            },
            plain,
        ))
    }

    /// Düz metni mevcut DEK + sarımlarla zarfa şifreler (sarımlar korunur).
    ///
    /// # Errors
    /// AEAD/serileştirme başarısız olursa hata döner.
    pub fn seal(
        &self,
        plaintext: &[u8],
        device_label: &str,
        updated_at_ms: u64,
    ) -> CryptoResult<Vec<u8>> {
        let aad = header_aad(FORMAT_VERSION, updated_at_ms, device_label);
        let payload_nonce = random_bytes::<NONCE_LEN>()?;
        let payload = aead_seal(&self.dek, &payload_nonce, plaintext, &aad)?;
        let sealed = Sealed {
            version: FORMAT_VERSION,
            updated_at: updated_at_ms,
            device_label: device_label.to_string(),
            wraps: self.wraps.clone(),
            payload_nonce: payload_nonce.to_vec(),
            payload,
        };
        serde_json::to_vec_pretty(&sealed).map_err(|_| CryptoError::Format)
    }

    /// Bir anahtar yöntemi ekler ya da var olanı değiştirir (ör. sonradan parola).
    ///
    /// # Errors
    /// Rastgelelik/KDF/AEAD başarısız olursa hata döner.
    pub fn add_key(&mut self, key: SealKey<'_>) -> CryptoResult<()> {
        let method = seal_method(key);
        self.wraps.retain(|w| w.method != method);
        let wrap = wrap_for(&self.dek, key)?;
        self.wraps.push(wrap);
        Ok(())
    }

    /// Bir yöntemin sarımını kaldırır. Son sarım kaldırılamaz (vault erişilemez olurdu).
    ///
    /// # Errors
    /// Bu son kalan sarımsa [`CryptoError::NoMatchingKey`].
    pub fn remove_method(&mut self, method: WrapMethod) -> CryptoResult<()> {
        if !self.wraps.iter().any(|w| w.method != method) {
            return Err(CryptoError::NoMatchingKey);
        }
        self.wraps.retain(|w| w.method != method);
        Ok(())
    }

    /// Bu vault'u açabilen yöntemler.
    #[must_use]
    pub fn methods(&self) -> Vec<WrapMethod> {
        self.wraps.iter().map(|w| w.method).collect()
    }

    /// Verilen yöntemin bir sarımı var mı.
    #[must_use]
    pub fn has_method(&self, method: WrapMethod) -> bool {
        self.wraps.iter().any(|w| w.method == method)
    }
}

/// Zarfın açık başlığını şifre çözmeden okur (senkron çakışma çözümü için).
///
/// # Errors
/// Dosya tanınan bir zarf değilse hata döner.
pub fn read_header(sealed_bytes: &[u8]) -> CryptoResult<Header> {
    let sealed: Sealed = serde_json::from_slice(sealed_bytes).map_err(|_| CryptoError::Format)?;
    Ok(Header {
        version: sealed.version,
        updated_at: sealed.updated_at,
        device_label: sealed.device_label,
    })
}

/// Yeni, rastgele bir 32-baytlık anahtar üretir (keyring makine-anahtarı için).
///
/// # Errors
/// Güvenli rastgelelik kaynağı yoksa hata döner.
pub fn random_key() -> CryptoResult<[u8; KEY_LEN]> {
    random_bytes::<KEY_LEN>()
}

/// Şu anki zamanı unix milisaniye olarak döndürür (saat geriye giderse 0).
#[must_use]
pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

// --- İç yardımcılar (saf) -------------------------------------------------

/// Argon2id ile bir sırdan 32-baytlık KEK türetir.
fn derive_kek(secret: &[u8], salt: &[u8]) -> CryptoResult<Zeroizing<[u8; KEY_LEN]>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    // OWASP tabanı: m=19 MiB, t=2, p=1.
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN)).map_err(|_| CryptoError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(secret, salt, &mut out[..])
        .map_err(|_| CryptoError::Kdf)?;
    Ok(out)
}

/// Bir [`SealKey`] için DEK sarımı üretir (parola/recovery → Argon2id KEK; keyring → ham).
fn wrap_for(dek: &[u8; KEY_LEN], key: SealKey<'_>) -> CryptoResult<Wrap> {
    match key {
        SealKey::Password(pw) => {
            let salt = random_bytes::<SALT_LEN>()?;
            let kek = derive_kek(pw.as_bytes(), &salt)?;
            make_wrap(dek, &kek, WrapMethod::Password, salt.to_vec())
        }
        SealKey::Recovery(phrase) => {
            let salt = random_bytes::<SALT_LEN>()?;
            let kek = derive_kek(phrase.as_bytes(), &salt)?;
            make_wrap(dek, &kek, WrapMethod::Recovery, salt.to_vec())
        }
        SealKey::Keyring(kek) => make_wrap(dek, kek, WrapMethod::Keyring, Vec::new()),
    }
}

/// Bir [`SealKey`]'in yöntemi.
fn seal_method(key: SealKey<'_>) -> WrapMethod {
    match key {
        SealKey::Password(_) => WrapMethod::Password,
        SealKey::Recovery(_) => WrapMethod::Recovery,
        SealKey::Keyring(_) => WrapMethod::Keyring,
    }
}

/// DEK'i bir KEK ile şifreleyip bir [`Wrap`] üretir.
fn make_wrap(
    dek: &[u8; KEY_LEN],
    kek: &[u8; KEY_LEN],
    method: WrapMethod,
    salt: Vec<u8>,
) -> CryptoResult<Wrap> {
    let nonce = random_bytes::<NONCE_LEN>()?;
    let ct = aead_seal(kek, &nonce, dek, method_aad(method))?;
    Ok(Wrap {
        method,
        salt,
        nonce: nonce.to_vec(),
        dek: ct,
    })
}

/// Bir sarımdan DEK'i çözer.
fn unwrap_dek(wrap: &Wrap, key: OpenKey<'_>) -> CryptoResult<Zeroizing<[u8; KEY_LEN]>> {
    let kek: Zeroizing<[u8; KEY_LEN]> = match key {
        OpenKey::Password(pw) => derive_kek(pw.as_bytes(), &wrap.salt)?,
        OpenKey::Recovery(ph) => derive_kek(ph.as_bytes(), &wrap.salt)?,
        OpenKey::Keyring(k) => Zeroizing::new(*k),
    };
    let plain = Zeroizing::new(aead_open(
        &kek,
        &wrap.nonce,
        &wrap.dek,
        method_aad(wrap.method),
    )?);
    let dek = <[u8; KEY_LEN]>::try_from(plain.as_slice()).map_err(|_| CryptoError::Decrypt)?;
    Ok(Zeroizing::new(dek))
}

/// XChaCha20-Poly1305 ile şifreler (anahtar/nonce uzunlukları çağıran tarafından garanti).
fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> CryptoResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Encrypt)
}

/// XChaCha20-Poly1305 ile çözer. Nonce uzunluğu dosyadan geldiği için doğrulanır
/// (yanlış uzunlukta panik atmaması için).
fn aead_open(
    key: &[u8; KEY_LEN],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> CryptoResult<Vec<u8>> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::Format);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Decrypt)
}

/// Açık başlığı payload'a bağlayan associated-data baytları.
fn header_aad(version: u32, updated_at: u64, device_label: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(12 + device_label.len());
    aad.extend_from_slice(&version.to_le_bytes());
    aad.extend_from_slice(&updated_at.to_le_bytes());
    aad.extend_from_slice(device_label.as_bytes());
    aad
}

/// Bir sarımı yöntemine bağlayan associated-data (sarım türü değiştirilemez).
fn method_aad(method: WrapMethod) -> &'static [u8] {
    match method {
        WrapMethod::Password => b"portal.wrap.password",
        WrapMethod::Keyring => b"portal.wrap.keyring",
        WrapMethod::Recovery => b"portal.wrap.recovery",
    }
}

/// Güvenli rastgele N bayt.
fn random_bytes<const N: usize>() -> CryptoResult<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|_| CryptoError::Rng)?;
    Ok(buf)
}

/// İkili alanları base64 olarak (de)serileştiren serde yardımcı modülü.
mod b64 {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(d: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let text = String::deserialize(d)?;
        STANDARD
            .decode(text.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &[u8] = br#"{"hosts":[{"address":"203.0.113.10","user":"deploy"}]}"#;

    #[test]
    fn password_roundtrips() {
        let sealed = seal(PLAIN, &[SealKey::Password("hunter2")], "alex-laptop", 42).unwrap();
        let opened = open(&sealed, OpenKey::Password("hunter2")).unwrap();
        assert_eq!(opened.as_slice(), PLAIN);
    }

    #[test]
    fn wrong_password_fails() {
        let sealed = seal(PLAIN, &[SealKey::Password("hunter2")], "dev", 1).unwrap();
        let err = open(&sealed, OpenKey::Password("nope")).unwrap_err();
        assert!(matches!(err, CryptoError::Decrypt));
    }

    #[test]
    fn keyring_roundtrips_and_rejects_other_methods() {
        let key = [7u8; KEY_LEN];
        let sealed = seal(PLAIN, &[SealKey::Keyring(&key)], "dev", 1).unwrap();
        assert_eq!(
            open(&sealed, OpenKey::Keyring(&key)).unwrap().as_slice(),
            PLAIN
        );
        // Parola sarımı yok → eşleşen anahtar yok.
        let err = open(&sealed, OpenKey::Password("x")).unwrap_err();
        assert!(matches!(err, CryptoError::NoMatchingKey));
        // Yanlış keyring anahtarı → çözme hatası.
        let err = open(&sealed, OpenKey::Keyring(&[9u8; KEY_LEN])).unwrap_err();
        assert!(matches!(err, CryptoError::Decrypt));
    }

    #[test]
    fn multiple_wraps_all_unlock_same_payload() {
        let key = [3u8; KEY_LEN];
        let sealed = seal(
            PLAIN,
            &[
                SealKey::Password("pw"),
                SealKey::Recovery("correct horse battery staple"),
                SealKey::Keyring(&key),
            ],
            "dev",
            7,
        )
        .unwrap();
        assert_eq!(
            open(&sealed, OpenKey::Password("pw")).unwrap().as_slice(),
            PLAIN
        );
        assert_eq!(
            open(&sealed, OpenKey::Recovery("correct horse battery staple"))
                .unwrap()
                .as_slice(),
            PLAIN
        );
        assert_eq!(
            open(&sealed, OpenKey::Keyring(&key)).unwrap().as_slice(),
            PLAIN
        );
    }

    #[test]
    fn tampered_header_is_rejected() {
        let sealed = seal(PLAIN, &[SealKey::Password("pw")], "alex-laptop", 100).unwrap();
        // Başlığı kurcala: device_label'i değiştir → AAD uyuşmaz → çözme başarısız.
        let mut doc: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
        doc["device_label"] = serde_json::json!("attacker");
        let tampered = serde_json::to_vec(&doc).unwrap();
        let err = open(&tampered, OpenKey::Password("pw")).unwrap_err();
        assert!(matches!(err, CryptoError::Decrypt));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let sealed = seal(PLAIN, &[SealKey::Password("pw")], "dev", 1).unwrap();
        let mut doc: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
        // payload base64'ünün son karakterini boz.
        let mut p = doc["payload"].as_str().unwrap().to_string();
        p.pop();
        p.push(if doc["payload"].as_str().unwrap().ends_with('A') {
            'B'
        } else {
            'A'
        });
        doc["payload"] = serde_json::json!(p);
        let tampered = serde_json::to_vec(&doc).unwrap();
        assert!(open(&tampered, OpenKey::Password("pw")).is_err());
    }

    #[test]
    fn header_is_readable_without_key() {
        let sealed = seal(PLAIN, &[SealKey::Password("pw")], "alex-laptop", 1234).unwrap();
        let h = read_header(&sealed).unwrap();
        assert_eq!(h.version, FORMAT_VERSION);
        assert_eq!(h.updated_at, 1234);
        assert_eq!(h.device_label, "alex-laptop");
    }

    #[test]
    fn no_plaintext_material_on_disk() {
        // Denetim: şifreli baytlar düz metin host adresini içermemeli.
        let sealed = seal(PLAIN, &[SealKey::Password("pw")], "dev", 1).unwrap();
        let hay = String::from_utf8_lossy(&sealed);
        assert!(!hay.contains("203.0.113.10"), "adres düz metin sızdı");
        assert!(!hay.contains("deploy"), "kullanıcı adı düz metin sızdı");
    }

    #[test]
    fn empty_keys_is_rejected() {
        assert!(matches!(
            seal(PLAIN, &[], "dev", 1).unwrap_err(),
            CryptoError::NoMatchingKey
        ));
    }

    #[test]
    fn garbage_bytes_are_not_a_vault() {
        assert!(matches!(
            open(b"not a vault", OpenKey::Password("x")).unwrap_err(),
            CryptoError::Format
        ));
    }

    #[test]
    fn cipher_save_loop_preserves_all_methods() {
        // Bir yöntemle aç → yeniden kaydet → diğer yöntemler hâlâ açmalı.
        let key = [4u8; KEY_LEN];
        let first = seal(
            PLAIN,
            &[SealKey::Password("pw"), SealKey::Keyring(&key)],
            "dev",
            1,
        )
        .unwrap();

        // Sadece parolayla aç (recovery/keyring sırrını "bilmeden").
        let (cipher, plain) = VaultCipher::unlock(&first, OpenKey::Password("pw")).unwrap();
        assert_eq!(plain.as_slice(), PLAIN);

        // Yeni içerikle yeniden kaydet.
        let new_plain = br#"{"hosts":[]}"#;
        let second = cipher.seal(new_plain, "dev", 2).unwrap();

        // Keyring sarımı korunmuş olmalı: ham anahtarla açılabilir.
        assert_eq!(
            open(&second, OpenKey::Keyring(&key)).unwrap().as_slice(),
            new_plain
        );
        // Zaman damgası güncellenmiş.
        assert_eq!(read_header(&second).unwrap().updated_at, 2);
    }

    #[test]
    fn add_password_to_keyring_only_vault() {
        let key = [8u8; KEY_LEN];
        let sealed = seal(PLAIN, &[SealKey::Keyring(&key)], "dev", 1).unwrap();

        // Keyring ile aç, sonra parola ekle, yeniden kaydet.
        let (mut cipher, _) = VaultCipher::unlock(&sealed, OpenKey::Keyring(&key)).unwrap();
        assert!(!cipher.has_method(WrapMethod::Password));
        cipher.add_key(SealKey::Password("added")).unwrap();
        assert!(cipher.has_method(WrapMethod::Password));
        let updated = cipher.seal(PLAIN, "dev", 2).unwrap();

        // Artık parolayla da açılıyor; keyring de hâlâ çalışıyor.
        assert_eq!(
            open(&updated, OpenKey::Password("added"))
                .unwrap()
                .as_slice(),
            PLAIN
        );
        assert_eq!(
            open(&updated, OpenKey::Keyring(&key)).unwrap().as_slice(),
            PLAIN
        );
    }

    #[test]
    fn cannot_remove_last_method() {
        let mut cipher = VaultCipher::create(&[SealKey::Password("pw")]).unwrap();
        assert!(cipher.remove_method(WrapMethod::Password).is_err());
        // İki yöntemden birini kaldırmak sorun değil.
        let key = [1u8; KEY_LEN];
        cipher.add_key(SealKey::Keyring(&key)).unwrap();
        cipher.remove_method(WrapMethod::Password).unwrap();
        assert_eq!(cipher.methods(), vec![WrapMethod::Keyring]);
    }
}
