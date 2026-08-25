// Bağlanma-anı kimlik diyaloğu (promise tabanlı). Sır (şifre/passphrase) yalnız
// bu çağrı için toplanır — asla diske yazılmaz (bkz. Rust cached_creds, bellek içi).
//
// requestAuth(host) → Promise<Auth | null>. null = kullanıcı iptal etti.

import { useEffect, useState } from "react";
import { Check, KeyRound, Lock, X } from "lucide-react";
import type { Auth, Host } from "../lib/types";
import { usePortal } from "../context";

let resolver: ((a: Auth | null) => void) | null = null;
let opener: ((host: Host) => void) | null = null;

/** Kimlik iste; diyalog kapanınca Auth (veya iptal için null) ile çözülür. */
export function requestAuth(host: Host): Promise<Auth | null> {
  return new Promise((resolve) => {
    // Bir diyalog zaten açıksa (resolver set) yenisini iptal say — çağıran yeniden
    // dener. Böylece eşzamanlı Connect/Files/Monitor promptu birbirini ezmez.
    if (!opener || resolver) {
      resolve(null);
      return;
    }
    resolver = resolve;
    opener(host);
  });
}

export function AuthDialog() {
  // Şifresiz (profilsiz) vault'ta sır saklanamaz — çekirdek reddeder. Anahtarı
  // göstermek yerine NEDENİNİ söyle: kullanıcı sessiz bir başarısızlıkla karşılaşmasın.
  const { canRemember } = usePortal();
  const [host, setHost] = useState<Host | null>(null);
  const [kind, setKind] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    opener = (h) => {
      setKind("password");
      setPassword("");
      setPath("");
      setPassphrase("");
      setRemember(false); // her diyalog kapalı başlar — sessizce saklamak yok
      setHost(h);
    };
    return () => {
      opener = null;
    };
  }, []);

  const finish = (a: Auth | null) => {
    setHost(null);
    const r = resolver;
    resolver = null;
    r?.(a);
  };

  useEffect(() => {
    if (!host) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  if (!host) return null;

  const submit = () => {
    const keep = remember && canRemember;
    if (kind === "password") finish({ kind: "password", password, remember: keep });
    else finish({ kind: "key", path, passphrase: passphrase || undefined, remember: keep });
  };

  const who = host.username ? `${host.username}@${host.address}` : host.address;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div className="dialog" role="dialog" aria-label="Connect">
        <div className="dlg-head">
          <span className="dlg-title">Connect to {host.label}</span>
          <button className="dlg-x" aria-label="Cancel" onClick={() => finish(null)}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="dlg-sub">{who}</div>

        <div className="dlg-body">
        <div className="seg">
          <button
            className={"seg-b" + (kind === "password" ? " on" : "")}
            onClick={() => setKind("password")}
          >
            <Lock size={16} strokeWidth={1.75} /> Password
          </button>
          <button
            className={"seg-b" + (kind === "key" ? " on" : "")}
            onClick={() => setKind("key")}
          >
            <KeyRound size={16} strokeWidth={1.75} /> Key file
          </button>
        </div>

        {kind === "password" ? (
          <label className="fld">
            <span className="fld-k">Password</span>
            <span className="fwrap">
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={
                  remember && canRemember
                    ? "Saved to your encrypted vault"
                    : "Never stored — asked each session"
                }
              />
            </span>
          </label>
        ) : (
          <>
            <label className="fld">
              <span className="fld-k">Private key path</span>
              <span className="fwrap">
                <input
                  autoFocus
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className="mono"
                />
              </span>
            </label>
            <label className="fld">
              <span className="fld-k">Passphrase (if any)</span>
              <span className="fwrap">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder={
                  remember && canRemember
                    ? "Saved to your encrypted vault (leave empty if none)"
                    : "Leave empty if the key has none"
                }
                />
              </span>
            </label>
          </>
        )}

        <button
          className={"hf-check lit" + (remember ? " on" : "")}
          onClick={() => canRemember && setRemember(!remember)}
          disabled={!canRemember}
          title={
            canRemember
              ? "Store this in your encrypted vault so Portal stops asking."
              : "Needs an encrypted vault — set up a profile password first."
          }
        >
          <span className="hf-box">
            <Check size={16} strokeWidth={3} />
          </span>
          <span>
            Remember for this server — <b>don&apos;t ask again</b>
          </span>
        </button>
        {!canRemember && (
          <div className="dlg-note">
            Portal can only remember credentials in an <b>encrypted</b> vault. This
            profile has no password, so the vault is plain text and secrets would sit
            unprotected on disk. Add a profile password in Settings ▸ Profiles first.
          </div>
        )}
        {remember && canRemember && (
          <div className="dlg-note">
            Kept in your encrypted vault, never in plain text. Anyone who can unlock that
            vault — or use this computer, if the vault opens without a password — can
            connect as you. Turn it off any time from the server&apos;s menu.
          </div>
        )}

        </div>

        <div className="dlg-foot">
          <button className="btn-ghost" onClick={() => finish(null)}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
