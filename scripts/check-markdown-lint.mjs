// Lints the Markdown our own renderer produces (OPEN_QUESTIONS §8, ADR-0006).
//
// This is a **gate, not a repair pass.** ADR-0006 originally specified `remark-stringify`
// followed by markdownlint autofix iterated to a fixed point, with `maxIterations: 8` as a
// guard. The reviewer asked whether the iteration was avoidable by construction, and it
// is: two tools that can disagree about emphasis markers, list bullets, and line wrapping
// can each undo the other, which is what made a fixed point uncertain in the first place.
// Configuring `remark-stringify` so its output already satisfies the rule set, and then
// checking rather than fixing, gets idempotency from `stringify` being a pure function of
// the tree — no loop, no cap, no oscillation to detect.
//
// A violation here is therefore a **build failure meaning the stringify configuration has
// drifted**, not something to patch after the fact.
//
//   node scripts/check-markdown-lint.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "markdownlint/sync";
import { formatMarkdownSync } from "../packages/core/dist/index.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The rule set, and why each disabled rule is disabled.
 *
 * Every exclusion is a deliberate conflict with a decision recorded elsewhere, not a rule
 * we could not satisfy. A rule turned off to make the build green would defeat the point.
 */
const CONFIG = {
  default: true,
  // ADR-0006: `markdown.lineWidth` defaults to 0, never reflow. Reflowing destroys diff
  // stability — editing one word reflows a paragraph and the diff shows the whole block —
  // and SPEC §10.8 requires minimal diffs. So line length is not ours to satisfy.
  MD013: false,
  // Duplicate headings are a property of the *source document*, not of our rendering. A
  // real manuscript has "Methods" under two parts, and rewriting it would be a content
  // change, which a formatter may not make.
  MD024: false,
  // Likewise multiple top-level headings: some source documents genuinely have them, and
  // inventing a hierarchy to satisfy a linter would be inference, not formatting.
  MD025: false,
  // Inline HTML is how §4.1's table degradation policy preserves merged cells and block
  // content. Banning it would forbid the thing that prevents silent loss.
  MD033: false,
  // First line need not be a heading: a document may open with front matter or a lead
  // paragraph, and that is the source's decision.
  MD041: false,
  // A fence with no language in the source has no language in the output. A formatter
  // cannot invent one, and guessing would be a content change. This is a documentation
  // quality rule, not a rendering rule, so it does not belong in a gate whose job is to
  // detect stringify drift — a bare fence in a new doc would fail the build for a reason
  // that has nothing to do with the renderer.
  MD040: false,
  // The direct conflict, and the most interesting one. MD029 wants every ordered list to
  // start at 1. `fixtures/md/nested-restarting-lists.md` has a list starting at 7, and
  // `restartsAt` exists in the IR precisely so that survives a round trip — DOCX and HTML
  // both express it and losing it is measurable fidelity loss. Renumbering to satisfy the
  // linter would destroy information we built the IR to carry, so our requirement wins.
  MD029: false,
};

const sources = [];
for (const dir of ["docs", "docs/adr", "fixtures/md"]) {
  if (!existsSync(join(REPO, dir))) continue;
  for (const name of readdirSync(join(REPO, dir))) {
    if (name.endsWith(".md")) sources.push(join(REPO, dir, name));
  }
}

const strings = {};
const renderFailures = [];
for (const path of sources) {
  try {
    strings[relative(REPO, path)] = formatMarkdownSync(readFileSync(path, "utf8")).markdown;
  } catch (error) {
    renderFailures.push(`${relative(REPO, path)}: ${error.message}`);
  }
}

const result = lint({ strings, config: CONFIG });

let violations = 0;
for (const [path, issues] of Object.entries(result)) {
  for (const issue of issues) {
    violations += 1;
    if (violations <= 40) {
      console.log(
        `FAIL  ${path}:${issue.lineNumber}  ${issue.ruleNames.slice(0, 2).join("/")}  ` +
          `${issue.ruleDescription}${issue.errorDetail ? ` — ${issue.errorDetail}` : ""}`,
      );
    }
  }
}
if (violations > 40) console.log(`... and ${violations - 40} more`);

for (const f of renderFailures) console.log(`FAIL  could not render ${f}`);

const files = Object.keys(strings).length;

// --- Negative control.
//
// Added in the Phase 6 gate audit, which found this gate could not demonstrate a failure.
// "Zero violations" is what a working configuration reports and also what an empty `strings`
// reports, and also what a config with every rule disabled reports. Three different states,
// one message. ADR-0006 rests on this gate — the autofix pass was removed on the strength of
// "34 files, zero violations" — so a silent one would retire the argument as well as the loop.
console.log("\nNegative control");
let controlFailures = 0;
{
  const ctlOk = (m) => console.log(`ok   ${m}`);
  const ctlFail = (m) => { console.log(`FAIL ${m}`); controlFailures += 1; };

  if (files >= 20) ctlOk(`${files} file(s) linted, so "zero violations" is a measurement`);
  else ctlFail(`only ${files} file(s) linted — "zero violations" is close to vacuous`);

  const enabled = Object.entries(CONFIG).filter(([k, v]) => k !== "default" && v !== false).length;
  const disabled = Object.entries(CONFIG).filter(([k, v]) => k !== "default" && v === false).length;
  if (CONFIG.default !== false) ctlOk(`the rule set is default-on with ${disabled} rule(s) explicitly disabled`);
  else ctlFail("the rule set is default-off, so it can only catch the rules it names");

  // The smallest violation the configuration must still catch: one line of bad Markdown,
  // linted through the same `lint()` call the gate uses. A control that builds its own
  // linter would prove the library works, not that *this* configuration is live.
  const probe = { "_control.md": "#Heading with no space\n\n\n\ntrailing space   \n" };
  const probeResult = lint({ strings: probe, config: CONFIG });
  const caught = (probeResult["_control.md"] ?? []).length;
  if (caught > 0) {
    ctlOk(`a deliberately malformed document raises ${caught} violation(s) under this exact config`);
  } else {
    ctlFail(
      "a deliberately malformed document raised no violation under this config, so the " +
        "zero above says the rules are off rather than satisfied",
    );
  }

  // And the other direction: a clean document must stay clean, or every file fails and the
  // gate is noise. Narrowing a predicate is how a check stops catching anything; widening one
  // is how it stops being read.
  const cleanProbe = { "_control-clean.md": "# Heading\n\nA paragraph.\n" };
  const cleanCaught = (lint({ strings: cleanProbe, config: CONFIG })["_control-clean.md"] ?? []).length;
  if (cleanCaught === 0) ctlOk("a well-formed document raises no violation");
  else ctlFail(`a well-formed document raised ${cleanCaught} violation(s), so the rule set is over-strict`);
}

// --- The documented numbers must match the measured ones.
//
// `34 rendered files` and `five rules are disabled` appeared in SPEC §4.1, OPEN_QUESTIONS §8,
// and ADR-0006. All three were stale — 41 and 7 — because the corpus grew and the prose did
// not, and ADR-0006's decision to drop the autofix pass rests on exactly those figures. A
// number in prose that no check reads is a number that drifts, so this reads them back.
{
  const disabled = Object.entries(CONFIG).filter(([k, v]) => k !== "default" && v === false).length;
  const WORDS = { 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };
  const claims = [
    ["docs/SPEC.md", /Measured at (\d+) files/, files],
    ["docs/OPEN_QUESTIONS.md", /(\d+) rendered files, \*\*zero violations\*\*/, files],
    ["docs/adr/0006-markdown-renderer-idempotency.md", /(\d+) rendered files/, files],
  ];
  for (const [doc, pattern, expected] of claims) {
    const text = readFileSync(join(REPO, doc), "utf8");
    const m = text.match(pattern);
    if (!m) {
      console.log(`FAIL  ${doc} no longer states a rendered-file count in the expected form`);
      controlFailures += 1;
    } else if (Number(m[1]) > expected) {
      // Asserted as a floor, not an equality, and the direction is the whole design. A
      // documented count *above* the measured one is a claim about files that do not exist,
      // which is the dishonest direction and fails. A documented count below it just means
      // the corpus grew since the sentence was written, which is expected and harmless.
      //
      // The first version demanded equality and broke on the commit that added docs/GATES.md
      // — three prose edits for one new document. A check that forces a number to be bumped on
      // every unrelated change is how ADR-0013's `verifiedAgainst` date would rot if it failed
      // the build: people learn to bump the number instead of re-reading the claim.
      console.log(`FAIL  ${doc} claims ${m[1]} rendered file(s); only ${expected} exist`);
      controlFailures += 1;
    } else {
      console.log(`ok   ${doc} claims ${m[1]} rendered file(s), and ${expected} were linted`);
    }
  }
  for (const doc of ["docs/OPEN_QUESTIONS.md", "docs/adr/0006-markdown-renderer-idempotency.md"]) {
    const text = readFileSync(join(REPO, doc), "utf8");
    const m = text.match(/(\w+) rules are disabled/i);
    if (!m) {
      console.log(`FAIL  ${doc} no longer states how many lint rules are disabled`);
      controlFailures += 1;
    } else if (m[1].toLowerCase() !== WORDS[disabled] && m[1] !== String(disabled)) {
      console.log(`FAIL  ${doc} says "${m[1]} rules are disabled"; the config disables ${disabled}`);
      controlFailures += 1;
    } else {
      console.log(`ok   ${doc} states ${disabled} disabled rule(s), matching the config`);
    }
  }
}

if (violations === 0 && renderFailures.length === 0 && controlFailures === 0) {
  console.log(`\nok   ${files} rendered file(s) satisfy the lint rule set with no autofix pass`);
  console.log("\nMARKDOWN LINT GATE PASSED");
  process.exit(0);
}
if (controlFailures > 0) {
  console.log(`\n${controlFailures} negative-control failure(s): this gate cannot currently detect a violation.`);
  process.exit(1);
}
console.log(
  `\n${violations} violation(s) and ${renderFailures.length} render failure(s) across ` +
    `${files} file(s). The remark-stringify configuration has drifted from the rule set: ` +
    `fix the configuration in @markforge/render-md rather than post-processing the output.`,
);
process.exit(1);
