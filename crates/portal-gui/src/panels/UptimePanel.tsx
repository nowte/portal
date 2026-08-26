// Uptime listesi — Hosts ile aynı sol sütunda yaşayan bir ARAÇ paneli.
//
// Buradaki iş listelemek ve düzenlemek; bir monitörün verisi merkeze, kendi
// sayfasına açılır (MonitorPage) — tıpkı bir sunucunun sayfası gibi. Satır
// primitive'leri Hosts panelinden aynen gelir (.hostrow / .h-name / .h-sub):
// iki liste iki farklı satır görünmesin.

import { useState } from "react";
import { ChevronDown, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { usePortal } from "../context";
import { openMonitorPage } from "../dock/dock";
import { addMonitor, checkMonitorNow, removeMonitor, updateMonitor } from "../lib/ipc";
import { StateIcon } from "../components/StateIcon";
import type { MonitorInput, MonitorSummary } from "../lib/types";
import { pctText, targetText, useMonitors } from "../lib/uptime";
import { ErrorNote } from "../components/ErrorNote";
import { SpinButton } from "../components/SpinButton";

/** Formun ekranda tuttuğu hâli (sayılar string; kullanıcı yazarken boş kalabilir). */
interface FormState {
  id: string | null; // null = ekle
  label: string;
  kind: "http" | "tcp";
  target: string;
  port: string;
  expectStatus: string;
  contains: string;
  intervalSecs: string;
  timeoutSecs: string;
  enabled: boolean;
  hostId: string | null;
}

const emptyForm = (): FormState => ({
  id: null,
  label: "",
  kind: "http",
  target: "",
  port: "",
  expectStatus: "",
  contains: "",
  intervalSecs: "60",
  timeoutSecs: "10",
  enabled: true,
  hostId: null,
});

function formOf(m: MonitorSummary): FormState {
  const t = m.monitor.target;
  return {
    id: m.monitor.id,
    label: m.monitor.label,
    kind: t.kind,
    target: t.kind === "http" ? t.url : t.host,
    port: t.kind === "tcp" ? String(t.port) : "",
    expectStatus: t.kind === "http" && t.expect_status ? String(t.expect_status) : "",
    contains: t.kind === "http" ? (t.contains ?? "") : "",
    intervalSecs: String(m.monitor.interval_secs),
    timeoutSecs: String(m.monitor.timeout_secs),
    enabled: m.monitor.enabled,
    hostId: m.monitor.host_id ?? null,
  };
}

function toInput(f: FormState): MonitorInput {
  const num = (v: string, fallback: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    label: f.label,
    kind: f.kind,
    target: f.target,
    port: f.kind === "tcp" ? num(f.port, 0) : null,
    expectStatus: f.kind === "http" && f.expectStatus.trim() ? num(f.expectStatus, 200) : null,
    contains: f.kind === "http" && f.contains.trim() ? f.contains.trim() : null,
    intervalSecs: num(f.intervalSecs, 60),
    timeoutSecs: num(f.timeoutSecs, 10),
    enabled: f.enabled,
    hostId: f.hostId,
  };
}

export function UptimePanel() {
  const { hosts } = usePortal();
  const { monitors, refresh } = useMonitors();
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const submit = async (): Promise<void> => {
    if (!form) return;
    setErr(null);
    try {
      const input = toInput(form);
      if (form.id) await updateMonitor(form.id, input);
      else await addMonitor(input);
      setForm(null);
      refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  const filtered = monitors.filter((m) =>
    `${m.monitor.label} ${targetText(m)}`.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="panelbody">
      <div className="hosts">
        <div className="search">
          <Search size={16} strokeWidth={1.75} />
          <input
            placeholder="Search monitors…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="side-tools">
          <SpinButton
            className="tool"
            title="Check every monitor now"
            onRun={() => {
              for (const m of monitors) void checkMonitorNow(m.monitor.id);
            }}
          />
          <span className="sp" />
          <button
            className="btn-primary"
            onClick={() => {
              setErr(null);
              setForm(emptyForm());
            }}
          >
            <Plus size={16} strokeWidth={1.75} /> Add Monitor
          </button>
        </div>

        {form && (
          <div className="addform lit">
            <div className="form-title">{form.id ? "Edit monitor" : "Add a monitor"}</div>

            <div className="grp">
              <span className="grp-k">What to check</span>
              <div className="upkind">
                <button
                  className={"set-tab" + (form.kind === "http" ? " on" : "")}
                  onClick={() => setForm({ ...form, kind: "http" })}
                >
                  Website
                </button>
                <button
                  className={"set-tab" + (form.kind === "tcp" ? " on" : "")}
                  onClick={() => setForm({ ...form, kind: "tcp" })}
                >
                  Port
                </button>
              </div>
              <label className="hf">
                <span className="hf-k">{form.kind === "http" ? "URL" : "Host"}</span>
                <span className={"fwrap" + (err ? " bad" : "")}>
                  <input
                    autoFocus
                    placeholder={form.kind === "http" ? "e.g. example.com" : "e.g. 10.0.0.5"}
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && void submit()}
                  />
                </span>
              </label>
              {form.kind === "tcp" ? (
                <label className="hf">
                  <span className="hf-k">Port</span>
                  <span className="fwrap">
                    <input
                      placeholder="e.g. 443"
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && void submit()}
                    />
                  </span>
                </label>
              ) : (
                <>
                  <label className="hf">
                    <span className="hf-k">
                      Expected status <span className="hf-opt">(optional)</span>
                    </span>
                    <span className="fwrap">
                      <input
                        placeholder="any 2xx or 3xx"
                        value={form.expectStatus}
                        onChange={(e) => setForm({ ...form, expectStatus: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && void submit()}
                      />
                    </span>
                  </label>
                  <label className="hf">
                    <span className="hf-k">
                      Response must contain <span className="hf-opt">(optional)</span>
                    </span>
                    <span className="fwrap">
                      <input
                        placeholder="e.g. All systems operational"
                        value={form.contains}
                        onChange={(e) => setForm({ ...form, contains: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && void submit()}
                      />
                    </span>
                  </label>
                </>
              )}
            </div>

            <div className="grp">
              <span className="grp-k">Schedule</span>
              <label className="hf">
                <span className="hf-k">Every (seconds)</span>
                <span className="fwrap">
                  <input
                    value={form.intervalSecs}
                    onChange={(e) => setForm({ ...form, intervalSecs: e.target.value })}
                  />
                </span>
              </label>
              <label className="hf">
                <span className="hf-k">Timeout (seconds)</span>
                <span className="fwrap">
                  <input
                    value={form.timeoutSecs}
                    onChange={(e) => setForm({ ...form, timeoutSecs: e.target.value })}
                  />
                </span>
              </label>
            </div>

            <div className="grp">
              <span className="grp-k">Name &amp; server</span>
              <label className="hf">
                <span className="hf-k">
                  Display name <span className="hf-opt">(optional)</span>
                </span>
                <span className="fwrap">
                  <input
                    placeholder="defaults to the address"
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </span>
              </label>
              {hosts.length > 0 && (
                <div className="upkind wrap">
                  <button
                    className={"set-tab" + (form.hostId === null ? " on" : "")}
                    onClick={() => setForm({ ...form, hostId: null })}
                  >
                    No server
                  </button>
                  {hosts.map((h) => (
                    <button
                      key={h.id}
                      className={"set-tab" + (form.hostId === h.id ? " on" : "")}
                      onClick={() => setForm({ ...form, hostId: h.id })}
                    >
                      {h.label.trim() || h.address}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {err && <ErrorNote>{err}</ErrorNote>}

            <div className="row">
              <button className="btn-primary" onClick={() => void submit()}>
                {form.id ? "Save changes" : "Add monitor"}
              </button>
              <button className="btn-ghost" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          !form && (
            <div className="empty">
              {monitors.length === 0 ? (
                <>
                  Nothing is being watched yet. Press <b>+ Add Monitor</b> to check a site or
                  a port while Portal is running.
                </>
              ) : (
                "No match."
              )}
            </div>
          )
        ) : (
          <>
            <div className="grouphdr">
              <span className="caret">
                <ChevronDown size={16} strokeWidth={1.75} />
              </span>
              <span className="gname">Monitors</span>
              <span className="cnt">{filtered.length}</span>
            </div>
            {filtered.map((m) => (
              <div
                key={m.monitor.id}
                className={"hostrow uprow" + (m.monitor.enabled ? "" : " off")}
                role="button"
                tabIndex={0}
                title="Click to open this monitor"
                onClick={() => openMonitorPage(m.monitor.id, m.monitor.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openMonitorPage(m.monitor.id, m.monitor.label);
                  }
                }}
              >
                <StateIcon state={m.state} enabled={m.monitor.enabled} />
                <div className="min0">
                  <div className="h-name">
                    {m.monitor.label}
                    {!m.monitor.enabled && (
                      <span className="h-auto" title="Checks are paused">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="h-sub">
                    <span className="h-conn mono">{targetText(m)}</span>
                  </div>
                </div>
                <span className="up-pct mono" title="Uptime today">
                  {pctText(m.today.up, m.today.down)}
                </span>
                <div className="hrow-actions">
                  <SpinButton
                    title="Check now"
                    onRun={() => void checkMonitorNow(m.monitor.id)}
                  />
                  <button
                    className="hostrow-edit"
                    title="Edit monitor"
                    aria-label={`Edit the monitor for ${m.monitor.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setErr(null);
                      setForm(formOf(m));
                    }}
                  >
                    <Pencil size={16} strokeWidth={1.75} />
                  </button>
                  <button
                    className="hostdel"
                    title="Remove monitor"
                    aria-label={`Remove the monitor for ${m.monitor.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeMonitor(m.monitor.id).then(refresh);
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
    </div>
  );
}
