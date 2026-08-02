# Roadmap — what is deferred, and why

Everything here was **promised somewhere and is not built**. It is on this page precisely so
that it can be taken out of the promises: `docs/STATUS.md` marks each of these `deferred` or
`struck`, and `scripts/check-status-claims.mjs` fails a deferred row that does not point here.
A capability removed from the README and recorded nowhere is lost rather than deferred.

As of the 2026-08-02 closing audit, `docs/STATUS.md` carries **no `deferred` rows at all**:
every one was either finished or struck with a numbered ruling. What remains on this page is
therefore either struck-with-a-route-back, or tooling that was never in the shipped surface.

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

## Four IR node types no adapter produces (SPEC §2.3)

Found 2026-08-01 by `scripts/check-node-type-coverage.mjs` on its first run, and it is worth
recording *how*, because the whole point of that gate is that nothing else could have.
`docs/FIDELITY.md`'s node-type census diffs input IR against round-tripped IR, so a type that
never reaches the IR at all is absent from **both** sides, differences to zero, and scores as
**agreement**. All four below read `0 → 0` and looked clean.

| Type | SPEC says it comes from | State | What it needs |
| --- | --- | --- | --- |
| `equationBlock` | §2.3: DOCX OMML, PDF math, MD `$$` | No producer. MD `$$` yields mdast `math`, not `equationBlock`; DOCX OMML reached the phrasing walk's silent `default` until it was fixed and now yields `unknown` | An OMML→`equationBlock` mapping in the DOCX adapter, and the same from the PDF math path |
| `comment` | §2.3 and §3.1: DOCX comments with anchor ranges | No producer. `commentRangeStart`/`End`/`Reference` sit in the DOCX adapter's `PROPERTY_ELEMENTS`, so they are dropped as non-content with no diagnostic | Read `comments.xml`, and stop treating the anchor markers as properties |
| `citation` | §2.3: Pandoc `[@key]`, DOCX citation fields. §3.1 lists citation fields under "Also extracted" | No producer, and **no code anywhere mentions it** | A field-code path in the DOCX adapter and a `[@key]` extension on the Markdown side |
| `textBox` | §2.3 and §3.1: DOCX `wps:txbx`/`v:textbox`, PPTX shapes | No producer, and **no code anywhere mentions it** | `wps:txbx` handling in the DOCX adapter; the PPTX adapter maps shapes to other types today |

The last two are the sharper finding: `SPEC.md` §3.1 lists text boxes and citation fields under
*"Also extracted"*, and neither string appears in any adapter source. That is a specification
describing behaviour that does not exist, which is the class `docs/LIMITS.md` and the W9 sweep
exist to catch — arrived at by a gate rather than by a reading.

`check-node-type-coverage.mjs` gates these **on regression rather than on value**: a fifth
uncovered type fails immediately, and any of these four becoming covered fails as stale until
it is removed from the list. Same posture as the classification holdout, for the same reason —
a bar set at today's number stops it getting worse without implying it is acceptable.

## Struck in Phase 6, and what each would take

These are not deferred in the "someone will get to it" sense. Each was ruled on, each ruling
names what was lost, and each is here so the capability is visible rather than forgotten.

| Struck | Ruling | What it would take |
| --- | --- | --- |
| `CORPUS.md` §2.6 multi-column PDFs | §7ac | A generator producing a real two- or three-column PDF **with a text layer** — the scanned-fixture generator writes rasters, so this is a different tool. Then a fidelity row for reading order |
| `CORPUS.md` §2.8 slide decks | §7ac | A PPTX generator, comparable in size to the DOCX one in `build-corpus-fixtures.mjs` |
| `CORPUS.md` §2.9 spreadsheets | §7ac | An XLSX generator, plus a decision about how formula-versus-result is asserted |
| Visual regression | §7ad | For PDF: rasterise via pdfium and compare against approved PNGs with a perceptual threshold — reachable now that `render-pdf` exists and its output is byte-stable. For DOCX: a LibreOffice container, isolated per brief §13, degrading loudly when absent |
| `SPEC.md` §10.10 reverse direction | §7ae | A corpus first. Repository-derived units graded against an authored key, the same discipline §2.14 used for documents |
| `citation` and `textBox` node types | §7ab | A field-code parser and a bibliography model for the first; floating-shape anchor semantics and a reading-order decision for the second |

## Third-party adapter loading

`@markforge/ir` is published so an adapter can be *written*. There is no loader, so one cannot
be *loaded*. `docs/decisions/PUBLISHING.md` records the decision and the reason: a loader has
to settle IR instance identity across the CLI's bundle boundary first, and this release has no
evidence to answer that. `scripts/check-docs.mjs` asserts both that the README says so and that
no adapter-loading flag or export exists, so the two cannot drift apart.

## ADR-0012's two remaining PDF clauses

Named in the ADR's Decision as though all four shipped together. **Two are now built** —
ligature repair (`expandLigatures`) and header/footer detection routed to `furniture`
(`detectFurniture`, by cross-page repetition with digits masked so `Page 3 of 12` and
`Page 4 of 12` are one running footer). **Two are struck** (§7af), not deferred, and appear in
the struck table above: both need `CORPUS.md` §2.6, itself struck.

| Clause | State | What it would take |
| --- | --- | --- |
| Figure and caption binding | **Struck** (§7af) | §2.6 first, then proximity plus caption-pattern matching over PDF geometry; the normaliser's `NORM_FIGURE_BOUND` runs on IR shape, not glyph coordinates |
| Table recovery, confidence-gated | **Struck** (§7af) | §2.6 first, then ruling-line detection, whitespace-column alignment, and vision escalation. Today a whitespace-aligned table is diagnosed as *possibly present* and emitted as prose |

## ADR-0007's four unbuilt tooling rows

Found by making the ADR gate test relevance rather than filename resolution.

| Row | State |
| --- | --- |
| `tsdown` as the build tool | **Deferred.** The build is `tsc -b` and the browser bundle is `esbuild`. `tsdown` was selected for ESM+CJS+dts output "because packages ship to npm"; under the B+ publishing decision one bundled CLI and one library ship, and neither needs it yet |
| ESLint + Prettier | **Deferred, and it is a real gap** — a 20-package TypeScript repository with no linter and no formatter. Deferred rather than done because adding either now would produce a diff across every file in the middle of a release, and because `tsc` strict plus review has carried it so far. The ADR no longer claims otherwise |
| `@changesets/cli` | **Gate 6 work, not deferred.** The release gate requires changesets or equivalent wired into CI, and this is a known-unbuilt dependency of it rather than a surprise |
| The suite running twice with the network blocked | **Deferred.** CI unsets `MODEL_API_KEY` on the jobs that touch the LLM path, which makes a network attempt fail rather than impossible, per-job rather than over the suite. The stronger form needs a sandbox the runner does not give for free |

## Struck, and listed above rather than here

Three entries used to sit at the foot of this page as deferred work. Each was ruled on in
Phase 6 and now appears in **Struck in Phase 6** above, with what it would take:

- **Reverse direction, agent files back to documents (§10.10)** — struck by §7ae. A stretch
  that survived five phases with no corpus is declined rather than carried.
- **Visual regression** — struck by §7ad. `render-pdf` now exists and its output is
  byte-stable, so the PDF half is reachable; the DOCX half needs a LibreOffice container.
- **Model-adjudicated dedup (§10.4)** — struck by §7ap, and described in full at the top of
  this page. The flag stays, off.

## Playwright against the browser build

ADR-0015's *Consequences* promise it. Today the bundle is evaluated in a `vm` context holding
only web-platform globals, which is a weaker check and is labelled as one wherever it is cited.
