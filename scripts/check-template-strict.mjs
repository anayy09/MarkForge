#!/usr/bin/env node
/**
 * What the shipped templates do under `--strict`, asserted where `pnpm verify` can run it.
 *
 * This was six lines of inline shell in `ci.yml`. It caught a real defect — and it caught it
 * *after* a merge, because `scripts/check-gate-parity.mjs` compares the set of gate **scripts**
 * on each side and an inline `run:` step is not a script. So the assertion existed on exactly
 * one of the two sides, which is the divergence that gate was written to prevent, wearing a
 * shape it could not see. Moving it into a file is the fix; the gate now covers it.
 *
 * ## What it asserts
 *
 * All three templates exit **2**, SPEC §8's code for "completed with lossy diagnostics", each
 * for a construct named in `docs/LIMITS.md` §2:
 *
 * - `academic-manuscript.docx` — five OMML equations; Markdown math is TeX.
 * - `clean-report.docx`, `technical-documentation.docx` — a caption and a description list;
 *   Markdown has syntax for neither.
 *
 * The middle case is worth its own sentence, because the expected value **changed** on
 * 2026-08-02 and changing an expected value after seeing a result is how an assertion becomes
 * decoration. `clean-report.docx` used to exit 0. It did not become lossier: the DOCX adapter
 * began recovering the caption and description list it has always contained, so a loss that
 * was silent became reportable. The template is unchanged in what it holds; the instrument
 * improved.
 *
 * Which is exactly why the control below is not optional. Without a document that must exit
 * **0**, these three assertions would pass on a build where every conversion always exited 2.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "packages/cli/dist/index.js");
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const dir = mkdtempSync(join(tmpdir(), "markforge-tpl-"));

/** Converts under `--strict` and returns the exit code. */
function strictExit(input, out, extra = []) {
  const r = spawnSync(
    process.execPath,
    [CLI, "convert", join(REPO, input), "-o", join(dir, out), "--strict", "--quiet", ...extra],
    { cwd: REPO, encoding: "utf8" },
  );
  return r.status ?? -1;
}

const CASES = [
  ["templates/academic-manuscript.docx", 2, "five OMML equations Markdown cannot express"],
  ["templates/clean-report.docx", 2, "a caption and a description list Markdown cannot express"],
  ["templates/technical-documentation.docx", 2, "a caption and a description list"],
  // The control, and the reason the three above mean anything.
  ["fixtures/md/clean-report.md", 0, "nothing Markdown cannot express"],
];

try {
  for (const [input, expected, why] of CASES) {
    const code = strictExit(input, `${input.replace(/[\\/]/g, "_")}.md`);
    if (code === expected) ok(`${input} exits ${code} under --strict — ${why}`);
    else fail(`${input} exited ${code} under --strict, expected ${expected} — ${why}`);
  }

  /*
   * Negative control. `--strict` must be what decides, not the document: the same lossy
   * conversion without the flag has to exit 0, or "exits 2" says nothing about `--strict`.
   */
  const withoutStrict = spawnSync(
    process.execPath,
    [CLI, "convert", join(REPO, "templates/academic-manuscript.docx"), "-o", join(dir, "nostrict.md"), "--quiet"],
    { cwd: REPO, encoding: "utf8" },
  );
  if ((withoutStrict.status ?? -1) === 0) ok("the same conversion without --strict exits 0, so the flag is what decides");
  else fail(`without --strict the manuscript exited ${withoutStrict.status}, so exit 2 above is not about the flag`);

  if (CASES.some(([, expected]) => expected === 0)) ok("at least one case must exit 0, so a constant exit code fails");
  else fail("every case expects a non-zero exit, so this gate would pass on a build that always failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
else console.log(failures.length === 0 ? "\nThe shipped templates report their losses, and a clean document reports none." : `\n${failures.length} failure(s).`);
process.exit(failures.length === 0 ? 0 : 1);
