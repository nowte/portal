# portal-gui — Portal Windows GUI (Tauri v2 + React)

Faz 3 (v1.0) yüzeyi. Tüm domain mantığı `portal-core`'dadır; burası ince kabuk.
Görsel referans: [`../../docs/mockups/portal-windows-gui.html`](../../docs/mockups/portal-windows-gui.html) ·
düzen/bileşen spec'i: **docs/DESIGN.md §12** · köprü: **docs/ARCHITECTURE.md §3.1–3.2**.

## Yapı
- **Frontend (kökte):** `src/` — React + TS. `dockview` (dock motoru), `lucide-react`
  (ikon), gömülü Geist + JetBrains Mono. Vite ile derlenir → `dist/`.
- **`src-tauri/`:** Tauri v2 (Rust). **Ayrı workspace** — ana `cargo test --workspace`
  kapısını yavaşlatmaz. `portal-core`'a path-dep. Komutlar + Rust→web olay köprüsü.

## Çalıştır (geliştirme)
```bash
cd crates/portal-gui
npm install          # ilk sefer
npm run tauri dev    # frontend (vite) + Tauri penceresini birlikte açar
```
> İlk `tauri dev` Rust bağımlılıklarını (Tauri + portal-core + russh…) derler — birkaç
> dakika sürer. Sonraki açılışlar hızlıdır. WebView2 (Windows 11'de gömülü) gerekir.

## Derle / paketle
```bash
npm run tauri build  # .msi/.exe (Faz 3-E'de kod imzalama eklenir)
```

## P6-A kapsamı (bu iskelet)
- Sabit **icon bar** + üst bar (logo mark + version + command palette) + status bar.
- **dockview** shell: Hosts (sol) · Home (merkez, Homepage/Dashboard alt-sekme) · Guide (sağ).
  Paneller taşınır/boyutlanır; düzen kaydedilir; **Ctrl+K** reset.
- `portal-core` köprüsü: `get_bootstrap` · `list_hosts/folders` · `add_host` · `remove_host`
  · `set_theme`. `add/remove_host` → `portal://hosts-changed` olayı → UI tazelenir.
- Saf monokrom; Geist + JetBrains Mono gömülü.

Sonraki (P6-B): Gateway/Terminal(xterm.js)/Files(sürükle-bırak)/Monitor + canlı SSH köprüsü.

## Notlar
- Uygulama ikonu şimdilik logodan üretilmiş placeholder — düzgün "tight" mark + `.ico`
  DESIGN §13'te yapılacaklar arasında.
- Düzen kalıcılığı P6-A'da `localStorage`'ta; ileride `portal-core` config'e taşınabilir.
