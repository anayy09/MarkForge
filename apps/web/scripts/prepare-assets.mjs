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

writeFileSync(join(OUT, "examples.json"), `${JSON.stringify(examples, null, 2)}\n`);

// Section 6 built `rendered-page.svg`: a page of `clean-report.md` compiled by the Node Typst
// binding, with the same markup and the same fonts the PDF writer uses. It is deleted as of
// 2026-08-02 along with the landing section that displayed it. Nothing served the file, and a
// build step that imports a native addon to produce an asset no page requests is weight with
// no reader. The Typst path is still exercised on every run by `check:pdf` and
// `check:pdf-fonts`, which is where a compiler regression should be caught anyway.

// ---------------------------------------------------------------------------------------
// 7. The Agent Context Compiler's inputs: target profiles, and a folder to try it on
//
// ## Why the profiles are resolved here rather than fetched as-is
//
// `targets/` holds twelve profile files, and several are deltas: `claude-md` declares no
// `sections` because it inherits the base's. Serving those raw would give the browser an
// object whose `extends` was never applied, and an unresolved profile does not fail loudly
// — it assembles an empty file that the traceability gate then passes at 100%, which is the
// worst possible failure for a feature whose entire claim is provenance.
//
// So resolution and schema validation happen here, in Node, where ajv and the schema exist.
// `registryFromProfiles` in the browser refuses anything still carrying `extends`, so the
// two ends agree about what "resolved" means rather than trusting each other.

const { resolveAllProfiles } = await load("packages/agentify/dist/registry-node.js");
const profiles = resolveAllProfiles(join(REPO, "targets"));
writeFileSync(join(OUT, "targets.json"), `${JSON.stringify(profiles, null, 2)}\n`);

// The five-document clean set from `fixtures/agentify/clean/`, which is the exact corpus
// docs/AGENTIFY.md measures the acceptance criterion on: mixed formats (Markdown, HTML and
// a DOCX), authored before the extractor existed. A visitor who clicks "try the sample"
// gets the run the project's own gate reports on, not a curated happy path.
mkdirSync(join(OUT, "agentify-sample"), { recursive: true });
const AGENTIFY_SAMPLE = [
  { file: "product-spec.md", label: "Product spec" },
  { file: "architecture.md", label: "Architecture notes" },
  { file: "runbook.md", label: "Runbook" },
  { file: "api-contract.html", label: "API contract" },
  { file: "conventions.docx", label: "Coding conventions" },
];
for (const s of AGENTIFY_SAMPLE) {
  copyFileSync(join(REPO, "fixtures/agentify/clean", s.file), join(OUT, "agentify-sample", s.file));
}
writeFileSync(
  join(OUT, "agentify-sample/manifest.json"),
  `${JSON.stringify(AGENTIFY_SAMPLE, null, 2)}\n`,
);

/**
 * A real compile of that sample set, for the landing page to quote.
 *
 * Same reasoning as the conversion examples above: the page's whole argument is that its
 * numbers are measured, so an illustrative AGENTS.md pasted into JSX would be the one
 * dishonest thing on it. This runs the actual compiler over the actual corpus, and the
 * traceability figure the page prints is the figure the gate computed here. If extraction
 * regresses, this build fails rather than the page continuing to advertise the old number.
 */
const agentifyExample = await (async () => {
  const { compile, authorityOf } = await load("packages/agentify/dist/index.js");
  const { registryFromProfiles } = await load("packages/agentify/dist/index.js");
  const { parse } = await load("packages/core/dist/index.js");

  const sources = [];
  for (const { file } of AGENTIFY_SAMPLE) {
    const path = join(REPO, "fixtures/agentify/clean", file);
    const bytes = new Uint8Array(readFileSync(path));
    const format = file.endsWith(".docx") ? "docx" : file.endsWith(".html") ? "html" : "md";
    const parsed = await parse(bytes, format, file);
    const sourceText = format === "docx" ? "" : readFileSync(path, "utf8");
    sources.push({
      path: file,
      document: parsed.document,
      sourceText,
      role: "unknown",
      authority: authorityOf(sourceText, [], file),
    });
  }

  const run = await compile(sources, {
    registry: registryFromProfiles(profiles),
    targets: ["agents-md", "claude-skills"],
  });

  const agents = run.results.find((r) => r.target === "agents-md")?.files[0];
  if (!agents || run.report.targets[0].traceability < 1) {
    throw new Error(
      `prepare-assets: the sample compile no longer reaches 100% traceability ` +
        `(${run.report.targets[0]?.traceability}). The landing page states that figure as a ` +
        `measurement, so this is a decision to make rather than a number to update.`,
    );
  }

  const manifestFile = run.manifest.files.find((f) => f.path === agents.path);
  const traced = manifestFile.sections.flatMap((s) => s.sentences).filter((s) => s.unitIds.length);

  return {
    documents: AGENTIFY_SAMPLE.length,
    units: run.units.length,
    tracedSentences: traced.length,
    traceability: run.report.targets[0].traceability,
    files: run.results.flatMap((r) => r.files.map((f) => ({ path: f.path, tokens: f.tokens }))),
    // Enough of the real file to show its shape, cut at a line boundary so the excerpt is
    // never a half-written table row.
    excerpt: agents.content.split("\n").slice(0, 22).join("\n"),
  };
})();
writeFileSync(join(OUT, "agentify-example.json"), `${JSON.stringify(agentifyExample, null, 2)}\n`);

// ---------------------------------------------------------------------------------------

const diagCount = Object.values(examples).reduce((n, e) => n + e.diagnostics.length, 0);
console.log(
  `prepare-assets: engine ${kb(eager.code.length)}, pdf chunk ${kb(deferred.code.length)}, ` +
    `typst.wasm ${kb(wasmBytes)}, ${fonts.length} fonts, ${SAMPLES.length} samples, ` +
    `${Object.keys(FLAVORS).length} flavours, ${nodeTypes.length} node types, ` +
    `${Object.keys(examples).length} examples (${diagCount} diagnostics), ` +
    `${profiles.length} target profiles, ${AGENTIFY_SAMPLE.length} sample documents, ` +
    `agentify example ${agentifyExample.tracedSentences} traced sentences at ` +
    `${(agentifyExample.traceability * 100).toFixed(1)}%`,
);
