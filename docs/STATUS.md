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
| Beats `word-to-markdown-js` | **not done** — the competitor is not in the scoreboard |
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

## Unbuilt CLI surface

`SPEC.md` §8 specifies seven subcommands. Two work. The other five refuse by name rather
than pretending, which is the right behaviour but is not delivery.

| Command | State |
| --- | --- |
| `convert`, `fmt` | done |
| `check` | **not done** — including `check --reference-doc`, which `SPEC.md` §4.2.1 specifies and `TEMPLATES.md` §2.2 documents as though it exists |
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

`CORPUS.md` names 15 categories. Phase 1 required eight of them; five exist.

| Category | State |
| --- | --- |
| 2.1 clean reports | done |
| 2.4 nested and restarting lists | done |
| 2.5 tables with merged cells | done, HTML only |
| 2.11 emoji and Unicode | done |
| 2.13 Markdown flavours | partial — one flavour |
| 2.2 manuscripts with footnotes and equations | not done |
| 2.3 badly formatted real-world documents | done — 6 fixtures, asserted defect by defect |
| 2.6 multi-column PDFs | not done |
| 2.7 scanned PDFs | not done — blocks the Phase 3 OCR criterion |
| 2.8 slide decks | not done |
| 2.9 spreadsheets | not done |
| 2.10 RTL and CJK | partial, inside 2.11; native-speaker review not done |
| 2.12 tracked changes and comments | not done |
| 2.14 agentify source sets | not done, Phase 4 |
| 2.15 library- and LLM-generated documents | partial — 2 of 4 producer profiles; Pandoc and LibreOffice exports need the binaries |

The measured numbers in `FIDELITY.md` now cover eight deliberately defective DOCX
documents alongside the clean ones, so they are no longer only a claim about easy input.
They remain a claim about *authored* input: nothing in the corpus was found in the wild.

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
