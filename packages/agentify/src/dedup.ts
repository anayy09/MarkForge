/**
 * Deduplication — SPEC §10.4.
 *
 * Two passes, in this order, because they are good at different things and the cheap one
 * is not a weaker version of the expensive one:
 *
 *   1. **Normalized text.** Catches exact and near-exact restatement. Free, offline, and
 *      the only pass that runs under `--no-llm`.
 *   2. **Embedding shortlist, then model adjudication.** Catches the same fact written by two
 *      people who shared no vocabulary. Needs a model, so it runs only when one is supplied.
 *
 * OPEN_QUESTIONS §7c reversed this design from a text threshold to embeddings, and the
 * corpus exists to keep that reversal honest rather than merely argued: both near-duplicate
 * pairs in `fixtures/agentify/clean/` score **content-word Jaccard 0.000**, asserted on every
 * run of `scripts/build-agentify-corpus.mjs`. At zero overlap no lexical threshold can merge
 * them at any setting. That much held up.
 *
 * **What did not hold up is the other half of §7c: that cosine distance could then make the
 * decision.** Measured against `nomic-embed-text-v1.5`, the two authored near-duplicate pairs
 * score 0.63 and 0.62 — and the highest-scoring pair in the entire clean set is
 * `NIMBUS_MAX_BATCH_MB=64` against `NIMBUS_BATCH_TIMEOUT_MS=30000` at **0.82**, two unrelated
 * variables. "Every rejected batch must be retrievable for thirty days" against "A batch that
 * fails validation must be rejected whole" scores 0.74. The true pairs rank *below* several
 * false ones, so no threshold separates them; the documented task prefixes (`clustering:`,
 * `search_document:`) raise every score and leave the ordering unchanged.
 *
 * The reason is not a bad model. Cosine over sentence embeddings measures topical
 * relatedness, and deduplication needs semantic equivalence — two sentences about the same
 * subsystem are near each other whether or not they say the same thing. So pass 2 is now two
 * stages: the embedding **shortlists** candidates, and a `strong` model **decides**, with the
 * surviving text constrained by schema to be one of the two inputs verbatim. Recorded in
 * ADR-0020 and measured in docs/AGENTIFY.md.
 *
 * **Provenance is additive, never replaced** (§10.4). A merged unit keeps every source
 * reference from both sides. This is why `unitContentHash` deliberately excludes `sources`:
 * gaining a source must not look like a content change to §10.8's incremental diff, or every
 * merge would rewrite a region that did not change.
 *
 * **Blocking by category is not an optimisation.** Merging a `command` into a `constraint`
 * would be a claim about meaning that this stage has no basis for, so units only ever merge
 * within a category — which also keeps the number of embedding calls proportional to the
 * largest category rather than to the square of the corpus.
 */
import { DiagnosticCode, type DiagnosticBag } from "@markforge/ir";

/** Shortlisted pairs adjudicated per category before the cap bites. */
const DEFAULT_MAX_PAIRS = 24;
import { normalizeUnitText, type ContextUnit, type UnitCategory } from "./units.js";
import { mergeVerdict } from "./merge-predicate.js";

/**
 * Embeds a batch of strings, returning one vector per input in the same order.
 *
 * Injected rather than imported. `@markforge/agentify` must not depend on `@markforge/llm`
 * for the same two reasons `@markforge/core` must not (ADR-0015 browser compatibility, and
 * ADR-0009's rule being enforceable only if the import does not exist) — so the CLI
 * composes this from a session and hands it in, and its absence is `--no-llm`.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * Decides whether a shortlisted pair states one fact, and which wording survives.
 *
 * Injected for the same reason `Embedder` is. Returning `undefined` means the call failed
 * and the pair stays unmerged — an adjudicator that cannot answer must not merge.
 */
export type Adjudicator = (pair: {
  a: ContextUnit;
  b: ContextUnit;
}) => Promise<{ sameFact: boolean; survivingText: string } | undefined>;

export interface DedupOptions {
  /**
   * Cosine at or above which a pair is *worth asking about*. Not a merge decision.
   *
   * It was a merge decision until it was measured. See this module's header: on the clean
   * corpus the highest-scoring pair of all was two unrelated environment variables, and the
   * two authored near-duplicates ranked below several non-duplicates, so no value of this
   * number both merges the true pairs and spares the decoys. It now controls recall into
   * the adjudication stage, where being generous is cheap and being wrong is not.
   */
  threshold: number;
  embed?: Embedder;
  adjudicate?: Adjudicator;
  /** Cap on shortlisted pairs per category, so a large corpus cannot fan out unboundedly. */
  maxPairsPerCategory?: number;
  /**
   * Whether CORPUS §2.14.1's predicate may veto a merge the adjudicator proposed. Default true.
   *
   * The **only** legitimate `false` is a counterfactual measurement.
   * `scripts/check-merge-predicate.mjs` exists to answer "if these two merged, what would the
   * output lose?", which it does by forcing the merge and diffing the emitted files — and a
   * veto that prevents merges necessarily prevents that. Measured: turning the veto on made
   * every graded pair report "forcing the merge changed no output", which the script correctly
   * read as the predicate being untestable.
   *
   * It is a named option rather than an internal flag so that anyone passing `false` has to
   * write down that they are asking a counterfactual. Nothing in `@markforge/cli` sets it.
   */
  enforcePredicate?: boolean;
}

export interface DedupResult {
  units: ContextUnit[];
  merges: {
    survivingId: string;
    mergedId: string;
    method: "text" | "embedding";
    similarity: number;
    text: string;
  }[];
}

export async function deduplicate(
  input: ContextUnit[],
  options: DedupOptions,
  diagnostics: DiagnosticBag,
): Promise<DedupResult> {
  const merges: DedupResult["merges"] = [];

  // --- Pass 1: exact restatement, by normalized text.
  const byText = new Map<string, ContextUnit>();
  const afterText: ContextUnit[] = [];
  for (const unit of input) {
    const key = `${unit.category} ${normalizeUnitText(unit.text)}`;
    const existing = byText.get(key);
    if (existing) {
      mergeInto(existing, unit);
      merges.push({
        survivingId: existing.id,
        mergedId: unit.id,
        method: "text",
        similarity: 1,
        text: unit.text,
      });
      continue;
    }
    byText.set(key, unit);
    afterText.push(unit);
  }

  if (!options.embed) {
    report(merges, diagnostics, false);
    return { units: afterText, merges };
  }

  // --- Pass 2: same fact, different words.
  const groups = new Map<UnitCategory, ContextUnit[]>();
  for (const unit of afterText) {
    const bucket = groups.get(unit.category);
    if (bucket) bucket.push(unit);
    else groups.set(unit.category, [unit]);
  }

  /*
   * Every unit's vector, kept so the cost of the category block can be counted.
   *
   * §10.4 blocks cross-category merges and that block is not being loosened — a wrong merge
   * deletes a fact silently and a wrong refusal only leaves a duplicate. But until now the
   * block was also *invisible*: a pair it separated looked exactly like a pair the model
   * considered and rejected. CORPUS §2.17 was authored, measured, and reported a clean 3/3
   * precision score before anyone noticed that all six of its graded pairs had been
   * separated here and never compared at all.
   *
   * So the block now reports what it declined to look at. Not lossy: nothing was deleted,
   * and a duplicate surviving twice is the safe direction. It is an `info` because the
   * number is the point — OPEN_QUESTIONS §9 is the question of what to do about it, and that
   * question needs a count rather than an anecdote.
   *
   * Vectors are collected only from categories that were embedded anyway — those holding two
   * or more units. A category with exactly one unit is not embedded, because doing so would
   * add a model call and a cache entry purely to report a number, and the shape this exists
   * to catch is a whole document's worth of sentences landing in one category rather than a
   * lone straggler.
   */
  const embedded: { unit: ContextUnit; vector: number[] }[] = [];

  const absorbed = new Set<string>();
  for (const [category, bucket] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (bucket.length < 2) continue;
    // One call per category, inputs in the bucket's own order, so the cache key is stable
    // across runs. Batching per category rather than per pair is what keeps the committed
    // cache small enough to review in a diff.
    const vectors = await options.embed(bucket.map((u) => embeddingTextOf(u)));
    if (vectors.length !== bucket.length) {
      throw new Error(
        `agentify: the embedder returned ${vectors.length} vectors for ${bucket.length} ` +
          `${category} units. Merging on a misaligned batch would attach one unit's ` +
          `provenance to another's text, so this refuses rather than guessing.`,
      );
    }
    for (let i = 0; i < bucket.length; i++) embedded.push({ unit: bucket[i]!, vector: vectors[i]! });

    // Step 2a: shortlist by cosine, highest first.
    const shortlist: { i: number; j: number; similarity: number }[] = [];
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        // Two units that name *different* entities are about different things by
        // definition, whatever the geometry says. This is the same "same entity" notion
        // §10.4 uses for conflict detection, and it removes the corpus's strongest decoy —
        // two unrelated NIMBUS_* variables at cosine 0.82 — on a principle rather than by
        // tuning a number.
        if (a.entityKey !== undefined && b.entityKey !== undefined && a.entityKey !== b.entityKey) {
          continue;
        }
        const similarity = cosine(vectors[i]!, vectors[j]!);
        if (similarity < options.threshold) continue;
        shortlist.push({ i, j, similarity });
      }
    }
    shortlist.sort((x, y) => y.similarity - x.similarity);
    const capped = shortlist.slice(0, options.maxPairsPerCategory ?? DEFAULT_MAX_PAIRS);
    if (shortlist.length > capped.length) {
      diagnostics.info(
        DiagnosticCode.AGENTIFY_UNITS_MERGED,
        `agentify: ${shortlist.length} ${category} pairs cleared the shortlist threshold and ` +
          `only the ${capped.length} closest were adjudicated. Raise ` +
          `agentify.maxPairsPerCategory if duplicates are being missed.`,
      );
    }

    // Step 2b: the model decides. With no adjudicator, nothing merges here — a cosine
    // score is not a merge decision and pretending otherwise is what the measurement
    // refuted.
    for (const { i, j, similarity } of capped) {
      const a = bucket[i]!;
      const b = bucket[j]!;
      if (absorbed.has(a.id) || absorbed.has(b.id)) continue;
      if (!options.adjudicate) continue;

      const verdict = await options.adjudicate({ a, b });
      if (!verdict || !verdict.sameFact) continue;

      /*
       * The adjudicator proposes; §2.14.1's predicate decides.
       *
       * A model cannot talk its way past this. It merged *"A sealed document must **never** be
       * re-issued under the same reference"* with *"A sealed document must be re-issued under a
       * fresh reference"* — a prohibition and its opposite — reasoning "Keeping A would drop
       * nothing", and §10.6's traceability gate could not catch it because the surviving
       * sentence is genuinely supported by a source. A gate that checks nothing was invented
       * has nothing to say about something being dropped.
       *
       * Measured over 46 pairs that reached the adjudicator across both graded sets: a
       * definite verdict on 93.5%, agreement with the model on 38, and of the merges the
       * model proposed it blocks exactly the one that was wrong, with zero false vetoes.
       */
      const predicate = options.enforcePredicate === false
        ? { decision: "allow" as const, abstained: false, dropped: [] }
        : mergeVerdict(a.text, b.text);
      if (predicate.decision === "block") {
        // `info`, not `lossy`. Nothing was lost: refusing a merge leaves a duplicate, which is
        // the safe direction and is what `--no-llm` produces anyway. Marking it lossy would
        // make `--strict` fail on the gate working correctly.
        diagnostics.info(
          DiagnosticCode.AGENTIFY_MERGE_VETOED,
          `agentify: the adjudicator called two ${category} units one fact and CORPUS §2.14.1 ` +
            `refused the merge — it would drop ${predicate.dropped.join(", ")}, which some ` +
            `target profile renders. The units stay separate. "${a.text.slice(0, 60)}" against ` +
            `"${b.text.slice(0, 60)}".`,
        );
        continue;
      }

      // The adjudicator names the surviving wording; `mergeInto` otherwise picks by
      // authority. Aligning them here means the model's choice is honoured without
      // `mergeInto` needing to know a model exists.
      const [keep, drop] = verdict.survivingText === b.text ? [b, a] : [a, b];
      mergeInto(keep, drop);
      absorbed.add(drop.id);
      merges.push({
        survivingId: keep.id,
        mergedId: drop.id,
        method: "embedding",
        similarity,
        text: drop.text,
      });
    }

    if (capped.length > 0 && !options.adjudicate) {
      diagnostics.info(
        DiagnosticCode.AGENTIFY_UNITS_MERGED,
        `agentify: ${capped.length} ${category} pair(s) were close enough to be candidates but ` +
          `no adjudicator was supplied, so none were merged. Cosine alone cannot make this ` +
          `call on real text — see docs/AGENTIFY.md.`,
      );
    }
  }

  reportCrossCategoryBlocks(embedded, absorbed, options.threshold, diagnostics);
  report(merges, diagnostics, true);
  return { units: afterText.filter((u) => !absorbed.has(u.id)), merges };
}

/**
 * Count the pairs the category block refused to look at that everything else would have
 * shortlisted, and say so.
 *
 * The predicate is deliberately the *same* one the shortlist uses — cosine at or above the
 * configured threshold, and no conflicting `entityKey` — with the category equality removed.
 * Anything it reports is a pair that differed from an adjudicated pair in exactly one
 * respect, so the number means "this is what the block cost on this input" rather than "here
 * are some units that resemble each other".
 */
function reportCrossCategoryBlocks(
  embedded: { unit: ContextUnit; vector: number[] }[],
  absorbed: Set<string>,
  threshold: number,
  diagnostics: DiagnosticBag,
): void {
  const live = embedded.filter((e) => !absorbed.has(e.unit.id));
  const blocked: { a: ContextUnit; b: ContextUnit; similarity: number }[] = [];

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.unit.category === b.unit.category) continue;
      if (
        a.unit.entityKey !== undefined &&
        b.unit.entityKey !== undefined &&
        a.unit.entityKey !== b.unit.entityKey
      ) {
        continue;
      }
      const similarity = cosine(a.vector, b.vector);
      if (similarity < threshold) continue;
      blocked.push({ a: a.unit, b: b.unit, similarity });
    }
  }
  if (blocked.length === 0) return;

  blocked.sort((x, y) => y.similarity - x.similarity);
  const shown = blocked.slice(0, 3);
  diagnostics.info(
    DiagnosticCode.AGENTIFY_CROSS_CATEGORY_BLOCKED,
    `agentify: ${blocked.length} pair(s) cleared the shortlist threshold and were separated ` +
      `by category alone, so the adjudicator never saw them. Nothing was lost — an unmerged ` +
      `duplicate survives twice — but this is where §10.4 declines to look, and a document ` +
      `whose role routes all of its sentences to one category can disappear into it entirely ` +
      `(OPEN_QUESTIONS §9). Closest: ` +
      shown
        .map(
          (p) =>
            `${p.similarity.toFixed(3)} ${p.a.category}/${p.b.category} ` +
            `"${p.a.text.slice(0, 40)}" vs "${p.b.text.slice(0, 40)}"`,
        )
        .join("; "),
  );
}

/**
 * What gets embedded for a unit.
 *
 * The text alone, not the category or the rationale. Including the category would push
 * every unit in a bucket together — they already share it — and including the rationale
 * would let two decisions with similar justifications merge despite deciding different
 * things.
 */
function embeddingTextOf(unit: ContextUnit): string {
  return unit.text;
}

/**
 * Folds `from` into `into`, keeping the better-attested text.
 *
 * The surviving text is the one from the higher-authority source, which is a stated
 * preference in §10.4 for *ordering*; used here it decides phrasing only, and both sources
 * remain attached either way, so nothing is lost by the choice.
 */
function mergeInto(into: ContextUnit, from: ContextUnit): void {
  const fromIsBetter =
    from.authority > into.authority ||
    (from.authority === into.authority && from.confidence > into.confidence);
  if (fromIsBetter) {
    into.text = from.text;
    if (from.rationale !== undefined) into.rationale = from.rationale;
    // The id and hash follow the text, so the surviving unit is addressable by what it
    // now says rather than by what it used to say.
    into.id = from.id;
    into.contentHash = from.contentHash;
  } else if (into.rationale === undefined && from.rationale !== undefined) {
    // A merge should never lose a rationale: a decision that arrives without one and gains
    // one from its twin is strictly better attested than either was alone.
    into.rationale = from.rationale;
  }

  const seen = new Set(into.sources.map((s) => `${s.path} ${s.order}`));
  for (const source of from.sources) {
    const key = `${source.path} ${source.order}`;
    if (!seen.has(key)) {
      into.sources.push(source);
      seen.add(key);
    }
  }
  into.sources.sort((a, b) => (a.path === b.path ? a.order - b.order : a.path < b.path ? -1 : 1));
  into.confidence = Math.max(into.confidence, from.confidence);
  into.authority = Math.max(into.authority, from.authority);
  if (into.entityKey === undefined && from.entityKey !== undefined) into.entityKey = from.entityKey;
}

function report(merges: DedupResult["merges"], diagnostics: DiagnosticBag, embedded: boolean): void {
  if (merges.length === 0) return;
  const byMethod = merges.filter((m) => m.method === "embedding").length;
  diagnostics.info(
    DiagnosticCode.AGENTIFY_UNITS_MERGED,
    `agentify: merged ${merges.length} duplicate context unit(s) — ` +
      `${merges.length - byMethod} by exact restatement` +
      (embedded
        ? ` and ${byMethod} by embedding similarity.`
        : `. No embedder was supplied, so units restating the same fact in different words ` +
          `were kept separate (SPEC §10.4). Pass --llm to merge them.`),
  );
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`agentify: cannot compare embeddings of length ${a.length} and ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
