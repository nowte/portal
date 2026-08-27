// Güncelleme durumu — TEK abonelik (uptime.ts'teki kalıp): TopBar ve About aynı
// veriyi okur, ikisi ayrı istek atmaz.
//
// Kontrol açılışta BİR KEZ yapılır (ayar açıksa) ve About'taki düğmeyle elle
// tekrarlanabilir. İndirme yok — sonuç yalnız "şu sürüm çıkmış" bilgisidir.

import { useSyncExternalStore } from "react";
import * as ipc from "./ipc";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "found"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
const listeners = new Set<() => void>();

function set(next: UpdateState): void {
  state = next;
  listeners.forEach((l) => l());
}

/** Kontrolü çalıştırır. Zaten sürüyorsa ikinci istek açmaz. */
export async function checkNow(): Promise<void> {
  if (state.status === "checking") return;
  set({ status: "checking" });
  try {
    const version = await ipc.checkUpdate();
    set(version ? { status: "found", version } : { status: "current" });
  } catch (e) {
    set({ status: "error", message: String(e) });
  }
}

/** Açılış kontrolü — oturumda yalnız bir kez, ayar kapalıysa hiç. */
let launched = false;
export function checkOnLaunch(enabled: boolean): void {
  if (launched || !enabled) return;
  launched = true;
  void checkNow();
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
