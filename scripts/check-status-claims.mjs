#!/usr/bin/env node
/**
 * The closing deliverable: `STATUS.md` carries no unmarked unchecked claim.
 *
 * Every state cell in every table is either **produced by a check that can fail**, or
 * **explicitly marked unverified**. A claim with neither property is a defect regardless of
 * whether it happens to be true — which is the whole lesson of this phase, stated as a
 * gate. ADR-0015 was `Accepted` and wrong; `mcp-manifest`'s `honestyNote` was wrong about
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
 * ## What this gate does not do
 *
 * It does not verify the claims. It verifies that each claim **says how it is verified**,
 * which is a strictly weaker property and the only one a text file can carry. The claims
 * themselves are checked by the gates they name — that is the point of naming them.
 */
import { readFileSync } from "node:fs";
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
];

/** Evidence a reader can act on: a script, a test, a generated report, or a CI job. */
const EVIDENCE =
  /(scripts\/[\w.-]+\.(mjs|ps1)|packages\/[\w-]+\/test\/[\w.-]+\.ts|docs\/[A-Z_]+\.md|CI job|ci\.yml|`pnpm [\w:]+`|ADR-\d{4}|OPEN_QUESTIONS §\d|§\d)/;

/** Why a claim is not verified — required whenever the verdict is `not verified`. */
const UNVERIFIED_REASON = /—|because|no such|needs|blocked|manual/i;

const text = readFileSync(join(REPO, "docs/STATUS.md"), "utf8").split(/\r?\n/);

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
     * graded on evidence alone, without the verdict vocabulary — the done-criterion
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
    }
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

  // Everything else is a positive claim and must name its evidence, in the cell or
  // anywhere else in the row.
  if (!EVIDENCE.test(rowText)) {
    fail(
      `STATUS.md:${i + 1} — "${cells[0]?.slice(0, 44)}" claims "${bare.slice(0, 18)}" and names no check. ` +
        `Name one, or mark it "not verified — <why>".`,
    );
  }
});

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
