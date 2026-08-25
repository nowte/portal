//! SSH anahtar yönetimi: Ed25519 üret, içe aktar/incele, passphrase ile şifrele.
//!
//! (docs/ROADMAP.md — İleri SSH: "SSH anahtar yönetimi: üret, içe aktar, passphrase,
//! agent'a ekle". Agent'a ekleme async olduğu için [`crate::ssh::SshRuntime`]'dadır.)
//!
//! Anahtar üretimi **saf ve test edilebilir** — sunucu/agent gerektirmez. `russh`'un
//! kullandığı `ssh-key` (Ed25519, OpenSSH PEM) üzerine kuruludur; **kendi kripto YOK**.

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, HashAlg, PrivateKey};

use crate::error::{Error, Result};
use crate::persist;

/// Bir anahtarın **gizli olmayan** özeti (private materyal İÇERMEZ).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    /// Algoritma, ör. "ssh-ed25519".
    pub algorithm: String,
    /// SHA256 fingerprint, ör. "SHA256:…".
    pub fingerprint: String,
    /// Public anahtar (authorized_keys satırı), ör. "ssh-ed25519 AAAA… comment".
    pub public_openssh: String,
    /// Private key dosyası passphrase ile şifreli mi.
    pub encrypted: bool,
}

/// Yeni üretilen bir anahtarın diskteki yeri + özeti.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedKey {
    /// Private key dosya yolu.
    pub private_path: PathBuf,
    /// Public key dosya yolu (`<private>.pub`).
    pub public_path: PathBuf,
    /// Özet (fingerprint, public key, …).
    pub info: KeyInfo,
}

/// `dir/name` (+ `dir/name.pub`) konumunda yeni bir Ed25519 anahtarı üretir.
///
/// `passphrase` verilirse private key onunla şifrelenir. Var olan bir dosyanın
/// üzerine **yazmaz** (kaza ile anahtar kaybını önler).
///
/// # Errors
/// Ad geçersizse, dosya zaten varsa, üretim/şifreleme veya yazma başarısızsa hata döner.
pub fn generate_ed25519(
    dir: &Path,
    name: &str,
    comment: &str,
    passphrase: Option<&str>,
) -> Result<GeneratedKey> {
    let name = sanitize_name(name)?;
    let private_path = dir.join(&name);
    let public_path = dir.join(format!("{name}.pub"));
    if private_path.exists() {
        return Err(Error::Key(format!(
            "a key named \"{name}\" already exists — choose another name"
        )));
    }

    let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|e| Error::Key(format!("couldn't generate key: {e}")))?;
    let comment = comment.trim();
    if !comment.is_empty() {
        key.set_comment(comment);
    }

    // Özet (public materyal — şifrelemeden önce hesapla).
    let info_public = key
        .public_key()
        .to_openssh()
        .map_err(|e| Error::Key(format!("couldn't encode public key: {e}")))?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let algorithm = key.algorithm().to_string();

    // Passphrase verildiyse şifrele.
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let pem = if let Some(pw) = passphrase {
        let enc = key
            .encrypt(&mut rand::rng(), pw.as_bytes())
            .map_err(|e| Error::Key(format!("couldn't encrypt key: {e}")))?;
        enc.to_openssh(LineEnding::LF)
    } else {
        key.to_openssh(LineEnding::LF)
    }
    .map_err(|e| Error::Key(format!("couldn't encode key: {e}")))?;

    write_private_key(&private_path, pem.as_bytes())?;
    persist::atomic_write(&public_path, format!("{}\n", info_public.trim()).as_bytes())?;

    Ok(GeneratedKey {
        private_path,
        public_path,
        info: KeyInfo {
            algorithm,
            fingerprint,
            public_openssh: info_public,
            encrypted: passphrase.is_some(),
        },
    })
}

/// Var olan bir private key dosyasını **inceler** (şifresini çözmeden): algoritma,
/// fingerprint, public key ve şifreli olup olmadığı. Passphrase gerekmez.
///
/// # Errors
/// Dosya okunamaz veya bir OpenSSH private key değilse hata döner.
pub fn key_info(path: &Path) -> Result<KeyInfo> {
    let resolved = crate::ssh::expand_home(path);
    let pem = std::fs::read_to_string(&resolved).map_err(|e| Error::io(&resolved, e))?;
    let key = PrivateKey::from_openssh(pem.as_bytes()).map_err(|e| {
        Error::Key(format!(
            "couldn't read a private key at {}: {e}",
            resolved.display()
        ))
    })?;
    Ok(KeyInfo {
        algorithm: key.algorithm().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        public_openssh: key
            .public_key()
            .to_openssh()
            .map_err(|e| Error::Key(format!("couldn't encode public key: {e}")))?,
        encrypted: key.is_encrypted(),
    })
}

/// Anahtar adını doğrular (yol enjeksiyonunu engeller).
fn sanitize_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() || n.contains(['/', '\\', ':']) || n.contains("..") {
        return Err(Error::Key(
            "invalid key name — use letters, digits, - or _".to_string(),
        ));
    }
    Ok(n.to_string())
}

/// Private key'i yazar; Unix'te izinleri 0600'e kısar (ssh gevşek izinli anahtarı reddeder).
fn write_private_key(path: &Path, bytes: &[u8]) -> Result<()> {
    persist::ensure_parent_dir(path)?;
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| Error::io(path, e))?;
        file.write_all(bytes).map_err(|e| Error::io(path, e))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|e| Error::io(path, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generate_writes_key_pair_and_summary() {
        let dir = tempdir().unwrap();
        let gen = generate_ed25519(dir.path(), "id_portal", "alex@laptop", None).unwrap();

        assert!(gen.private_path.exists());
        assert!(gen.public_path.exists());
        assert_eq!(gen.info.algorithm, "ssh-ed25519");
        assert!(gen.info.fingerprint.starts_with("SHA256:"));
        assert!(gen.info.public_openssh.starts_with("ssh-ed25519 "));
        assert!(gen.info.public_openssh.contains("alex@laptop"));
        assert!(!gen.info.encrypted);

        // Diskteki .pub, özetteki public anahtarla eşleşmeli.
        let pub_on_disk = std::fs::read_to_string(&gen.public_path).unwrap();
        assert_eq!(pub_on_disk.trim(), gen.info.public_openssh.trim());
    }

    #[test]
    fn generated_key_reloads_and_fingerprint_is_stable() {
        let dir = tempdir().unwrap();
        let gen = generate_ed25519(dir.path(), "k1", "", None).unwrap();
        // Yeniden okuyunca aynı fingerprint + şifresiz.
        let info = key_info(&gen.private_path).unwrap();
        assert_eq!(info.fingerprint, gen.info.fingerprint);
        assert!(!info.encrypted);
    }

    #[test]
    fn passphrase_protected_key_is_encrypted_on_disk() {
        let dir = tempdir().unwrap();
        let gen = generate_ed25519(dir.path(), "sec", "", Some("hunter2")).unwrap();
        assert!(gen.info.encrypted);

        // İnceleme passphrase'siz de fingerprint verir ama şifreli işaretler.
        let info = key_info(&gen.private_path).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.fingerprint, gen.info.fingerprint);

        // Diskte OpenSSH şifreli anahtar formatı; düz "none" cipher DEĞİL.
        let pem = std::fs::read_to_string(&gen.private_path).unwrap();
        assert!(pem.contains("OPENSSH PRIVATE KEY"));
    }

    #[test]
    fn refuses_to_overwrite_existing_key() {
        let dir = tempdir().unwrap();
        generate_ed25519(dir.path(), "dup", "", None).unwrap();
        assert!(generate_ed25519(dir.path(), "dup", "", None).is_err());
    }

    #[test]
    fn rejects_unsafe_names() {
        let dir = tempdir().unwrap();
        for bad in ["", "  ", "../evil", "a/b", "a\\b", "c:key"] {
            assert!(
                generate_ed25519(dir.path(), bad, "", None).is_err(),
                "kabul edilmemeliydi: {bad:?}"
            );
        }
    }

    #[test]
    fn key_info_rejects_non_key_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("notakey");
        std::fs::write(&p, "hello").unwrap();
        assert!(key_info(&p).is_err());
    }
}
