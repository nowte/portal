// Uzak metin dosyası editörü (gömülü). Files panelinde bir metin dosyasına çift
// tıklayınca açılır.
//
// SFTP oturumunu AÇAN Files paneliyle PAYLAŞIR: ikinci bir bağlantı açmaz, ikinci
// parola sormaz. Bedeli, o Files paneli kapanırsa oturumun da kapanması — bu durumda
// editör kaydetmeyi reddeder ve nedenini söyler (sessizce veri kaybetmez).
//
// İkili dosya buraya hiç gelmez: boyut sınırı çağıran tarafta (listedeki `size`),
// UTF-8 kontrolü köprüde (session.rs → editError).

import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { sftpRead, sftpWrite } from "../lib/ipc";
import type { SftpMsg } from "../lib/types";
import { floatEditor } from "../dock/dock";
import { ErrorNote } from "../components/ErrorNote";

export function EditorPanel({
  hostId,
  sessionId,
  path,
  floating,
}: {
  hostId: string;
  sessionId: number;
  path: string;
  /** Zaten yüzen pencerede miyiz? (Float düğmesi gizlenir.) */
  floating?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = text !== null && saved !== null && text !== saved;

  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    void (async () => {
      un = await listen<SftpMsg>(`portal://sftp/${sessionId}`, (e) => {
        if (!alive) return;
        const m = e.payload;
        // Aynı kanalı Files paneli de dinliyor → yalnız BU dosyaya ait mesajlar.
        if (m.type === "remoteContent" && m.path === path) {
          setText(m.text);
          setSaved(m.text);
          setBusy(null);
          setError(null);
        } else if (m.type === "editError" && m.path === path) {
          setError(m.message);
          setBusy(null);
        } else if (m.type === "writeDone" && m.path === path) {
          setSaved((s) => (s === null ? s : areaRef.current?.value ?? s));
          setBusy(null);
        } else if (m.type === "error") {
          setError(m.message);
          setBusy(null);
        }
      });
      void sftpRead(sessionId, path).catch((err: unknown) => {
        setError(String(err));
        setBusy(null);
      });
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, [sessionId, path]);

  const save = useCallback(() => {
    if (text === null || busy) return;
    setBusy("saving");
    setError(null);
    void sftpWrite(sessionId, path, text).catch((err: unknown) => {
      setError(String(err));
      setBusy(null);
    });
  }, [busy, path, sessionId, text]);

  // Ctrl+S: yalnız bu panel odaktayken (global kısayol çalmıyoruz).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="panelbody">
      <section className="edt">
        <div className="edt-head">
          <span className="edt-path mono" title={path}>
            {path}
          </span>
          {dirty && <span className="edt-dot" title="Unsaved changes" />}
          <span className="sp" />
          {!floating && (
            <button
              className="tool"
              title="Open in a floating window (stays above everything)"
              onClick={() => floatEditor(hostId, sessionId, path)}
            >
              Float
            </button>
          )}
          <button
            className="btn-primary"
            onClick={save}
            disabled={!dirty || busy !== null || text === null}
          >
            <Save size={16} strokeWidth={1.75} />
            <span>{busy === "saving" ? "Saving…" : "Save"}</span>
          </button>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {busy === "loading" && !error && <div className="empty">Opening {path}…</div>}

        {text !== null && (
          <textarea
            ref={areaRef}
            className="edt-area mono"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </section>
    </div>
  );
}
