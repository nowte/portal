// "Tazele" düğmesi — basınca simge bir tur döner.
//
// Geri bildirim şart: kontrol arka planda çalışıyor ve sonucu saniyeler sonra
// geliyor; dönmeyen bir düğme "tıkladım mı?" sorusunu bırakıyordu. Dönüş TEK
// turdur (sürekli dönen spinner §13'te yasak) ve `animationend` ile kendini
// kapatır — sahte bir "yükleniyor" süresi uydurmuyoruz.

import { useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

export function SpinButton({
  title,
  onRun,
  className = "hostrow-edit",
  disabled = false,
  children,
}: {
  title: string;
  onRun: () => void;
  className?: string;
  disabled?: boolean;
  /** Verilirse simgenin yanına etiket basılır (metinli buton kullanımı). */
  children?: ReactNode;
}) {
  const [spin, setSpin] = useState(false);

  return (
    <button
      className={className}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        setSpin(true);
        onRun();
      }}
    >
      <RefreshCw
        className={"spin-i" + (spin ? " on" : "")}
        size={16}
        strokeWidth={1.75}
        onAnimationEnd={() => setSpin(false)}
      />
      {children}
    </button>
  );
}
