// Hosts paneli. İsimlendirme ayrımı (P6-D backlog B):
// - Display Name (label) OPSİYONEL → boşsa kartta adres/IP gösterilir.
// - Login Username = bağlanırken kullanılan gerçek kullanıcı adı (ayrı alan).
// - Akıllı toggle: display name ≠ login ise ikonla farklı ad gir; aynıysa login adı kullanılır.
// - Kartta username@ip GİZLİ; hover'da uyarı, tıkla-onayla → göster.
// - Düzenleme: sağ-tık menü ya da seçili host'ta E.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Pencil, Search, Trash2 } from "lucide-react";
import { usePortal } from "../context";
import { openGateway, openTerminal } from "../dock/dock";
import type { Host } from "../lib/types";
import { ErrorNote } from "../components/ErrorNote";
import { SpinButton } from "../components/SpinButton";

/** Kartta gösterilecek ad: Display Name, boşsa adres/IP. */
function displayName(h: Host): string {
  return h.label.trim() || h.address;
}
/** Gizli tutulan tam bağlantı bilgisi (username@ip:port). */
function connString(h: Host): string {
  return (h.username ? `${h.username}@` : "") + h.address + (h.port !== 22 ? `:${h.port}` : "");
}
/** Sekme başlığı (oturum açılınca). */
function tabTitle(h: Host): string {
  return h.username ? `${h.username}@${h.address}` : h.address;
}

interface FormState {
  id: string | null; // null = ekle, dolu = düzenle
  username: string;
  address: string;
  port: string;
  customName: boolean; // farklı display name kullan (B2 toggle)
  label: string; // customName true iken girilen display name
  autoConnect: boolean; // sayfa açılınca otomatik shell aç
}

const emptyForm = (): FormState => ({
  id: null,
  username: "",
  address: "",
  port: "",
  customName: false,
  label: "",
  autoConnect: false,
});

export function HostsPanel() {
  const { hosts, selectedHost, selectHost, addHost, updateHost, removeHost, setAutoConnect, hostState, refresh } =
    usePortal();
  const [q, setQ] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const filtered = useMemo(
    () =>
      hosts.filter((h) =>
        `${h.label} ${h.address} ${h.username ?? ""}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [hosts, q],
  );

  const openAdd = () => {
    setErr(null);
    setForm(emptyForm());
  };
  const openEdit = (h: Host) => {
    setErr(null);
    const login = (h.username ?? "").trim();
    const custom = h.label.trim() !== "" && h.label.trim() !== login;
    setForm({
      id: h.id,
      username: h.username ?? "",
      address: h.address,
      port: h.port !== 22 ? String(h.port) : "",
      customName: custom,
      label: custom ? h.label : "",
      autoConnect: h.auto_connect ?? false,
    });
  };
  const closeForm = () => {
    setForm(null);
    setErr(null);
  };

  const submit = async () => {
    if (!form) return;
    setErr(null);
    const username = form.username.trim();
    const address = form.address.trim();
    // Display Name: toggle açıksa girilen ad, kapalıysa login username (B2).
    const label = form.customName ? form.label.trim() : username;
    const port = form.port.trim() ? Number(form.port.trim()) : undefined;
    if (!address) {
      setErr("Enter the server's address.");
      return;
    }
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setErr("Port must be a number between 1 and 65535.");
      return;
    }
    try {
      if (form.id) {
        await updateHost(form.id, label, address, port, username || undefined);
        await setAutoConnect(form.id, form.autoConnect);
      } else {
        const created = await addHost(label, address, port, username || undefined);
        if (form.autoConnect && created) await setAutoConnect(created.id, true);
      }
      closeForm();
    } catch (e) {
      setErr(String(e));
    }
  };

  // E tuşu → seçili host'u düzenle (bir input'a yazarken ya da form açıkken değil).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (form) return;
      if ((e.key !== "e" && e.key !== "E") || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const h = hosts.find((x) => x.id === selectedHost);
      if (h) {
        e.preventDefault();
        openEdit(h);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hosts, selectedHost, form]);

  // Host bağlam menüsünü dış tıkla/blur ile kapat.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const menuHost = menu ? hosts.find((h) => h.id === menu.id) : undefined;

  return (
    <div className="panelbody">
      <div className="hosts">
        <div className="search">
          <Search size={16} strokeWidth={1.75} />
          <input placeholder="Search hosts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="side-tools">
          <SpinButton className="tool" title="Refresh list" onRun={() => void refresh()} />
          <span className="sp" />
          <button className="btn-primary" onClick={openAdd}>
            + Add Host
          </button>
        </div>

        {form && (
          <div className="addform lit">
            <div className="form-title">{form.id ? "Edit server" : "Add a server"}</div>
            <div className="grp">
            <span className="grp-k">Connection</span>
            <label className="hf">
              <span className="hf-k">Login username</span>
              <span className="fwrap">
              <input
                autoFocus
                placeholder="e.g. root"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
              </span>
            </label>
            <label className="hf">
              <span className="hf-k">Address</span>
              <span className={"fwrap" + (err ? " bad" : "")}>
              <input
                placeholder="e.g. 10.0.0.5"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
              </span>
            </label>
            <label className="hf">
              <span className="hf-k">
                Port <span className="hf-opt">(optional)</span>
              </span>
              <span className="fwrap">
              <input
                placeholder="22"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
              </span>
            </label>
            </div>

            <div className="grp">
            <span className="grp-k">Appearance</span>
            {form.customName ? (
              <label className="hf">
                <span className="hf-k">
                  Display name
                  <span className="sp" />
                  <button
                    className="hf-link"
                    onClick={() => setForm({ ...form, customName: false, label: "" })}
                  >
                    use login name
                  </button>
                </span>
                <span className="fwrap">
                <input
                  placeholder="e.g. Hostinger"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
                </span>
              </label>
            ) : (
              <button
                className="hf-toggle lit"
                onClick={() => setForm({ ...form, customName: true })}
                title="Login name and the name you want to see differ? Set a separate display name."
              >
                <Pencil size={16} strokeWidth={1.75} />
                <span>
                  Shows as <b>{form.username.trim() || form.address.trim() || "…"}</b> — set a
                  different name
                </span>
              </button>
            )}
            </div>

            <div className="grp">
            <span className="grp-k">Behaviour</span>
            <button
              className={"hf-check lit" + (form.autoConnect ? " on" : "")}
              onClick={() => setForm({ ...form, autoConnect: !form.autoConnect })}
              title="Open a shell automatically whenever you open this server."
            >
              <span className="hf-box">
                <Check size={16} strokeWidth={3} />
              </span>
              <span>
                Keep connected — <b>auto-open a shell</b> when this server opens
              </span>
            </button>
            </div>

            {err && (
              <ErrorNote>{err}</ErrorNote>
            )}
            <div className="row">
              <button className="btn-primary" onClick={() => void submit()}>
                <span>{form.id ? "Save changes" : "Add server"}</span>
              </button>
              <button className="btn-ghost" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="empty">
            {hosts.length === 0 ? (
              <>
                No servers yet. Press <b>+ Add Host</b> to add your first one — or import from{" "}
                <b>~/.ssh/config</b> later. Everything stays encrypted on this machine.
              </>
            ) : (
              "No match."
            )}
          </div>
        ) : (
          <>
            <div className="grouphdr">
              <span className="caret">
                <ChevronDown size={16} strokeWidth={1.75} />
              </span>
              <span className="gname">Servers</span>
              <span className="cnt">{filtered.length}</span>
            </div>
            {filtered.map((h) => (
              <div
                key={h.id}
                className={
                  "hostrow" +
                  (selectedHost === h.id ? " sel" : "") +
                  (hostState(h.id) === "offline" ? " off" : "")
                }
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectHost(h.id);
                    openGateway(h.id, tabTitle(h));
                  }
                }}
                title="Click to open · double-click to connect · right-click for options"
                onClick={() => {
                  selectHost(h.id);
                  openGateway(h.id, tabTitle(h));
                }}
                onDoubleClick={() => openTerminal(h.id, tabTitle(h))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectHost(h.id);
                  setMenu({ id: h.id, x: e.clientX, y: e.clientY });
                }}
              >
                <span
                  className={
                    "dot " +
                    (hostState(h.id) === "connected"
                      ? "on"
                      : hostState(h.id) === "connecting"
                        ? "connecting"
                        : "off")
                  }
                  title={
                    hostState(h.id) === "connected"
                      ? "Connected"
                      : hostState(h.id) === "connecting"
                        ? "Connecting…"
                        : "Not connected"
                  }
                />
                <div className="min0">
                  <div className="h-name">
                    {displayName(h)}
                    {h.auto_connect && (
                      <span className="h-auto" title="Auto-connects when opened">
                        auto
                      </span>
                    )}
                  </div>
                  <div className="h-sub">
                    <span className="h-conn mono">{connString(h)}</span>
                  </div>
                </div>
                <div className="hrow-actions">
                  <button
                    className="hostrow-edit"
                    title="Edit (E)"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(h);
                    }}
                  >
                    <Pencil size={16} strokeWidth={1.75} />
                  </button>
                  <button
                    className="hostdel"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeHost(h.id);
                    }}
                  >
                    <Trash2 size={16} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {menu && menuHost && (
        <div
          className="ctx hostctx"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 150),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-item"
            onClick={() => {
              openGateway(menuHost.id, tabTitle(menuHost));
              setMenu(null);
            }}
          >
            Open
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              openTerminal(menuHost.id, tabTitle(menuHost));
              setMenu(null);
            }}
          >
            Connect (terminal)
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => {
              openEdit(menuHost);
              setMenu(null);
            }}
          >
            Edit <span className="sc">E</span>
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              void removeHost(menuHost.id);
              setMenu(null);
            }}
          >
            <span>Remove</span>
            <span className="mk" />
          </button>
        </div>
      )}
    </div>
  );
}
