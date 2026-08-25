// Satır içi hata notu — TEK yer. Beş ayrı ekranda `<div className="err">` yazılıyordu
// ve hata simgesi CSS ::before ile çizilmiş bir noktaydı; simge dili (§8: lucide,
// 16/20, stroke 1.75) o noktayı kapsamıyordu. Artık gerçek bir simge var ve
// değiştirmek isteyen tek dosyaya bakıyor.

import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="err" role="alert">
      <CircleAlert className="err-i" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="err-t">{children}</span>
    </div>
  );
}
