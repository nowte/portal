// Uygulama durumu context'i: bootstrap + hosts/folders + aksiyonlar.
// portal-core ile tek temas noktası burada (lib/ipc üzerinden).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Bootstrap, Folder, Host } from "./lib/types";
import * as ipc from "./lib/ipc";
import { applyTheme } from "./lib/theme";

/** Bir oturumun (shell/files/monitor) canlı bağlantı fazı. */
export type ConnState = "connecting" | "connected" | "error" | "closed";
/** Bir host'un toplam durumu (herhangi bir oturumu bağlıysa online). */
export type HostConn = "connected" | "connecting" | "offline";

interface PortalCtx {
  boot: Bootstrap | null;
  hosts: Host[];
  folders: Folder[];
  theme: string;
  ready: boolean;
  /** İlk-çalıştırma sihirbazı tamamlandı mı (false → onboarding göster). */
  onboarded: boolean;
  /** Aktif profil şifreli ve kilitli mi (true → kilit ekranı göster). */
  locked: boolean;
  /** Aktif profilde kurtarma cümlesi var mı (kilit ekranı "recovery ile aç" göstersin mi). */
  hasRecovery: boolean;
  /** Vault şifreli mi → kimlik "hatırlanabilir" mi (profilsiz modda vault düz metin). */
  canRemember: boolean;
  profile: string | null;
  selectedHost: string | null;
  selectHost: (id: string | null) => void;
  addHost: (label: string, address: string, port?: number, username?: string) => Promise<Host>;
  updateHost: (
    id: string,
    label: string,
    address: string,
    port?: number,
    username?: string,
  ) => Promise<void>;
  removeHost: (id: string) => Promise<void>;
  /** Host'un "sayfa açılınca otomatik bağlan" bayrağını değiştir. */
  setAutoConnect: (id: string, value: boolean) => Promise<void>;
  changeTheme: (t: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Onboarding'i tamamla (tema + opsiyonel profil/parola/kurtarma cümlesi) → benimse. */
  completeOnboarding: (
    theme: string,
    name?: string,
    password?: string,
    recoveryPhrase?: string,
  ) => Promise<void>;
  /** Kilitli profili parolayla aç (hata → throw, çağıran gösterir). */
  unlock: (password: string) => Promise<void>;
  /** Kilitli profili kurtarma cümlesiyle aç (parola unutulduğunda). */
  unlockWithRecovery: (phrase: string) => Promise<void>;
  /** Bir komuttan dönen güncel Bootstrap'ı benimse (profil değişimi/kilit/senkron). */
  adoptBootstrap: (b: Bootstrap) => void;
  // ── Canlı bağlantı durumu (paneller bildirir; Gateway/Hosts/Home okur) ──
  /** Bir oturumun fazını bildir (connect/olay/temizlik anında). */
  reportConn: (id: number, hostId: string, kind: string, state: ConnState) => void;
  /** Bir oturumu durumdan düşür (panel kapanınca). */
  dropConn: (id: number) => void;
  /** Bir host'un toplam bağlantı durumu. */
  hostState: (hostId: string) => HostConn;
  /** Bağlı (connected) oturum sayısı. */
  liveSessions: number;
  /** En az bir bağlı oturumu olan farklı host sayısı. */
  onlineHosts: number;
}

const Ctx = createContext<PortalCtx | null>(null);

export function usePortal(): PortalCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePortal must be used within <PortalProvider>");
  return c;
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [theme, setTheme] = useState("black");
  const [ready, setReady] = useState(false);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  // Canlı oturum durumu: sessionId → {hostId, kind, state}.
  const [conns, setConns] = useState<Record<number, { hostId: string; kind: string; state: ConnState }>>(
    {},
  );

  // Tema değişince kök öğeye uygula (anında; CSS token'ları geçiş yapar).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    setHosts(await ipc.listHosts());
    setFolders(await ipc.listFolders());
  }, []);

  // Bir Bootstrap'ı tüm türev duruma yay (bootstrap, onboarding, unlock, switch, sync).
  const adoptBootstrap = useCallback((b: Bootstrap) => {
    setBoot(b);
    setHosts(b.hosts);
    setFolders(b.folders);
    setTheme(b.theme);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        adoptBootstrap(await ipc.getBootstrap());
      } catch (e) {
        console.error("bootstrap failed", e);
      }
      setReady(true);
      unlisten = await ipc.onHostsChanged(() => {
        void refresh();
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [refresh, adoptBootstrap]);

  const addHost = useCallback(
    async (label: string, address: string, port?: number, username?: string) => {
      const created = await ipc.addHost(label, address, port, username);
      await refresh();
      return created;
    },
    [refresh],
  );
  const updateHost = useCallback(
    async (id: string, label: string, address: string, port?: number, username?: string) => {
      await ipc.updateHost(id, label, address, port, username);
      await refresh();
    },
    [refresh],
  );
  const removeHost = useCallback(
    async (id: string) => {
      await ipc.removeHost(id);
      await refresh();
    },
    [refresh],
  );
  const setAutoConnect = useCallback(
    async (id: string, value: boolean) => {
      await ipc.setHostAutoConnect(id, value);
      await refresh();
    },
    [refresh],
  );
  const changeTheme = useCallback(async (t: string) => {
    setTheme(t); // anında uygula (effect); sonra kalıcılaştır
    await ipc.setTheme(t);
  }, []);

  const completeOnboarding = useCallback(
    async (t: string, name?: string, password?: string, recoveryPhrase?: string) => {
      adoptBootstrap(await ipc.completeOnboarding(t, name, password, recoveryPhrase));
    },
    [adoptBootstrap],
  );

  const unlock = useCallback(
    async (password: string) => {
      adoptBootstrap(await ipc.unlockVault(password));
    },
    [adoptBootstrap],
  );

  const unlockWithRecovery = useCallback(
    async (phrase: string) => {
      adoptBootstrap(await ipc.unlockWithRecovery(phrase));
    },
    [adoptBootstrap],
  );

  const reportConn = useCallback(
    (id: number, hostId: string, kind: string, state: ConnState) => {
      setConns((c) => ({ ...c, [id]: { hostId, kind, state } }));
    },
    [],
  );
  const dropConn = useCallback((id: number) => {
    setConns((c) => {
      if (!(id in c)) return c;
      const n = { ...c };
      delete n[id];
      return n;
    });
  }, []);
  const hostState = useCallback(
    (hostId: string): HostConn => {
      const list = Object.values(conns).filter((x) => x.hostId === hostId);
      if (list.some((x) => x.state === "connected")) return "connected";
      if (list.some((x) => x.state === "connecting")) return "connecting";
      return "offline";
    },
    [conns],
  );
  const liveSessions = useMemo(
    () => Object.values(conns).filter((x) => x.state === "connected").length,
    [conns],
  );
  const onlineHosts = useMemo(
    () =>
      new Set(
        Object.values(conns)
          .filter((x) => x.state === "connected")
          .map((x) => x.hostId),
      ).size,
    [conns],
  );

  return (
    <Ctx.Provider
      value={{
        boot,
        hosts,
        folders,
        theme,
        ready,
        onboarded: boot?.onboarded ?? false,
        locked: boot?.locked ?? false,
        hasRecovery: boot?.has_recovery ?? false,
        canRemember: boot?.can_remember ?? false,
        profile: boot?.profile ?? null,
        selectedHost,
        selectHost: setSelectedHost,
        addHost,
        updateHost,
        removeHost,
        setAutoConnect,
        changeTheme,
        refresh,
        completeOnboarding,
        unlock,
        unlockWithRecovery,
        adoptBootstrap,
        reportConn,
        dropConn,
        hostState,
        liveSessions,
        onlineHosts,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
