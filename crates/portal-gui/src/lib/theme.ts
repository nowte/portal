// Tema uygulama: seçili tema kök öğeye `data-theme` olarak yazılır; token'lar
// styles.css'te `:root[data-theme="…"]` altında tanımlı (DESIGN §3 — dört monokrom tema).
// Anında değişir (CSS değişkenleri geçişli). Bkz. context.tsx + Onboarding/Settings.

export type ThemeName = "black" | "graphite" | "paper" | "contrast";

const THEMES: ThemeName[] = ["black", "graphite", "paper", "contrast"];

/** Ada göre bir tema doğrula (bilinmeyen → black). */
export function normalizeTheme(name: string): ThemeName {
  return (THEMES as string[]).includes(name) ? (name as ThemeName) : "black";
}

/** Temayı kök öğeye uygula (anında). */
export function applyTheme(name: string): void {
  document.documentElement.setAttribute("data-theme", normalizeTheme(name));
}

/** Onboarding/Settings için tema seçenekleri (ad + iki-renkli önizleme örneği). */
export const THEME_OPTIONS: { id: ThemeName; name: string; sub: string; a: string; b: string }[] = [
  { id: "black", name: "Black", sub: "near-black · default", a: "#ededed", b: "#0a0a0a" },
  { id: "graphite", name: "Graphite", sub: "soft dark gray", a: "#b0b0b0", b: "#161616" },
  { id: "paper", name: "Paper", sub: "light mode", a: "#0a0a0a", b: "#f2f2f2" },
  { id: "contrast", name: "Contrast", sub: "pure black & white", a: "#ffffff", b: "#000000" },
];
