//! `~/.ssh/config` içe aktarma — saf parser (docs/ROADMAP.md İleri SSH:
//! "~/.ssh/config içe aktarma: mevcut kurulumu taşımak").
//!
//! Kullanıcının OpenSSH `config` dosyasını okuyup her `Host` bloğunu bir
//! [`ImportedHost`]'a çevirir. **I/O yalnızca [`read_from`]**'da; [`parse`] tamamen
//! saftır ve test edilebilir. Domain'e dönüştürme (Host/Identity) [`crate::Store`]'da.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// OpenSSH `config`'ten okunan tek bir host tanımı (henüz domain'e çevrilmemiş).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedHost {
    /// `Host` bloğunun (joker olmayan ilk) takma adı — Portal etiketi olur.
    pub alias: String,
    /// `HostName` (gerçek adres). Yoksa adres = alias.
    pub host_name: Option<String>,
    /// `User`.
    pub user: Option<String>,
    /// `Port`.
    pub port: Option<u16>,
    /// `IdentityFile` (ilk görülen). Bir Key kimliği olur.
    pub identity_file: Option<PathBuf>,
    /// `ProxyJump` — şimdilik yalnızca saklanır (jump host = P5e).
    pub proxy_jump: Option<String>,
}

impl ImportedHost {
    fn new(alias: &str) -> Self {
        Self {
            alias: alias.to_string(),
            host_name: None,
            user: None,
            port: None,
            identity_file: None,
            proxy_jump: None,
        }
    }

    /// Bağlanılacak adres: `HostName` varsa o, yoksa alias.
    #[must_use]
    pub fn address(&self) -> &str {
        self.host_name.as_deref().unwrap_or(&self.alias)
    }
}

/// Portal'ın okuyacağı varsayılan `~/.ssh/config` yolu (home çözülemezse `None`).
#[must_use]
pub fn default_config_path() -> Option<PathBuf> {
    let resolved = crate::ssh::expand_home(Path::new("~/.ssh/config"));
    // expand_home, home yoksa "~/..."ı aynen döndürür → o durumda yol yok say.
    if resolved.starts_with("~") {
        None
    } else {
        Some(resolved)
    }
}

/// Bir `config` dosyasını okuyup ayrıştırır.
///
/// # Errors
/// Dosya okunamazsa hata döner.
pub fn read_from(path: &Path) -> Result<Vec<ImportedHost>> {
    let text = std::fs::read_to_string(path).map_err(|e| Error::io(path, e))?;
    Ok(parse(&text))
}

/// `config` metnini ayrıştırır (saf). Yalnızca joker olmayan `Host` blokları döner
/// (ör. `Host *` gibi varsayılan blokları atlar).
#[must_use]
pub fn parse(text: &str) -> Vec<ImportedHost> {
    let mut hosts = Vec::new();
    // `None` = joker-yalnızca blok içindeyiz (yoksay) ya da henüz blok yok.
    let mut current: Option<ImportedHost> = None;

    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = split_directive(line);
        if key.eq_ignore_ascii_case("host") {
            if let Some(done) = current.take() {
                hosts.push(done);
            }
            // İlk joker olmayan pattern'i alias yap; hepsi jokerse bloğu atla.
            current = value
                .split_whitespace()
                .find(|p| !is_pattern(p))
                .map(ImportedHost::new);
        } else if let Some(host) = current.as_mut() {
            apply_directive(host, &key.to_ascii_lowercase(), value);
        }
    }
    if let Some(done) = current.take() {
        hosts.push(done);
    }
    hosts
}

/// Bir direktifi (HostName/User/Port/IdentityFile/ProxyJump) host'a uygular.
fn apply_directive(host: &mut ImportedHost, key_lc: &str, value: &str) {
    match key_lc {
        "hostname" => host.host_name = Some(unquote(value)),
        "user" => host.user = Some(unquote(value)),
        "port" => host.port = value.parse().ok(),
        "identityfile" => {
            if host.identity_file.is_none() {
                host.identity_file = Some(PathBuf::from(unquote(value)));
            }
        }
        "proxyjump" => host.proxy_jump = Some(unquote(value)),
        _ => {} // diğer direktifleri yok say
    }
}

/// Satırı `#` yorumundan arındırır (basitleştirme: ilk `#`'ten keser).
fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
}

/// `Key Value` / `Key=Value` / `Key = Value` → (key, value).
fn split_directive(line: &str) -> (&str, &str) {
    match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(i) => {
            let key = &line[..i];
            let value = line[i..]
                .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                .trim();
            (key, value)
        }
        None => (line, ""),
    }
}

/// Değeri çevreleyen tırnakları soyar.
fn unquote(s: &str) -> String {
    let t = s.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Bir pattern joker/negasyon içeriyor mu (`*`, `?`, `!`) → somut host değil.
fn is_pattern(p: &str) -> bool {
    p.contains(['*', '?', '!'])
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# Örnek config
Host *
    ServerAliveInterval 60

Host web prod-web
    HostName 203.0.113.10
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host bastion
    HostName=bastion.example.com
    User admin

Host db
    # HostName yok → adres alias olur
    ProxyJump bastion
"#;

    #[test]
    fn parses_hosts_and_skips_wildcard_block() {
        let hosts = parse(SAMPLE);
        assert_eq!(hosts.len(), 3, "Host * atlanmalı: {hosts:?}");

        let web = &hosts[0];
        assert_eq!(web.alias, "web"); // ilk joker olmayan pattern
        assert_eq!(web.address(), "203.0.113.10");
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.port, Some(2222));
        assert_eq!(web.identity_file, Some(PathBuf::from("~/.ssh/id_ed25519")));

        let bastion = &hosts[1];
        assert_eq!(bastion.alias, "bastion");
        assert_eq!(bastion.address(), "bastion.example.com"); // Key=Value biçimi

        let db = &hosts[2];
        assert_eq!(db.alias, "db");
        assert_eq!(db.address(), "db"); // HostName yok → alias
        assert_eq!(db.proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn empty_or_commented_config_yields_nothing() {
        assert!(parse("").is_empty());
        assert!(parse("# just a comment\n\n   \n").is_empty());
        // Yalnızca joker blok → boş.
        assert!(parse("Host *\n  User x\n").is_empty());
    }

    #[test]
    fn directive_before_any_host_is_ignored() {
        // Bir Host bloğundan önce gelen direktifler yok sayılır (panik yok).
        let hosts = parse("HostName orphan\nUser nobody\nHost real\n HostName 10.0.0.1\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(hosts[0].address(), "10.0.0.1");
    }

    #[test]
    fn keywords_are_case_insensitive_and_quoted_values_unwrap() {
        let hosts = parse("HOST web\n  hostname \"10.0.0.9\"\n  USER \"al ex\"\n");
        assert_eq!(hosts[0].address(), "10.0.0.9");
        assert_eq!(hosts[0].user.as_deref(), Some("al ex"));
    }

    #[test]
    fn multiple_identity_files_keep_first() {
        let hosts = parse("Host web\n IdentityFile ~/.ssh/a\n IdentityFile ~/.ssh/b\n");
        assert_eq!(hosts[0].identity_file, Some(PathBuf::from("~/.ssh/a")));
    }
}
