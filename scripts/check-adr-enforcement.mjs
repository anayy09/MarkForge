#!/usr/bin/env node
/**
 * Every ADR names the check that enforces it, and that check exists.
 *
 * ADR-0015 sat at `Accepted` while being wrong for all ten packages it named. That is not a
 * failure of attention: **acceptance never had a check attached**, so nothing in the
 * repository could have contradicted it, and it stayed true-looking for four phases. An ADR
 * with no enforcing check is a comment.
 *
 * So each ADR carries an `Enforced by:` line naming one of:
 *
 *   - a script in `scripts/`, which must exist and be wired into `pnpm verify`;
 *   - a test file, which must exist;
 *   - a CI step name, which must appear in `.github/workflows/ci.yml`;
 *   - `not enforceable — <reason>`, for a decision with no runtime consequence.
 *
 * The last one is the honest escape and it is deliberately awkward to write: a licence
 * choice or a rejected alternative genuinely has nothing to check, but claiming that
 * requires saying so in the file where someone will read it. What it must never be is
 * silence, because silence is indistinguishable from "enforced" until someone measures.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const rows = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const ENFORCED_BY = /^-?\s*\**Enforced by\**:\s*(.+?)\s*$/im;

const verify = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.verify;
const workflow = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

const adrs = readdirSync(join(REPO, "docs/adr"))
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort();

!JSON_OUT && console.log("\n1. Every ADR names the check that enforces it");

for (const file of adrs) {
  const text = readFileSync(join(REPO, "docs/adr", file), "utf8");
  const match = ENFORCED_BY.exec(text);
  if (!match) {
    fail(`${file} has no \`Enforced by:\` line — an ADR with no enforcing check is a comment`);
    rows.push({ adr: file, enforcedBy: null });
    continue;
  }

  const claim = match[1].replace(/`/g, "").trim();
  rows.push({ adr: file, enforcedBy: claim });

  if (/^not enforceable\b/i.test(claim)) {
    // Must give a reason. "not enforceable" alone is silence with extra steps.
    if (claim.replace(/^not enforceable\s*[—-]?\s*/i, "").length < 12) {
      fail(`${file} says "not enforceable" without a reason`);
    } else {
      ok(`${file} — not enforceable, with a stated reason`);
    }
    continue;
  }

  // Every artifact it names has to exist. A named check that does not exist is worse
  // than none, because it reads as verified.
  const targets = claim.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean);
  let allFound = true;
  for (const target of targets) {
    const path = /^(scripts|packages)\//.test(target) ? target.split(/\s/)[0] : null;
    if (path) {
      if (!existsSync(join(REPO, path))) {
        fail(`${file} names ${path}, which does not exist`);
        allFound = false;
      } else if (path.startsWith("scripts/")) {
        /*
         * A script that exists but never runs enforces nothing — so it must be invoked
         * from `pnpm verify` **or** from a CI job.
         *
         * Both count, and the distinction is not pedantic: this gate first required
         * `verify` alone and failed ADR-0010, whose enforcing script `run-fidelity.mjs` is
         * deliberately a CI-only job because it measures the whole corpus and is far too
         * slow for the local loop. That is real enforcement — it runs on every pull
         * request — and a gate that called it unenforced would have pushed a slow job into
         * `verify` to satisfy the gate rather than the goal.
         */
        const scripts = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts;
        const pnpmName = Object.entries(scripts).find(([, cmd]) => cmd.includes(path))?.[0];
        const inVerify = pnpmName !== undefined && verify.includes(pnpmName);
        const inCi = workflow.includes(path);
        if (!inVerify && !inCi) {
          fail(`${file} names ${path}, which exists but is invoked by neither \`pnpm verify\` nor CI`);
          allFound = false;
        }
      }
    } else if (!workflow.includes(target.slice(0, 40))) {
      fail(`${file} names CI step "${target}", which is not in ci.yml`);
      allFound = false;
    }
  }
  if (allFound) ok(`${file} — ${claim.slice(0, 62)}`);
}

// ---------------------------------------------------------------- 2. negative control
!JSON_OUT && console.log("\n2. Negative control — the gate must be able to fail");
{
  const missing = "## Context\n\nNo enforcement line here at all.\n";
  if (!ENFORCED_BY.exec(missing)) ok("an ADR with no Enforced by line is detected");
  else fail("negative control: a missing Enforced by line was not detected");

  const bare = "- Enforced by: not enforceable\n";
  const m = ENFORCED_BY.exec(bare);
  const reason = m ? m[1].replace(/^not enforceable\s*[—-]?\s*/i, "") : "x".repeat(50);
  if (reason.length < 12) ok('an unreasoned "not enforceable" is detected');
  else fail('negative control: an unreasoned "not enforceable" was not detected');

  const ghost = "- Enforced by: scripts/check-nothing-at-all.mjs\n";
  const g = ENFORCED_BY.exec(ghost);
  if (g && !existsSync(join(REPO, g[1].trim()))) ok("a named check that does not exist is detected");
  else fail("negative control: a nonexistent named check was not detected");
}

const enforced = rows.filter((r) => r.enforcedBy && !/^not enforceable/i.test(r.enforcedBy)).length;
if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, failures, rows }, null, 2));
else
  console.log(
    failures.length === 0
      ? `\n${adrs.length} ADRs, ${enforced} with a live enforcing check, ${adrs.length - enforced} explicitly not enforceable.`
      : `\n${failures.length} ADR enforcement check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
process.exit(failures.length === 0 ? 0 : 1);
