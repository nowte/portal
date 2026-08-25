// Guide railinin ne anlatacağını belirleyen hafif bağlam sinyali (F24). Paneller
// mount olunca / tıklanınca setGuideTopic çağırır; GuidePanel useGuideTopic ile dinler.
// Backend teaching komutu (portal-core::teaching) gelene dek içerik frontend'de durur
// (GuidePanel içindeki harita) — ama rail artık gerçekten açık olana göre değişir.

import { useSyncExternalStore } from "react";

export type GuideTopic = "home" | "gateway" | "terminal" | "files" | "monitor";

let topic: GuideTopic = "home";
const listeners = new Set<() => void>();

/** Aktif Guide konusunu değiştir (değişmediyse abone tetiklenmez). */
export function setGuideTopic(t: GuideTopic): void {
  if (t === topic) return;
  topic = t;
  pinned = false;
  listeners.forEach((l) => l());
}

// Kullanıcı rail'in altındaki seçiciden bir konu seçtiyse, o seçim aktif pencere
// DEĞİŞENE kadar korunur: otomatik takibin kullanıcının elini bir sonraki karede
// geri alması, seçiciyi kullanılamaz yapardı.
let pinned = false;

/** Rail'in kendi seçicisinden konu seç (bir sonraki pencere değişimine kadar sabit). */
export function pinGuideTopic(t: GuideTopic): void {
  topic = t;
  pinned = true;
  listeners.forEach((l) => l());
}

/** Aktif pencere değişti: konuyu takip et (elle seçim varsa onu serbest bırak). */
export function followGuideTopic(t: GuideTopic): void {
  if (pinned && t === topic) return;
  pinned = false;
  if (t === topic) return;
  topic = t;
  listeners.forEach((l) => l());
}

/** Panel id'sinden konu türet: `term:<host>` → terminal, `home` → home … */
export function topicOfPanel(id: string | undefined): GuideTopic | null {
  if (!id) return null;
  if (id === "home") return "home";
  if (id.startsWith("gw:")) return "gateway";
  if (id.startsWith("term:")) return "terminal";
  if (id.startsWith("files:")) return "files";
  if (id.startsWith("monitor:")) return "monitor";
  return null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** GuidePanel için: mevcut konuyu dinle (harici store → useSyncExternalStore). */
export function useGuideTopic(): GuideTopic {
  return useSyncExternalStore(
    subscribe,
    () => topic,
    () => topic,
  );
}
