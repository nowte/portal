// Bağlanma-anı kimlik diyaloğu (promise tabanlı). Sır (şifre/passphrase) yalnız
// bu çağrı için toplanır — asla diske yazılmaz (bkz. Rust cached_creds, bellek içi).
//
// requestAuth(host) → Promise<Auth | null>. null = kullanıcı iptal etti.

import { useEffect, useState } from "react";
import { KeyRound, Lock, X } from "lucide-react";
import type { Auth, Host } from "../lib/types";

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
  const [host, setHost] = useState<Host | null>(null);
  const [kind, setKind] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");

  useEffect(() => {
    opener = (h) => {
      setKind("password");
      setPassword("");
      setPath("");
      setPassphrase("");
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
    if (kind === "password") finish({ kind: "password", password });
    else finish({ kind: "key", path, passphrase: passphrase || undefined });
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
                placeholder="Never stored — asked each session"
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
                  placeholder="Leave empty if the key has none"
                />
              </span>
            </label>
          </>
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
