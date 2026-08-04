#!/usr/bin/env node
/**
 * The §10.4 merge predicate, made decidable — and then applied to the corpus's own claims.
 *
 * ## Why this exists
 *
 * `CORPUS.md` §2.14 asserted that two units are "the same fact" without stating under what
 * predicate, and the adjudicator was applying its own. So when the two disagreed there was
 * no way to say which was wrong: "are these one fact" was undecidable, and a graded case
 * whose answer key cannot be checked grades nothing.
 *
 * ## The predicate (CORPUS.md §2.14.1, normative)
 *
 *   Two units are **one fact** if and only if merging them drops nothing renderable —
 *   that is, no constraint, qualifier, scope restriction, or source obligation that some
 *   target profile would have emitted survives in the unmerged output and is absent from
 *   the merged one.
 *
 * This is checkable because it is a question about **output**, not about meaning. Compile
 * the whole target set twice — once with the merge forced, once with it blocked — and diff
 * the emitted files. Whatever disappears is what merging costs. If what disappears is
 * carried by the surviving text, the merge was free and they are one fact. If it is not,
 * they are different facts and the corpus is wrong.
 *
 * ## What counts as "renderable content"
 *
 * Content words in the dropped text that no surviving unit's text carries — stopwords and
 * inflection removed, so "committed"/"commit" do not read as different content. Numbers
 * and units are included on purpose: "two seconds" against "2000 milliseconds" is the
 * qualifier case the predicate exists to catch, and it must survive the comparison as a
 * difference rather than being normalised away into agreement.
 *
 * The predicate is deliberately **conservative**: anything it cannot see as carried is
 * reported as dropped, so its errors fall on the side of "different facts", which is the
 * side that keeps data. §10.4 blocks merges for the same reason.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

const dist = (pkg) => new URL(`../packages/${pkg}/dist/index.js`, import.meta.url).href;
const { parseMarkdown } = await import(dist("adapters-md"));
const agentify = await import(dist("agentify"));
const { DiagnosticBag } = await import(dist("ir"));

const failures = [];
const rows = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};
const info = (m) => !JSON_OUT && console.log(`  info  ${m}`);

const PRODUCER = { kind: "rule", name: "check-merge-predicate", version: "1" };

/**
 * Stopwords. Function words carry no fact, so their presence or absence in a dropped
 * sentence says nothing about whether information was lost.
 */
const STOP = new Set(
  ("a an and are as at be been being but by can cannot could did do does for from had has have how " +
    "if in into is it its may must no not of on once only or over shall should so some such than that " +
    "the their them then there these they this those to under until up was were what when where which " +
    "while who whom why will with within would you your we our us any all each every both").split(" "),
);

/** Crude suffix stripping, so `committed`/`commit` and `batches`/`batch` compare equal. */
function stem(word) {
  return word
    .replace(/(ies)$/, "y")
    .replace(/(ted|ping|ning|ded)$/, "")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/(t)$/, "");
}

/**
 * Number words, so "two seconds" and "2 seconds" are the same qualifier and
 * "sixty-four" and "64" are the same size.
 */
const NUMBER_WORDS = new Map(
  Object.entries({
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
    nine: "9", ten: "10", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", sixty: "60",
    ninety: "90", hundred: "100", thousand: "1000",
  }),
);

/**
 * Scope and quantifier words — the "scope restriction" arm of the predicate.
 *
 * A closed list on purpose. These are the words whose removal changes what a rule *covers*
 * rather than how it is phrased, so dropping one is dropping a restriction some target
 * would have rendered.
 */
const SCOPE = new Set(
  ("whole partial all every only never always least most more fewer less greater per " +
    "before after during unless except including excluding maximum minimum at-least at-most").split(" "),
);

/*
 * `any` and `each` are deliberately **not** in that list.
 *
 * Both were, and the restatement control caught it: "refuse **any** upload exceeding 64 MB"
 * against "Uploads larger than 64 MB are rejected" was called different facts on the
 * strength of a bare determiner. As a determiner in front of a generic plural, `any` adds
 * no coverage the plural did not already have — the restriction in that sentence is
 * `64 MB`, and the number carries it. `all`, `every`, `only`, `whole`, `partial`, `never`,
 * and `always` stay, because each of those genuinely changes what a rule covers and a
 * restatement that drops one is saying something weaker.
 */

/**
 * The **salient** subset of a text: what a target renders as a constraint, qualifier,
 * scope restriction, or source obligation. Synonyms are deliberately excluded.
 *
 * This replaced a plain content-word comparison, and the reason matters more than the
 * code. Measured, content words called a genuine restatement — "The service must refuse
 * any upload exceeding 64 MB" against "Uploads larger than 64 MB are rejected by the
 * platform" — **different facts**, because `service`, `refuse`, and `exceed` do not appear
 * in the second. Every lexically-varied restatement would have failed the same way, which
 * is exactly the case §10.4 and OPEN_QUESTIONS §7c exist for (both authored pairs score
 * Jaccard 0.000). A predicate that can only ever answer "different facts" for the pairs it
 * is meant to judge is not conservative, it is vacuous — and its verdict on those pairs
 * would have been an artifact of the implementation rather than evidence about the pairs.
 *
 * So salience is restricted to what a restatement does *not* get to vary: numbers, units,
 * identifiers, and scope words. `refuse`/`reject` may differ freely; `64 MB` and `p95` and
 * `whole` may not.
 */
function salient(text) {
  const out = new Set();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_.\- ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-]+/, "").replace(/[.\-]+$/, ""))
    .filter(Boolean);

  for (const raw of tokens) {
    // Identifiers: anything carrying an underscore, a digit-letter mix, or a dot.
    if (/_/.test(raw) || /\d/.test(raw)) {
      out.add(raw.replace(/^0+(?=\d)/, ""));
      continue;
    }
    const asNumber = NUMBER_WORDS.get(raw);
    if (asNumber) {
      out.add(asNumber);
      continue;
    }
    const stemmed = stem(raw);
    if (SCOPE.has(raw) || SCOPE.has(stemmed)) out.add(stemmed);
    // Units, kept because a qualifier is a number *and* its unit.
    if (/^(ms|millisecond|second|minute|hour|day|week|month|year|byte|kb|mb|gb|tb|percent|pct)$/.test(stemmed)) {
      out.add(stemmed);
    }
  }
  return out;
}

function contentWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_.\- ]+/g, " ")
      .split(/\s+/)
      // Trailing and leading punctuation is stripped **after** splitting, not before.
      // `.` and `-` are kept inside a token on purpose — `NIMBUS_MAX_BATCH_MB=64` and
      // `p95` are content — but a sentence-final full stop is not part of the word, and
      // leaving it attached made `batches.` and `batches` compare as different content.
      // Caught by the reordering control, which called two orderings of one sentence
      // different facts.
      .map((w) => w.replace(/^[.\-]+/, "").replace(/[.\-]+$/, ""))
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem)
      .filter(Boolean),
  );
}

async function readSet(dir) {
  const sources = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    const text = new TextDecoder().decode(bytes);
    const parsed = await parseMarkdown(bytes, { sourcePath: file, diagnostics: new DiagnosticBag(PRODUCER) });
    sources.push({
      path: file,
      document: parsed.document ?? parsed,
      sourceText: text,
      role: "unknown",
      authority: agentify.authorityOf(text, [], file),
    });
  }
  return sources;
}

/**
 * Compiles the target set with one specific pair forced to merge, or blocked.
 *
 * The adjudicator is replaced rather than configured: this asks "what would the output be
 * if these two were one unit", which is the predicate's question, and it must not depend
 * on what a model happens to think today.
 */
async function compileWith(sources, registry, targets, pair, merge) {
  const assist = {
    embed: undefined,
    adjudicate: async ({ a, b }) => {
      const matches = (sideOf(a.text) === "a" && sideOf(b.text) === "b") ||
        (sideOf(a.text) === "b" && sideOf(b.text) === "a");
      return matches && merge ? { sameFact: true, survivingText: a.text } : { sameFact: false };
    },
  };
  // Enforces **ADR-0020**: the embedding shortlists and the model decides. This file
  // validates the predicate that decision is measured against — with the adjudicator
  // replaced, so the question is what merging *costs*, not what a model thinks today.
  // A cosine of 1.0 for the target pair and 0 elsewhere: the shortlist is not what is
  // under test here, the consequence of merging is.
  assist.embed = (texts) => texts.map((t) => (sideOf(t) ? [1, 0] : [0, 1]));

  /**
   * Which side of the pair a unit's text is, or undefined.
   *
   * Containment in **either direction**, because extraction splits sentences: the key's
   * `a.text` is two sentences ("…rejected whole. Partial ingestion is never acceptable.")
   * while the unit is the first one alone. Matching the key inside the unit finds nothing,
   * which is why the first run of this script reported that forcing the merge changed no
   * output — the forced merge never fired, and the predicate silently measured nothing.
   */
  function sideOf(text) {
    // Case-folded and punctuation-stripped, then compared as prefixes.
    //
    // Neither exact containment direction works. Extraction splits sentences, so the key's
    // two-sentence `a.text` is longer than the unit; and a **rationale** sentence is
    // extracted mid-clause with a lowercased leading word, so the key's capitalised version
    // is not a substring of the unit either. Pair 1 is that second case, and with plain
    // containment the forced merge never fired — the script reported "changed no output"
    // and would have been read as a property of the pipeline rather than of this matcher.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const t = norm(text);
    // Scored, not first-match. A 45-character prefix cannot separate two sentences that
    // open identically — and the §2.16 ordering hard negative was exactly that pair, differing
    // only at "before the write is acknowledged" against "within one hour of acknowledgement".
    // With first-match both sides resolved to `a`, the forced merge never fired, and the
    // script reported "changed no output" as though the pipeline had declined it.
    let best;
    for (const [side, target] of [["a", pair.a], ["b", pair.b]]) {
      const g = norm(target);
      let score = 0;
      if (t === g) score = 1000;
      else if (t.startsWith(g) || g.startsWith(t)) score = Math.min(t.length, g.length);
      else if (t.includes(g) || g.includes(t)) score = Math.min(t.length, g.length) - 1;
      if (score > 0 && (!best || score > best.score)) best = { side, score };
    }
    return best?.side;
  }

  /*
   * `enforceMergePredicate: false` — the one place it is legitimate.
   *
   * §2.14.1 is now a **veto** inside `dedup.ts`, not only a grading instrument, and a veto
   * that prevents merges prevents the forced merge this script depends on. Measured: with it
   * on, every graded pair reported "forcing the merge changed no output", which this script
   * correctly read as the predicate being untestable. The question here is a counterfactual —
   * *if* these two merged, what would the output lose — so the thing that stops merges has to
   * stand aside for it.
   */
  return agentify.compile(sources, { registry, targets, assist, enforceMergePredicate: false });
}

// Not on the package index — it needs node:fs and ajv, and the index must bundle for a
// browser (see packages/agentify/src/registry-node.ts).
const { loadRegistry } = await import(new URL("../packages/agentify/dist/registry-node.js", import.meta.url).href);
const registry = loadRegistry(join(REPO, "targets"));

/** Every first-class profile: the predicate asks whether **any** target's output changes. */
const TARGETS = ["agents-md", "claude-md", "claude-skills", "claude-commands", "mcp-manifest"];
/*
 * Applied to **both** sets, for different reasons.
 *
 * `dedup` (CORPUS §2.17) is the live grading set: its key claims one pair is one fact and
 * two are not, and §2.14.1 is the predicate those claims are claims *under*, so it must
 * agree with them. `clean`'s pairs are retired (§2.14.2) and are re-checked here because
 * retiring them was a conclusion this script produced — a retirement nothing re-derives is
 * a retirement nobody can find wrong later.
 */

const SETS = [
  { name: "dedup §2.17", dir: "fixtures/agentify/dedup", field: "nearDuplicates", expect: "oneFact" },
  { name: "dedup §2.17", dir: "fixtures/agentify/dedup", field: "mustNotMerge", expect: "differentFacts" },
  { name: "clean §2.14.2 (retired)", dir: "fixtures/agentify/clean", field: "retiredNearDuplicates", expect: "differentFacts" },
];

console.log("\n1. The predicate, applied to every pair a corpus key makes a claim about");

for (const set of SETS) {
const sources = await readSet(join(REPO, set.dir));
const key = JSON.parse(readFileSync(join(REPO, set.dir, "expected-units.json"), "utf8"));
for (const pair of key[set.field] ?? []) {
  /*
   * A pair the entity block removes cannot be measured here, and that is a property of the
   * pipeline rather than a defect in the pair.
   *
   * This script works by *forcing* the merge and diffing the output. `dedup.ts` skips a pair
   * whose two units carry different `entityKey`s before it builds a shortlist, so the forced
   * adjudicator is never called and the forced run is identical to the blocked one — which
   * this script correctly reports as "the predicate could not be applied". Excluding it is
   * not weakening the gate: `check-agentify.mjs` asserts separately that such a pair really
   * is blocked, and fails if it reaches the adjudicator after all.
   */
  if ((pair.blockedBy ?? "adjudicator") !== "adjudicator") {
    info(`skipped ${set.name}/${set.field}: "${(pair.a.text ?? "").slice(0, 30)}" is separated by the ${pair.blockedBy} block before any merge could be forced`);
    continue;
  }
  // The **first sentence** of each side, because that is the unit extraction produces.
  const firstSentence = (t) => (/^[^.!?]+[.!?]/.exec(t.trim())?.[0] ?? t).trim();
  const spec = { a: firstSentence(pair.a.text), b: firstSentence(pair.b.text) };

  const unmerged = await compileWith(sources, registry, TARGETS, spec, false);
  const merged = await compileWith(sources, registry, TARGETS, spec, true);

  // Everything the unmerged run emitted, per file, against the merged run.
  const unmergedText = new Map();
  for (const t of unmerged.results) for (const f of t.files) unmergedText.set(`${t.target}:${f.path}`, f.content);
  const mergedText = new Map();
  for (const t of merged.results) for (const f of t.files) mergedText.set(`${t.target}:${f.path}`, f.content);

  const changedFiles = [...unmergedText.keys()].filter((k) => unmergedText.get(k) !== (mergedText.get(k) ?? ""));

  if (changedFiles.length === 0) {
    // Nothing merged, so the predicate has nothing to measure. Almost always means the
    // shortlist or a category block stopped the pair before adjudication.
    fail(
      `"${spec.a}…" / "${spec.b}…": forcing the merge changed no output at all, so the pair ` +
        `never reached the merge stage and the predicate could not be applied`,
    );
    rows.push({ set: set.name, pair: spec, verdict: "unreachable" });
    continue;
  }

  // What content disappeared, across every profile, and whether the merged output still
  // carries it. `survivors` is the whole merged corpus text: a fact re-stated in another
  // unit is not dropped, and only checking the surviving unit would call it dropped.
  // Compared over **unit texts**, not whole rendered files.
  //
  // Whole files carry rendering artifacts — token counts in a budget line, section numbers,
  // a version string — and those are numbers, so the salience rule counted them as
  // qualifiers. Measured, the recall pair "dropped" the token `4`, which came from a count
  // that changed because the file got shorter. The predicate asks what a *reader* would no
  // longer know, and that is carried by the units, so the units are what is compared.
  // **Surviving units only.** `run.merges` carries the text that was folded away, which is
  // exactly the content whose disappearance is being measured — including it in the survivor
  // set made every pair look like it dropped nothing, and all four verdicts flipped to
  // "one fact" at once. A survivor set that contains the casualties measures nothing.
  const survivors = salient(merged.units.map((u) => u.text).join(" "));
  const droppedWords = new Set();
  for (const w of salient(unmerged.units.map((u) => u.text).join(" "))) {
    if (!survivors.has(w)) droppedWords.add(w);
  }

  const verdict = droppedWords.size === 0 ? "oneFact" : "differentFacts";
  rows.push({ set: set.name, pair: spec, verdict, expected: set.expect, dropped: [...droppedWords].sort(), files: changedFiles.length });
  if (verdict !== set.expect) {
    fail(
      `${set.name}/${set.field}: the key says ${set.expect} and the predicate says ${verdict} ` +
        `for "${spec.a.slice(0, 40)}…" / "${spec.b.slice(0, 40)}…"` +
        (droppedWords.size ? ` (drops ${[...droppedWords].sort().join(", ")})` : ""),
    );
  }

  info(
    `"${pair.a.text.slice(0, 44)}…"\n        vs "${pair.b.text.slice(0, 44)}…"\n` +
      `        → ${changedFiles.length} file(s) change; ` +
      (droppedWords.size === 0
        ? `nothing renderable is dropped → ONE FACT`
        : `drops ${[...droppedWords].sort().join(", ")} → DIFFERENT FACTS`),
  );
}
}

// ---------------------------------------------------------------- 2. corpus vs predicate
console.log("\n2. Do the corpus keys agree with the predicate?");

if (rows.some((r) => r.verdict === "unreachable")) {
  fail("at least one graded pair never reached the merge stage, so the predicate is untested for it");
}
const agreeing = rows.filter((r) => r.verdict === r.expected).length;
if (agreeing === rows.length && rows.length > 0) {
  ok(`all ${rows.length} graded pair(s) match their key under §2.14.1`);
}

// ---------------------------------------------------------------- 3. negative control
console.log("\n3. Negative control — the predicate must be able to say both things");
{
  // THE control that matters: a genuine restatement sharing almost no vocabulary.
  //
  // This is the case §10.4 exists for — both authored pairs score Jaccard 0.000 — and it
  // is the one an earlier implementation of this predicate got wrong. Comparing plain
  // content words, it called this pair different facts because `service`, `refuse`, and
  // `exceed` are absent from the second sentence. Every lexically-varied restatement would
  // have failed identically, so the predicate could only ever answer "different facts" for
  // exactly the pairs it exists to judge, and its verdict on the corpus would have been an
  // artifact rather than evidence. If this control ever regresses, the verdicts above mean
  // nothing.
  const restatedA = salient("The service must refuse any upload exceeding 64 MB.");
  const restatedB = salient("Uploads larger than 64 MB are rejected by the platform.");
  const droppedA = [...restatedA].filter((w) => !restatedB.has(w));
  if (droppedA.length === 0) {
    ok("a lexically-disjoint restatement is measured as ONE FACT — the predicate can say both things");
  } else {
    fail(
      `negative control: a genuine restatement was called different facts (drops ${droppedA.join(", ")}). ` +
        `Every verdict in section 1 is an artifact until this passes.`,
    );
  }

  // A qualifier that a merge would delete: the case the predicate exists to catch.
  const withQualifier = salient("Acknowledge within 2000 milliseconds at p95.");
  const withoutQualifier = salient("Acknowledge quickly.");
  const droppedB = [...withQualifier].filter((w) => !withoutQualifier.has(w));
  if (droppedB.length > 0) ok(`a dropped numeric qualifier is detected (${droppedB.join(", ")})`);
  else fail("negative control: dropping a numeric qualifier was not detected");

  // A dropped scope restriction, with the wording otherwise identical.
  const scoped = salient("Every batch must be rejected whole.");
  const unscoped = salient("A batch must be rejected.");
  const droppedC = [...scoped].filter((w) => !unscoped.has(w));
  if (droppedC.length > 0) ok(`a dropped scope restriction is detected (${droppedC.join(", ")})`);
  else fail("negative control: dropping a scope restriction was not detected");

  // And a pure reordering must stay one fact.
  const x = salient("The service must reject oversized batches.");
  const y = salient("Oversized batches must be rejected by the service.");
  const droppedD = [...x].filter((w) => !y.has(w));
  if (droppedD.length === 0) ok("a pure reordering is measured as one fact");
  else fail(`negative control: a pure reordering was called different facts (${droppedD.join(", ")})`);
}

if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, failures, rows }, null, 2));
else
  console.log(
    failures.length === 0
      ? `\nThe merge predicate is decidable and was applied to ${rows.length} graded pair(s).`
      : `\n${failures.length} merge-predicate check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
process.exit(failures.length === 0 ? 0 : 1);
