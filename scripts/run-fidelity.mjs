// Runs the fidelity harness over the golden corpus and writes docs/FIDELITY.md.
//
// docs/CORPUS.md and ADR-0010: the numbers are measured, committed as baselines,
// and CI fails on a regression beyond tolerance. This script is the thing that
// measures them, so it deliberately has no way to skip a fixture or suppress a row.
//
//   node scripts/run-fidelity.mjs            measure and report
//   node scripts/run-fidelity.mjs --update   rewrite the baselines
//   node scripts/run-fidelity.mjs --check    fail on regression (CI)
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");
const CHECK = args.has("--check");

// Imported from built output: the harness measures what ships, not what the source
// would do if it were bundled differently.
//
// pathToFileURL, not a bare path: on Windows a dynamic import of "C:\..." is
// rejected as an unsupported URL scheme, because the drive letter parses as one.
const load = (pkg) => import(pathToFileURL(join(REPO, `packages/${pkg}/dist/index.js`)).href);

const { parseMarkdown } = await load("adapters-md");
const { renderMarkdown } = await load("render-md");
const { renderDocx } = await load("render-docx");
const { parseDocx } = await load("adapters-docx");
const { parseHtmlDocument } = await load("adapters-html");
const { renderHtml } = await load("render-html");
// inferAll, not inferHeadings: @markforge/core runs inferAll, so measuring with
// anything less measures a pipeline we do not ship. Blockquote recovery lives in
// inferBlockquotes, and leaving it out made every blockquote look like a permanent
// loss through the DOCX path.
const { inferAll } = await load("infer");
const { compare, compareToBaselines, renderFidelityMarkdown } = await load("fidelity");

const MD_CORPUS = join(REPO, "fixtures/md");
const HTML_CORPUS = join(REPO, "fixtures/html");
const BASELINES = join(REPO, "fixtures/expected/baselines.json");

const mdFixtures = readdirSync(MD_CORPUS).filter((f) => f.endsWith(".md")).sort();
const htmlFixtures = existsSync(HTML_CORPUS)
  ? readdirSync(HTML_CORPUS).filter((f) => f.endsWith(".html")).sort()
  : [];

if (mdFixtures.length + htmlFixtures.length === 0) {
  console.error("No fixtures found. Nothing to measure.");
  process.exit(1);
}

const measured = [];

for (const file of mdFixtures) {
  const name = file.replace(/\.md$/, "");
  const source = readFileSync(join(MD_CORPUS, file), "utf8");
  const original = parseMarkdown(source, { path: `fixtures/md/${file}` }).document;

  // --- Loop 1: md -> md. The formatter's own fixed point.
  const formatted = renderMarkdown(original).markdown;
  const reparsed = parseMarkdown(formatted).document;
  measured.push(entry(name, "md->md", compare(original, reparsed)));

  // --- Loop 2: md -> docx -> md. The Phase 1 gate.
  const docxBytes = renderDocx(original, { onMissingStyle: "synthesize" }).bytes;
  const fromDocx = parseDocx(docxBytes).document;
  inferAll(fromDocx);
  measured.push(entry(name, "md->docx->md", compare(original, fromDocx)));

  // --- Loop 3: docx -> md -> docx. Stability of the binary side.
  const roundTripped = renderMarkdown(fromDocx).markdown;
  const secondDocx = renderDocx(parseMarkdown(roundTripped).document, {
    onMissingStyle: "synthesize",
  }).bytes;
  const secondParsed = parseDocx(secondDocx).document;
  // Inference on both sides or the comparison is between unlike trees. `fromDocx` has
  // been through inference and this had not, so every heading counted as a lost
  // heading and a gained paragraph — the loop under-reported itself at 96.8% when it
  // was actually clean. Found by the node-type census, which is the entire argument
  // for having one.
  inferAll(secondParsed);
  measured.push(entry(name, "docx->md->docx", compare(fromDocx, secondParsed)));

  // --- Loop 4: md -> html -> md. Phase 2.
  const html = renderHtml(original, { fullDocument: false }).html;
  const fromHtml = parseHtmlDocument(html).document;
  measured.push(entry(name, "md->html->md", compare(original, fromHtml)));
}

// The messy DOCX corpus (§2.3 and §2.15). These start as DOCX, so the loop begins
// there — and unlike every other fixture they are *designed* to be hard, so these rows
// are the ones worth watching. A regression here means a real-world document got worse.
const DOCX_CORPUS = join(REPO, "fixtures/docx");
const docxFixtures = existsSync(DOCX_CORPUS)
  ? readdirSync(DOCX_CORPUS).filter((f) => f.endsWith(".docx")).sort()
  : [];

for (const file of docxFixtures) {
  const name = file.replace(/\.docx$/, "");
  const bytes = new Uint8Array(readFileSync(join(DOCX_CORPUS, file)));
  const original = parseDocx(bytes, { path: `fixtures/docx/${file}` }).document;
  inferAll(original);

  // docx -> md -> docx, the Phase 1 gate loop, on documents that fight back.
  const md = renderMarkdown(original).markdown;
  const reDocx = renderDocx(parseMarkdown(md).document, { onMissingStyle: "synthesize" }).bytes;
  const back = parseDocx(reDocx).document;
  inferAll(back);
  measured.push(entry(name, "docx->md->docx", compare(original, back)));

  // docx -> html, so a lossy path other than Markdown is measured too.
  const html = renderHtml(original, { fullDocument: false }).html;
  measured.push(entry(name, "docx->html", compare(original, parseHtmlDocument(html).document)));
}

// HTML fixtures are the table-span ground truth (docs/CORPUS.md §2.5), so they are
// measured through DOCX as well: the gap between the html->html and html->docx->html
// table scores is exactly how much the DOCX path loses.
for (const file of htmlFixtures) {
  const name = file.replace(/\.html$/, "");
  const source = readFileSync(join(HTML_CORPUS, file), "utf8");
  const original = parseHtmlDocument(source, { path: `fixtures/html/${file}` }).document;

  const html = renderHtml(original, { fullDocument: false }).html;
  measured.push(entry(name, "html->html", compare(original, parseHtmlDocument(html).document)));

  const docxBytes = renderDocx(original, { onMissingStyle: "synthesize" }).bytes;
  const viaDocx = parseDocx(docxBytes).document;
  inferAll(viaDocx);
  measured.push(entry(name, "html->docx->html", compare(original, viaDocx)));

  const md = renderMarkdown(original).markdown;
  measured.push(entry(name, "html->md->html", compare(original, parseMarkdown(md).document)));
}

// --- The Phase 3 subsets: the same document down the deterministic path and down the
// LLM-assisted one, each against an answer key.
//
// This is the measurement the Phase 3 done-criterion names, and it is run **from the
// committed cache in readOnly mode**, so it needs no API key and makes no network call.
// That is the point of a content-addressed cache: the LLM rows are as reproducible as
// every other row here, and CI measures them without talking to a gateway.
//
// A note on what these rows are *not*. Every other row in this file is a round trip, where
// the input is its own answer key. These two are one-way conversions measured against a
// committed ground-truth Markdown file, because a scan has no round trip — the deterministic
// path cannot read it at all, which is exactly the difference being measured.
const { LlmSession, headingTiebreaker, visionRecognizer } = await load("llm");
const { documentFromPages } = await load("adapters-ocr");
const { readPdf } = await load("adapters-pdf");
const { resolveAmbiguities } = await load("infer");

const CACHE_DIR = join(REPO, ".markforge/llm-cache");
const cachedSession = () =>
  new LlmSession({
    baseUrl: "https://api.ai.it.ufl.edu/v1",
    models: { fast: "gpt-oss-120b", strong: "nemotron-3-super-120b-a12b", vision: "gemma-4-31b-it", embed: "nomic-embed-text-v1.5" },
    cache: { dir: CACHE_DIR, mode: "readOnly" },
    // Guided decoding was measured on this deployment (OPEN_QUESTIONS §3) and the recorded
    // cache entries were produced with it, so the cache key must be computed the same way.
    // Getting this wrong would miss every entry and look like a model failure.
    capabilities: {
      baseUrl: "https://api.ai.it.ufl.edu/v1",
      probedModel: "gpt-oss-120b",
      guidedDecoding: true,
      seed: true,
      probedAt: new Date().toISOString(),
      evidence: ["Pinned to match the committed cache; see docs/OPEN_QUESTIONS.md §3."],
    },
    seed: 20260731,
  });

// --- Subset 1: the scanned PDF (CORPUS §2.7).
const SCAN = join(REPO, "fixtures/pdf/scanned-150dpi.pdf");
if (existsSync(SCAN)) {
  const truthSource = readFileSync(join(REPO, "fixtures/md/scanned-source.md"), "utf8");
  const truth = parseMarkdown(truthSource, { path: "fixtures/md/scanned-source.md" }).document;
  const bytes = new Uint8Array(readFileSync(SCAN));

  // The deterministic path. It does not produce a bad document, it produces *no*
  // document — `readPdf` reports a scan and `parsePdf` throws rather than returning
  // something that looks like a successful conversion. Scored as zero, because that is
  // what "MarkForge could not read this file" is worth, and pretending otherwise would
  // flatter the deterministic path on the one corpus where it genuinely cannot compete.
  const scanRead = await readPdf(bytes, { path: "fixtures/pdf/scanned-150dpi.pdf" });
  if (scanRead.kind !== "scan") throw new Error("scanned-150dpi.pdf is no longer detected as a scan");
  measured.push(zeroEntry("scanned-150dpi-nollm", "scan->md"));

  // The cached vision path.
  const session = cachedSession();
  const ocr = await documentFromPages(scanRead.pages, visionRecognizer(session), {
    path: "fixtures/pdf/scanned-150dpi.pdf",
    sourceBytes: bytes,
    mediaType: "application/pdf",
  });
  measured.push(entry("scanned-150dpi", "scan->md", compare(truth, ocr.document)));

  // The local OCR path. Runs only when `node scripts/fetch-ocr-assets.mjs` has put
  // `eng.traineddata` in `fixtures/local/tessdata` — it is 4 MB of third-party model
  // weights and CORPUS.md §4 keeps that out of git — so this row is absent rather than
  // wrong on a machine that has not fetched it.
  //
  // This row is the point of having two recognisers. SPEC §3.3 claims a vision model
  // recovers structure tesseract cannot, because tesseract returns text and a confidence
  // while a vision model can see that a line is large and bold. That was an argument until
  // there were two numbers next to each other; now it is a measurement.
  const TESSDATA = join(REPO, "fixtures/local/tessdata");
  if (existsSync(join(TESSDATA, "eng.traineddata"))) {
    const { createTesseractRecognizer } = await load("adapters-ocr");
    const recognize = createTesseractRecognizer({ langPath: TESSDATA });
    try {
      const local = await documentFromPages(scanRead.pages, recognize, {
        path: "fixtures/pdf/scanned-150dpi.pdf",
        sourceBytes: bytes,
        mediaType: "application/pdf",
      });
      measured.push(entry("scanned-150dpi-tesseract", "scan->md", compare(truth, local.document)));
    } finally {
      await recognize.close?.();
    }
  }
}

// --- Subset 2: ambiguous headings (CORPUS §2.3).
const AMBIGUOUS = join(REPO, "fixtures/docx/messy-ambiguous-headings.docx");
const AMBIGUOUS_TRUTH = join(REPO, "fixtures/expected/ambiguous-headings-truth.md");
if (existsSync(AMBIGUOUS) && existsSync(AMBIGUOUS_TRUTH)) {
  const truth = parseMarkdown(readFileSync(AMBIGUOUS_TRUTH, "utf8"), {
    path: "fixtures/expected/ambiguous-headings-truth.md",
  }).document;
  const bytes = new Uint8Array(readFileSync(AMBIGUOUS));

  // Deterministic: every close call resolved by score, which promotes all four candidates.
  const plain = parseDocx(bytes, { path: "fixtures/docx/messy-ambiguous-headings.docx" }).document;
  const plainInfer = inferAll(plain);
  if (plainInfer.ambiguous.length === 0) {
    throw new Error(
      "messy-ambiguous-headings.docx no longer produces any ambiguous decision, so the " +
        "Phase 3 ambiguous subset is measuring nothing. Check inferHeadings' scoring.",
    );
  }
  measured.push(entry("ambiguous-headings-nollm", "docx->truth", compare(truth, plain)));

  // LLM-assisted: the same four calls, answered from the committed cache.
  const assisted = parseDocx(bytes, { path: "fixtures/docx/messy-ambiguous-headings.docx" }).document;
  const assistedInfer = inferAll(assisted);
  await resolveAmbiguities(assisted, assistedInfer.ambiguous, headingTiebreaker(cachedSession()));
  measured.push(entry("ambiguous-headings", "docx->truth", compare(truth, assisted)));
}

/** A conversion that could not happen at all. Every metric is zero, by definition. */
function zeroEntry(fixture, loop) {
  return {
    fixture,
    loop,
    structural: 0,
    textSensitive: 0,
    textInsensitive: 0,
    tableF1: 0,
    tableContentF1: 0,
    spanF1: 0,
    census: { gained: [], lost: [{ type: "*", count: 0, note: "the file could not be read" }] },
  };
}

function entry(fixture, loop, score) {
  return {
    fixture,
    loop,
    structural: round(score.structural.score),
    textSensitive: round(score.text.sensitive),
    textInsensitive: round(score.text.insensitive),
    tableF1: round(score.table.full.f1),
    tableContentF1: round(score.table.contentOnly.f1),
    spanF1: round(score.spans.f1),
    // Named node-type differences, so a regression report says which construct moved
    // rather than only how far a number fell.
    census: score.census,
  };
}

// Rounded to four places. Floating-point noise in the last bits would otherwise
// make committed baselines churn on every run for no real reason.
function round(n) {
  return typeof n === "number" && n >= 0 ? Math.round(n * 10000) / 10000 : n;
}

const markdown = renderFidelityMarkdown(measured, {
  generatedFrom: "fixtures/md, fixtures/html, and fixtures/docx via scripts/run-fidelity.mjs",
  corpusSize: mdFixtures.length + htmlFixtures.length + docxFixtures.length,
});
writeFileSync(join(REPO, "docs/FIDELITY.md"), markdown, "utf8");

if (UPDATE || !existsSync(BASELINES)) {
  mkdirSync(join(REPO, "fixtures/expected"), { recursive: true });
  writeFileSync(
    BASELINES,
    JSON.stringify({ version: 1, tolerance: 0.005, entries: measured }, null, 2) + "\n",
    "utf8",
  );
  console.log(
    `Wrote ${measured.length} baseline entries for ${mdFixtures.length + htmlFixtures.length + docxFixtures.length} fixture(s).`,
  );
  console.log("docs/FIDELITY.md regenerated.");
  process.exit(0);
}

const baselines = JSON.parse(readFileSync(BASELINES, "utf8"));
const result = compareToBaselines(baselines, measured);

for (const r of result.regressions) {
  console.log(
    `REGRESSION ${r.fixture} ${r.loop} ${r.metric}: ${r.baseline.toFixed(4)} -> ${r.measured.toFixed(4)} (${r.delta.toFixed(4)})`,
  );
}
for (const r of result.improvements) {
  // Reported, not celebrated: a jump is as likely to mean the metric broke as that
  // the converter improved.
  console.log(
    `improved   ${r.fixture} ${r.loop} ${r.metric}: ${r.baseline.toFixed(4)} -> ${r.measured.toFixed(4)} (+${r.delta.toFixed(4)}) — confirm this is real, then --update`,
  );
}
for (const k of result.missing) console.log(`missing    ${k} (in baselines, not measured)`);
for (const k of result.added) console.log(`new        ${k} (measured, not in baselines) — run --update`);

console.log(
  `\n${measured.length} measurements across ${mdFixtures.length + htmlFixtures.length} fixture(s): ` +
    `${result.regressions.length} regression(s), ${result.improvements.length} improvement(s).`,
);

// Exit 4 is the fidelity-regression code from SPEC §8.
if (CHECK && result.regressions.length > 0) process.exit(4);
process.exit(0);
