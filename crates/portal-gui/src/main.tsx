import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import markSrc from "./assets/portal-mark-black.png";
import { installDevMock } from "./lib/devmock";
import "./styles.css";

// Tarayıcı önizlemesinde Tauri köprüsünü taklit et (Tauri içinde no-op).
installDevMock();

// Mark TEK yerden gelir: gerçek marka varlığı, CSS mask olarak. Maske yalnız
// alpha kanalını kullanır → renk --text'ten gelir, dört temada da doğru
// (DESIGN §24.2; filter/invert hilesi yok). Elle çizilmiş SVG kopyası YOK.
document.documentElement.style.setProperty("--mark-src", `url(${markSrc})`);

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
