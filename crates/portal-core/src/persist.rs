//! Dosya I/O yardımcıları (atomik yazma, yol bağlamlı hatalar).
//!
//! Crate içi kullanım; config (TOML) ve vault (JSON) modülleri bunu paylaşır.

use std::fs;
use std::path::Path;

use crate::error::{Error, Result};

/// Verilen yolun üst dizinini (yoksa) oluşturur.
pub(crate) fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
    }
    Ok(())
}

/// Atomik yazar: geçici dosyaya yazıp hedefin üzerine yeniden adlandırır.
/// Böylece yarım yazılmış/bozuk dosya kalmaz.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    ensure_parent_dir(path)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| Error::io(&tmp, e))?;
    // std::fs::rename Windows'ta da var olan hedefi atomik olarak değiştirir.
    fs::rename(&tmp, path).map_err(|e| Error::io(path, e))?;
    Ok(())
}

/// Sırlı içeriği (ör. uzaktan çekilen bir dosyanın şifresi çözülmüş içeriği) **güvenli**
/// bir geçici dosyaya yazar ve yolunu döndürür (P6-D #4):
/// - **benzersiz rastgele ad** → öngörülebilir yola önceden dosya/symlink koyma saldırısı yok,
/// - unix'te **0600** izin (yalnız sahip okur/yazar),
/// - `O_EXCL` ile oluşturma → var olan bir dosyayı ele geçirmez.
///
/// Dosya çağrana **bırakılır** (harici editör açacak); temizlik çağrananın sorumluluğunda.
///
/// # Errors
/// Geçici dosya oluşturulamaz ya da yazılamazsa hata döner.
pub fn write_secure_temp(bytes: &[u8], name_hint: &str) -> Result<std::path::PathBuf> {
    use std::io::Write;
    // Ad ipucunu güvenli karakterlere indir (yol ayracı/sürpriz sızıntı olmasın).
    let hint: String = name_hint
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(40)
        .collect();
    let prefix = if hint.is_empty() {
        "portal-edit-".to_string()
    } else {
        format!("portal-edit-{hint}-")
    };
    let mut tf = tempfile::Builder::new()
        .prefix(prefix.as_str())
        .rand_bytes(12)
        .tempfile()
        .map_err(|e| Error::io(Path::new(prefix.as_str()), e))?;
    tf.write_all(bytes).map_err(|e| Error::io(tf.path(), e))?;
    // Kalıcılaştır (editör açabilsin); (File, PathBuf) döner.
    let (_file, path) = tf.keep().map_err(|e| {
        let p = e.file.path().to_path_buf();
        Error::io(&p, e.error)
    })?;
    Ok(path)
}

/// Dosyayı ham baytlar olarak okur (yol bağlamlı hata).
pub(crate) fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| Error::io(path, e))
}

/// Dosyayı UTF-8 string olarak okur (yol bağlamlı hata).
pub(crate) fn read_string(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| Error::io(path, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_temp_writes_content_with_unique_names() {
        // P6-D #4: içerik doğru yazılır ve her çağrı benzersiz (öngörülebilir yol yok).
        let a = write_secure_temp(b"secret bytes", "notes.conf").unwrap();
        let b = write_secure_temp(b"secret bytes", "notes.conf").unwrap();
        assert_ne!(a, b, "her çağrı benzersiz ad üretmeli");
        assert_eq!(fs::read(&a).unwrap(), b"secret bytes");
        assert_eq!(fs::read(&b).unwrap(), b"secret bytes");
        // unix'te 0600 (yalnız sahip okur/yazar).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&a).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "temp izinleri 0600 olmalı");
        }
        let _ = fs::remove_file(&a);
        let _ = fs::remove_file(&b);
    }
}
