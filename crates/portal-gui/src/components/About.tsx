// "About Portal" ve "Support" — ≡ menüden ve top bar'daki Docs/Support
// düğmelerinden açılır. İkisi de AYNI modal gövdesinden doğar (§4 primitive),
// yalnız içerikleri farklı.
//
// Neden dış bağlantı açmıyoruz: Portal'ın tezi çevrimdışı çalışmak. Adres metin
// olarak veriliyor + "Copy" düğmesi; kullanıcı kendi tarayıcısında açar. Uydurma
// URL yok — tek adres Cargo.toml'daki `repository` alanıdır. (P8'de gelen
// `open_external` terminalin bağlantıları içindir, burası ondan önce vardı ve
// kopyala-yapıştır kalıyor: adresi görmeden bir yere gitmiyorsun.)
//
// Modül-düzeyi köprü (prop-drilling'siz): openAbout("about" | "support").

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy, X } from "lucide-react";
import { usePortal } from "../context";
import { APP_VERSION } from "../lib/version";
import { useModal } from "../lib/modal";
import { SpinButton } from "./SpinButton";
import { checkNow, useUpdate } from "../lib/update";

export type AboutTab = "about" | "support";

let open: AboutTab | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openAbout(tab: AboutTab = "about"): void {
  open = tab;
  emit();
}
function close(): void {
  open = null;
  emit();
}

const REPO = "https://github.com/nowte/portal";
const RELEASES = `${REPO}/releases/latest`;

// Güncelleme satırı: durum + "Check now". Sürüm karşılaştırması Rust'ta, burada
// yalnız çizim. İndirme yok — yeni sürüm varsa alttaki Copy düğmesi releases
// adresini verir, kullanıcı kendi tarayıcısında indirir.
function UpdateLine() {
  const upd = useUpdate();
  return (
    <span className="about-upd">
      <span className={"about-upd-t" + (upd.status === "found" ? " lit" : "")}>
        {upd.status === "checking"
          ? "Checking…"
          : upd.status === "found"
            ? `Portal ${upd.version} is out — ${RELEASES}`
            : upd.status === "current"
              ? "Up to date"
              : upd.status === "error"
                ? upd.message
                : "Not checked"}
      </span>
      <SpinButton
        className="btn-ghost"
        title="Ask github.com whether a newer Portal has been released"
        disabled={upd.status === "checking"}
        onRun={() => void checkNow()}
      >
        {" "}
        Check now
      </SpinButton>
    </span>
  );
}

function CopyLink({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className="btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setDone(true));
      }}
    >
      {done ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.75} />}
      <span>{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function About() {
  const tab = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
    () => open,
  );
  const { boot } = usePortal();
  const upd = useUpdate();
  const boxRef = useRef<HTMLDivElement>(null);

  // Esc + odak tuzağı + odak iadesi: lib/modal.ts (tek kaynak).
  useModal(boxRef, close, tab !== null);

  if (!tab) return null;
  const support = tab === "support";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={support ? "Support" : "About Portal"}
      >
        <div className="dlg-head">
          <span className="dlg-title">{support ? "Support" : "About Portal"}</span>
          <button className="dlg-x" aria-label="Close" onClick={close}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="dlg-body">
          {support ? (
            <>
              <p className="about-lead">
                Portal runs entirely on this machine — there is no account and no support server to
                write to. Everything below is what actually exists today.
              </p>
              <div className="about-rows">
                <div className="about-row">
                  <span className="about-k">Report a bug</span>
                  <span className="about-v mono">{REPO}/issues</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Log file</span>
                  <span className="about-v mono">&lt;data dir&gt;/portal.log</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Vault</span>
                  <span className="about-v mono">&lt;data dir&gt;/vault.portal</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Known hosts</span>
                  <span className="about-v mono">&lt;data dir&gt;/known_hosts</span>
                </div>
              </div>
              <p className="about-note">
                When reporting a bug, the log file helps most. It never contains passwords or key
                material — those are held in memory only and zeroed when a session ends.
              </p>
            </>
          ) : (
            <>
              <p className="about-lead">
                A calm door to your servers. Connect over SSH, browse files and watch their health —
                no cloud account, nothing leaves this machine.
              </p>
              <div className="about-rows">
                <div className="about-row">
                  <span className="about-k">Version</span>
                  <span className="about-v mono">{APP_VERSION}</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Updates</span>
                  <span className="about-v">
                    <UpdateLine />
                  </span>
                </div>
                <div className="about-row">
                  <span className="about-k">Profile</span>
                  <span className="about-v mono">{boot?.profile ?? "local · no account"}</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Device</span>
                  <span className="about-v mono">{boot?.device_label ?? "—"}</span>
                </div>
                <div className="about-row">
                  <span className="about-k">Vault</span>
                  <span className="about-v mono">
                    {boot?.profile ? "encrypted · Argon2id + XChaCha20-Poly1305" : "not created yet"}
                  </span>
                </div>
                <div className="about-row">
                  <span className="about-k">Source</span>
                  <span className="about-v mono">{REPO}</span>
                </div>
              </div>
              <p className="about-note">
                Your servers, keys and saved commands are stored encrypted on this device. Passwords
                and key passphrases are never written to disk — they live in memory for the length
                of a session and are zeroed on close.
              </p>
            </>
          )}
        </div>

        <div className="dlg-foot">
          <CopyLink
            value={support ? `${REPO}/issues` : upd.status === "found" ? RELEASES : REPO}
          />
          <button className="btn-primary" onClick={close}>
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}
