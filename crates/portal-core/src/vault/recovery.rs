//! Kurtarma cümlesi (recovery phrase) üretimi ve normalizasyonu.
//!
//! Parola kaybı = veri kaybı riskini kapatmak için, şifreli bir profil kurulurken
//! kullanıcıya bir kez gösterilen bir kelime öbeği üretilir. Bu öbek
//! [`crate::vault::crypto::SealKey::Recovery`] ile bir KEK'e (Argon2id) türetilerek
//! vault'a ikinci bir açma yolu olarak sarılır (bkz. store `create_profile`).
//!
//! **Kendine yeten:** kelime listesi derlemeye gömülüdür (`include_str!`); ağ yok.
//! 263 benzersiz kelimeden 16 kelime seçilir → ~128 bit entropi; üstüne Argon2id.
//! Liste küçük olduğu için tek kelimenin entropisi ~8 bit; uzunlukla telafi edilir.

use rand::RngExt;
use zeroize::Zeroizing;

/// Bir kurtarma öbeğindeki kelime sayısı. 16 × log2(263) ≈ 128 bit.
const WORDS_PER_PHRASE: usize = 16;

/// Gömülü kelime listesi (satır başına bir kelime, küçük harf).
const WORDLIST_RAW: &str = include_str!("recovery_wordlist.txt");

/// Kelime listesini ayrıştırır (boş satırları atar). Ucuz; nadiren çağrılır.
fn words() -> Vec<&'static str> {
    WORDLIST_RAW
        .lines()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect()
}

/// Yeni bir kurtarma öbeği üretir (16 kelime, boşlukla ayrılmış, küçük harf).
///
/// CSPRNG olarak `rand::rng()` kullanılır (keys.rs ile aynı yol; ChaCha tabanlı,
/// OS'tan tohumlanır). Sonuç [`Zeroizing`] ile döner — kapsam dışına çıkınca sıfırlanır.
#[must_use]
pub fn generate_phrase() -> Zeroizing<String> {
    let words = words();
    // Liste sabit ve boş değil; yine de güvenli davran (boşsa boş öbek döner).
    if words.is_empty() {
        return Zeroizing::new(String::new());
    }
    let mut rng = rand::rng();
    let mut out = String::new();
    for i in 0..WORDS_PER_PHRASE {
        if i > 0 {
            out.push(' ');
        }
        let idx = rng.random_range(0..words.len());
        out.push_str(words[idx]);
    }
    Zeroizing::new(out)
}

/// Kullanıcının girdiği öbeği kanonik forma indirger: baş/son boşluk atılır, iç
/// boşluklar tekilleşir, küçük harfe çevrilir. Böylece elle yazımda tolerans olur.
///
/// **Aynı normalizasyon hem sarma hem açma anında uygulanır** — aksi halde
/// gösterilen ve girilen öbek bayt-bayt eşleşmezse KEK farklı çıkar.
#[must_use]
pub fn normalize_phrase(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn wordlist_is_sane() {
        let ws = words();
        // Entropi tabanı: en az 256 kelime (log2 ≥ 8) ve hepsi benzersiz.
        assert!(ws.len() >= 256, "wordlist too small: {}", ws.len());
        let unique: HashSet<_> = ws.iter().collect();
        assert_eq!(unique.len(), ws.len(), "wordlist has duplicates");
        // Hepsi küçük harf ASCII kelime.
        for w in &ws {
            assert!(w.chars().all(|c| c.is_ascii_lowercase()), "bad word: {w:?}");
        }
    }

    #[test]
    fn generated_phrase_has_expected_shape() {
        let phrase = generate_phrase();
        let parts: Vec<&str> = phrase.split(' ').collect();
        assert_eq!(parts.len(), WORDS_PER_PHRASE);
        let known: HashSet<&str> = words().into_iter().collect();
        for p in parts {
            assert!(known.contains(p), "unknown word in phrase: {p:?}");
        }
    }

    #[test]
    fn generated_phrase_is_already_normalized() {
        let phrase = generate_phrase();
        assert_eq!(normalize_phrase(&phrase), *phrase);
    }

    #[test]
    fn two_phrases_differ() {
        // Çakışma olasılığı ihmal edilebilir (~128 bit).
        assert_ne!(*generate_phrase(), *generate_phrase());
    }

    #[test]
    fn normalize_is_forgiving_and_idempotent() {
        let raw = "  Correct   Horse\tBattery \nStaple  ";
        let n = normalize_phrase(raw);
        assert_eq!(n, "correct horse battery staple");
        assert_eq!(normalize_phrase(&n), n, "normalize not idempotent");
    }
}
