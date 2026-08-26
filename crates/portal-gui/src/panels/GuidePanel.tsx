// Öğretme katmanı raili (DESIGN §12.9). İçerik açık olan yüzeye göre değişir (F24):
// paneller lib/guide üzerinden konuyu bildirir, burası dinler. İçerik şimdilik burada
// statik bir harita; ileride portal-core::teaching'ten bağlama-duyarlı gelecek.

import { type ReactNode } from "react";
import { pinGuideTopic, useGuideTopic, type GuideTopic } from "../lib/guide";

interface Topic {
  title: string;
  blocks: { q: string; a: ReactNode }[];
  /** Kısayol haritası (yalnız "keys" konusunda). */
  keys?: { group: string; rows: { k: string[]; d: string }[] }[];
}

// Kısayol haritası. Her satır KODDAN doğrulandı — ezberden yazılmadı:
// App.tsx (Ctrl+K/B/F) · CommandPalette.tsx (⇧⇧, ok tuşları) · HostsPanel.tsx (E,
// satırda Enter/Space) · TerminalPanel.tsx (attachCustomKeyEventHandler + arama
// şeridi) · EditorPanel.tsx (Ctrl+S) · FilesPanel.tsx (yol kutusu, filtre).
// Yeni bir kısayol bağlarken buraya da bir satır ekle; tek liste burasıdır.
const KEYMAP: NonNullable<Topic["keys"]> = [
  {
    group: "Anywhere",
    rows: [
      { k: ["Shift", "Shift"], d: "Command palette — jump to any server or action" },
      { k: ["Ctrl", "F"], d: "Find a server (inside a terminal this searches its output instead)" },
      { k: ["Ctrl", "B"], d: "Show or hide the left column" },
      { k: ["Ctrl", "K"], d: "Reset the window layout to its default" },
      { k: ["Esc"], d: "Close whatever is on top — dialog, palette, menu" },
    ],
  },
  {
    group: "Command palette",
    rows: [
      { k: ["↑ ↓"], d: "Move through the results" },
      { k: ["Enter"], d: "Run the selected command" },
    ],
  },
  {
    group: "Hosts",
    rows: [
      { k: ["Enter"], d: "Open the focused server's page" },
      { k: ["E"], d: "Edit the selected server (not while you're typing in a box)" },
    ],
  },
  {
    group: "Terminal",
    rows: [
      { k: ["Ctrl", "F"], d: "Find in the output" },
      { k: ["Enter"], d: "Next match · Shift+Enter for the previous one" },
      { k: ["Ctrl", "+"], d: "Bigger text (applies to every terminal, and is remembered)" },
      { k: ["Ctrl", "−"], d: "Smaller text" },
      { k: ["Ctrl", "0"], d: "Back to the default size" },
    ],
  },
  {
    group: "Files",
    rows: [
      { k: ["Enter"], d: "Go to the folder you typed in the path box" },
      { k: ["Esc"], d: "Close the filter box" },
      { k: ["Ctrl", "S"], d: "Save the file you're editing back to the server" },
    ],
  },
];

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
  keys: {
    title: "Keyboard",
    blocks: [
      {
        q: "What is this?",
        a: (
          <>
            Every shortcut Portal listens for. You can add a server and connect to it without
            touching the mouse — tab to the <span className="mono">Hosts</span> icon on the
            left, press <span className="mono">Enter</span>, and keep going.
          </>
        ),
      },
    ],
    keys: KEYMAP,
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
          {g.keys?.map((grp) => (
            <div className="blk" key={grp.group}>
              <p className="q">{grp.group}</p>
              <dl className="keymap">
                {grp.rows.map((r) => (
                  <div className="keyrow" key={r.d}>
                    <dt>
                      {r.k.map((k, i) => (
                        <span key={i}>
                          {i > 0 && <span className="keyplus">+</span>}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{r.d}</dd>
                  </div>
                ))}
              </dl>
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
