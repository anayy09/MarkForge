# Status — delivered against promised

An honest audit of what Phases 0–2 said they would produce against what exists. Written
because the fidelity numbers looked healthy while several named deliverables were simply
absent, and a green test suite is not the same as a finished phase.

Every row is checkable. `docs/INIT.md` §11 defines the phases; the other references are
to the Phase 0 specification documents that promised specific artifacts.

## Phase 0 — specification

| Deliverable | State |
| --- | --- |
| `SPEC.md`, `PRIOR_ART.md`, `CORPUS.md`, `OPEN_QUESTIONS.md`, `TEMPLATES.md` | done |
| 15 ADRs with rejected alternatives | done |
| Three JSON Schemas, ajv strict | done |
| Worked IR examples | done, 4 of them |

Phase 0 is complete. Two amendments were needed once code existed, both recorded:
`contentHash` on `NodeBase` (SPEC §2.7 specified it, the schema never declared it) and
`TableCell.children` widened to accept block content (SPEC §2.7.1) because the schema
contradicted `CORPUS.md` §2.5.

## Phase 1 — deterministic spine

**Done when** `docx → md → docx` beats the reference project and Pandoc, and `fmt` is
provably idempotent.

| Deliverable | State |
| --- | --- |
| `@markforge/ir` with generated types, node ids, canonical JSON | done |
| DOCX adapter on the own-OOXML reader | done |
| Markdown adapter and renderer | done |
| DOCX renderer with template-driven styles | done |
| `convert` and `fmt` | done |
| Fidelity harness with committed baselines | done |
| `fmt` provably idempotent | done — 35 cases + 400 generated, to three passes |
| Beats Pandoc on `docx → md → docx` | **done, after fixing three writer defects** |
| Beats `word-to-markdown-js` | **done** — added to the scoreboard as a third column, pinned to `word-to-markdown@0.3.0`. Structural 100% against 99.4%, span F1 100% against 96.0%; it leads on 0 of 28 metric-fixture pairs |
| Golden corpus v1 | **partial** — 7 of the 8 categories Phase 1 required |
| Three reference DOCX templates | **done** — `templates/`, built by `scripts/build-reference-templates.mjs`, all 38 Pandoc names and all 20 of `TEMPLATES.md` §2.1's rows asserted in CI including zero direct formatting |

### The Pandoc comparison, and why it was wrong before

The first scoreboard run had Pandoc ahead on structure, 97.5% against 92.8%. The
explanation offered at the time — that MarkForge keeps a richer representation than the
Markdown-shaped reference — was plausible and wrong. Diffing the node-type census against
ground truth found three defects in our own DOCX **writer**:

1. **Nested lists were flattened.** A numbering id was allocated per nesting level, so a
   reader grouping paragraphs by numbering id saw a separate list at each depth. Three
   nested bullet lists became five flat one-item lists.
2. **Links lost their URL.** The writer emitted the label underlined followed by the
   address in parentheses instead of writing a hyperlink relationship. The link type was
   destroyed and the address became prose.
3. **Every table cell gained a wrapper paragraph**, so one fixture came back with sixteen
   extra nodes.

A fourth surfaced while writing the regression tests: **blockquotes were lost entirely**.
DOCX has no blockquote element, so a quotation is a named style, and nothing reconstructed
it — `> quoted` round-tripped to a plain paragraph.

Fixing them raised **both** tools' scores, because both were reading a DOCX we had written
badly: Pandoc's span F1 went from 90.5% to 100% without Pandoc changing at all.

The lesson is about the measurement, not the code. An aggregate fidelity score cannot say
*which* node types differ, so four format-destroying defects hid behind a number in the
nineties. The census diff found all four in under an hour. **That census now lives in
`@markforge/fidelity` and is reported in `docs/FIDELITY.md`** under *Where the losses are*,
and it found four more defects on its first run — see *What to fix first*.

### What the reference templates found, three phases late

They were the oldest unbuilt named deliverable: specified row by row in Phase 0, absent
through Phases 1–4, with no `templates/` directory at all. Building them broke two things
within minutes, both invisible until a document with a header and a table existed.

**IR validation did not finish in 120 seconds on a 183-node document, so `markforge check`
hung.** Two causes, compounding. The content unions are `oneOf` over 24 and 25 branches and
they nest — a table holds cells, which hold paragraphs, which hold phrasing — and `oneOf`
must evaluate every branch to prove exactly one matched. Every union is discriminated by a
distinct `type` const, so `anyOf` accepts precisely the same documents and may stop at the
first match; that change alone was not enough, because `allErrors: true` re-disables the
short-circuit. `validateDocument` now runs a fast validator and compiles a thorough one only
when the answer is "invalid" — paying for good error messages exactly when there are errors.
**183 nodes: >120 s → 3 ms.** The table-conformance suite went from **154 s to 1.7 s**, a cost
the test run had simply absorbed for two phases.

**Furniture content was the wrong shape, forced past the compiler with a double cast.** The
schema declares `Furniture.content` as a `Root`; the DOCX adapter emitted a bare array and
wrote `as unknown as Furniture["content"]` to make it compile. Every document with a header or
footer failed `validateDocument` at `/furniture/0/content`, and nothing noticed because no
committed fixture had furniture until now. ADR-0002 routes headers rather than stripping them;
routing them into a shape the schema rejects is not much better than stripping them.

Both are the same lesson as the node-type census: a deliverable that is missing does not just
lack its own value, it removes the pressure that would have found other defects.

## Phase 2 — breadth

**Done when** a real-world messy PDF and a real-world messy DOCX both convert with zero
manual cleanup, verified by inspection against the fidelity report.

| Deliverable | State |
| --- | --- |
| HTML adapter and renderer | done |
| PPTX adapter | done |
| XLSX adapter | done |
| PDF adapter, text layer | done |
| Deterministic structure inference | done — headings, lists, blockquotes |
| PDF renderer | **not done** — needs Typst WASM (ADR-0003) |
| Visual regression suite | **not done** |
| Real-world messy PDF converts cleanly | **not verified** — no such fixture exists |
| Real-world messy DOCX converts cleanly | **verified on authored equivalents** — `CORPUS.md` §2.3 built; no committable real specimen |

**The Phase 2 done-criterion is now met on authored equivalents, with one caveat stated
plainly.** `CORPUS.md` §2.3 and §2.15 are built: eight deliberately defective DOCX fixtures
are committed and measured, and all eight round-trip at 100% structural, text, table, and
span fidelity. The caveat is that they are *our* messy documents. `fixtures/local/` holds
three genuinely messy real documents that cannot be committed (IEEE licensing, and personal
data in two of the owner's own files), so the real-specimen check remains manual.

That said, the fixtures are not a soft target — building them broke the converter in five
places the clean corpus could not reach: `w:tcPr` parsed as cell content, heading inference
blind to run-level formatting, a per-run rather than per-document missing-theme diagnostic,
`## **TEXT**` from a fully-bold heading, and — the largest — merged table cells silently
flattened by GFM pipe syntax with no diagnostic. See **Corpus coverage** below.

## Phase 3 — the LLM layer

**Done when** `--no-llm` and cached-LLM runs are both byte-reproducible and the LLM path
measurably improves fidelity on the scanned and ambiguous subsets.

| Deliverable | State |
| --- | --- |
| `@markforge/llm`: OpenAI-compatible client, no vendor SDK | done |
| Credentials from the environment only, missing key is a startup error | done |
| Prompts as versioned files, version **and content digest** in the cache key | done |
| Schema-validated structured output with a bounded repair loop | done |
| Content-addressed, committable cache; offline `readOnly` mode | done |
| Per-call token accounting and a `maxTokens` ceiling that refuses before spending | done |
| Endpoint capability probe recorded in `.markforge/llm-capabilities.json` | done — `markforge check --llm` |
| LLM tie-breaking within the deterministic candidate set | done |
| Vision/OCR path (ADR-0012) | done, both recognisers **measured** — vision 100% structural, tesseract 14.6% structural / 96.0% text |
| `CORPUS.md` §2.7 scanned fixtures | done — 3 synthesized committed, 1 found scan fetched on demand; the 2nd deliberately dropped (CORPUS §2.7 limitation 3) |
| Non-blocking live drift job | done |
| Model registry, routing policy, capability tags | **not deliverables** — descoped by the reviewer (ADR-0009) |

**The done-criterion is met, and both halves are checked in CI rather than asserted.**

*Reproducibility.* Two cached-LLM runs of the same input, with `MODEL_API_KEY` unset and
`--llm-cache-mode readOnly`, produce byte-identical output — for the scanned PDF and for the
ambiguous DOCX. The key being absent is the point: if anything on that path reached the network
the job would fail rather than quietly succeed.

*Improvement.* Measured in `docs/FIDELITY.md`, from the committed cache, offline:

| Subset | Deterministic | Local OCR (tesseract) | Cached LLM |
| --- | --- | --- | --- |
| `scanned-150dpi` (`scan->md`) | 0.0% on every metric | 14.6% structural, 96.0% text | 100% structural, 100% text |
| `ambiguous-headings` (`docx->truth`) | 96.1% structural, span F1 0.0% | n/a | 100% on every metric |

The scanned gap is that large because the deterministic baseline on a scan is *zero*: the adapter
refuses by name rather than returning three words of a forty-page document. Stating it as
"0% → 100%" is accurate and would be misleading without that sentence.

The middle column is what `--no-llm` actually buys on a scan, and it is the honest answer to
"do you need a model for this": **the text, and not the document.** Tesseract reads the words
about as well as the vision model — 96.0% against 100% — and recovers none of the shape, with
6 headings, 5 list items, and 2 lists all going to zero and 9 paragraphs collapsing into 1.
That is not a defect in tesseract; it returns text and a confidence and never claimed to see
that a line is large and bold. `SPEC.md` §3.3 asserted this difference from the start. It is
measured now rather than argued, which is the whole reason the row exists.

### What building it found

**Running tesseract for the first time broke it immediately.** It had been carried as
"implemented but never measured" for the whole phase. tesseract.js looks for
`<lang>.traineddata.gz`; every tessdata repository — including the one our own error message
tells users to download from — publishes the file uncompressed, so the documented offline
setup could not start at all. A wrapper whose behaviour contradicted its own instructions,
found in the minute it took to execute rather than read it. `gzip` now defaults to
uncompressed when `langPath` is local, and three tests guard it. This is the argument for
"measured" being a different status from "implemented", made concrete.

**Every reachable public-domain scan already has an OCR text layer.** §2.7 asked for two found
scans. NTRS, the Internet Archive, and the Library of Congress all run OCR before publishing,
so a text-layer-free public-domain scan is rare precisely because nobody releases one. The
consequence is worth more than the fixture would have been: the common real-world scanned
document is not the one this adapter refuses, it is one carrying **somebody else's OCR of
unknown quality**, which passes the coverage test and is read as ordinary text. One such
document is wired in and handled; measuring the quality of an archive's OCR is not something
this corpus can do, and `CORPUS.md` §2.7 now says so instead of leaving a checkbox.

**The ambiguous subset did not exist.** Phase 3's criterion names it, and running every
committed fixture through `convert --json` produced **zero** ambiguous decisions — so the
tie-break had nothing to decide and the criterion was unmeasurable rather than unmet. §2.3's
fixtures are *badly* formatted, which turns out to be a different thing from *ambiguously*
formatted. `messy-ambiguous-headings.docx` was built to the arithmetic of `scoreHeading` (12pt
bold against an 11pt body scores 0.536 to 0.464, margin 0.073) rather than to taste, and the
first attempt still produced no ambiguity: with four 12pt lines against five 11pt ones the
*median* body size came out 11.5, which dropped the score below the 0.5 that even offers a
heading candidate. Two more body paragraphs fixed it.

**The first prompt made the model wrong for a coherent reason.** v1 carried the deterministic
rules' instruction not to skip heading levels. The candidate set offered `heading4` or
`paragraph`, the preceding heading was level 1, and the model demoted a genuine section label
because the only heading on offer would have skipped levels — and said so in its rationale. The
prompt had asked it to weigh something it could not act on. v2 states the division of labour
instead (decide label or prose; take the level as given) and gets all four decisions right. The
prompt version is in the cache key, so the change invalidated the recorded answers, which is
the mechanism working.

**The capability probe reported the wrong answer twice, and the second one was dangerous.**
Sending a *valid* `seed` proved nothing, because the gateway ignores unknown parameters — a
valid seed and a nonsense field look identical in the response. And run with a deliberately
wrong key, the probe concluded "guided decoding unavailable" and **wrote that to the
capabilities file**, so a typo'd credential would have left a confident wrong claim that every
later run inherited. The mechanism whose entire purpose is to avoid assuming had produced an
assumption. It now refuses to conclude anything from an authentication failure, a rate limit, a
missing model, or an unreachable endpoint. Both defects were found by running the gate against
ground truth established by hand first, which is the only reason they were visible at all.

**`objs.has()` is not a precondition for `objs.get()`.** Page-image extraction gated on
pdf.js's `has`, which reports whether an object is *already resolved* rather than whether it
exists — so every scanned page came back "no raster this reader can extract", a plausible
diagnostic for a file that was fine. Found by running the pipeline end to end after a scratch
script had already proved the extraction worked.

**Three smaller ones**, each caught the same way. An empty completion was treated as a transport
failure, so a reasoning model that spent its token ceiling on reasoning looked like a broken
endpoint. Library error messages that name the tool arrived double-prefixed as
`markforge: markforge: …`. And `packages/core/test/assist.test.ts` computed the repository root
with `new URL(...).pathname`, which on Windows yields `/C:/Users/...`, `existsSync` said false,
and **every fixture-backed test in the file skipped silently** — the failure mode this document's
last section is about, in a file written to check for it.

## Phase 4 — the Agent Context Compiler

**Done when** a folder of mixed source documents produces a `CLAUDE.md` set that passes the
verification gate at 100 percent traceability, and editing one source document produces a
minimal, readable git diff.

**The done-criterion is met, and both halves are checked in CI rather than asserted.**

| Half | Measured | Where |
| --- | --- | --- |
| A `CLAUDE.md` set at 100% traceability | 100.0% over 37 sentences, from 5 documents in md + html + docx | `check-agentify.mjs` check 1, and a CLI job in `ci.yml` |
| One source edit → a minimal diff | **1 line in 1 region** | check 3 |

Both run offline with `MODEL_API_KEY` unset, because `--no-llm` is the default and a gate that
needed a model would not be the default path.

| Deliverable | State |
| --- | --- |
| `@markforge/agentify`: units, dedup, budget, targets, verification | done |
| `targets/` registry — 12 profiles, all schema-validated | done |
| Rule-based classification (§10.2) | done — 10/10 in-distribution, but **1 of 5 on a holdout it was not tuned against** |
| Deterministic extraction (§10.3) | done — recall **94.7%**, precision **75.0%** against the authored key |
| Dedup by text, then embedding shortlist + model adjudication (§10.4) | done and measured live — **0 of 2 authored pairs merged, 0 false merges on 4 hard negatives**. The design as specified was refuted (ADR-0020); one authored pair is unmergeable by design (OPEN_QUESTIONS §7q) |
| Conflict report (§10.4) | done — **2/2** recall, **0** false positives |
| Budget and progressive disclosure (§10.5) | done — 31 primary / 9 secondary at a 600-token budget, nothing lost |
| The traceability gate (§10.6) | done, **and checked for its ability to fail** |
| Provenance manifest (§10.7) | done, byte-identical across runs |
| Incremental regeneration (§10.8) | partial — unchanged sources are detected and reported; units are re-extracted rather than reused |
| `markforge agentify` (§8) | done — `--targets`, `--budget`, `--dry-run`, `--explain-drops`, `--strict`, `--json` |
| Reverse direction (§10.10) | not done — a stated stretch, and no corpus for it |

### The measurement that refuted a design

`SPEC.md` §10.4 and OPEN_QUESTIONS §7c say near-duplicates merge by **cosine distance between
embeddings**. §7c added the `embed` role up front specifically so Phase 4 would not have to
retrofit it. Half of that reasoning was right and half was wrong, and only running it showed
which.

Right: no lexical threshold reaches these pairs — both score content-word Jaccard 0.000.

Wrong: cosine cannot decide either. Against `nomic-embed-text-v1.5`, the two authored pairs
score **0.63** and **0.62**, while the highest-scoring pair in the whole clean set is
`NIMBUS_MAX_BATCH_MB=64` against `NIMBUS_BATCH_TIMEOUT_MS=30000` at **0.82** — two unrelated
variables. "Retrievable for thirty days" against "rejected whole" scores 0.74. Both decoys
outrank both true pairs, so no cutoff separates them, and the documented task prefixes lift
every score while leaving the ranking identical. Cosine measures topical relatedness;
deduplication needs semantic equivalence.

Shipped as specified, this would have failed one of two ways: a safe threshold that merges
nothing, or a low one that silently deletes real facts from every generated file. The second
is worse and is invisible, because a merged unit looks exactly like a unit.

The embedding now **shortlists** and a `strong` model **decides** (ADR-0020). Measured: 19
pairs adjudicated, 0 unparseable, **0 of 2 authored pairs merged, 0 false merges against 4
hard negatives.**

That first number was reported as 1 of 2 and was wrong, and how it was wrong matters more than
the number. The merge that happens is between two *product-spec* sentences — one requirement
bullet split by sentence segmentation — which is correct but is not an authored pair. The CI
job asserting `--llm` differs from `--no-llm` went green because of it, and that was read as
the authored pair working. Pair 1 is shortlisted and rejected on defensible grounds (a p95
target is not a hard ceiling, and the model said so). **Pair 2 is never compared at all**: its
two sides are a `constraint` and a `decision`, and cross-category merges are blocked by design.
The corpus and §10.4 contradict each other there, and that is now open as OPEN_QUESTIONS §7q.

Two more defects surfaced on the way, both only visible by running it:

**An enum of long strings is a pathological guided-decoding grammar.** Constraining
`survivingText` to an enum of the two full sentences is the obvious way to guarantee the merged
text comes from a source. It also forces the sampler to reproduce ~150 characters exactly, and
when the model diverges it can only emit whitespace: **41 of 50 adjudications died at
`finish_reason: "length"` having burned a 3000-token ceiling.** A two-letter `"A" | "B"` enum
with the mapping done in code gives the identical guarantee at a median of 153 tokens.

**A 500-token ceiling on a reasoning model looks like model incompetence.** The first run set
it there; `nemotron-3-super-120b-a12b` spent all of it before writing JSON. STATUS.md already
records this exact mistake from Phase 3's capability probe, which is the argument for the
ceiling being commented with its number rather than merely set.

The cache is committed — 48 entries, 324 KB — and the path is offline-reproducible: two
`readOnly` runs with no key present are byte-identical, and `--llm` differs from `--no-llm` by
exactly the one merged line. Both are CI jobs.

### The 10/10 that measured nothing

`classify.ts` and the three corpus sets were written in the same sitting, with the signal
weights tuned while reading the classifier's own output on those documents. The 10/10 it scores
on them is therefore in-distribution by construction, with no holdout — it says the set is
small and familiar, not that the rules are good. It was nonetheless reported here and in
`AGENTIFY.md` as evidence, and used to argue against wiring an LLM classifier. That argument
was circular.

`fixtures/agentify/classification/` is the holdout: five documents authored to be plausibly
missed, key fixed before the rules ran and not adjusted afterwards. **The rules score 1 of 5.**

| Document | Want | Got | Why it is hard |
| --- | --- | --- | --- |
| `weekly.md` | meetingNotes | unknown | role only in the body — attendees, an apology, three owned action items |
| `overview.md` | productSpec | unknown | a PRD in ADR clothing: an `## Decision` heading and a `**Rationale:**` paragraph over requirements and scope |
| `README.md` | codingConventions | **apiContract** | an `## Errors` heading matched the API rule; the filename offers nothing |
| `platform.md` | architecture | architecture | ✔ |
| `checks.md` | testPolicy | unknown | a role none of the other sets contain |

Three of the four misses were `margin: 0.000` — exact ties the classifier reported as decisions
because the distribution sort falls back to `localeCompare`, so `weekly.md` answered
"architecture" over "meetingNotes" because *a* precedes *m*. A tie now returns `unknown`, which
is one of §10.2's ten roles and was previously unreachable. **That fix does not change the
score**, which is the evidence it is a correctness fix and not tuning against the answers.

The holdout is gated on regression, not on its value: 1 of 5 is the finding, and a gate set at
today's number would only stop it getting worse without implying it is acceptable.

### What "first-class" does and does not mean here

Five targets are first-class per ADR-0013 and all five pass the gate. Three of them —
`agents-md`, `claude-md`, `claude-skills` — are checked against something outside this
repository: two vendor-documented filenames and, for skills, a normative specification whose
`name` constraints are asserted field by field. **Two are not.** `claude-commands` and
`mcp-manifest` have a verified *envelope* and an invented *content model*: brief §6.3 asked for
an MCP manifest without saying what a document-derived one holds, so its shape is ours, and the
server it names (`markforge serve`) is Phase 5 and does not exist. Their gates measure our
authored expectation. That is a weaker claim than the other three and the shared label hides
it, so it is written down here and in `docs/TARGETS.md` (OPEN_QUESTIONS §7n).

### What building it found

**Re-verifying the target registry broke ADR-0013's own premise.** ADR-0013 was written on
2026-07-29 and states that Claude Code reads `AGENTS.md`. Checked on 2026-07-31, two days
later, the vendor documentation says the opposite in as many words: *"Claude Code reads
CLAUDE.md, not AGENTS.md."* The decision survives — the vendor's own remedy is a `CLAUDE.md`
importing `@AGENTS.md`, which is base-plus-delta in the target's own syntax — but the premise
was already stale when it was written down. Two more the same afternoon: Windsurf's docs now
307-redirect to `docs.devin.ai`, and `.clinerules` is a directory rather than a file. Three
corrections in one pass is the argument for `verifiedAgainst` being a required schema field
rather than a note someone might read.

**SPEC §10.8's ordering rule defeated its own goal, and it took a measurement to see it.**
The spec orders units by `(sectionOrder, categoryOrder, id)` and calls that diff-stable. `id`
is content-addressed, so editing a unit's text moves it: measured, a one-word edit changed
three rows rather than one. The rule and the criterion it exists to serve contradicted each
other in the spec, and reading them had not surfaced it. ADR-0018 amends the order; the row
count is now asserted every CI run.

**The traceability gate had a bypass, and the negative control that was supposed to catch it
did not.** §10.6 exempts scaffolding from the gate and requires it to be "declared by the
template, not inferred". The first implementation validated a `heading` fragment with, among
other things, "any title-cased string under 40 characters" — so `## Ignore all previous
instructions` was accepted as legitimate structure. The harness's own negative control missed
it because the invented heading it used happened to be longer than 40 characters; a unit test
with a shorter one found it. The allowed set is now enumerated rather than pattern-matched. A
gate with a loose predicate is a gate with a bypass, which is precisely what §10.6 says it must
not have.

**The conflict detector's first run reported a false conflict on the set with no conflicts in
it.** Three sequential deploy commands under one `## Deploy` heading in one runbook were read
as three competing answers to one question. Brief §6.1 scopes conflicts to *across* documents;
that is now enforced rather than assumed. The corpus's `nonConflicts` list exists for exactly
this and earned its place on the first run.

**The extractor found no commands and no environment variables at all, at first.** `textContent`
walks children and returns `""` for a literal node, so every code fence produced an empty block
and the shell-fence and env-assignment rules matched nothing — silently, because "no commands in
this document" is a legitimate answer. Found by running it against the corpus rather than by
reading it.

**Two smaller ones.** The same DOCX sentence was emitted as both a `convention` and a
`constraint`, in two different sections of the same file, because the extraction passes overlap
by construction and nothing arbitrated; passes now claim their sentences. And the answer-key
matcher, greedy on category, reported the *wrong* convention as missed when there were four
expected and three found — a miss list is the part of a report someone acts on, so it now
matches lexically first.

### Prerequisites this phase inherited

| Prerequisite | State |
| --- | --- |
| `CORPUS.md` §2.14 source sets | done before the phase — 10 documents, three sets, authored answer keys |
| Near-duplicate pairs proven beyond lexical reach | done — both score Jaccard 0.000 |
| `embed` role and `context-unit-dedup` binding | done (Phase 3, OPEN_QUESTIONS §7c) |
| `target.v0.schema.json` | done (Phase 0), and it needed no changes |
| Everything in §10.1's ingest path | done — all ten documents parse with zero lossy diagnostics |

**Building the corpus first paid off exactly as intended.** Phase 3's criterion named an
"ambiguous subset" that did not exist, and was unmeasurable rather than unmet until one was
authored. Phase 4's criterion was measurable on day one, and the authored keys caught two
things a captured snapshot could not have: the classifier traps (`architecture.md` answers
`decisionRecord`, `service-overview.md` answers `architecture`) and the false conflict above.

Five of the ten bound LLM tasks still have no prompt file. Phase 4 wrote one —
`context-unit-summarization/v1.md`, the near-duplicate adjudicator — and wired the embeddings
path, which needs none. `document-role-classification` and `context-unit-extraction` remain
unwired for the reason in OPEN_QUESTIONS §7o: this corpus cannot grade them.

## Unbuilt CLI surface

`SPEC.md` §8 specifies seven subcommands. Three work. The other four refuse by name rather
than pretending, which is the right behaviour but is not delivery.

| Command | State |
| --- | --- |
| `convert`, `fmt` | done |
| `check` | **partial, and no longer a lie** — validates documents against the IR schema, reports reference-document style coverage (`--reference-doc`), and probes the LLM endpoint (`--llm`). Corpus fidelity baselines stay in `scripts/run-fidelity.mjs`, and `check --help` says so rather than implying otherwise |
| `agentify` | **done** — `--targets`, `--budget`, `--dry-run`, `--explain-drops`, `--strict`, `--json`. Exit 5 is the traceability gate and has no bypass flag (SPEC §10.6) |
| `diff`, `init`, `serve` | not done, by phase |

## Renderer gaps that lose content today

Each emits a diagnostic — but that was **not true when this section was first written**, and
the claim is worth correcting rather than quietly fixing. Through `html -> docx -> html` the
DOCX writer dropped nine node types while emitting exactly one diagnostic, and the Markdown
writer degraded figures, captions, and description lists in silence. Both now report. Neither
was found by a test; the node-type census found them.

A diagnostic is still not a feature.

| Gap | Effect | Reported |
| --- | --- | --- |
| Images are not embedded in DOCX output | an image becomes `[alt text]` | yes |
| Footnotes are not written to `footnotes.xml` | footnote bodies become body paragraphs | yes |
| Cross-references are not resolved on write | become plain links | yes |
| Tracked changes are read but not written | `revisionMode` affects reading only | yes |
| DOCX has no figure, caption, or description list | text survives, the construct does not | yes, since this session |
| Markdown has no figure, caption, or description list | same, and it is a format limit rather than a gap | yes, since this session |
| ~~`code` and `thematicBreak` written to DOCX but not read back~~ | **fixed** — `inferCodeAndBreaks` reads both back from the style name and the paragraph border, exactly as blockquotes already were. `html -> docx -> html` text fidelity 89.7% to 96.2%, structural 91.2% to 93.8%, and both node types left the loss census | n/a |

The last row was the tractable one and is now done. Fixing it needed three changes rather
than one, which is the interesting part: the inference pass was the easy third. The cascade
recorded no border at all, so `thematicBreak` had no evidence to be recovered *from* — and
`normalize` was deleting the empty bordered paragraph as spacing before inference ever saw
it. A construct can be written correctly, be readable in principle, and still be destroyed
in between by a rule that was right about every other empty paragraph.

## Corpus coverage

`CORPUS.md` names 15 categories. Phase 1 required eight of them; five exist. Phase 3 added
§2.7 and the ambiguous fixture §2.3 was missing.

| Category | State |
| --- | --- |
| 2.1 clean reports | done |
| 2.4 nested and restarting lists | done |
| 2.5 tables with merged cells | done, HTML only |
| 2.11 emoji and Unicode | done |
| 2.13 Markdown flavours | partial — one flavour |
| 2.2 manuscripts with footnotes and equations | not done |
| 2.3 badly formatted real-world documents | done — 7 fixtures, asserted defect by defect (the seventh is the Phase 3 ambiguous subset) |
| 2.6 multi-column PDFs | not done |
| 2.7 scanned PDFs | **done** — 3 synthesized (1 committed, 2 generated), 1 found scan fetched on demand; 2nd dropped with reasons |
| 2.8 slide decks | not done |
| 2.9 spreadsheets | not done |
| 2.10 RTL and CJK | partial, inside 2.11; native-speaker review not done |
| 2.12 tracked changes and comments | not done |
| 2.14 agentify source sets | done — 10 documents, 3 sets, authored answer keys, all measured in `docs/AGENTIFY.md` |
| 2.15 library- and LLM-generated documents | partial — 2 of 4 producer profiles; Pandoc and LibreOffice exports need the binaries |

The measured numbers in `FIDELITY.md` now cover eight deliberately defective DOCX
documents alongside the clean ones, so they are no longer only a claim about easy input.
They remain a claim about *authored* input: nothing in the corpus was found in the wild.

## CI had never passed, from Phase 1 until now

Worth its own section, because it invalidates how every earlier "done" in this document
was arrived at. Every CI run on `main` failed — the merges of PRs #1, #2, and #3 included
— and each failed in **setup**, before install, in under ten seconds. Red that fast reads
as infrastructure noise, so it was never chased. Phase 1 added `packageManager` to
`package.json` while the workflow also pinned `version: 11`, and `pnpm/action-setup@v4`
refuses when both are present.

Fixing that one line exposed four more defects, each latent since the phase that
introduced it, none reachable by any local run:

1. **The test suite could not pass on a clone.** `packages/ooxml/test/real-docx.test.ts`
   reads two gitignored fixtures. It guarded them with `describe.skipIf` *and* carried a
   comment insisting CI must be reproducible from a clone — but `skipIf` skips the tests,
   not the suite body, so `readFileSync` at body level threw during collection.
2. **Node 20 was in the test matrix and could never work.** pnpm 11.9.0 needs a builtin
   Node 20 lacks. `engines.node` claimed `>=20.11`, which was simply untrue.
3. **The scoreboard staleness gate could not pass.** It byte-compares a file that records
   its pandoc version, while installing whatever apt shipped. Same code, pandoc 3.10: *1
   metric-win to MarkForge, 23 tied*; Ubuntu's pandoc: *12 to MarkForge, 12 tied*.
4. **`normalize` was not idempotent** — a stated Phase 1 gate. Rule 3 collapsed whitespace
   per text node *before* the merge, so `["! ", " ", "!"]` merged into `"!  !"` and nothing
   revisited it. Caught at fast-check seed 1458972494, on CI and not locally purely
   because the seed is random per run. Seeds are now pinned in all four property files.

The lesson matches the one about aggregate fidelity scores: **a check that has never run
is not a check.** A green local `pnpm verify` and a red CI badge were both visible for
three phases, and the local one was believed. Every gate in `.github/workflows/ci.yml`
should be assumed unverified until it has been seen to pass *and* seen to fail for the
right reason.

## What to fix first

In the order that removes the most risk:

1. **Figures, description lists, and captions in the DOCX writer.** The top item,
   and the largest remaining measured loss. `docs/FIDELITY.md` **Where the losses are**
   names it exactly: through `html -> docx -> html`, `figure`, `caption`, `image`,
   `code`, `thematicBreak`, and all three `description*` node types go to zero. DOCX
   has no description list, so this needs a style convention plus inference the way
   blockquotes got one. Markdown genuinely cannot express a figure or a description
   list, so those rows are a format limit — but they are now *reported* rather than
   silent, which they were not until the census found them.
2. **`word-to-markdown-js` in the scoreboard.** It is the project's stated baseline and is
   absent from the comparison.
3. **Images and footnotes in the DOCX writer.** Both currently degrade real content.
4. **`check --reference-doc`.** Two specification documents describe it as though it
   exists.
5. **`CORPUS.md` §2.12 (tracked changes) and §2.2 (scanned documents).** The two remaining
   categories that block a stated done-criterion rather than a nice-to-have.

Completed since this document was first written: `CORPUS.md` §2.3 and §2.15, and the
per-node-type census, which were items 1 and 2.

The census earned its place immediately. Added to `@markforge/fidelity` and reported in
`docs/FIDELITY.md`, it found four things the aggregate scores had hidden behind means of
99% and above:

- **The harness measured a pipeline we do not ship.** It ran `inferHeadings` where
  `@markforge/core` runs `inferAll`, so blockquote recovery was missing from every
  measurement and every blockquote through DOCX looked like a permanent loss.
- **`docx -> md -> docx` compared unlike trees.** Inference ran on one side only, so all
  five headings in `clean-report` counted as lost and five paragraphs as gained. The loop
  was reporting 96.8% against itself when it was clean.
- **A whole table vanished** from `spans-ground-truth` through Markdown, because a GFM
  pipe cell cannot hold block content any more than it can hold a merge. Table F1 read
  88.9% while the metric never saw the table that disappeared.
- **`html -> html` lost an image** — a loop through a single format. A `figure` holds its
  `image` as a direct child, the block renderer had no case for an inline node, and it
  produced nothing. `renderRow` already carried a comment about the same mistake costing
  table F1 0.0%, which is twice.

Mean structural fidelity went 98.9% to 99.7% and mean table F1 96.5% to 100.0% as a
result — none of which was new capability, all of which was measurement finding real
defects. That is the argument for keeping the census.
