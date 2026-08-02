# Limits — what this toolkit cannot do

A reader who trusts only this document should not be surprised by anything MarkForge does.
That is the bar, and it is deliberately higher than "the known bugs are listed": a limit is
not only a defect, it is also a number that is not calibrated, a metric that cannot see its
own blind spot, and a capability a specification once described and no longer does.

Every entry names how it is known. Where a gate holds it, the gate is named — a limit nothing
measures is a limit that drifts.

---

## 1. Struck capabilities

Each was promised somewhere and will not be delivered. The ruling is linked; the ruling names
what was lost.

| Capability | Struck by | What is lost |
| --- | --- | --- |
| Published packages | `OPEN_QUESTIONS.md` §7r | Nothing installs from a registry. Every package stays `private: true`; the GitHub Action builds the CLI from source |
| Documentation site | `OPEN_QUESTIONS.md` §7s | No browsable docs. Per-surface quickstarts in `README.md`, with their commands executed in CI |
| Package name, scope, publication as an open question | `OPEN_QUESTIONS.md` §7v | `OPEN_QUESTIONS.md` §5 is closed permanently rather than deferred; the name `markforge` is not checked for availability |
| `citation` node type | `OPEN_QUESTIONS.md` §7ab | A Word citation field flattens to its cached result (`MF-DOCX-0053`); the field code does not survive. No Pandoc `[@key]` support |
| `textBox` node type | `OPEN_QUESTIONS.md` §7ab | A DOCX text box becomes an `unknown` node with a lossy diagnostic. Its text is reported, not placed in reading order |
| Model registry, routing policy, capability tags | ADR-0009 | Brief §7.2's generated registry does not exist. Three model names in config replace it |
| Multi-column PDF corpus (§2.6) | `OPEN_QUESTIONS.md` §7ac | Column detection is unit-tested against synthetic geometry, never against a real multi-column PDF. `FIDELITY.md` has no row for interleaved text, the defect the category exists to catch |
| Slide-deck corpus (§2.8) | `OPEN_QUESTIONS.md` §7ac | The PPTX adapter is unit-tested and unmeasured; no fidelity number describes it |
| Spreadsheet corpus (§2.9) | `OPEN_QUESTIONS.md` §7ac | The XLSX adapter is unit-tested and unmeasured. Merged ranges and formula-versus-result are untested against a real workbook |
| Visual regression (brief §10) | `OPEN_QUESTIONS.md` §7ad | **Nothing catches a change that is visually wrong and structurally identical** — a heading font, a margin, a line-height. The PDF path has byte-identity instead, which is stronger about change and silent about quality; the DOCX path has neither |
| Reverse direction, repository to context units (§10.10) | `OPEN_QUESTIONS.md` §7ae | `agentify` reads documents, not code. A repository with good code and poor documentation gets a poor `CLAUDE.md` |
| PDF figure and caption binding | `OPEN_QUESTIONS.md` §7af | A figure and its caption stay two adjacent blocks; the binding SPEC §2.3 declares is never made from PDF geometry |
| PDF table recovery | `OPEN_QUESTIONS.md` §7af | A table laid out with whitespace is emitted as prose with a *possibly present* diagnostic. Honest, and not a table |
| Playwright against the browser build | `OPEN_QUESTIONS.md` §7ah | The `vm` sandbox has no DOM, no `fetch`, no worker, no real event loop. A defect needing one of those is invisible to it — including the entity-decoding hazard ADR-0015 records, which needs a host HTML parser to manifest |
| LibreOffice producer profile (§2.15's fourth) | `OPEN_QUESTIONS.md` §7aj | One more OOXML encoding of a document we have three encodings of. A headless LibreOffice in CI is a ~400 MB install per run, with the same unexamined-licence question about its exported styles |
| Incremental *unit reuse* (§10.8) | `OPEN_QUESTIONS.md` §7am | Changed sources are detected and reported; every unit is re-extracted on every run. Nothing is stale and nothing is saved |
| "Real-world messy PDF converts cleanly" | `OPEN_QUESTIONS.md` §7an | No claim is made about PDFs we did not generate. It depended on §2.6, which is struck |
| Inline OMML equations | `OPEN_QUESTIONS.md` §7ao | An equation inside a sentence becomes an `unknown` node carrying its markup, with a lossy diagnostic. The IR has no inline OMML slot and `inlineMath` is TeX |
| Model-adjudicated dedup (§10.4's adjudicated half) | `OPEN_QUESTIONS.md` §7ap | Near-duplicate merging rests on the deterministic predicate alone. Two sources stating one rule in different words stay two units, and the budget pays for both. `--llm` and `--no-llm` produce byte-identical agentify output on every fixture that exists |
| Third-party adapter loading | `docs/ROADMAP.md` | `@markforge/ir` is designed so an adapter can be written; no loader exists, so one cannot be loaded |

---

## 2. Format limits — the construct cannot survive the target

These are not defects. The target format has no way to express the construct, so the loss is
inherent and the only question is whether it is reported. All of them are.

| Construct | Target | Behaviour |
| --- | --- | --- |
| Merged table cells | Markdown (GFM) | `markdown.tables: auto` switches the whole table to HTML; `gfm` flattens and emits a `degraded` diagnostic naming what went. A merged 6-cell table re-parses as 8 cells with 3 on their original coordinates |
| Block content in a table cell | Markdown (GFM) | Same policy. A GFM pipe cell holds one line of inline content |
| Figure, caption, description list | Markdown | No syntax exists. Text survives, the construct does not; reported since the census found it |
| Description list | DOCX | No DOCX element. Needs a named-style convention plus a recovery pass |
| A list inside a fenced admonition | Docusaurus, MkDocs, Pandoc | Those three admonition forms are emitted as raw blocks, so their bodies are flattened to text and list markers are lost (ADR-0021) |
| Tracked changes | Markdown | No native syntax. `revisionMode` is honoured as of 2026-08-02 on all three surfaces: `clean` (the default) emits the accepted text and diagnoses each dropped deletion, `showInsertions` marks insertions with `<ins>`, `showAll` adds `~~strikethrough~~`. Until then this renderer ignored the option and emitted both sides of every edit — `fortyfifty`, `someall`. `fixtures/docx/tracked-changes-two-authors.docx` |
| OMML equations | Markdown, HTML | Markdown math is TeX and HTML math is TeX or MathML; there is no OMML converter here, so the equation's *structure* is lost. The source is retained — a fenced ` ```omml ` block in Markdown, a `<pre>` inside the math div in HTML — and the loss is diagnosed. Both surfaces show it rather than one hiding it, which costs text fidelity on the two manuscript fixtures: `docs/FIDELITY.md` says how much and why |
| Inline OMML equations | The IR itself | No node type fits: `equationBlock` is block content, `inlineMath` holds TeX. The equation becomes an `unknown` node carrying the markup, with a lossy diagnostic (§7ao) |

---

## 3. Uncalibrated numbers

Numbers that look like measurements and are not. Each is monotonic or indicative, none is
calibrated against ground truth.

- **Token counts use 3.8 characters per token** (ADR-0019). Not calibrated against any consumer
  model. `modelTokenizer` refuses rather than silently approximating, so a report never puts an
  estimate under the name of a measurement.
- **PDF extraction confidence is not a probability** (`SPEC.md` §3.3, `OPEN_QUESTIONS.md` §7h).
  It is required only to be monotonic in the strength of the evidence. "Escalate the least
  confident decile" is meaningful; "this node is 80% likely correct" is not.
- **Fidelity percentages are corpus-relative.** They describe *authored* documents. Nothing in
  the corpus was found in the wild.

---

## 4. What the measurements cannot see

The most important section, because these are limits of the instruments rather than of the
toolkit, and an instrument's blind spot looks exactly like success.

**A node type that never reaches the IR scores as agreement.** `docs/FIDELITY.md`'s census
diffs input IR against round-tripped IR. A type no adapter produces is absent from *both*
sides, differences to zero, and reads as clean. Four types sat at `0 → 0`: `equationBlock`,
`comment`, `citation`, `textBox`. The first two are now built; the last two are struck.
Held by `scripts/check-node-type-coverage.mjs`.

**A defect applied symmetrically to both sides of a round trip is invisible to a round-trip
metric.** `fixtures/docx/tables-block-content.docx` scores 100% on every metric through
`docx → md → docx` while `textContent` joins a cell's block children with no separator, so
three paragraphs read as `Stop the intake.Wait for depth…`. The same wrong string is compared
against itself and agrees perfectly. Held by `scripts/check-ir-structure.mjs`, which compares
parsed IR against an authored declaration rather than against its own round trip.

**A validity check that only ever ran on two of the three input formats saw nothing.** Every
fixture-backed IR-validation test began from DOCX or HTML, so `markforge check` reported
**INVALID IR** on a committed Markdown fixture for five phases while `pnpm verify` stayed
green. Held by `scripts/check-ir-structure.mjs` §3b, which validates *every* committed fixture
through *its own* adapter — the same assertion, applied to the format nobody had applied it to.
Its first run found five further defects across three adapters.

**Agentify's traceability metric is one-directional, and an empty file scores 100%.** It asks
"does every sentence in the output trace to a context unit", not "did every unit reach the
output" (SPEC §10.6). A source document with no agent-relevant content correctly yields no
units, an empty file, and `traceability 100.0%`. The other direction is `--strict` and
`--explain-drops`, which report every unit and sentence that did not land.

**A differential test can report a divergence its own reduction invented.**
`scripts/diff-mammoth.mjs` reduces both readers to text before comparing, and four separate
findings turned out to be artefacts of that reduction rather than of either reader: a nested
list seam, a table truncated at different lengths, a caption whose phrasing children were
walked past, and `textContent` returning tracked deletions the shipped renderer drops. The last
one kept reporting a renderer defect for hours after the renderer was fixed. The file records
each, because a differential test that invents divergences trains you to skim the list.

**The classification holdout scores 1 of 5.** Gated on regression, not on value: the gate stops
it getting worse and does not imply the number is acceptable.

**Extraction precision is 75%.** One in four extracted context units is not what the answer key
expected.

---

## 5. The LLM layer

- **No frontier model is available.** The gateway's strongest general model is
  `nemotron-3-super-120b-a12b`. Everything downstream assumes competent open-weight models,
  which is why §10.6's verification gate is mandatory rather than advisory.
- **Adjudicated deduplication is off by default** and is a stage that, when it worked, did
  nothing: recall 0 of 3 on the first uncontaminated grading set. `docs/ROADMAP.md` records
  what would re-enable it.
- **The adjudicator made a false merge** that deleted a prohibition — *"a sealed document must
  **never** be re-issued under the same reference"* merged with *"must be re-issued under a
  fresh reference"*. `CORPUS.md` §2.14.1's predicate is now a veto in `dedup.ts` and blocked
  it, but the model's judgement was wrong on a case where merging deletes a fact.
- **Six of the ten bound LLM tasks have no prompt file** — `document-role-classification`,
  `context-unit-extraction`, `alt-text`, `conflict-analysis`, `glossary-extraction`, and
  `table-structure-recovery`. They are bound in `DEFAULT_TASK_ROLES` and unwired. The figure
  read "five" in `STATUS.md` from Phase 4 until 2026-08-01, and the Phase 6 brief inherited it.
- **`--llm` is never a default**, and a cached run with no key is byte-reproducible.
- **Extraction precision fell to 72.0% from 75.0%** when §7ag reordered the extraction passes.
  Recall held at 94.7%; one more unit is extracted and the same 18 are correct. The trade was
  taken because it removes a *structural* block: all three `CORPUS.md` §2.17 near-duplicate
  pairs now reach the adjudicator, where before a filename kept them in different categories
  and §10.4 never compared them at all.

---

## 6. Corpus limits

- **Nothing in the corpus was found in the wild.** Every fixture is authored or generated. The
  messy documents are *our* messy documents.
- **The RTL and CJK fixtures had no native-speaker review** (`CORPUS.md` §2.10.1). They gate
  byte preservation, grapheme counting, and structure — all mechanically decidable — and they
  do **not** establish that the prose is idiomatic or that bidi renders correctly. No number
  derived from them says this toolkit handles those scripts well.
- **`fixtures/local/` cannot be committed** (IEEE licensing, personal data), so the
  real-specimen checks run only where those files exist.

---

## 7. The PDF renderer

Built 2026-08-01 (ADR-0003). What it does **not** do:

- **No profile fonts are shipped**, so `renderPdf` called without a `fonts` array uses the
  compiler's bundled faces. Output stays deterministic; it is not the profile's typography, and
  SPEC §4.3's "embedded fonts, no substitution" is met only when a caller supplies them. The
  renderer says so with an `info` diagnostic rather than letting silence imply otherwise.
- **Images are not embedded.** `image` nodes are resource-referenced and this renderer has no
  resource resolver, so the alt text is emitted and the loss is reported.
- **PDF/A and PDF/UA are unmeasured.** The compiler accepts a `pdfStandard` argument and
  nothing here verifies the output conforms, so the profile option exists and its claim does
  not. Typst's accessibility support arrived in 0.14 and tagged-PDF quality has never been
  checked here — the measurement task ADR-0003's *Consequences* named in Phase 2 and that is
  still open.
- **`md → pdf → md` scores 57.9% structural and 86.5% text** on `clean-report.md`. Per SPEC
  §9.5 that is a **joint** measure of this renderer and the PDF *extractor*, and it must never
  be quoted as a renderer-only number.
- **OMML equations reaching the PDF renderer are not converted.** Typst math is not OMML; the
  source is emitted as a raw block and the loss is reported.

---

## 8. Shipped artifacts with known losses

**`templates/academic-manuscript.docx` contains five constructs this toolkit cannot round-trip.**
Its five OMML display equations survive as `equationBlock` with their markup retained, and the
Markdown renderer cannot express any of them, so converting the primary shipped template emits
five lossy diagnostics and **exits 2 under `--strict`**. That is the correct code for
"completed with lossy diagnostics", and it is a behaviour change from before 2026-08-01, when
the equations were discarded silently and the same command exited 0.
