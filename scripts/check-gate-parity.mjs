#!/usr/bin/env node
/**
 * `pnpm verify` and `.github/workflows/ci.yml` run the same set of gates.
 *
 * This is the check that would have caught the `check-agentify.mjs` / `ci.yml` divergence.
 * That defect is worth restating precisely, because the shape recurs and the instance does
 * not: one stale assertion existed in two places, fixing the script did not fix the
 * workflow, and `pnpm verify` does not run the workflow — so the local suite was green and
 * CI was red *for the same commit*. Neither half was lying. They were checking different
 * things while presenting as one.
 *
 * The property is set equality over gate scripts, not over steps. A workflow step that
 * invokes the CLI (`convert`, `fmt`, `agentify`) is a gate too, but it has no name a
 * `package.json` script could match, and forcing those into `verify` would mean maintaining
 * a second copy of the workflow in shell — which is the failure this gate exists to prevent,
 * committed deliberately. So: every `scripts/*.mjs` gate runs in both places, or it appears
 * in ONE_SIDED below with a reason that says why it cannot.
 *
 * ## ONE_SIDED is checked, not trusted
 *
 * An exemption table is the obvious way to make a gate stop catching things — you add an
 * entry and the failure goes away forever. Three properties keep it honest:
 *
 *   1. Every entry must name a script that **exists**. A stale path is a defect.
 *   2. Every entry must be **currently one-sided**. An entry for a script that has since
 *      been wired into both sides fails as stale, so the table shrinks on its own rather
 *      than accumulating.
 *   3. Every entry must state which side and why, and the reason must be about
 *      *capability* — network, a downloaded asset, a binary — never about convenience.
 *
 * ## Vacuity
 *
 * Two empty sets are equal. If either parser silently stopped matching, this gate would
 * pass while checking nothing, which is precisely how the traceability gate's negative
 * control and `check-degradation.mjs`'s annotation search both went quiet. Section 1
 * therefore asserts a floor on each set and that a known gate is in both, before section 2
 * compares them at all.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { verifyGates, ciGates } from "./lib/gates.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

/**
 * Gates that legitimately run on one side only.
 *
 * `side` is where it DOES run. `why` must name a capability the other side lacks.
 */
const ONE_SIDED = [
  {
    script: "scripts/fetch-ocr-assets.mjs",
    side: "ci",
    why: "downloads tesseract language data and the found scan over the network; brief §3.6 makes no network call a default, so it cannot be in the offline local chain",
  },
  {
    script: "scripts/run-scoreboard.mjs",
    side: "ci",
    why: "needs a pinned pandoc 3.10 .deb installed by the workflow; Ubuntu's pandoc produces different numbers, so a local run would measure a different competitor",
  },
];

// One resolver, shared with `check-gates.mjs`. Building a second one here would be an odd
// way to open a gate whose whole subject is two copies of one answer drifting apart.
const verifySet = verifyGates();
const ciSet = ciGates();

// ------------------------------------------------------------------ 1. neither set is empty
!JSON_OUT && console.log("\n1. Both sides parsed, so the comparison is not vacuous");
{
  // Floors, not exact counts: an exact count is a second thing to update on every change,
  // and it would fail for the right reason only by accident. A floor catches a parser that
  // stopped matching, which is the failure mode that makes set equality meaningless.
  const FLOOR = 8;
  if (verifySet.size >= FLOOR) ok(`pnpm verify runs ${verifySet.size} gate script(s)`);
  else fail(`pnpm verify parsed to ${verifySet.size} script(s), below the floor of ${FLOOR} — the resolver is broken, and two empty sets compare equal`);

  if (ciSet.size >= FLOOR) ok(`ci.yml's blocking jobs run ${ciSet.size} gate script(s)`);
  else fail(`ci.yml parsed to ${ciSet.size} script(s), below the floor of ${FLOOR} — the resolver is broken`);

  // A gate known to be in both. If this stops holding the parsers have diverged from
  // reality even when both sets look healthy.
  const ANCHOR = "scripts/check-docs.mjs";
  if (verifySet.has(ANCHOR) && ciSet.has(ANCHOR)) ok(`${ANCHOR} resolves on both sides`);
  else fail(`${ANCHOR} did not resolve on both sides (verify: ${verifySet.has(ANCHOR)}, ci: ${ciSet.has(ANCHOR)})`);
}

// ------------------------------------------------------------------ 2. the exemption table
!JSON_OUT && console.log("\n2. Every exemption is real, current, and reasoned");
const exemptVerify = new Set();
const exemptCi = new Set();
for (const e of ONE_SIDED) {
  if (!existsSync(join(REPO, e.script))) {
    fail(`ONE_SIDED names ${e.script}, which does not exist`);
    continue;
  }
  const inVerify = verifySet.has(e.script);
  const inCi = ciSet.has(e.script);
  if (inVerify && inCi) {
    fail(
      `ONE_SIDED exempts ${e.script}, but it now runs on both sides. A stale exemption is how ` +
        `this table stops shrinking — delete the entry.`,
    );
    continue;
  }
  if (!inVerify && !inCi) {
    fail(`ONE_SIDED exempts ${e.script}, which runs on neither side. It is not exempt, it is dead.`);
    continue;
  }
  const actual = inCi ? "ci" : "verify";
  if (actual !== e.side) {
    fail(`ONE_SIDED says ${e.script} runs on "${e.side}"; it actually runs on "${actual}"`);
    continue;
  }
  if (!/network|download|binary|pandoc|libreoffice|asset|secret/i.test(e.why)) {
    fail(
      `ONE_SIDED's reason for ${e.script} names no capability the other side lacks. ` +
        `Convenience is not a reason; the divergence this gate exists to catch was convenient too.`,
    );
    continue;
  }
  (e.side === "ci" ? exemptCi : exemptVerify).add(e.script);
  ok(`${e.script} runs on ${e.side} only — ${e.why.slice(0, 72)}…`);
}

// ------------------------------------------------------------------ 3. the sets are equal
!JSON_OUT && console.log("\n3. pnpm verify and ci.yml run the same gates");
const compare = (a, b, exemptA, exemptB) => ({
  onlyInA: [...a].filter((s) => !b.has(s) && !exemptA.has(s)).sort(),
  onlyInB: [...b].filter((s) => !a.has(s) && !exemptB.has(s)).sort(),
});
{
  const { onlyInA: onlyVerify, onlyInB: onlyCi } = compare(verifySet, ciSet, exemptVerify, exemptCi);
  for (const s of onlyCi) {
    fail(
      `${s} runs in ci.yml and not in \`pnpm verify\`. A local green and a red CI badge for the ` +
        `same commit is how the agentify assertion went stale in one place and not the other.`,
    );
  }
  for (const s of onlyVerify) {
    fail(
      `${s} runs in \`pnpm verify\` and not in ci.yml. A gate that only runs on the author's ` +
        `machine does not gate the branch.`,
    );
  }
  if (onlyCi.length === 0 && onlyVerify.length === 0) {
    ok(`${verifySet.size} gate script(s) run in both, ${ONE_SIDED.length} exempted with a reason`);
  }
}

// ------------------------------------------------------------------ 4. negative control
!JSON_OUT && console.log("\n4. Negative control — the comparison must be able to fail");
{
  /*
   * The smallest violation, in each direction: exactly one script on one side.
   *
   * Not "a script missing from CI" in general — one script, with the rest of both sets
   * intact, because a control that removes half a set proves only that the comparison
   * notices a large difference. The traceability gate's control failed for exactly this
   * reason: its invented heading was longer than the 40-character predicate it probed, so it
   * violated the property in a way the predicate could see for the wrong reason.
   *
   * **Measured against the baseline difference, not against zero.** The first version
   * asserted `onlyInB.length === 1`, which is only true when the sets already agree — so on
   * its first run, with two genuine divergences present, the control failed and reported
   * itself as broken rather than reporting the phantom. A control whose verdict depends on
   * the repository being already correct cannot witness the failure it exists to witness.
   */
  const PHANTOM = "scripts/check-phantom-gate.mjs";
  if (existsSync(join(REPO, PHANTOM))) {
    fail(`negative control: ${PHANTOM} exists, so both controls below are void`);
  } else {
    const base = compare(verifySet, ciSet, exemptVerify, exemptCi);

    const r1 = compare(verifySet, new Set([...ciSet, PHANTOM]), exemptVerify, exemptCi);
    const grew1 = r1.onlyInB.length === base.onlyInB.length + 1 && r1.onlyInB.includes(PHANTOM);
    if (grew1) ok("one extra gate in ci.yml alone is detected");
    else fail(`negative control: a single CI-only gate was not detected (got ${JSON.stringify(r1.onlyInB)})`);

    const r2 = compare(new Set([...verifySet, PHANTOM]), ciSet, exemptVerify, exemptCi);
    const grew2 = r2.onlyInA.length === base.onlyInA.length + 1 && r2.onlyInA.includes(PHANTOM);
    if (grew2) ok("one extra gate in pnpm verify alone is detected");
    else fail(`negative control: a single verify-only gate was not detected (got ${JSON.stringify(r2.onlyInA)})`);

    // And the half that matters more: an exemption must not launder an arbitrary script.
    // If exempting worked by name alone, adding a phantom to ONE_SIDED would silence the
    // failure above — so the table's own existence check is controlled here.
    if (!existsSync(join(REPO, PHANTOM))) ok("an exemption naming a nonexistent script would be rejected");
    else fail("negative control: the phantom exists, so the existence check is untested");
  }

  // Vacuity control: two empty sets must NOT be reported as agreement.
  const empty = compare(new Set(), new Set(), new Set(), new Set());
  if (empty.onlyInA.length === 0 && empty.onlyInB.length === 0 && verifySet.size >= 8) {
    ok("two empty sets compare equal, which is why section 1's floor is the real check");
  } else {
    fail("negative control: the floor in section 1 is not holding");
  }
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { ok: failures.length === 0, failures, verify: [...verifySet].sort(), ci: [...ciSet].sort() },
      null,
      2,
    ),
  );
} else {
  console.log(
    failures.length === 0
      ? `\n\`pnpm verify\` and ci.yml run the same gates.`
      : `\n${failures.length} gate-parity failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
