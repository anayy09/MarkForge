// Scores MarkForge against Pandoc on the same corpus, and writes docs/SCOREBOARD.md.
//
// docs/CORPUS.md §3 requires this, and the Phase 1 done-criterion is stated in terms
// of it: "docx -> md -> docx beats the reference project and Pandoc on our corpus".
// Until Pandoc was installed the claim was unverifiable, so it went unmade.
//
// It is now measurable, and the answer is mixed. The report says so.
//
//   node scripts/run-scoreboard.mjs            measure and report
//   node scripts/run-scoreboard.mjs --check    fail on regression (CI)
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");

const load = (pkg) => import(pathToFileURL(join(REPO, `packages/${pkg}/dist/index.js`)).href);
const { parseMarkdown } = await load("adapters-md");
const { renderMarkdown } = await load("render-md");
const { renderDocx } = await load("render-docx");
const { parseDocx } = await load("adapters-docx");
const { inferHeadings } = await load("infer");
const { compare } = await load("fidelity");

/** Locates pandoc without assuming PATH — a fresh MSI install often is not on it. */
function findPandoc() {
  const candidates = [
    "pandoc",
    join(process.env["LOCALAPPDATA"] ?? "", "Pandoc", "pandoc.exe"),
    "C:/Program Files/Pandoc/pandoc.exe",
    "/usr/bin/pandoc",
    "/usr/local/bin/pandoc",
  ];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return { path: candidate, version: (probe.stdout ?? "").split("\n")[0]?.trim() ?? "unknown" };
    }
  }
  return undefined;
}

const pandoc = findPandoc();
if (!pandoc) {
  // Skip rather than fail: a comparison with a missing competitor is impossible, not
  // failed. CI installs pandoc; a contributor's laptop need not have it.
  console.log(
    "SKIP scoreboard: pandoc not found. Install it (winget install JohnMacFarlane.Pandoc)\n" +
      "     to compare against it. Exiting 0 — a missing competitor is not a regression.",
  );
  process.exit(0);
}

console.log(`Competitor: ${pandoc.version}`);

const CORPUS = join(REPO, "fixtures/md");
const fixtures = readdirSync(CORPUS).filter((f) => f.endsWith(".md")).sort();
const work = mkdtempSync(join(tmpdir(), "markforge-scoreboard-"));

const round = (n) => (typeof n === "number" && n >= 0 ? Math.round(n * 10000) / 10000 : n);
const pct = (n) => (n < 0 ? "n/a" : (n * 100).toFixed(1) + "%");
const pick = (s) => ({
  structural: round(s.structural.score),
  text: round(s.text.insensitive),
  tableF1: round(s.table.full.f1),
  spanF1: round(s.spans.f1),
});

/**
 * A tool's own `md -> md` self-consistency, computed identically for both.
 *
 * The first version of this script did not do that: it compared MarkForge's
 * *DOCX-derived* IR against a Markdown round trip of it, while comparing Pandoc's
 * *Markdown-derived* IR against the same. Pandoc's control came out trivially 100%
 * and ours did not, so the column labelled "bias control" was itself biased. Both now
 * start from the Markdown each tool emits.
 */
function selfConsistency(markdown) {
  const once = parseMarkdown(markdown).document;
  const twice = parseMarkdown(renderMarkdown(once).markdown).document;
  return compare(once, twice);
}

const rows = [];

try {
  for (const file of fixtures) {
    const name = file.replace(/\.md$/, "");
    const source = readFileSync(join(CORPUS, file), "utf8");

    // Ground truth is the IR of the original Markdown. Both tools are measured against
    // it, through the same DOCX.
    const truth = parseMarkdown(source, { path: `fixtures/md/${file}` }).document;

    // One DOCX, written by us, read by both. Using our own writer is unavoidable —
    // a Pandoc-written DOCX would be a different document — and is part of the
    // disclosed bias.
    const docxPath = join(work, `${name}.docx`);
    writeFileSync(docxPath, renderDocx(truth, { onMissingStyle: "synthesize" }).bytes);

    const mine = parseDocx(new Uint8Array(readFileSync(docxPath))).document;
    inferHeadings(mine);

    // Pandoc's Markdown is parsed by *our* adapter, because Pandoc does not produce
    // our IR. That is the second half of the bias, and it is reported alongside.
    const pandocMdPath = join(work, `${name}.pandoc.md`);
    const converted = spawnSync(
      pandoc.path,
      [docxPath, "-f", "docx", "-t", "gfm", "-o", pandocMdPath],
      { encoding: "utf8" },
    );
    if (converted.status !== 0) {
      console.log(`  pandoc failed on ${name}: ${(converted.stderr ?? "").split("\n")[0]}`);
      continue;
    }
    const theirs = parseMarkdown(readFileSync(pandocMdPath, "utf8")).document;

    rows.push({
      fixture: name,
      markforge: pick(compare(truth, mine)),
      pandoc: pick(compare(truth, theirs)),
      markforgeSelf: round(selfConsistency(renderMarkdown(mine).markdown).structural.score),
      pandocSelf: round(selfConsistency(renderMarkdown(theirs).markdown).structural.score),
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const METRICS = [
  ["Structural", (r) => r.markforge.structural, (r) => r.pandoc.structural],
  ["Text", (r) => r.markforge.text, (r) => r.pandoc.text],
  ["Table F1", (r) => r.markforge.tableF1, (r) => r.pandoc.tableF1],
  ["Span F1", (r) => r.markforge.spanF1, (r) => r.pandoc.spanF1],
];

const mean = (get) => {
  const values = rows.map(get).filter((v) => v >= 0);
  return values.length === 0 ? -1 : values.reduce((a, b) => a + b, 0) / values.length;
};

// A half-point band is a tie. Below that the difference is noise, and claiming a win
// on it would be exactly the number-polishing this file exists not to do.
const TIE_BAND = 0.005;

let mineWins = 0;
let theirsWins = 0;
let ties = 0;
const resultRows = [];

for (const row of rows) {
  for (const [label, getMine, getTheirs] of METRICS) {
    const a = getMine(row);
    const b = getTheirs(row);
    const winner = Math.abs(a - b) <= TIE_BAND ? "tie" : a > b ? "MarkForge" : "Pandoc";
    if (winner === "MarkForge") mineWins++;
    else if (winner === "Pandoc") theirsWins++;
    else ties++;
    resultRows.push(`| ${row.fixture} | ${label} | ${pct(a)} | ${pct(b)} | ${winner} |`);
  }
}

const lines = [
  "# Scoreboard",
  "",
  "MarkForge against Pandoc on the same corpus, through the same DOCX, scored with the",
  "metrics in [SPEC.md](SPEC.md) §9. Generated by `node scripts/run-scoreboard.mjs`.",
  "",
  `Competitor: ${pandoc.version}. Corpus: ${rows.length} fixture(s) from \`fixtures/md/\`.`,
  "",
  "## Disclosed bias",
  "",
  "**This comparison advantages MarkForge in one way and penalises it in another.** Both are",
  "structural, neither is removable without a different corpus, and the numbers mean little",
  "without them.",
  "",
  "1. **The DOCX is written by MarkForge**, so it uses the styles and structures our writer",
  "   emits. Pandoc reading a Pandoc-written DOCX would score differently. This favours us.",
  "2. **Ground truth is the original Markdown's IR**, which has mdast's shape, and Pandoc's",
  "   route is `docx -> markdown -> our parser` — mdast-shaped by construction. This favours",
  "   Pandoc, and it is the larger effect of the two.",
  "",
  "The mitigation `docs/CORPUS.md` §3 asks for is the self-consistency row in the means table:",
  "each tool's own `md -> md` score, computed the same way for both. A tool with high",
  "self-consistency and a low conversion score genuinely lost information; one where both are",
  "low is being penalised by the shared parser.",
  "",
  "## Results",
  "",
  "| Fixture | Metric | MarkForge | Pandoc | Winner |",
  "| --- | --- | --: | --: | :-: |",
  ...resultRows,
  "",
  "## Means",
  "",
  "| Metric | MarkForge | Pandoc |",
  "| --- | --: | --: |",
  ...METRICS.map(([label, m, t]) => `| ${label} | ${pct(mean(m))} | ${pct(mean(t))} |`),
  `| *md -> md self-consistency* | ${pct(mean((r) => r.markforgeSelf))} | ${pct(mean((r) => r.pandocSelf))} |`,
  "",
  `Metric-fixture pairs: **${mineWins} to MarkForge, ${theirsWins} to Pandoc, ${ties} tied**`,
  "(within half a percentage point).",
  "",
  "## What this shows",
  "",
  "**Text, table, and span fidelity tie.** Both tools recover the words, the cells, and the",
  "inline marks equally well on this corpus. That is the part a user notices.",
  "",
  "**Pandoc scores higher on the structural metric, so the brief's Phase 1 criterion —",
  '"beats the reference project and Pandoc" — is not met on that metric.* Saying so is more',
  "useful than adjusting the metric until it is.",
  "",
  "The mechanism is worth understanding before treating the gap as a defect. Ground truth is",
  "Markdown-shaped, and Pandoc's route passes through Markdown, so its output matches the",
  "target's shape by construction. MarkForge reads DOCX into the IR directly, and the IR keeps",
  "structure Markdown cannot express: a list item wrapping a paragraph, a cell holding block",
  "content, evidence in the sidecar. Tree-edit distance counts those nodes as differences from",
  "a flatter reference.",
  "",
  "So part of the gap is real and part is an artefact of measuring a richer representation",
  "against a flatter one. **Which part is which is not yet separated**, and until it is, this",
  "table should not be quoted as either a win or a loss.",
  "",
  "## What would make this fair",
  "",
  "1. **Pandoc-authored DOCX files as input**, so the writer is not ours.",
  "2. **Ground truth that is not Markdown-shaped** — a hand-authored IR per fixture, which is",
  "   what the construct inventories in `fixtures/expected/` are for.",
  "3. **A corpus of real documents.** Seven authored fixtures is not a sample. Categories §2.3",
  "   and §2.15 of `docs/CORPUS.md` exist for this and are not built yet.",
  "",
  "Until those exist, this measures one narrow thing honestly rather than a broad thing",
  "loosely.",
  "",
];

writeFileSync(join(REPO, "docs/SCOREBOARD.md"), lines.join("\n"), "utf8");
console.log(
  `\n${rows.length} fixture(s): ${mineWins} metric-wins to MarkForge, ${theirsWins} to Pandoc, ${ties} tied.`,
);
console.log("docs/SCOREBOARD.md written.");

// --check guards the metrics that currently tie, so a change turning a tie into a loss
// fails the build. It deliberately does *not* require beating Pandoc overall: we do not
// beat it on structural today, and a gate asserting something untrue would either fail
// forever or invite tuning the metric until it passed. The honest gate is "do not get
// worse at what we are currently equal on".
if (CHECK) {
  const lost = [];
  for (const row of rows) {
    for (const [label, getMine, getTheirs] of METRICS) {
      if (label === "Structural") continue; // known gap, explained above
      if (getTheirs(row) - getMine(row) > TIE_BAND) lost.push(`${row.fixture}/${label}`);
    }
  }
  if (lost.length > 0) {
    console.log(`\nRegression against Pandoc on previously-tied metrics: ${lost.join(", ")}.`);
    process.exit(4);
  }
  console.log("No regression against Pandoc on text, table, or span fidelity.");
}
process.exit(0);
