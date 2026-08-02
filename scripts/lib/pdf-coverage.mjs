/**
 * Fixtures the shipped font set cannot render, and why.
 *
 * One list, three consumers: `check-pdf-fonts.mjs` (which *proves* each entry by rendering it
 * and finding a face `fonts/` does not ship), `check-surface-parity.mjs` (which drops them
 * from the pdf column), and `run-fidelity.mjs` (which drops them from the `md->pdf->md` loop).
 *
 * It lives here because it was about to exist in three places. A duplicated exemption list is
 * worse than no list: the copies drift, and the one that drifts is the one nobody re-measures.
 *
 * ## Why an uncovered fixture must be excluded rather than measured
 *
 * Measured 2026-08-02: with no explicit font for a glyph, Typst resolves it against **the host
 * machine's installed faces** — `SimSun`, `ArialMT`, `YuGothic`, `SegoeUIEmoji` on Windows.
 * The NAPI binding exposes no way to disable that (`CompileArgs` is `fontArgs` / `workspace` /
 * `inputs`), so the output depends on the machine.
 *
 * For byte parity that is fatal. For *fidelity* it is subtler and still disqualifying: a
 * Linux runner without those faces produces different glyph coverage, so the text extracted
 * back out differs, so the score differs — and a baseline that moves with the runner is not a
 * baseline. These rows are excluded for that reason, not because the conversion is bad.
 *
 * Adding an entry here is not free: `check-pdf-fonts.mjs` §2 fails any entry whose fixture
 * actually renders closed. `rtl-hebrew.md` was rejected that way on the first run — Libertinus
 * covers Hebrew.
 */
export const PDF_UNCOVERED = {
  "unicode-edge-cases.md": "CJK, emoji, Arabic and Hebrew are outside Libertinus/DejaVu",
  "cjk-chinese.md": "Simplified Chinese is outside Libertinus/DejaVu",
  "cjk-japanese.md": "Japanese is outside Libertinus/DejaVu",
  "rtl-arabic.md": "Arabic is outside Libertinus/DejaVu",
};

/** `true` when the named Markdown fixture needs a font we do not ship. */
export const isPdfUncovered = (fixtureFile) =>
  Object.prototype.hasOwnProperty.call(PDF_UNCOVERED, fixtureFile);
