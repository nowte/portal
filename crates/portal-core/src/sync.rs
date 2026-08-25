//! BYOS senkron: şifreli vault dosyasını kullanıcının seçtiği klasöre yaz/oku
//! (docs/ARCHITECTURE.md §6, docs/PRD.md §4).
//!
//! Portal bir senkron **sunucusu çalıştırmaz**. Kullanıcı bir hedef klasör seçer
//! (yerel klasör, Git repo'su, Dropbox/iCloud/Nextcloud, kendi sunucusu…) ve Portal
//! oraya **yalnızca şifreli `vault.portal`**'ı kopyalar. Şirket veriyi asla görmez.
//!
//! **Çakışma = son-yazan-kazanır + zaman damgası.** Zarfın açık başlığındaki
//! `updated_at` [`crate::vault::crypto::read_header`] ile **şifre çözmeden** okunur,
//! bu yüzden çakışma çözümü kilit açmadan yapılır.
//!
//! Not: cihazlar-arası senkron **taşınabilir bir kilit** ister (parola/recovery) —
//! keyring anahtarı makineye özgüdür, başka makine keyring-sarımlı vault'u çözemez.
//!
//! **SECURITY (P6-D #3):**
//! - `pull` yerel dosyayı ezmeden önce `<vault>.bak` yedeği alır → çakışmada (son-yazan-
//!   kazanır) yerelde kaybolan değişiklik geri alınabilir.
//! - Zarfın açık başlığı **bilerek düz metindir** (`device_label` + `updated_at`) → kilit
//!   açmadan çakışma çözümünü mümkün kılar. Kabul edilen ödünleşim: senkron klasörünü gören
//!   biri cihaz etiketini ve son-yazma zamanını görebilir (host/kimlik verisi DEĞİL — o
//!   şifreli). Gizlilik gerekiyorsa senkron klasörünü paylaşmayın.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::persist;
use crate::vault::crypto::{self, Header};

/// Bir hedef klasördeki senkron dosyasının adı.
pub const REMOTE_VAULT_NAME: &str = "vault.portal";

/// Yerel ile uzak vault'un karşılaştırma sonucu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    /// İki taraf aynı sürümde.
    InSync,
    /// Yerel daha yeni → uzağa itilir (push).
    LocalNewer,
    /// Uzak daha yeni → yerele çekilir (pull).
    RemoteNewer,
    /// Yalnız yerel var → itilir.
    OnlyLocal,
    /// Yalnız uzak var → çekilir.
    OnlyRemote,
    /// İki tarafta da vault yok.
    Neither,
}

impl SyncOutcome {
    /// Senkron **sonrası** kullanıcıya dönük kısa açıklama (ne yapıldı).
    #[must_use]
    pub fn describe(self) -> &'static str {
        match self {
            SyncOutcome::InSync => "Already in sync.",
            SyncOutcome::LocalNewer | SyncOutcome::OnlyLocal => "Pushed your vault to the folder.",
            SyncOutcome::RemoteNewer | SyncOutcome::OnlyRemote => {
                "Pulled a newer vault from the folder."
            }
            SyncOutcome::Neither => "Nothing to sync yet.",
        }
    }

    /// Senkron **öncesi** durum etiketi (ne olacak).
    #[must_use]
    pub fn status_label(self) -> &'static str {
        match self {
            SyncOutcome::InSync => "in sync",
            SyncOutcome::LocalNewer => "local is newer — will push",
            SyncOutcome::RemoteNewer => "remote is newer — will pull",
            SyncOutcome::OnlyLocal => "not yet in the folder — will push",
            SyncOutcome::OnlyRemote => "a vault is waiting in the folder — will pull",
            SyncOutcome::Neither => "nothing to sync yet",
        }
    }
}

/// Karşılaştırma ayrıntısı (başlıklar + sonuç).
#[derive(Debug, Clone)]
pub struct SyncStatus {
    /// Yerel vault başlığı (yoksa `None`).
    pub local: Option<Header>,
    /// Uzak vault başlığı (yoksa `None`).
    pub remote: Option<Header>,
    /// Sonuç.
    pub outcome: SyncOutcome,
}

/// Bir vault dosyasının **açık başlığını** okur (şifre çözmeden); dosya yoksa `None`.
fn read_header_opt(path: &Path) -> Result<Option<Header>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = persist::read_bytes(path)?;
    Ok(Some(crypto::read_header(&bytes)?))
}

/// Yerel ve uzak vault'u başlıklarına göre karşılaştırır (şifre çözmez).
///
/// # Errors
/// Bir dosya okunamaz ya da tanınan bir vault değilse hata döner.
pub fn status(local: &Path, remote: &Path) -> Result<SyncStatus> {
    let local_h = read_header_opt(local)?;
    let remote_h = read_header_opt(remote)?;
    let outcome = match (&local_h, &remote_h) {
        (None, None) => SyncOutcome::Neither,
        (Some(_), None) => SyncOutcome::OnlyLocal,
        (None, Some(_)) => SyncOutcome::OnlyRemote,
        (Some(l), Some(r)) => match l.updated_at.cmp(&r.updated_at) {
            Ordering::Greater => SyncOutcome::LocalNewer,
            Ordering::Less => SyncOutcome::RemoteNewer,
            Ordering::Equal => SyncOutcome::InSync,
        },
    };
    Ok(SyncStatus {
        local: local_h,
        remote: remote_h,
        outcome,
    })
}

/// Yerel şifreli vault'u uzağa atomik kopyalar (son-yazan-kazanır: üzerine yazar).
///
/// # Errors
/// Yerel okunamaz ya da uzak yazılamazsa hata döner.
pub fn push(local: &Path, remote: &Path) -> Result<()> {
    let bytes = persist::read_bytes(local)?;
    persist::atomic_write(remote, &bytes)?;
    Ok(())
}

/// Uzak şifreli vault'u yerele atomik kopyalar. Yazmadan önce geçerli bir vault
/// olduğunu doğrular (bozuk/yanlış dosya yerel veriyi ezmesin).
///
/// # Errors
/// Uzak okunamaz, tanınan bir vault değilse ya da yerel yazılamazsa hata döner.
pub fn pull(remote: &Path, local: &Path) -> Result<()> {
    let bytes = persist::read_bytes(remote)?;
    crypto::read_header(&bytes)?; // geçerli bir Portal vault mı?
                                  // Ezmeden önce yereli yedekle (P6-D #3): pull yerel değişikliği geri alabilir →
                                  // veri kaybı olmasın. Yedek alınamazsa yazma YAPMA (tek kopyayı yok etme).
    if local.exists() {
        let backup = backup_path(local);
        std::fs::copy(local, &backup).map_err(|e| Error::io(&backup, e))?;
    }
    persist::atomic_write(local, &bytes)?;
    Ok(())
}

/// Yerel vault'un yanındaki `.bak` yedek yolu (ör. `vault.portal` → `vault.portal.bak`).
fn backup_path(local: &Path) -> PathBuf {
    let mut s = local.as_os_str().to_owned();
    s.push(".bak");
    PathBuf::from(s)
}

/// Tek adımda uzlaştırır: yerel yeni/yalnız-yerelse iter, uzak yeni/yalnız-uzaksa çeker.
///
/// # Errors
/// Karşılaştırma ya da kopyalama başarısız olursa hata döner.
pub fn reconcile(local: &Path, remote: &Path) -> Result<SyncOutcome> {
    let outcome = status(local, remote)?.outcome;
    match outcome {
        SyncOutcome::LocalNewer | SyncOutcome::OnlyLocal => push(local, remote)?,
        SyncOutcome::RemoteNewer | SyncOutcome::OnlyRemote => pull(remote, local)?,
        SyncOutcome::InSync | SyncOutcome::Neither => {}
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::crypto::{seal, SealKey};
    use tempfile::tempdir;

    /// Verilen zaman damgasıyla şifreli bir vault dosyası yazar.
    fn write_vault(path: &Path, plaintext: &[u8], updated_at: u64) {
        let bytes = seal(plaintext, &[SealKey::Password("pw")], "dev", updated_at).unwrap();
        persist::atomic_write(path, &bytes).unwrap();
    }

    #[test]
    fn pull_backs_up_local_before_overwrite() {
        // P6-D #3: pull yereli ezmeden önce <vault>.bak yedeği almalı (veri kaybı olmasın).
        let dir = tempdir().unwrap();
        let local = dir.path().join("vault.portal");
        let remote = dir.path().join("remote/vault.portal");
        write_vault(&local, b"LOCAL-OLD", 100);
        write_vault(&remote, b"REMOTE-NEW", 200);

        let local_before = persist::read_bytes(&local).unwrap();
        pull(&remote, &local).unwrap();

        // Yedek eski yerel dosyayı bayt-bayt korudu.
        let bak = backup_path(&local);
        assert!(bak.exists(), "yedek dosyası oluşmalı");
        assert_eq!(persist::read_bytes(&bak).unwrap(), local_before);
        // Yerel artık uzak içerikle güncellendi.
        assert_eq!(
            persist::read_bytes(&local).unwrap(),
            persist::read_bytes(&remote).unwrap()
        );
    }

    #[test]
    fn status_reflects_presence_and_timestamps() {
        let dir = tempdir().unwrap();
        let local = dir.path().join("local.portal");
        let remote = dir.path().join("remote/vault.portal");

        assert_eq!(
            status(&local, &remote).unwrap().outcome,
            SyncOutcome::Neither
        );

        write_vault(&local, b"L", 100);
        assert_eq!(
            status(&local, &remote).unwrap().outcome,
            SyncOutcome::OnlyLocal
        );

        write_vault(&remote, b"R", 200);
        assert_eq!(
            status(&local, &remote).unwrap().outcome,
            SyncOutcome::RemoteNewer
        );

        write_vault(&local, b"L2", 200);
        assert_eq!(
            status(&local, &remote).unwrap().outcome,
            SyncOutcome::InSync
        );

        write_vault(&local, b"L3", 300);
        assert_eq!(
            status(&local, &remote).unwrap().outcome,
            SyncOutcome::LocalNewer
        );
    }

    #[test]
    fn push_then_pull_roundtrips_encrypted_bytes() {
        // Kabul: vault başka klasöre yazılıp geri okunuyor.
        let dir = tempdir().unwrap();
        let local = dir.path().join("data/vault.portal");
        let remote = dir.path().join("dropbox/vault.portal");

        write_vault(&local, b"secret-hosts", 100);
        let original = std::fs::read(&local).unwrap();

        // Başka klasöre yaz.
        reconcile(&local, &remote).unwrap();
        assert!(remote.exists());
        assert_eq!(std::fs::read(&remote).unwrap(), original);

        // Yereli sil, geri oku.
        std::fs::remove_file(&local).unwrap();
        assert_eq!(reconcile(&local, &remote).unwrap(), SyncOutcome::OnlyRemote);
        assert_eq!(std::fs::read(&local).unwrap(), original);

        // İçerik hâlâ çözülebilir (aynı şifreli baytlar).
        let opened = crate::vault::crypto::open(
            &std::fs::read(&local).unwrap(),
            crate::vault::crypto::OpenKey::Password("pw"),
        )
        .unwrap();
        assert_eq!(opened.as_slice(), b"secret-hosts");
    }

    #[test]
    fn remote_copy_has_no_plaintext() {
        let dir = tempdir().unwrap();
        let local = dir.path().join("vault.portal");
        let remote = dir.path().join("out/vault.portal");
        write_vault(&local, b"topsecret-address-203.0.113.10", 1);
        push(&local, &remote).unwrap();
        let text = String::from_utf8_lossy(&std::fs::read(&remote).unwrap()).into_owned();
        assert!(
            !text.contains("203.0.113.10"),
            "uzak kopya düz metin sızdırdı"
        );
    }

    #[test]
    fn pull_rejects_a_non_vault_file() {
        let dir = tempdir().unwrap();
        let local = dir.path().join("vault.portal");
        let remote = dir.path().join("garbage");
        std::fs::write(&remote, b"not a vault").unwrap();
        assert!(pull(&remote, &local).is_err());
        assert!(!local.exists(), "bozuk uzak dosya yereli oluşturmamalı");
    }
}
