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
  // and brief §6.2 requires minimal diffs. So line length is not ours to satisfy.
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
if (violations === 0 && renderFailures.length === 0) {
  console.log(`ok   ${files} rendered file(s) satisfy the lint rule set with no autofix pass`);
  console.log("\nMARKDOWN LINT GATE PASSED");
  process.exit(0);
}
console.log(
  `\n${violations} violation(s) and ${renderFailures.length} render failure(s) across ` +
    `${files} file(s). The remark-stringify configuration has drifted from the rule set: ` +
    `fix the configuration in @markforge/render-md rather than post-processing the output.`,
);
process.exit(1);
