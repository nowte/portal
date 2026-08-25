//! Basit fuzzy (bulanık) eşleştirme — bağlantı araması için.
//!
//! Domain mantığı olduğu için çekirdekte durur; TUI ve (ileride) GUI aynı
//! eşleştirmeyi kullanır — kod tekrarı yok.

/// `query`, `text` içinde (harf sırasını koruyan) bir alt-dizi olarak geçiyorsa
/// `Some(score)` döner; yüksek skor = daha iyi eşleşme (bitişik ve erken).
///
/// Karşılaştırma büyük/küçük harf duyarsızdır. Boş `query` her zaman eşleşir.
#[must_use]
pub fn score(query: &str, text: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }

    let needle: Vec<char> = query.to_lowercase().chars().collect();
    let haystack: Vec<char> = text.to_lowercase().chars().collect();

    let mut n = 0usize;
    let mut points: i64 = 0;
    let mut last_match: Option<usize> = None;

    for (i, &ch) in haystack.iter().enumerate() {
        if n < needle.len() && ch == needle[n] {
            match last_match {
                Some(prev) => {
                    let gap = i - prev - 1;
                    points -= gap as i64; // boşlukları cezalandır
                    if gap == 0 {
                        points += 3; // bitişik eşleşme ödülü
                    }
                }
                None => {
                    points -= i as i64; // geç başlamayı cezalandır
                }
            }
            last_match = Some(i);
            n += 1;
        }
    }

    if n == needle.len() {
        Some(points)
    } else {
        None
    }
}

/// `query` verilen metinlerden herhangi birine uyuyorsa en iyi skoru döner.
/// Birden çok alanı (ad, adres, kullanıcı, etiket) tek aramada denemek için.
#[must_use]
pub fn best_score<'a>(query: &str, texts: impl IntoIterator<Item = &'a str>) -> Option<i64> {
    texts.into_iter().filter_map(|t| score(query, t)).max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_matches_everything() {
        assert_eq!(score("", "anything"), Some(0));
    }

    #[test]
    fn subsequence_matches_case_insensitively() {
        assert!(score("wb", "web-01").is_some());
        assert!(score("WEB", "web-01").is_some());
        assert!(score("db", "db-01").is_some());
    }

    #[test]
    fn non_subsequence_does_not_match() {
        assert!(score("xyz", "web-01").is_none());
        assert!(score("bw", "web-01").is_none()); // sıra önemli
    }

    #[test]
    fn contiguous_beats_scattered() {
        let contiguous = score("web", "web-01").unwrap();
        let scattered = score("web", "w-e-b").unwrap();
        assert!(contiguous > scattered, "{contiguous} > {scattered}");
    }

    #[test]
    fn earlier_match_beats_later() {
        let early = score("api", "api-02").unwrap();
        let late = score("api", "my-api").unwrap();
        assert!(early > late, "{early} > {late}");
    }

    #[test]
    fn best_score_picks_matching_field() {
        // Ada uymuyor ama adrese uyuyor.
        let s = best_score("203", ["web-01", "203.0.113.10", "alex"]);
        assert!(s.is_some());
        assert!(best_score("zzz", ["web-01", "203.0.113.10"]).is_none());
    }
}
