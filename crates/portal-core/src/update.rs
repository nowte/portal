//! "Yeni bir sürüm var mı" kontrolü — GitHub Releases'e TEK bir GET.
//!
//! Bu telemetri DEĞİLDİR ve öyle kalmalı: istek hiçbir tanımlayıcı taşımaz —
//! sorgu parametresi yok, sabit User-Agent, hatta kurulu sürüm bile
//! gönderilmez. Karşılaştırma yerelde yapılır; github.com'un öğrendiği tek şey
//! isteğin geldiği IP'dir. Kullanıcı `config.toml → check_updates` ile kapatır.
//!
//! İNDİRME YOK. Yalnız "daha yeni bir etiket var mı" sorusu cevaplanır; indirme
//! ve kurma kullanıcının kendi adımıdır. Portal imzasız dağıtıldığı sürece
//! otomatik kurulum, her güncellemede bir SmartScreen uyarısı demek olurdu —
//! bu da hiç güncelleme sunmamaktan kötü.

use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};

/// GitHub'ın "son YAYINLANMIŞ sürüm" uç noktası. Taslak (draft) release'ler
/// buraya düşmez → yayınlanmamış bir sürüm kimseye önerilmez.
const LATEST_URL: &str = "https://api.github.com/repos/nowte/portal/releases/latest";

/// Kullanıcının elle gideceği sayfa; hata metninde geçer.
pub const RELEASES_PAGE: &str = "https://github.com/nowte/portal/releases/latest";

/// Yanıtın ilgilendiğimiz tek alanı.
#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
}

/// `v1.2.3` / `1.2` / `1.2.3-beta.1` → `(1, 2, 3)`. Ön-sürüm eki yok sayılır:
/// aynı üçlüde `-beta` "daha yeni" sayılmaz (`is_newer` katı `>` kullanır).
fn triple(tag: &str) -> Option<(u32, u32, u32)> {
    let core = tag.trim().trim_start_matches(['v', 'V']);
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// `latest` gerçekten `current`'tan yeni mi.
///
/// Biri ayrıştırılamıyorsa **false** döner: okunamayan bir etiket yüzünden
/// kullanıcıya var olmayan bir güncelleme gösterilmez.
#[must_use]
pub fn is_newer(current: &str, latest: &str) -> bool {
    match (triple(current), triple(latest)) {
        (Some(now), Some(new)) => new > now,
        _ => false,
    }
}

/// Daha yeni bir sürüm varsa etiketini döndürür (baştaki `v` kırpılmış hâlde);
/// güncel ise `None`.
///
/// # Errors
/// Ağa çıkılamazsa, GitHub hata döndürürse (ör. istek sınırı) veya yanıt
/// beklenen biçimde değilse hata döner.
pub fn check(current: &str) -> Result<Option<String>> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        // GitHub User-Agent'sız isteği reddeder. Sürüm numarası KOYMUYORUZ:
        // karşılaştırma yerelde, sunucunun kim olduğumuzu bilmesine gerek yok.
        .user_agent("Portal (+https://github.com/nowte/portal)")
        .build();
    let agent: ureq::Agent = config.into();

    let mut response = agent.get(LATEST_URL).call().map_err(|e| {
        Error::Update(format!(
            "Couldn't check for updates: {e}. Check your connection, or open {RELEASES_PAGE} in your browser."
        ))
    })?;
    let body = response.body_mut().read_to_string().map_err(|e| {
        Error::Update(format!(
            "Couldn't read GitHub's answer while checking for updates: {e}. Try again in a minute."
        ))
    })?;
    let latest: LatestRelease = serde_json::from_str(&body).map_err(|_| {
        Error::Update(format!(
            "GitHub answered with something Portal didn't understand. Open {RELEASES_PAGE} to check by hand."
        ))
    })?;

    let tag = latest
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    Ok(is_newer(current, &tag).then_some(tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_only_when_strictly_greater() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.0", "1.1.0"));
        assert!(is_newer("1.9.9", "2.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.1.0", "1.0.9"));
        // Sürüm 10, sürüm 9'dan yenidir — string karşılaştırması bunu kaçırırdı.
        assert!(is_newer("1.9.0", "1.10.0"));
    }

    #[test]
    fn tolerates_v_prefix_and_short_tags() {
        assert!(is_newer("1.0.0", "v1.0.1"));
        assert!(is_newer("v1.0.0", "1.1"));
        assert!(!is_newer("v2", "v1.9.9"));
    }

    #[test]
    fn prerelease_of_the_same_version_is_not_newer() {
        assert!(!is_newer("1.1.0", "1.1.0-beta.1"));
        assert!(is_newer("1.0.0", "1.1.0-beta.1"));
    }

    #[test]
    #[ignore = "github.com'a gerçek istek atar (elle çalıştır)"]
    fn talks_to_github() {
        // Yayınlanmış en yeni etiket 0.0.0'dan yenidir → Some döner.
        let found = check("0.0.0").expect("github.com'a ulaşılmalı");
        assert!(found.is_some(), "bir release etiketi okunmalı");
        // Ve çok ileri bir sürümden yeni değildir → None.
        assert_eq!(check("999.0.0").expect("ikinci istek de geçmeli"), None);
    }

    #[test]
    fn unreadable_tag_never_offers_an_update() {
        assert!(!is_newer("1.0.0", "nightly"));
        assert!(!is_newer("1.0.0", ""));
        assert!(!is_newer("unknown", "2.0.0"));
    }
}
