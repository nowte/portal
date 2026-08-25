// Switzer'ı Fontshare'den indirir (npm install sonrası otomatik çalışır).
//
// NEDEN BU SCRIPT VAR: Switzer, ITF Free Font License altında. Lisans fontu
// kullanmaya, @font-face ile self-host etmeye ve uygulamaya gömmeye izin veriyor
// (§01) ama font DOSYASINI "repository" üzerinden dağıtmayı yasaklıyor (§02) ve
// kullanacak herkesin kendi kopyasını doğrudan Fontshare'den almasını istiyor.
// Repo public olduğu için dosya git'te duramaz; bu script onu her makinede
// doğrudan kaynağından indirir.
//
// Commit Mono (SIL OFL 1.1) repoda duruyor — onun için böyle bir kısıt yok.
//
// İndirme başarısız olursa build KIRILMAZ: 0 baytlık yer tutucu yazılır, Vite
// CSS url()'ini çözebilir, tarayıcı bozuk fontu yok sayıp fallback'e düşer.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "..", "src", "assets", "fonts");
const WEIGHTS = [400, 500, 600]; // styles.css'te fiilen kullanılanlar
const API = `https://api.fontshare.com/v2/css?f%5B%5D=switzer@${WEIGHTS.join(",")}`;
const TIMEOUT_MS = 20_000;

const out = (w) => join(FONT_DIR, `Switzer-${w}.woff2`);

/** Dosya var ve boş değil mi? */
async function present(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function get(url, as) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "portal-build" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
}

/** Fontshare CSS'inden ağırlık → woff2 URL eşlemesi çıkarır. */
function parseCss(css) {
  const found = new Map();
  for (const block of css.split("@font-face")) {
    const url = block.match(/url\('(\/\/[^']+\.woff2)'\)/)?.[1];
    const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
    const style = block.match(/font-style:\s*(\w+)/)?.[1];
    if (url && weight && style !== "italic") found.set(Number(weight), `https:${url}`);
  }
  return found;
}

async function main() {
  await mkdir(FONT_DIR, { recursive: true });

  const missing = [];
  for (const w of WEIGHTS) if (!(await present(out(w)))) missing.push(w);
  if (missing.length === 0) return; // zaten var, sessizce çık

  const urls = parseCss(await get(API, "text"));
  for (const w of missing) {
    const url = urls.get(w);
    if (!url) throw new Error(`Fontshare did not return weight ${w}`);
    await writeFile(out(w), await get(url));
  }
  console.log(`Switzer: downloaded ${missing.join(", ")} from Fontshare.`);
}

main().catch(async (err) => {
  // Sessizce başarısız OLMA: neyin neden olmadığını ve nasıl düzelteceğini söyle.
  console.warn(
    [
      "",
      "  Couldn't download the Switzer webfont from Fontshare.",
      `  Reason: ${err.message}`,
      "",
      "  The app still builds and runs — it falls back to your system sans-serif,",
      "  so the interface will look slightly off but nothing is broken.",
      "",
      "  To fix it: re-run `npm install`, or download Switzer yourself from",
      "  https://www.fontshare.com/fonts/switzer and save the 400/500/600 web files",
      "  as crates/portal-gui/src/assets/fonts/Switzer-{400,500,600}.woff2",
      "",
    ].join("\n"),
  );
  // Yer tutucu: olmazsa `vite build` CSS url()'ini çözemeyip patlar.
  for (const w of WEIGHTS) if (!(await present(out(w)))) await writeFile(out(w), "");
});
