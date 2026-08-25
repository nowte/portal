//! Uygulama durumunun kalıcı deposu: config + aktif profilin vault'unu yükler,
//! mutasyonları **şifreli** olarak diske yazar. Tüm CRUD burada (domain), UI çağırır.
//!
//! Faz 2-B (P4): vault artık şifreli (`vault/crypto.rs`). Profil **indeksi**
//! ([`Config::profiles`]) hassas değildir ve kilit açılmadan okunur; her profilin
//! gizli verisi kendi `profiles/<id>/vault.portal` dosyasındadır.
//!
//! Kilit modelleri (bkz. docs/ARCHITECTURE.md §5, kullanıcı kararı: keyring-only):
//! - **Parola** verilirse: yalnız parola sarımı → yeniden açılışta parola sorulur.
//! - **Parolasız**: OS keyring makine-anahtarı → sessiz otomatik açılış. Keyring yoksa
//!   parola zorunlu.

use crate::config::{Config, Theme};
use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

use crate::model::{
    AuthMethod, Folder, FolderId, Host, HostId, Identity, IdentityId, Monitor, MonitorId, Profile,
    ProfileId, Snippet, SnippetId,
};
use crate::paths::Paths;
use crate::ssh_config::ImportedHost;
use crate::vault::crypto::{self, OpenKey, SealKey, VaultCipher};
use crate::vault::keystore::{KeyStore, KeyringStore};
use crate::vault::recovery::normalize_phrase;
use crate::vault::Vault;

/// `~/.ssh/config` içe aktarma özeti.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ImportSummary {
    /// Eklenen host sayısı.
    pub added: usize,
    /// Atlanan (etiketi zaten var olan) host sayısı.
    pub skipped: usize,
}

/// Config ve aktif profilin vault'unu tutan, mutasyonda kendini şifreli yazan depo.
pub struct Store {
    config: Config,
    /// Aktif profilin çözülmüş verisi (kilitliyse boş).
    vault: Vault,
    /// Aktif vault'un kripto oturumu (açıldıysa). `None` → düz-metin (profilsiz) ya da kilitli.
    cipher: Option<VaultCipher>,
    /// Aktif profil şifreli ama henüz açılmadı (parola bekleniyor).
    locked: bool,
    /// BYOS senkronda cihaz ayrımı için etiket.
    device_label: String,
    /// Platform yolları.
    paths: Paths,
    /// Parolasız mod için makine-anahtarı kasası.
    keystore: Box<dyn KeyStore>,
}

impl Store {
    /// Platform dizinlerinden, gerçek OS keyring ile yükler (gerçek çalışma).
    ///
    /// # Errors
    /// Dizinler çözülemezse veya dosyalar okunamazsa hata döner.
    pub fn load() -> Result<Self> {
        let paths = Paths::resolve()?;
        Self::open_with(&paths, Box::new(KeyringStore::default()))
    }

    /// Verilen dizinlerden, gerçek OS keyring ile yükler.
    ///
    /// # Errors
    /// Var olan dosyalar okunamaz/ayrıştırılamazsa hata döner.
    pub fn open(paths: &Paths) -> Result<Self> {
        Self::open_with(paths, Box::new(KeyringStore::default()))
    }

    /// Verilen dizinlerden, belirtilen anahtar kasasıyla yükler (test için de).
    ///
    /// Aktif profil parolasız (keyring) ise sessizce açılır; parolalıysa kilitli
    /// başlar ve [`Store::unlock`] beklenir.
    ///
    /// # Errors
    /// Config okunamaz/ayrıştırılamazsa hata döner.
    pub fn open_with(paths: &Paths, keystore: Box<dyn KeyStore>) -> Result<Self> {
        let config = Config::load(&paths.config_file())?;
        let mut store = Self {
            config,
            vault: Vault::default(),
            cipher: None,
            locked: false,
            device_label: default_identity_label(),
            paths: paths.clone(),
            keystore,
        };
        store.load_active_vault()?;
        Ok(store)
    }

    /// Aktif profilin vault'unu yükler; parolasız (keyring) ise açar, aksi halde kilitler.
    fn load_active_vault(&mut self) -> Result<()> {
        let Some(profile) = self.config.active_profile else {
            // Profil yok: eski/geçici düz-metin vault'u yükle (varsa boş döner).
            self.vault = Vault::load(&self.paths.default_vault_file())?;
            self.cipher = None;
            self.locked = false;
            return Ok(());
        };

        let path = self.paths.vault_file(profile);
        if !path.exists() {
            self.vault = Vault::default();
            self.cipher = None;
            self.locked = false;
            return Ok(());
        }

        // Parolasız otomatik açılış: keyring anahtarı varsa dene.
        if let Some(key) = self.keystore.get(profile).ok().flatten() {
            if let Ok((cipher, vault)) = Vault::unlock(&path, OpenKey::Keyring(&key)) {
                self.vault = vault;
                self.cipher = Some(cipher);
                self.locked = false;
                return Ok(());
            }
        }

        // Aksi halde parola gerek → kilitli başla.
        self.vault = Vault::default();
        self.cipher = None;
        self.locked = true;
        Ok(())
    }

    /// Aktif konfigürasyon.
    #[must_use]
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Konfigürasyonu değiştirip diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn set_config(&mut self, config: Config) -> Result<()> {
        self.config = config;
        self.config.save(&self.paths.config_file())
    }

    /// Onboarding tamamlandı mı (ilk-çalıştırma sihirbazı gösterilsin mi).
    #[must_use]
    pub fn is_onboarded(&self) -> bool {
        self.config.onboarded
    }

    /// Aktif profil şifreli ve henüz açılmadı mı (UI kilit ekranı göstermeli).
    #[must_use]
    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// Profil indeksi (hassas olmayan).
    #[must_use]
    pub fn profiles(&self) -> &[Profile] {
        &self.config.profiles
    }

    /// Aktif profilin kimliği.
    #[must_use]
    pub fn active_profile(&self) -> Option<ProfileId> {
        self.config.active_profile
    }

    /// Aktif profilin adı (varsa).
    #[must_use]
    pub fn active_profile_name(&self) -> Option<&str> {
        let id = self.config.active_profile?;
        self.config
            .profiles
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.as_str())
    }

    /// Bu cihazın kimlik etiketi.
    #[must_use]
    pub fn device_label(&self) -> &str {
        &self.device_label
    }

    /// Kilitli aktif profili parolayla açar; başarılıysa vault yüklenir.
    ///
    /// # Errors
    /// Parola yanlış, dosya bozuk ya da açılacak profil yoksa hata döner.
    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let Some(profile) = self.config.active_profile else {
            return Ok(());
        };
        let path = self.paths.vault_file(profile);
        let (cipher, vault) = Vault::unlock(&path, OpenKey::Password(password))?;
        self.vault = vault;
        self.cipher = Some(cipher);
        self.locked = false;
        Ok(())
    }

    /// Kilitli aktif profili kurtarma cümlesiyle açar (parola unutulduğunda son çare).
    ///
    /// [`Store::unlock`]'un aynısıdır, yalnız açma anahtarı [`OpenKey::Recovery`]'dir;
    /// cümle sarma anındakiyle aynı şekilde normalize edilir (elle yazımda tolerans).
    ///
    /// # Errors
    /// Cümle yanlış, dosya bozuk ya da açılacak profil yoksa hata döner.
    pub fn unlock_with_recovery(&mut self, phrase: &str) -> Result<()> {
        let Some(profile) = self.config.active_profile else {
            return Ok(());
        };
        let path = self.paths.vault_file(profile);
        let normalized = normalize_phrase(phrase);
        let (cipher, vault) = Vault::unlock(&path, OpenKey::Recovery(&normalized))?;
        self.vault = vault;
        self.cipher = Some(cipher);
        self.locked = false;
        Ok(())
    }

    /// Açık (kilitsiz) aktif vault'a bir kurtarma cümlesi sarımı ekler ve diske yazar.
    ///
    /// Onboarding'de parola belirlendikten hemen sonra çağrılır — vault zaten açıktır
    /// (DEK biliniyor), yani yalnızca yeni bir KEK sarımı eklenir; payload'a dokunulmaz
    /// (bkz. [`VaultCipher::add_key`]). Cümle bayt-eşleşmesi için normalize edilir.
    ///
    /// # Errors
    /// Aktif profil yoksa, vault açık değilse (kilitli/profilsiz) ya da kripto/yazma
    /// başarısızsa hata döner.
    pub fn set_recovery_phrase(&mut self, phrase: &str) -> Result<()> {
        let Some(profile_id) = self.config.active_profile else {
            return Err(Error::VaultLocked);
        };
        let normalized = normalize_phrase(phrase);
        {
            // Sır sadece bu blokta ödünç alınır; add_key CryptoError'ı `?` ile taşır.
            let cipher = self.cipher.as_mut().ok_or(Error::VaultLocked)?;
            cipher.add_key(SealKey::Recovery(&normalized))?;
        }
        // Yeni sarımla (Recovery dahil) vault'u yeniden diske yaz.
        self.save_vault()?;
        // İndekste bayrağı işaretle ve config'i kalıcılaştır.
        if let Some(p) = self.config.profiles.iter_mut().find(|p| p.id == profile_id) {
            p.has_recovery_phrase = true;
        }
        self.config.save(&self.paths.config_file())
    }

    /// Aktif profilde bir kurtarma cümlesi tanımlı mı (kilit ekranı "recovery ile aç"
    /// yolunu göstersin mi diye).
    #[must_use]
    pub fn active_profile_has_recovery(&self) -> bool {
        let Some(id) = self.config.active_profile else {
            return false;
        };
        self.config
            .profiles
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.has_recovery_phrase)
    }

    /// Onboarding'i tamamlar: temayı ayarlar, bir profil oluşturup şifreli vault kurar,
    /// `onboarded` bayrağını işaretler ve config'i diske yazar.
    ///
    /// `profile_name`/`password` boşsa: kullanıcı profili tümden atlamış demektir —
    /// keyring varsa yine de sessizce şifreli bir "default" profil kurulur, yoksa
    /// düz-metin sürtünmesiz modda kalınır.
    ///
    /// # Errors
    /// Kullanıcı bir profil isterken (ad/parola verildi) şifreleme kurulamazsa
    /// (ör. parolasız ama keyring yok), veya yazma başarısız olursa hata döner.
    pub fn complete_onboarding(
        &mut self,
        theme: Theme,
        profile_name: Option<&str>,
        password: Option<&str>,
    ) -> Result<()> {
        self.config.theme = theme;
        self.config.onboarded = true;

        let name = profile_name.map(str::trim).filter(|n| !n.is_empty());
        let password = password.filter(|p| !p.is_empty());

        if name.is_some() || password.is_some() {
            // Kullanıcı bir profil istiyor → şifreli kur (anahtar yoksa hata yükselir).
            self.create_profile(name, password)?;
        } else if let Err(e) = self.create_profile(None, None) {
            // Tümden atlandı ve keyring yok → düz-metin sürtünmesiz modda kal.
            tracing::debug!(error = %e, "parolasız default profil kurulamadı; düz-metin modda kalınıyor");
        }

        self.config.save(&self.paths.config_file())
    }

    /// Yeni bir şifreli profil oluşturur, mevcut (eski/boş) vault verisini içine taşır,
    /// indekse ekler ve aktif yapar.
    ///
    /// Parola verilirse **yalnız parola** sarımı kurulur (keyring otomatik-açılış
    /// eklenmez → yeniden açılışta parola sorulur). Parolasızsa keyring makine-anahtarı
    /// kullanılır; keyring yoksa hata.
    fn create_profile(&mut self, name: Option<&str>, password: Option<&str>) -> Result<()> {
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or("default");
        let mut profile = Profile::new(name, &self.device_label);
        let profile_id = profile.id;

        // Anahtar sarımını kur.
        let (cipher, keyring_key) = if let Some(pw) = password.filter(|p| !p.is_empty()) {
            profile.locked_with_password = true;
            (VaultCipher::create(&[SealKey::Password(pw)])?, None)
        } else {
            let key = crypto::random_key()?;
            self.keystore.set(profile_id, &key).map_err(|_| {
                Error::Keyring(
                    "no OS keyring available — set a password to encrypt this profile".into(),
                )
            })?;
            let cipher = VaultCipher::create(&[SealKey::Keyring(&key)])?;
            (cipher, Some(profile_id))
        };

        // Mevcut vault verisini bu profile şifreli yaz (göç).
        let path = self.paths.vault_file(profile_id);
        if let Err(e) =
            self.vault
                .save_with_cipher(&path, &cipher, &self.device_label, crypto::now_millis())
        {
            // Yazma başarısızsa keyring anahtarını geri al (yetim bırakma).
            if let Some(id) = keyring_key {
                let _ = self.keystore.delete(id);
            }
            return Err(e);
        }

        // İndeks + aktiflik + oturum.
        self.config.profiles.push(profile);
        self.config.active_profile = Some(profile_id);
        self.cipher = Some(cipher);
        self.locked = false;

        // Göç tamam → eski düz-metin vault'u sil (diskte düz metin kalmasın).
        let legacy = self.paths.default_vault_file();
        if legacy.exists() {
            if let Err(e) = std::fs::remove_file(&legacy) {
                tracing::warn!(error = %e, "eski düz-metin vault silinemedi");
            }
        }
        Ok(())
    }

    /// Kayıtlı host'lar.
    #[must_use]
    pub fn hosts(&self) -> &[Host] {
        &self.vault.hosts
    }

    /// Klasörler.
    #[must_use]
    pub fn folders(&self) -> &[Folder] {
        &self.vault.folders
    }

    /// Kimlikler.
    #[must_use]
    pub fn identities(&self) -> &[Identity] {
        &self.vault.identities
    }

    /// Kimliğe göre host.
    #[must_use]
    pub fn host(&self, id: HostId) -> Option<&Host> {
        self.vault.hosts.iter().find(|h| h.id == id)
    }

    /// Kimliğe göre klasör.
    #[must_use]
    pub fn folder(&self, id: FolderId) -> Option<&Folder> {
        self.vault.folders.iter().find(|f| f.id == id)
    }

    /// Kimliğe göre kimlik kaydı.
    #[must_use]
    pub fn identity(&self, id: IdentityId) -> Option<&Identity> {
        self.vault.identities.iter().find(|i| i.id == id)
    }

    /// Tüm kayıtlı komutlar (snippet'ler).
    #[must_use]
    pub fn snippets(&self) -> &[Snippet] {
        &self.vault.snippets
    }

    /// Bir host için geçerli snippet'ler: global (host'a bağlı olmayan) + o host'a özel.
    #[must_use]
    pub fn snippets_for_host(&self, host: HostId) -> Vec<&Snippet> {
        self.vault
            .snippets
            .iter()
            .filter(|s| s.host_id.is_none() || s.host_id == Some(host))
            .collect()
    }

    /// Kimliğe göre snippet.
    #[must_use]
    pub fn snippet(&self, id: SnippetId) -> Option<&Snippet> {
        self.vault.snippets.iter().find(|s| s.id == id)
    }

    /// Yeni bir snippet ekler ve diske yazar; kimliğini döndürür.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn add_snippet(&mut self, snippet: Snippet) -> Result<SnippetId> {
        let id = snippet.id;
        self.vault.snippets.push(snippet);
        self.save_vault()?;
        Ok(id)
    }

    /// Var olan snippet'i (kimliğine göre) günceller ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn update_snippet(&mut self, snippet: Snippet) -> Result<()> {
        if let Some(slot) = self.vault.snippets.iter_mut().find(|s| s.id == snippet.id) {
            *slot = snippet;
        }
        self.save_vault()
    }

    /// Bir snippet'i siler ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn remove_snippet(&mut self, id: SnippetId) -> Result<()> {
        self.vault.snippets.retain(|s| s.id != id);
        self.save_vault()
    }

    /// Pencere kapatılınca tepsiye inilsin mi.
    #[must_use]
    pub fn minimize_to_tray(&self) -> bool {
        self.config.minimize_to_tray
    }

    /// Tepsiye inme ayarını değiştirir ve config'i yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn set_minimize_to_tray(&mut self, enabled: bool) -> Result<()> {
        self.config.minimize_to_tray = enabled;
        self.config.save(&self.paths.config_file())
    }

    /// Tüm uptime monitörleri.
    #[must_use]
    pub fn monitors(&self) -> &[Monitor] {
        &self.vault.monitors
    }

    /// Kimliğe göre monitör.
    #[must_use]
    pub fn monitor(&self, id: MonitorId) -> Option<&Monitor> {
        self.vault.monitors.iter().find(|m| m.id == id)
    }

    /// Yeni bir monitör ekler ve diske yazar; kimliğini döndürür.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn add_monitor(&mut self, monitor: Monitor) -> Result<MonitorId> {
        let id = monitor.id;
        self.vault.monitors.push(monitor);
        self.save_vault()?;
        Ok(id)
    }

    /// Var olan monitörü (kimliğine göre) günceller ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn update_monitor(&mut self, monitor: Monitor) -> Result<()> {
        if let Some(slot) = self.vault.monitors.iter_mut().find(|m| m.id == monitor.id) {
            *slot = monitor;
        }
        self.save_vault()
    }

    /// Bir monitörü siler ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn remove_monitor(&mut self, id: MonitorId) -> Result<()> {
        self.vault.monitors.retain(|m| m.id != id);
        self.save_vault()
    }

    /// BYOS senkron hedef klasörü (ayarlıysa).
    #[must_use]
    pub fn sync_dir(&self) -> Option<&Path> {
        self.config.sync_dir.as_deref()
    }

    /// Senkron hedef klasörünü ayarlar/temizler ve config'i yazar.
    ///
    /// # Errors
    /// Config yazılamazsa hata döner.
    pub fn set_sync_dir(&mut self, dir: Option<PathBuf>) -> Result<()> {
        self.config.sync_dir = dir.filter(|d| !d.as_os_str().is_empty());
        self.config.save(&self.paths.config_file())
    }

    /// Aktif profilin şifreli vault'u ile senkron dosyasının (yerel, uzak) yolları.
    fn sync_paths(&self) -> Result<(PathBuf, PathBuf)> {
        let Some(profile) = self.config.active_profile else {
            return Err(Error::Sync(
                "Create an encrypted profile before syncing.".to_string(),
            ));
        };
        let Some(dir) = self.config.sync_dir.clone() else {
            return Err(Error::Sync("Choose a sync folder first.".to_string()));
        };
        let local = self.paths.vault_file(profile);
        let remote = dir.join(crate::sync::REMOTE_VAULT_NAME);
        Ok((local, remote))
    }

    /// Yerel ile uzak vault'un senkron durumunu (şifre çözmeden) karşılaştırır.
    /// Hedef ayarlı değilse `None`.
    ///
    /// # Errors
    /// Dosyalar okunamaz/tanınmazsa hata döner.
    pub fn sync_status(&self) -> Result<Option<crate::sync::SyncStatus>> {
        match self.sync_paths() {
            Ok((local, remote)) => Ok(Some(crate::sync::status(&local, &remote)?)),
            Err(_) => Ok(None),
        }
    }

    /// Yerel ile uzak vault'u uzlaştırır (son-yazan-kazanır). Uzak daha yeniyse çeker
    /// ve aktif vault'u yeniden yükler (parolalı yabancı vault → kilitli duruma geçebilir).
    ///
    /// # Errors
    /// Senkron kurulu değilse ya da kopyalama başarısızsa hata döner.
    pub fn sync_now(&mut self) -> Result<crate::sync::SyncOutcome> {
        let (local, remote) = self.sync_paths()?;
        let outcome = crate::sync::reconcile(&local, &remote)?;
        // Uzak çekildiyse yerel dosya değişti → bellekteki vault'u tazele.
        if matches!(
            outcome,
            crate::sync::SyncOutcome::RemoteNewer | crate::sync::SyncOutcome::OnlyRemote
        ) {
            self.load_active_vault()?;
        }
        Ok(outcome)
    }

    /// `~/.ssh/config`'ten okunan host'ları vault'a ekler.
    ///
    /// Aynı etiket zaten varsa atlar (yeniden içe aktarımda çoğaltmaz). Anahtar
    /// dosyaları yola göre bir kimliğe eşlenir (paylaşılır). Bkz. [`crate::ssh_config`].
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn import_ssh_hosts(&mut self, imported: &[ImportedHost]) -> Result<ImportSummary> {
        let mut summary = ImportSummary::default();
        for ih in imported {
            if self.vault.hosts.iter().any(|h| h.label == ih.alias) {
                summary.skipped += 1;
                continue;
            }
            let mut host = Host::new(&ih.alias, ih.address());
            if let Some(port) = ih.port {
                host.port = port;
            }
            host.username = ih.user.clone();
            if let Some(key_path) = &ih.identity_file {
                host.identity_id = Some(self.ensure_key_identity(key_path));
            }
            self.vault.hosts.push(host);
            summary.added += 1;
        }
        if summary.added > 0 {
            self.save_vault()?;
        }
        Ok(summary)
    }

    /// Verilen anahtar yolu için bir Key kimliği bulur (yola göre) ya da oluşturur.
    fn ensure_key_identity(&mut self, key_path: &Path) -> IdentityId {
        if let Some(existing) = self.vault.identities.iter().find(|i| {
            matches!(
                &i.auth,
                AuthMethod::Key { private_key_path: Some(p), .. } if p.as_path() == key_path
            )
        }) {
            return existing.id;
        }
        let label = key_path
            .file_name()
            .map_or_else(|| "key".to_string(), |n| n.to_string_lossy().into_owned());
        let identity = Identity::new(
            label,
            AuthMethod::Key {
                private_key_path: Some(key_path.to_path_buf()),
                has_passphrase: false,
            },
        );
        let id = identity.id;
        self.vault.identities.push(identity);
        id
    }

    /// Yeni host ekler ve diske yazar; eklenen host'un kimliğini döndürür.
    ///
    /// # Errors
    /// Yazma başarısız olursa (ör. vault kilitli) hata döner.
    pub fn add_host(&mut self, host: Host) -> Result<HostId> {
        let id = host.id;
        self.vault.hosts.push(host);
        self.save_vault()?;
        Ok(id)
    }

    /// Var olan host'u (kimliğine göre) günceller ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn update_host(&mut self, host: Host) -> Result<()> {
        if let Some(slot) = self.vault.hosts.iter_mut().find(|h| h.id == host.id) {
            *slot = host;
        }
        self.save_vault()
    }

    /// Host'u siler (ve ona bağlı snippet'leri) ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn remove_host(&mut self, id: HostId) -> Result<()> {
        self.vault.hosts.retain(|h| h.id != id);
        self.vault.snippets.retain(|s| s.host_id != Some(id));
        self.save_vault()
    }

    /// Yeni bir kimlik (auth) kaydı ekler ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn add_identity(&mut self, identity: Identity) -> Result<IdentityId> {
        let id = identity.id;
        self.vault.identities.push(identity);
        self.save_vault()?;
        Ok(id)
    }

    /// Hiçbir host'un referans vermediği kimlikleri temizler ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn prune_orphan_identities(&mut self) -> Result<()> {
        let used: std::collections::HashSet<IdentityId> = self
            .vault
            .hosts
            .iter()
            .filter_map(|h| h.identity_id)
            .collect();
        let before = self.vault.identities.len();
        self.vault.identities.retain(|i| used.contains(&i.id));
        if self.vault.identities.len() != before {
            self.save_vault()?;
        }
        Ok(())
    }

    /// Verilen adla bir klasör bulur; yoksa oluşturur. Kimliğini döndürür.
    /// (Yeni klasör bir host'a bağlanınca [`Store::add_host`]/[`Store::update_host`] ile kalıcılaşır.)
    pub fn ensure_folder(&mut self, name: &str) -> FolderId {
        if let Some(folder) = self.vault.folders.iter().find(|f| f.name == name) {
            return folder.id;
        }
        let folder = Folder::new(name);
        let id = folder.id;
        self.vault.folders.push(folder);
        id
    }

    /// Hiçbir host'un referans vermediği klasörleri temizler ve diske yazar.
    ///
    /// # Errors
    /// Yazma başarısız olursa hata döner.
    pub fn prune_empty_folders(&mut self) -> Result<()> {
        let used: std::collections::HashSet<FolderId> = self
            .vault
            .hosts
            .iter()
            .filter_map(|h| h.folder_id)
            .collect();
        let before = self.vault.folders.len();
        self.vault.folders.retain(|f| used.contains(&f.id));
        if self.vault.folders.len() != before {
            self.save_vault()?;
        }
        Ok(())
    }

    /// Aktif vault'u diske yazar: şifreli (profil + cipher varsa) ya da düz metin
    /// (profil yoksa). Kilitliyken yazmayı reddeder (düz-metin sızıntısını önler).
    fn save_vault(&self) -> Result<()> {
        match (self.locked, &self.cipher, self.config.active_profile) {
            // Kilitli: hiçbir şey yazma (UI zaten engellemeli).
            (true, _, _) => Err(Error::VaultLocked),
            // Şifreli aktif profil.
            (false, Some(cipher), Some(profile)) => {
                let path = self.paths.vault_file(profile);
                self.vault
                    .save_with_cipher(&path, cipher, &self.device_label, crypto::now_millis())
            }
            // Profil yok → geçici düz metin (sürtünmesiz mod).
            (false, None, None) => self.vault.save(&self.paths.default_vault_file()),
            // Profil var ama cipher yok ve kilitli değil → tutarsız durum.
            (false, _, _) => Err(Error::VaultLocked),
        }
    }
}

/// BYOS senkronda cihaz ayrımı için varsayılan kimlik etiketi (ör. bilgisayar adı).
fn default_identity_label() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|h| h.trim().to_lowercase())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "this-device".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AuthMethod;
    use crate::vault::keystore::MemoryKeyStore;
    use tempfile::tempdir;

    /// Bellek kasalı bir store aç (testler gerçek OS keyring'e dokunmaz).
    fn open_mem(paths: &Paths, ks: MemoryKeyStore) -> Store {
        Store::open_with(paths, Box::new(ks)).unwrap()
    }

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let store = open_mem(&paths, MemoryKeyStore::new());
        (dir, store)
    }

    #[test]
    fn add_host_persists_across_reopen() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();

        let id = {
            let mut store = open_mem(&paths, ks.clone());
            store.add_host(Host::new("web-01", "203.0.113.10")).unwrap()
        };

        // Yeniden aç: host hâlâ orada (profilsiz → düz metin geçiş yolu).
        let store = open_mem(&paths, ks.clone());
        assert_eq!(store.hosts().len(), 1);
        assert_eq!(store.host(id).unwrap().label, "web-01");
    }

    #[test]
    fn update_host_replaces_in_place() {
        let (_dir, mut store) = temp_store();
        let id = store.add_host(Host::new("web", "10.0.0.1")).unwrap();

        let mut edited = store.host(id).unwrap().clone();
        edited.label = "web-renamed".into();
        edited.port = 2222;
        store.update_host(edited).unwrap();

        assert_eq!(store.hosts().len(), 1);
        assert_eq!(store.host(id).unwrap().label, "web-renamed");
        assert_eq!(store.host(id).unwrap().port, 2222);
    }

    #[test]
    fn remove_host_also_drops_its_snippets() {
        let (_dir, mut store) = temp_store();
        let id = store.add_host(Host::new("web", "10.0.0.1")).unwrap();
        store.remove_host(id).unwrap();
        assert!(store.hosts().is_empty());
        assert!(store.host(id).is_none());
    }

    #[test]
    fn monitor_crud_persists_across_reopen() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();

        let id = {
            let mut store = open_mem(&paths, ks.clone());
            let id = store
                .add_monitor(Monitor::new(
                    "site",
                    crate::model::MonitorTarget::Http {
                        url: "https://example.com".into(),
                        expect_status: None,
                    },
                ))
                .unwrap();
            let mut edited = store.monitor(id).unwrap().clone();
            edited.interval_secs = 300;
            store.update_monitor(edited).unwrap();
            id
        };

        let mut store = open_mem(&paths, ks.clone());
        assert_eq!(store.monitors().len(), 1);
        assert_eq!(store.monitor(id).unwrap().interval_secs, 300);
        store.remove_monitor(id).unwrap();
        assert!(store.monitors().is_empty());
    }

    #[test]
    fn vault_without_monitors_field_still_loads() {
        // Monitörlerden önce yazılmış bir vault okunabilmeli (Vault serde(default)).
        let old = r#"{"folders":[],"identities":[],"hosts":[],"snippets":[]}"#;
        let vault: Vault = serde_json::from_str(old).unwrap();
        assert!(vault.monitors.is_empty());
    }

    #[test]
    fn ensure_folder_is_idempotent_by_name() {
        let (_dir, mut store) = temp_store();
        let a = store.ensure_folder("Production");
        let b = store.ensure_folder("Production");
        let c = store.ensure_folder("Personal");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(store.folders().len(), 2);
    }

    #[test]
    fn host_can_reference_folder_and_identity() {
        let (_dir, mut store) = temp_store();
        let folder = store.ensure_folder("Production");
        let ident = Identity::new("agent", AuthMethod::Agent);
        let ident_id = ident.id;
        store.vault.identities.push(ident);

        let mut host = Host::new("web", "10.0.0.1");
        host.folder_id = Some(folder);
        host.identity_id = Some(ident_id);
        let id = store.add_host(host).unwrap();

        assert_eq!(store.host(id).unwrap().folder_id, Some(folder));
        assert_eq!(store.folder(folder).unwrap().name, "Production");
        assert_eq!(store.identity(ident_id).unwrap().label, "agent");
    }

    #[test]
    fn onboarding_keyring_profile_auto_unlocks_on_reopen() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        {
            let mut store = open_mem(&paths, ks.clone());
            assert!(!store.is_onboarded());
            // Parolasız → keyring makine-anahtarı ile şifreli.
            store
                .complete_onboarding(Theme::Paper, Some("work"), None)
                .unwrap();
            assert!(!store.is_locked());
        }
        // Yeniden aç (aynı kasa): keyring sessizce açar.
        let store = open_mem(&paths, ks.clone());
        assert!(store.is_onboarded());
        assert!(!store.is_locked());
        assert_eq!(store.config().theme, Theme::Paper);
        assert_eq!(store.config().profiles.len(), 1);
        assert_eq!(store.config().profiles[0].name, "work");
        assert_eq!(store.active_profile(), Some(store.config().profiles[0].id));
    }

    #[test]
    fn onboarding_skip_still_encrypts_with_keyring() {
        // Tümden atlansa bile keyring varsa şifreli "default" profil kurulur.
        let (_dir, store) = {
            let dir = tempdir().unwrap();
            let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
            let mut store = open_mem(&paths, MemoryKeyStore::new());
            store
                .complete_onboarding(Theme::Contrast, None, None)
                .unwrap();
            (dir, store)
        };
        assert!(store.is_onboarded());
        assert_eq!(store.config().theme, Theme::Contrast);
        assert_eq!(store.config().profiles.len(), 1);
        assert_eq!(store.active_profile_name(), Some("default"));
        assert!(!store.config().profiles[0].locked_with_password);
    }

    #[test]
    fn password_profile_locks_on_reopen_then_unlocks() {
        // Kabul: parola kurulunca yeniden açılışta isteniyor; veri korunur.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        let host_id = {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), Some("s3cret"))
                .unwrap();
            assert!(store.config().profiles[0].locked_with_password);
            store.add_host(Host::new("web", "10.0.0.9")).unwrap()
        };

        // Yeniden aç: parola sarımı var, keyring yok → KİLİTLİ.
        let mut store = open_mem(&paths, ks.clone());
        assert!(store.is_locked());
        assert!(store.hosts().is_empty(), "kilitliyken veri görünmemeli");

        // Yanlış parola reddedilir.
        assert!(store.unlock("wrong").is_err());
        assert!(store.is_locked());

        // Doğru parola açar; host geri gelir.
        store.unlock("s3cret").unwrap();
        assert!(!store.is_locked());
        assert_eq!(store.hosts().len(), 1);
        assert_eq!(store.host(host_id).unwrap().label, "web");
    }

    #[test]
    fn password_vault_file_has_no_plaintext_secrets() {
        // Kabul denetimi: diskte düz metin hassas veri YOK.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        let profile_id = {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), Some("pw"))
                .unwrap();
            store
                .add_host(Host::new("prod-web", "203.0.113.77"))
                .unwrap();
            store.active_profile().unwrap()
        };

        let vault_bytes = std::fs::read(paths.vault_file(profile_id)).unwrap();
        let text = String::from_utf8_lossy(&vault_bytes);
        assert!(!text.contains("203.0.113.77"), "adres düz metin sızdı");
        assert!(!text.contains("prod-web"), "host etiketi düz metin sızdı");
        // Eski düz-metin vault dosyası kalmamalı.
        assert!(
            !paths.default_vault_file().exists(),
            "eski düz metin vault silinmedi"
        );
    }

    #[test]
    fn recovery_phrase_unlocks_after_password_forgotten() {
        // Kabul: parola unutulsa bile kurtarma cümlesiyle geri dönülür.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        let phrase = crate::vault::recovery::generate_phrase();
        let host_id = {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), Some("s3cret"))
                .unwrap();
            // Parola profiline kurtarma cümlesi ekle (vault açık → yalnız yeni sarım).
            store.set_recovery_phrase(&phrase).unwrap();
            assert!(store.active_profile_has_recovery());
            assert!(store.config().profiles[0].has_recovery_phrase);
            store.add_host(Host::new("web", "10.0.0.9")).unwrap()
        };

        // Yeniden aç: keyring yok → KİLİTLİ. Parola "unutuldu"; recovery ile açacağız.
        let mut store = open_mem(&paths, ks.clone());
        assert!(store.is_locked());
        assert!(
            store.active_profile_has_recovery(),
            "recovery bayrağı kilitliyken indeksten okunmalı"
        );

        // Yanlış cümle reddedilir (kilitli kalır).
        assert!(store
            .unlock_with_recovery("these are not the right words at all")
            .is_err());
        assert!(store.is_locked());

        // Doğru cümle açar — elle-yazım toleransı: büyük harf + fazladan boşluk.
        let typed = format!("  {}  ", phrase.to_uppercase());
        store.unlock_with_recovery(&typed).unwrap();
        assert!(!store.is_locked());
        assert_eq!(store.hosts().len(), 1);
        assert_eq!(store.host(host_id).unwrap().label, "web");
    }

    #[test]
    fn recovery_phrase_not_stored_in_plaintext() {
        // Kabul: kurtarma cümlesi diske DÜZ METİN yazılmaz (yalnız salt/nonce/sarılı DEK).
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        let phrase = crate::vault::recovery::generate_phrase();
        let profile_id = {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), Some("pw"))
                .unwrap();
            store.set_recovery_phrase(&phrase).unwrap();
            store.active_profile().unwrap()
        };

        let vault_bytes = std::fs::read(paths.vault_file(profile_id)).unwrap();
        let vault_text = String::from_utf8_lossy(&vault_bytes);
        assert!(
            !vault_text.contains(&*phrase),
            "kurtarma cümlesi vault dosyasına düz metin sızdı"
        );
        // Config (profil indeksi) yalnız bayrağı tutar; cümleyi ASLA.
        let cfg_bytes = std::fs::read(paths.config_file()).unwrap();
        let cfg_text = String::from_utf8_lossy(&cfg_bytes);
        assert!(
            !cfg_text.contains(&*phrase),
            "kurtarma cümlesi config'e düz metin sızdı"
        );
    }

    #[test]
    fn locked_store_refuses_mutations() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), Some("pw"))
                .unwrap();
        }
        let mut store = open_mem(&paths, ks.clone());
        assert!(store.is_locked());
        // Kilitliyken yazma reddedilir (düz-metin sızıntısı olmaz).
        assert!(store.add_host(Host::new("x", "1.2.3.4")).is_err());
    }

    #[test]
    fn prune_removes_unreferenced_folders() {
        let (_dir, mut store) = temp_store();
        let used = store.ensure_folder("Keep");
        let _unused = store.ensure_folder("Drop");
        let mut host = Host::new("web", "10.0.0.1");
        host.folder_id = Some(used);
        store.add_host(host).unwrap();

        store.prune_empty_folders().unwrap();
        assert_eq!(store.folders().len(), 1);
        assert_eq!(store.folders()[0].name, "Keep");
    }

    #[test]
    fn snippet_crud_and_host_scoping() {
        let (_dir, mut store) = temp_store();
        let web = store.add_host(Host::new("web", "10.0.0.1")).unwrap();
        let db = store.add_host(Host::new("db", "10.0.0.2")).unwrap();

        let g = store.add_snippet(Snippet::new("uptime", "uptime")).unwrap();
        let mut host_snip = Snippet::new("restart nginx", "sudo systemctl restart nginx");
        host_snip.host_id = Some(web);
        let hs = store.add_snippet(host_snip).unwrap();

        // web: global + kendi; db: yalnız global.
        assert_eq!(store.snippets_for_host(web).len(), 2);
        let for_db = store.snippets_for_host(db);
        assert_eq!(for_db.len(), 1);
        assert_eq!(for_db[0].id, g);

        // Güncelle + sil.
        let mut edited = store.snippet(hs).unwrap().clone();
        edited.label = "reload nginx".into();
        store.update_snippet(edited).unwrap();
        assert_eq!(store.snippet(hs).unwrap().label, "reload nginx");

        store.remove_snippet(g).unwrap();
        assert_eq!(store.snippets().len(), 1);
        assert!(store.snippet(g).is_none());
    }

    #[test]
    fn snippets_persist_encrypted_across_reopen() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let ks = MemoryKeyStore::new();
        {
            let mut store = open_mem(&paths, ks.clone());
            store
                .complete_onboarding(Theme::Black, Some("work"), None)
                .unwrap();
            store.add_snippet(Snippet::new("uptime", "uptime")).unwrap();
        }
        // Keyring profili → sessiz açılır; snippet şifreli vault'tan geri gelir.
        let store = open_mem(&paths, ks.clone());
        assert!(!store.is_locked());
        assert_eq!(store.snippets().len(), 1);
        assert_eq!(store.snippets()[0].label, "uptime");
    }

    #[test]
    fn imports_ssh_config_hosts_dedupes_and_shares_identity() {
        let (_dir, mut store) = temp_store();
        let parsed = crate::ssh_config::parse(
            "Host web\n HostName 10.0.0.1\n User deploy\n Port 2222\n IdentityFile ~/.ssh/id\n\
             Host db\n HostName 10.0.0.2\n IdentityFile ~/.ssh/id\n",
        );

        let summary = store.import_ssh_hosts(&parsed).unwrap();
        assert_eq!(summary.added, 2);
        assert_eq!(summary.skipped, 0);
        assert_eq!(store.hosts().len(), 2);

        let web = store.hosts().iter().find(|h| h.label == "web").unwrap();
        assert_eq!(web.address, "10.0.0.1");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username.as_deref(), Some("deploy"));

        // İki host aynı anahtar yolunu paylaşır → tek kimlik.
        assert_eq!(store.identities().len(), 1);
        let db = store.hosts().iter().find(|h| h.label == "db").unwrap();
        assert_eq!(web.identity_id, db.identity_id);
        assert!(web.identity_id.is_some());

        // Yeniden içe aktarım: hepsi zaten var → eklenmez.
        let again = store.import_ssh_hosts(&parsed).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.skipped, 2);
        assert_eq!(store.hosts().len(), 2);
    }

    #[test]
    fn syncs_encrypted_vault_to_folder_and_reads_it_back() {
        // Kabul (P4 madde 2): vault başka klasöre yazılıp geri okunuyor.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("config"), dir.path().join("data"));
        let sync_dir = dir.path().join("dropbox");
        let ks = MemoryKeyStore::new();

        let mut store = open_mem(&paths, ks.clone());
        store
            .complete_onboarding(Theme::Black, Some("work"), None)
            .unwrap();
        let hid = store.add_host(Host::new("web", "10.0.0.9")).unwrap();
        store.set_sync_dir(Some(sync_dir.clone())).unwrap();

        // İt: uzak yoktu → yalnız-yerel.
        assert_eq!(
            store.sync_now().unwrap(),
            crate::sync::SyncOutcome::OnlyLocal
        );
        let remote = sync_dir.join("vault.portal");
        assert!(remote.exists());
        // Uzak kopya şifreli — düz metin adres yok.
        let remote_bytes = std::fs::read(&remote).unwrap();
        assert!(!String::from_utf8_lossy(&remote_bytes).contains("10.0.0.9"));

        // Yerel şifreli vault'u sil → tekrar senkron → uzaktan çek → host geri gelir.
        let profile = store.active_profile().unwrap();
        std::fs::remove_file(paths.vault_file(profile)).unwrap();
        assert_eq!(
            store.sync_now().unwrap(),
            crate::sync::SyncOutcome::OnlyRemote
        );
        assert!(!store.is_locked());
        assert_eq!(store.hosts().len(), 1);
        assert_eq!(store.host(hid).unwrap().address, "10.0.0.9");
    }
}
