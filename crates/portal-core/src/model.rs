//! Portal domain veri modeli.
//!
//! Bu modeller UI'dan bağımsızdır; hem TUI hem (ileride) GUI aynı tipleri kullanır.
//! **Hassas materyal (parola, private key baytları, passphrase) burada TUTULMAZ** —
//! yalnızca vault'ta şifreli saklanır (docs/ARCHITECTURE.md §5). Buradaki alanlar
//! yalnızca referans/metadata taşır.

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// SSH varsayılan portu.
pub const DEFAULT_SSH_PORT: u16 = 22;

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

/// Tip-güvenli kimlik (ID) newtype'ları üretir. `#[serde(transparent)]` sayesinde
/// bir UUID string'i olarak serileşir; farklı ID tipleri karışmaz.
macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            /// Yeni, rastgele bir kimlik üretir.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                std::fmt::Display::fmt(&self.0, f)
            }
        }

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }
    };
}

id_type!(
    /// Bir [`Host`] kaydının kimliği.
    HostId
);
id_type!(
    /// Bir [`Folder`]'ın kimliği.
    FolderId
);
id_type!(
    /// Bir [`Identity`]'nin kimliği.
    IdentityId
);
id_type!(
    /// Bir [`Profile`]'ın kimliği.
    ProfileId
);
id_type!(
    /// Bir [`Session`]'ın kimliği.
    SessionId
);
id_type!(
    /// Bir [`Snippet`]'in kimliği.
    SnippetId
);
id_type!(
    /// Bir [`Monitor`]'ün kimliği.
    MonitorId
);

/// Kaydedilmiş bir SSH bağlantısı (host/port/user + kimlik & gruplama referansları).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Host {
    /// Benzersiz kimlik.
    pub id: HostId,
    /// İnsan-okur ad, ör. "prod-web".
    pub label: String,
    /// Ağ adresi (IP veya hostname).
    pub address: String,
    /// SSH portu (varsayılan 22).
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    /// Bağlanılacak kullanıcı; boşsa kimlikteki/kullanıcının varsayılanı.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Kullanılacak kimlik (anahtar/şifre) referansı.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<IdentityId>,
    /// İçinde bulunduğu klasör; boşsa köke ait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<FolderId>,
    /// Üzerinden atlanacak jump host (bastion); boşsa doğrudan bağlanılır. Bkz. P5e.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host_id: Option<HostId>,
    /// Bağlanırken yerel ssh-agent'ı bu host'a forward et (yalnız güvenilen host).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forward_agent: bool,
    /// Sunucu sayfası açılınca otomatik bir shell aç (kullanıcı her seferinde
    /// Connect'e basmasın — "sürekli bağlı tut").
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_connect: bool,
    /// Serbest etiketler (arama/filtre).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Opsiyonel not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Host {
    /// Varsayılan port ve boş alanlarla yeni bir host oluşturur.
    #[must_use]
    pub fn new(label: impl Into<String>, address: impl Into<String>) -> Self {
        Self {
            id: HostId::new(),
            label: label.into(),
            address: address.into(),
            port: DEFAULT_SSH_PORT,
            username: None,
            identity_id: None,
            folder_id: None,
            jump_host_id: None,
            forward_agent: false,
            auto_connect: false,
            tags: Vec::new(),
            note: None,
        }
    }
}

/// Host'ları gruplayan (iç içe olabilen) klasör.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    /// Benzersiz kimlik.
    pub id: FolderId,
    /// Klasör adı.
    pub name: String,
    /// Üst klasör; boşsa köke ait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<FolderId>,
}

impl Folder {
    /// Kökte, üst klasörü olmayan yeni bir klasör oluşturur.
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: FolderId::new(),
            name: name.into(),
            parent_id: None,
        }
    }
}

/// Yeniden kullanılabilir kimlik doğrulama yöntemi (anahtar / şifre / agent).
///
/// Gerçek gizli materyal vault'ta; burada yalnızca metadata/referans vardır.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethod {
    /// Çalışan ssh-agent üzerinden doğrulama.
    Agent,
    /// Public-key doğrulama. Anahtar/passphrase gizli materyali vault'tadır.
    Key {
        /// Private key dosya yolu (opsiyonel; içerik değil yalnızca yol referansı).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        private_key_path: Option<std::path::PathBuf>,
        /// Anahtarın passphrase ile korunup korunmadığı.
        #[serde(default)]
        has_passphrase: bool,
    },
    /// Şifre doğrulama. Şifrenin kendisi vault'tadır.
    Password,
}

/// Bir host için SAKLANAN bağlanma sırrı (parola ya da anahtar passphrase'i).
///
/// Yalnızca kullanıcı açıkça "Remember" derse yazılır ve **yalnızca şifreli vault'ta**
/// yaşar — `config.toml`'da ya da düz metin hiçbir yerde durmaz. `AuthMethod`
/// yorumlarının baştan beri söylediği "sır vault'tadır" ifadesinin karşılığı budur.
///
/// ⚠️ Vault parolasız (OS keyring) açılıyorsa, makineye erişen biri bu sırra da
/// erişir. Arayüz bunu anahtarın yanında AÇIKÇA söyler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredSecret {
    /// Hangi host'a ait.
    #[zeroize(skip)]
    pub host_id: HostId,
    /// Anahtar dosyası yolu. `Some` ise yöntem key-file, `None` ise paroladır.
    /// Yol SIR DEĞİLDİR (bkz. ARCHITECTURE §5) ama yöntemi o belirler — sırrın
    /// yanında durması, bağlanırken kimliğe ikinci bir sorgu gerektirmemesi içindir.
    #[zeroize(skip)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<std::path::PathBuf>,
    /// Parola ya da passphrase. Boş = passphrase'siz anahtar. Düşerken sıfırlanır.
    pub secret: String,
}

/// Host'ların referans verdiği kimlik doğrulama kaydı.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    /// Benzersiz kimlik.
    pub id: IdentityId,
    /// İnsan-okur etiket, ör. "alex-laptop key".
    pub label: String,
    /// Bu kimlikle ilişkili varsayılan kullanıcı adı (opsiyonel).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Doğrulama yöntemi.
    pub auth: AuthMethod,
}

impl Identity {
    /// Verilen yöntemle yeni bir kimlik oluşturur.
    #[must_use]
    pub fn new(label: impl Into<String>, auth: AuthMethod) -> Self {
        Self {
            id: IdentityId::new(),
            label: label.into(),
            username: None,
            auth,
        }
    }
}

/// Yerel profil (bulut hesabı DEĞİL). Her profilin kendi şifreli vault'u vardır.
///
/// Aynı makinede birden çok profil yan yana durabilir (iş/kişisel). Bkz.
/// docs/ARCHITECTURE.md §5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Benzersiz kimlik.
    pub id: ProfileId,
    /// Profil adı, ör. "work" / "personal".
    pub name: String,
    /// BYOS senkronda cihaz/çakışma ayrımı için kimlik etiketi, ör. "alex-laptop".
    pub identity_label: String,
    /// Vault bir parola ile mi kilitli.
    #[serde(default)]
    pub locked_with_password: bool,
    /// Profil kurulurken bir kurtarma cümlesi üretildi mi.
    #[serde(default)]
    pub has_recovery_phrase: bool,
}

impl Profile {
    /// Parolasız/kurtarmasız yeni bir profil oluşturur.
    #[must_use]
    pub fn new(name: impl Into<String>, identity_label: impl Into<String>) -> Self {
        Self {
            id: ProfileId::new(),
            name: name.into(),
            identity_label: identity_label.into(),
            locked_with_password: false,
            has_recovery_phrase: false,
        }
    }
}

/// Bir host'a açılan çalışma oturumu (bir sekme). Çalışma-zamanı durumu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// Benzersiz kimlik.
    pub id: SessionId,
    /// Hangi host'a ait.
    pub host_id: HostId,
    /// Sekme başlığı.
    pub title: String,
    /// Aktif görünüm (Gateway varsayılan).
    #[serde(default)]
    pub view: SessionView,
}

impl Session {
    /// Gateway görünümüyle başlayan yeni bir oturum oluşturur.
    #[must_use]
    pub fn new(host_id: HostId, title: impl Into<String>) -> Self {
        Self {
            id: SessionId::new(),
            host_id,
            title: title.into(),
            view: SessionView::default(),
        }
    }
}

/// Bir oturumun aktif görünümü (docs/DESIGN.md §7 görünüm anahtarı).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionView {
    /// Sade dilli karşılama kartı — host seçince ilk gelen ekran.
    #[default]
    Gateway,
    /// İnteraktif shell.
    Terminal,
    /// İki panelli dosya (SFTP).
    Files,
    /// Sistem metrikleri.
    Monitor,
}

/// Kaydedilmiş komut (snippet) — tek tıkla çalıştırılır.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    /// Benzersiz kimlik.
    pub id: SnippetId,
    /// Etiket, ör. "restart nginx".
    pub label: String,
    /// Çalıştırılacak komut.
    pub command: String,
    /// `None` = global; `Some` = yalnızca bu host'a özel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<HostId>,
}

impl Snippet {
    /// Global (host'a bağlı olmayan) yeni bir snippet oluşturur.
    #[must_use]
    pub fn new(label: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: SnippetId::new(),
            label: label.into(),
            command: command.into(),
            host_id: None,
        }
    }
}

/// Varsayılan kontrol aralığı (saniye).
pub const DEFAULT_MONITOR_INTERVAL: u32 = 60;
/// Varsayılan kontrol zaman aşımı (saniye).
pub const DEFAULT_MONITOR_TIMEOUT: u32 = 10;

fn default_interval() -> u32 {
    DEFAULT_MONITOR_INTERVAL
}

fn default_timeout() -> u32 {
    DEFAULT_MONITOR_TIMEOUT
}

fn default_true() -> bool {
    true
}

/// Bir uptime monitörünün ne kontrol ettiği.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MonitorTarget {
    /// HTTP(S) isteği; yanıt kodu beklenen aralıkta değilse Down.
    Http {
        /// Tam URL (şema dahil), ör. "https://example.com/health".
        url: String,
        /// Beklenen HTTP durum kodu; `None` = herhangi bir 2xx/3xx.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect_status: Option<u16>,
    },
    /// Ham TCP bağlantısı; port açılmıyorsa Down.
    Tcp {
        /// Host adı veya IP.
        host: String,
        /// TCP portu.
        port: u16,
    },
}

impl MonitorTarget {
    /// Kullanıcıya gösterilecek tek satırlık hedef metni.
    #[must_use]
    pub fn display(&self) -> String {
        match self {
            Self::Http { url, .. } => url.clone(),
            Self::Tcp { host, port } => format!("{host}:{port}"),
        }
    }
}

/// Periyodik olarak kontrol edilen bir uptime monitörü.
///
/// Hedef adresler sır değildir; yine de vault'ta tutulurlar — böylece profil
/// senkronuyla birlikte gelirler ve ikinci bir depolama yolu açılmaz.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Monitor {
    /// Benzersiz kimlik.
    pub id: MonitorId,
    /// İnsan-okur ad, ör. "portal.co".
    pub label: String,
    /// Ne kontrol edilecek.
    pub target: MonitorTarget,
    /// Kontrol aralığı (saniye).
    #[serde(default = "default_interval")]
    pub interval_secs: u32,
    /// Tek kontrol için zaman aşımı (saniye).
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    /// Kapalıysa hiç kontrol edilmez (geçmişi korunur).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// İsteğe bağlı: bu monitörün ait olduğu kayıtlı host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<HostId>,
}

impl Monitor {
    /// Varsayılan aralık/zaman aşımı ile yeni, etkin bir monitör oluşturur.
    #[must_use]
    pub fn new(label: impl Into<String>, target: MonitorTarget) -> Self {
        Self {
            id: MonitorId::new(),
            label: label.into(),
            target,
            interval_secs: DEFAULT_MONITOR_INTERVAL,
            timeout_secs: DEFAULT_MONITOR_TIMEOUT,
            enabled: true,
            host_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON üzerinden tam tur (serialize → deserialize).
    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + serde::de::DeserializeOwned,
    {
        let json = serde_json::to_string(value).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn host_roundtrips() {
        let mut host = Host::new("prod-web", "203.0.113.10");
        host.port = 2222;
        host.username = Some("deploy".into());
        host.identity_id = Some(IdentityId::new());
        host.folder_id = Some(FolderId::new());
        host.jump_host_id = Some(HostId::new());
        host.forward_agent = true;
        host.tags = vec!["prod".into(), "web".into()];
        host.note = Some("birincil web düğümü".into());
        assert_eq!(host, roundtrip(&host));
    }

    #[test]
    fn host_default_port() {
        let host = Host::new("box", "example.com");
        assert_eq!(host.port, DEFAULT_SSH_PORT);
        assert_eq!(host, roundtrip(&host));
    }

    #[test]
    fn folder_roundtrips() {
        let mut child = Folder::new("staging");
        child.parent_id = Some(FolderId::new());
        assert_eq!(child, roundtrip(&child));
    }

    #[test]
    fn identity_roundtrips_all_auth_methods() {
        for auth in [
            AuthMethod::Agent,
            AuthMethod::Password,
            AuthMethod::Key {
                private_key_path: Some("/home/alex/.ssh/id_ed25519".into()),
                has_passphrase: true,
            },
            AuthMethod::Key {
                private_key_path: None,
                has_passphrase: false,
            },
        ] {
            let mut identity = Identity::new("alex-laptop", auth);
            identity.username = Some("alex".into());
            assert_eq!(identity, roundtrip(&identity));
        }
    }

    #[test]
    fn profile_roundtrips() {
        let mut profile = Profile::new("work", "alex-laptop");
        profile.locked_with_password = true;
        profile.has_recovery_phrase = true;
        assert_eq!(profile, roundtrip(&profile));
    }

    #[test]
    fn session_roundtrips_each_view() {
        for view in [
            SessionView::Gateway,
            SessionView::Terminal,
            SessionView::Files,
            SessionView::Monitor,
        ] {
            let mut session = Session::new(HostId::new(), "prod-web");
            session.view = view;
            assert_eq!(session, roundtrip(&session));
        }
    }

    #[test]
    fn session_defaults_to_gateway() {
        let session = Session::new(HostId::new(), "box");
        assert_eq!(session.view, SessionView::Gateway);
    }

    #[test]
    fn snippet_roundtrips() {
        let mut snippet = Snippet::new("restart nginx", "sudo systemctl restart nginx");
        snippet.host_id = Some(HostId::new());
        assert_eq!(snippet, roundtrip(&snippet));
    }

    #[test]
    fn monitor_roundtrips_each_target() {
        for target in [
            MonitorTarget::Http {
                url: "https://example.com/health".into(),
                expect_status: Some(204),
            },
            MonitorTarget::Http {
                url: "https://example.com".into(),
                expect_status: None,
            },
            MonitorTarget::Tcp {
                host: "203.0.113.10".into(),
                port: 5432,
            },
        ] {
            let mut monitor = Monitor::new("site", target);
            monitor.host_id = Some(HostId::new());
            monitor.interval_secs = 300;
            monitor.enabled = false;
            assert_eq!(monitor, roundtrip(&monitor));
        }
    }

    #[test]
    fn monitor_fills_defaults_from_minimal_json() {
        // Elle yazılmış/eski kayıtta yalnız zorunlu alanlar olabilir.
        let json = r#"{"id":"7a1f6d3e-0000-4000-8000-000000000001","label":"site",
            "target":{"kind":"tcp","host":"example.com","port":443}}"#;
        let monitor: Monitor = serde_json::from_str(json).unwrap();
        assert_eq!(monitor.interval_secs, DEFAULT_MONITOR_INTERVAL);
        assert_eq!(monitor.timeout_secs, DEFAULT_MONITOR_TIMEOUT);
        assert!(monitor.enabled);
    }

    #[test]
    fn id_types_are_distinct_but_serialize_as_bare_uuid() {
        let id = HostId::new();
        let json = serde_json::to_string(&id).unwrap();
        // transparent: dıştan yalnızca bir UUID string'i görünür.
        assert!(json.starts_with('"') && json.ends_with('"'));
        assert_eq!(id, serde_json::from_str::<HostId>(&json).unwrap());
    }
}
