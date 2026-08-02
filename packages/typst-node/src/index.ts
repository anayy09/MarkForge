/**
 * @markforge/typst-node — the Node Typst compiler, bound to the shipped font set.
 *
 * ADR-0003 makes `compile(source, fonts) → bytes` a requirement rather than a nicety, so that
 * swapping the single-maintainer binding is a one-file change. This is where that seam is
 * bound for every Node surface. It exists as its own package rather than as a helper inside
 * the CLI because four callers need it — CLI, HTTP, MCP, and the gates — and three copies of
 * a compiler configuration will drift. When they drift, the gate stops measuring the shipped
 * path, which is the failure this package prevents.
 *
 * `browserTier: "nodeOnly"`. The binding is NAPI with platform-specific binaries; the browser
 * reaches Typst through the WASM compiler instead, and `@markforge/core` reaches neither
 * because the renderer is injected (see `PdfRenderer` in core).
 *
 * ## Why the fonts are here and not configurable per surface
 *
 * Measured 2026-08-02, and this is the whole reason this package exists. Run with no explicit
 * fonts, the NAPI compiler resolves missing glyphs against **the host machine's installed
 * fonts**: `fixtures/md/unicode-edge-cases.md` produced a PDF embedding `SimSun`, `ArialMT`,
 * and `SegoeUIEmoji` — three Windows faces. Three consequences, all of which were live and
 * none of which any gate could see:
 *
 *   - `scripts/check-pdf-determinism.mjs` compares two processes **on one machine**, so it is
 *     structurally blind to output that depends on what is installed. On a Linux runner those
 *     faces do not exist, CI produced different bytes, and both runs passed.
 *   - SPEC §4.3 requires no font substitution. Substitution is exactly what was happening.
 *   - ADR-0003 states `--ignore-system-fonts` is "always on". It is not, and the binding's
 *     `CompileArgs` (`fontArgs` / `workspace` / `inputs`) exposes no way to turn it on.
 *
 * There is no API to disable the fallback, so the fix is to remove the *need* for it: supply a
 * closed font set covering the corpus, and gate on the result. `scripts/check-pdf-fonts.mjs`
 * fails any PDF embedding a face outside `SHIPPED_FONTS`, which is the check that would have
 * caught `SimSun`.
 *
 * The set is fixed rather than per-surface for the reason `@markforge/core` records at its
 * `docx` case: a default that lives in one surface is a default the other surfaces do not
 * have. If fonts were configurable, one surface supplying them and another not would produce
 * different bytes for the same document, which is precisely what four-surface parity rules out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DiagnosticBag, MarkForgeDocument } from "@markforge/ir";
import { renderPdf, type PdfFont } from "@markforge/render-pdf";

/**
 * The faces this toolkit ships, in `fonts/`.
 *
 * Libertinus Serif is Typst's own default serif, and `DejaVuSansMono` is what the binding
 * falls back to for `raw`. Both were chosen by measurement rather than taste: supplying
 * exactly these produces **byte-identical output to the pre-font pipeline** on every fixture
 * they cover, so adopting them regenerated no baseline.
 *
 * `DejaVuSansMono.ttf` is byte-identical across typst-assets v0.11.0, v0.12.0 and v0.13.1, so
 * the mono face is not sensitive to which assets pin a compiler was built against.
 */
export const SHIPPED_FONTS = [
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-BoldItalic.otf",
  "DejaVuSansMono.ttf",
] as const;

/**
 * Family names the shipped set can legitimately produce in a PDF.
 *
 * `scripts/check-pdf-fonts.mjs` compares embedded `/BaseFont` entries against this. A face
 * outside it means Typst substituted from the host machine, which is a determinism defect
 * rather than a cosmetic one.
 */
export const SHIPPED_FONT_FAMILIES = ["LibertinusSerif", "DejaVuSansMono"] as const;

/**
 * The faces prose is actually set in, which is a smaller set than `SHIPPED_FONTS`.
 *
 * The distinction is load-bearing for coverage and was found by CI. Asking "can *any* shipped
 * face draw this character" says yes for Arabic — `DejaVuSansMono` covers all 45 of the
 * characters in `fixtures/md/rtl-arabic.md`, while `LibertinusSerif` covers **0**. But Typst
 * sets body text in the serif face and will not fall back to a monospace one for prose, so it
 * reaches past both of ours to a system font. Coverage for body text is therefore a question
 * about the *serif* faces alone; the mono face only widens what a `raw` span can draw.
 */
export const SHIPPED_BODY_FONTS = SHIPPED_FONTS.filter((f) => f.startsWith("LibertinusSerif"));

/** `<repo>/fonts`, resolved from this package's own location rather than from `cwd`. */
export function fontsDir(): string {
  // dist/index.js -> packages/typst-node/dist -> packages/typst-node -> packages -> <repo>
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fonts");
}

let cachedFonts: PdfFont[] | undefined;

/** Reads the shipped faces. Cached, because a conversion should not re-read 1.6 MB. */
export function loadShippedFonts(dir = fontsDir()): PdfFont[] {
  if (cachedFonts) return cachedFonts;
  cachedFonts = SHIPPED_FONTS.map((file) => ({
    family: file.replace(/\.(otf|ttf)$/, ""),
    bytes: new Uint8Array(readFileSync(join(dir, file))),
  }));
  return cachedFonts;
}

interface NodeBinding {
  NodeCompiler: { create(args: unknown): { pdf(args: unknown): Buffer } };
}

/**
 * The binding, loaded once at first use.
 *
 * Imported lazily rather than at module scope because it loads a native addon, and a Node
 * surface that never renders a PDF should not pay for it — the same reasoning
 * `@markforge/adapters-pdf` applies to `pdfjs-dist`.
 */
let bindingPromise: Promise<NodeBinding> | undefined;
const binding = (): Promise<NodeBinding> =>
  (bindingPromise ??= import("@myriaddreamin/typst-ts-node-compiler") as Promise<NodeBinding>);

/**
 * The injected renderer every Node surface hands to `@markforge/core`.
 *
 * Returns the shape `core`'s `PdfRenderer` declares structurally, so `core` keeps no reference
 * of any kind to this package or to `@markforge/render-pdf`.
 */
export function createNodePdfRenderer(options: { fontsDir?: string } = {}) {
  return async function renderPdfNode(
    document: MarkForgeDocument,
  ): Promise<{ bytes: Uint8Array; diagnostics: DiagnosticBag }> {
    const { NodeCompiler } = await binding();
    const fonts = loadShippedFonts(options.fontsDir ?? fontsDir());
    const compiler = NodeCompiler.create({
      fontArgs: [{ fontBlobs: fonts.map((f) => Buffer.from(f.bytes)) }],
    });
    const result = await renderPdf(document, {
      compile: (src) => new Uint8Array(compiler.pdf({ mainFileContent: src })),
      fonts,
    });
    return { bytes: result.bytes, diagnostics: result.diagnostics };
  };
}
