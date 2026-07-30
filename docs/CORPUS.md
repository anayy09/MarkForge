# Golden Corpus Plan

Status: Phase 0 deliverable. Written 2026-07-29.

Brief §10 requires `fixtures/` to be built deliberately, with licensing recorded per file. This
document is the plan: what categories exist, why each one exists, how each is sourced, and how
licensing is handled.

The governing principle is that **a fixture exists to catch a specific failure mode**. A
fixture whose failure mode cannot be named does not belong in the corpus, because nobody will
know what a regression on it means.

## 1. Licensing rules

These are hard rules, not guidelines.

1. **No fixture lands without a licence line.** Every file has an entry in
   `fixtures/LICENSES.md`. CI fails if a file exists under `fixtures/` with no entry, and fails
   if an entry names a file that does not exist. This is enforced before any conversion test
   runs, so an unlicensed fixture cannot be used even accidentally.
2. **The project licence does not cover fixtures.** Apache-2.0 (ADR-0008) applies to code.
   Fixtures carry their own terms, and `fixtures/README.md` says so.
3. **Four acceptable provenance classes**, in order of preference:
   - **Synthesized by us** — authored specifically as a fixture, Apache-2.0 or CC0. Preferred,
     because we control exactly which construct is under test.
   - **Public domain** — US federal documents, pre-1930 publications, CC0 releases.
   - **Permissively licensed** — CC-BY, CC-BY-SA, or an open-source project's own docs, with
     attribution recorded in the licence entry.
   - **Generated from a permissive source** — e.g. a DOCX we produced by converting a CC-BY
     Markdown file. The derivation is recorded so the chain is auditable.
4. **No real personal data, ever.** Names, addresses, emails, and identifiers in fixtures are
   invented. Where a fixture needs to look like a real business document, it is authored to look
   like one rather than sourced from one.
5. **No scraped proprietary documents**, regardless of how convenient. The temptation is real —
   the messiest documents are always someone's internal report — and the answer is to *author* a
   messy document instead, which is also more controllable.

`fixtures/LICENSES.md` entry format:

```
| Path | Source | Licence | Attribution | Derived from | Notes |
| --- | --- | --- | --- | --- | --- |
| docx/nested-restarting-lists.docx | authored | Apache-2.0 | MarkForge | — | Exercises w:startOverride |
```

## 2. Fixture categories

Each category lists the failure mode it catches, the sourcing plan, and the metrics it is
scored under (`SPEC.md` §9).

### 2.1 Clean Word reports — *authored*

**Catches:** baseline regressions on the easy path. If these ever score below near-perfect,
something fundamental broke.
**Plan:** three documents authored against each of our three shipped reference templates
(clean report, academic manuscript, technical documentation), so they also serve as
round-trip tests for the DOCX renderer's style mapping (ADR-0004). The
`academic-manuscript` one is the Phase 1 gate document, because it carries the most
constructs (`SPEC.md` §4.2.1).
**Metrics:** all; `docx → md → docx` is the Phase 1 gate.

**Licensing note:** the three shipped templates and these three fixtures are **authored**, not
downloaded publisher templates. Rule 5 below is the general form of this, and ADR-0004 records
why the specific temptation here is declined: the IEEE conference template is construct-rich and
was supplied as the starting point, but IEEE grants no redistribution right, and MDPI's CC BY on
its *articles* does not extend to its blank template file. Users who want publisher-exact output
point `docx.referenceDoc` at their own downloaded copy; `TEMPLATES.md` §3.1 supplies the IEEE
`styleMap` so that works on the first try.

### 2.2 Academic manuscripts with footnotes and equations — *authored + public domain*

**Catches:** footnote and endnote identity, OMML equation extraction, caption binding,
cross-references (`SPEC.md` §2.3), and `Footnote Text` / `Caption` style round-tripping.
**Plan:** two authored manuscripts covering footnotes, endnotes, numbered display equations
with labels, and figure/table cross-references. Supplemented by a pre-1930 public-domain
scholarly article typeset into DOCX, which brings genuinely awkward footnote conventions.
**Metrics:** structural, text, inline styling.

### 2.3 Badly formatted real-world documents — *authored, deliberately*

**Catches:** the entire premise of Surface B. Direct formatting instead of named styles, empty
paragraphs as spacing, hard line breaks used as paragraph breaks, mixed theme fonts, manual
numbering typed as literal text, tabs used for indentation, inconsistent heading sizes.
**Plan:** authored, not sourced — this is where rule 5 bites, and it is also where authoring is
*better*, because we can produce a document that contains exactly the seven defects above and
know that a score change means one of them regressed. Five documents, each concentrating on a
subset, plus one that combines all of them.
**Metrics:** all, plus visual regression. These fixtures are the primary test of heading
inference (`SPEC.md` §5.1) and are expected to have the lowest scores in the corpus.

**A real specimen: the IEEE conference proceedings template.** Inspected 2026-07-30, it
contains six of the seven defects above in a single genuine file, plus three this plan had not
anticipated:

| Defect | Evidence |
| --- | --- |
| Manual numbering typed as literal text | second-order headings read `I.  Main text`, `II.  Figures and tables` |
| Equation as plain text | the equation example is the literal string `a + b = c.` in a body paragraph; **zero OMML in the file** |
| Direct formatting alongside named styles | 101 `w:rPr` blocks across 112 paragraphs |
| Inconsistent style cascade | `heading 2` is `basedOn: Heading1` but `heading 3` is `basedOn: Normal` |
| Custom names for standard constructs | `paper title`, `Author Data`, `BlockQuote`, `Table text`, `Source` — 8 of 38 Pandoc names present (`SPEC.md` §4.2.2) |
| Only three heading levels defined | forces `onMissingStyle` for depth 4–6 |
| Declared footnote support, zero footnotes | `footnotes.xml` and `endnotes.xml` present and empty; no `Footnote Text` style |
| TIFF image inside DOCX | `word/media/image2.tiff` — no browser renders TIFF, so the HTML renderer needs a stated policy |
| Instructional comments | 5 comments with `commentsExtended`/`commentsIds`, useful for §2.12 |
| Scrubbed document properties | `dc:creator`, `lastModifiedBy` all empty; German `Titel` in `app.xml` heading pairs |

**Two further real specimens**, both authored by the project owner and inspected 2026-07-30, in
gitignored `fixtures/local/`. Their measurements changed this category's priorities:

| | `sample001.docx` | `sample002.docx` |
| --- | --- | --- |
| Paragraphs / tables | 79 / 2 | 45 / 0 |
| Styles defined vs used | 18 defined, **3 used** (`Heading1`, `Heading2`, `ListParagraph`) | 18 defined, **3 used** (`Heading1`, `Heading3`, `ListParagraph`) |
| Direct formatting | 32 `w:rPr` | **261 `w:rPr` across 45 paragraphs — 5.8 per paragraph** |
| List items | 23, all `ListParagraph` + `numPr` | 27, all `ListParagraph` + `numPr` |
| Heading hierarchy | 1 → 2 | **1 → 3, skipping level 2 entirely** |
| Equations / drawings | none | none |

Three findings worth carrying into Phase 1:

1. **`ListParagraph` + `numPr` is the dominant real-world list encoding.** All 50 list items
   across both files use it. Word's UI produces this, and it is exactly the encoding behind the
   reference project's documented "numbered lists are converted to bullet lists" defect: the
   style name says nothing about ordered-versus-unordered, which lives only in the `numPr`
   reference into `numbering.xml`. Any adapter reading `pStyle` and ignoring `numPr` reproduces
   the bug. This makes §2.4 higher-priority than its position in §5 suggests.
2. **Heading levels skip in practice.** `sample002.docx` goes `Heading 1` → `Heading 3` with no
   `Heading 2`. So `depth` and `resolvedLevel` diverge in ordinary documents, not just pathological
   ones, which is the case `SPEC.md` §2.3 introduced `resolvedLevel` for. A renderer that assumes
   contiguous levels produces a wrong outline.
3. **`sample001.docx` is machine-generated OOXML**, not Word output: `dc:creator` is `Un-named`,
   `dcterms:created` carries millisecond precision (`...10.036Z`, where Word writes whole
   seconds), and there is **no `theme1.xml`** — so `+mn-lt` theme font resolution has nothing to
   resolve against and the cascade must fall back to `docDefaults` without erroring. It also ships
   `comments.xml`, `footnotes.xml`, and `endnotes.xml` parts. **A new fixture sub-category:
   library- and LLM-generated documents**, which are an increasingly common input class with a
   distinct defect profile (no theme, few styles, heavy `ListParagraph`) and are not represented
   anywhere else in this plan.

Neither is committable as-is: rule 4 forbids the real names both contain, and `sample002.docx` is
a **confidential peer review** naming an unpublished paper by ID and title, so it is permanently
local rather than an anonymization candidate. `sample001.docx` could be committed after
substituting invented names, since every defect above survives that edit.

**Provenance resolved, and it cannot be committed.** IEEE publishes the conference templates
for authors preparing IEEE submissions and grants no redistribution right, so rule 1 has no
licence line to write. The local copy lives in gitignored `fixtures/local/`, where it is
useful — as the structural model for our authored `academic-manuscript.docx`
(`TEMPLATES.md` §2.1) and as a development conversion target — while being redistributed
nowhere.

**So this category's fixtures are authored, and the table above is the specification for
authoring them.** That is rule 5 working as intended rather than as a consolation: the defects
are now enumerated precisely enough to reproduce deliberately, and a synthetic file containing
exactly these ten defects tells us *which one* regressed, where the found file would only tell
us that something did. Two properties do not survive authoring and are noted as accepted gaps:
the TIFF image (we would author a real TIFF for §2.11 instead) and the scrubbed-metadata quirk,
which is a `docProps` edge case rather than a conversion one.

### 2.4 Nested and restarting lists — *authored*

**Catches:** the reference project's documented "numbered lists are converted to bullet lists"
defect, `numbering.xml` reconstruction, `w:lvlOverride` and `w:startOverride`, mixed
ordered/unordered nesting, lists interrupted by a paragraph and resumed, and list indentation
that comes from the numbering definition rather than the paragraph.
**Plan:** four authored documents, one of which is the pathological case — five levels deep with
restarts at levels 1 and 3 and a legal-numbering variant.
**Metrics:** structural, text.

### 2.5 Complex tables with merged cells — *authored + permissive*

**Catches:** `rowSpan`/`colSpan` recovery, multi-row headers, header columns, vertical merge
continuation cells, nested tables, tables broken across pages, and cells containing block
content.
**Plan:** four authored DOCX and two authored HTML (HTML is where span semantics are
unambiguous, giving us a ground truth to compare the DOCX and PDF paths against).

**Status:** the two HTML fixtures exist — `fixtures/html/spans-ground-truth.html` and
`fixtures/html/semantic-structure.html`. They are measured through three loops each, and the
gap between `html->html` and `html->md->html` on table F1 is the honest cost of Markdown
having no rowspan: 100% against 27%. `docs/FIDELITY.md` lists that under known limitations so
it reads as a format constraint rather than a defect.
**Metrics:** table full-cell F1 and content-only F1 — the gap between them is the point
(`SPEC.md` §9.3).

### 2.6 Multi-column PDFs — *public domain*

**Catches:** column detection and reading-order recovery. A failure here produces interleaved
text, which is the single most visible PDF conversion defect.
**Plan:** US federal publications (public domain) in two- and three-column layouts, plus arXiv
papers under CC-BY. Includes at least one with a full-width figure interrupting the columns and
one with a footnote rule that could be mistaken for a column boundary.
**Metrics:** text (both variants), structural.

### 2.6.1 Status: what the text-layer path measured

The PDF adapter is built and its layout analysis is tested against authored fixtures
(`packages/adapters-pdf/test/`). Three findings from doing it, all about pdf.js rather than
about PDFs:

1. **pdf.js synthesises a whitespace run to represent a horizontal gap, with the width of the
   gap.** On a two-column page that is a ~170pt-wide `" "` sitting exactly across the gutter.
   Counting it as occupancy fills every gutter, so no columns are found and the page reads
   interleaved — the defect this category exists to catch, caused by a helpful parser filling
   in a blank. Whitespace-only runs are now excluded from occupancy.
2. **Columns must be detected before lines are grouped.** Two columns share baselines
   constantly, so grouping runs into lines first merges "left column line one" with "right
   column line one" into one full-width line, after which no gutter exists to find.
3. **pdf.js clips text extending past the MediaBox and reports the survivors with no flag.**
   Measured: a 125-character line at 16pt on a 612pt page came back as 78 characters, cut
   mid-word. The loss happens before we see the items, so it cannot be detected directly; a run
   reaching the page edge now emits a "this may be incomplete" diagnostic, which is the only
   honest thing available.

### 2.7 Scanned PDFs — *public domain + synthesized*

**Catches:** missing-text-layer detection, OCR routing, confidence propagation
(`SPEC.md` §3.3).
**Plan:** two genuinely scanned public-domain documents, plus three synthesized by rasterizing
our own authored documents at 150/300/600 DPI with controlled skew and noise. The synthesized
ones are valuable precisely because we have exact ground truth, which no real scan provides —
so OCR accuracy becomes measurable rather than eyeballed.
**Metrics:** text (whitespace-insensitive primarily), with per-DPI baselines. Expected to lose
to marker; see ADR-0010 and ADR-0012.

### 2.8 Slide decks — *authored*

**Catches:** PPTX slide/notes/shape mapping, reading order within a slide, text boxes.
**Plan:** two authored decks, one text-heavy and one diagram-heavy (the latter exercising the
`unknown` node path for SmartArt).
**Metrics:** structural, text.

### 2.9 Spreadsheets — *authored + public domain*

**Catches:** sheet-to-table mapping, merged ranges, number formats, formulas versus results,
and very wide sheets.
**Plan:** two authored workbooks plus one public-domain government data release.
**Metrics:** table F1, text.

### 2.10 RTL and CJK text — *authored, reviewed*

**Catches:** bidirectional run handling, CJK line breaking, grapheme-cluster correctness in the
text metric (`SPEC.md` §9.2 specifies graphemes rather than UTF-16 units specifically because of
this category), and full-width punctuation.
**Plan:** one Arabic, one Hebrew, one Japanese, one Simplified Chinese document, each with mixed
Latin text to force bidi transitions. Content is authored; **native-speaker review is required
before these are trusted as ground truth**, and until reviewed they are marked provisional in
`LICENSES.md`. A fixture whose expected output we cannot read is not a fixture, it is a guess.
**Metrics:** text (both variants), inline styling.

### 2.11 Emoji and Unicode edge cases — *authored*

**Catches:** ZWJ sequences, skin-tone modifiers, combining marks, NFC/NFD normalization
(`SPEC.md` §2.7 mandates NFC), soft hyphens, non-breaking spaces preserved as semantic
(`SPEC.md` §2.8 rule 5), and surrogate pairs at chunk boundaries.
**Plan:** one dense authored document. Small but high-yield.
**Metrics:** text (whitespace-sensitive especially).

### 2.12 Tracked changes and comments — *authored*

**Catches:** `w:ins`/`w:del`/`w:moveFrom`/`w:moveTo`, comment anchor ranges, resolved versus
unresolved comments, and the `revisionMode` behaviour of all three renderers
(`SPEC.md` §4.3).
**Plan:** two authored documents, one with overlapping revisions from two authors — the case
where range-based models corrupt and `SPEC.md` §2.3's wrapping-node choice earns its keep.
**Metrics:** structural, text, plus a dedicated revision-preservation check per
`revisionMode`.

### 2.13 Markdown flavour fixtures — *authored*

**Catches:** `fmt` idempotency across all seven flavour presets, unknown-construct
preservation (`SPEC.md` §3.2), and front-matter handling.
**Plan:** one document per flavour plus a "hostile" document containing constructs from *other*
flavours, which must survive as `unknown` rather than being dropped.
**Metrics:** `md → md` round trip; property-tested idempotency.

### 2.14 Agentify source sets — *authored*

**Catches:** the whole of Surface A. Document classification, unit extraction, deduplication,
**conflict detection** (deliberately contradictory documents), budgeting overflow, the
traceability gate, and incremental regeneration.
**Plan:** three source sets. (a) A small clean set, five documents in five roles. (b) A
conflicting set where two documents disagree on an environment variable value and on a build
command — the conflict report is the expected output, not a resolution. (c) An oversized set
that forces budget overflow into secondary files. Each set ships with an
`expected-units.json` recording the unit inventory, so extraction changes are visible.
**Metrics:** traceability (must be 1.0), conflict recall, and a diff-stability check that
mutating one sentence in one source produces a single-region `git diff`.

### 2.15 Library- and LLM-generated documents — *authored via generators*

**Catches:** the defect profile of DOCX files produced by software rather than by Word, which is
a large and growing share of real input and is structurally different from both clean Word output
and hand-mangled documents. Specifically: **a missing `theme1.xml`**, so `+mn-lt` and `+mj-lt`
font tokens have nothing to resolve against and the cascade must fall back to `docDefaults`
rather than error (`SPEC.md` §3.1); a near-empty style table where almost everything is `Normal`,
`Heading N`, or `ListParagraph`; `numPr` carrying all list semantics with no style distinction
between ordered and unordered; declared-but-empty `comments.xml`/`footnotes.xml`/`endnotes.xml`
parts; and non-Word `docProps` conventions such as millisecond timestamps and placeholder authors.

**Why it earns a category** rather than living inside §2.3: the defects are *absences* rather than
misuse. §2.3 documents overspecified files — direct formatting fighting named styles. These are
underspecified files, where the information a correct conversion needs was never written. A
resolver tuned on §2.3 can pass everything there and still crash on a missing `theme1.xml`.

**Plan:** four documents, generated by the four common producers — the `docx` npm library, Pandoc,
a headless LibreOffice export, and an LLM-authored file — from one identical source Markdown. That
shared source is the point: it gives four different OOXML encodings of *known-identical* content,
so a fidelity difference between them isolates the producer's encoding rather than the content.
Generated by committed script into `generated/`, not committed as binaries.

**Metrics:** structural, text, table F1. Also the only category that directly tests
cascade-resolution fallbacks, so a failure here is a cascade bug rather than an inference bug.

A real specimen of this class is `fixtures/local/sample001.docx` (§2.3), which is how the category
was identified — it was not in the original plan, and inspecting a real document put it there.

## 3. Competitor scoreboard runs

Brief §10 requires competing tools scored on the same corpus. Three, chosen because each
represents a different claim:

| Tool | Represents | Path |
| --- | --- | --- |
| `word-to-markdown-js` | The reference project and the Phase 1 bar | `docx → md` |
| Pandoc | The established general-purpose standard | `docx → md`, `docx → md → docx` |
| markitdown | Breadth without fidelity as a stated non-goal | `docx → md`, `pdf → md`, `pptx → md`, `xlsx → md` |

Both non-JS tools run in the scoreboard CI job only, never as toolkit dependencies (brief §13).
Because competitors do not produce our IR, their output is parsed by our own Markdown adapter
before scoring. **That advantages us slightly and must be disclosed in `docs/FIDELITY.md`** —
our Markdown renderer and our Markdown parser share assumptions. The honest mitigation is to
report the `md → md` self-consistency score for each competitor's output alongside its fidelity
score, so a reader can see how much of any gap is attributable to the shared parser.

## 4. Physical layout and size discipline

```
fixtures/
  LICENSES.md              # mandatory, CI-enforced
  README.md                # licensing policy, how to add a fixture
  docx/  pdf/  pptx/  xlsx/  html/  md/  images/
  agentify/{clean,conflicting,oversized}/
  expected/                # ground truth: expected-units.json, construct inventories
  local/                   # gitignored: third-party files, never committed, no licence entry
  generated/               # gitignored: produced by script, never committed
```

`local/` and `generated/` are the two exemptions from rule 1, and both are exempt for the same
reason: nothing in them is committed, so there is nothing to license. Neither can hold a CI
fixture, because CI must be reproducible from a clone. `fixtures/README.md` is the operating
procedure and `fixtures/LICENSES.md` is the register; both exist as of Phase 0, so the rule is
enforceable before the first fixture lands rather than retrofitted after.

Two size rules. Individual fixtures stay under 1 MB where the failure mode allows, since large
binaries in git history are permanent. Anything genuinely large — scanned PDFs at 600 DPI,
Tesseract language data — is generated by a committed, deterministic script rather than
committed itself, and `fixtures/README.md` documents how to regenerate.

Every fixture also carries a **construct inventory** in `expected/`: the list of source
constructs it contains. This is what makes the loss invariant of `SPEC.md` §2.6 testable —
comparing the inventory against the IR tells us what disappeared, and the diagnostics must
account for the difference. Without inventories, "nothing was lost silently" is unfalsifiable.

## 5. Build order

Phase 1 needs 2.1, 2.3, 2.4, 2.5 (DOCX and HTML only), 2.11, 2.12, and 2.13 — enough to gate
`docx → md → docx` against the reference project and Pandoc, and to prove `fmt` idempotent.

**2.15 joins Phase 1**, promoted on evidence rather than plan: a real specimen
(`fixtures/local/sample001.docx`) turned out to have no `theme1.xml` at all, and a cascade
resolver that assumes one is present will fail on a whole common class of input. That is a Phase 1
correctness issue, not a later refinement, and it is cheap to cover — the four generated variants
come from one source Markdown by script.

Phase 2 adds 2.6, 2.9, 2.8, and the PDF half of 2.5. Phase 3 adds 2.7 and the OCR baselines.
Phase 4 adds 2.14. Category 2.10 lands as soon as native-speaker review is available, and its
absence from Phase 1 is a stated gap rather than an oversight — RTL and CJK defects found late
are expensive.
