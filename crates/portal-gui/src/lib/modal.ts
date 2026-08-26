// Modal davranışı — TEK yer (P11 erişilebilirlik geçişi).
//
// Beş ekranda ayrı ayrı `keydown` dinleyicisi yazılıyordu ve hiçbirinde odak
// tuzağı yoktu: Tab modalın arkasındaki panele kaçıyor, klavye kullanıcısı
// göremediği bir düğmeye basabiliyordu. Dört davranış burada birlikte durur:
//
//   1. Esc kapatır.
//   2. Tab kutunun İÇİNDE döner (uçlara sarar).
//   3. Açılışta odak içeri girer (bir alan `autoFocus` aldıysa ona dokunulmaz).
//   4. Kapanışta odak modalı açan öğeye geri döner.

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Modal kutusuna bağlanır. `box` bir `tabIndex={-1}` taşımalı: içinde hiç
 * odaklanabilir öğe yoksa odağın gidebileceği tek yer kutunun kendisidir.
 *
 * `active`: modal KAPALIYKEN de render edilen bileşenler (About, Settings…)
 * için. Kancalar erken `return null`dan sonra çağrılamaz, o yüzden açıklık
 * bilgisi buradan geçer — kapalıyken hiçbir dinleyici kurulmaz.
 */
export function useModal(
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
): void {
  // onClose çoğu çağrı yerinde satır içi bir ok fonksiyonu — bağımlılığa
  // koyarsak effect her render'da yeniden kurulur, odak sürekli başa döner.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const el = box.current;
    const returnTo = document.activeElement as HTMLElement | null;

    const items = (): HTMLElement[] =>
      Array.from(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        // Gizli öğeler tuzağın sırasına girmez (offsetParent yoksa çizilmiyor).
        (n) => n.offsetParent !== null,
      );

    if (el && !el.contains(document.activeElement)) {
      (items()[0] ?? el).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const f = items();
      if (f.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      const outside = !el.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    // Yakalama fazı: altta duran panellerin kendi Esc/Tab kancalarından ÖNCE.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      returnTo?.focus?.();
    };
  }, [box, active]);
}
