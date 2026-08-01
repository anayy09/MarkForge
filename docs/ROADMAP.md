# Roadmap — what is deferred, and why

Everything here was **promised somewhere and is not built**. It is on this page precisely so
that it can be taken out of the promises: `docs/STATUS.md` marks each of these `deferred`, and
`scripts/check-status-claims.mjs` fails a deferred row that does not point here. A capability
removed from the README and recorded nowhere is lost rather than deferred.

Nothing on this page is a commitment to a date. Each entry states what it would take.

## Deduplication by model adjudication (SPEC §10.4, ADR-0020)

**Disabled by default at 0.1.0. Behind `--dedup-adjudicate`.**

The deterministic half of §10.4 stays on: exact-text collapse, and the `entityKey` entity block
that separates two settings of one subsystem. Neither involves a model.

The adjudicated half — embedding shortlist, `strong` model decides — is off. The reason is one
measurement, `CORPUS.md` §2.17, the first grading set for this stage that was not contaminated
by the prompt that grades it:

| Arm | Result |
| --- | --- |
| Recall | 0 of 3 |
| Precision | 1 false merge of 2 adjudicated hard negatives |

The false merge collapsed *"A sealed document must **never** be re-issued under the same
reference"* with *"A sealed document must be re-issued under a fresh reference"*.

**The asymmetry is what decides it.** An unmerged near-duplicate produces redundancy, which is
a quality defect a reader can see and complain about. A wrong merge deletes a prohibition from
every generated file, and §10.6's traceability gate cannot catch it, because the surviving
sentence *is* supported by a source — the gate checks that nothing was invented, not that
nothing was dropped. With recall at 0 of 3 the stage also buys almost nothing when it works.

**The safety half is now solved; the blocker is recall.** `CORPUS.md` §2.14.1 was promoted from
a grading instrument to a **veto** inside `dedup.ts` on 2026-08-01: the adjudicator proposes and
the predicate refuses any merge that would drop a salient token. Measured, that took §2.17's
false merges from 1 to 0 and left recall at 0 of 3, and it blocked exactly the one bad merge
across 46 adjudicated pairs with zero false vetoes.

So the reason this stage stays off is no longer that it is dangerous. It is that **it does
nothing**: recall 0 of 3, and 3 of the 5 model/predicate disagreements are cases where the
predicate says one fact and the model refuses — a block-only veto cannot compel a merge. A
stage that is safe and merges nothing is not worth a flag being on by default.

**What would re-enable it:**

1. ~~Promote the predicate to a veto.~~ **Done 2026-08-01.** It closed the precision half and
   moved the blocker rather than removing it.
2. A prompt revision that raises recall, measured on a **fresh** uncontaminated set. §2.17
   cannot grade a fix made in response to §2.17, and `scripts/check-fixture-contamination.mjs`
   will fail the build if a new fixture repeats §2.16's mistake.
3. Failing that, accept that §10.4's embedding-plus-model design does not work on real text and
   say so in ADR-0020, which currently records it as the answer to a measurement rather than as
   something itself unmeasured until now.

## Third-party adapter loading

`@markforge/ir` is published so an adapter can be *written*. There is no loader, so one cannot
be *loaded*. `docs/decisions/PUBLISHING.md` records the decision and the reason: a loader has
to settle IR instance identity across the CLI's bundle boundary first, and this release has no
evidence to answer that. `scripts/check-docs.mjs` asserts both that the README says so and that
no adapter-loading flag or export exists, so the two cannot drift apart.

## ADR-0012's four unbuilt PDF clauses

Named in the ADR's Decision as though they shipped together, and enumerated clause by clause in
its own text since 2026-08-01. All four are real requirements from `SPEC.md` §3.3 and brief
§5.2, which is why they are deferred rather than withdrawn.

| Clause | What it needs |
| --- | --- |
| Header/footer detection routed to `furniture` | A cross-page repetition pass over y-bands (ADR-0002 already specifies the destination) |
| Ligature repair | A mapping pass beside the existing hyphenation repair |
| Figure and caption binding | Proximity plus caption-pattern matching over PDF geometry; the normaliser's `NORM_FIGURE_BOUND` does not run on glyph coordinates |
| Table recovery, confidence-gated | The largest: ruling-line detection, then whitespace-column alignment, then vision escalation. Currently a whitespace-aligned table is diagnosed as *possibly present* and emitted as prose |

## ADR-0007's four unbuilt tooling rows

Found by making the ADR gate test relevance rather than filename resolution.

| Row | State |
| --- | --- |
| `tsdown` as the build tool | **Deferred.** The build is `tsc -b` and the browser bundle is `esbuild`. `tsdown` was selected for ESM+CJS+dts output "because packages ship to npm"; under the B+ publishing decision one bundled CLI and one library ship, and neither needs it yet |
| ESLint + Prettier | **Deferred, and it is a real gap** — a 20-package TypeScript repository with no linter and no formatter. Deferred rather than done because adding either now would produce a diff across every file in the middle of a release, and because `tsc` strict plus review has carried it so far. The ADR no longer claims otherwise |
| `@changesets/cli` | **Gate 6 work, not deferred.** The release gate requires changesets or equivalent wired into CI, and this is a known-unbuilt dependency of it rather than a surprise |
| The suite running twice with the network blocked | **Deferred.** CI unsets `MODEL_API_KEY` on the jobs that touch the LLM path, which makes a network attempt fail rather than impossible, per-job rather than over the suite. The stronger form needs a sandbox the runner does not give for free |

## Reverse direction: agent files back to documents (SPEC §10.10)

A stated stretch from the start, with no corpus. Deferred: nothing in the repository promises
it, and building it without a corpus would produce a number nobody could check.

## Visual regression suite

Depends on ADR-0003. Snapshots of PDF output cannot exist before the PDF renderer does.

## Playwright against the browser build

ADR-0015's *Consequences* promise it. Today the bundle is evaluated in a `vm` context holding
only web-platform globals, which is a weaker check and is labelled as one wherever it is cited.
