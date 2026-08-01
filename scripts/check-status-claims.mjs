#!/usr/bin/env node
/**
 * The closing deliverable: `STATUS.md` carries no unmarked unchecked claim.
 *
 * Every state cell in every table is either **produced by a check that can fail**, or
 * **explicitly marked unverified**. A claim with neither property is a defect regardless of
 * whether it happens to be true — which is the whole lesson of this repository's defect
 * history, stated as a gate. ADR-0015 was `Accepted` and wrong; `mcp-manifest`'s `honestyNote` was wrong about
 * its own profile; `CORPUS` §2.14 asserted an identity nothing could test. In every case
 * the sentence read as verified because nothing existed that could have contradicted it.
 *
 * ## The vocabulary
 *
 * A state cell must start with one of:
 *
 *   `done`          — and the row must name the check, in the same cell or its neighbour.
 *   `partial`       — same requirement. Partial is a measurement, not a hedge.
 *   `not done`      — nothing to verify; absence is self-evident and cheap to confirm.
 *   `not verified`  — the explicit escape. Must state why it is not verified.
 *   `descoped`      / `struck` / `not deliverables` — a decision, with its record cited.
 *
 * "Named check" means a `scripts/…`, a `packages/…/test/…`, a `docs/…` generated report, or
 * a CI job name. The point is that a reader can go and run the thing.
 *
 * ## What this gate does, and what it deliberately still does not
 *
 * The first version verified only that a cell **said** how it was verified — that the row
 * contained something path-shaped. It did not check that the thing existed. Measured: a row
 * reading `| A thing that does not exist | done | scripts/check-total-fiction.mjs |` passed,
 * which is the same defect as ADR-0012 naming a check that had nothing to do with it, and the
 * same shape as `check-degradation.mjs` accepting an annotation as evidence for itself.
 *
 * Three things are now resolved against the repository rather than against the sentence:
 *
 *   1. **Every named artifact exists.** A script, a test file, or a generated report.
 *   2. **Every named script runs.** It must be invoked by `pnpm verify` or by a CI job,
 *      because a script nobody executes verifies nothing. Same rule as
 *      `check-adr-enforcement.mjs`, and the reason both need it is the same.
 *   3. **Every number in a graded row is traceable.** A cell claiming `recall 94.7%` must
 *      have that figure present in a committed machine-readable measurement, so a number
 *      cannot be edited in prose while the measurement says otherwise. The corpus of
 *      permitted figures is `fixtures/expected/*.json` plus the generated reports — files a
 *      check writes, not files a person writes.
 *
 * What it still does not do is decide whether the named check *tests* the claim. There is no
 * mechanical form for that. Requirements 1–3 are the strongest available approximations: they
 * make a fictional check, a dead check, and a hand-edited number all fail, which are the
 * three ways this document has actually gone wrong.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const LIST = process.argv.includes("--list");

const failures = [];
const rows = [];
const ok = (m) => !JSON_OUT && !LIST && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && !LIST && console.log(`  FAIL  ${m}`);
};

/** A cell opens with one of these, ignoring emphasis and strikethrough markers. */
const VERDICTS = [
  "done",
  "partial",
  "not done",
  "not verified",
  "not built",
  "descoped",
  "struck",
  "not deliverables",
  "verified on authored equivalents",
  "n/a",
  "yes",
  "no",
  // The closing phase's three terminal states for a gap. Each carries its own requirement
  // below, because the whole point of naming them is that they are not synonyms for "later".
  "deferred",
  "blocked",
];

/**
 * A deferred capability must point at `docs/ROADMAP.md`.
 *
 * "Deferred" under the closing rule means removed from every promise in the repository and
 * moved somewhere it is still visible. A row that says `deferred` and cites nothing has done
 * the first half, which is the half that loses information.
 */
const DEFERRED_HOME = /ROADMAP\.md/;

/** A blocked capability must name a blocker and an owner. Blocked is only legitimate when the blocker is external. */
const BLOCKED_SHAPE = /blocke[dr][^|]*\b(owner|decision|awaiting|needs|upstream|vendor)\b/i;

/** Evidence a reader can act on: a script, a test, a generated report, or a CI job. */
const EVIDENCE =
  /(scripts\/[\w.-]+\.(mjs|ps1)|packages\/[\w-]+\/test\/[\w.-]+\.ts|docs\/[A-Z_]+\.md|CI job|ci\.yml|`pnpm [\w:]+`|ADR-\d{4}|OPEN_QUESTIONS §\d|§\d)/;

/** Why a claim is not verified — required whenever the verdict is `not verified`. */
const UNVERIFIED_REASON = /—|because|no such|needs|blocked|manual/i;

const text = readFileSync(join(REPO, "docs/STATUS.md"), "utf8").split(/\r?\n/);

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const verifyScript = pkg.scripts.verify;
const workflow = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

/** Every artifact path a row names, extracted so each can be resolved. */
const ARTIFACT = /(scripts\/[\w.-]+\.(?:mjs|ps1)|packages\/[\w-]+\/test\/[\w.-]+\.ts|docs\/[A-Z_-]+\.md)/g;

/** Does a `pnpm <name>` or a script path actually run? */
function isInvoked(scriptPath) {
  const name = Object.entries(pkg.scripts).find(([, cmd]) => cmd.includes(scriptPath))?.[0];
  return (name !== undefined && verifyScript.includes(name)) || workflow.includes(scriptPath);
}

/**
 * Every figure a check has committed, as strings.
 *
 * Only files a check writes. `fixtures/expected/*.json` are the extraction and fidelity
 * baselines, rewritten by `--update`; the generated reports are regenerated by their own
 * gates and drift-checked. A number that appears in none of them is a number somebody typed.
 */
const measuredFigures = (() => {
  const out = new Set();
  const add = (raw) => {
    for (const m of raw.matchAll(/\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      out.add(m[0]);
      // A ratio stored as 0.9474 backs a cell reading 94.7% or 94.74%.
      if (n > 0 && n < 1) {
        out.add((n * 100).toFixed(1));
        out.add((n * 100).toFixed(2));
        out.add(String(Math.round(n * 100)));
      }
    }
  };
  const expectedDir = join(REPO, "fixtures/expected");
  if (existsSync(expectedDir)) {
    for (const f of readdirSync(expectedDir).filter((x) => x.endsWith(".json"))) {
      add(readFileSync(join(expectedDir, f), "utf8"));
    }
  }
  for (const doc of ["docs/AGENTIFY.md", "docs/FIDELITY.md", "docs/SCOREBOARD.md", "docs/TARGETS.md"]) {
    if (existsSync(join(REPO, doc))) add(readFileSync(join(REPO, doc), "utf8"));
  }
  return out;
})();

!JSON_OUT && !LIST && console.log("\n1. Every STATUS.md state cell is checked or marked unverified");

let inTable = false;
let headerCells = [];
text.forEach((line, i) => {
  const isRow = /^\s*\|.*\|\s*$/.test(line);
  if (!isRow) {
    inTable = false;
    headerCells = [];
    return;
  }
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (/^[\s|:-]+$/.test(line)) return; // separator
  if (!inTable) {
    inTable = true;
    headerCells = cells.map((c) => c.toLowerCase());
    return;
  }

  // Only tables with a state-shaped column are graded. A table of measurements
  // ("Subset | Deterministic | Cached LLM") is data, not a claim about delivery.
  const stateIndex = headerCells.findIndex((h) => /^(state|reported)$/.test(h));
  if (stateIndex < 0) {
    /*
     * A `Where` column is the target form already: every row names the check that
     * produced it, which is the property this gate exists to enforce. Those tables are
     * graded on evidence alone, without the verdict vocabulary — the acceptance-criterion
     * tables read "100.0% over 37 sentences" in the measured column, which is a number
     * rather than a verdict and is better than one.
     *
     * The first version of this gate matched `half` and `measured` as state columns and
     * failed exactly those three rows, which are the best-evidenced in the file.
     */
    const whereIndex = headerCells.findIndex((h) => /^(where|verified by)$/.test(h));
    if (whereIndex < 0) return;
    rows.push({ line: i + 1, verdict: "measured", cell: (cells[whereIndex] ?? "").slice(0, 60) });
    if (!EVIDENCE.test(line)) {
      fail(`STATUS.md:${i + 1} — a measured row whose "where" names no check`);
      return;
    }
    resolveRow(i, cells[0] ?? "", line);
    return;
  }

  const cell = cells[stateIndex] ?? "";
  const bare = cell.replace(/[*~`]/g, "").trim().toLowerCase();
  if (bare === "") return;

  const verdict = VERDICTS.find((v) => bare.startsWith(v));
  const rowText = line;
  rows.push({ line: i + 1, verdict: verdict ?? null, cell: cell.slice(0, 60) });

  if (!verdict) {
    fail(`STATUS.md:${i + 1} — state "${cell.slice(0, 40)}" opens with no recognised verdict`);
    return;
  }

  // `not done` needs nothing: absence is self-evident. Decisions cite their record.
  if (verdict === "not done" || verdict === "not built" || verdict === "n/a") return;

  if (verdict === "not verified") {
    if (!UNVERIFIED_REASON.test(cell)) {
      fail(`STATUS.md:${i + 1} — "not verified" with no stated reason`);
    }
    return;
  }

  if (verdict === "deferred") {
    if (!DEFERRED_HOME.test(rowText)) {
      fail(
        `STATUS.md:${i + 1} — "${cells[0]?.slice(0, 40)}" is deferred and does not point at ` +
          `docs/ROADMAP.md. A capability removed from the promises and recorded nowhere is lost, ` +
          `not deferred.`,
      );
    }
    resolveRow(i, cells[0] ?? "", rowText);
    return;
  }

  if (verdict === "blocked") {
    if (!BLOCKED_SHAPE.test(rowText)) {
      fail(
        `STATUS.md:${i + 1} — "${cells[0]?.slice(0, 40)}" is blocked without naming a blocker and ` +
          `a decision owner. Blocked is only legitimate when the blocker is external and named.`,
      );
    }
    return;
  }

  // Everything else is a positive claim and must name its evidence, in the cell or
  // anywhere else in the row.
  if (!EVIDENCE.test(rowText)) {
    fail(
      `STATUS.md:${i + 1} — "${cells[0]?.slice(0, 44)}" claims "${bare.slice(0, 18)}" and names no check. ` +
        `Name one, or mark it "not verified — <why>".`,
    );
    return;
  }

  resolveRow(i, cells[0] ?? "", rowText);
});

/**
 * The three resolutions: the artifact exists, it runs, and the row's numbers were measured.
 *
 * Split out because the `measured` rows above need exactly the same treatment — they were the
 * best-evidenced rows in the file and the weakest-checked, since naming a `Where` column
 * exempted them from everything but the regex.
 */
function resolveRow(lineIndex, label, rowText) {
  for (const path of new Set(rowText.match(ARTIFACT) ?? [])) {
    if (!existsSync(join(REPO, path))) {
      fail(
        `STATUS.md:${lineIndex + 1} — "${label.slice(0, 40)}" names ${path}, which does not exist. ` +
          `A named check that is not there reads as verified and is not.`,
      );
      continue;
    }
    if (path.startsWith("scripts/") && !isInvoked(path)) {
      fail(
        `STATUS.md:${lineIndex + 1} — "${label.slice(0, 40)}" names ${path}, which exists but is ` +
          `invoked by neither \`pnpm verify\` nor CI, so it verifies nothing`,
      );
    }
  }

  /*
   * Numbers in the row must be traceable to a committed measurement.
   *
   * Scoped to figures that read as measurements — a percentage, or an `N of M` — because a
   * cell also carries counts of things this gate has no measurement for ("7 of the 8
   * categories", a token budget, a version). Percentages and ratios are where a hand-edit
   * would do real damage, and they are what `docs/AGENTIFY.md` used to carry as literals.
   */
  const figures = [
    ...[...rowText.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => m[1]),
    ...[...rowText.matchAll(/\b(\d+)\s+of\s+(\d+)\b/g)].flatMap((m) => [m[1], m[2]]),
  ];
  const untraceable = figures.filter((f) => !measuredFigures.has(f) && !measuredFigures.has(String(Number(f))));
  if (untraceable.length > 0) {
    fail(
      `STATUS.md:${lineIndex + 1} — "${label.slice(0, 40)}" reports ${untraceable.join(", ")} ` +
        `which appear in no committed measurement (fixtures/expected/*.json or a generated ` +
        `report). Either the figure is stale or it was typed rather than measured.`,
    );
  }
}

if (failures.length === 0) {
  const byVerdict = rows.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {});
  ok(
    `${rows.length} state cell(s): ` +
      Object.entries(byVerdict).sort().map(([v, n]) => `${n} ${v}`).join(", "),
  );
}

// ---------------------------------------------------------------- 2. negative control
!JSON_OUT && !LIST && console.log("\n2. Negative control — the gate must be able to fail");
{
  const bareClaim = "| Some deliverable | done |";
  const cells = bareClaim.split("|").slice(1, -1).map((c) => c.trim());
  const caught = VERDICTS.some((v) => cells[1].toLowerCase().startsWith(v)) && !EVIDENCE.test(bareClaim);
  if (caught) ok('a "done" with no named check is detected');
  else fail('negative control: a bare "done" was not detected');

  const withCheck = "| Some deliverable | done — scripts/check-docs.mjs |";
  if (EVIDENCE.test(withCheck)) ok("a claim naming a script is accepted");
  else fail("negative control: a claim naming a script was rejected");

  const unmarked = "| Some deliverable | probably fine |";
  const c2 = unmarked.split("|").slice(1, -1).map((x) => x.trim());
  if (!VERDICTS.some((v) => c2[1].toLowerCase().startsWith(v))) ok("an unrecognised verdict is detected");
  else fail("negative control: an unrecognised verdict was not detected");

  const noReason = "| Thing | not verified |";
  if (!UNVERIFIED_REASON.test(noReason)) ok('an unreasoned "not verified" is detected');
  else fail('negative control: an unreasoned "not verified" was not detected');

  /*
   * The three resolutions, each controlled. Without these the gate would pass while any of
   * them silently stopped resolving — which is exactly how it passed for a whole phase while
   * checking only that a row contained something path-shaped.
   */
  if (!existsSync(join(REPO, "scripts/check-total-fiction.mjs"))) {
    ok("a named check that does not exist is detected");
  } else {
    fail("negative control: scripts/check-total-fiction.mjs exists, so this control is void");
  }

  // A real script that `pnpm verify` and CI both ignore. `inspect-docx.ps1` is a hand tool,
  // which is why it is the honest example rather than a fabricated path.
  if (existsSync(join(REPO, "scripts/inspect-docx.ps1")) && !isInvoked("scripts/inspect-docx.ps1")) {
    ok("a named check that exists but never runs is detected");
  } else {
    fail("negative control: no uninvoked script available, so the invocation check is untested");
  }

  // A figure no measurement contains. 77.3 is chosen because it appears in none of them.
  if (!measuredFigures.has("77.3")) ok("a percentage present in no committed measurement is detected");
  else fail("negative control: 77.3 is in the measured corpus, so this control is void");

  // And the positive half: a figure that *is* measured must be accepted, or every row fails.
  if (measuredFigures.size > 50) ok(`${measuredFigures.size} measured figures available to trace against`);
  else fail(`only ${measuredFigures.size} measured figures parsed — the traceability check is vacuous`);

  const deferredNoHome = "| Thing | deferred | `scripts/check-docs.mjs` |";
  if (!DEFERRED_HOME.test(deferredNoHome)) ok("a deferred row pointing at no roadmap is detected");
  else fail("negative control: a homeless deferred row was not detected");
}

if (LIST) {
  for (const r of rows) console.log(`STATUS.md:${String(r.line).padEnd(5)} ${(r.verdict ?? "UNRECOGNISED").padEnd(18)} ${r.cell}`);
} else if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, rows }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nSTATUS.md carries no unmarked unchecked claim.`
      : `\n${failures.length} STATUS.md claim(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
