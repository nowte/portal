import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import markSrc from "./assets/portal-mark.svg";
import { installDevMock } from "./lib/devmock";
import "./styles.css";

// Tarayıcı önizlemesinde Tauri köprüsünü taklit et (Tauri içinde no-op).
installDevMock();

// Mark TEK yerden gelir: `assets/portal-mark.svg`, CSS mask olarak. Maske yalnız
// alpha kanalını kullanır → renk --text'ten gelir, dört temada da doğru
// (DESIGN §24.2; filter/invert hilesi yok). İkinci bir mark kopyası YOK.
// SVG vektör: viewBox varlığın tam sınırı, yani mask-size 100% — eski PNG'nin
// geniş şeffaf payını telafi eden ölçü/konum hesapları gitti (DESIGN §24.3).
//
// ⚠️ url() TIRNAKLI olmalı: Vite küçük SVG'yi data URI olarak gömüyor ve o URI tek
// tırnak içeriyor. Tırnaksız `url(...)` bunu kabul etmez → setProperty sessizce
// yutulur, mark HİÇ çizilmez (PNG'de büyük olduğu için gömülmüyordu, fark edilmezdi).
document.documentElement.style.setProperty("--mark-src", `url("${markSrc}")`);

// StrictMode kullanmıyoruz: dev'de çift-mount dockview init'ini iki kez tetikler.
const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<App />);
  // Pencere gizli açılır (tauri.conf visible:false). İçerik (loading ekranı) ilk
  // boyandıktan sonra göster → başlangıçtaki gri boş pencere görünmez.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Tema geçiş animasyonu ancak İLK boyamadan sonra açılır (styles.css
      // .theme-ready): aksi halde açılışta token'lar yerleşirken renk kayması
      // animasyonu görünürdü.
      document.documentElement.classList.add("theme-ready");
      try {
        void getCurrentWindow().show().catch(() => undefined);
      } catch {
        /* Tauri dışında pencere yok — tarayıcı önizlemesi. */
      }
    });
  });
}
