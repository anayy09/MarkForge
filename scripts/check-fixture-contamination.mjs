#!/usr/bin/env node
/**
 * No graded fixture may appear inside a prompt that grades it.
 *
 * ## Why this exists
 *
 * `CORPUS.md` §2.14.2 retired two near-duplicate pairs on the rule that *a graded case which
 * has already taught the thing it grades is not a graded case*. That rule was applied by hand,
 * to the two pairs someone happened to be looking at, and the replacement set — §2.16 — was
 * authored under it and then **violated it in all three of its cases at once**:
 *
 *   - the recall pair's two sentences are a verbatim worked example in
 *     `context-unit-summarization/v2.md`, together with the answer ("and are one fact");
 *   - the retention hard negative's numbers are a worked example ("24 hours and 7 days are
 *     different facts");
 *   - the ordering hard negative's side A is the sentence quoted in the prompt's own
 *     changelog as the case v1 got wrong, and the `before/after/until` rule was written for it.
 *
 * Every §2.16 number was the prompt reciting its own examples. `1/1` recall and `0/2` false
 * merges measured the copy, not the model. Nothing in the repository could have said so,
 * because the rule was prose and the check was a person remembering to apply it.
 *
 * ## What is measured
 *
 * Three predicates, weakest to strongest, over every graded sentence against every prompt:
 *
 *   `verbatim`  — the normalised sentence is a substring of the normalised prompt. Fatal.
 *   `ngram`     — a shared run of {@link NGRAM} content words. Catches a paraphrase that keeps
 *                 the distinctive clause, which is contamination that a diff would not show.
 *   `signature` — every number, unit, and identifier in the sentence appears in the prompt.
 *                 This is what caught the retention pair, whose sentences are nowhere in the
 *                 prompt but whose *answer* is: "24 hours and 7 days are different facts".
 *
 * A prompt may of course contain worked examples. What it may not contain is a worked example
 * that is also a graded case, and the fix is always to change the fixture rather than the
 * prompt — the prompt is allowed to teach, and the corpus is what checks whether it worked.
 *
 * Retired cases are reported and do not fail: they are documentation of a disagreement and
 * grade nothing by definition, which is the whole point of retiring them.
 *
 * ## Every prompt version, not the live one
 *
 * All five prompt files are scanned — `context-unit-summarization/{v1,v2}`,
 * `heading-tiebreak/{v1,v2}`, `page-transcription/v1` — because a fixture authored while v1
 * was live is contaminated by v1 whatever v2 says, and because v2 was written by editing v1.
 * That is not theoretical: the fourth contamination this gate found on its first run was
 * `clean/mustNotMerge[2]`, verbatim in **v1** and in no live prompt.
 *
 * ## What this gate cannot see, stated so its passing is not overread
 *
 * All three predicates are surface predicates. **A prompt that teaches the general rule a
 * fixture tests, sharing no words, no run, and no numbers with it, passes cleanly here and is
 * still contamination of a kind.** `v2.md` says *"An ordering or a precondition — before,
 * after, until → different facts"*; a fresh hard negative turning on `until`, in another
 * domain with other numbers, would be graded against a rule the model was handed.
 *
 * This is probably not closable mechanically, because the alternative — forbidding prompts
 * from stating rules — would leave nothing to grade. The line drawn instead is between
 * teaching a rule and supplying an answer, and only the second is detectable. So a pass here
 * means "no graded case appears in a prompt", which is narrower than "no graded case was
 * given away", and the difference is a judgement a fixture author still has to make.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const note = (m) => !JSON_OUT && !LIST && console.log(`  note  ${m}`);

/** Shared run of content words that counts as the same clause rather than the same topic. */
const NGRAM = 6;

const STOP = new Set(
  ("a an and are as at be been by can for from has have in is it its must no not of on or " +
    "should so than that the their them then there these this those to under until up was " +
    "were which while with within would any all each every both").split(" "),
);

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);
const contentWords = (s) => words(s).filter((w) => !STOP.has(w));

/** Numbers, units, and identifiers — what a restatement is not allowed to vary. */
function signature(text) {
  const out = new Set();
  for (const w of words(text)) {
    if (/\d/.test(w) || /_/.test(w)) out.add(w);
    if (/^(ms|millisecond|milliseconds|second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|kb|mb|gb|tb|percent)$/.test(w)) {
      out.add(w.replace(/s$/, ""));
    }
  }
  return out;
}

/** The longest run of content words the two texts share. */
function longestSharedRun(a, b) {
  const A = contentWords(a);
  const B = new Set();
  const Bw = contentWords(b);
  for (let n = Math.min(A.length, Bw.length); n >= 1; n--) {
    B.clear();
    for (let i = 0; i + n <= Bw.length; i++) B.add(Bw.slice(i, i + n).join(" "));
    for (let i = 0; i + n <= A.length; i++) {
      if (B.has(A.slice(i, i + n).join(" "))) return { length: n, run: A.slice(i, i + n).join(" ") };
    }
  }
  return { length: 0, run: "" };
}

// ------------------------------------------------------------------ inputs
function promptFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...promptFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const prompts = promptFiles(join(REPO, "packages/llm/prompts")).map((path) => ({
  path: path.replaceAll("\\", "/").replace(REPO.replaceAll("\\", "/"), ""),
  text: readFileSync(path, "utf8"),
}));

/** Every sentence a corpus answer key makes a grading claim about. */
const GRADED_FIELDS = [
  { field: "nearDuplicates", graded: true },
  { field: "mustNotMerge", graded: true },
  { field: "retiredNearDuplicates", graded: false },
  { field: "retiredMustNotMerge", graded: false },
];

const cases = [];
const agentifyDir = join(REPO, "fixtures/agentify");
for (const set of readdirSync(agentifyDir).sort()) {
  const keyPath = join(agentifyDir, set, "expected-units.json");
  if (!existsSync(keyPath)) continue;
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  for (const { field, graded } of GRADED_FIELDS) {
    for (const [i, pair] of (key[field] ?? []).entries()) {
      for (const side of ["a", "b"]) {
        if (!pair[side]?.text) continue;
        /*
         * A case is only *gradeable by the model* if the model decides it.
         *
         * `blockedBy: "entityKey"` means §10.4's entity block separates the pair in
         * `dedup.ts` before any shortlist is built and before any prompt is read
         * (`packages/agentify/src/dedup.ts:165` — the pair is skipped, not scored). Its
         * verdict is produced by code, deterministically, so what a prompt happens to
         * contain cannot influence it. Reported, not failed.
         *
         * This is scoping, not an escape hatch, and the difference is that it is bounded
         * from two directions: `build-agentify-corpus.mjs` already fails a precision arm
         * where fewer than half the negatives reach the adjudicator, and section 3 below
         * fails if *every* contaminated case in a set claims the exemption. A pair cannot
         * dodge this gate by relabelling itself without also weakening the arm it sits in.
         */
        const modelDecides = field !== "mustNotMerge" || (pair.blockedBy ?? "adjudicator") === "adjudicator";
        cases.push({
          set, field, index: i, side, text: pair[side].text,
          graded: graded && modelDecides,
          exempt: graded && !modelDecides ? (pair.blockedBy ?? "unknown") : null,
        });
      }
    }
  }
}

// ------------------------------------------------------------------ 1. the measurement
!JSON_OUT && !LIST && console.log("\n1. No graded fixture sentence appears in a prompt that grades it");

for (const c of cases) {
  const hits = [];
  for (const p of prompts) {
    const promptNorm = norm(p.text);
    if (promptNorm.includes(norm(c.text))) {
      hits.push({ prompt: p.path, kind: "verbatim", detail: "the sentence is in the prompt word for word" });
      continue;
    }
    const shared = longestSharedRun(c.text, p.text);
    if (shared.length >= NGRAM) {
      hits.push({ prompt: p.path, kind: "ngram", detail: `${shared.length} content words shared: "${shared.run}"` });
      continue;
    }
    const sig = signature(c.text);
    if (sig.size >= 2) {
      const promptWords = new Set(words(p.text).map((w) => w.replace(/s$/, "")));
      const missing = [...sig].filter((s) => !promptWords.has(s) && !promptWords.has(s.replace(/s$/, "")));
      if (missing.length === 0) {
        hits.push({ prompt: p.path, kind: "signature", detail: `every distinctive token appears: ${[...sig].sort().join(", ")}` });
      }
    }
  }

  rows.push({ ...c, hits });
  if (hits.length === 0) continue;

  const where = hits.map((h) => `${h.prompt} (${h.kind}: ${h.detail})`).join("; ");
  if (c.graded) {
    fail(`${c.set}/${c.field}[${c.index}].${c.side} "${c.text.slice(0, 46)}…" is in ${where}`);
  } else if (c.exempt) {
    note(
      `${c.set}/${c.field}[${c.index}].${c.side} overlaps ${hits[0].prompt} (${hits[0].kind}) — ` +
        `decided by the ${c.exempt} block before any prompt is read, so a prompt cannot influence it`,
    );
  } else {
    note(`retired ${c.set}/${c.field}[${c.index}].${c.side} overlaps ${hits[0].prompt} (${hits[0].kind}) — grades nothing, so not a failure`);
  }
}

const gradedCases = rows.filter((r) => r.graded);
if (failures.length === 0) {
  ok(`${gradedCases.length} model-decided sentence(s) across ${new Set(gradedCases.map((r) => r.set)).size} set(s), none present in any of the ${prompts.length} prompts`);
}

// ------------------------------------------------------- 1b. the exemption cannot be the arm
for (const set of new Set(rows.map((r) => r.set))) {
  const negatives = rows.filter((r) => r.set === set && r.field === "mustNotMerge");
  if (negatives.length === 0) continue;
  const exemptContaminated = negatives.filter((r) => r.exempt && r.hits.length > 0);
  if (exemptContaminated.length > 0 && exemptContaminated.length === negatives.length) {
    fail(
      `${set}: every hard negative is both contaminated and structurally exempt, so the ` +
        `precision arm measures entity blocking on cases the prompt already answers`,
    );
  } else if (exemptContaminated.length > 0) {
    note(
      `${set}: ${exemptContaminated.length / 2} contaminated negative(s) exempt as structurally ` +
        `decided, out of ${negatives.length / 2} — the arm still rests on model-decided cases`,
    );
  }
}

// ------------------------------------------------------------------ 2. negative controls
!JSON_OUT && !LIST && console.log("\n2. Negative controls — each predicate must be able to fire");
{
  const promptText = prompts.find((p) => p.path.includes("context-unit-summarization/v2"))?.text ?? "";
  if (!promptText) fail("the adjudicator prompt was not found, so nothing below measures anything");

  // The three real contaminations, as controls. If any stops firing, this gate has stopped
  // being able to catch the thing it was written for.
  const verbatim = "Uploads larger than 64 MB must be rejected by the platform.";
  if (norm(promptText).includes(norm(verbatim))) ok("verbatim: the §2.16 recall pair is detectable inside the prompt");
  else fail("negative control: the known-verbatim §2.16 recall sentence was not found");

  const ordering = "Every archive must be written to two availability zones before the write is acknowledged.";
  const sharedOrdering = longestSharedRun(ordering, promptText);
  if (sharedOrdering.length >= NGRAM) ok(`ngram: the §2.16 ordering sentence shares ${sharedOrdering.length} content words with the prompt`);
  else fail(`negative control: the ordering sentence shared only ${sharedOrdering.length} content words`);

  const retention = "Deletion requests must be honoured within 24 hours.";
  const sig = signature(retention);
  const pw = new Set(words(promptText).map((w) => w.replace(/s$/, "")));
  if ([...sig].every((s) => pw.has(s))) ok(`signature: the retention pair's tokens (${[...sig].sort().join(", ")}) are all in the prompt`);
  else fail("negative control: the retention signature did not fire");

  // And the other direction: an unrelated sentence must come back clean, or the gate would
  // flag every fixture and mean nothing.
  const clean = "Invoices are archived to cold storage after the quarter closes.";
  const cleanShared = longestSharedRun(clean, promptText);
  const cleanSig = signature(clean);
  const cleanHit =
    norm(promptText).includes(norm(clean)) ||
    cleanShared.length >= NGRAM ||
    (cleanSig.size >= 2 && [...cleanSig].every((s) => pw.has(s)));
  if (!cleanHit) ok("an unrelated sentence is not flagged, so the predicate discriminates");
  else fail(`negative control: an unrelated sentence was flagged (shared ${cleanShared.length}: "${cleanShared.run}")`);
}

if (LIST) {
  for (const r of rows) {
    console.log(
      `${r.graded ? "GRADED " : "retired"} ${r.set}/${r.field}[${r.index}].${r.side} ` +
        `${r.hits.length ? "CONTAMINATED " + r.hits.map((h) => h.kind).join("+") : "clean"}  ${r.text.slice(0, 60)}`,
    );
  }
} else if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, rows }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nNo graded case is present in a prompt that grades it.`
      : `\n${failures.length} contaminated graded case(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
