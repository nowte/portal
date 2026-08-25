// Files — iki panel (This PC ⇄ host, SFTP). Sürükle-bırak transfer + alt transfer
// kuyruğu (ilerleme/iptal). SftpEvent köprüsü: portal://sftp/{id}.
//
// Uzak gezinme home'a görelidir (bağlantı cwd'si login diziniyle sabit) → "foo/bar"
// gibi göreli yollar her read_dir'de home'a çözülür; böylece realpath gerekmez.

import { useCallback, useEffect, useRef, useState } from "react";
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
function remoteInto(p: string, name: string): string {
  return p && p !== "." ? `${p}/${name}` : name;
}
function remoteUp(p: string): string {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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
  const parts = path.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ name: p, path: acc });
  }
  return out;
}

// deferConnect: bkz. TerminalPanel — diskten geri yüklenen pane kendiliğinden bağlanmaz.
export function FilesPanel({ hostId, deferConnect }: { hostId: string; deferConnect?: boolean }) {
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
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [remoteSel, setRemoteSel] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dropSide, setDropSide] = useState<"local" | "remote" | null>(null);
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
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
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
      reportConn(id, hostId, "files", "connecting");
      unlistenRef.current = await onSftp(id, (m) => {
        switch (m.type) {
          case "hostKey":
            setHostKey(m);
            break;
          case "ready":
            readyRef.current = true;
            setPhase("ready");
            reportConn(id, hostId, "files", "connected");
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
            reportConn(id, hostId, "files", "error");
            setMessage(m.message);
            break;
        }
      });
    } catch (e) {
      setPhase("error");
      setMessage(String(e));
    }
  }, [host, hostId, loadLocal, loadRemote, reportConn]);

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

  // ── sürükle-bırak ──
  const onDrop = (side: "local" | "remote", e: React.DragEvent) => {
    e.preventDefault();
    setDropSide(null);
    const id = sessionRef.current;
    if (id == null) return;
    let item: DragItem;
    try {
      item = JSON.parse(e.dataTransfer.getData("application/portal"));
    } catch {
      return;
    }
    if (item.isDir) return; // klasör transferi henüz yok
    if (item.side === "local" && side === "remote") {
      void sftpUpload(id, item.path, remoteInto(remotePathRef.current, item.name));
    } else if (item.side === "remote" && side === "local") {
      const dest = localPathRef.current + localSep(localPathRef.current) + item.name;
      void sftpDownload(id, item.path, dest);
    }
  };
  const dragStart = (item: DragItem, e: React.DragEvent) => {
    e.dataTransfer.setData("application/portal", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };

  const active = transfers.filter((t) => t.status === "active").length;

  return (
    <div className="files" onPointerDown={() => setGuideTopic("files")}>
      <div className="files-panes">
        {/* This PC */}
        <div
          className={"fpane" + (dropSide === "local" ? " drop" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDropSide("local");
          }}
          onDragLeave={() => setDropSide(null)}
          onDrop={(e) => onDrop("local", e)}
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
                draggable={!en.isDir}
                onClick={() => setLocalSel(en.path)}
                onDragStart={(e) =>
                  dragStart({ side: "local", name: en.name, path: en.path, isDir: en.isDir }, e)
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
          className={"fpane" + (dropSide === "remote" ? " drop" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDropSide("remote");
          }}
          onDragLeave={() => setDropSide(null)}
          onDrop={(e) => onDrop("remote", e)}
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
            <button className="tool" title="Up" onClick={remoteGoUp} disabled={!remotePath}>
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <SpinButton className="tool" title="Refresh" onRun={() => loadRemote(remotePath)} />
          </div>
          <div className="fpath crumbs">
            <button className="crumb" onClick={() => goRemote("")} title="Home">
              ~
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
              <div className="empty err">
                <span className="mk" />
                <span>
                  Couldn&apos;t open files on this server.
                  <span className="raw">{message}</span>
                </span>
              </div>
            )}
            {remoteErr && (
              <div className="empty err">
                <span className="mk" />
                <span>
                  Couldn&apos;t read this folder.
                  <span className="raw">{remoteErr}</span>
                </span>
              </div>
            )}
            {phase === "ready" &&
              remote.map((en: RemoteEntry) => (
                <div
                  key={en.name}
                  className={"frow" + (remoteSel === en.name ? " sel" : "")}
                  draggable={!en.isDir}
                  onClick={() => setRemoteSel(en.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRemoteSel(en.name);
                    setMenu({ entry: en, x: e.clientX, y: e.clientY });
                  }}
                  onDragStart={(e) =>
                    dragStart(
                      {
                        side: "remote",
                        name: en.name,
                        path: remoteInto(remotePath, en.name),
                        isDir: en.isDir,
                      },
                      e,
                    )
                  }
                  onDoubleClick={() => en.isDir && openRemoteDir(en.name)}
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

      {/* Uzak sağ-tık menüsü */}
      {menu && (
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
        </div>
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
