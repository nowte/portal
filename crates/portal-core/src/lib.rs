//! Portal domain çekirdeği.
//!
//! Tüm domain mantığı burada yaşar; UI crate'leri (portal-tui, ileride portal-gui)
//! bu çekirdeğin ince kabuğudur — kod tekrarı yok. Bkz. docs/ARCHITECTURE.md.
//!
//! Kütüphane kodunda `unwrap`/`expect` yasaktır (aşağıdaki lint + CI `-D warnings`);
//! testlerde `clippy.toml` ile muaf tutulur.

#![warn(clippy::unwrap_used, clippy::expect_used)]
#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod fuzzy;
pub mod keys;
pub mod metrics;
pub mod model;
pub mod paths;
pub mod sftp;
pub mod ssh;
pub mod ssh_config;
pub mod store;
pub mod sync;
pub mod teaching;
pub mod tunnel;
pub mod uptime;
pub mod uptime_log;
pub mod vault;

mod persist;

pub use config::{Config, Theme};
pub use error::{Error, Result};
pub use keys::{generate_ed25519, key_info, GeneratedKey, KeyInfo};
pub use metrics::{DiskInfo, Metrics, ProcInfo, SystemEvent, SystemReport, SystemSession};
pub use model::{
    AuthMethod, Folder, FolderId, Host, HostId, Identity, IdentityId, Monitor, MonitorId,
    MonitorTarget, Profile, ProfileId, Session, SessionId, SessionView, Snippet, SnippetId,
    StoredSecret, DEFAULT_SSH_PORT,
};
pub use paths::Paths;
pub use persist::write_secure_temp;
pub use sftp::{FileEntry, SftpEvent, SftpSession, TransferId, TransferKind};
pub use ssh::{
    AuthChoice, ConnectParams, Endpoint, HostKeyInfo, JumpHop, PtySize, SshEvent, SshRuntime,
    SshSession,
};
pub use ssh_config::ImportedHost;
pub use store::{ImportSummary, Store, TERM_FONT_DEFAULT, TERM_FONT_MAX, TERM_FONT_MIN};
pub use sync::{SyncOutcome, SyncStatus};
pub use teaching::{TeachingCard, Topic};
pub use tunnel::{TunnelEvent, TunnelKind, TunnelSession, TunnelSpec};
pub use uptime::{check_once, UptimeEvent, UptimeService};
pub use uptime_log::{CheckResult, DayStat, MonitorHistory, MonitorState, UptimeLog};
pub use vault::crypto::{self, CryptoError, Header, OpenKey, SealKey, VaultCipher, WrapMethod};
pub use vault::keystore::{KeyStore, KeyringStore, MemoryKeyStore};
pub use vault::recovery::{generate_phrase, normalize_phrase};
pub use vault::Vault;
