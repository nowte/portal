// Snippets yöneticisi (kayıtlı komutlar) — global modal. Icon bar "Snippets" açar,
// Gateway'deki "+ New / edit" da buraya yönlenir (tek form kaynağı — kod tekrarı yok).
// CRUD + kapsam (global/host) + arama + kopyala + host'a özel tek-tık çalıştır +
// yıkıcı-komut için nötr uyarı rozeti.
//
// Modül-düzeyi köprü (prop-drilling'siz): openSnippets(intent?).

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, Pencil, Plus, Search, Trash2, X, Zap } from "lucide-react";
import { usePortal } from "../context";
import * as ipc from "../lib/ipc";
import { openTerminal } from "../dock/dock";
import type { Host, Snippet } from "../lib/types";
import { ErrorNote } from "./ErrorNote";

// Açılış niyeti: yeni komut (opsiyonel host kapsamıyla) ya da bir komutu düzenle.
export interface SnippetsIntent {
  newForHost?: string | null; // tanımlıysa forma bu host kapsamıyla başla
  editId?: string; // tanımlıysa bu komutu düzenle
}

let externalOpen: ((intent?: SnippetsIntent) => void) | null = null;
export function openSnippets(intent?: SnippetsIntent): void {
  externalOpen?.(intent);
}

// Yaygın yıkıcı kalıplar → çalıştırmadan önce nötr uyarı (durum rengi = amber).
const DANGER =
  /\brm\s+-[a-z]*f|\bmkfs\b|\bdd\s+if=|\b(reboot|shutdown|halt|poweroff)\b|--no-preserve-root|\bdrop\s+(database|table)\b|:\(\)\s*\{|\s>\s*\/dev\/sd/i;
function isDangerous(cmd: string): boolean {
  return DANGER.test(cmd);
}

function hostName(h: Host): string {
  return h.label.trim() || h.address;
}

interface FormState {
  id: string | null; // null = ekle, dolu = düzenle
  label: string;
  command: string;
  hostId: string | null; // null = global
}

export function SnippetsManager() {
  const { hosts } = usePortal();
  const [open, setOpen] = useState(false);
  const [snips, setSnips] = useState<Snippet[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);

  const load = useCallback(async (): Promise<Snippet[]> => {
    try {
      const list = await ipc.listSnippets();
      setSnips(list);
      return list;
    } catch (e) {
      setErr(String(e));
      return [];
    }
  }, []);

  // Açılış köprüsü + niyet (yeni/düzenle) uygulaması.
  useEffect(() => {
    externalOpen = (intent) => {
      setErr(null);
      setConfirmId(null);
      setQ("");
      setOpen(true);
      void load().then((list) => {
        if (intent?.editId) {
          const s = list.find((x) => x.id === intent.editId);
          if (s) {
            setForm({ id: s.id, label: s.label, command: s.command, hostId: s.host_id ?? null });
          }
        } else if (intent && "newForHost" in intent) {
          setForm({ id: null, label: "", command: "", hostId: intent.newForHost ?? null });
        } else {
          setForm(null);
        }
      });
    };
    return () => {
      externalOpen = null;
    };
  }, [load]);

  // Başka bir yerde (Gateway) değişirse listeyi tazele.
  useEffect(() => {
    if (!open) return;
    let un: (() => void) | undefined;
    void ipc.onSnippetsChanged(() => void load()).then((u) => (un = u));
    return () => un?.();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (form) setForm(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, form]);

  if (!open) return null;
  const close = () => setOpen(false);

  const filtered = snips.filter((s) => {
    if (!q.trim()) return true;
    const hay = `${s.label} ${s.command}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const globals = filtered.filter((s) => !s.host_id);
  const byHost = new Map<string, Snippet[]>();
  for (const s of filtered) {
    if (s.host_id) {
      const arr = byHost.get(s.host_id) ?? [];
      arr.push(s);
      byHost.set(s.host_id, arr);
    }
  }

  const startNew = () => {
    setErr(null);
    setForm({ id: null, label: "", command: "", hostId: null });
  };
  const startEdit = (s: Snippet) => {
    setErr(null);
    setForm({ id: s.id, label: s.label, command: s.command, hostId: s.host_id ?? null });
  };

  const save = async () => {
    if (!form) return;
    const command = form.command.trim();
    if (!command) {
      setErr("Enter the command to run.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (form.id) await ipc.updateSnippet(form.id, form.label, command, form.hostId);
      else await ipc.addSnippet(form.label, command, form.hostId);
      await load();
      setForm(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await ipc.removeSnippet(id);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setConfirmId(null);
    }
  };

  const run = (s: Snippet) => {
    if (!s.host_id) return;
    const h = hostById.get(s.host_id);
    if (!h) return;
    openTerminal(h.id, h.username ? `${h.username}@${h.address}` : h.address, s.command);
    close();
  };

  const copy = (s: Snippet) => {
    void navigator.clipboard?.writeText(s.command).then(
      () => {
        setCopied(s.id);
        setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 1200);
      },
      () => undefined,
    );
  };

  const row = (s: Snippet) => {
    const danger = isDangerous(s.command);
    return (
      <div className={"snm-row" + (danger ? " danger" : "")} key={s.id}>
        <div className="snm-main">
          <div className="snm-label">
            {s.label}
            {danger && (
              <span className="snm-danger" title="This command looks destructive — double-check before running.">
                <AlertTriangle size={16} strokeWidth={2} /> careful
              </span>
            )}
          </div>
          <div className="snm-cmd mono">
            <span className="c">{s.command.trim().split(/\s+/)[0]}</span>
            {s.command.trim().slice(s.command.trim().split(/\s+/)[0].length)}
          </div>
        </div>
        {confirmId === s.id ? (
          <div className="snm-confirm">
            <span>Remove?</span>
            <button className="danger" disabled={busy} onClick={() => void remove(s.id)}>
              <span className="mk" />
              Yes
            </button>
            <button onClick={() => setConfirmId(null)}>No</button>
          </div>
        ) : (
          <div className="snm-actions">
            {s.host_id && (
              <button className="snm-ic" title="Run in a new terminal" onClick={() => run(s)}>
                <Zap size={16} strokeWidth={1.75} />
              </button>
            )}
            <button
              className={"snm-ic" + (copied === s.id ? " copied" : "")}
              title={copied === s.id ? "Copied" : "Copy command"}
              onClick={() => copy(s)}
            >
              <Copy size={16} strokeWidth={1.75} />
              <span className="tick">
                <Check size={16} strokeWidth={2} />
              </span>
            </button>
            <button className="snm-ic" title="Edit" onClick={() => startEdit(s)}>
              <Pencil size={16} strokeWidth={1.75} />
            </button>
            <button className="snm-ic" title="Remove" onClick={() => setConfirmId(s.id)}>
              <Trash2 size={16} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings snm" role="dialog" aria-label="Saved commands">
        <div className="set-head">
          <span className="set-title">Saved commands</span>
          {!form && (
            <button className="btn-primary snm-new" onClick={startNew}>
              <Plus size={16} strokeWidth={2} /> New command
            </button>
          )}
          <button className="dlg-x" aria-label="Close" onClick={close}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {form ? (
          <div className="set-body">
            <label className="fld">
              <span className="fld-k">Label (optional)</span>
              <span className="fwrap">
                <input
                  autoFocus
                  placeholder="e.g. Restart nginx"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </span>
            </label>
            <label className="fld">
              <span className="fld-k">Command</span>
              <span className="fwrap">
                <textarea
                  className="mono"
                  rows={3}
                  placeholder="sudo systemctl restart nginx"
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
              </span>
            </label>
            <label className="fld">
              <span className="fld-k">Runs on</span>
              <span className="fwrap">
                <select
                  value={form.hostId ?? ""}
                  onChange={(e) => setForm({ ...form, hostId: e.target.value || null })}
                >
                  <option value="">Global — available on every server</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      Only {hostName(h)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="chev" size={16} strokeWidth={1.75} />
              </span>
            </label>

            {form.command.trim() && isDangerous(form.command) && (
              <div className="snm-danger-note">
                <AlertTriangle size={16} strokeWidth={2} /> This command looks destructive. Make sure
                it's what you intend before saving.
              </div>
            )}
            {err && <ErrorNote>{err}</ErrorNote>}

            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={() => void save()}>
                {form.id ? "Save changes" : "Add command"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="snm-toolbar">
              <span className="snm-search">
                <Search size={16} strokeWidth={1.75} />
                <input placeholder="Search commands…" value={q} onChange={(e) => setQ(e.target.value)} />
              </span>
            </div>

            <div className="set-body snm-list">
              {snips.length === 0 ? (
                <div className="empty">
                  No saved commands yet. Create one-click commands (like <b>restart nginx</b> or{" "}
                  <b>tail logs</b>) — mark them <b>global</b> to reuse everywhere, or scope them to a
                  single server.
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty">No command matches “{q}”.</div>
              ) : (
                <>
                  {globals.length > 0 && (
                    <div className="snm-group">
                      <div className="snm-group-h">
                        Global <span className="snm-count">{globals.length}</span>
                      </div>
                      {globals.map(row)}
                    </div>
                  )}
                  {hosts
                    .filter((h) => byHost.has(h.id))
                    .map((h) => (
                      <div className="snm-group" key={h.id}>
                        <div className="snm-group-h">
                          {hostName(h)} <span className="snm-count">{byHost.get(h.id)?.length}</span>
                        </div>
                        {byHost.get(h.id)?.map(row)}
                      </div>
                    ))}
                </>
              )}
              {err && !form && <ErrorNote>{err}</ErrorNote>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
