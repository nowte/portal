// Sürüm TEK kaynaktan gelir: src-tauri/tauri.conf.json → vite.config.ts'te
// `define` ile derleme anında gömülür. Kodda elle yazılmış sürüm numarası
// bırakmak DESIGN BÖLÜM III'te yasak ("kodlanmış sürüm numarası") — v1.0.0
// üç yerde elle duruyordu ve gerçek sürümle ilgisi yoktu.
declare const __APP_VERSION__: string;

export const APP_VERSION = `v${__APP_VERSION__}`;
