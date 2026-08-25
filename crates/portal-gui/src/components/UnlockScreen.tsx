// Başlangıç kilit-açma ekranı: parolalı aktif profil → store.unlock (Faz 3-C).
// Birden çok profil varsa aralarında geçiş yapılabilir (keyring profili sessizce açılır).
// Profilde kurtarma cümlesi varsa (hasRecovery) "parolamı unuttum" yolu açılır → recovery
// ile aç (parola kaybı = veri kaybı riskini kapatır, P6-D).
//
// Görsel: docs/mockups/re-desing/02-unlock.html.
// Mark markanın kendisidir (tek parça, CSS mask). Kilit durumu markın ÜZERİNDE
// değil, altındaki "Profile locked" satırında okunur; markın tek efekti glow:
// vault açılırken nefes alır, açılınca bir kez parlar.

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { usePortal } from "../context";
import * as ipc from "../lib/ipc";
import type { ProfileInfo } from "../lib/types";
import { ErrorNote } from "./ErrorNote";

export function UnlockScreen() {
  const { profile, hasRecovery, unlock, unlockWithRecovery, adoptBootstrap } = usePortal();
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);

  useEffect(() => {
    void ipc.listProfiles().then(setProfiles).catch(() => undefined);
  }, []);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setErr(null);
    try {
      await unlock(password);
      // Başarılıysa locked=false → App gate'i geçer, bu ekran unmount olur.
      setOpened(true);
    } catch (e) {
      setBusy(false);
      setPassword("");
      setErr(String(e));
    }
  };

  const submitRecovery = async () => {
    if (busy || !phrase.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await unlockWithRecovery(phrase);
      setOpened(true);
    } catch (e) {
      // Cümleyi silme — kullanıcı bir yazım hatasını düzeltsin.
      setBusy(false);
      setErr(String(e));
    }
  };

  const switchTo = async (id: string) => {
    setBusy(true);
    setErr(null);
    setPassword("");
    setPhrase("");
    setMode("password");
    try {
      adoptBootstrap(await ipc.switchProfile(id));
      // Hâlâ kilitliysek (yeni profil de parolalı) çip listesini tazele.
      setProfiles(await ipc.listProfiles());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const others = profiles.filter((p) => !p.active);
  const recoveryMode = mode === "recovery";
  const cardClass =
    "unlock-card lit" + (busy ? " busy" : "") + (opened ? " opened" : "") + (err ? " shake" : "");

  return (
    <div className="unlock">
      <div className={cardClass} role="dialog" aria-label="Unlock profile">
        {/* Gerçek marka varlığı (§24.2). Kilit durumu markın üzerinde değil,
            altındaki satırda okunur; markın tek efekti glow'dur. */}
        <span className="mark unlock-mark" aria-hidden="true" />

        <span className="unlock-lockrow">
          <Lock size={16} strokeWidth={1.75} />
          <span>Profile locked</span>
        </span>

        <h1 className="unlock-name">{profile ?? "Portal"}</h1>
        <p className="unlock-sub">
          {recoveryMode
            ? "Enter your recovery phrase to unlock this profile."
            : "Enter this profile's password to unlock your servers."}
        </p>

        {recoveryMode ? (
          <div className="unlock-pane">
            <label className="fld">
              <span className="fld-k">Recovery phrase</span>
              <span className={"fwrap tall" + (err ? " bad" : "")}>
                <textarea
                  autoFocus
                  value={phrase}
                  disabled={busy}
                  onChange={(e) => setPhrase(e.target.value)}
                  placeholder="The words you saved when you created this profile"
                  rows={3}
                />
              </span>
            </label>
            {err && (
              <ErrorNote>
                Couldn&apos;t unlock with that phrase.
                <span className="raw">{err}</span>
              </ErrorNote>
            )}
            <button
              className="btn-primary unlock-go"
              onClick={submitRecovery}
              disabled={busy || !phrase.trim()}
            >
              <span>{busy ? "Unlocking…" : "Unlock with recovery phrase"}</span>
            </button>
          </div>
        ) : (
          <div className="unlock-pane">
            <label className="fld">
              <span className="fld-k">Password</span>
              <span className={"fwrap" + (err ? " bad" : "")}>
                <input
                  type="password"
                  autoFocus
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="Never leaves this machine"
                />
              </span>
            </label>
            {err && (
              <ErrorNote>
                Couldn&apos;t unlock this profile.
                <span className="raw">{err}</span>
              </ErrorNote>
            )}
            <button className="btn-primary unlock-go" onClick={submit} disabled={busy || !password}>
              <span>{busy ? "Unlocking…" : "Unlock"}</span>
            </button>
          </div>
        )}

        {hasRecovery && (
          <button
            className="unlock-forgot"
            disabled={busy}
            onClick={() => {
              setErr(null);
              setMode(recoveryMode ? "password" : "recovery");
            }}
          >
            {recoveryMode ? "Use password instead" : "Forgot your password? Unlock with recovery phrase"}
          </button>
        )}

        {others.length > 0 && (
          <div className="unlock-others">
            <span className="unlock-others-k">Other profiles</span>
            <div className="unlock-chips">
              {others.map((p) => (
                <button
                  key={p.id}
                  className="unlock-chip lit"
                  disabled={busy}
                  onClick={() => switchTo(p.id)}
                  title={p.lockedWithPassword ? "Password-protected" : "Unlocks automatically"}
                >
                  {p.name}
                  {p.lockedWithPassword && <Lock size={16} strokeWidth={1.75} />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="unlock-foot">Your data stays on this machine · no account</div>
    </div>
  );
}
