// Bir monitörün sayfası — sol listeden tıklanınca merkezde açılır (host sayfası gibi).
//
// Kart/blok primitive'leri Monitor panelinden gelir (.mon / .mcard / .mbig / .mblock):
// "sunucunun sağlığı" ile "sitenin sağlığı" aynı görsel dille okunur.

import { CircleAlert } from "lucide-react";
import { checkMonitorNow } from "../lib/ipc";
import { SpinButton } from "../components/SpinButton";
import { agoText, dayText, pctText, targetText, useMonitors } from "../lib/uptime";
import { StateIcon } from "../components/StateIcon";

/** Verilen günlerin toplamından uptime yüzdesi. */
function rangePct(days: { up: number; down: number }[]): string {
  const up = days.reduce((a, d) => a + d.up, 0);
  const down = days.reduce((a, d) => a + d.down, 0);
  return pctText(up, down);
}

export function MonitorPage({ monitorId }: { monitorId: string }) {
  const { monitors } = useMonitors();
  const m = monitors.find((x) => x.monitor.id === monitorId);

  if (!m) {
    return (
      <div className="panelbody">
        <div className="mon">
          <div className="empty">This monitor no longer exists. Close this tab.</div>
        </div>
      </div>
    );
  }

  const last = m.last;
  const todayAvg =
    m.today.up > 0 ? Math.round(m.today.latency_sum_ms / m.today.up) : null;

  return (
    <div className="panelbody">
      <div className="mon">
        <div className="mon-status">
          <StateIcon state={m.state} enabled={m.monitor.enabled} size={20} />
          <span className="mono">{targetText(m)}</span>
          <span className="sp" />
          <SpinButton
            className="tool"
            title="Check now"
            onRun={() => void checkMonitorNow(m.monitor.id)}
          />
        </div>

        <div className="mon-cards">
          <div className="mcard">
            <span className="u">Today</span>
            <span className="mbig sm">{pctText(m.today.up, m.today.down)}</span>
            <span className="mfoot">
              {m.today.up + m.today.down} {m.today.up + m.today.down === 1 ? "check" : "checks"}
            </span>
          </div>
          <div className="mcard">
            <span className="u">Last {m.days.length || 0} days</span>
            <span className="mbig sm">{rangePct(m.days)}</span>
            <span className="mfoot">{m.days.reduce((a, d) => a + d.down, 0)} failed</span>
          </div>
          <div className="mcard">
            <span className="u">Response</span>
            <span className="mbig sm">
              {last?.up ? `${last.latency_ms ?? 0} ms` : last ? "down" : "—"}
            </span>
            <span className="mfoot">
              {last ? agoText(last.at) : "not checked yet"}
              {todayAvg !== null ? ` · ${todayAvg} ms avg` : ""}
            </span>
          </div>
          <div className="mcard">
            <span className="u">Schedule</span>
            <span className="mbig sm">{m.monitor.interval_secs}s</span>
            <span className="mfoot">
              {m.monitor.enabled ? "checking" : "paused"} · {m.monitor.timeout_secs}s timeout
            </span>
          </div>
        </div>

        {last && !last.up && (
          <div className="mon-status err">
            <CircleAlert className="err-i" size={16} strokeWidth={1.75} />
            <span>
              Last check failed.
              <span className="raw">{last.error ?? "no reason reported"}</span>
            </span>
          </div>
        )}

        <div className="mblock">
          <div className="mblock-h">
            Daily uptime
            <span className="mblock-sub">one bar per day, oldest first</span>
          </div>
          {m.days.length === 0 ? (
            <div className="empty short">No checks recorded yet.</div>
          ) : (
            <div className="updays">
              {m.days.map((d) => (
                <i
                  key={d.day}
                  className={"upd-bar" + (d.down === 0 ? " on" : "")}
                  title={`${dayText(d.day)} · ${pctText(d.up, d.down)} · ${d.down} failed`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mblock">
          <div className="mblock-h">
            Recent checks
            <span className="mblock-sub">last {m.recent.length}, oldest first</span>
          </div>
          {m.recent.length === 0 ? (
            <div className="empty short">Nothing yet — the first check runs within a minute.</div>
          ) : (
            <div className="upbars tall">
              {m.recent.map((c, i) => (
                <i
                  key={i}
                  className={"upb" + (c.up ? " on" : "")}
                  title={c.up ? `${c.latency_ms ?? 0} ms · ${agoText(c.at)}` : `${c.error ?? "failed"} · ${agoText(c.at)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mblock">
          <div className="mblock-h">Recent failures</div>
          {(() => {
            const fails = m.recent.filter((c) => !c.up).slice(-8).reverse();
            if (fails.length === 0)
              return <div className="empty short">No failures recorded.</div>;
            return fails.map((c) => (
              <div className="upfail" key={c.at}>
                <span className="upfail-t mono">{agoText(c.at)}</span>
                <span className="upfail-m">{c.error ?? "check failed"}</span>
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
