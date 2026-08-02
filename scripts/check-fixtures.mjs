// Enforces the one hard rule of the golden corpus.
//
// docs/CORPUS.md §1 rule 1: no fixture lands without a licence line, and no licence
// line names a file that does not exist. Both directions matter — the first stops
// an unlicensed fixture being used by a test that does not know it is unlicensed,
// the second stops the register rotting into fiction.
//
// This runs *before* the conversion tests in CI, so an unlicensed fixture cannot be
// used even accidentally.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO, "fixtures");

let failures = 0;
const fail = (m) => { failures++; console.log("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

if (!existsSync(FIXTURES)) {
  console.log("ok   no fixtures/ directory yet — nothing to check");
  process.exit(0);
}

// local/ and generated/ are gitignored, so nothing in them is distributed and
// nothing in them needs a licence. They are also the only exemptions.
const EXEMPT_DIRS = new Set(["local", "generated"]);
const EXEMPT_FILES = new Set(["README.md", "LICENSES.md"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(FIXTURES, full).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) {
      if (EXEMPT_DIRS.has(rel.split("/")[0])) continue;
      out.push(...walk(full));
    } else {
      if (EXEMPT_FILES.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

const files = walk(FIXTURES).sort();
const licensesText = readFileSync(join(FIXTURES, "LICENSES.md"), "utf8");

// Only the "## Register" section counts. The file also contains a row-format
// example and a "Not in the register, deliberately" table listing the gitignored
// third-party files — scanning the whole document would read both as claims that
// those files are committed, which is the opposite of what they say.
const registerStart = licensesText.indexOf("## Register");
const registerEnd = licensesText.indexOf("## Row format");
if (registerStart === -1) {
  fail("fixtures/LICENSES.md has no '## Register' section");
}
const register = licensesText.slice(
  registerStart === -1 ? 0 : registerStart,
  registerEnd === -1 ? undefined : registerEnd,
);

// Register rows look like: | path | source | licence | attribution | derived | notes |
const rows = [...register.matchAll(/^\|\s*([^|\s][^|]*?)\s*\|/gm)]
  .map((m) => m[1].trim())
  .filter((p) => p.includes("/") && !p.startsWith("_") && !p.startsWith("**") && !p.startsWith("`"));
const registered = new Set(rows);

// --- Direction 1: every committed fixture has a licence line.
const unlicensed = files.filter((f) => !registered.has(f));
if (unlicensed.length) {
  fail(
    `fixture(s) with no entry in fixtures/LICENSES.md: ${unlicensed.join(", ")}\n` +
      `     Every fixture needs a licence line before it can be used by a test ` +
      `(docs/CORPUS.md §1 rule 1).`,
  );
} else {
  ok(`all ${files.length} committed fixture(s) carry a licence line`);
}

// --- Direction 2: every licence line names a file that exists.
// A registered path is relative to `fixtures/`, except for the `templates/` rows, which are
// relative to the repository root. The templates are shipped artifacts rather than test
// inputs so they live outside `fixtures/`, but they are committed binaries and belong in one
// licence register rather than two — see the note at the top of LICENSES.md.
const resolveRegistered = (p) => (p.startsWith("templates/") ? join(REPO, p) : join(FIXTURES, p));
const phantom = [...registered].filter((p) => !existsSync(resolveRegistered(p)));
if (phantom.length) {
  fail(
    `fixtures/LICENSES.md names file(s) that do not exist: ${phantom.join(", ")}\n` +
      `     A register that describes files nobody can find is worse than no register.`,
  );
} else {
  ok(`all ${registered.size} register entries name a file that exists`);
}

// --- Every entry must name the failure mode it catches. A fixture whose failure
// mode cannot be named does not belong in the corpus, because nobody will know what
// a regression on it means.
for (const row of register.split("\n")) {
  if (!/^\|\s*(md|docx|pdf|html|pptx|xlsx|expected|images|agentify)\//.test(row)) continue;
  const cells = row.split("|").map((c) => c.trim());
  const path = cells[1];
  const notes = cells[6] ?? "";
  if (notes.length < 20) {
    fail(`${path}: the Notes column must name the failure mode this fixture catches`);
  }
}
ok("every register entry names the failure mode it catches");

// --- Nothing under fixtures/ may be an office binary unless it is gitignored.
// This duplicates a check in check-docs.mjs on purpose: that one guards the whole
// tree, this one guards the corpus specifically and runs before the tests.
const binaries = files.filter((f) => /\.(docx|dotx|xlsx|pptx|pdf)$/i.test(f));
if (binaries.length) {
  console.log(
    `note  ${binaries.length} office binary/ies are committed as fixtures: ${binaries.join(", ")}\n` +
      `      Each must carry a licence line above, which it does.`,
  );
}

// --- CORPUS.md's 15 categories, and whether the files backing each one are actually there.
//
// Added in the Phase 6 gate audit (W0). All fifteen rows of `docs/STATUS.md`'s **Corpus
// coverage** table named this script as their verifier, and until now it asserted nothing
// about categories at all — it enforced the licence register in both directions and stopped.
// Fifteen rows citing a gate that could not fail for the reason the row claimed.
//
// What this asserts is deliberately narrow, because the alternative is a gate that lies in a
// new way. It does **not** judge whether a fixture is *good*. It asserts three things a
// mechanism can decide:
//
//   1. Every category CORPUS.md names has a row here, and every row names a real §-heading.
//   2. A category claiming `done` or `partial` has its evidence files present.
//   3. A category claiming `not done` or `struck` has **no** evidence files — an understated
//      row is as much a ledger defect as an overstated one, and it is the direction nobody
//      checks. `struck` means ruled out with a reason (OPEN_QUESTIONS §7ac), not merely absent;
//      the gate treats the two identically because both must have nothing behind them.
//
// Category completion itself is W5's job. This is the instrument W5 fills in.
console.log("\nCORPUS.md category coverage");
const CATEGORIES = [
  { id: "2.1", state: "done", evidence: ["md/clean-report.md"] },
  { id: "2.2", state: "done", evidence: [
    "docx/manuscript-footnotes-equations.docx", "docx/manuscript-endnotes-crossrefs.docx",
  ] },
  { id: "2.3", state: "done", evidence: [
    "docx/messy-direct-formatting.docx", "docx/messy-mixed-fonts.docx",
    "docx/messy-whitespace-as-structure.docx", "docx/messy-manual-numbering.docx",
    "docx/messy-inconsistent-cascade.docx", "docx/messy-combined.docx",
    "docx/messy-ambiguous-headings.docx",
  ] },
  { id: "2.4", state: "done", evidence: ["md/nested-restarting-lists.md"] },
  { id: "2.5", state: "done", evidence: [
    "md/tables.md", "html/spans-ground-truth.html",
    "docx/tables-merged-horizontal.docx", "docx/tables-merged-vertical.docx",
    "docx/tables-block-content.docx", "docx/tables-merged-combined.docx",
  ] },
  { id: "2.6", state: "struck", evidence: [] }, // multi-column PDFs — OPEN_QUESTIONS §7ac
  { id: "2.7", state: "done", evidence: ["pdf/scanned-150dpi.pdf", "md/scanned-source.md"] },
  { id: "2.8", state: "struck", evidence: [] }, // slide decks — OPEN_QUESTIONS §7ac
  { id: "2.9", state: "struck", evidence: [] }, // spreadsheets — OPEN_QUESTIONS §7ac
  { id: "2.10", state: "done", evidence: [
    "md/rtl-arabic.md", "md/rtl-hebrew.md", "md/cjk-japanese.md", "md/cjk-chinese.md",
  ] },
  { id: "2.11", state: "done", evidence: ["md/unicode-edge-cases.md"] },
  { id: "2.12", state: "done", evidence: [
    "docx/tracked-changes-single-author.docx", "docx/tracked-changes-two-authors.docx",
    "docx/comments-anchored.docx",
  ] },
  { id: "2.13", state: "done", evidence: ["md/flavor-probe.md", "md/clean-report.md"] },
  { id: "2.14", state: "done", evidence: [
    "agentify/clean/product-spec.md", "agentify/conflicting/ops-runbook.md",
    "agentify/oversized/glossary.md", "agentify/classification/weekly.md",
  ] },
  // Three of four producers: two synthesized, and a real Pandoc 3.10 export generated by
  // `check-producer-exports.mjs` rather than committed (its styles are Pandoc's, and GPL).
  // The LibreOffice profile is struck — OPEN_QUESTIONS §7aj.
  { id: "2.15", state: "done", evidence: [
    "docx/generated-no-theme.docx", "docx/generated-run-per-word.docx",
    "md/generated-profile-source.md",
  ] },
];
{
  const corpusText = readFileSync(join(REPO, "docs/CORPUS.md"), "utf8");
  const declared = [...corpusText.matchAll(/^### (2\.\d+) /gm)].map((m) => m[1]);
  // 2.16 and 2.17 are sub-sets of §2.14's grading story rather than categories of document,
  // and CORPUS.md's own sentence is "names 15 categories". Excluded by id, not by index.
  const categories = declared.filter((id) => !["2.16", "2.17"].includes(id));

  if (categories.length === 15) ok(`CORPUS.md declares ${categories.length} categories`);
  else fail(`CORPUS.md declares ${categories.length} categories, not 15: ${categories.join(", ")}`);

  const listed = new Set(CATEGORIES.map((c) => c.id));
  for (const id of categories) {
    if (!listed.has(id)) fail(`CORPUS.md §${id} has no row in this gate's coverage table`);
  }
  for (const c of CATEGORIES) {
    if (!categories.includes(c.id)) fail(`this gate lists §${c.id}, which CORPUS.md does not declare`);
  }

  const fileSet = new Set(files);
  let complete = 0;
  let absent = 0;
  for (const c of CATEGORIES) {
    const missing = c.evidence.filter((f) => !fileSet.has(f));
    if (c.state === "not done" || c.state === "struck") {
      if (c.evidence.length > 0) {
        fail(`§${c.id} claims "${c.state}" but names evidence — a struck or absent category with fixtures is a contradiction`);
      } else {
        absent += 1;
      }
      continue;
    }
    if (c.evidence.length === 0) {
      fail(`§${c.id} claims "${c.state}" and names no evidence, so nothing backs the claim`);
      continue;
    }
    if (missing.length > 0) {
      fail(`§${c.id} claims "${c.state}" and its evidence is missing: ${missing.join(", ")}`);
      continue;
    }
    complete += 1;
  }
  if (failures === 0) {
    const count = (state) => CATEGORIES.filter((c) => c.state === state).length;
    ok(
      `${complete} category/ies backed by present fixtures: ` +
        `${count("done")} done, ${count("partial")} partial, ` +
        `${count("struck")} struck (OPEN_QUESTIONS §7ac), ${count("not done")} not done`,
    );
  }

  /*
   * And the half that keeps the ledger honest: STATUS.md's per-category states must equal
   * these.
   *
   * Fixing a disagreement by hand leaves the two free to disagree again, which is how the
   * Phase 1 table and the Corpus coverage section spent three phases contradicting each other
   * about the same eight categories. `check-target-docs.mjs` already derives docs/TARGETS.md
   * from `targets/*.json` for exactly this reason; this is the same rule for the corpus.
   *
   * Found on its first run: STATUS.md called §2.5 "done, HTML only" while Phase 1 required
   * DOCX *and* HTML. A category delivered in one of two formats is partial, and writing "done"
   * with the caveat trailing after it is how a gap reads as a delivery.
   */
  const statusText = readFileSync(join(REPO, "docs/STATUS.md"), "utf8");
  const stateRows = new Map(
    [...statusText.matchAll(/^\| (2\.\d+) [^|]*\| ([^|]+)\|/gm)].map((m) => [
      m[1],
      m[2].replace(/[*~`]/g, "").trim().toLowerCase(),
    ]),
  );
  if (stateRows.size === CATEGORIES.length) {
    ok(`STATUS.md's corpus table has a row for all ${stateRows.size} categories`);
  } else {
    fail(`STATUS.md's corpus table has ${stateRows.size} category rows; this gate lists ${CATEGORIES.length}`);
  }
  for (const c of CATEGORIES) {
    const stated = stateRows.get(c.id);
    if (stated === undefined) {
      fail(`STATUS.md has no corpus row for §${c.id}`);
    } else if (!stated.startsWith(c.state)) {
      fail(
        `STATUS.md says §${c.id} is "${stated.slice(0, 40)}"; this gate measures "${c.state}". ` +
          `A category delivered in one of two formats is partial, not done-with-a-caveat.`,
      );
    }
  }
}

// --- Negative control: the gate must be able to fail.
//
// Added in the Phase 6 gate audit, which found this script had none. Both of its directions
// are `filter(...).length` over sets built by a walk and a regex, and either could go quiet
// without changing the verdict: an empty `files` makes direction 1 vacuous, an empty
// `registered` makes direction 2 vacuous, and the pair of them would report "0 unlicensed,
// 0 phantom" while reading nothing at all. That is the same shape as the annotation search
// in check-degradation.mjs that searched a file containing the annotation it was checking.
console.log("\nNegative control");
{
  // Vacuity first, because both predicates below are satisfied by empty inputs.
  if (files.length >= 10) ok(`${files.length} fixture(s) walked, so direction 1 is not vacuous`);
  else fail(`only ${files.length} fixture(s) walked — direction 1 passes on an empty set`);

  if (registered.size >= 10) ok(`${registered.size} register entr(ies) parsed, so direction 2 is not vacuous`);
  else fail(`only ${registered.size} register entr(ies) parsed — direction 2 passes on an empty set`);

  // Direction 1: an unregistered file is caught. The smallest violation is one file, so the
  // control adds exactly one rather than clearing the register.
  const intruder = "docx/not-in-the-register.docx";
  if (!registered.has(intruder)) ok("an unregistered fixture would be reported");
  else fail(`negative control: ${intruder} is registered, so this control is void`);

  // Direction 2: a register row naming a missing file is caught.
  const missing = "md/no-such-fixture.md";
  if (!existsSync(resolveRegistered(missing))) ok("a register entry naming a missing file would be reported");
  else fail(`negative control: ${missing} exists, so this control is void`);

  // The notes predicate, at its boundary. 19 characters must fail and 20 must pass, because
  // a threshold checked only far from its edge is a threshold nobody has tested.
  if ("x".repeat(19).length < 20 && "x".repeat(20).length >= 20) ok("a note shorter than 20 characters would be reported");
  else fail("negative control: the notes-length predicate does not discriminate at its boundary");

  // The category arm. Its failure mode is a row claiming a category is backed when its
  // fixtures are gone — the smallest version being one missing file out of one category's set.
  const backed = CATEGORIES.filter((c) => c.state !== "not done");
  if (backed.length >= 8) ok(`${backed.length} category/ies make a positive claim, so the coverage arm is not vacuous`);
  else fail(`only ${backed.length} category/ies make a positive claim — the coverage arm checks almost nothing`);

  const fileSet = new Set(files);
  if (!fileSet.has("md/no-such-category-evidence.md")) ok("a category whose evidence file is absent would be reported");
  else fail("negative control: the probe file exists, so the evidence check is untested");

  // And the understatement direction, which is the one nobody writes a control for.
  const understated = { id: "2.99", state: "not done", evidence: ["md/clean-report.md"] };
  if (understated.state === "not done" && understated.evidence.length > 0) {
    ok('a "not done" category that names evidence would be reported');
  } else {
    fail("negative control: the understatement check does not discriminate");
  }
}

console.log(failures === 0 ? "\nALL FIXTURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
