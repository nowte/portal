// Host-key öğretme modalı (DESIGN §12.9 teaching): ilk bağlanışta bilinmeyen anahtar
// → fingerprint + "What is this?" → güven (known_hosts'a yazılır) ya da reddet.
// Anahtar DEĞİŞMİŞSE (changed) olası MITM → güçlü uyarı + yalnız reddet (P6-D #5).
// portal-core kararı handshake'e geri iletir (host_key_decision komutu).

import { ShieldAlert, ShieldQuestion } from "lucide-react";

export interface HostKeyReq {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  changed: boolean;
}

export function HostKeyModal({
  req,
  onDecision,
}: {
  req: HostKeyReq;
  onDecision: (accept: boolean) => void;
}) {
  const changed = req.changed;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onDecision(false)}>
      <div
        className="dialog"
        role="dialog"
        aria-label={changed ? "Host key changed" : "Unknown host key"}
      >
        <div className="dlg-head">
          <span className={"dlg-ic-wrap" + (changed ? " warn" : "")}>
            {changed ? (
              <ShieldAlert size={20} strokeWidth={1.75} className="dlg-ic" />
            ) : (
              <ShieldQuestion size={20} strokeWidth={1.75} className="dlg-ic" />
            )}
          </span>
          <span className="dlg-title">
            {changed ? `Host key changed for ${req.host}` : `First connection to ${req.host}`}
          </span>
        </div>
        <div className="hk-card">
          <div className="hk-row">
            <span className="hk-k">Host</span>
            <span className="mono">
              {req.host}:{req.port}
            </span>
          </div>
          <div className="hk-row">
            <span className="hk-k">Key type</span>
            <span className="mono">{req.keyType}</span>
          </div>
          <div className="hk-row">
            <span className="hk-k">Fingerprint</span>
            <span className="mono hk-fp">{req.fingerprint}</span>
          </div>
        </div>

        {changed ? (
          <>
            <p className="hk-q warn">
              <span className="mk" />
              This is not the key Portal trusted before.
            </p>
            <p className="hk-p">
              The server's key has changed. That can happen if it was rebuilt or its SSH was
              reinstalled — but it can also mean someone is intercepting the connection. Portal
              refused to connect. Verify it's really the same server before trusting it again, then
              remove the old entry from Portal's <span className="mono">known_hosts</span>.
            </p>
            <div className="dlg-foot">
              <button className="btn-primary" onClick={() => onDecision(false)}>
                <span>OK, don&apos;t connect</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hk-q">What is this?</p>
            <p className="hk-p">
              Every server has a unique key. Portal hasn't seen this one before. If you trust it,
              Portal remembers the key in its own <span className="mono">known_hosts</span> — next
              time it connects silently. If the fingerprint ever changes unexpectedly, that's a
              warning.
            </p>
            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => onDecision(false)}>
                Reject
              </button>
              <button className="btn-primary" onClick={() => onDecision(true)}>
                <span>Trust &amp; continue</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
