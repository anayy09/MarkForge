# Status — delivered against promised

An honest audit of what Phases 0–5 said they would produce against what exists. Written
because the fidelity numbers looked healthy while several named deliverables were simply
absent, and a green test suite is not the same as a finished phase.

Every row is checkable. `docs/INIT.md` §11 defines the phases; the other references are
to the Phase 0 specification documents that promised specific artifacts.

## Closing audit, 2026-08-02

**Every row in this document reads `done` or `struck`.** A struck row links a numbered ruling
in `OPEN_QUESTIONS.md` that names what was lost, and every strike also appears in
`docs/LIMITS.md`. There are no `partial`, `not done`, `not verified`, or `deferred` rows left;
where one used to stand, either the work was finished or a ruling closed it.

`pnpm verify` is green across all 32 gates. `docs/GATES.md` lists them with a commit where each
was seen to fail, `scripts/check-gate-parity.mjs` asserts `pnpm verify` and `ci.yml` run the
same set, and `scripts/check-gates.mjs` asserts every gate carries a negative control that runs
on every invocation.

| Package | State | Where it landed |
| --- | --- | --- |
| W0 ledger and gate audit | done | `docs/GATES.md` (32 gates), gate-parity gate, 10 gates given negative controls, 11 countable-fact contradictions fixed, D4 amended |
| W1 DOCX writer losses | done — footnotes, images, tracked changes, and the figure/caption/description-list style convention all round-trip | `scripts/check-ir-structure.mjs`, `scripts/run-fidelity.mjs` |
| W2 PDF renderer | done | `scripts/check-pdf-determinism.mjs` — byte-identical across separate processes on 4 fixtures |
| W3 PDF adapter clauses | done — 2 built (ligature repair, furniture routing), 2 struck (figure/caption binding, table recovery) | OPEN_QUESTIONS §7af |
| W4 visual regression | struck | OPEN_QUESTIONS §7ad |
| W5 corpus completion | done — 12 categories complete, 3 struck, 0 partial, 0 absent | §2.2, §2.5, §2.10, §2.12, §2.13, §2.15 closed. §2.6, §2.8, §2.9 struck (§7ac); §2.15's LibreOffice producer struck (§7aj) |
| W6 CLI surface | done — `diff`, `init`, `--emit-ir`, `--report`, `check --fidelity`, `--md-flavor`, and the pre-commit hook | `pnpm test`, `scripts/check-hook.mjs` |
| W7 agentify | done — §9's routing fix built (§7ag); §10.10 struck (§7ae); §10.8's unit reuse struck (§7am) | `scripts/check-agentify.mjs` |
| W8 distribution | done — the Playwright leg struck (§7ah); the `first-class` label split (§7ai) | OPEN_QUESTIONS §7ah, §7ai |
| W9 closing pass | done — this section, and the sweep below | `docs/LIMITS.md`, `docs/GATES.md` |

### What the closing pass found

**Six IR-validity defects, none of which any gate could see.** `markforge check
fixtures/md/clean-report.md` printed **INVALID IR** while `pnpm verify` was green, and it had
been doing so for five phases. The cause was one missing field on a Markdown table cell; the
*reason nothing caught it* was that every fixture-backed validation test began from DOCX or
HTML. Validating **every committed fixture through its own adapter** — one new section in
`scripts/check-ir-structure.mjs` — found five more on its first run:

| Defect | Effect |
| --- | --- |
| `tableCell` missing `rowSpan`/`colSpan`/`isHeader` | Every Markdown document with a table produced an invalid IR |
| mdast `data` copied onto `inlineMath` | Every `$…$` in every Markdown fixture produced an invalid IR |
| `restartsAt` set on `list` instead of `listItem` | Three adapters; the property is a `ListItem` field, and two tests asserted the defect |
| `comment` emitted with `anchors` and no `children` | Every document with a comment; the adapter had overruled the schema's wrapping model in a comment explaining why |
| `equationBlock` inside a paragraph | Block content in a phrasing slot, on four fixtures |
| `caption` without `for`, `image` directly under `figure` | Every HTML document with a `<figcaption>` or `<figure><img>` |

**The validator could not explain any of them without exhausting a 4 GB heap.** A 46-node
fixture with one missing `rowSpan` produced **1,054,471** errors, because `allErrors: true`
cannot short-circuit a union and the count multiplies through the nesting. The explanation now
descends to the deepest node that fails on its own merits and validates *that node* against its
own `$defs` entry: same defect, **1** error, and it names the right field.

**Two exit codes in `SPEC.md` §8's table could not be produced by anything.** Exit 4 had no
implementation — `check --fidelity` did not exist. Exit 5 had one that could not fire: the
scaffolding check was handed a fragment beginning `## More`, which satisfied its
"does this look like a link" pattern before the link was examined, so a target profile whose
declared import syntax was not a link passed the mandatory gate. Both are now produced by a
test, from shipped behaviour rather than doctored inputs (§7ak, §7al).

**A real Pandoc export invalidated every Pandoc-produced document.** `CORPUS.md` §2.15's third
producer profile, built as a generation step, found on its first run that Pandoc's `TOCHeading`
style declares `w:outlineLvl` 9 while our schema capped `outlineLevel` at 8 — against ISO/IEC
29500-1, which allows 0 to 9. Five phases of hand-written fixtures never produced a 9 because
we only ever wrote headings (§7aj).

**`revisionMode` now means the same thing on all three renderers.** The DOCX writer and the PDF
renderer read it; the Markdown renderer did not, so under the default `clean` it emitted both
sides of every tracked change. It now emits the accepted text and diagnoses each dropped
deletion.

**Two renderers were hiding the document inside the annotation.** Once the DOCX adapter began
wrapping a comment's range — as the schema always required — `render-md` and `render-html` both
rendered the *commented text* inside `<!-- -->` and dropped the reviewer's note. The note is the
annotation; the text under it is body text.

### From the earlier run

**W1's root cause was the IR, not the writer.** `STATUS.md` carried *"images are not embedded
in DOCX output"* as a writer gap from Phase 1 to Phase 6. `Resource` recorded an image's media
type, hash, and length and **never its bytes** — so every adapter read them, hashed them, and
dropped them. ADR-0022 adds `Resource.data`.

**W7: §9's routing collision is fixed.** Extraction passes were reordered so a modal-bearing
sentence is claimed by the pass that reads the modal rather than by a filename. All three
`CORPUS.md` §2.17 near-duplicate pairs now read **COMPARED and rejected** where they were
previously never compared. Recall is still 0 of 3; the structural block is gone.

**The surface-parity gate caught a real divergence mid-run.** `docx.onMissingStyle` defaulted
to `"synthesize"` in the **CLI** and to `"warn"` everywhere else: four surfaces, two behaviours.
The default now lives in `@markforge/core`, where all four surfaces read it.

## Phase 0 — specification

| Deliverable | State | Verified by |
| --- | --- | --- |
| `SPEC.md`, `PRIOR_ART.md`, `CORPUS.md`, `OPEN_QUESTIONS.md`, `TEMPLATES.md` | done | `pnpm check:schemas`, `pnpm check:docs` |
| ADRs with rejected alternatives | done — 15 at Phase 0, **20 now**; ADR-0016 through ADR-0020 were written as later phases made decisions on the reviewer's behalf | `scripts/check-adr-enforcement.mjs`, `docs/GATES.md` |
| Three JSON Schemas, ajv strict | done | `pnpm check:schemas`, `pnpm check:docs` |
| Worked IR examples | done, 4 of them | `pnpm check:schemas`, `pnpm check:docs` |

Phase 0 is complete. Two amendments were needed once code existed, both recorded:
`contentHash` on `NodeBase` (SPEC §2.7 specified it, the schema never declared it) and
`TableCell.children` widened to accept block content (SPEC §2.7.1) because the schema
contradicted `CORPUS.md` §2.5.

## Phase 1 — deterministic spine

**Done when** `docx → md → docx` beats the reference project and Pandoc, and `fmt` is
provably idempotent.

| Deliverable | State | Verified by |
| --- | --- | --- |
| `@markforge/ir` with generated types, node ids, canonical JSON | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| DOCX adapter on the own-OOXML reader | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Markdown adapter and renderer | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| DOCX renderer with template-driven styles | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| `convert` and `fmt` | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Fidelity harness with committed baselines | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| `fmt` provably idempotent | done — 35 cases + 400 generated, to three passes | `pnpm test`, `scripts/run-fidelity.mjs` |
| Beats Pandoc on `docx → md → docx` | **done — and it briefly regressed on 2026-08-01, for a harness defect rather than a converter one.** Adding the four RTL/CJK fixtures put MarkForge below Pandoc on Structural for all four. Cause: `run-scoreboard.mjs` called `inferHeadings` where `@markforge/core` calls `inferAll`, so it measured a pipeline we do not ship and every recovered blockquote read as a permanent loss. `run-fidelity.mjs` had the identical defect and it was fixed there in Phase 1; the fix never crossed. **Re-measured 2026-08-02 on 12 fixtures: 0 losses across 48 metric-fixture pairs, 1 win, 47 ties** | `scripts/run-scoreboard.mjs` (docs/SCOREBOARD.md) |
| Beats `word-to-markdown-js` | **done, and re-measured twice on a growing corpus** — pinned to `word-to-markdown@0.3.0`. It leads on **0 of 48** metric-fixture pairs. The corpus grew from 7 fixtures to 11 and then to 12 during Phase 6, including the comment, equation, and tracked-change work of the closing pass, and the row survived each re-measurement | `scripts/run-scoreboard.mjs` (docs/SCOREBOARD.md) |
| Golden corpus v1 | **done** — all 8 categories Phase 1 required are complete: 2.1, 2.3, 2.4, 2.5, 2.11, 2.12, 2.13 (seven flavour presets, ADR-0021) and 2.15 (three producer profiles; the fourth struck, §7aj) | `scripts/check-fixtures.mjs` category coverage, and the per-category table under **Corpus coverage** below |
| Three reference DOCX templates | **done** — `templates/`, built by `scripts/build-reference-templates.mjs`, all 38 Pandoc names and all 20 of `TEMPLATES.md` §2.1's rows asserted in CI including zero direct formatting | `scripts/build-reference-templates.mjs --check` |

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

| Deliverable | State | Verified by |
| --- | --- | --- |
| HTML adapter and renderer | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| PPTX adapter | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| XLSX adapter | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| PDF adapter, text layer | done — extraction, line and block assembly, column order, hyphenation repair, scan detection. **Four clauses of ADR-0012 are unbuilt**: furniture routing, ligature repair, figure/caption binding, and table recovery. Enumerated in the ADR rather than implied by a missing test | `pnpm test` (`packages/adapters-pdf/test/pdf.test.ts`), ADR-0012 |
| Deterministic structure inference | done — headings, lists, blockquotes | `pnpm test`, `scripts/run-fidelity.mjs` |
| PDF renderer | **done, and reachable as of 2026-08-02** — `@markforge/render-pdf`, IR to Typst to PDF, byte-identical across separate processes and across all four surfaces. The wall-clock `/CreationDate` is omitted via `#set document(date: none)`, because the compiler's `creationTimestamp` option does not override it. **This row read `done` from 2026-08-01 while nothing imported the package except its own gate**: `core`'s dispatch threw *"not built yet"* for `pdf`, so no surface could produce one. `done` meant *built*, `README.md` meanwhile said *not built*, and both were locally defensible — a package that compiles and passes a gate is not a delivered capability, and no gate distinguished the two | `scripts/check-pdf-determinism.mjs`, `scripts/check-surface-parity.mjs`, `scripts/check-pdf-fonts.mjs` |
| PDF output on all four surfaces | done — 39 conversions × 4 surfaces, byte-identical, PDF included on 9 of 10 inputs | `scripts/check-surface-parity.mjs` |
| PDF font closure | done — every embedded face is one `fonts/` ships; four fixtures excluded, each exclusion proved rather than asserted | `scripts/check-pdf-fonts.mjs` |
| `md → pdf → md` measured (SPEC §9.5) | done — 8 fixtures. Structural 57.9% on `clean-report`, 16.5% floor on `nested-restarting-lists`. ADR-0003 had asserted 57.9%/86.5% with nothing computing either; structural reproduced, the text figure did not | `scripts/run-fidelity.mjs` (docs/FIDELITY.md) |
| Visual regression suite | **struck** — OPEN_QUESTIONS §7ad. Nothing catches a change that is visually wrong and structurally identical; the PDF path has byte-identity instead, which is stronger about change and silent about quality | OPEN_QUESTIONS §7ad, `docs/LIMITS.md` |
| Real-world messy PDF converts cleanly | **struck** — OPEN_QUESTIONS §7an. It depends on `CORPUS.md` §2.6, itself struck (§7ac); a criterion resting on a struck category is struck, not pending. No claim is made about PDFs we did not generate | OPEN_QUESTIONS §7an, `docs/LIMITS.md` |
| Real-world messy DOCX converts cleanly | **verified on authored equivalents** — `CORPUS.md` §2.3 built; no committable real specimen | `scripts/build-messy-fixtures.mjs --check` |

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

| Deliverable | State | Verified by |
| --- | --- | --- |
| `@markforge/llm`: OpenAI-compatible client, no vendor SDK | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Credentials from the environment only, missing key is a startup error | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Prompts as versioned files, version **and content digest** in the cache key | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Schema-validated structured output with a bounded repair loop | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Content-addressed, committable cache; offline `readOnly` mode | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Per-call token accounting and a `maxTokens` ceiling that refuses before spending | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Endpoint capability probe recorded in `.markforge/llm-capabilities.json` | done — `markforge check --llm` | `pnpm test`, `scripts/run-fidelity.mjs` |
| LLM tie-breaking within the deterministic candidate set | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Vision/OCR path (ADR-0012) | done, both recognisers **measured** — vision 100% structural, tesseract 14.6% structural / 96.0% text | `pnpm test`, `scripts/run-fidelity.mjs` |
| `CORPUS.md` §2.7 scanned fixtures | done — 3 synthesized committed, 1 found scan fetched on demand; the 2nd deliberately dropped (CORPUS §2.7 limitation 3) | `pnpm test`, `scripts/run-fidelity.mjs` |
| Non-blocking live drift job | done | `pnpm test`, `scripts/run-fidelity.mjs` |
| Model registry, routing policy, capability tags | **not deliverables** — descoped by the reviewer (ADR-0009) | ADR-0009 (descoped by the reviewer) |

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
| One source edit → a minimal diff | **1 line in 1 region** | `scripts/check-agentify.mjs` check 3 |

Both run offline with `MODEL_API_KEY` unset, because `--no-llm` is the default and a gate that
needed a model would not be the default path.

| Deliverable | State | Verified by |
| --- | --- | --- |
| `@markforge/agentify`: units, dedup, budget, targets, verification | done | `scripts/check-agentify.mjs` |
| `targets/` registry — 12 profiles, all schema-validated | done | `scripts/check-agentify.mjs` check 10 |
| Rule-based classification (§10.2) | done — 10/10 in-distribution, but **1 of 5 on a holdout it was not tuned against** | `scripts/check-agentify.mjs` |
| Deterministic extraction (§10.3) | done — recall **94.7%**, precision **75.0%** against the authored key | `scripts/check-agentify.mjs` |
| Dedup by text (§10.4, deterministic half) | done — exact-text collapse and the `entityKey` entity block, no model involved | `scripts/check-agentify.mjs` check 8 |
| Dedup by embedding shortlist + model adjudication (§10.4, adjudicated half) | **struck at 0.1.0 — OPEN_QUESTIONS §7ap.** Disabled by default, behind `--dedup-adjudicate`. On every fixture that exists, **the LLM dedup path currently changes nothing**: `--llm` and `--no-llm` produce byte-identical output, because §2.14.1's veto blocks the one merge the adjudicator proposes. Measured on `CORPUS.md` §2.17, the first uncontaminated grading set: recall **0 of 3**, and the veto took false merges from 1 to 0. Every earlier number is withdrawn — §2.16's were the adjudicator reciting worked examples out of its own prompt. Reason and scope in OPEN_QUESTIONS §7ap and `docs/ROADMAP.md` | `scripts/check-agentify.mjs` check 8, `scripts/check-fixture-contamination.mjs`, docs/CORPUS.md §2.17 |
| Conflict report (§10.4) | done — **2/2** recall, **0** false positives | `scripts/check-agentify.mjs` |
| Budget and progressive disclosure (§10.5) | done — 31 primary / 9 secondary at a 600-token budget, nothing lost | `scripts/check-agentify.mjs` |
| The traceability gate (§10.6) | done, **and checked for its ability to fail** | `scripts/check-agentify.mjs` |
| Provenance manifest (§10.7) | done, byte-identical across runs | `scripts/check-agentify.mjs` |
| Incremental regeneration (§10.8) | **done for change detection, struck for unit reuse** — OPEN_QUESTIONS §7am. Unchanged sources are detected by content hash and reported; every unit is re-extracted on every run, and a reuse cache that went stale would put wrong content in a generated file | `scripts/check-agentify.mjs` check 3, OPEN_QUESTIONS §7am |
| `markforge agentify` (§8) | done — `--targets`, `--budget`, `--dry-run`, `--explain-drops`, `--strict`, `--json` | `scripts/check-agentify.mjs` |
| Reverse direction (§10.10) | **struck** — OPEN_QUESTIONS §7ae. A stretch that survived five phases with no corpus is declined rather than deferred | OPEN_QUESTIONS §7ae, `docs/LIMITS.md` |

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

The cache is committed and the path is offline-reproducible: two `readOnly` runs with no key
present are byte-identical, and `--llm` differs from `--no-llm` by exactly the one merged
line. Both are CI jobs.

**Corrected again, 2026-08-01: every dedup number above is withdrawn, and the replacement is
worse.** `CORPUS.md` §2.16 — the set authored to replace §2.14's retired pairs — had all three
of its graded cases sitting inside the adjudicator prompt that grades them. Two sentence pairs
verbatim; the third given away by its numbers and its verdict (*"24 hours and 7 days are
different facts"*). The rule that retired §2.14's pairs was prose applied by hand, and its own
replacement broke it three times.

`scripts/check-fixture-contamination.mjs` is that rule as a gate: verbatim containment, a
shared six-content-word run, and the signature predicate that caught the third case. §2.17 is
the replacement, authored afterwards and clean under all three. Measured:

| Arm | §2.16 (contaminated) | §2.17 (clean) |
| --- | --- | --- |
| Recall | 1 of 1 | **0 of 3**, all compared and rejected |
| False merges | 0 of 2 | **1 of 2** |

The false merge is the serious half: *"A sealed document must **never** be re-issued under the
same reference"* was merged with *"A sealed document must be re-issued under a fresh
reference"*, reasoning *"Keeping A would drop nothing."* `check-merge-predicate.mjs`
independently says those drop `never` and are different facts, so the predicate is right and
the model is wrong on a case where merging deletes a prohibition. **The adjudicated path is
therefore off by default at 0.1.0** — see the deferred row above. No prompt has been changed:
tuning against these cases would contaminate them and destroy the only clean §10.4 evidence
there is.

**§2.17 also found the precision arm could pass vacuously.** On its first run the category
block separated all six pairs and the arm read 3/3 on cases nothing had compared. The clean
set has separated *compared and rejected* from *never compared* since §7q; this set did not.
It does now. The cause is a system limitation, recorded as `OPEN_QUESTIONS` §9: one filename
matching the `codingConventions` signal routes **every** sentence in that document to a
different category, and §10.4 then blocks every cross-document merge involving it.
`MF-AGENT-0012` now counts those pairs, so the cost is visible per run.

**Corrected 2026-08-01:** that second claim used to be made about the *clean* set, where it
held because of a sentence-split merge. Adjudicator prompt v2 correctly declines that merge —
it drops `partial` and `never`, which §2.14.1 counts as scope — so the clean set now merges
nothing and the CI job failed for the right behaviour. It runs on
`fixtures/agentify/dedup` (CORPUS §2.16), which contains a genuine near-duplicate, and the
diff is one line there.

Worth recording separately: the identical stale assertion existed in **two** places, and
fixing `check-agentify.mjs` did not fix `ci.yml`, because `pnpm verify` does not run the
workflow. The local suite was green and CI was red for the same commit. That is the Phase 1
lesson — *a check that has never run is not a check* — arriving from the opposite direction:
here the check ran and the local proxy for it did not.

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

| Prerequisite | State | Verified by |
| --- | --- | --- |
| `CORPUS.md` §2.14 source sets | done before the phase — 10 documents, three sets, authored answer keys | `scripts/check-agentify.mjs` |
| Near-duplicate pairs proven beyond lexical reach | done — both score Jaccard 0.000 | `scripts/check-agentify.mjs` |
| `embed` role and `context-unit-dedup` binding | done (Phase 3, OPEN_QUESTIONS §7c) | `scripts/check-agentify.mjs` |
| `target.v0.schema.json` | done (Phase 0), and it needed no changes | `scripts/check-agentify.mjs` |
| Everything in §10.1's ingest path | done — all ten documents parse with zero lossy diagnostics | `scripts/check-agentify.mjs` |

**Building the corpus first paid off exactly as intended.** Phase 3's criterion named an
"ambiguous subset" that did not exist, and was unmeasurable rather than unmet until one was
authored. Phase 4's criterion was measurable on day one, and the authored keys caught two
things a captured snapshot could not have: the classifier traps (`architecture.md` answers
`decisionRecord`, `service-overview.md` answers `architecture`) and the false conflict above.

**Six** of the ten bound LLM tasks still have no prompt file. Phase 4 wrote one —
`context-unit-summarization/v1.md`, the near-duplicate adjudicator — and wired the embeddings
path, which needs none. `document-role-classification` and `context-unit-extraction` remain
unwired for the reason in OPEN_QUESTIONS §7o: this corpus cannot grade them.

Counted rather than recalled: `DEFAULT_TASK_ROLES` binds ten tasks, `packages/llm/prompts/`
holds three (`context-unit-summarization`, `heading-tiebreak`, `page-transcription`), and
`context-unit-dedup` needs none because it is an embedding call. Ten minus three minus one is
six — `document-role-classification`, `context-unit-extraction`, `alt-text`,
`conflict-analysis`, `glossary-extraction`, and `table-structure-recovery`.

> **Corrected 2026-08-01 (Phase 6, W0).** This read "Five" from Phase 4 until now, and the
> figure had been propagated outward rather than inward: it is the number the Phase 6 brief
> itself carries in W7. A wrong count in a ledger becomes a wrong requirement in the next
> brief, which is the reason W0 runs before anything that would build against it.

## Phase 5 — distribution

**Done when** the same input produces byte-identical output through the CLI, the HTTP API,
the MCP server, and the browser build with `MODEL_API_KEY` unset, and the browser bundle's
freedom from `node:` builtins and the HTTP API's no-retention claim are each measured by a
check that has been seen to fail.

Phase 5 was the only phase in `INIT.md` §11 with no done-criterion. The sentence above was
proposed and agreed before any code was written, and §11 is amended to carry it (§7r).

**The done-criterion is met, and all three clauses are CI jobs with negative controls.**

| Half | Measured | Where |
| --- | --- | --- |
| Four surfaces, byte-identical | **30 conversions × 4 surfaces, all identical** | `check-surface-parity.mjs`, CI job `determinism` |
| No `node:` builtin in the browser bundle | 9 eager packages clean; `core`'s entry chunk clean across 6 chunks | `check-browser-bundle.mjs`, CI job `build` |
| No document retention | 4 probes, all 4 catch a deliberately retaining control | `check-http-retention.mjs`, CI job `build` |

| Deliverable | State | Verified by |
| --- | --- | --- |
| `@markforge/http` and `markforge serve` | done — `node:http` only, no framework | `scripts/check-http-retention.mjs` |
| `@markforge/mcp` and `markforge mcp` | done — hand-written JSON-RPC over stdio, `convert`/`fmt`/`agentify` | `pnpm test` (`packages/mcp/test/mcp.test.ts`) |
| `@markforge/browser` | done — bytes in, bytes out, no filesystem; md/docx/html only | `scripts/check-browser-bundle.mjs` |
| GitHub Action | done — `action.yml`, and **this repository's own CI consumes it**, on both halves: the dogfood step runs it against a built tree, and a second job runs it on a clean one so the build path a consumer takes is not the one path nothing tests | ci.yml jobs `determinism` (`uses: ./`) and `The Action builds from source on a clean runner` |
| GitHub Marketplace listing | done — `MarkForge Document Check`, published from tag `v0.1.0`. The name is a phrase because the Marketplace rejects one matching a GitHub user, and the description is 115 characters because it rejects 125 or more (§7aq) | `scripts/check-docs.mjs` §14a-iv, `README.md` |
| Documentation site | **descoped** (§7s) — replaced by quickstarts whose commands run in CI | OPEN_QUESTIONS §7s |
| Published packages | **struck** (§7r) — contradicts `OPEN_QUESTIONS` §5; nothing un-privated | OPEN_QUESTIONS §7r, `scripts/check-docs.mjs` (all packages private) |
| ADR-0015 ratified | done — moved off `Proposed`, **amended in three places** | `scripts/check-adr-enforcement.mjs` |
| Playwright against the same fixtures | **struck** — OPEN_QUESTIONS §7ah. The `vm` sandbox has no DOM, no `fetch`, no worker, and no real event loop, and `docs/LIMITS.md` records what that cannot see | OPEN_QUESTIONS §7ah, `docs/LIMITS.md` |

### ADR-0015 was wrong about every package it named

It listed ten packages that "run fully in-browser" and sat at `Status: Proposed` for four
phases because nothing built it. The first run of `scripts/check-browser-bundle.mjs` failed
**all ten**.

Nine failed for one shared reason — they all depend on `@markforge/ir`, which reached Node in
three files: `node:crypto` in `node-id.ts`, and a runtime `readFileSync` of
`ir.v0.schema.json` in both `salient.ts` and `validate.ts`, plus `createRequire` for ajv's CJS
interop. `@markforge/ooxml` was the only package in the repository that bundled for a browser.

The fix was small and local, which is the ADR's own argument for not deferring the browser
build arriving early in miniature. Node ids are unchanged, measured on both sides rather than
reasoned: all seven Markdown fixtures produce byte-identical id lists, and `@noble/hashes`
matches `node:crypto` over 306 inputs.

Three claims are amended rather than quietly narrowed:

- ~~**`render-pdf` is named in the lazy tier and does not exist**~~ — **stale from Phase 5
  until 2026-08-02.** It was built 2026-08-01, so the sentence was already false when the
  paragraph beneath it was being read, and its second half — *"the gate says so on every
  run"* — was false too: `check-browser-bundle.mjs` §3 took the `ok` branch and said the
  opposite. Two wrong claims in one bullet, in the section about amending claims rather than
  quietly narrowing them. The tier is ratified for all three members, and §3 is deleted
  rather than left as a loop over a one-element list that can no longer fail.
- **"Lazy" and "browser-capable" are different properties.** The deferred `adapters-pdf`
  chunk still imports `node:module`, `node:path`, and `node:zlib`. Deferring it means a user
  converting DOCX to Markdown does not download it — that argument holds. It does not mean
  PDF works in a browser.
- **The lazy tier is drawn around packages, and the package is the wrong unit.** The ADR's
  stated reason is weight, but `@markforge/adapters-ocr` bundles at **397 KB with no
  Tesseract in it at all** — the recogniser is injected (ADR-0017), so the heavy artifact
  sits behind the injection point rather than behind the import. The gate asserts on
  `tesseract.js`, `pdfjs-dist`, and `typst` instead.

### What building it found

**The browser build had a determinism hazard nobody would have looked for.**
`platform: "browser"` makes esbuild prefer the `browser` export condition, and
`decode-named-character-reference` uses that to swap in `index.dom.js`, which decodes HTML
entities by **writing them into a detached `<i>` element and reading `textContent` back**.
Sensible in a page. Here it routes entity decoding through the host's HTML parser, so browser
output would depend on the browser — against a criterion of byte equality with the CLI, in
the one direction nobody would think to test. The `worker` condition selects the same
table-based module Node loads: measured, it changes exactly one package's resolution and
costs 47 KB.

**`--llm` against an unreachable endpoint exited 0 with `ok: true`,** and it took two
corrections to state that accurately. The check first used `clean-report.md`, which produces
**zero** ambiguous heading decisions — so `--llm` had nothing to ask and exiting 0 was
correct. A check that cannot provoke a model call cannot detect a broken one. Then, with the
ambiguous fixture, it reported the finding as a *silent* fallback, which was **wrong**:
`llmFailures` carried all four failures in the `--json` envelope and the run report showed
`failures: 4, liveCalls: 0`.

What was true is narrower and still a defect. No `Diagnostic` was emitted, so `--strict` could
not see it and `reportDiagnostics` did not print it — `MF-LLM-0001` existed with an emission
site for one case and none for this one. `resolveAmbiguities` swallows the exception with the
comment "the caller diagnoses the failure with its own vocabulary"; the caller did half of
that. Now each failure carries an `MF-LLM-0001` warning, and a run where `--llm` was requested
and *every* call failed exits 1 with `ok: false`.

**Corrected 2026-08-01, third time on the same claim: `--strict` was never run against it.**
Everything above asserts the *precondition* — `degraded: true` on the diagnostic — and stopped
one step short of the flag that consumes it. Adding `--strict` to that run looks like closing
the gap and closes nothing: with the endpoint unreachable, `llmTotallyFailed` exits 1 before
the flag is read, so the run exits 1 with the flag and 1 without. **Measured, both.** The first
attempt at this fix asserted exactly that vacuous pair and passed.

The discriminating case is a **partial** failure, which is also the common one. Three of the
fixture's four committed tie-break answers are copied into a cache, the run is `readOnly` with
no key, and the fourth call misses: nothing is lost, and `--strict` is the only reason to fail.
Measured: **exit 0 without the flag, exit 2 with it.** Both codes are asserted, because the
pair is the claim. `scripts/check-surface-parity.mjs` §3.

**Two more found by enumerating the degrading paths rather than reading about them.**
`scripts/check-degradation.mjs` classifies all 30 `catch` blocks, and its one checkable
consequence — an `emits MF-XXX-0000` annotation must name a code the file can raise — was
**vacuous**: it searched a file that contains the annotation making the claim, so every
annotation satisfied itself. Under it sat a wrong one, `emits MF-PDF-0004`, a code no
`DiagnosticCode` entry defines; the real one is `MF-PDF-0002`. The search now excludes
annotation lines and resolves codes against the table parsed out of
`packages/ir/src/diagnostics.ts` rather than a two-entry map maintained in the gate. The old
negative control passed throughout, because it asserted only that the regex *exposed* the code
and never ran the presence test on it.

**Two of the four degrading paths had no test at all.** `adapters-pdf/src/pages.ts` and
`llm/src/assist.ts`'s vision recogniser were annotated and never executed. Both are forced now
— `packages/adapters-pdf/test/pdf.test.ts` throws from the object store and asserts
`MF-PDF-0002` with `lossy: true`; `scripts/check-surface-parity.mjs` §3b converts a scan
against a dead endpoint and asserts the page is reported lost.

**`targets/mcp-manifest.json` was wrong in three ways at once, and its own `honestyNote` was
wrong about the profile it was attached to.** The note said the manifest named
`markforge serve`; the scaffold said `npx -y @markforge/mcp`. `markforge serve` is the HTTP
API and would hang if an MCP client spawned it on stdio. And `npx @markforge/mcp` names a
package nothing publishes and nothing may publish (§5), so it could not have worked from any
checkout. **`STATUS.md` and `docs/TARGETS.md` both repeated the `markforge serve` claim**,
inheriting the error from a field whose name is `honestyNote`.

**Two of the browser gate's own checks were wrong first**, both caught by reading output
against what is on disk rather than by reasoning about it. It reported the absent
`render-pdf` as **present**, because it inferred existence from an esbuild error whose
wording for a missing entry point matches its wording for a builtin. And its negative control
for Node globals read `process.env.NODE_ENV` — the one key esbuild constant-folds — so the
control bundled to `var mode = "development"` with no `process` in it and proved the predicate
silent rather than working.

**A predicate that flagged nine clean packages.** The Node-global check first searched for the
substring `require(`, which matched ajv's *standalone code generation* templates — string
literals never executed here — and esbuild's `__commonJS` wrapper. Narrowed to
`Dynamic require of`, esbuild's own marker for a require it could not resolve. Narrowing a
predicate is how a check stops catching anything, so the negative control was added in the
same change.

### The §7q ruling resolved the contradiction and did not produce the merge

`OPEN_QUESTIONS` §7q was open: `CORPUS.md` §2.14 calls two units the same fact, `SPEC.md`
§10.4 blocks cross-category merges, and both could not be right. Ruled: an ADR statement that
**asserts a rule** is filed as a `constraint` rather than a `decision`, leaving §10.4's block
intact.

Applied and measured, ADR-2's statement is now a `constraint`, both sides sit in one category,
and the pair **reaches the adjudicator for the first time**. The adjudicator judged them
different facts. Recall still reads **0 of 2**.

The category block was *masking* a disagreement about meaning rather than causing it — and
those two states are indistinguishable from the number alone, which is how §7q stayed open for
a phase. `check-agentify.mjs` now separates "never compared" from "compared and rejected";
under the old reporting both read `0/2`.

> **Closed 2026-08-01 (Phase 6, §7w).** §7q left one question open — is `CORPUS.md` §2.14
> right that these are one fact? — and the answer is **no, on both pairs**. It is not a matter
> of taste: §2.14.1's predicate decides it, and merging pair 1 drops `more` and `second` while
> merging pair 2 drops `whole`. **The adjudicator was right and the answer key was wrong**, so
> the `0 of 2` above was the correct answer to a question whose key was incorrect — a fixture
> error, not a pipeline failure.
>
> What is worth recording is that this was already true when it was written. `CORPUS.md`
> §2.14.2 applied the predicate and retired both pairs on 2026-08-01, and neither §7q above it
> nor this section below it was updated to match — so three documents disagreed about one
> countable fact for the length of a phase, with the corpus holding the right answer and the
> ledger reporting the wrong framing. Found by W0 reading them against each other rather than
> by any gate, which is the argument for W0 existing.

## Unbuilt CLI surface

`SPEC.md` §8 specifies seven subcommands. **All seven are done**, as of 2026-08-02, when
`check --fidelity` closed the last clause. An eighth, `mcp`, is delivered and is not in §8's
table (§7u). Every exit code in §8's table — 0 through 5 — now has a test that produces it,
which was not true of 4 or 5 before this pass (§7ak, §7al).

> **Corrected 2026-08-01 (Phase 6, W0).** This paragraph said "Three work. The other four
> refuse by name" and had disagreed with the table directly beneath it since Phase 5 added
> `serve` and `mcp`. Only two commands refuse by name, not four. The prose was written when it
> was true and was never re-read against the rows it introduces — which is the same failure as
> the corpus counts above, in a section short enough that the contradiction is visible without
> scrolling.

| Command | State | Verified by |
| --- | --- | --- |
| `convert`, `fmt` | done | `pnpm test` (`packages/cli/test/cli.test.ts`) |
| `check` | **done** — validates documents against the IR schema, reports reference-document style coverage (`--reference-doc`), probes the LLM endpoint (`--llm`), and measures named documents against committed baselines (`--fidelity`, with `--tolerance` and `--md-flavor`), exiting 4 on a regression. The fidelity clause was the last unbuilt part of SPEC §8 and was what made exit 4 unreachable (§7ak) | `pnpm test` (`packages/cli/test/cli.test.ts`), `describe("SPEC §8 exit codes")` |
| `agentify` | **done** — `--targets`, `--budget`, `--dry-run`, `--explain-drops`, `--strict`, `--json`. Exit 5 is the traceability gate and has no bypass flag (SPEC §10.6) | `pnpm test` (`packages/cli/test/cli.test.ts`) |
| `serve` | **done** (Phase 5) — stateless HTTP API, loopback by default, no document retention, measured | `pnpm test` (`packages/cli/test/cli.test.ts`) |
| `mcp` | **done** (Phase 5) — not in SPEC §8's seven; `serve` is HTTP and an MCP client on stdio needs its own command (§7u) | `pnpm test` (`packages/cli/test/cli.test.ts`) |
| `diff`, `init` | **done** — `diff` is a semantic IR diff with `--metric` (the second consumer `OPEN_QUESTIONS` §7a promised `@markforge/fidelity` would have); `init` scaffolds config and lint config with `--print-config` and refuses to overwrite | `pnpm test` (`packages/cli/test/cli.test.ts`) |

## Reader gaps the Phase 6 corpus exposed

`CORPUS.md` §2.2 and §2.12 had never been built, so no committed fixture contained a
footnote, an equation, or a comment. Building them found three reader defects in one
afternoon — the pattern trap 1 predicts, arriving on schedule.

| Gap | Effect | Reported | Verified by |
| --- | --- | --- | --- |
| ~~Unrecognised inline elements dropped silently~~ | **fixed** — the phrasing walk ended in `default: break` while the block walk beside it obeyed adapter rule A6. Five OMML equations in the shipped `academic-manuscript.docx` vanished with no diagnostic. Now an `unknown` node plus `MF-DOCX-0052` | n/a | `packages/adapters-docx/test/parse.test.ts` ("A6 at the inline level", 3 of 4 fail without the fix) |
| ~~`footnotes.xml` and `endnotes.xml` are never read~~ | **fixed 2026-08-01** — both parts are read and their definitions appended after the body, so `[^1]` resolves. `docs/MAMMOTH-DIFF.md` now reports the opposite shape: our footnote definitions against Mammoth's ordered list, triaged as a representation difference | n/a | `scripts/check-ir-structure.mjs` (declares 3 references and 3 definitions), `scripts/build-corpus-fixtures.mjs --check` |
| ~~Comments are dropped as property elements~~ | **fixed 2026-08-01, and corrected 2026-08-02.** The first fix emitted the comment at document level with an `anchors` id list, which the schema's `Comment` forbids — so every document with a comment produced an invalid IR for a day. The range is now wrapped as SPEC §2.3 always required, an unanchored comment is dropped **and counted** (MF-DOCX-0062), and a range crossing a paragraph boundary says so (MF-DOCX-0061) | n/a | `scripts/check-ir-structure.mjs` (declares 2 comments, and validates every fixture) |
| ~~Table-cell block content is concatenated with no separator~~ | **fixed 2026-08-01** — `textContent` in `@markforge/ir` was joining a cell's block children with nothing, so three paragraphs become `Stop the intake.Wait for depth…` and a nested table becomes `keyvaluemodestrict`. SPEC §9.2 requires block nodes to join with a blank line. **Located by running `textContent` on the parsed cell, not inferred from the differential** | n/a | `scripts/check-ir-structure.mjs` (both strings declared by hand, and the rule scanned across the corpus) |
| ~~`revisionMode` is applied nowhere on the **Markdown** render path~~ | **fixed 2026-08-02** — all three renderers now mean the same three things by it: `clean` emits the accepted text and diagnoses each dropped deletion, `showInsertions` marks insertions, `showAll` adds `~~strikethrough~~`. `docs/MAMMOTH-DIFF.md`'s two rows for it are resolved, including the half where the *comparison* was reading the IR rather than the output | n/a | `docx/tracked-changes-two-authors.docx` (§2.12), `scripts/diff-mammoth.mjs --check` |
| ~~`--emit-ir` and `--report` do not exist~~ | **fixed** — both built 2026-08-01. The IR is written with `canonicalJsonPretty`, so SPEC §2.7's canonical form makes two runs byte-identical and the file diffable | n/a | `packages/cli/test/cli.test.ts` |

**Every row in this table is now struck through.** The one that mattered most was the footnote
reader, and the reason was the output rather than the loss: `[^1]` pointing at a definition
that does not exist is not degraded Markdown, it is **invalid** Markdown. `SPEC.md` §3.1 lists
footnotes and endnotes under "Also extracted"; now something extracts them.

**And a second blind spot, from the same fixture.** `tables-block-content` scores **100% on
every metric** through `docx → md → docx` while carrying the concatenation defect above. That
is not a broken metric: `textContent` is applied to *both* sides of the round trip, so the
same wrong string is compared against itself and agrees perfectly. **A defect applied
symmetrically to both sides of a round trip is invisible to a round-trip metric** — the same
shape as the census blind spot, reached from a different direction. What makes this one real
rather than cosmetic is that agentify's sentence segmentation is *not* symmetric: a cell whose
paragraphs run together produces context units spanning a boundary that does not exist.

**Why the node-type census could not see any of this.** The census diffs input IR against
round-tripped IR, so it only sees node types that reach the IR *at least once*. A construct
no adapter ever produces is absent from both sides and scores as agreement:
`equationBlock` read 0 against 0, `footnoteDefinition` read 0 against 0, `comment` read 0
against 0. The census exists because aggregate scores hid four format-destroying defects;
it has a blind spot of the same shape, and nothing in this repository said so until now.

## Corpus coverage

`CORPUS.md` names 15 categories. Phase 1 required eight — `CORPUS.md` §5's build order names
2.1, 2.3, 2.4, 2.5, 2.11, 2.12, and 2.13, and promotes 2.15 to Phase 1 on evidence. **All eight
are complete.** Across all fifteen: **twelve complete, three struck, none partial.**

> **Corrected 2026-08-01 (Phase 6, W0).** This section and the Phase 1 table above disagreed
> about a countable fact for three phases: the table said "7 of the 8 categories" and this
> paragraph said "eight of them; five exist". Neither was right, and the two could not both
> be. Resolved against `CORPUS.md` §5, which is the only place the Phase 1 requirement is
> actually enumerated.
>
> The second half of the correction is worse than the first. Every row below cited
> `scripts/check-fixtures.mjs` as its verifier, and **that script asserts nothing about
> categories** — it enforces `fixtures/LICENSES.md` in both directions and stops. Fifteen rows
> named a gate that could not fail for the reason the row claimed. `docs/GATES.md` now records
> what each gate actually asserts, which is what made this visible.

| Category | State | Verified by |
| --- | --- | --- |
| 2.1 clean reports | done | `scripts/check-fixtures.mjs` category coverage |
| 2.4 nested and restarting lists | done | `scripts/check-fixtures.mjs` category coverage |
| 2.5 tables with merged cells | done — 2 HTML plus 4 authored DOCX: `w:gridSpan`, `w:vMerge` restart/continue, a two-row header, a header column, block content in cells, and a nested table | `scripts/check-fixtures.mjs` category coverage, `scripts/build-corpus-fixtures.mjs --check` |
| 2.11 emoji and Unicode | done | `scripts/check-fixtures.mjs` category coverage |
| 2.13 Markdown flavours | done — all seven SPEC §4.1 presets **built as data** (ADR-0021) and gated on producing seven byte-distinct renders of one construct-dense probe. `markdown.flavor` was a config-schema value read by nothing until now | `scripts/check-flavor-distinctness.mjs` |
| 2.2 manuscripts with footnotes and equations | done — 2 authored DOCX: footnotes with Word's separator entries, endnotes, display and inline OMML, a REF cross-reference. **Authoring them found the adapter never reads `footnotes.xml`** | `scripts/check-fixtures.mjs` category coverage, `scripts/build-corpus-fixtures.mjs --check` |
| 2.3 badly formatted real-world documents | done — 7 fixtures, asserted defect by defect (the seventh is the Phase 3 ambiguous subset) | `scripts/check-fixtures.mjs` category coverage |
| 2.6 multi-column PDFs | **struck** — OPEN_QUESTIONS §7ac. Column detection stays unit-tested against synthetic geometry and unmeasured against a real document | `scripts/check-fixtures.mjs` category coverage |
| 2.7 scanned PDFs | **done** — 3 synthesized (1 committed, 2 generated), 1 found scan fetched on demand; 2nd dropped with reasons | `scripts/check-fixtures.mjs` category coverage |
| 2.8 slide decks | **struck** — OPEN_QUESTIONS §7ac. The PPTX adapter is unit-tested and carries no fidelity row | `scripts/check-fixtures.mjs` category coverage |
| 2.9 spreadsheets | **struck** — OPEN_QUESTIONS §7ac. The XLSX adapter is unit-tested and carries no fidelity row | `scripts/check-fixtures.mjs` category coverage |
| 2.10 RTL and CJK | done — 4 authored documents (Arabic, Hebrew, Japanese, Simplified Chinese), all marked `PROVISIONAL`. **The native-speaker review did not happen**; CORPUS §2.10.1 states what they are and are not trusted for | `scripts/check-fixtures.mjs` category coverage |
| 2.12 tracked changes and comments | done — 3 authored DOCX; `w:ins`/`w:del` read as wrapping nodes, including overlapping revisions from two authors, and comments wrap the range they annotate with the reviewer's note carried in `body`. An unanchored comment is dropped **and counted** | `scripts/check-fixtures.mjs` category coverage, `scripts/build-corpus-fixtures.mjs --check` |
| 2.14 agentify source sets | done — 10 documents, 3 sets, authored answer keys, all measured in `docs/AGENTIFY.md` | `scripts/check-fixtures.mjs` category coverage, `scripts/build-agentify-corpus.mjs --check` |
| 2.15 library- and LLM-generated documents | done — 3 of 4 producer profiles: two synthesized, plus a **real pandoc 3.10 export** generated at check time rather than committed, because a Pandoc DOCX carries Pandoc's GPL reference styles. Its first run found `outlineLevel` capped at 8 against ISO/IEC 29500-1's 0-9, which had made every Pandoc-produced document invalid. The LibreOffice profile is struck (§7aj) | `scripts/check-producer-exports.mjs` |

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

## What the census found

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
