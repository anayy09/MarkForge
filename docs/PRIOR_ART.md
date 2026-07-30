# Prior Art Survey

Status: Phase 0 deliverable. Written 2026-07-29.

Every verdict here is one of **STEAL** (adopt the code or the design), **BENCHMARK**
(compete against it and publish the numbers), or **AVOID** (studied, deliberately not
used). Brief §13 makes maintenance status a selection criterion, so every npm dependency
carries a verified latest version and publish date, queried from the registry rather than
recalled.

## How maintenance status was established

Versions and publish dates below come from `npm view <pkg> --json` run on 2026-07-29, not
from memory. Repository facts come from the projects' own READMEs and docs, fetched the
same day. Where a claim needed a source we could not verify, it is marked
*(unverified — Phase 1 must measure)* rather than stated.

## Verdict summary

| Project | Verdict | One-line reason |
| --- | --- | --- |
| `benbalter/word-to-markdown-js` | BENCHMARK | The bar to beat, and the licence/packaging model to copy |
| `microsoft/markitdown` | BENCHMARK | Explicitly not aiming at fidelity, so it defines the low bar broadly |
| `docling` | STEAL (design) | Best existing provenance-and-layout document model |
| `VikParuchuri/marker` | BENCHMARK | Best-in-class PDF accuracy numbers; model licence blocks reuse |
| `Unstructured-IO/unstructured` | STEAL (taxonomy ideas) | Element taxonomy worth learning from, architecture not |
| `unified`/`remark`/`mdast` | STEAL | The IR foundation (ADR-0001) |
| `hast` | STEAL (partial) | Needed for the HTML adapter, rejected as the IR (ADR-0001) |
| `mammoth.js` | AVOID as parse path / BENCHMARK | Drops exactly the style evidence we need (ADR-0005) |
| `turndown` | AVOID | HTML-intermediate path is the architecture we are rejecting |
| `docx` (dolanmiu) | STEAL | The DOCX writer (ADR-0004) |
| Pandoc | STEAL (design) | `--reference-doc` mechanism and its named-style vocabulary |
| Typst | STEAL | The PDF engine (ADR-0003) |
| Paged.js | AVOID | Nondeterministic pagination, breaks the browser build |
| Tectonic / LaTeX | AVOID | Toolchain weight and unsafe text escaping |
| `pdfjs-dist` | STEAL | PDF text-layer extraction |
| `tesseract.js` | STEAL | OCR fallback |
| `markdownlint` / `prettier` / `remark-stringify` | STEAL (selectively) | Deterministic Markdown output (ADR-0006) |
| SheetJS `xlsx` (npm) / `exceljs` | AVOID | Both stale on npm; our own OOXML reader covers XLSX |

---

## 1. `benbalter/word-to-markdown-js` — BENCHMARK

The reference project and the closest prior art. Apache-2.0. Pipeline is
**mammoth.js → turndown → markdownlint**. Surfaces: CLI (`w2m`), a client-side Astro web
app at word2md.com, and a Node API exposing `convert(input, options?)` and
`convertWithWarnings(input, options?)` with typed errors (`UnsupportedFileError`,
`FileNotFoundError`, `InvalidFileError`). Tested with Jest plus Playwright across Node and
browser.

**Steal:** the Apache-2.0 choice (ADR-0008), the typed-error surface, the
`convertWithWarnings` shape — it is the right instinct, and our conversion report is the
same idea taken further. The client-side-capable web app is the privacy story brief §3.6
requires, and Playwright-in-browser testing is how to keep the browser build honest.

**Its own README states the limits we are built to fix:** numbered lists become bullet
lists; images inline as base64 data URIs; comments, text boxes, and equations are not
converted; heading levels derive from paragraph styles only, never from font size.

**Benchmark against:** `docx → md` on the whole corpus, per brief §11 Phase 1.

## 2. `microsoft/markitdown` — BENCHMARK

MIT. Broadest input coverage of anything surveyed: PDF, PPTX, DOCX, XLSX, EPUB, images
(EXIF + OCR), audio (EXIF + transcription), HTML, YouTube URLs, CSV, JSON, XML, ZIP
(iterates contents), legacy Office formats. LLM integration is an optional `llm_client` /
`llm_model` pair used for image descriptions, with an OpenAI-compatible client — the same
abstraction we chose in ADR-0009. Third-party plugins, disabled by default.

**The critical quote**, from its own README: it "is meant to be consumed by text analysis
tools -- and may not be the best option for high-fidelity document conversions for human
consumption." That is an explicit non-goal statement, and it is precisely our goal. We are
not competing with markitdown on breadth in Phase 1; we are competing on fidelity, and
markitdown is the honest baseline for "structure preserved, fidelity not attempted."

**Steal:** the adapter-breadth roadmap ordering, and plugins-off-by-default as a security
default. **Avoid:** its string-oriented pipeline, which brief §3.2 bans in our core.

## 3. `docling` (IBM / docling-project) — STEAL (design only)

MIT, Python. The `DoclingDocument` model is the best existing answer to brief §4.3 and
deserves close study:

- Content lives in flat typed lists: `texts` (base class `TextItem`, covering paragraph,
  heading, equation), `tables` (`TableItem`), `pictures` (`PictureItem`),
  `key_value_items`.
- Structure lives in a separate tree: a `body` root, a **`furniture` root for headers,
  footers, and non-body matter**, and `groups` for containers (lists, chapters) that are
  not themselves content.
- Cross-references use JSON pointers (`#/texts/1`).
- Reading order is the `body` tree plus child order.
- Bounding boxes and provenance attach to items where available.

**Steal three ideas outright.** (a) Separating content storage from the structure tree is
how you attach provenance without polluting the semantic tree — it is the same conclusion
as ADR-0002, reached independently, which is reassuring. (b) The `furniture` root is a
genuinely good idea we would have missed: running headers and footers are neither content
nor noise, and giving them a home means brief §5.2's "header and footer stripping" becomes
"header and footer *routing*", so nothing is silently lost (brief §3.3). (c) JSON-pointer
cross-references.

**Do not depend on it:** Python, and brief §13 rules out a heavyweight non-JS core.

## 4. `VikParuchuri/marker` (datalab-to/marker) — BENCHMARK

Code is Apache-2.0, but **model weights are under a modified AI Pubs Open RAIL-M licence:
free for research, personal use, and companies under $5M funding/revenue, paid above
that.** That licence split is disqualifying for a dependency in an Apache-2.0 toolkit and
is the reason this is BENCHMARK not STEAL.

Architecture worth learning from: an `rf-detr` layout detector in fast mode or the Surya
VLM in balanced mode; equations and inline math via the VLM; **tables reconstructed from
the text layer with CPU heuristics, falling back to the VLM only on low confidence.**

That last point is the single most useful finding in this survey, because it is brief §3.1
and §7.1 validated by someone else's production system: deterministic-first, model-second,
gated on confidence. Our PDF table recovery should adopt exactly that shape.

Published accuracy on olmocr-bench (1,403 PDFs): balanced mode 76.0% overall, **83.5% on
born-digital PDFs**; fast mode 66.6%. Those are the numbers our `docs/FIDELITY.md` should
be measured against on the PDF subset, and we should expect to lose on scanned pages and
compete on born-digital.

## 5. `Unstructured-IO/unstructured` — STEAL (taxonomy ideas only)

Apache-2.0, Python. Element taxonomy: `Title`, `NarrativeText`, `ListItem`, `Table`,
`Image`, `Formula`, `FigureCaption`, `Header`, `Footer`, `PageBreak`, `PageNumber`,
`Address`, `EmailAddress`, `CodeSnippet`, `UncategorizedText`, `CompositeElement`.
Partitioning strategies: `auto`, `fast`, `hi_res`, `ocr_only`. Metadata carries
`coordinates` (points in a named coordinate system such as `PixelSpace`, origin top-left,
y descending), `page_number`, `parent_id` for inferred hierarchy, and `text_as_html` for
tables.

**Two things to take.** `PageNumber` and `Header`/`Footer` as *first-class element types*
rather than as text to discard — same lesson as docling's `furniture`. And the explicit
coordinate-system declaration: a bbox without a stated origin and unit is a bug waiting to
happen, so our sidecar's `bbox` must name its coordinate space (ADR-0002).

**Two things to reject.** `NarrativeText` versus `UncategorizedText` is a
confidence-in-disguise distinction — we model confidence as a number in provenance instead.
And `text_as_html` for tables is a lossy escape hatch: our IR models spans structurally.

## 6. `unified` / `remark` / `mdast` — STEAL (the IR foundation)

The mdast spec has 18 core node types (`Root`, `Paragraph`, `Heading`, `Blockquote`,
`List`, `ListItem`, `Code`, `Html`, `ThematicBreak`, `Definition`, `Text`, `Emphasis`,
`Strong`, `InlineCode`, `Break`, `Link`, `Image`, `LinkReference`, `ImageReference`), plus
GFM (`Table`, `TableRow`, `TableCell`, `Delete`, `FootnoteDefinition`, `FootnoteReference`,
and `checked` on `ListItem`) and frontmatter (`Yaml`).

Maintenance: the `unified` ecosystem is stable rather than busy, and that must not be
misread as abandonment. `unified@11.0.5` (2024-06-19) and `remark-stringify@11.0.0`
(2023-09-18) have not moved because the specs have not moved, while the actively developed
edges have: `mdast-util-from-markdown@2.0.3` (2026-02-21), `unist-util-visit@5.1.0`
(2026-01-22), `micromark@4.0.2` (2025-02-27), `mdast-util-gfm@3.1.0` (2025-02-10),
`remark-directive@4.0.0` (2025-02-27). Ecosystem health is good.

**What mdast does not give us, and therefore what ADR-0001 must add:** no whitespace
preservation, no concrete-syntax record (`*x*` vs `_x_` collapse to the same tree), no
comments as a node type, no table cell spans, no math, no admonitions, no tracked changes,
no captions bound to figures, no cross-references, no definition lists, and no styling
evidence of any kind. That list is the specification of our extension set.

**Steal:** the node shape, the `unist` `position` convention, the visitor utilities, and
the plugin architecture. Extending mdast rather than inventing a tree buys us
`remark-stringify`, `remark-gfm`, `unist-util-visit`, and third-party plugins for free —
which is what brief §4 means by third parties writing adapters against the IR.

## 7. `hast` — STEAL (partial), rejected as the IR

Five node types only: `Root`, `Element`, `Text`, `Comment`, `Doctype`. Models attributes,
`<template>` content, SVG, and MathML; models nothing semantic.

**Use it** inside the HTML adapter (`rehype-parse@9.0.1`, 2024-09-27) as the parse target
before mapping to our IR. **Reject it as the IR:** it is a markup tree, not a document
tree. Heading level in hast is a tag name; in our IR it is a resolved semantic level with
confidence and evidence attached. Choosing hast would mean re-deriving semantics on every
render.

## 8. `mammoth.js` — AVOID as the parse path, BENCHMARK as a baseline

`mammoth@1.12.0`, BSD-2-Clause, published 2026-03-12. Genuinely well maintained; this is
not a maintenance rejection.

The style-map API is the best-designed part of any tool surveyed. Matchers cover
paragraphs, runs, and tables, with `p[style-name='Heading 1']`, prefix matching
`p[style-name^='Heading']`, style-id matching `p.Heading1`, formatting matchers (`b`, `i`,
`u`, `strike`, `all-caps`, `small-caps`), `highlight[color='yellow']`, and `!` to ignore.
HTML paths support classes, attributes, nesting, `:fresh` to force a new element between
consecutive same-style paragraphs, and `:separator(...)`. There is also an unstable
`transformDocument` hook with `mammoth.transforms.paragraph`,
`mammoth.transforms.run`, and `getDescendantsOfType`, operating on an internal element
model where paragraphs expose `styleId` and `styleName`.

**Why we still do not parse through it (ADR-0005).** Mammoth's documented philosophy is to
map to semantics and discard presentation: table formatting such as borders "is currently
ignored", and fonts, text size, and colours "are generally ignored in favor of semantic
mapping." Discarding presentation is the correct decision for Mammoth's goal and the fatal
one for ours, because brief §4.2's style sidecar and brief §5.3's font-size clustering are
built from exactly the evidence Mammoth throws away. Routing DOCX → HTML → IR would leave
the sidecar empty and reduce our heading inference to the reference project's.

The `transformDocument` route is closer but insufficient: it is explicitly unstable, and
`styleName` without the resolved cascade is not enough — we need effective font size after
`docDefaults` → style chain → direct formatting, and font family after `theme1.xml`
resolution. Mammoth computes none of that.

**Steal the style-map *concept*:** our DOCX style mapping should be declarative and
selector-based in the same spirit, expressed in the config profile (brief §5.5).
**Benchmark against:** Mammoth-based conversion, i.e. the reference project, on the corpus.

## 9. `turndown` — AVOID

`turndown@7.2.4`, MIT, 2026-04-03 — maintained, contrary to reputation. But
`turndown-plugin-gfm@1.0.2` was last published **2018-05-11**, so GFM tables, strikethrough,
and task lists in a Turndown pipeline rest on an eight-year-unmaintained plugin. Brief §13
makes that alone disqualifying for a core dependency.

The deeper reason is architectural: Turndown is HTML → Markdown, and any pipeline routing
through HTML has already discarded the style sidecar (see §8). Brief §3.2 bans
string-to-string paths in the core; Turndown is the canonical one.

Its rule system is still worth reading for the taxonomy of Markdown-escaping edge cases,
which our own `render-md` will face regardless. Specific whitespace-loss mechanisms
*(unverified — Phase 1 must measure)*; the claim goes in `docs/FIDELITY.md` with numbers,
not in prose without them.

## 10. `docx` (dolanmiu) — STEAL (the DOCX writer)

`docx@9.7.1`, MIT, 2026-05-27. Active, typed, browser-capable, and supports named styles
and numbering definitions programmatically, which is exactly what brief §5.1's
"named styles only" requirement needs. Selected in ADR-0004.

Open risk to settle in Phase 1: whether it can write a document that *references* style ids
defined in a user-supplied reference `.docx`/`.dotx` without redefining them, since that is
the mechanism ADR-0004 depends on. If not, we merge our body part into the reference
package ourselves using the OOXML writer we already need for the reader's inverse.

## 11. Pandoc — STEAL (design), not a dependency

Brief §13 forbids a hard Pandoc binary dependency. Study it anyway; `--reference-doc` is
the mechanism brief §5.1 describes.

How it works: the reference document's **contents are ignored, but its stylesheets and
document properties — including margins, page size, header, and footer — are used.** You
build one by modifying a Pandoc-generated default and changing only the style definitions.

**Steal the named-style vocabulary directly.** Pandoc looks for: `Normal`, `Body Text`,
`First Paragraph`, `Compact`, `Title`, `Subtitle`, `Author`, `Date`, `Heading 1`–`Heading
9`, `Abstract`, `AbstractTitle`, `Bibliography`, `Block Text`, `Footnote Block Text`,
`Source Code`, `Footnote Text`, `Definition Term`, `Definition`, `Caption`,
`Table Caption`, `Image Caption`, `Figure`, `Captioned Figure`, `TOC Heading`; character
styles `Default Paragraph Font`, `Verbatim Char`, `Footnote Reference`, `Hyperlink`,
`Section Number`; and table style `Table`.

Adopting these names verbatim as our IR-role → style-name mapping means **any existing
Pandoc reference document works with MarkForge unchanged**, which is a large
interoperability win for one paragraph of spec. Recorded in ADR-0004.

**Benchmark against:** Pandoc on `docx → md → docx`, per brief §11 Phase 1.

## 12. Typst — STEAL (the PDF engine, ADR-0003)

`@myriaddreamin/typst.ts@0.7.0`, Apache-2.0, 2026-06-01. Verified properties that decided
ADR-0003: deterministic output (same source → same PDF regardless of OS or installed
fonts, because fonts are embedded); its own layout engine rather than a browser's;
`SOURCE_DATE_EPOCH` honoured per the reproducible-builds specification;
`--ignore-system-fonts` plus `--font-path` to eliminate substitution entirely; PDF/A and
PDF/UA output; and a WASM build so the browser surface in brief §8 is real rather than
aspirational.

Accepted costs, recorded in ADR-0003: we author and maintain Typst templates; Typst's
accessibility support is only as of 0.14, so tagged-PDF quality needs measuring; and the
`typst.ts` binding is a single-maintainer project, so ADR-0003 carries a fallback note.

## 13. Paged.js and headless Chromium — AVOID

The obvious alternative, since we already need an HTML renderer. Rejected on three counts:
pagination shifts between Chrome versions, so brief §3.1's byte-identical requirement is
unachievable; Chromium is a very large dependency for a toolkit whose core must be
installable and offline; and it breaks the browser build, since you cannot ship headless
Chrome inside a web page. Retained as a *comparison* target in the visual-regression
suite.

## 14. Tectonic / LaTeX — AVOID

Best typography and unmatched math. Rejected: heavy toolchain, slow compiles, hostile
error messages, and — the deciding factor — escaping arbitrary user document text into
LaTeX safely is a permanent, unbounded source of correctness bugs. Typst's data model
avoids that class of bug entirely.

## 15. `pdfjs-dist` and `tesseract.js` — STEAL

`pdfjs-dist@6.2.108`, Apache-2.0, published 2026-07-28 — one day before this survey, and
Mozilla-backed. Use for text-layer extraction, per-glyph positions, and font metadata.
It gives us positioned text runs; column detection, reading-order recovery,
header/footer routing, hyphenation repair, and table recovery are ours to write (ADR-0012).

`tesseract.js@7.0.0`, Apache-2.0, 2025-12-15. The OCR fallback when a text layer is
missing, with per-word confidence propagated into IR provenance as brief §5.2 requires.
The VLM path uses the NaviGator vision models (`gemma-3-27b-it`, `gemma-4-31b-it`,
`mistral-small-3.1`, `medgemma-27b-it`).

Not used: `pdf-lib@1.17.1` (2021-11-06) — stale, and made unnecessary by Typst.

## 16. `markdownlint`, `prettier`, `remark-stringify` — STEAL selectively

`markdownlint@0.41.1` (2026-07-13) and `markdownlint-cli2@0.23.2` (2026-07-27): both very
actively maintained. `prettier@3.9.6` (2026-07-21). `remark-stringify@11.0.0` (2023-09-18),
stable per §6.

ADR-0006 uses `remark-stringify` with a pinned option set as the single generator, then
markdownlint autofix as a *verification-and-repair* pass, in a fixed order. Prettier is
**not** in the pipeline: two formatters with overlapping opinions is how you lose the
idempotency property brief §3.5 requires. Prettier's Markdown behaviour is instead a
*conformance target* for one of our flavour presets, so `markforge fmt` output can be
Prettier-stable for teams that run both.

## Dependency maintenance register

Queried 2026-07-29. Adopted list; rejected candidates and reasons follow.

| Package | Version | Licence | Last publish | Role |
| --- | --- | --- | --- | --- |
| `unified` | 11.0.5 | MIT | 2024-06-19 | IR pipeline |
| `remark-parse` | 11.0.0 | MIT | 2023-09-18 | MD adapter |
| `remark-stringify` | 11.0.0 | MIT | 2023-09-18 | MD renderer |
| `remark-gfm` | 4.0.1 | MIT | 2025-02-10 | GFM |
| `remark-frontmatter` | 5.0.0 | MIT | 2023-09-18 | Front matter |
| `remark-math` | 6.0.0 | MIT | 2023-09-19 | Math |
| `remark-directive` | 4.0.0 | MIT | 2025-02-27 | Admonitions |
| `mdast-util-from-markdown` | 2.0.3 | MIT | 2026-02-21 | IR internals |
| `unist-util-visit` | 5.1.0 | MIT | 2026-01-22 | Traversal |
| `rehype-parse` | 9.0.1 | MIT | 2024-09-27 | HTML adapter |
| `markdownlint` | 0.41.1 | MIT | 2026-07-13 | MD repair pass |
| `docx` | 9.7.1 | MIT | 2026-05-27 | DOCX renderer |
| `@myriaddreamin/typst.ts` | 0.7.0 | Apache-2.0 | 2026-06-01 | PDF renderer |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | 2026-07-28 | PDF adapter |
| `tesseract.js` | 7.0.0 | Apache-2.0 | 2025-12-15 | OCR |
| `fflate` | 0.8.3 | MIT | 2026-05-16 | OOXML unzip (browser-safe) |
| `fast-xml-parser` | 5.10.1 | MIT | 2026-07-16 | OOXML XML reading |
| `ajv` | 8.20.0 | MIT | 2026-04-24 | Schema validation |
| `zod` | 4.4.3 | MIT | 2026-05-04 | Config validation |
| `json-schema-to-typescript` | 15.0.4 | MIT | 2025-01-14 | IR type generation |
| `vitest` | 4.1.10 | MIT | 2026-07-06 | Tests |
| `commander` | 15.0.0 | MIT | 2026-05-29 | CLI |
| `@changesets/cli` | 2.31.1 | MIT | 2026-07-15 | Releases |
| `tsdown` | 0.22.14 | MIT | 2026-07-23 | Builds |

Rejected on maintenance grounds, with the replacement:

| Package | Version | Last publish | Why rejected | Replacement |
| --- | --- | --- | --- | --- |
| `xlsx` (SheetJS on npm) | 0.18.5 | 2022-03-24 | Four years stale on npm; SheetJS distributes elsewhere, so the registry version is not the project | Own OOXML reader |
| `exceljs` | 4.4.0 | 2023-10-19 | Nearly three years stale | Own OOXML reader |
| `jszip` | 3.10.1 | 2022-08-02 | Stale; dual MIT/GPL licence complicates an Apache-2.0 tree | `fflate` |
| `turndown-plugin-gfm` | 1.0.2 | 2018-05-11 | Eight years unmaintained | No HTML-intermediate path at all |
| `pdf-lib` | 1.17.1 | 2021-11-06 | Stale | Typst |
| `saxes` | 6.0.0 | 2021-11-07 | Stale, though stable | `fast-xml-parser` |
| `mammoth` | 1.12.0 | 2026-03-12 | **Not** a maintenance rejection — an architectural one (§8) | Own OOXML reader |

The XLSX finding matters more than it looks: with both mainstream JS spreadsheet libraries
stale, the OOXML reader we are already building for DOCX (ADR-0005) becomes the sensible
XLSX and PPTX path too, since SpreadsheetML and PresentationML are the same zip-plus-XML
family. One reader core, three adapters — which is brief §3.2's "one adapter, not N
converters" applied one level deeper than the brief asked for. Recorded in ADR-0005.
