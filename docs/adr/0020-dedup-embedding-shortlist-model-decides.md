# ADR-0020: The embedding shortlists near-duplicates; a model decides

- Status: **Accepted** — supersedes half of `OPEN_QUESTIONS.md` §7c, flagged for reversal in §7p
- Date: 2026-07-31
- Relates to: `SPEC.md` §10.4; brief §6.1, §7.1; `OPEN_QUESTIONS.md` §7c; ADR-0009

## Context

`OPEN_QUESTIONS.md` §7c made two claims when it added the `embed` role. The first held up
under measurement. The second did not.

**Claim one: a text threshold cannot merge these.** True, and the corpus proves it as a
number rather than an argument — both authored near-duplicate pairs in
`fixtures/agentify/clean/` score content-word Jaccard **0.000**, asserted on every run of
`scripts/build-agentify-corpus.mjs`. Nothing lexical reaches zero overlap.

**Claim two: cosine distance between embeddings can.** False on this corpus. Measured against
`nomic-embed-text-v1.5` through the NaviGator gateway:

| Pair | Cosine (no prefix) | With `clustering:` |
| --- | --- | --- |
| Authored pair 1 — the latency constraint, PRD against ADR | 0.6335 | 0.7782 |
| Authored pair 2 — whole-batch atomicity | 0.6183 | 0.7416 |
| **Decoy** — `NIMBUS_MAX_BATCH_MB=64` against `NIMBUS_BATCH_TIMEOUT_MS=30000` | **0.8201** | **0.9063** |
| **Decoy** — "retrievable for thirty days" against "rejected whole" | **0.7428** | **0.8648** |

Both decoys outrank both true pairs. There is no threshold that merges what should merge and
spares what should not; the ordering is wrong, so no cutoff fixes it. Nomic's documented task
prefixes lift every score and change nothing about the ranking, which rules out the obvious
"you used the model wrong" explanation.

The reason is not a deficient model. **Cosine over sentence embeddings measures topical
relatedness; deduplication needs semantic equivalence.** Two sentences about the same
subsystem sit near each other whether or not they assert the same thing, and a timeout and a
size cap are maximally topical and completely different facts.

Left as specified, §10.4 would have shipped one of two failures: a threshold high enough to be
safe and merge nothing, or one low enough to merge and silently delete real facts from every
generated file. The second is worse and is invisible — a merged unit looks exactly like a unit.

## Decision

**Pass 2 becomes two stages.** The embedding **shortlists**; a `strong` model **decides**.

1. **Structural block.** Two units carrying different non-empty `entityKey`s never pair. This
   is the same "same entity" notion §10.4 already uses for conflict detection, and it removes
   the strongest decoy — the two `NIMBUS_*` variables — on a principle rather than by tuning.
2. **Shortlist** by cosine within a category, default 0.72, capped per category. This is a
   recall control, not a verdict; being generous costs a call and being wrong costs a fact.
3. **Adjudicate** each shortlisted pair with `judgeUnitEquivalence`, bound to
   `context-unit-summarization` → `strong`. Permitted by brief §7.1, which names "context-unit
   extraction and summarization"; the question asked is which single unit two units collapse
   into.
4. **No adjudicator, no merge.** Under `--no-llm` the embedding pass does not run at all, and
   with an embedder but no adjudicator, close pairs are reported and left separate.

The schema is the guarantee, as everywhere else in `@markforge/llm`: the model answers
`surviving: "A" | "B"` and the code maps that back to verbatim text. A merged unit's wording
is always one of its two inputs byte for byte.

**Measured result on the clean corpus:** 19 pairs adjudicated, 0 unparseable, 1 merge. Pair 2
merges. Pair 1 does not, and the model's reason is sound — *"Statement A defines a p95 latency
target, while Statement B imposes a hard maximum wait; they describe different guarantees."* A
p95 budget of 2000 ms permits 5% of requests to exceed two seconds, which "no user should ever
wait more than two seconds" forbids. The answer key calls them near-duplicates; on the text the
extractor actually produces, they are not, and the pipeline is right to keep them apart.
Neither decoy merged. So: **1 of 2 authored pairs, 0 false merges.**

## Rejected alternatives

**Tune the threshold.** The first thing tried, and impossible: the decoys rank *above* the
true pairs, so every cutoff either merges both or neither. Ordering cannot be fixed by a
scalar.

**Use the documented task prefixes and keep the threshold.** Worth doing on its own merits —
`clustering:` is now applied, and it raises the true pairs from 0.63/0.62 to 0.78/0.74 — but it
lifts the decoys by as much and leaves the ranking identical. Kept for recall, rejected as a
fix.

**A different embedding model.** Possibly better, unmeasured, and beside the point: the failure
is a property of what cosine measures, not of one model's quality. It would also mean choosing
a model on one corpus of ten documents, which is how a benchmark gets overfitted.

**Adjudicate every pair and drop the embedding entirely.** Correct and quadratic. On the clean
set that is 24 units → 276 calls instead of 19, and the shortlist costs one embedding call per
category. The embedding earns its place as a filter even though it cannot be a decider.

**Constrain `survivingText` to an enum of the two full sentences**, which is the obvious way to
make the schema guarantee verbatim text. Rejected after measurement: it is a pathological
guided-decoding grammar. The sampler must reproduce a ~150-character string exactly, and when
the model's preferred continuation diverges it can only emit whitespace — **41 of 50
adjudications died that way, each having burned a 3000-token ceiling**. The two-letter enum
gives an identical guarantee with a grammar the model can satisfy, at a median of 153
completion tokens.

**Give up and leave dedup text-only.** Rejected: it would leave the `embed` role, the model
binding, and the corpus's whole near-duplicate premise as machinery with no working consumer,
and OPEN_QUESTIONS §7c paid for that role up front specifically to avoid a Phase 4 retrofit.

## Consequences

- Deduplication now costs *n* embedding calls plus one adjudication per shortlisted pair. On
  the clean corpus: 5 embedding batches and 19 adjudications, all cached and committed at
  324 KB across 48 entries.
- The committed cache makes it offline-reproducible: two `readOnly` runs with no key present
  produce byte-identical output, and the `--llm` result differs from `--no-llm` by exactly the
  merged line. Both are CI jobs.
- `agentify.dedupeThreshold` changes meaning. It was a merge decision; it is now a shortlist
  cutoff, and its default drops from 0.9 to 0.72. A configuration written against the old
  meaning becomes more generous rather than less, which is the safe direction — it widens what
  gets asked about, and the model still decides.
- An adjudication that fails leaves the pair unmerged and diagnosed. Failing safe here means
  duplicating, not deleting.
- The general lesson is worth more than the mechanism: **an embedding is a retrieval tool, and
  a decision that deletes data should not be made by a distance.**
