// Sekme kapatma düğmesi — TEK yer.
//
// Üç ayrı kapatma işareti vardı: diyaloglarda lucide `X` (16), sunucu/pane
// sekmesinde elle yazılmış bir `×` karakteri (18px kutuda, --faint), monitör
// sayfasında da dockview'ün kendi SVG'si. Üçü farklı boyutta ve farklı çizgi
// kalınlığındaydı. Artık hepsi buradan basılıyor.

import { X } from "lucide-react";

export function TabClose({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <button
      className="tab-x"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <X size={16} strokeWidth={1.75} />
    </button>
  );
}
