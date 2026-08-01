/**
 * `CORPUS.md` §2.14.1's merge predicate, as a **veto** on the adjudicator rather than only as
 * a grading instrument.
 *
 * ## Why this moved into the pipeline
 *
 * The predicate was written to grade §10.4 and it caught the adjudicator merging a rule with
 * its own negation: *"A sealed document must never be re-issued under the same reference"*
 * with *"A sealed document must be re-issued under a fresh reference"*, on the model's
 * reasoning that *"Keeping A would drop nothing."* Merging deletes the prohibition from every
 * generated file, and §10.6's traceability gate cannot catch it — the surviving sentence *is*
 * supported by a source, so the gate that checks nothing was invented has nothing to say
 * about something being dropped.
 *
 * Detecting that afterwards is worth less than preventing it. Measured over **46 pairs that
 * reached the adjudicator** across both graded fixture sets:
 *
 *   - a **definite verdict on 43 (93.5%)**; it abstains only when neither side carries a
 *     single salient token,
 *   - it agrees with the model on 38,
 *   - and of the merges the model proposed, it blocks **exactly the one that was wrong**,
 *     with **zero** false vetoes.
 *
 * So the adjudicator proposes and this decides. A model cannot talk its way past it.
 *
 * ## Why it is legitimate to use it this way
 *
 * The predicate reads **unit text**, which `extractUnits` produced by rule with no model
 * involved — `compile` calls it as `extractUnits(resolved, diagnostics)`, with no `assist`
 * parameter, and `context-unit-extraction` is unwired. If that ever changes, this stops being
 * an independent oracle and becomes a second reading of the same model's output, and the
 * measurement above stops meaning anything. That is the one precondition worth re-checking
 * before trusting these numbers again.
 *
 * ## `differentFacts` is sound on the cases measured, not by construction
 *
 * A later reader must not promote this to a proof. `differentFacts` is only as sound as
 * salience extraction is at finding the thing that would be dropped: the verdict means "a
 * salient token is present on one side and absent from the other", and a difference living
 * entirely outside the salient vocabulary is invisible to it. Measured, it got every case in
 * both graded sets right — that is evidence, not a guarantee, and the guarantee does not
 * follow from the code.
 *
 * The converse is worse and is the reason `allow` is not a positive verdict.
 * **`oneFact` means "no evidence of loss under my salience extraction"** — an
 * absence-of-evidence result wearing a positive one's clothing. Measured, it called *"We
 * accept batches into a durable queue and acknowledge before processing"* and *"Customers
 * register a schema before their first submission"* one fact, because their only shared
 * salient token is `before` and nothing else about either is salient. They are unrelated.
 *
 * So: `block` may be trusted on the evidence available, `allow` may never be read as
 * agreement, and neither is a theorem. `packages/agentify/test/agentify.test.ts` asserts the
 * false positive above so it cannot be forgotten.
 *
 * ## What it deliberately cannot do
 *
 * It only ever **blocks**. It cannot force a merge the adjudicator declined, so it does
 * nothing for §10.4's recall, which is 0 of 3 on unseen pairs. It closes the direction where
 * being wrong is invisible and leaves the direction where being wrong is merely redundant.
 */

/**
 * Scope and quantifier words: the ones whose removal changes what a rule *covers*.
 *
 * A closed list on purpose. `any` and `each` are deliberately absent — as a determiner before
 * a generic plural, `any` adds no coverage the plural did not already have, and including it
 * turned a genuine restatement ("refuse **any** upload exceeding 64 MB" against "Uploads
 * larger than 64 MB are rejected") into a false negative on the strength of a bare determiner.
 */
const SCOPE = new Set(
  ("whole partial all every only never always least most more fewer less greater per " +
    "before after during unless except including excluding maximum minimum").split(" "),
);

/** Number words, so "two seconds" and "2 seconds" are one qualifier. */
const NUMBER_WORDS = new Map(
  Object.entries({
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
    nine: "9", ten: "10", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", sixty: "60",
    ninety: "90", hundred: "100", thousand: "1000",
  }),
);

const UNIT =
  /^(ms|millisecond|second|minute|hour|day|week|month|year|byte|kb|mb|gb|tb|percent|pct)$/;

/** Crude suffix stripping, so `committed`/`commit` and `batches`/`batch` compare equal. */
function stem(word: string): string {
  return word
    .replace(/(ies)$/, "y")
    .replace(/(ted|ping|ning|ded)$/, "")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/(t)$/, "");
}

/**
 * The **salient** tokens of a text: numbers, units, identifiers, and scope words.
 *
 * Synonyms are excluded on purpose, and this is the part that took a measurement to get
 * right. Comparing plain content words called a genuine restatement *different facts*,
 * because `service`, `refuse`, and `exceed` were absent from the other side — so every
 * lexically-varied restatement failed, which is exactly the case §10.4 exists for. A
 * predicate that can only answer "different facts" for the pairs it judges is not
 * conservative, it is vacuous.
 *
 * A restatement gets to vary `refuse`/`reject` freely. It does not get to vary `64`, `mb`,
 * `p95`, `NIMBUS_MAX_BATCH_MB`, or `never`.
 */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_.\- ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-]+/, "").replace(/[.\-]+$/, ""))
    .filter(Boolean);

  for (const raw of tokens) {
    // Identifiers: an underscore or a digit anywhere makes it a name, not a word.
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
    if (UNIT.test(stemmed)) out.add(stemmed);
  }
  return out;
}

export interface MergeVerdict {
  /** `block` when merging would drop something renderable. `allow` otherwise. */
  decision: "allow" | "block";
  /** True when neither side carries a salient token, so the predicate had no basis. */
  abstained: boolean;
  /** Salient tokens present on one side and absent from the other, sorted. */
  dropped: string[];
}

/**
 * Would merging these two texts drop anything renderable?
 *
 * Symmetric on purpose. Which side the adjudicator chose to keep is its decision, and the
 * predicate's question is whether *either* side carries something the other does not — a
 * merge discards one wording whichever way round it is recorded.
 *
 * Abstention is reported rather than hidden: with no salient token on either side, "drops
 * nothing" is true and meaningless, and a caller that wants to be strict about the stage as a
 * whole should be able to tell that case from a real allowance.
 */
export function mergeVerdict(textA: string, textB: string): MergeVerdict {
  const a = salientTokens(textA);
  const b = salientTokens(textB);
  if (a.size === 0 && b.size === 0) {
    return { decision: "allow", abstained: true, dropped: [] };
  }
  const dropped = [...new Set([...a].filter((t) => !b.has(t)).concat([...b].filter((t) => !a.has(t))))].sort();
  return { decision: dropped.length > 0 ? "block" : "allow", abstained: false, dropped };
}
