//! Öğretme Katmanı içeriği (yüzeyden bağımsız).
//!
//! Portal ileri SSH sistemlerini **saklamaz** — koyar, ama bilmeyene **öğretir**.
//! Her ileri alanın yanında "What is this? / Why might I want this?" gösterilir.
//! İçerik burada **tek yerde** durur; TUI (ve ileride GUI) aynı metni paylaşır —
//! kod tekrarı yok. Render yüzeye özgüdür (`portal-tui`).
//!
//! Metin İngilizce (kullanıcıya dönük), **abartısız ve dürüst** (docs/ROADMAP.md
//! Teaching Layer; risk listesi: "öğretme metinleri yanıltıcı olmasın").

/// Bir ileri özelliğin öğretme kartı — düz-dilli açıklama + tek-cümle senaryo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeachingCard {
    /// Kısa başlık, ör. "SSH key".
    pub title: &'static str,
    /// "What is this?" — 2-3 cümle, düz dil.
    pub what: &'static str,
    /// "Why might I want this?" — tek cümle senaryo.
    pub why: &'static str,
}

/// Öğretme katmanının kapsadığı ileri konular. Her ileri form ilgili konuyu gösterir.
///
/// Yeni ileri özellikler (tünel, jump host, agent forwarding, ~/.ssh/config içe
/// aktarma, multiplexing) eklendikçe buraya yeni varyantlar eklenir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Topic {
    /// SSH anahtar çifti (public/private).
    SshKey,
    /// Anahtar passphrase'i.
    Passphrase,
    /// ssh-agent.
    Agent,
    /// `~/.ssh/config` içe aktarma.
    SshConfigImport,
    /// Port yönlendirme / tünel.
    Tunnel,
    /// Jump host / ProxyJump.
    JumpHost,
    /// Agent forwarding.
    AgentForwarding,
    /// Bağlantı çoğullama (ControlMaster).
    Multiplexing,
    /// Kayıtlı host anahtarının değişmesi (olası MITM uyarısı).
    HostKeyChanged,
}

impl Topic {
    /// Bu konunun öğretme kartı.
    #[must_use]
    pub fn card(self) -> TeachingCard {
        match self {
            Topic::SshKey => TeachingCard {
                title: "SSH key",
                what: "An SSH key is a pair of files: a private key you keep secret, and a public key you put on the server. Together they prove who you are without sending a password. Ed25519 is a modern, fast, safe default.",
                why: "Log in without typing a password every time — and it's far harder to guess than one.",
            },
            Topic::Passphrase => TeachingCard {
                title: "Passphrase",
                what: "A passphrase encrypts the private key file itself, so a stolen key is useless without it. You type it when the key is first used, not on every connection — an agent can remember it for the session.",
                why: "Protect the key if your laptop or a backup is ever lost or stolen.",
            },
            Topic::Agent => TeachingCard {
                title: "SSH agent",
                what: "The SSH agent is a small background program that holds your unlocked keys in memory. Add a key once and it handles authentication for you, so you don't re-enter the passphrase each time.",
                why: "Type your passphrase once per session instead of on every connection.",
            },
            Topic::SshConfigImport => TeachingCard {
                title: "SSH config import",
                what: "Your ~/.ssh/config file lists servers you've already set up for the ssh command — their names, addresses, users, and keys. Portal can read it and add those servers for you.",
                why: "Bring your existing SSH setup into Portal in one step, without retyping it.",
            },
            Topic::Tunnel => TeachingCard {
                title: "Port tunnel",
                what: "A tunnel securely carries a network port through your SSH connection. A local tunnel maps a port on your computer to one on the server, so localhost:5432 on your machine reaches the database on the server. Dynamic mode runs a SOCKS proxy to route many apps through the server.",
                why: "Reach a private service (a database, an admin panel) that only listens on the server.",
            },
            Topic::JumpHost => TeachingCard {
                title: "Jump host",
                what: "A jump host (or bastion) is a server you connect through to reach another one. Portal logs in to the jump host first, then opens the connection to your real target from there — all in one step. The target never has to be exposed to the internet.",
                why: "Reach a private server that only accepts connections from inside its network.",
            },
            Topic::AgentForwarding => TeachingCard {
                title: "Agent forwarding",
                what: "Agent forwarding lets the server you're on use the keys in your local SSH agent to authenticate onward — without ever copying the private key to the server. Only turn it on for servers you trust, since they can use your agent while you're connected.",
                why: "Hop from one server to the next using your own keys, without leaving copies behind.",
            },
            Topic::Multiplexing => TeachingCard {
                title: "Connection multiplexing",
                what: "Multiplexing reuses a single SSH connection for extra sessions to the same server, instead of authenticating again each time. New shells, file browsers, and tunnels open almost instantly over the existing link.",
                why: "Open a second session to a server without waiting to log in again.",
            },
            Topic::HostKeyChanged => TeachingCard {
                title: "Host key changed",
                what: "This server's key is different from the one Portal trusted before. That can happen if the server was rebuilt or its SSH was reinstalled — but it can also mean someone is intercepting the connection. Portal won't connect until you've verified it's really the same server.",
                why: "Stop and check before trusting a server whose identity suddenly changed.",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Topic; 9] = [
        Topic::SshKey,
        Topic::Passphrase,
        Topic::Agent,
        Topic::SshConfigImport,
        Topic::Tunnel,
        Topic::JumpHost,
        Topic::AgentForwarding,
        Topic::Multiplexing,
        Topic::HostKeyChanged,
    ];

    #[test]
    fn every_topic_has_nonempty_honest_content() {
        for topic in ALL {
            let c = topic.card();
            assert!(!c.title.is_empty(), "{topic:?} title boş");
            // "What" gerçek bir açıklama olmalı (başlıktan uzun).
            assert!(c.what.len() > c.title.len(), "{topic:?} what çok kısa");
            assert!(!c.why.is_empty(), "{topic:?} why boş");
            // Senaryo tek cümle: aşırı uzun olmamalı.
            assert!(c.why.len() < 160, "{topic:?} why tek cümleyi aşıyor");
        }
    }

    #[test]
    fn cards_are_distinct() {
        assert_ne!(Topic::SshKey.card(), Topic::Passphrase.card());
        assert_ne!(Topic::Passphrase.card(), Topic::Agent.card());
    }
}
