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
| Three reference DOCX templates | **not done** — `TEMPLATES.md` §2.1 specifies them row by row |

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
| Vision/OCR path (ADR-0012) | done for the vision recogniser; tesseract **implemented but never measured** |
| `CORPUS.md` §2.7 scanned fixtures | partial — 3 synthesized, the 2 found scans absent |
| Non-blocking live drift job | done |
| Model registry, routing policy, capability tags | **not deliverables** — descoped by the reviewer (ADR-0009) |

**The done-criterion is met, and both halves are checked in CI rather than asserted.**

*Reproducibility.* Two cached-LLM runs of the same input, with `MODEL_API_KEY` unset and
`--llm-cache-mode readOnly`, produce byte-identical output — for the scanned PDF and for the
ambiguous DOCX. The key being absent is the point: if anything on that path reached the network
the job would fail rather than quietly succeed.

*Improvement.* Measured in `docs/FIDELITY.md`, from the committed cache, offline:

| Subset | Deterministic | Cached LLM |
| --- | --- | --- |
| `scanned-150dpi` (`scan->md`) | 0.0% on every metric | 100% structural, 100% text |
| `ambiguous-headings` (`docx->truth`) | 96.1% structural, span F1 0.0% | 100% on every metric |

The scanned gap is that large because the deterministic baseline on a scan is *zero*: the adapter
refuses by name rather than returning three words of a forty-page document. Stating it as
"0% → 100%" is accurate and would be misleading without that sentence.

### What building it found

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

## Unbuilt CLI surface

`SPEC.md` §8 specifies seven subcommands. Two work. The other five refuse by name rather
than pretending, which is the right behaviour but is not delivery.

| Command | State |
| --- | --- |
| `convert`, `fmt` | done |
| `check` | **partial, and no longer a lie** — validates documents against the IR schema, reports reference-document style coverage (`--reference-doc`), and probes the LLM endpoint (`--llm`). Corpus fidelity baselines stay in `scripts/run-fidelity.mjs`, and `check --help` says so rather than implying otherwise |
| `diff`, `init`, `serve`, `agentify` | not done, by phase |

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
| `code` and `thematicBreak` are written to DOCX but not read back | a code block returns as prose, a rule as an empty paragraph | **no — the writer is correct and the reader has no case for them** |

The last row is the tractable one: both are written correctly and recoverable by inference
from the style name and the paragraph border, exactly as blockquotes already are.

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
| 2.7 scanned PDFs | **partial** — 3 synthesized (1 committed, 2 generated); the 2 found scans absent |
| 2.8 slide decks | not done |
| 2.9 spreadsheets | not done |
| 2.10 RTL and CJK | partial, inside 2.11; native-speaker review not done |
| 2.12 tracked changes and comments | not done |
| 2.14 agentify source sets | not done, Phase 4 |
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

1. **Figures, description lists, and captions in the DOCX writer.** Now the top item,
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
