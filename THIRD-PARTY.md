# Third-party assets

Portal bundles the fonts below. Everything else it depends on is a normal package
dependency — see `Cargo.lock` and `crates/portal-gui/package-lock.json` for the full
tree and their licenses.

## Fonts

### Commit Mono
Monospace typeface used for terminal output, tabular data and code.

- Author: Eigil Nikolajsen
- Source: <https://commitmono.com>
- License: **SIL Open Font License 1.1** — bundling and redistribution with software
  are permitted; selling the font on its own is not.
- Bundled files: `crates/portal-gui/src/assets/fonts/CommitMono-{400,500,600}.woff2`
- License text: `crates/portal-gui/src/assets/fonts/CommitMono-OFL.txt`

### Switzer
Sans-serif typeface used for the interface.

- Foundry: Indian Type Foundry, via [Fontshare](https://www.fontshare.com/fonts/switzer)
- License: **ITF Free Font License** — free for personal and commercial use.
  Self-hosting and embedding in a desktop application are explicitly permitted;
  redistributing the font file itself is not.
- **The font file is not stored in this repository.** `npm install` fetches it from
  Fontshare, so every copy comes directly from the foundry, as the license requires.
  If the download fails the build still works and the interface falls back to your
  system sans-serif.

## Brand assets — not covered by the project license

The Portal name, wordmark and mark (`crates/portal-gui/src/assets/portal-*.png` and
`.github/assets/`) are **not** covered by the GPL and are not licensed for reuse.
You may fork the code; please do not ship it under the Portal name or mark.

## Reporting a licensing problem

If you believe something here is bundled incorrectly, open an issue — it will be
treated as a bug and fixed quickly.
