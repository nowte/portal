// İlk-çalıştırma sihirbazı: Welcome → Theme → Profile → [Recovery] → Ready (DESIGN §9,
// mockup: portal-onboarding.jsx — monokroma çevrildi). Tema anında önizlenir. Parola
// belirlenirse araya bir Recovery adımı girer: bir kez üretilen kurtarma cümlesi gösterilir
// ve kullanıcı kaydettiğini onaylar; son adımda complete_onboarding'e geri verilir (parola
// unutulursa tek dönüş yolu). Bkz. context.completeOnboarding + lib/ipc.generateRecoveryPhrase.

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, KeyRound } from "lucide-react";
import { usePortal } from "../context";
import * as ipc from "../lib/ipc";
import { applyTheme, THEME_OPTIONS } from "../lib/theme";

function Dots({ step, count }: { step: number; count: number }) {
  return (
    <div className="ob-dots" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={"ob-dot" + (i === step ? " on" : "") + (i < step ? " done" : "")}
        />
      ))}
    </div>
  );
}

export function Onboarding() {
  const { theme, completeOnboarding } = usePortal();
  const [step, setStep] = useState(0);
  const [pick, setPick] = useState(theme);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Kurtarma cümlesi: recovery adımına ilk girişte bir kez üretilir.
  const [recovery, setRecovery] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [copied, setCopied] = useState(false);

  // Seçilen tema anında önizlenir (tüm ekran token'ları döner).
  useEffect(() => {
    applyTheme(pick);
  }, [pick]);

  // Parola belirlendiyse akışta bir Recovery adımı vardır; aksi halde yok.
  const withPassword = pw.length > 0;
  const flow = withPassword
    ? (["welcome", "theme", "profile", "recovery", "ready"] as const)
    : (["welcome", "theme", "profile", "ready"] as const);
  const stepIdx = Math.min(step, flow.length - 1);
  const current = flow[stepIdx];

  const next = () => setStep((s) => Math.min(flow.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const pwMismatch = pw.length > 0 && pw2.length > 0 && pw !== pw2;
  const canCreate = name.trim().length > 0 && (pw.length === 0 || pw === pw2);

  // Recovery adımına girince cümleyi bir kez üret (durum değiştirmeyen saf çağrı).
  useEffect(() => {
    if (current === "recovery" && recovery === null) {
      ipc
        .generateRecoveryPhrase()
        .then(setRecovery)
        .catch((e) => setErr(String(e)));
    }
  }, [current, recovery]);

  // Profili taşımadan (sırrı state'te tutup) ilerlet; kalıcılaşma son adımda.
  const goProfile = (withProfile: boolean) => {
    if (!withProfile) {
      setName("");
      setPw("");
      setPw2("");
    }
    next();
  };

  const copyPhrase = async () => {
    if (!recovery) return;
    try {
      await navigator.clipboard?.writeText(recovery);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Pano yoksa sessiz geç — kullanıcı elle yazabilir.
    }
  };

  const finish = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Kurtarma cümlesi yalnız parola profili için gönderilir.
      const phrase = withPassword ? recovery ?? undefined : undefined;
      await completeOnboarding(
        pick,
        name.trim() || undefined,
        pw.length > 0 ? pw : undefined,
        phrase,
      );
      // Başarılıysa onboarded=true → bu bileşen unmount olur (App gate'i geçer).
    } catch (e) {
      setBusy(false);
      setErr(String(e));
    }
  };

  const summary = useMemo(() => {
    if (name.trim() && pw)
      return `Profile "${name.trim()}" — locked with a password, recovery phrase saved.`;
    if (name.trim()) return `Profile "${name.trim()}" — encrypted with a key on this machine.`;
    return "No profile — you can add one later in Settings.";
  }, [name, pw]);

  return (
    <div className="ob">
      <div className="ob-card" role="dialog" aria-label="Welcome to Portal">
        <Dots step={stepIdx} count={flow.length} />

        {current === "welcome" && (
          <div className="ob-step ob-center">
            <div className="mark ob-hero" role="img" aria-label="Portal" />
            <div className="ob-word">portal</div>
            <p className="ob-lead">
              Your servers, one calm door. Connect, browse files and watch their health —
              no cloud account, nothing leaves this machine.
            </p>
            <div className="ob-actions ob-actions-center">
              <button className="btn-primary" onClick={next}>
                Get started <ArrowRight size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}

        {current === "theme" && (
          <div className="ob-step">
            <h2 className="ob-h">Pick a theme</h2>
            <p className="ob-sub">You can change this any time in Settings.</p>
            <div className="ob-themes">
              {THEME_OPTIONS.map((th) => (
                <button
                  key={th.id}
                  className={"ob-theme" + (pick === th.id ? " on" : "")}
                  onClick={() => setPick(th.id)}
                >
                  <span className="ob-swatch">
                    <span style={{ background: th.b }} />
                    <span style={{ background: th.a }} />
                  </span>
                  <span className="ob-theme-main">
                    <span className="ob-theme-name">{th.name}</span>
                    <span className="ob-theme-sub">{th.sub}</span>
                  </span>
                  <Check className="ob-theme-check" size={16} strokeWidth={2} />
                </button>
              ))}
            </div>
            <div className="ob-actions">
              <button className="btn-ghost" onClick={back}>
                Back
              </button>
              <button className="btn-primary" onClick={next}>
                Continue <ArrowRight size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}

        {current === "profile" && (
          <div className="ob-step">
            <h2 className="ob-h">Create a local profile</h2>
            <p className="ob-sub">
              A profile keeps your servers together and encrypts them on this computer. It's a
              profile, not an account — no sign-up, no server, nothing leaves your machine.
            </p>
            <label className="fld">
              <span className="fld-k">Profile name</span>
              <span className="fwrap">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. work, personal"
                />
              </span>
            </label>
            <label className="fld">
              <span className="fld-k">Password (optional)</span>
              <span className="fwrap">
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="Leave empty to unlock automatically on this machine"
                />
              </span>
            </label>
            {pw.length > 0 && (
              <label className="fld">
                <span className="fld-k">Confirm password</span>
                <span className={"fwrap" + (pwMismatch ? " bad" : "")}>
                  <input
                    type="password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && canCreate && goProfile(true)}
                    placeholder="Type it again"
                  />
                </span>
              </label>
            )}
            {pwMismatch && (
              <div className="ob-warn">
                <span className="mk" />
                <span>Passwords don&apos;t match yet.</span>
              </div>
            )}
            <p className="ob-note">
              No password? Your profile is still encrypted with a key kept on this machine.
            </p>
            <div className="ob-actions ob-actions-split">
              <button className="ob-skip" onClick={() => goProfile(false)}>
                Skip for now
              </button>
              <div className="ob-actions-right">
                <button className="btn-ghost" onClick={back}>
                  Back
                </button>
                <button
                  className="btn-primary"
                  disabled={!canCreate}
                  onClick={() => goProfile(true)}
                >
                  Continue <ArrowRight size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
          </div>
        )}

        {current === "recovery" && (
          <div className="ob-step">
            <div className="ob-reco-badge">
              <KeyRound size={20} strokeWidth={2} />
            </div>
            <h2 className="ob-h">Save your recovery phrase</h2>
            <p className="ob-sub">
              If you ever forget your password, these words are the only way back into this
              profile. Write them down and keep them somewhere safe — they're never stored on this
              machine and we can't recover them for you.
            </p>

            {recovery ? (
              <ol className="ob-phrase">
                {recovery.split(" ").map((w, i) => (
                  <li key={`${i}-${w}`}>
                    <span className="ob-phrase-n">{i + 1}</span>
                    <span className="ob-phrase-w">{w}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="ob-phrase-loading">
                <span className="st" />
                Generating…
              </div>
            )}

            <div className="ob-reco-tools">
              <button className="btn-ghost" onClick={copyPhrase} disabled={!recovery}>
                {copied ? (
                  <>
                    <Check size={16} strokeWidth={2} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={16} strokeWidth={2} /> Copy
                  </>
                )}
              </button>
            </div>

            <label className={"ob-check" + (recoverySaved ? " on" : "")}>
              <input
                type="checkbox"
                checked={recoverySaved}
                onChange={(e) => setRecoverySaved(e.target.checked)}
              />
              <span className="ob-box">
                <Check size={16} strokeWidth={3} />
              </span>
              <span>I&apos;ve written down my recovery phrase and stored it safely.</span>
            </label>
            {err && <div className="ob-err">{err}</div>}

            <div className="ob-actions">
              <button className="btn-ghost" onClick={back}>
                Back
              </button>
              <button
                className="btn-primary"
                disabled={!recovery || !recoverySaved}
                onClick={next}
              >
                Continue <ArrowRight size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}

        {current === "ready" && (
          <div className="ob-step ob-center">
            <div className="ob-ready-mark">
              <Check size={20} strokeWidth={3} />
            </div>
            <h2 className="ob-h">You're all set</h2>
            <p className="ob-lead">{summary}</p>
            {err && <div className="ob-err">{err}</div>}
            <div className="ob-actions ob-actions-center">
              <button className="btn-ghost" onClick={back} disabled={busy}>
                Back
              </button>
              <button className="btn-primary" onClick={finish} disabled={busy}>
                {busy ? "Setting up…" : "Enter Portal"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="ob-foot">Your data stays on this machine · no account</div>
    </div>
  );
}
