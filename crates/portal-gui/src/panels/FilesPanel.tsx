// Files — iki panel (This PC ⇄ host, SFTP). Sürükle-bırak transfer + alt transfer
// kuyruğu (ilerleme/iptal/tekrar). SftpEvent köprüsü: portal://sftp/{id}.
//
// Uzak gezinme home'a görelidir (bağlantı cwd'si login diziniyle sabit) → "foo/bar"
// gibi göreli yollar her read_dir'de home'a çözülür; böylece realpath gerekmez.
//
// P9 (derinlik): çoklu seçim (Shift aralık / Ctrl tek tek) · gizli dosya anahtarı ·
// sütuna göre sıralama · panel içi filtre (çekirdeğin fuzzy'si) · başarısız
// transferde "Try again" · hedefte aynı ad varsa Overwrite/Skip/Rename sorusu.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  RotateCw,
  Search,
  Server,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePortal } from "../context";
import { ErrorNote } from "../components/ErrorNote";
import { useModal } from "../lib/modal";
import { openEditor } from "../dock/dock";
import { setGuideTopic } from "../lib/guide";
import { requestAuth } from "../components/AuthDialog";
import { HostKeyModal, type HostKeyReq } from "../components/HostKeyModal";
import { SpinButton } from "../components/SpinButton";
import {
  closeSession,
  connectFiles,
  forgetCreds,
  freeNames,
  fuzzyFilter,
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
  // Kaynak + hedef, çekirdekten geldiği gibi: "Try again" aynı transferi kurar.
  local: string;
  remote: string;
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

/** Bir transfer isteği. `src` yerelde tam yol, uzakta home-göreli yoldur;
 *  `name` hedef dizinde alacağı addır (çakışmada değişebilir). */
interface Job {
  kind: "upload" | "download";
  src: string;
  name: string;
}

type SortKey = "name" | "size" | "date";

/** Bir panelin görünüm durumu — iki panel birbirinden bağımsız ayarlanır. */
interface View {
  sort: SortKey;
  desc: boolean;
  hidden: boolean;
  filter: string;
  finding: boolean;
}
const VIEW0: View = { sort: "name", desc: false, hidden: false, filter: "", finding: false };

/** Sıralama/filtreleme için iki panelin ortak satır biçimi. */
interface Row {
  name: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  hidden?: boolean;
}

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
// Locale SABİT (en-GB): `undefined` makinenin diline döner ve bu makinede tarih
// Türkçe çıkıyordu — arayüzün geri kalanı İngilizce (CLAUDE.md §9 "Genel").
function when(secs: number | null | undefined): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} ${d
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
/** Uzak tarafta gizlilik yalnız addan okunur (POSIX noktası); yerel tarafta
 *  çekirdek Windows'un HIDDEN özniteliğini de katar. */
function isHidden(en: Row): boolean {
  return en.hidden ?? en.name.startsWith(".");
}
/** Klasörler HER ZAMAN önce (sıra tersine çevrilse de) — dizin ağacında gezinme
 *  sırası, sıralama tercihine kurban edilmez. */
function sortRows<T extends Row>(rows: T[], view: View): T[] {
  const dir = view.desc ? -1 : 1;
  return rows.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let d = 0;
    if (view.sort === "size") d = a.size - b.size;
    else if (view.sort === "date") d = (a.modified ?? 0) - (b.modified ?? 0);
    if (d === 0) d = a.name.localeCompare(b.name, "en");
    return d * dir;
  });
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

/** Görünen satırlar: gizlileri ele → çekirdeğin fuzzy'siyle filtrele → sırala.
 *  İki panel de bunu kullanır (tek gövde; ikinci bir arama uygulaması yok). */
function useRows<T extends Row>(entries: T[], view: View): T[] {
  const base = useMemo(
    () => entries.filter((e) => view.hidden || !isHidden(e)),
    [entries, view.hidden],
  );
  // Eşleşen ADLAR (indeks değil): filtre yanıtı geldiğinde liste değişmiş olabilir,
  // indeks o an başka bir dosyayı gösterirdi.
  const [hits, setHits] = useState<Set<string> | null>(null);
  const q = view.filter.trim();
  useEffect(() => {
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    void fuzzyFilter(
      q,
      base.map((e) => e.name),
    ).then((ix) => {
      if (alive) setHits(new Set(ix.map((i) => base[i]?.name).filter(Boolean)));
    });
    return () => {
      alive = false;
    };
  }, [q, base]);
  return useMemo(
    () => sortRows(q && hits ? base.filter((e) => hits.has(e.name)) : base, view),
    [base, hits, q, view],
  );
}

/** Sütun başlığı = sıralama kontrolü. Ayrı bir menü yok: sıralanan sütunun
 *  başlığında yön oku durur. Kolonlar satırdakilerle aynı genişlikte. */
function SortBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  const hit = (key: SortKey) =>
    onView(view.sort === key ? { ...view, desc: !view.desc } : { ...view, sort: key, desc: false });
  const arrow = (key: SortKey) =>
    view.sort !== key ? null : view.desc ? (
      <ChevronDown size={16} strokeWidth={1.75} />
    ) : (
      <ChevronUp size={16} strokeWidth={1.75} />
    );
  return (
    <div className="ftools">
      <span className="ftools-pad" />
      <button
        className={"fsort fsort-n" + (view.sort === "name" ? " on" : "")}
        onClick={() => hit("name")}
        title="Sort by name"
      >
        Name {arrow("name")}
      </button>
      <button
        className={"fsort fsort-s" + (view.sort === "size" ? " on" : "")}
        onClick={() => hit("size")}
        title="Sort by size"
      >
        Size {arrow("size")}
      </button>
      <button
        className={"fsort fsort-d" + (view.sort === "date" ? " on" : "")}
        onClick={() => hit("date")}
        title="Sort by date modified"
      >
        Modified {arrow("date")}
      </button>
    </div>
  );
}

/** Panel içi filtre şeridi — yalnız açıkken render edilir (terminalin Ctrl+F
 *  şeridiyle aynı fikir: arama kalıcı bir kutu değil, çağrılan bir araç). */
function FindBar({
  view,
  onView,
  shown,
  total,
}: {
  view: View;
  onView: (v: View) => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="fwrap ffind">
      <Search size={16} strokeWidth={1.75} />
      <input
        autoFocus
        value={view.filter}
        spellCheck={false}
        placeholder="Filter this folder"
        onChange={(e) => onView({ ...view, filter: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") onView({ ...view, filter: "", finding: false });
        }}
      />
      {view.filter.trim() && (
        <span className="ffind-n mono">
          {shown}/{total}
        </span>
      )}
      <button
        className="tool"
        title="Close filter"
        aria-label="Close filter"
        onClick={() => onView({ ...view, filter: "", finding: false })}
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
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
  // Seçim ÇOKLU: yerelde tam yol, uzakta ad (o dizindeki benzersiz anahtar).
  const [localSel, setLocalSel] = useState<string[]>([]);
  // "This PC" yol çubuğu düzenlenebilir (C:\Users\... elle yazılabilir).
  const [localInput, setLocalInput] = useState("");
  const [remotePath, setRemotePath] = useState("");
  // Yol çubuğu iki kipli: breadcrumb (gezinme) ↔ yazılabilir alan (sıçrama).
  // Yazılabilir alan olmadan HOME DIŞINA çıkmak imkânsızdı (/var/www gibi).
  const [remoteEdit, setRemoteEdit] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [remoteSel, setRemoteSel] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [localView, setLocalView] = useState<View>(VIEW0);
  const [remoteView, setRemoteView] = useState<View>(VIEW0);
  // Shift aralığının çıpası (son "düz" tıklama).
  const localAnchor = useRef<string | null>(null);
  const remoteAnchor = useRef<string | null>(null);
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
  const [confirmDel, setConfirmDel] = useState<RemoteEntry[] | null>(null);
  // Hedefte aynı ad var: çakışma kuyruğu + her biri için çekirdeğin önerdiği
  // serbest ad (`suggest`) + kullanıcının o an düzenlediği ad + "hepsine uygula".
  const [conflict, setConflict] = useState<{
    queue: Job[];
    suggest: string[];
    i: number;
    rename: string;
  } | null>(null);
  const [applyAll, setApplyAll] = useState(false);

  const localRows = useRows(local?.entries ?? [], localView);
  const remoteRows = useRows(remote, remoteView);

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

  // Bağlanma denemesi sayacı — iptal edilen bir deneme geri döndüğünde kendi
  // oturumunu kapatır ve ekranı ezmez. Bkz. TerminalPanel (aynı desen).
  const genRef = useRef(0);
  // "Bağlı değil" kartının alt satırı. `message` uzak panelin hata şeridine ait,
  // ikisi karışmasın.
  const [idleNote, setIdleNote] = useState("");

  const connect = useCallback(async () => {
    if (!host) return;
    setPhase("connecting");
    setIdleNote("");
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    const cached = await hostIsCached(hostId);
    if (stale()) return;
    let auth;
    if (!cached) {
      const a = await requestAuth(host);
      if (stale()) return;
      if (!a) {
        setPhase("error");
        setMessage("Cancelled — nothing was sent to the server. Press Retry when you're ready.");
        return;
      }
      auth = a;
    }
    try {
      const id = await connectFiles(hostId, auth);
      if (stale()) {
        void closeSession(id);
        return;
      }
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
                local: m.local,
                remote: m.remote,
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
      if (stale()) return;
      setPhase("error");
      setMessage(String(e));
    }
  }, [host, hostId, paneId, loadLocal, loadRemote, reportConn]);

  // Üç küçük diyalog da modal davranışını TEK yerden alır (Esc + odak tuzağı):
  // buradaki × ile Esc aynı şeyi yapar, kaçış tuşu her zaman geri dönüş yoludur.
  const nameBoxRef = useRef<HTMLDivElement>(null);
  const conflictBoxRef = useRef<HTMLDivElement>(null);
  const delBoxRef = useRef<HTMLDivElement>(null);
  useModal(nameBoxRef, () => setNameDlg(null), nameDlg !== null);
  useModal(conflictBoxRef, () => setConflict(null), conflict !== null);
  useModal(delBoxRef, () => setConfirmDel(null), confirmDel !== null);

  // Bağlanmayı yarıda kes; çekirdek el sıkışmayı da keser (ssh.rs Cancel).
  const cancelConnect = () => {
    genRef.current++;
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
    setPhase("idle");
    // İptal edilen bir bağlanma "düzen geri yüklendi" DEĞİLDİR: idle kartı
    // kullanıcının az önce yaptığı şeyi anlatsın.
    setIdleNote("Cancelled before the server answered.");
    setMessage("");
  };

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
    setRemoteSel([]);
    loadRemote(next);
  };
  const remoteGoUp = () => {
    const next = remoteUp(remotePath);
    setRemotePath(next);
    setRemoteSel([]);
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
    setRemoteSel([]);
    loadRemote(path);
  };

  // ── seçim ─────────────────────────────────────────────────────────────────
  // Shift = çıpadan buraya aralık · Ctrl = tek tek ekle/çıkar · düz tık = yalnız bu.
  // Aralık GÖRÜNEN sıraya göre alınır (sıralama/filtre neyse o) — gizli ya da
  // elenmiş bir satır aralığa sızmaz.
  const pick = (
    e: React.MouseEvent,
    key: string,
    keys: string[],
    sel: string[],
    setSel: (v: string[]) => void,
    anchor: React.MutableRefObject<string | null>,
  ) => {
    if (e.shiftKey && anchor.current) {
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        setSel(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSel(sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key]);
      anchor.current = key;
      return;
    }
    setSel([key]);
    anchor.current = key;
  };

  const selLocal = localRows.filter((e) => localSel.includes(e.path));
  const selRemote = remoteRows.filter((e) => remoteSel.includes(e.name));
  const selLocalFiles = selLocal.filter((e) => !e.isDir);
  const selRemoteFiles = selRemote.filter((e) => !e.isDir);

  // ── transfer aksiyonları ──────────────────────────────────────────────────
  // Hedef dizin HER ZAMAN o an açık olan dizindir → çakışma kontrolü elimizdeki
  // listeden yapılır, ek bir tur gerekmez.
  const takenFor = useCallback(
    (kind: "upload" | "download"): Set<string> =>
      kind === "upload"
        ? new Set(remote.map((e) => e.name))
        : new Set((local?.entries ?? []).map((e) => e.name)),
    [remote, local],
  );

  /** Bir işi çekirdeğe verir; `as` hedefte alacağı addır. */
  const run = useCallback((job: Job, as: string) => {
    const id = sessionRef.current;
    if (id == null) return;
    if (job.kind === "upload") {
      void sftpUpload(id, job.src, remoteInto(remotePathRef.current, as));
    } else {
      void sftpDownload(id, job.src, localPathRef.current + localSep(localPathRef.current) + as);
    }
  }, []);

  /** Çakışmayanları hemen başlatır, çakışanları soru kuyruğuna alır. */
  const dispatch = useCallback(
    (jobs: Job[]) => {
      const id = sessionRef.current;
      if (id == null) {
        setMessage("Not connected yet — connect this Files panel before transferring.");
        return;
      }
      if (!jobs.length) return;
      setMessage("");
      const clash: Job[] = [];
      for (const j of jobs) {
        if (takenFor(j.kind).has(j.name)) clash.push(j);
        else run(j, j.name);
      }
      if (clash.length) {
        setApplyAll(false);
        // Öneriler TEK çağrıda gelir ve birbirine de çarpmaz — aynı ada düşen iki
        // dosya aynı yeni adı almaz.
        void freeNames(
          [...takenFor(clash[0].kind)],
          clash.map((j) => j.name),
        ).then((suggest) =>
          setConflict({ queue: clash, suggest, i: 0, rename: suggest[0] ?? clash[0].name }),
        );
      }
    },
    [run, takenFor],
  );

  /** Çakışma cevabı. "Apply to all" ile kalan çakışmalar da aynı yolu izler;
   *  Rename'de kalanlara otomatik benzersiz ad verilir (her biri elle
   *  yazılamayacağı için — kullanıcı yine de tek tek gidebilir). */
  const resolveConflict = (choice: "overwrite" | "skip" | "rename") => {
    if (!conflict) return;
    const { queue, suggest, i, rename } = conflict;
    const apply = (at: number) => {
      if (choice === "skip") return;
      const job = queue[at];
      const as =
        choice === "overwrite"
          ? job.name
          : at === i
            ? rename.trim() || suggest[at] || job.name
            : suggest[at] || job.name;
      run(job, as);
    };
    if (applyAll) {
      for (let k = i; k < queue.length; k += 1) apply(k);
      setConflict(null);
      return;
    }
    apply(i);
    const next = i + 1;
    if (next < queue.length) {
      setConflict({ queue, suggest, i: next, rename: suggest[next] ?? queue[next].name });
    } else {
      setConflict(null);
    }
  };

  // Upload: native seçici → seçilen dosyaları GEÇERLİ uzak dizine yükle.
  const uploadPick = async () => {
    if (sessionRef.current == null) return;
    const sel = await openDialog({ multiple: true, title: "Choose files to upload" });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    dispatch(paths.map((p) => ({ kind: "upload" as const, src: p, name: baseName(p) })));
  };
  // Seçili yerel dosyaları uzağa gönder (orta ▲).
  const uploadSelected = () =>
    dispatch(selLocalFiles.map((e) => ({ kind: "upload" as const, src: e.path, name: e.name })));
  // Seçili uzak dosyaları yerele indir (orta ▼) — geçerli "This PC" dizinine.
  const downloadSelected = () =>
    dispatch(
      selRemoteFiles.map((e) => ({
        kind: "download" as const,
        src: remoteInto(remotePath, e.name),
        name: e.name,
      })),
    );

  /** Başarısız transferi AYNI argümanlarla yeniden kurar. Eski satır düşer —
   *  çekirdek yeni bir kimlikle yeni bir satır açacak. */
  const retryTransfer = (t: Transfer) => {
    const id = sessionRef.current;
    if (id == null) {
      setMessage("Not connected — reconnect this Files panel first.");
      return;
    }
    setTransfers((ts) => ts.filter((x) => x.id !== t.id));
    if (t.kind === "upload") void sftpUpload(id, t.local, t.remote);
    else void sftpDownload(id, t.remote, t.local);
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
    for (const en of confirmDel) {
      void sftpRemove(id, remoteInto(remotePath, en.name), en.isDir);
    }
    const gone = new Set(confirmDel.map((e) => e.name));
    setRemoteSel((s) => s.filter((n) => !gone.has(n)));
    setConfirmDel(null);
  };

  const decide = (accept: boolean) => {
    const id = sessionRef.current;
    setHostKey(null);
    if (id != null) void hostKeyDecision(id, accept);
    if (!accept) {
      setPhase("error");
      setMessage(
        "You didn't trust this server's key, so Portal stopped before signing in. Retry to see the fingerprint again.",
      );
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
  const transfer = (items: DragItem[], side: "local" | "remote") => {
    if (sessionRef.current == null) {
      setMessage("Not connected yet — connect this Files panel before transferring.");
      return;
    }
    if (items[0] && items[0].side === side) {
      setMessage("Drop it on the other panel to transfer.");
      return;
    }
    const files = items.filter((i) => !i.isDir);
    if (!files.length) {
      setMessage("Folder transfer isn't supported yet — drag files instead.");
      return;
    }
    if (files.length < items.length) {
      setMessage(`Skipped ${items.length - files.length} folder(s) — only files transfer for now.`);
    }
    dispatch(
      files.map((i) => ({
        kind: i.side === "local" ? ("upload" as const) : ("download" as const),
        src: i.path,
        name: i.name,
      })),
    );
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

  /** Sürüklenen küme: satır seçimin İÇİNDEYSE tüm seçim taşınır, değilse yalnız
   *  o satır (seçimi bozmadan tek dosya sürüklemek mümkün kalsın). */
  const dragSet = (side: "local" | "remote", key: string): DragItem[] => {
    const one = (name: string, path: string, isDir: boolean): DragItem => ({
      side,
      name,
      path,
      isDir,
    });
    if (side === "local") {
      const rows = localSel.includes(key) ? selLocal : localRows.filter((e) => e.path === key);
      return rows.map((e) => one(e.name, e.path, e.isDir));
    }
    const rows = remoteSel.includes(key) ? selRemote : remoteRows.filter((e) => e.name === key);
    return rows.map((e) => one(e.name, remoteInto(remotePath, e.name), e.isDir));
  };

  const beginDrag = (items: DragItem[], e: React.PointerEvent) => {
    if (e.button !== 0 || !items.length) return;
    const side = items[0].side;
    const label = items.length > 1 ? `${items.length} items` : items[0].name;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        dragFromRef.current = side;
        setDragFrom(side);
      }
      setGhost({ name: label, x: ev.clientX, y: ev.clientY });
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
      if (started && over) transfer(items, over);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Hedef vurgusu: karşı panel, üstünde duruyorsak. */
  const canDrop = (side: "local" | "remote") => dragFrom !== null && dragFrom !== side;

  const active = transfers.filter((t) => t.status === "active").length;
  const clash = conflict ? conflict.queue[conflict.i] : null;
  const remaining = conflict ? conflict.queue.length - conflict.i : 0;

  /** Bir panelin başlığındaki arama + gizli anahtarları (iki panelde de aynı). */
  const viewTools = (view: View, onView: (v: View) => void) => (
    <>
      <button
        className={"tool" + (view.finding ? " on" : "")}
        title="Filter this folder"
        aria-label="Filter this folder"
        onClick={() => onView({ ...view, finding: !view.finding, filter: "" })}
      >
        <Search size={16} strokeWidth={1.75} />
      </button>
      <button
        className={"tool" + (view.hidden ? " on" : "")}
        title={view.hidden ? "Hide hidden files" : "Show hidden files"}
        aria-label={view.hidden ? "Hide hidden files" : "Show hidden files"}
        aria-pressed={view.hidden}
        onClick={() => onView({ ...view, hidden: !view.hidden })}
      >
        {view.hidden ? (
          <Eye size={16} strokeWidth={1.75} />
        ) : (
          <EyeOff size={16} strokeWidth={1.75} />
        )}
      </button>
    </>
  );

  return (
    <div className="files" onPointerDown={() => setGuideTopic("files")}>
      {/* Geçici uyarı şeridi. `message` bugüne kadar YALNIZ hata ekranında
          basılıyordu; bağlıyken yapılan uyarılar (bırakma reddedildi, dosya
          editör için çok büyük) hiç görünmüyordu — sessiz başarısızlık. */}
      {phase === "ready" && message && (
        <div className="files-note">
          <ErrorNote>{message}</ErrorNote>
          <button className="tool" title="Dismiss" aria-label="Dismiss this message" onClick={() => setMessage("")}>
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
            {localSel.length > 1 && <span className="fsel-n mono">{localSel.length} selected</span>}
            {viewTools(localView, setLocalView)}
            <button
              className="tool"
              title="Up"
              aria-label="Go up one folder on this PC"
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
          {localView.finding && (
            <FindBar
              view={localView}
              onView={setLocalView}
              shown={localRows.length}
              total={local?.entries.length ?? 0}
            />
          )}
          <SortBar view={localView} onView={setLocalView} />
          <div className="flist">
            {localErr && <div className="empty term-err">{localErr}</div>}
            {!localErr && localRows.length === 0 && (
              <div className="empty">
                {localView.filter.trim()
                  ? "No file matches that filter — clear it to see everything again."
                  : "This folder is empty. Type a path in the box above to go somewhere else."}
              </div>
            )}
            {localRows.map((en: LocalEntry) => (
              <div
                key={en.path}
                className={"frow" + (localSel.includes(en.path) ? " sel" : "")}
                onClick={(e) =>
                  pick(
                    e,
                    en.path,
                    localRows.map((r) => r.path),
                    localSel,
                    setLocalSel,
                    localAnchor,
                  )
                }
                onPointerDown={(e) => beginDrag(dragSet("local", en.path), e)}
                onDoubleClick={() => {
                  setLocalSel([]);
                  if (en.isDir) void loadLocal(en.path);
                }}
              >
                {en.isDir ? (
                  <Folder size={16} strokeWidth={1.75} className="ficon" />
                ) : (
                  <FileText size={16} strokeWidth={1.75} className="ficon dim" />
                )}
                <span className="fname">{en.name}</span>
                <span className="fsize mono">{en.isDir ? "" : human(en.size)}</span>
                <span className="fdate mono">{when(en.modified)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="files-mid">
          <button
            className="mid-x"
            title={
              selLocalFiles.length > 1
                ? `Upload ${selLocalFiles.length} files to the host`
                : "Upload selected file to the host"
            }
            aria-label={
              selLocalFiles.length > 1
                ? `Upload ${selLocalFiles.length} files to the host`
                : "Upload selected file to the host"
            }
            onClick={uploadSelected}
            disabled={phase !== "ready" || selLocalFiles.length === 0}
          >
            <Upload size={16} strokeWidth={2} />
          </button>
          <button
            className="mid-x"
            title={
              selRemoteFiles.length > 1
                ? `Download ${selRemoteFiles.length} files to this PC`
                : "Download selected file to this PC"
            }
            aria-label={
              selRemoteFiles.length > 1
                ? `Download ${selRemoteFiles.length} files to this PC`
                : "Download selected file to this PC"
            }
            onClick={downloadSelected}
            disabled={phase !== "ready" || selRemoteFiles.length === 0}
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
            {remoteSel.length > 1 && (
              <span className="fsel-n mono">{remoteSel.length} selected</span>
            )}
            <button
              className="tool tool-wide"
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
              aria-label="New folder on the server"
              onClick={() => setNameDlg({ mode: "mkdir", value: "" })}
              disabled={phase !== "ready"}
            >
              <FolderPlus size={16} strokeWidth={1.75} />
            </button>
            {viewTools(remoteView, setRemoteView)}
            <button
              className="tool"
              title="Up"
              aria-label="Go up one folder on the server"
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
              <button className="crumb" onClick={() => goRemote("")} title="Home" aria-label="Go to the home folder">
                ~
              </button>
              <button className="crumb" onClick={() => goRemote("/")} title="Filesystem root" aria-label="Go to the filesystem root">
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
          {remoteView.finding && (
            <FindBar
              view={remoteView}
              onView={setRemoteView}
              shown={remoteRows.length}
              total={remote.length}
            />
          )}
          {phase === "ready" && <SortBar view={remoteView} onView={setRemoteView} />}
          <div className="flist">
            {phase === "idle" && (
              <div className="pane-idle">
                <div className="pane-idle-t">Not connected</div>
                <div className="pane-idle-s">
                  {idleNote || "Portal restored this panel's position but didn't reconnect on its own."}
                </div>
                <button className="btn-primary" onClick={() => void connect()}>
                  <span>Connect</span>
                </button>
              </div>
            )}
            {phase === "connecting" && (
              /* Bağlanırken de bir çıkış var (P11). */
              <div className="err-retry">
                <div className="conn-row">
                  <span className="st" />
                  Connecting…
                </div>
                <button className="btn-ghost" onClick={cancelConnect}>
                  Cancel
                </button>
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
            {phase === "ready" && !remoteErr && remoteRows.length === 0 && (
              <div className="empty">
                {remoteView.filter.trim()
                  ? "No file matches that filter — clear it to see everything again."
                  : "This folder is empty. Drag a file in from the left, or press Upload."}
              </div>
            )}
            {phase === "ready" &&
              remoteRows.map((en: RemoteEntry) => (
                <div
                  key={en.name}
                  className={"frow" + (remoteSel.includes(en.name) ? " sel" : "")}
                  onClick={(e) =>
                    pick(
                      e,
                      en.name,
                      remoteRows.map((r) => r.name),
                      remoteSel,
                      setRemoteSel,
                      remoteAnchor,
                    )
                  }
                  onPointerDown={(e) => beginDrag(dragSet("remote", en.name), e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Seçimin DIŞINA sağ tıklamak seçimi o satıra indirger; içine
                    // tıklamak çoklu seçimi korur (menü kaç öğeye baktığını söyler).
                    if (!remoteSel.includes(en.name)) {
                      setRemoteSel([en.name]);
                      remoteAnchor.current = en.name;
                    }
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
                  <span className="fsize mono">{en.isDir ? "" : human(en.size)}</span>
                  <span className="fdate mono">{when(en.modified)}</span>
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
                      {/* Hata METNİ bugüne kadar hiç çizilmiyordu: satır yalnız
                          "failed" diyordu, sebebi (izin? disk? kopma?) kayıptı. */}
                      {t.status === "failed" && t.message && (
                        <div className="xfer-why">{t.message}</div>
                      )}
                    </div>
                    {t.status === "active" && (
                      <button
                        className="tool"
                        title="Cancel"
                        aria-label={`Cancel the transfer of ${t.name}`}
                        onClick={() => {
                          const id = sessionRef.current;
                          if (id != null) void sftpCancel(id, t.id);
                        }}
                      >
                        <X size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    {(t.status === "failed" || t.status === "cancelled") && (
                      <button
                        className="tool tool-wide"
                        title={`Transfer ${t.name} again`}
                        onClick={() => retryTransfer(t)}
                      >
                        <RotateCw size={16} strokeWidth={1.75} />
                        <span>Try again</span>
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
          {selRemoteFiles.length > 0 && (
            <button
              className="ctx-item"
              onClick={() => {
                downloadSelected();
                setMenu(null);
              }}
            >
              <Download size={16} strokeWidth={1.75} />{" "}
              {selRemoteFiles.length > 1 ? `Download ${selRemoteFiles.length} files` : "Download"}
            </button>
          )}
          {menu.entry.isDir && selRemote.length === 1 && (
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
          {selRemote.length === 1 && (
            <button
              className="ctx-item"
              onClick={() => {
                setNameDlg({ mode: "rename", value: menu.entry.name, target: menu.entry });
                setMenu(null);
              }}
            >
              <Pencil size={16} strokeWidth={1.75} /> Rename
            </button>
          )}
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => {
              setConfirmDel(selRemote.length ? selRemote : [menu.entry]);
              setMenu(null);
            }}
          >
            <Trash2 size={16} strokeWidth={1.75} />{" "}
            {selRemote.length > 1 ? `Delete ${selRemote.length} items` : "Delete"}
          </button>
        </div>,
          document.body,
        )}

      {/* İsim dialog'u (yeni klasör / yeniden adlandır) */}
      {nameDlg && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setNameDlg(null)}>
          <div
            ref={nameBoxRef}
            tabIndex={-1}
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={nameDlg.mode === "mkdir" ? "New folder" : "Rename"}
          >
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

      {/* Çakışma: hedefte aynı adda bir dosya var. Sessizce ÜSTÜNE YAZMAK eski
          davranıştı — SFTP `create` ve yerel `File::create` ikisi de kırpar. */}
      {clash && (
        <div className="overlay">
          <div
            ref={conflictBoxRef}
            tabIndex={-1}
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="File already exists"
          >
            <div className="dlg-head">
              <span className="dlg-title">That name is taken</span>
              <button className="dlg-x" aria-label="Close" onClick={() => setConflict(null)}>
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <p className="dlg-sub">
              <b className="mono">{clash.name}</b> already exists in{" "}
              {clash.kind === "upload" ? "the host folder" : "this PC's folder"}. Overwriting
              replaces it for good.
              {remaining > 1 && <span className="raw">{remaining - 1} more name(s) also clash.</span>}
            </p>
            <label className="fld">
              <span className="fld-k">Save it as</span>
              <input
                value={conflict?.rename ?? ""}
                onChange={(e) =>
                  setConflict((c) => (c ? { ...c, rename: e.target.value } : c))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") resolveConflict("rename");
                  if (e.key === "Escape") setConflict(null);
                }}
              />
            </label>
            {remaining > 1 && (
              <button
                className={"hf-check lit" + (applyAll ? " on" : "")}
                onClick={() => setApplyAll(!applyAll)}
                title="Answer once for every remaining name clash. Rename gives each file a free name automatically."
              >
                <span className="hf-box">
                  <Check size={16} strokeWidth={3} />
                </span>
                <span>
                  Do the same for the <b>{remaining - 1}</b> other clash(es)
                </span>
              </button>
            )}
            <div className="dlg-foot">
              <button className="btn-ghost" onClick={() => resolveConflict("skip")}>
                Skip
              </button>
              <button className="btn-ghost" onClick={() => resolveConflict("overwrite")}>
                Overwrite
              </button>
              <button
                className="btn-primary"
                onClick={() => resolveConflict("rename")}
                disabled={!(conflict?.rename ?? "").trim()}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Silme onayı */}
      {confirmDel && confirmDel.length > 0 && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDel(null)}>
          <div
            ref={delBoxRef}
            tabIndex={-1}
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Delete"
          >
            <div className="dlg-head">
              <span className="dlg-title">
                {confirmDel.length > 1
                  ? `Delete ${confirmDel.length} items?`
                  : `Delete ${confirmDel[0].isDir ? "folder" : "file"}?`}
              </span>
              <button className="dlg-x" aria-label="Close" onClick={() => setConfirmDel(null)}>
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <p className="dlg-sub">
              {confirmDel.length > 1 ? (
                <>
                  <b className="mono">{confirmDel.length} items</b> will be permanently removed from
                  the host.
                </>
              ) : (
                <>
                  <b className="mono">{confirmDel[0].name}</b> will be permanently removed from the
                  host.
                </>
              )}
              {confirmDel.some((e) => e.isDir) && " Folders must be empty."} This can&apos;t be
              undone.
              {confirmDel.length > 1 && (
                <span className="raw">{confirmDel.map((e) => e.name).join(", ")}</span>
              )}
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
