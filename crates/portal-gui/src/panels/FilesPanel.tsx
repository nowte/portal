// Files — iki panel (This PC ⇄ host, SFTP). Sürükle-bırak transfer + alt transfer
// kuyruğu (ilerleme/iptal). SftpEvent köprüsü: portal://sftp/{id}.
//
// Uzak gezinme home'a görelidir (bağlantı cwd'si login diziniyle sabit) → "foo/bar"
// gibi göreli yollar her read_dir'de home'a çözülür; böylece realpath gerekmez.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  Server,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePortal } from "../context";
import { ErrorNote } from "../components/ErrorNote";
import { openEditor } from "../dock/dock";
import { setGuideTopic } from "../lib/guide";
import { requestAuth } from "../components/AuthDialog";
import { HostKeyModal, type HostKeyReq } from "../components/HostKeyModal";
import { SpinButton } from "../components/SpinButton";
import {
  closeSession,
  connectFiles,
  forgetCreds,
  hostIsCached,
  hostKeyDecision,
  listLocal,
  onSftp,
  sftpCancel,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpUpload,
} from "../lib/ipc";
import type { LocalEntry, LocalListing, RemoteEntry } from "../lib/types";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface Transfer {
  id: number;
  kind: "upload" | "download";
  name: string;
  total: number;
  transferred: number;
  status: "active" | "done" | "failed" | "cancelled";
  message?: string;
}

interface DragItem {
  side: "local" | "remote";
  name: string;
  path: string; // local: full path; remote: home-relative path
  isDir: boolean;
}

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
// Uzak yol iki kipte olabilir: "" veya "foo/bar" = HOME-göreli · "/var/www" = MUTLAK.
// Çekirdek ikisini de olduğu gibi `read_dir`'e verir; ayrım yalnız burada kurulur.
function isAbs(p: string): boolean {
  return p.startsWith("/");
}
function remoteInto(p: string, name: string): string {
  if (!p || p === ".") return name;
  if (p === "/") return `/${name}`;
  return `${p}/${name}`;
}
function remoteUp(p: string): string {
  if (isAbs(p)) {
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
/** Kullanıcının yazdığı yolu normalize eder ("~" ve "~/x" → home-göreli). */
function normalizeRemote(input: string): string {
  const t = input.trim();
  if (!t || t === "~") return "";
  if (t.startsWith("~/")) return t.slice(2);
  if (isAbs(t)) return t === "/" ? "/" : t.replace(/\/+$/, "");
  return t.replace(/\/+$/, "");
}
/** Sunucu "izin yok" mu dedi? SFTP sunucuları farklı diller/kodlar döndürür,
 *  bu yüzden metin eşlemesi — yanlış pozitifi zararsız (yalnız mesaj değişir). */
function denied(message: string): boolean {
  return /permission denied|access denied|not permitted|eacces/i.test(message);
}
function localSep(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}
function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
// Uzak yolu (home-göreli) tıklanır breadcrumb parçalarına böler.
function crumbs(path: string): { name: string; path: string }[] {
  const abs = isAbs(path);
  const parts = path.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = abs ? "" : "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ name: p, path: abs ? `/${acc}` : acc });
  }
  return out;
}

// deferConnect: bkz. TerminalPanel — diskten geri yüklenen pane kendiliğinden bağlanmaz.
export function FilesPanel({
  hostId,
  paneId,
  deferConnect,
}: {
  hostId: string;
  /** Dock pane kimliği — bağlantı durumu sekmede bunun üzerinden görünür. */
  paneId?: string;
  deferConnect?: boolean;
}) {
  const { hosts, reportConn, dropConn } = usePortal();
  const host = hosts.find((h) => h.id === hostId);

  const sessionRef = useRef<number | null>(null);
  const readyRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // Transfer yönü (id → upload/download): tamamlanınca doğru tarafı tazelemek için.
  const kindRef = useRef<Map<number, "upload" | "download">>(new Map());

  // "idle" yalnız geri yüklenen (deferConnect) pane'de görülür: bağlanmadan bekler.
  const [phase, setPhase] = useState<"idle" | "connecting" | "ready" | "error">(
    deferConnect ? "idle" : "connecting",
  );
  const [message, setMessage] = useState("");
  const [hostKey, setHostKey] = useState<HostKeyReq | null>(null);

  const [local, setLocal] = useState<LocalListing | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [localSel, setLocalSel] = useState<string | null>(null);
  // "This PC" yol çubuğu düzenlenebilir (C:\Users\... elle yazılabilir).
  const [localInput, setLocalInput] = useState("");
  const [remotePath, setRemotePath] = useState("");
  // Yol çubuğu iki kipli: breadcrumb (gezinme) ↔ yazılabilir alan (sıçrama).
  // Yazılabilir alan olmadan HOME DIŞINA çıkmak imkânsızdı (/var/www gibi).
  const [remoteEdit, setRemoteEdit] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [remoteSel, setRemoteSel] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  // Sürükleme nereden başladı: hedef göstergesi KARŞI panelde çıksın. Kaynak
  // panelin kendi üstünde "Drop to transfer" yazması yanıltıcıydı — oraya
  // bırakmak hiçbir şey yapmıyor (kullanıcı bulgusu).
  const [dragFrom, setDragFrom] = useState<"local" | "remote" | null>(null);
  // ⚠️ Kaynak tarafı AYRICA ref'te tut. `dragover` yerli bir olaydır ve
  // `dragstart`ın hemen ardından tetiklenir; React state o ana kadar
  // güncellenmemiş olabilir. State'e bakıp `preventDefault` atlanınca tarayıcı
  // bırakmayı reddediyordu (transfer hiç başlamıyordu). Ref senkron güncellenir;
  // state yalnız GÖRSEL sınıf için.
  const dragFromRef = useRef<"local" | "remote" | null>(null);
  // Sürükleme hayaleti + üstünde durulan panel (pointer tabanlı sürükleme).
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  const [overSide, setOverSide] = useState<"local" | "remote" | null>(null);
  // Uzak sağ-tık menüsü + isim (mkdir/rename) dialog'u + silme onayı.
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null);
  const [nameDlg, setNameDlg] = useState<{
    mode: "mkdir" | "rename";
    value: string;
    target?: RemoteEntry;
  } | null>(null);
  const [confirmDel, setConfirmDel] = useState<RemoteEntry | null>(null);

  useEffect(() => setGuideTopic("files"), []);

  // Sağ-tık menüsünü dış tıkla / blur ile kapat.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    // Sağ tık `click` üretmez → başka yere sağ tıklayınca bu menü açık kalıyordu.
    // YAKALAMA fazı: hedef `stopPropagation` yapsa bile kapanır (bkz. HostsPanel).
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const remotePathRef = useRef(remotePath);
  remotePathRef.current = remotePath;
  const localPathRef = useRef<string>("");

  const loadLocal = useCallback(async (path: string) => {
    try {
      const l = await listLocal(path);
      localPathRef.current = l.path;
      setLocal(l);
      setLocalInput(l.path);
      setLocalErr(null);
    } catch (e) {
      // Yerel hata yerel panede gösterilir (uzak pane'in mesajını kirletmesin).
      setLocalErr(String(e));
    }
  }, []);

  const loadRemote = useCallback((path: string) => {
    const id = sessionRef.current;
    if (id != null) void sftpList(id, path || ".");
  }, []);

  const connect = useCallback(async () => {
    if (!host) return;
    setPhase("connecting");
    const cached = await hostIsCached(hostId);
    let auth;
    if (!cached) {
      const a = await requestAuth(host);
      if (!a) {
        setPhase("error");
        setMessage("Connect cancelled.");
        return;
      }
      auth = a;
    }
    try {
      const id = await connectFiles(hostId, auth);
      sessionRef.current = id;
      reportConn(id, hostId, "files", "connecting", paneId);
      unlistenRef.current = await onSftp(id, (m) => {
        switch (m.type) {
          case "hostKey":
            setHostKey(m);
            break;
          case "ready":
            readyRef.current = true;
            setPhase("ready");
            reportConn(id, hostId, "files", "connected", paneId);
            loadRemote(remotePathRef.current);
            break;
          case "listing":
            setRemoteErr(null);
            setRemote(m.entries);
            break;
          case "listError":
            setRemoteErr(m.message);
            break;
          case "transferQueued":
            kindRef.current.set(m.id, m.kind);
            setTransfers((t) => [
              ...t,
              {
                id: m.id,
                kind: m.kind,
                name: m.name,
                total: m.total,
                transferred: 0,
                status: "active",
              },
            ]);
            break;
          case "transferProgress":
            setTransfers((t) =>
              t.map((x) => (x.id === m.id ? { ...x, transferred: m.transferred } : x)),
            );
            break;
          case "transferDone":
            setTransfers((t) => t.map((x) => (x.id === m.id ? { ...x, status: "done" } : x)));
            // Tamamlanınca hedef tarafı tazele (yön kindRef'ten; side-effect state
            // güncelleyicisinin dışında).
            if (kindRef.current.get(m.id) === "upload") loadRemote(remotePathRef.current);
            else void loadLocal(localPathRef.current);
            kindRef.current.delete(m.id);
            break;
          case "transferFailed":
            setTransfers((t) =>
              t.map((x) => (x.id === m.id ? { ...x, status: "failed", message: m.message } : x)),
            );
            break;
          case "transferCancelled":
            setTransfers((t) =>
              t.map((x) => (x.id === m.id ? { ...x, status: "cancelled" } : x)),
            );
            break;
          case "error":
            if (!readyRef.current) void forgetCreds(hostId);
            setPhase("error");
            reportConn(id, hostId, "files", "error", paneId);
            setMessage(m.message);
            break;
        }
      });
    } catch (e) {
      setPhase("error");
      setMessage(String(e));
    }
  }, [host, hostId, paneId, loadLocal, loadRemote, reportConn]);

  // Terminal'dekiyle AYNI geri dönüş yolu: dinleyiciyi sök, oturumu kapat, kaydı
  // düşür (yoksa sekmedeki işaret ölü oturumu gösterir), baştan bağlan.
  const retry = () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const id = sessionRef.current;
    if (id != null) {
      void closeSession(id);
      dropConn(id);
    }
    sessionRef.current = null;
    readyRef.current = false;
    setMessage("");
    setRemoteErr(null);
    void connect();
  };

  useEffect(() => {
    // Yerel taraf her hâlükârda yüklenir (bağlantı gerektirmez); uzak taraf bekler.
    void loadLocal("");
    if (!deferConnect) void connect();
    return () => {
      if (unlistenRef.current) unlistenRef.current();
      const id = sessionRef.current;
      if (id != null) {
        void closeSession(id);
        dropConn(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRemoteDir = (name: string) => {
    const next = remoteInto(remotePath, name);
    setRemotePath(next);
    setRemoteSel(null);
    loadRemote(next);
  };
  const remoteGoUp = () => {
    const next = remoteUp(remotePath);
    setRemotePath(next);
    setRemoteSel(null);
    loadRemote(next);
  };
  // Breadcrumb'tan bir dizine atla (home-göreli).
  // Çift tıkla gömülü editörde aç. Büyük dosya editöre GİRMEZ: tamamı belleğe
  // okunuyor ve textarea'da açılıyor — sınır burada, listedeki boyuttan.
  const EDIT_MAX = 2 * 1024 * 1024;
  const openRemoteFile = (en: RemoteEntry) => {
    const id = sessionRef.current;
    if (id == null || !host) return;
    if (en.size > EDIT_MAX) {
      setMessage(`${en.name} is too large to edit here (${human(en.size)}). Download it instead.`);
      return;
    }
    openEditor(hostId, host.label, id, remoteInto(remotePath, en.name));
  };

  const goRemote = (path: string) => {
    setRemotePath(path);
    setRemoteSel(null);
    loadRemote(path);
  };

  // ── transfer aksiyonları (düğme tabanlı; sürükle-bırak ayrıca çalışır) ──
  // Upload: native seçici → seçilen dosyaları GEÇERLİ uzak dizine yükle.
  const uploadPick = async () => {
    const id = sessionRef.current;
    if (id == null) return;
    const sel = await openDialog({ multiple: true, title: "Choose files to upload" });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    for (const p of paths) {
      void sftpUpload(id, p, remoteInto(remotePathRef.current, baseName(p)));
    }
  };
  // Seçili yerel dosyayı uzağa gönder (orta ▲).
  const uploadSelected = () => {
    const id = sessionRef.current;
    const en = local?.entries.find((e) => e.path === localSel);
    if (id == null || !en || en.isDir) return;
    void sftpUpload(id, en.path, remoteInto(remotePathRef.current, en.name));
  };
  // Seçili uzak dosyayı yerele indir (orta ▼) — geçerli "This PC" dizinine.
  const downloadSelected = () => {
    const id = sessionRef.current;
    const en = remote.find((e) => e.name === remoteSel);
    if (id == null || !en || en.isDir) return;
    const dest = localPathRef.current + localSep(localPathRef.current) + en.name;
    void sftpDownload(id, remoteInto(remotePath, en.name), dest);
  };
  // Bir uzak ögeyi (menüden) indir.
  const downloadEntry = (en: RemoteEntry) => {
    const id = sessionRef.current;
    if (id == null || en.isDir) return;
    const dest = localPathRef.current + localSep(localPathRef.current) + en.name;
    void sftpDownload(id, remoteInto(remotePath, en.name), dest);
  };

  // ── uzak dosya işlemleri (mkdir/rename/delete) ──
  const submitName = () => {
    const id = sessionRef.current;
    if (id == null || !nameDlg) return;
    const name = nameDlg.value.trim();
    if (!name) return;
    if (nameDlg.mode === "mkdir") {
      void sftpMkdir(id, remoteInto(remotePathRef.current, name));
    } else if (nameDlg.target && name !== nameDlg.target.name) {
      void sftpRename(
        id,
        remoteInto(remotePathRef.current, nameDlg.target.name),
        remoteInto(remotePathRef.current, name),
      );
    }
    setNameDlg(null);
  };
  const doDelete = () => {
    const id = sessionRef.current;
    if (id == null || !confirmDel) return;
    void sftpRemove(id, remoteInto(remotePath, confirmDel.name), confirmDel.isDir);
    if (remoteSel === confirmDel.name) setRemoteSel(null);
    setConfirmDel(null);
  };

  const decide = (accept: boolean) => {
    const id = sessionRef.current;
    setHostKey(null);
    if (id != null) void hostKeyDecision(id, accept);
    if (!accept) {
      setPhase("error");
      setMessage("Host key rejected.");
    }
  };

  // ── sürükle-bırak: POINTER tabanlı ────────────────────────────────────────
  //
  // ⚠️ HTML5 drag-and-drop KULLANMIYORUZ. Tauri/WebView2'de güvenilmez —
  // dockview için de aynı sebeple `dndStrategy: "pointer"`e geçilmişti
  // (CLAUDE.md §9). Burada `dragstart` çoğu zaman hiç tetiklenmiyordu: sürükleme
  // görsel olarak bile başlamıyor, dolayısıyla `dragover`/`drop` da hiç gelmiyordu.
  //
  // Pointer olayları her yerde çalışır. Akış: pointerdown → eşiği (5px) geçen
  // pointermove → hayalet + hedef vurgusu → pointerup'ta isabet testi.
  const transfer = (item: DragItem, side: "local" | "remote") => {
    const id = sessionRef.current;
    if (id == null) {
      setMessage("Not connected yet — connect this Files panel before transferring.");
      return;
    }
    if (item.isDir) {
      setMessage("Folder transfer isn't supported yet — drag files instead.");
      return;
    }
    if (item.side === side) {
      setMessage("Drop it on the other panel to transfer.");
      return;
    }
    setMessage("");
    if (item.side === "local") {
      void sftpUpload(id, item.path, remoteInto(remotePathRef.current, item.name));
    } else {
      const dest = localPathRef.current + localSep(localPathRef.current) + item.name;
      void sftpDownload(id, item.path, dest);
    }
  };

  /** İmlecin altındaki panel hangisi? (hayalet `pointer-events:none` olduğu için
   *  isabet testine karışmaz.) */
  const paneUnder = (x: number, y: number): "local" | "remote" | null => {
    const el = document.elementFromPoint(x, y)?.closest(".fpane");
    if (!el) return null;
    const panes = Array.from(document.querySelectorAll(".fpane"));
    const i = panes.indexOf(el);
    return i === 0 ? "local" : i === 1 ? "remote" : null;
  };

  const beginDrag = (item: DragItem, e: React.PointerEvent) => {
    if (e.button !== 0 || item.isDir) return; // klasör transferi yok
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        dragFromRef.current = item.side;
        setDragFrom(item.side);
      }
      setGhost({ name: item.name, x: ev.clientX, y: ev.clientY });
      setOverSide(paneUnder(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const over = started ? paneUnder(ev.clientX, ev.clientY) : null;
      dragFromRef.current = null;
      setDragFrom(null);
      setGhost(null);
      setOverSide(null);
      if (started && over) transfer(item, over);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Hedef vurgusu: karşı panel, üstünde duruyorsak. */
  const canDrop = (side: "local" | "remote") => dragFrom !== null && dragFrom !== side;

  const active = transfers.filter((t) => t.status === "active").length;

  return (
    <div className="files" onPointerDown={() => setGuideTopic("files")}>
      {/* Geçici uyarı şeridi. `message` bugüne kadar YALNIZ hata ekranında
          basılıyordu; bağlıyken yapılan uyarılar (bırakma reddedildi, dosya
          editör için çok büyük) hiç görünmüyordu — sessiz başarısızlık. */}
      {phase === "ready" && message && (
        <div className="files-note">
          <ErrorNote>{message}</ErrorNote>
          <button className="tool" title="Dismiss" onClick={() => setMessage("")}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {ghost &&
        // Hayalet de body'ye portallanır: `position: fixed` transform taşıyan bir
        // atanın içinde ONA göre konumlanır (sağ-tık menüsündeki tuzağın aynısı) ve
        // hayalet imlecin yanında değil başka bir yerde çizilirdi.
        createPortal(
          <div className="dragghost mono" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
            {ghost.name}
          </div>,
          document.body,
        )}
      <div className="files-panes">
        {/* This PC */}
        <div
          className={
            "fpane" + (canDrop("local") ? " drop" : "") + (overSide === "local" ? " over" : "")
          }
        >
          <div className="fpane-head">
            <HardDrive size={16} strokeWidth={1.75} />
            <span className="fpane-t">This PC</span>
            <button
              className="tool"
              title="Up"
              onClick={() => local?.parent && void loadLocal(local.parent)}
              disabled={!local?.parent}
            >
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <SpinButton
              className="tool"
              title="Refresh"
              onRun={() => void loadLocal(localPathRef.current)}
            />
          </div>
          <input
            className="fpath fpath-edit mono"
            value={localInput}
            spellCheck={false}
            placeholder="Type a path, e.g. C:\Users\you\Downloads"
            onChange={(e) => setLocalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadLocal(localInput.trim());
            }}
          />
          <div className="flist">
            {localErr && <div className="empty term-err">{localErr}</div>}
            {!localErr && local?.entries.length === 0 && (
              <div className="empty">This folder is empty.</div>
            )}
            {(local?.entries ?? []).map((en: LocalEntry) => (
              <div
                key={en.path}
                className={"frow" + (localSel === en.path ? " sel" : "")}
                onClick={() => setLocalSel(en.path)}
                onPointerDown={(e) =>
                  beginDrag({ side: "local", name: en.name, path: en.path, isDir: en.isDir }, e)
                }
                onDoubleClick={() => {
                  setLocalSel(null);
                  if (en.isDir) void loadLocal(en.path);
                }}
              >
                {en.isDir ? (
                  <Folder size={16} strokeWidth={1.75} className="ficon" />
                ) : (
                  <FileText size={16} strokeWidth={1.75} className="ficon dim" />
                )}
                <span className="fname">{en.name}</span>
                {!en.isDir && <span className="fsize mono">{human(en.size)}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="files-mid">
          <button
            className="mid-x"
            title="Upload selected file to the host"
            onClick={uploadSelected}
            disabled={phase !== "ready" || !localSel}
          >
            <Upload size={16} strokeWidth={2} />
          </button>
          <button
            className="mid-x"
            title="Download selected file to this PC"
            onClick={downloadSelected}
            disabled={phase !== "ready" || !remoteSel}
          >
            <Download size={16} strokeWidth={2} />
          </button>
        </div>

        {/* Host */}
        <div
          className={
            "fpane" + (canDrop("remote") ? " drop" : "") + (overSide === "remote" ? " over" : "")
          }
        >
          <div className="fpane-head">
            <Server size={16} strokeWidth={1.75} />
            <span className="fpane-t">{host?.label ?? "host"}</span>
            <button
              className="tool up-btn"
              title="Upload files here"
              onClick={() => void uploadPick()}
              disabled={phase !== "ready"}
            >
              <Upload size={16} strokeWidth={1.75} />
              <span>Upload</span>
            </button>
            <button
              className="tool"
              title="New folder"
              onClick={() => setNameDlg({ mode: "mkdir", value: "" })}
              disabled={phase !== "ready"}
            >
              <FolderPlus size={16} strokeWidth={1.75} />
            </button>
            <button
              className="tool"
              title="Up"
              onClick={remoteGoUp}
              disabled={!remotePath || remotePath === "/"}
            >
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <SpinButton className="tool" title="Refresh" onRun={() => loadRemote(remotePath)} />
          </div>
          {remoteEdit !== null ? (
            <input
              className="fpath fpath-edit mono"
              value={remoteEdit}
              spellCheck={false}
              autoFocus
              placeholder="Type a path, e.g. /var/www"
              onChange={(e) => setRemoteEdit(e.target.value)}
              onBlur={() => setRemoteEdit(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = normalizeRemote(remoteEdit);
                  setRemoteEdit(null);
                  goRemote(next);
                } else if (e.key === "Escape") {
                  setRemoteEdit(null);
                }
              }}
            />
          ) : (
            <div
              className="fpath crumbs"
              title="Click to type a path"
              onClick={(e) => {
                // Yalnız çubuğun BOŞLUĞUNA tıklayınca yazma kipine geç; crumb'a
                // tıklamak gezinmeye devam etsin.
                if (e.target === e.currentTarget) setRemoteEdit(remotePath);
              }}
            >
              <button className="crumb" onClick={() => goRemote("")} title="Home">
                ~
              </button>
              <button className="crumb" onClick={() => goRemote("/")} title="Filesystem root">
                /
              </button>
              {crumbs(remotePath).map((c) => (
                <span className="crumb-seg" key={c.path}>
                  <ChevronRight size={16} strokeWidth={1.75} className="crumb-sep" />
                  <button className="crumb" onClick={() => goRemote(c.path)}>
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flist">
            {phase === "idle" && (
              <div className="pane-idle">
                <div className="pane-idle-t">Not connected</div>
                <div className="pane-idle-s">
                  Portal restored this panel's position but didn't reconnect on its own.
                </div>
                <button className="btn-primary" onClick={() => void connect()}>
                  <span>Connect</span>
                </button>
              </div>
            )}
            {phase === "connecting" && (
              <div className="conn-row">
                <span className="st" />
                Connecting…
              </div>
            )}
            {phase === "error" && (
              <div className="err-retry">
                {/* Simge ErrorNote'tan gelir: buradaki `.mk` noktasının hiç kuralı
                    yoktu, yani hata İŞARETSİZ çiziliyordu (renk de tek taşıyıcı
                    olamaz, §9). */}
                <ErrorNote>
                  Couldn&apos;t open files on this server.
                  <span className="raw">{message}</span>
                </ErrorNote>
                <button className="btn-primary" onClick={retry}>
                  <span>Retry</span>
                </button>
              </div>
            )}
            {remoteErr && (
              <div className="empty err">
                <span className="mk" />
                <span>
                  {denied(remoteErr) ? (
                    <>
                      Permission denied. Portal reads files as{" "}
                      <b>{host?.username ?? "the user you connected with"}</b>, and that
                      account can&apos;t open this folder. Connect as a user that can, or
                      open a terminal here and use <b className="mono">sudo</b>.
                    </>
                  ) : (
                    <>Couldn&apos;t read this folder.</>
                  )}
                  <span className="raw">{remoteErr}</span>
                </span>
              </div>
            )}
            {phase === "ready" &&
              remote.map((en: RemoteEntry) => (
                <div
                  key={en.name}
                  className={"frow" + (remoteSel === en.name ? " sel" : "")}
                  onClick={() => setRemoteSel(en.name)}
                  onPointerDown={(e) =>
                    beginDrag(
                      {
                        side: "remote",
                        name: en.name,
                        path: remoteInto(remotePath, en.name),
                        isDir: en.isDir,
                      },
                      e,
                    )
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRemoteSel(en.name);
                    setMenu({ entry: en, x: e.clientX, y: e.clientY });
                  }}
                  onDoubleClick={() => {
                    if (en.isDir) {
                      openRemoteDir(en.name);
                      return;
                    }
                    openRemoteFile(en);
                  }}
                >
                  {en.isDir ? (
                    <Folder size={16} strokeWidth={1.75} className="ficon" />
                  ) : (
                    <FileText size={16} strokeWidth={1.75} className="ficon dim" />
                  )}
                  <span className="fname">{en.name}</span>
                  {!en.isDir && <span className="fsize mono">{human(en.size)}</span>}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Transfer kuyruğu */}
      <div className="xfers">
        <div className="xfers-head">
          Transfers {active > 0 && <span className="xfers-badge">{active} active</span>}
        </div>
        <div className="xfers-list">
          {transfers.length === 0 ? (
            <div className="xfers-empty">
              Use <b>Upload</b>, the arrow buttons on a selected file, or drag between the panels.
            </div>
          ) : (
            transfers
              .slice()
              .reverse()
              .map((t) => {
                const pct = t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : 0;
                return (
                  <div className="xfer" key={t.id}>
                    <span className="xfer-dir">
                      {t.kind === "upload" ? (
                        <Upload size={16} strokeWidth={2} />
                      ) : (
                        <Download size={16} strokeWidth={2} />
                      )}
                    </span>
                    <div className="xfer-body">
                      <div className="xfer-top">
                        <span className="xfer-name">{t.name}</span>
                        <span className="xfer-stat mono">
                          {t.status === "active"
                            ? `${human(t.transferred)}${t.total ? ` / ${human(t.total)}` : ""}`
                            : t.status}
                        </span>
                      </div>
                      <div className="xfer-bar">
                        <i
                          className={"xfer-fill s-" + t.status}
                          style={{ transform: `scaleX(${(t.status === "done" ? 100 : pct) / 100})` }}
                        />
                      </div>
                    </div>
                    {t.status === "active" && (
                      <button
                        className="tool"
                        title="Cancel"
                        onClick={() => {
                          const id = sessionRef.current;
                          if (id != null) void sftpCancel(id, t.id);
                        }}
                      >
                        <X size={16} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                );
              })
          )}
        </div>
      </div>

      {hostKey && <HostKeyModal req={hostKey} onDecision={decide} />}

      {/* Uzak sağ-tık menüsü — body'ye portal (bkz. ContextMenu: fixed, transform
          taşıyan bir atanın içinde tıklanan yerden uzakta çıkıyordu). */}
      {menu &&
        createPortal(
        <div
          className="ctx"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 160),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {!menu.entry.isDir && (
            <button
              className="ctx-item"
              onClick={() => {
                downloadEntry(menu.entry);
                setMenu(null);
              }}
            >
              <Download size={16} strokeWidth={1.75} /> Download
            </button>
          )}
          {menu.entry.isDir && (
            <button
              className="ctx-item"
              onClick={() => {
                openRemoteDir(menu.entry.name);
                setMenu(null);
              }}
            >
              <Folder size={16} strokeWidth={1.75} /> Open
            </button>
          )}
          <button
            className="ctx-item"
            onClick={() => {
              setNameDlg({ mode: "rename", value: menu.entry.name, target: menu.entry });
              setMenu(null);
            }}
          >
            <Pencil size={16} strokeWidth={1.75} /> Rename
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => {
              setConfirmDel(menu.entry);
              setMenu(null);
            }}
          >
            <Trash2 size={16} strokeWidth={1.75} /> Delete
          </button>
        </div>,
          document.body,
        )}

      {/* İsim dialog'u (yeni klasör / yeniden adlandır) */}
      {nameDlg && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setNameDlg(null)}>
          <div className="dialog" role="dialog" aria-label={nameDlg.mode === "mkdir" ? "New folder" : "Rename"}>
            <div className="dlg-head">
              <span className="dlg-title">{nameDlg.mode === "mkdir" ? "New folder" : "Rename"}</span>
              <button className="dlg-x" aria-label="Close" onClick={() => setNameDlg(null)}>
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <label className="fld">
              <span className="fld-k">{nameDlg.mode === "mkdir" ? "Folder name" : "New name"}</span>
              <input
                autoFocus
                value={nameDlg.value}
                onChange={(e) => setNameDlg({ ...nameDlg, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitName();
                  if (e.key === "Escape") setNameDlg(null);
                }}
                placeholder={nameDlg.mode === "mkdir" ? "e.g. deploy" : ""}
              />
            </label>
            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => setNameDlg(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={submitName} disabled={!nameDlg.value.trim()}>
                {nameDlg.mode === "mkdir" ? "Create" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Silme onayı */}
      {confirmDel && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDel(null)}>
          <div className="dialog" role="dialog" aria-label="Delete">
            <div className="dlg-head">
              <span className="dlg-title">Delete {confirmDel.isDir ? "folder" : "file"}?</span>
              <button className="dlg-x" aria-label="Close" onClick={() => setConfirmDel(null)}>
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <p className="dlg-sub">
              <b className="mono">{confirmDel.name}</b> will be permanently removed from the host.
              {confirmDel.isDir && " The folder must be empty."} This can't be undone.
            </p>
            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => setConfirmDel(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={doDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
