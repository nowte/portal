// Öğretme katmanı raili (DESIGN §12.9). İçerik açık olan yüzeye göre değişir (F24):
// paneller lib/guide üzerinden konuyu bildirir, burası dinler. İçerik şimdilik burada
// statik bir harita; ileride portal-core::teaching'ten bağlama-duyarlı gelecek.

import { type ReactNode } from "react";
import { pinGuideTopic, useGuideTopic, type GuideTopic } from "../lib/guide";

interface Topic {
  title: string;
  blocks: { q: string; a: ReactNode }[];
}

const GUIDE: Record<GuideTopic, Topic> = {
  home: {
    title: "Home",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            Your starting point. Every server you save shows up here; open one to connect,
            browse its files or watch its health.
          </>
        ),
      },
      {
        q: "Where do I start?",
        a: (
          <>
            Open the <span className="mono">Hosts</span> panel on the left and add your first
            server — nothing leaves this machine.
          </>
        ),
      },
    ],
  },
  gateway: {
    title: "Server gateway",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            A server's front door. From here you open a shell, browse files (SFTP) or watch live
            CPU / RAM — each opens in its own tab.
          </>
        ),
      },
      {
        q: "Do I need to connect first?",
        a: (
          <>
            No. Pick Connect, Files or Monitor and Portal opens that connection for you, asking for
            a password or key only when it needs one.
          </>
        ),
      },
    ],
  },
  terminal: {
    title: "Terminal",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            A direct command line on the server — the same shell you'd get over SSH, showing the
            server's real colors.
          </>
        ),
      },
      {
        q: "Good to know",
        a: (
          <>
            Your password is asked once per session and never written to disk. Close the tab to end
            the session.
          </>
        ),
      },
    ],
  },
  files: {
    title: "Files (SFTP)",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            Two side-by-side folders — this PC and the server. Drag a file from one to the other to
            copy it over an encrypted SSH channel.
          </>
        ),
      },
      {
        q: "Why not plain FTP?",
        a: (
          <>
            SFTP rides inside SSH, so transfers are encrypted end to end — no separate service and
            no extra open port on the server.
          </>
        ),
      },
    ],
  },
  monitor: {
    title: "Monitor",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            Live health for the server — CPU, memory, disk and network, read straight from the
            system. No agent to install.
          </>
        ),
      },
      {
        q: "How does it work?",
        a: (
          <>
            Portal runs tiny read-only commands over your SSH connection and charts the result
            about once a second.
          </>
        ),
      },
    ],
  },
};

export function GuidePanel() {
  const topic = useGuideTopic();
  const g = GUIDE[topic];
  return (
    <div className="guide-body">
      <div className="tour">
        <span className="step">?</span>
        <span className="tt">Guide</span>
      </div>
      {/* key={topic}: konu değişince kart yeniden monte olur → giriş animasyonu
          tekrar oynar. Rail'in "az önce değişti" demesinin tek yolu bu. */}
      <div className="guide-card" key={topic}>
        <div className="gc-h">
          <span className="qmark">?</span>
          <span className="gt">{g.title}</span>
        </div>
        <div className="gc-b">
          {g.blocks.map((b, i) => (
            <div className="blk" key={i}>
              <p className="q">{b.q}</p>
              <p className="a">{b.a}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="guide-note">
        <b>Guide follows what you&apos;re doing.</b> Open a terminal, files or the
        monitor and this rail explains it — in plain language. Collapse it any time.
      </p>

      {/* Rail aktif pencereyi kendiliğinden takip eder; bu seçici o takibi
          geçici olarak devralır — kullanıcı açık olmayan bir yüzey hakkında da
          okuyabilsin diye. Bir sonraki pencere değişiminde takip geri alır. */}
      <div className="guide-pick">
        <span className="guide-pick-k">Read about another window</span>
        <div className="guide-pick-row">
          {(Object.keys(GUIDE) as GuideTopic[]).map((t) => (
            <button
              key={t}
              className={"guide-pick-b" + (t === topic ? " on" : "")}
              aria-pressed={t === topic}
              onClick={() => pinGuideTopic(t)}
            >
              {GUIDE[t].title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
