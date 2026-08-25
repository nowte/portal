// Yerel (cihaza özel) kullanıcı tercihleri: favoriler + son etkinlik.
//
// Neden localStorage: bunlar SIR DEĞİL ve makineler arası taşınmaları gerekmiyor —
// "bu bilgisayarda hangi sunucuları sabitledim / neyi son açtım". Vault'a (ve dolayısıyla
// portal-core model'ine) girmemeleri bilinçli: core değişikliği TUI'yi de etkilerdi ve
// senkron edilen şifreli vault'u cihaz-yereli bir tercihle şişirirdi.
//
// İkisi de useSyncExternalStore ile dinlenir → Home anında tazelenir.

const FAV_KEY = "portal.favorites";
const ACT_KEY = "portal.activity";
const ACT_CAP = 40; // en fazla bu kadar kayıt tutulur (en yeni başta)

export type ActivityKind = "terminal" | "files" | "monitor" | "gateway";

export interface ActivityEntry {
  hostId: string;
  kind: ActivityKind;
  at: number; // epoch ms
}

// ── Ortak abone mekanizması ────────────────────────────────────────────────
const listeners = new Set<() => void>();
function emit(): void {
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Bozuk/erişilemez depolama sessizce yok sayılır — bu bir tercih, veri değil.
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kota dolu / özel mod: tercihi kaybetmek uygulamayı bozmamalı.
  }
}

// ── Favoriler ──────────────────────────────────────────────────────────────
// Snapshot'lar önbelleklenir: useSyncExternalStore her render'da getSnapshot çağırır,
// her seferinde yeni bir dizi dönersek sonsuz döngüye girer.
let favCache: string[] = read<string[]>(FAV_KEY, []);
let actCache: ActivityEntry[] = read<ActivityEntry[]>(ACT_KEY, []);

export function isFavorite(hostId: string): boolean {
  return favCache.includes(hostId);
}

export function toggleFavorite(hostId: string): void {
  favCache = favCache.includes(hostId)
    ? favCache.filter((id) => id !== hostId)
    : [...favCache, hostId];
  write(FAV_KEY, favCache);
  emit();
}

export function useFavorites(): string[] {
  return useStore(() => favCache);
}

// ── Son etkinlik ───────────────────────────────────────────────────────────
/** Bir oturum açılışını kaydet (Home'daki "Recent activity" bunu gösterir). */
export function recordActivity(hostId: string, kind: ActivityKind): void {
  const now = Date.now();
  // Aynı host+tür 60 sn içinde tekrar açıldıysa yeni satır değil, zamanı güncelle:
  // aksi halde bir sekmeyi kapatıp açmak akışı aynı satırla doldurur.
  const head = actCache[0];
  if (head && head.hostId === hostId && head.kind === kind && now - head.at < 60_000) {
    actCache = [{ hostId, kind, at: now }, ...actCache.slice(1)];
  } else {
    actCache = [{ hostId, kind, at: now }, ...actCache].slice(0, ACT_CAP);
  }
  write(ACT_KEY, actCache);
  emit();
}

export function useActivity(): ActivityEntry[] {
  return useStore(() => actCache);
}

/** Artık var olmayan host'lara ait kayıtları temizle (host silindiğinde). */
export function pruneLocal(existingHostIds: string[]): void {
  const alive = new Set(existingHostIds);
  const nextFav = favCache.filter((id) => alive.has(id));
  const nextAct = actCache.filter((a) => alive.has(a.hostId));
  const changed = nextFav.length !== favCache.length || nextAct.length !== actCache.length;
  if (!changed) return;
  favCache = nextFav;
  actCache = nextAct;
  write(FAV_KEY, favCache);
  write(ACT_KEY, actCache);
  emit();
}

// ── Hook yardımcısı ────────────────────────────────────────────────────────
import { useSyncExternalStore } from "react";

function useStore<T>(get: () => T): T {
  return useSyncExternalStore(subscribe, get, get);
}

/** "3 dk önce" / "4d" gibi kısa göreli zaman (mockup'taki feed biçimi). */
export function relativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
