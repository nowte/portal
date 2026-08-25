import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Sürüm TEK kaynaktan: src-tauri/tauri.conf.json. Kodda elle yazılmış sürüm
// numarası bırakmak yasak (DESIGN BÖLÜM III) — derleme anında gömülür.
const appVersion: string = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf-8"),
).version;

// Tauri, frontend'i bu dev sunucusundan (devUrl) yükler. Windows GUI hedefi
// olduğundan modern WebView2'ye derliyoruz. Bkz. docs/ARCHITECTURE.md §3.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
  // Dev'de ilk açılışı hızlandır: büyük bağımlılıkları önden bundle et
  // (aksi halde ~1800 modül tek tek dönüştürülürken pencere boş bekler).
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "dockview-react",
      "lucide-react",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
    ],
  },
});
