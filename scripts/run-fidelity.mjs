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
const { inferHeadings } = await load("infer");
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
  inferHeadings(fromDocx);
  measured.push(entry(name, "md->docx->md", compare(original, fromDocx)));

  // --- Loop 3: docx -> md -> docx. Stability of the binary side.
  const roundTripped = renderMarkdown(fromDocx).markdown;
  const secondDocx = renderDocx(parseMarkdown(roundTripped).document, {
    onMissingStyle: "synthesize",
  }).bytes;
  const secondParsed = parseDocx(secondDocx).document;
  measured.push(entry(name, "docx->md->docx", compare(fromDocx, secondParsed)));

  // --- Loop 4: md -> html -> md. Phase 2.
  const html = renderHtml(original, { fullDocument: false }).html;
  const fromHtml = parseHtmlDocument(html).document;
  measured.push(entry(name, "md->html->md", compare(original, fromHtml)));
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
  inferHeadings(viaDocx);
  measured.push(entry(name, "html->docx->html", compare(original, viaDocx)));

  const md = renderMarkdown(original).markdown;
  measured.push(entry(name, "html->md->html", compare(original, parseMarkdown(md).document)));
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
  };
}

// Rounded to four places. Floating-point noise in the last bits would otherwise
// make committed baselines churn on every run for no real reason.
function round(n) {
  return typeof n === "number" && n >= 0 ? Math.round(n * 10000) / 10000 : n;
}

const markdown = renderFidelityMarkdown(measured, {
  generatedFrom: "fixtures/md and fixtures/html via scripts/run-fidelity.mjs",
  corpusSize: mdFixtures.length + htmlFixtures.length,
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
    `Wrote ${measured.length} baseline entries for ${mdFixtures.length + htmlFixtures.length} fixture(s).`,
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
