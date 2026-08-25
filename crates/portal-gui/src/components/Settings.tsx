// Ayarlar modalı (Faz 3-C): Appearance (tema) · Profiles (liste/geçiş/kilit) ·
// Sync (BYOS klasör + son-yazan-kazanır durum). Icon bar Settings/Profile açar.
//
// Modül-düzeyi köprü (prop-drilling'siz): openSettings(tab?).

import { useCallback, useEffect, useState } from "react";
import { Check, FolderSync, Lock, UserRound, X } from "lucide-react";
import { usePortal } from "../context";
import * as ipc from "../lib/ipc";
import type { ProfileInfo, SyncInfo } from "../lib/types";
import { THEME_OPTIONS } from "../lib/theme";
import { SpinButton } from "./SpinButton";

type Tab = "appearance" | "profiles" | "sync";

let externalOpen: ((tab: Tab) => void) | null = null;
export function openSettings(tab: Tab = "appearance"): void {
  externalOpen?.(tab);
}

function whenText(ms: number | null, device: string | null): string {
  if (ms == null) return "—";
  const when = new Date(ms).toLocaleString();
  return device ? `${when} · ${device}` : when;
}

export function Settings() {
  const { theme, changeTheme, boot, adoptBootstrap, refresh } = usePortal();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("appearance");

  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Tepsiye inme ayarı bootstrap'tan gelir; toggle sonrası yerelde de tutulur ki
  // kutucuk anında dolsun (bootstrap tazelemesini beklemeden).
  const [tray, setTray] = useState(false);

  const loadProfiles = useCallback(() => {
    void ipc.listProfiles().then(setProfiles).catch(() => undefined);
  }, []);
  const loadSync = useCallback(() => {
    void ipc.syncGet().then((s) => {
      setSync(s);
      setDirInput(s.dir ?? "");
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    externalOpen = (t) => {
      setTab(t);
      setNote(null);
      setOpen(true);
    };
    return () => {
      externalOpen = null;
    };
  }, []);

  const toggleTray = useCallback(async (): Promise<void> => {
    const next = !tray;
    setTray(next);
    try {
      await ipc.setMinimizeToTray(next);
    } catch {
      setTray(!next); // yazılamadıysa kutucuk gerçeği göstersin
    }
  }, [tray]);

  // Açılınca / sekme değişince ilgili veriyi tazele.
  useEffect(() => {
    if (!open) return;
    if (tab === "profiles") loadProfiles();
    if (tab === "sync") loadSync();
    if (tab === "appearance") setTray(boot?.minimize_to_tray ?? false);
  }, [open, tab, boot?.minimize_to_tray, loadProfiles, loadSync]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  if (!open) return null;

  const close = () => setOpen(false);

  // ── Profiles ───────────────────────────────────────────
  const switchTo = async (id: string) => {
    setBusy(true);
    setNote(null);
    try {
      adoptBootstrap(await ipc.switchProfile(id));
      // Kilitli profile geçilirse App gate kilit ekranını gösterir (bu modal unmount).
      loadProfiles();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const lockNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      adoptBootstrap(await ipc.lockNow());
      // locked=true → App kilit ekranına geçer.
    } catch (e) {
      setNote(String(e));
      setBusy(false);
    }
  };

  // ── Sync ───────────────────────────────────────────────
  const useFolder = async () => {
    setBusy(true);
    setNote(null);
    try {
      await ipc.setSyncDir(dirInput.trim() || null);
      loadSync();
      setNote(dirInput.trim() ? "Sync folder set." : "Sync turned off.");
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doSync = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await ipc.syncNow();
      setNote(res.message);
      await refresh(); // çekildiyse host'lar değişmiş olabilir
      loadSync();
      if (res.locked) {
        // Uzaktan gelen yabancı parolalı vault → kilit ekranına geç.
        adoptBootstrap(await ipc.getBootstrap());
      }
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <div className="set-head">
          <span className="set-title">Settings</span>
          <button className="dlg-x" aria-label="Close" onClick={close}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="set-tabs">
          <button className={"set-tab" + (tab === "appearance" ? " on" : "")} onClick={() => setTab("appearance")}>
            Appearance
          </button>
          <button className={"set-tab" + (tab === "profiles" ? " on" : "")} onClick={() => setTab("profiles")}>
            Profiles
          </button>
          <button className={"set-tab" + (tab === "sync" ? " on" : "")} onClick={() => setTab("sync")}>
            Sync
          </button>
        </div>

        <div className="set-body">
          {tab === "appearance" && (
            <section>
              <h3 className="set-h">Theme</h3>
              <p className="set-sub">Monochrome — hierarchy from contrast, not color. Changes apply instantly.</p>
              <div className="set-themes">
                {THEME_OPTIONS.map((th) => (
                  <button
                    key={th.id}
                    className={"ob-theme" + (theme === th.id ? " on" : "")}
                    onClick={() => void changeTheme(th.id)}
                  >
                    <span className="ob-swatch">
                      <span style={{ background: th.b }} />
                      <span style={{ background: th.a }} />
                    </span>
                    <span className="ob-theme-main">
                      <span className="ob-theme-name">{th.name}</span>
                      <span className="ob-theme-sub">{th.sub}</span>
                    </span>
                    {/* Tik her zaman DOM'da: opaklikla gelir, layout kaymaz. */}
                    <Check className="ob-theme-check" size={16} strokeWidth={2} />
                  </button>
                ))}
              </div>

              <h3 className="set-h">Window</h3>
              <p className="set-sub">
                With this on, closing the window keeps Portal running in the system tray, so
                uptime checks continue. Quit from the tray icon's menu.
              </p>
              <button
                className={"hf-check lit" + (tray ? " on" : "")}
                onClick={() => void toggleTray()}
              >
                <span className="hf-box">
                  <Check size={16} strokeWidth={2} />
                </span>
                <span>
                  <b>Minimize to tray on close</b> — keep checking sites in the background
                </span>
              </button>
            </section>
          )}

          {tab === "profiles" && (
            <section>
              <h3 className="set-h">Profiles</h3>
              <p className="set-sub">
                A profile keeps servers together and encrypts them on this device
                {boot?.device_label ? ` (${boot.device_label})` : ""}. Switching reloads that
                profile's vault; a password profile asks to unlock.
              </p>
              <div className="set-list">
                {profiles.length === 0 && (
                  <div className="set-empty">
                    No encrypted profile yet — you're running in frictionless mode.
                  </div>
                )}
                {profiles.map((p) => (
                  <div key={p.id} className={"set-row" + (p.active ? " active" : "")}>
                    <span className="set-row-ic">
                      <UserRound size={16} strokeWidth={1.75} />
                    </span>
                    <span className="set-row-main">
                      <span className="set-row-name">{p.name}</span>
                      <span className="set-row-meta">
                        {p.lockedWithPassword ? (
                          <>
                            <Lock size={16} strokeWidth={1.75} /> password
                          </>
                        ) : (
                          "auto-unlock (key on this machine)"
                        )}
                      </span>
                    </span>
                    {p.active ? (
                      <span className="set-badge">Active</span>
                    ) : (
                      <button className="btn-ghost" disabled={busy} onClick={() => switchTo(p.id)}>
                        Switch
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {profiles.some((p) => p.active && p.lockedWithPassword) && (
                <div className="set-actions">
                  <button className="btn-ghost" disabled={busy} onClick={lockNow}>
                    <Lock size={16} strokeWidth={1.75} /> Lock now
                  </button>
                  <span className="set-hint">Locks this profile and asks for the password again.</span>
                </div>
              )}
            </section>
          )}

          {tab === "sync" && (
            <section>
              <h3 className="set-h">Sync (bring your own storage)</h3>
              <p className="set-sub">
                Portal copies only the <b>encrypted</b> vault into a folder you choose (a synced
                Drive/Dropbox folder, a Git repo, your own server). Nothing is decrypted; the
                company never sees your data. Conflicts resolve <b>last-writer-wins</b> by timestamp.
              </p>

              <label className="fld">
                <span className="fld-k">Sync folder</span>
                <span className="fwrap">
                  <input
                    value={dirInput}
                    onChange={(e) => setDirInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && useFolder()}
                    placeholder="C:\Users\you\Dropbox\portal"
                    className="mono"
                  />
                </span>
              </label>
              <div className="set-actions">
                <button className="btn-primary" disabled={busy} onClick={useFolder}>
                  <FolderSync size={16} strokeWidth={1.75} />
                  <span>{dirInput.trim() ? "Use this folder" : "Turn off"}</span>
                </button>
                <SpinButton
                  className="btn-ghost"
                  title="Sync now"
                  disabled={busy || !sync?.dir}
                  onRun={doSync}
                >
                  {" "}
                  Sync now
                </SpinButton>
              </div>

              {sync?.dir ? (
                <div className="set-sync-status">
                  <div className="set-sync-row">
                    <span className="set-sync-k">Status</span>
                    <span className="set-sync-v">{sync.label ?? "—"}</span>
                  </div>
                  <div className="set-sync-row">
                    <span className="set-sync-k">This device</span>
                    <span className="set-sync-v mono">{whenText(sync.localUpdated, sync.localDevice)}</span>
                  </div>
                  <div className="set-sync-row">
                    <span className="set-sync-k">In folder</span>
                    <span className="set-sync-v mono">{whenText(sync.remoteUpdated, sync.remoteDevice)}</span>
                  </div>
                </div>
              ) : (
                <p className="set-note-muted">
                  Cross-device sync needs a portable lock (a password), since the machine key can't
                  travel. Set a password on your profile to unlock the vault on another computer.
                </p>
              )}
            </section>
          )}

          {note && (
            <div className="set-note">
              <span className={"st" + (busy ? " run" : "")} />
              <span>{note}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
