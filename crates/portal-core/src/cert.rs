//! HTTPS hedeflerinin TLS sertifikası: ne zaman bitiyor, kaç gün kaldı.
//!
//! Neden ayrı bir el sıkışma: [`ureq`] yanıt nesnesi üzerinden peer sertifikasını
//! vermiyor. Yeni bir HTTP kütüphanesi eklemek yerine TLS katmanına doğrudan
//! iniyoruz — `rustls` + `webpki-roots` zaten ureq'in ağacında derleniyor.
//!
//! Sertifika DOĞRULAMASI burada tekrar edilmez; bağlantı kurulamıyorsa (süresi
//! geçmiş/güvenilmeyen sertifika dahil) uptime kontrolünün kendisi zaten hata
//! döner ve kullanıcı sebebi orada görür. Buradaki iş yalnızca "daha bitmedi ama
//! bitmek üzere" durumunu önceden haber vermek.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};

/// Bu kadar gün kalınca kullanıcı uyarılır.
pub const CERT_WARN_DAYS: i64 = 30;
/// Bu kadar gün kalınca uyarı kritik olur (artık "yakında" değil, "hemen").
pub const CERT_CRIT_DAYS: i64 = 7;

/// Sertifikanın bitişine kalan gün; geçmişse negatif.
#[must_use]
pub fn days_left(expires_at: u64, now: u64) -> i64 {
    let secs = i64::try_from(expires_at).unwrap_or(i64::MAX) - i64::try_from(now).unwrap_or(0);
    secs.div_euclid(86_400)
}

/// Hedefin sertifikasının bitiş anı (unix saniye).
///
/// `None` döner: hedef https değilse, bağlantı/el sıkışma başarısızsa ya da
/// sertifika okunamıyorsa. Bu bir HATA DEĞİLDİR — kontrolün kendi sonucu ayrıdır,
/// burada yalnızca "ek bilgi yok" denir.
#[must_use]
pub fn expires_at(url: &str, timeout_secs: u32) -> Option<u64> {
    let (host, port) = https_host_port(url)?;
    let timeout = Duration::from_secs(u64::from(timeout_secs.max(1)));

    let addr = (host.as_str(), port).to_socket_addrs().ok()?.next()?;
    let mut sock = TcpStream::connect_timeout(&addr, timeout).ok()?;
    // Zaman aşımı yoksa cevapsız bir sunucu bu thread'i süresiz tutar.
    sock.set_read_timeout(Some(timeout)).ok()?;
    sock.set_write_timeout(Some(timeout)).ok()?;

    let server = ServerName::try_from(host).ok()?;
    let mut conn = ClientConnection::new(Arc::new(client_config()?), server).ok()?;
    conn.complete_io(&mut sock).ok()?;
    let expiry = not_after(conn.peer_certificates()?.first()?);

    // Sunucuyu yarım kalmış bir bağlantıyla bırakma.
    conn.send_close_notify();
    let _ = conn.complete_io(&mut sock);
    expiry
}

/// Yalnız el sıkışma için istemci ayarı (kök sertifikalar: webpki-roots).
fn client_config() -> Option<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Sağlayıcı AÇIKÇA seçilir: `builder()` süreç varsayılanı yoksa panikler.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Some(
        ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .ok()?
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// `https://host[:port]/...` → (host, port). https değilse `None`.
///
/// Host köşeli parantezsiz döner: hem [`ToSocketAddrs`] hem [`ServerName`] çıplak
/// IPv6 bekler.
fn https_host_port(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // Kullanıcı bilgisi (user:pass@host) varsa at.
    let authority = authority.rsplit('@').next()?;

    // IPv6 iki nokta doludur; port ancak "]" sonrasında olabilir.
    let (host, port) = if let Some(inside) = authority.strip_prefix('[') {
        let (host, tail) = inside.split_once(']')?;
        (host, tail.strip_prefix(':'))
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return None;
    }
    match port {
        Some(port) => Some((host.to_string(), port.parse().ok()?)),
        None => Some((host.to_string(), 443)),
    }
}

// ── DER (X.509) ──────────────────────────────────────────────────────────────
//
// Sertifikadan tek bir alan okunuyor (`validity.notAfter`), bu yüzden tam bir
// X.509 ayrıştırıcısı (x509-parser + nom + oid-registry) getirilmedi. Tavan:
// yalnız bu alan okunur; sertifikadan başka bir şey (issuer, SAN, imza) gerekirse
// gerçek bir ayrıştırıcıya geçilmeli.

/// Bir DER TLV'sini böler: (etiket, içerik, kalan).
fn tlv(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *bytes.first()?;
    let first_len = *bytes.get(1)?;
    let (len, header) = if first_len < 0x80 {
        (usize::from(first_len), 2)
    } else {
        // Uzun biçim: alt 7 bit = uzunluğun kaç bayt olduğu.
        let count = usize::from(first_len & 0x7f);
        if count == 0 || count > 4 {
            return None; // belirsiz uzunluk DER'de yok; 4 bayttan büyüğü de gerçekçi değil
        }
        let mut len = 0usize;
        for byte in bytes.get(2..2 + count)? {
            len = (len << 8) | usize::from(*byte);
        }
        (len, 2 + count)
    };
    let content = bytes.get(header..header + len)?;
    Some((tag, content, bytes.get(header + len..)?))
}

/// Sertifikanın `validity.notAfter` alanı (unix saniye).
///
/// Yol: Certificate → TBSCertificate → \[0\] version (opsiyonel) · serialNumber ·
/// signature · issuer · **validity** → notBefore · **notAfter**.
fn not_after(der: &[u8]) -> Option<u64> {
    let (_, certificate, _) = tlv(der)?;
    let (_, tbs, _) = tlv(certificate)?;

    let mut rest = tbs;
    // Sürüm alanı bağlam-etiketli ve opsiyoneldir (v1 sertifikalarda yok).
    let (tag, _, after_version) = tlv(rest)?;
    if tag == 0xa0 {
        rest = after_version;
    }
    // serialNumber · signature · issuer atlanır.
    for _ in 0..3 {
        let (_, _, after) = tlv(rest)?;
        rest = after;
    }

    let (tag, validity, _) = tlv(rest)?;
    if tag != 0x30 {
        return None;
    }
    let (_, _, after_not_before) = tlv(validity)?;
    let (tag, not_after, _) = tlv(after_not_before)?;
    asn1_time(tag, not_after)
}

/// ASN.1 UTCTime (`0x17`, "YYMMDDHHMMSSZ") / GeneralizedTime (`0x18`,
/// "YYYYMMDDHHMMSSZ") → unix saniye.
fn asn1_time(tag: u8, body: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(body).ok()?.strip_suffix('Z')?;
    let (year, rest) = match tag {
        0x17 => {
            let yy: i64 = num(text.get(..2)?)?;
            // RFC 5280: 50 ve üstü 19xx, altı 20xx.
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, text.get(2..)?)
        }
        0x18 => (num(text.get(..4)?)?, text.get(4..)?),
        _ => return None,
    };
    if rest.len() < 10 {
        return None;
    }
    let at = |a: usize, b: usize| num(rest.get(a..b)?);
    let secs = days_from_civil(year, at(0, 2)?, at(2, 4)?) * 86_400
        + at(4, 6)? * 3600
        + at(6, 8)? * 60
        + at(8, 10)?;
    u64::try_from(secs).ok()
}

/// Yalnız rakamlardan oluşan bir dilimi sayıya çevirir (boşluk/işaret kabul etmez).
fn num(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Takvim tarihinden epoch'a kalan gün sayısı (Howard Hinnant'ın `days_from_civil`'i).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted = (month + 9) % 12;
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DER TLV kurar (uzunluk kısa biçimde; testteki parçalar küçük).
    fn der(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        if content.len() < 0x80 {
            out.push(content.len() as u8);
        } else {
            out.push(0x82);
            out.push((content.len() >> 8) as u8);
            out.push(content.len() as u8);
        }
        out.extend_from_slice(content);
        out
    }

    /// Gerçek bir sertifikanın iskeleti: yalnız yürünen alanlar doludur.
    fn fake_cert(version: bool, not_after: &[u8]) -> Vec<u8> {
        let validity = der(
            0x30,
            &[der(0x17, b"240101000000Z"), not_after.to_vec()].concat(),
        );
        let mut tbs = Vec::new();
        if version {
            tbs.extend(der(0xa0, &der(0x02, &[2])));
        }
        tbs.extend(der(0x02, &[0x01, 0x02, 0x03])); // serialNumber
        tbs.extend(der(0x30, &[0x06, 0x01, 0x2a])); // signature
        tbs.extend(der(0x30, &[0x31; 200])); // issuer (uzun biçim uzunluk)
        tbs.extend(validity);
        tbs.extend(der(0x30, &[0x31, 0x00])); // subject
        der(0x30, &der(0x30, &tbs))
    }

    #[test]
    fn reads_not_after_from_certificate() {
        // 2026-08-26 12:00:00Z = 1787745600
        let cert = fake_cert(true, &der(0x17, b"260826120000Z"));
        assert_eq!(not_after(&cert), Some(1_787_745_600));
    }

    #[test]
    fn handles_v1_certificate_and_generalized_time() {
        // v1'de sürüm alanı yok; 2050 sonrası GeneralizedTime ile yazılır.
        let cert = fake_cert(false, &der(0x18, b"20500101000000Z"));
        assert_eq!(not_after(&cert), Some(2_524_608_000));
    }

    #[test]
    fn rejects_garbage_instead_of_guessing() {
        assert_eq!(not_after(b""), None);
        assert_eq!(not_after(&[0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x01]), None);
        // Uzunluk baytı gövdeden büyük: taşma değil, None.
        assert_eq!(tlv(&[0x30, 0x40, 0x01]), None);
    }

    #[test]
    fn utc_year_window_follows_rfc5280() {
        // 49 → 2049, 50 → 1950.
        assert_eq!(asn1_time(0x17, b"490101000000Z"), Some(2_493_072_000));
        assert_eq!(asn1_time(0x17, b"500101000000Z"), None); // 1950 epoch öncesi
        assert_eq!(asn1_time(0x17, b"7001010000 0Z"), None); // rakam olmayan alan
    }

    #[test]
    #[ignore = "gerçek bir https sunucusuyla el sıkışır (elle çalıştır)"]
    fn reads_a_live_certificate() {
        let at = expires_at("https://example.com", 10);
        let at = at.expect("canlı sertifika okunmalı");
        let days = days_left(at, crate::uptime_log::now_unix());
        // Üst sınır: public CA'ler 398 günden uzun sertifika vermiyor. Sınırın
        // dışındaki bir değer okuma hatasıdır, uzun ömürlü sertifika değil.
        assert!(
            (1..=398).contains(&days),
            "canlı sertifikanın kalan günü makul olmalı: {days}"
        );
    }

    #[test]
    fn days_left_counts_down_and_goes_negative() {
        let now = 1_787_832_000;
        assert_eq!(days_left(now + 10 * 86_400, now), 10);
        assert_eq!(days_left(now, now), 0);
        assert_eq!(days_left(now - 86_400, now), -1);
    }

    #[test]
    fn host_port_split_covers_the_forms() {
        assert_eq!(
            https_host_port("https://example.com/health?x=1"),
            Some(("example.com".to_string(), 443))
        );
        assert_eq!(
            https_host_port("https://example.com:8443"),
            Some(("example.com".to_string(), 8443))
        );
        assert_eq!(
            https_host_port("https://[::1]/"),
            Some(("::1".to_string(), 443))
        );
        assert_eq!(
            https_host_port("https://[::1]:8443/x"),
            Some(("::1".to_string(), 8443))
        );
        assert_eq!(https_host_port("http://example.com"), None);
        assert_eq!(https_host_port("https://example.com:port"), None);
    }
}
