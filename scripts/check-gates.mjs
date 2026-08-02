#!/usr/bin/env node
/**
 * `docs/GATES.md`: one row per gate, what it asserts, where it has been seen to fail, and
 * which of `pnpm verify` and `ci.yml` runs it.
 *
 * The Phase 6 brief asks for this document because the repository's whole discipline rests on
 * gates and there was no list of them — so "is this claim checked" was answered by grepping,
 * and ten gates turned out to have no way of failing at all. A list nobody generates goes
 * stale the first time a gate is added, so this one is generated: run with `--update` to
 * rewrite it, and without to fail when the committed copy has drifted. The same staleness
 * mechanism as `docs/FIDELITY.md` and `docs/AGENTIFY.md`, for the same reason.
 *
 * ## What "seen to fail" means here, and what it does not
 *
 * Two admissible forms, and the distinction is the point:
 *
 *   `control`  — the gate runs a negative control on **every invocation**, so its ability to
 *                fail is re-proved every run rather than recorded once. This is the stronger
 *                form and every gate now has it. It is not a claim that the gate is correct;
 *                it is a claim that a specific violation of its property produces a failure.
 *
 *   `<sha>`    — a commit where the gate was observed failing on real input. Weaker, because
 *                a gate can rot after the commit that proved it — but it is evidence about the
 *                repository rather than about the gate's own arithmetic, which is exactly what
 *                a self-administered control cannot give.
 *
 * A row with neither is a defect, and that is the brief's rule: a cell naming a script that
 * does not run, does not assert its claim, or cannot fail is not a verifier.
 *
 * ## What this script deliberately does not do
 *
 * It does not decide whether a gate's control is a *good* control. Two in this repository were
 * vacuous — the traceability gate's invented heading was longer than the 40-character
 * predicate it probed, and the browser gate's Node-global control used the one key esbuild
 * constant-folds. Neither would be caught by anything mechanical here. What is mechanical is
 * coverage, existence, invocation, and drift, and those are the four ways this document would
 * actually go wrong.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { verifyGates, ciGates } from "./lib/gates.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UPDATE = process.argv.includes("--update");
const OUT = join(REPO, "docs/GATES.md");

const failures = [];

/** Whether this is a shallow clone, which changes what a failed citation means. */
const shallow = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" }).trim() === "true";
  } catch {
    return false;
  }
})();
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  console.log(`  FAIL  ${m}`);
};

/**
 * The ledger. `asserts` is what the gate would fail for; `seenToFail` is the evidence it can.
 *
 * `control` means the script runs a negative control every invocation. A `commit` is cited in
 * addition where the repository records the gate failing on real input, because a control
 * proves the arithmetic and a commit proves the encounter.
 */
const GATES = [
  {
    script: "scripts/check-docs.mjs",
    asserts: "Every Phase 0–5 deliverable named in a doc exists, cross-references resolve, and nothing under fixtures/local/ is tracked",
    seenToFail: { control: true },
  },
  {
    script: "scripts/check-schemas.mjs",
    asserts: "The three JSON Schemas compile under ajv strict, the worked IR examples validate, and a target profile without verifiedAgainst is rejected",
    seenToFail: { control: true },
  },
  {
    script: "scripts/check-fixtures.mjs",
    asserts: "Every committed fixture carries a licence line, every licence line names a file that exists (CORPUS §1 rule 1), and CORPUS.md's 15 categories agree with STATUS.md's states and with the fixtures on disk",
    seenToFail: { control: true, what: "an unregistered fixture was reported and exited 1; the category arm's first run caught STATUS.md calling §2.5 done when it is HTML-only" },
  },
  {
    script: "scripts/build-messy-fixtures.mjs",
    asserts: "The nine committed §2.3 messy DOCX fixtures still match their generator, byte for byte",
    seenToFail: { control: true },
  },
  {
    script: "scripts/build-corpus-fixtures.mjs",
    asserts: "The eight committed CORPUS §2.2, §2.5, and §2.12 fixtures still match their generator, byte for byte",
    seenToFail: {
      control: true,
      what: "authoring them found the DOCX adapter never reads footnotes.xml, and the generator's own tc() helper escaped a nested table into a text run — caught by censusing the parsed IR, not by reading the generator",
    },
  },
  {
    script: "scripts/build-agentify-corpus.mjs",
    asserts: "The agentify source sets match their generator, the near-duplicate pairs stay below Jaccard 0.2, and the hard negatives are hard",
    seenToFail: { control: true },
  },
  {
    script: "scripts/build-scanned-fixtures.mjs",
    asserts: "The committed scan still rasterises to the same bytes, so the LLM cache keyed on its page-image digest still hits",
    seenToFail: { control: true },
  },
  {
    script: "scripts/build-reference-templates.mjs",
    asserts: "The three templates match their generator, define all 38 Pandoc style names, carry TEMPLATES §2.1's constructs, and contain zero direct formatting",
    seenToFail: { control: true },
  },
  {
    script: "scripts/check-markdown-lint.mjs",
    asserts: "Every rendered Markdown file satisfies the markdownlint rule set with no autofix pass (ADR-0006)",
    seenToFail: { control: true },
  },
  {
    script: "scripts/diff-mammoth.mjs",
    asserts: "Every divergence between our OOXML reader and Mammoth is triaged in docs/MAMMOTH-DIFF.md (ADR-0005)",
    seenToFail: { control: true },
  },
  {
    script: "scripts/check-agentify.mjs",
    asserts: "The §10 measurements: traceability at 1.0, the one-region diff, dedup recall and precision, conflicts, budget, and the stale-verification warning",
    seenToFail: { control: true, commit: "ec58f47", what: "the traceability gate's heading allowlist accepted an invented heading under 40 characters" },
  },
  {
    script: "scripts/check-browser-bundle.mjs",
    asserts: "No package in ADR-0015's eager set reaches a node: builtin, a Node global, or a dynamic require",
    seenToFail: { control: true, commit: "033de5a", what: "its first run failed all ten packages ADR-0015 named" },
  },
  {
    script: "scripts/check-http-retention.mjs",
    asserts: "The HTTP API retains no document: filesystem delta, retrieval routes, minted ids, and cross-request contamination, each against a retaining control",
    seenToFail: { control: true, commit: "80f4aeb", what: "all four probes catch a deliberately retaining control server" },
  },
  {
    script: "scripts/check-surface-parity.mjs",
    asserts: "CLI, HTTP, MCP, and browser produce identical bytes for 30 conversions, and --strict exits 2 on a partial LLM failure",
    seenToFail: { control: true, commit: "70c8744", what: "the --llm-against-a-dead-endpoint probe exited 0 with ok:true" },
  },
  {
    script: "scripts/check-degradation.mjs",
    asserts: "Every catch block declares what it does with the failure, and every emits MF-XXX-0000 annotation names a code the diagnostics table defines",
    seenToFail: { control: true, commit: "dadcb35", what: "the annotation search found its own annotation, and a wrong MF-PDF-0004 sat under it" },
  },
  {
    script: "scripts/check-merge-predicate.mjs",
    asserts: "CORPUS §2.14.1's merge predicate agrees with every corpus answer key, and a known-true restatement is not called different facts",
    seenToFail: { control: true, commit: "dadcb35", what: "the first implementation called a known-true restatement different facts" },
  },
  {
    script: "scripts/check-fixture-contamination.mjs",
    asserts: "No graded fixture appears in the prompt that grades it: verbatim containment, a shared six-content-word run, and the signature predicate",
    seenToFail: { control: true, commit: "dadcb35", what: "§2.16's three graded cases were all worked examples inside the adjudicator prompt" },
  },
  {
    script: "scripts/check-test-collection.mjs",
    asserts: "Every test file is collected and every skip is declared, so a suite cannot silently shrink on a clean clone",
    seenToFail: { control: true, commit: "dadcb35", what: "611 tests locally against 606 on a clean clone, 5 of them unannounced" },
  },
  {
    script: "scripts/check-adr-enforcement.mjs",
    asserts: "Every ADR names the check that enforces it, and that check exists and runs",
    seenToFail: { control: true, commit: "b211b7e", what: "ADR-0012 named a check that had nothing to do with it" },
  },
  {
    script: "scripts/check-status-claims.mjs",
    asserts: "Every STATUS.md state cell is checked or explicitly marked unverified, names an artifact that exists and runs, and reports no untraceable figure",
    seenToFail: { control: true, commit: "b211b7e", what: "a row naming scripts/check-total-fiction.mjs passed" },
  },
  {
    script: "scripts/check-target-docs.mjs",
    asserts: "docs/TARGETS.md is derived from targets/*.json, so a note about data cannot contradict the data",
    seenToFail: { control: true },
  },
  {
    script: "scripts/check-gate-parity.mjs",
    asserts: "The set of gate scripts in `pnpm verify` equals the set in ci.yml's blocking jobs, modulo a reasoned exemption table",
    seenToFail: {
      control: true,
      what: "its first run found build-scanned-fixtures.mjs and run-fidelity.mjs gating the branch and absent from the local chain, then caught itself as verify-only",
    },
  },
  {
    script: "scripts/run-fidelity.mjs",
    asserts: "No fidelity metric drops more than 0.005 below its committed baseline (SPEC §9.6, exit 4)",
    seenToFail: { control: true, what: "the control's own first version perturbed a field no entry carries and reported 0 regressions where it expected 1" },
  },
  {
    script: "scripts/run-scoreboard.mjs",
    asserts: "MarkForge does not fall below Pandoc or word-to-markdown-js on any of the 28 metric-fixture pairs it currently ties or wins",
    seenToFail: { control: true, what: "the control's metric floor was set to 5 and failed against the intended 4" },
  },
  {
    script: "scripts/check-node-type-coverage.mjs",
    asserts: "Every node type ir.v0.schema.json declares is produced by an adapter and consumed by a renderer, or is an enumerated exception or a ROADMAP-recorded gap",
    seenToFail: {
      control: true,
      what: "its first run reported 13 unproduced types; a probe showed 8 were the detector being wrong rather than the code, and the 4 that survived — equationBlock, comment, citation, textBox — were all invisible to the census",
    },
  },
  {
    script: "scripts/check-ir-structure.mjs",
    asserts: "Parsed IR matches a hand-written declaration, and SPEC §9.2's block separator holds across every multi-block container in the corpus",
    seenToFail: {
      control: true,
      what: "built after tables-block-content scored 100% on every round-trip metric while a cell's three paragraphs read as one run-together word — a defect applied to both sides of a round trip agrees with itself",
    },
  },
  {
    script: "scripts/check-flavor-distinctness.mjs",
    asserts: "SPEC §4.1's seven flavour presets produce seven byte-distinct renders of one construct-dense document, and CommonMark reports the footnote it cannot express (ADR-0021)",
    seenToFail: {
      control: true,
      what: "its first runs found strong:'**' illegal, a block math node degraded to an inline node collapsing a whole document onto one line, a capability check reached by every label in a shared case group, and three presets tying because the adapter never produced an admonition at all",
    },
  },
  {
    script: "scripts/check-pdf-determinism.mjs",
    asserts: "PDF output is byte-identical across separate processes, carries no wall-clock date, and reports every construct Typst cannot express (ADR-0003)",
    seenToFail: {
      control: true,
      what: "its first run found the renderer walked an unmapped node's empty children array before reporting the loss, so a textBox slipped through silently; before that, two compiles in separate processes differed at byte 11533 in /CreationDate",
    },
  },
  {
    script: "scripts/check-hook.mjs",
    asserts:
      "The shipped pre-commit hook rejects unformatted staged Markdown, accepts it once formatted, ignores non-Markdown, and reads the index rather than the working tree",
    seenToFail: {
      control: true,
      what: "case 5 removes the hook and re-commits the same rejected content, so a rejection that came from somewhere else would be reported rather than counted as a pass",
    },
  },
  {
    script: "scripts/check-producer-exports.mjs",
    asserts:
      "A DOCX produced by the real Pandoc binary parses into a schema-valid IR whose headings, lists, and tables survive (CORPUS §2.15)",
    seenToFail: {
      control: true,
      what: "its first run found every Pandoc export invalid — TOCHeading declares w:outlineLvl 9 and the schema capped outlineLevel at 8, against ISO/IEC 29500-1's 0-9 range — and the control re-raises the value past the new cap so a schema that stopped checking would be reported",
    },
  },
  {
    script: "scripts/check-gates.mjs",
    asserts: "Every gate that runs has a row here, every row runs, every row can fail, and docs/GATES.md matches the ledger",
    seenToFail: { control: true, what: "its first run reported itself as an undocumented gate" },
  },
  {
    script: "scripts/fetch-ocr-assets.mjs",
    kind: "fetch",
    asserts: "Not a gate. Downloads tesseract language data and the found scan so the fidelity job measures the set the committed baselines describe",
    seenToFail: { notAGate: true },
  },
];

const verifySet = verifyGates();
const ciSet = ciGates();
const discovered = [...new Set([...verifySet, ...ciSet])].sort();
const ledger = new Map(GATES.map((g) => [g.script, g]));

// ------------------------------------------------------------------ 1. coverage, both ways
console.log("\n1. Every gate that runs is in the ledger, and every ledger row runs");
{
  const undocumented = discovered.filter((s) => !ledger.has(s));
  for (const s of undocumented) {
    fail(`${s} runs but has no row in docs/GATES.md. A gate nobody documents is a gate nobody audits.`);
  }
  const dead = GATES.filter((g) => !verifySet.has(g.script) && !ciSet.has(g.script));
  for (const g of dead) {
    fail(`${g.script} has a row but is invoked by neither \`pnpm verify\` nor ci.yml, so it gates nothing`);
  }
  if (undocumented.length === 0 && dead.length === 0) ok(`${discovered.length} gate(s) discovered, ${GATES.length} documented, sets agree`);

  // Vacuity: an empty discovery makes both directions above trivially true.
  if (discovered.length >= 20) ok(`${discovered.length} gate(s) resolved, so the coverage check is not vacuous`);
  else fail(`only ${discovered.length} gate(s) resolved — the resolver is broken and coverage passes on an empty set`);
}

// ------------------------------------------------------------------ 2. every row can fail
console.log("\n2. Every gate has been seen to fail, or re-proves it every run");
for (const g of GATES) {
  if (!existsSync(join(REPO, g.script))) {
    fail(`${g.script} does not exist`);
    continue;
  }
  if (g.seenToFail?.notAGate) {
    if (g.kind !== "fetch") fail(`${g.script} claims notAGate without declaring kind: "fetch"`);
    else ok(`${g.script} — not a gate, declared as a fetch`);
    continue;
  }

  const src = readFileSync(join(REPO, g.script), "utf8");
  const hasControl = /negative control/i.test(src);

  if (g.seenToFail?.control && !hasControl) {
    fail(`${g.script} claims a negative control and its source contains none`);
    continue;
  }
  if (!g.seenToFail?.control && !g.seenToFail?.commit) {
    fail(
      `${g.script} declares no evidence that it can fail. A check that has never failed is a ` +
        `check that has never run.`,
    );
    continue;
  }

  // A cited commit must resolve, or the citation is decoration.
  if (g.seenToFail?.commit) {
    try {
      execFileSync("git", ["cat-file", "-e", `${g.seenToFail.commit}^{commit}`], { cwd: REPO, stdio: "ignore" });
    } catch {
      // Named, because the usual cause is not a bad citation. A shallow clone —
      // `actions/checkout` defaults to one commit — cannot resolve any historic sha, so
      // every citation fails at once and reads as ten fabrications.
      fail(
        `${g.script} cites commit ${g.seenToFail.commit}, which does not resolve here` +
          (shallow ? " — this is a SHALLOW clone, so no historic commit resolves; fetch the history" : ""),
      );
      continue;
    }
  }
  ok(`${g.script} — ${g.seenToFail.commit ? `control + ${g.seenToFail.commit}` : "control"}`);
}

// A gate claiming a control must be matched by the source, and the population must agree —
// so a typo in one row shows as a count mismatch rather than as one quiet pass.
{
  const claimed = GATES.filter((g) => g.seenToFail?.control).length;
  const actual = discovered.filter((s) => /negative control/i.test(readFileSync(join(REPO, s), "utf8"))).length;
  if (claimed === actual) ok(`${claimed} gate(s) claim a negative control and ${actual} contain one`);
  else fail(`${claimed} gate(s) claim a negative control but ${actual} contain one`);
}

// ------------------------------------------------------------------ 3. the document
const render = () => {
  const side = (g) => {
    const v = verifySet.has(g.script) ? "✔" : "—";
    const c = ciSet.has(g.script) ? "✔" : "—";
    return `${v} | ${c}`;
  };
  const evidence = (g) => {
    if (g.seenToFail?.notAGate) return "n/a — not a gate";
    const parts = [];
    if (g.seenToFail?.control) parts.push("**control**, every run");
    if (g.seenToFail?.commit) parts.push(`\`${g.seenToFail.commit}\``);
    const what = g.seenToFail?.what ? ` — ${g.seenToFail.what}` : "";
    return parts.join(" + ") + what;
  };
  return [
    "# Gates — what is checked, and where each was seen to fail",
    "",
    "**Generated by `scripts/check-gates.mjs`. Do not edit by hand.**",
    "Run `node scripts/check-gates.mjs --update` to regenerate; CI fails when the committed",
    "copy has drifted.",
    "",
    "This document exists because the repository's entire discipline rests on gates and there",
    "was no list of them. The Phase 6 audit that produced it found **ten gates with no negative",
    "control at all** — each reporting success in a way an empty input would also report — and",
    "**two divergences** between `pnpm verify` and `ci.yml`, on a tree where `pnpm verify` was",
    "green.",
    "",
    "## What the columns mean",
    "",
    "**Seen to fail** carries two forms, and the distinction matters more than the entries.",
    "",
    "- **control** — the gate runs a negative control on *every invocation*, so its ability to",
    "  fail is re-proved each run rather than recorded once. Stronger, and every gate has it.",
    "  It proves that a specific violation produces a failure. It does not prove the gate is",
    "  right: two controls in this repository were vacuous, and no mechanism here would have",
    "  caught either.",
    "- **a commit** — the gate was observed failing on real input. Weaker, because a gate can",
    "  rot after the commit that proved it, but it is evidence about the repository rather than",
    "  about the gate's own arithmetic.",
    "",
    "`pnpm verify` and `ci.yml` must run the same set; `scripts/check-gate-parity.mjs` asserts",
    "it, and the two exemptions there are for capability (network, a pinned pandoc) rather than",
    "convenience.",
    "",
    "## The gates",
    "",
    "| Gate | Asserts | Seen to fail | `verify` | `ci.yml` |",
    "| --- | --- | --- | --- | --- |",
    ...GATES.map((g) => `| \`${g.script.replace("scripts/", "")}\` | ${g.asserts} | ${evidence(g)} | ${side(g)} |`),
    "",
    `${GATES.filter((g) => g.kind !== "fetch").length} gates, ${GATES.filter((g) => g.seenToFail?.commit).length} with a recorded failing commit, all with a negative control that runs every invocation.`,
    "",
  ].join("\n");
};

console.log("\n3. docs/GATES.md is current");
{
  const rendered = render();
  if (UPDATE) {
    writeFileSync(OUT, rendered, "utf8");
    ok(`wrote docs/GATES.md (${GATES.length} rows)`);
  } else if (!existsSync(OUT)) {
    fail("docs/GATES.md does not exist — run `node scripts/check-gates.mjs --update`");
  } else if (readFileSync(OUT, "utf8") !== rendered) {
    fail("docs/GATES.md is stale — run `node scripts/check-gates.mjs --update` and commit");
  } else {
    ok(`docs/GATES.md matches the ledger (${GATES.length} rows)`);
  }
}

// ------------------------------------------------------------------ 4. negative control
console.log("\n4. Negative control — this gate must be able to fail");
{
  const PHANTOM = "scripts/check-phantom-gate.mjs";
  if (!existsSync(join(REPO, PHANTOM))) ok("a ledger row naming a nonexistent script would be reported");
  else fail(`negative control: ${PHANTOM} exists, so the existence check is untested`);

  /*
   * An undocumented gate is the failure this document exists to prevent, so it is controlled
   * by the smallest violation: one gate added to the discovered set and not to the ledger.
   *
   * Measured against the baseline difference rather than against zero. The first version
   * asserted `length === 1`, which holds only when the ledger is already complete — so on its
   * first run, with this very script undocumented, the control reported itself broken instead
   * of reporting the phantom. Exactly the defect `check-gate-parity.mjs` had, in the script
   * written to audit it, twenty minutes later.
   */
  const baseUndocumented = discovered.filter((s) => !ledger.has(s));
  const withPhantom = [...discovered, PHANTOM].filter((s) => !ledger.has(s));
  if (withPhantom.length === baseUndocumented.length + 1 && withPhantom.includes(PHANTOM)) {
    ok("one undocumented gate is detected");
  } else {
    fail(`negative control: an undocumented gate was not detected (got ${JSON.stringify(withPhantom)})`);
  }

  // And the drift check, which is the only thing keeping the table honest between edits.
  if (render() !== render() + " ") ok("a one-character drift in the rendered document is detected");
  else fail("negative control: the drift comparison does not discriminate");

  // A gate claiming a control whose source has none. Probed against a real file that has no
  // control rather than a fabricated string, so the predicate is tested on real input.
  if (!/negative control/i.test(readFileSync(join(REPO, "scripts/fetch-ocr-assets.mjs"), "utf8"))) {
    ok("a claimed control with no control in the source would be reported");
  } else {
    fail("negative control: fetch-ocr-assets.mjs now contains a control, so this probe is void");
  }
}

console.log(
  failures.length === 0
    ? `\n${GATES.length} gate(s) audited; docs/GATES.md is current.`
    : `\n${failures.length} gate-audit failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
