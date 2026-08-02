#!/usr/bin/env node
/**
 * Everything the page downloads, produced rather than committed.
 *
 * ## Why the engine is built here instead of imported
 *
 * `scripts/lib/browser-bundle.mjs` builds `@markforge/browser` with esbuild
 * `conditions: ["worker"]`, and its comment records the measurement behind that: under
 * `platform: "browser"`, `decode-named-character-reference` resolves to a decoder that
 * routes HTML entities through a detached `<i>` element, so the browser build's output
 * would depend on the browser. `scripts/check-surface-parity.mjs` requires the browser and
 * the CLI to emit byte-identical bytes, so that swap is a determinism hazard rather than an
 * optimisation.
 *
 * This script calls **the same two exported functions** that gate calls. The page therefore
 * cannot be running a different build from the one parity was measured on, and it cannot
 * drift into one later, because there is no second build to drift from. A Next
 * `transpilePackages` entry or a resolve alias would have been a third answer to "where does
 * the engine come from", which is the shape this repo keeps finding and removing.
 *
 * ## Outputs, all under public/markforge/ and all gitignored
 *
 *   markforge.js        the eager bundle          window.MarkForge
 *   markforge-pdf.js    the deferred PDF chunk    window.MarkForgePdf
 *   typst.wasm          the Typst compiler, fetched only when a user asks for a PDF
 *   fonts/              the five shipped faces, plus manifest.json
 *   samples/            demo documents copied out of fixtures/
 *   examples.json       real conversions, run here by the real engine
 *
 * `samples/` is a copy rather than a commit for a reason beyond size: `check-docs.mjs`
 * fails any git-trackable office binary anywhere in the tree, and `check-fixtures.mjs`
 * resolves licence rows relative to `fixtures/`, so a registered `apps/**.docx` would be
 * reported as phantom. A gitignored copy satisfies both by not existing in git.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBrowserBundle, buildBrowserPdfBundle } from "../../../scripts/lib/browser-bundle.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(WEB, "public/markforge");

const kb = (n) => `${Math.round(n / 1024).toLocaleString("en-US")} KB`;
const load = (rel) => import(pathToFileURL(join(REPO, rel)).href);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "fonts"), { recursive: true });
mkdirSync(join(OUT, "samples"), { recursive: true });

// ---------------------------------------------------------------------------------------
// 1. The two browser bundles

const [eager, deferred] = await Promise.all([buildBrowserBundle(), buildBrowserPdfBundle()]);
writeFileSync(join(OUT, "markforge.js"), eager.code);
writeFileSync(join(OUT, "markforge-pdf.js"), deferred.code);

// ---------------------------------------------------------------------------------------
// 2. The Typst compiler and the font set
//
// Both paths are the literal ones scripts/check-surface-parity.mjs uses, resolved from the
// repo root where the `@myriaddreamin/*` pins live. SHIPPED_FONTS is imported from the built
// package rather than re-typed here: two lists of five filenames is exactly how the browser
// leg would quietly stop matching the Node leg. The import is by absolute path so this app
// needs no dependency on @markforge/typst-node, whose NAPI binaries it must not carry.

const WASM_SRC = "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";
copyFileSync(join(REPO, WASM_SRC), join(OUT, "typst.wasm"));
const wasmBytes = readFileSync(join(REPO, WASM_SRC)).length;

const { SHIPPED_FONTS } = await load("packages/typst-node/dist/index.js");
const fonts = SHIPPED_FONTS.map((file) => {
  copyFileSync(join(REPO, "fonts", file), join(OUT, "fonts", file));
  // The same derivation as packages/typst-node/src/index.ts and check-surface-parity.mjs.
  // Typst matches on the family name, and a mismatch produces a valid PDF with zero
  // extractable text and no error, so this must not be spelled a second way.
  return { family: file.replace(/\.(otf|ttf)$/, ""), file };
});
writeFileSync(join(OUT, "fonts/manifest.json"), `${JSON.stringify(fonts, null, 2)}\n`);

// ---------------------------------------------------------------------------------------
// 3. Demo documents
//
// Chosen so that every one of them demonstrates something true rather than something
// flattering. `nested-restarting-lists` is the corpus floor at 16.5% structural through
// md->pdf->md; `tables-merged-horizontal` is the fixture that makes the renderer say
// MF-RENDER-0006 out loud.

const SAMPLES = [
  { file: "fixtures/md/clean-report.md", as: "clean-report.md", from: "md",
    label: "Clean report", note: "Headings, lists, a table, and inline marks." },
  { file: "fixtures/md/tables.md", as: "tables.md", from: "md",
    label: "Tables", note: "Alignment and header rows across the formats that support them." },
  { file: "fixtures/md/inline-marks.md", as: "inline-marks.md", from: "md",
    label: "Inline marks", note: "The span kinds that span F1 measures." },
  { file: "fixtures/md/nested-restarting-lists.md", as: "nested-restarting-lists.md", from: "md",
    label: "Nested restarting lists", note: "The corpus floor. Scores 16.5% structural through md to pdf to md." },
  { file: "fixtures/html/semantic-structure.html", as: "semantic-structure.html", from: "html",
    label: "Semantic HTML", note: "Figures, captions, and description lists." },
  { file: "fixtures/docx/messy-direct-formatting.docx", as: "messy-direct-formatting.docx", from: "docx",
    label: "Word, no named styles", note: "Bold 16pt text standing in for a heading. Evidence, not structure." },
  { file: "fixtures/docx/tables-merged-horizontal.docx", as: "tables-merged-horizontal.docx", from: "docx",
    label: "Merged table cells", note: "A construct Markdown cannot express. Reported, not dropped." },
  { file: "fixtures/docx/tracked-changes-two-authors.docx", as: "tracked-changes-two-authors.docx", from: "docx",
    label: "Tracked changes", note: "Two authors of insertions and deletions." },
];

for (const s of SAMPLES) copyFileSync(join(REPO, s.file), join(OUT, "samples", s.as));
writeFileSync(
  join(OUT, "samples/manifest.json"),
  `${JSON.stringify(SAMPLES.map(({ as, from, label, note }) => ({ file: as, from, label, note })), null, 2)}\n`,
);

// ---------------------------------------------------------------------------------------
// 4. Vocabulary the UI has to name: the flavour presets and the IR node types
//
// Both are read from the artifacts that define them rather than retyped. A UI listing seven
// flavours is a second copy of a list ADR-0021 gates for distinctness, and a UI listing 53
// node types is a second copy of the schema; either would be right on the day it was written
// and wrong later, with nothing to notice.

// `stringify` and the renderer defaults both ship, because the options panel has to show the
// *effective* value of every control. renderMarkdown resolves them as
// `{ ...DEFAULT_MD_OPTIONS, ...preset.stringify, ...options }`, so a panel that showed the
// global default while a flavour had overridden it would be lying about what the next
// conversion will do, and a panel that sent every value explicitly would defeat that merge.
const { FLAVORS } = await load("packages/render-md/dist/flavors.js");
const { DEFAULT_MD_OPTIONS } = await load("packages/render-md/dist/index.js");
writeFileSync(
  join(OUT, "flavors.json"),
  `${JSON.stringify(
    {
      defaults: DEFAULT_MD_OPTIONS,
      presets: Object.values(FLAVORS).map((f) => ({
        id: f.id,
        displayName: f.displayName,
        reference: f.reference,
        syntax: f.syntax,
        stringify: f.stringify,
      })),
    },
    null,
    2,
  )}\n`,
);

// A node type is a definition in the IR schema that pins `type` to a constant. That is what
// makes it a node rather than a supporting shape like BBox or Provenance.
// The committed baselines, verbatim. CI recomputes these and fails on any drop beyond the
// tolerance, so the file is a measurement rather than a claim, and copying it means the site
// quotes the same numbers the build enforces.
copyFileSync(join(REPO, "fixtures/expected/baselines.json"), join(OUT, "baselines.json"));

const irSchema = JSON.parse(readFileSync(join(REPO, "packages/ir/schema/ir.v0.schema.json"), "utf8"));
const nodeTypes = Object.values(irSchema.$defs ?? irSchema.definitions ?? {})
  .map((d) => d?.properties?.type?.const)
  .filter((t) => typeof t === "string")
  .sort();
writeFileSync(join(OUT, "node-types.json"), `${JSON.stringify(nodeTypes, null, 2)}\n`);

// ---------------------------------------------------------------------------------------
// 5. Worked examples for the landing page, run by the real engine
//
// The alternative was to paste a diagnostic into JSX. On a site whose entire claim is that
// its numbers are measured, a hand-written example of a measurement would be the one
// dishonest thing on the page. If the renderer stops emitting MF-RENDER-0006, this build
// fails rather than the page continuing to say it does.

const { convert } = await load("packages/core/dist/index.js");

async function example({ input, from, to, expectCode, options = {} }) {
  const bytes = new Uint8Array(readFileSync(join(REPO, input)));
  const result = await convert(bytes, { from, to, path: input, ...options });
  const diagnostics = result.diagnostics.map((d) => ({
    code: d.code, severity: d.severity, message: d.message, lossy: d.lossy,
    ...(d.construct ? { construct: d.construct } : {}),
    ...(d.retained ? { retained: d.retained } : {}),
  }));
  if (expectCode && !diagnostics.some((d) => d.code === expectCode)) {
    throw new Error(
      `prepare-assets: ${input} -> ${to} no longer emits ${expectCode}. The landing page ` +
        `quotes this diagnostic as a live measurement, so a change here has to be a decision. ` +
        `Got: ${diagnostics.map((d) => d.code).join(", ") || "(none)"}`,
    );
  }
  return {
    input, from, to,
    source: from === "docx" ? null : readFileSync(join(REPO, input), "utf8"),
    output: new TextDecoder().decode(result.bytes),
    diagnostics,
  };
}

const MERGED = { input: "fixtures/docx/tables-merged-horizontal.docx", from: "docx", to: "md" };

/**
 * A real digest, for the section that claims four surfaces produce the same bytes.
 *
 * Computed here from an actual conversion rather than pasted. `scripts/check-surface-parity.mjs`
 * is what proves the claim; this is the page showing a number it can be checked against, and
 * a reader with the repo can run the same conversion and get the same string.
 */
async function parityDigest(input, from, to) {
  const bytes = new Uint8Array(readFileSync(join(REPO, input)));
  const result = await convert(bytes, { from, to, path: input });
  return {
    input,
    to,
    bytes: result.bytes.length,
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
  };
}

const examples = {
  // The headline pair, and the reason it is a pair.
  //
  // A merged cell cannot be expressed in a GFM pipe table. There are exactly two honest
  // responses to that and MarkForge implements both, chosen by `markdown.tables`:
  //
  //   auto (the default)  keep the table as HTML. Nothing is lost, but the output is no
  //                       longer pipe-table Markdown, and MF-RENDER-0007 says so.
  //   gfm (forced)        flatten the spans into a pipe table. Now something IS lost, and
  //                       MF-RENDER-0006 carries lossy: true.
  //
  // Showing one without the other would be showing a trade-off as if it were a limitation.
  mergedCellsAsHtml: await example({ ...MERGED, expectCode: "MF-RENDER-0007" }),
  mergedCellsFlattened: await example({
    ...MERGED, expectCode: "MF-RENDER-0006", options: { markdown: { tables: "gfm" } },
  }),
  // Direct formatting is evidence. Inference promotes it and records that it did.
  directFormatting: await example({
    input: "fixtures/docx/messy-direct-formatting.docx", from: "docx", to: "md",
  }),
};

const parity = await parityDigest("fixtures/md/clean-report.md", "md", "docx");
writeFileSync(join(OUT, "parity.json"), `${JSON.stringify(parity, null, 2)}\n`);

// ---------------------------------------------------------------------------------------
// 6. A rendered page, as an image
//
// The site is about what happens to documents and until this existed it never showed one.
// The honest way to fix that is not stock photography of a desk: it is to render a page with
// the same compiler, the same Typst markup and the same fonts the PDF writer uses, and put
// that on the page.
//
// SVG rather than a raster, for three reasons that all matter here. It stays sharp at any
// size, it needs no rasteriser in the build, and it is text rather than pixels, so a reader
// who doubts it is a real render can open it. The compiler is the Node binding rather than
// the WASM one: this runs at build time, where a native addon is free.
const renderedPage = await (async () => {
  const { NodeCompiler } = await import("@myriaddreamin/typst-ts-node-compiler");
  const { toTypst } = await load("packages/render-pdf/dist/index.js");
  const { loadShippedFonts } = await load("packages/typst-node/dist/index.js");

  const input = "fixtures/md/clean-report.md";
  const bytes = new Uint8Array(readFileSync(join(REPO, input)));
  // Parsed and inferred exactly as a conversion would, by going through `convert` and
  // taking the document rather than the bytes.
  const { document } = await convert(bytes, { from: "md", to: "md", path: input });

  const fonts = loadShippedFonts();
  const compiler = NodeCompiler.create({
    fontArgs: [{ fontBlobs: fonts.map((f) => Buffer.from(f.bytes)) }],
  });
  const svg = compiler.svg({ mainFileContent: toTypst(document).source });

  if (!svg.startsWith("<svg")) {
    throw new Error("prepare-assets: the Typst compiler returned no SVG for the sample page.");
  }
  writeFileSync(join(OUT, "rendered-page.svg"), svg);
  return { input, bytes: svg.length };
})();
writeFileSync(join(OUT, "examples.json"), `${JSON.stringify(examples, null, 2)}\n`);

// ---------------------------------------------------------------------------------------

const diagCount = Object.values(examples).reduce((n, e) => n + e.diagnostics.length, 0);
console.log(
  `prepare-assets: engine ${kb(eager.code.length)}, pdf chunk ${kb(deferred.code.length)}, ` +
    `typst.wasm ${kb(wasmBytes)}, ${fonts.length} fonts, ${SAMPLES.length} samples, ` +
    `${Object.keys(FLAVORS).length} flavours, ${nodeTypes.length} node types, ` +
    `${Object.keys(examples).length} examples (${diagCount} diagnostics)`,
);
