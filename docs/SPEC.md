# MarkForge Specification

Status: Phase 0 deliverable, awaiting review. Version 0.1.0-draft. Written 2026-07-29.

Normative keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used in the RFC 2119
sense. Every judgement call not dictated by the project brief cites an ADR number; if you
find a decision here without one, it is a spec bug — see the checklist in §10.

- [1. Scope and architecture](#1-scope-and-architecture)
- [2. The IR](#2-the-ir)
- [3. Adapter contract](#3-adapter-contract)
- [4. Renderer contract](#4-renderer-contract)
- [5. Inference](#5-inference)
- [6. LLM layer](#6-llm-layer)
- [7. Configuration](#7-configuration)
- [8. CLI surface](#8-cli-surface)
- [9. Fidelity measurement](#9-fidelity-measurement)
- [10. Agent Context Compiler](#10-agent-context-compiler)
- [11. Packages](#11-packages)
- [12. Coverage checklist](#12-coverage-checklist)

---

## 1. Scope and architecture

### 1.1 The pipeline

```
                 ┌─────────── deterministic core ───────────┐
input bytes ──▶ adapter ──▶ normalize ──▶ infer ──▶ render ──▶ output bytes
                    │           │           │         │
                    └───────────┴─────┬─────┴─────────┘
                                      ▼
                            MarkForgeDocument (IR)
                                      ▲
                                      │  optional, never on the critical path
                                 enrich (LLM)
```

Five stages. `adapter`, `normalize`, `infer`, and `render` are the deterministic core.
`enrich` is the only stage permitted to touch the network, and it is off by default.

**Determinism (brief §3.1).** For a fixed toolkit version, identical input bytes plus
identical config **MUST** produce byte-identical output. Concretely, every stage:

- **MUST NOT** read the wall clock. Any timestamp in output comes from
  `SOURCE_DATE_EPOCH`, or is omitted.
- **MUST NOT** use randomness, including hash-seed-dependent iteration.
- **MUST NOT** depend on ambient locale, timezone, or installed system fonts.
- **MUST** sort object keys on serialization and **MUST NOT** leak `Map`/`Set` insertion
  order into output unless that order is itself derived from input order.
- **MUST NOT** embed absolute filesystem paths in output; paths are recorded relative to a
  declared root.

`--no-llm` **MUST** work fully offline and **MUST** pass the entire fidelity suite (brief
§3.1). This is enforced by running the whole suite twice in CI, once with the network
blocked.

### 1.2 One IR, many adapters (brief §3.2)

There are no format-to-format code paths. `render-docx` **MUST NOT** import
`adapters-docx`. No stage in the core may accept a string and return a string as its
primary contract. Adding a format is one adapter and/or one renderer.

### 1.3 Never lose silently (brief §3.3)

Every stage that discards or approximates information **MUST** emit a `Diagnostic` with a
source locator, and **MUST** retain the original payload where retention is possible (as an
`unknown` node, a sidecar entry, or a resource blob). In `--strict`, any diagnostic with
`lossy: true` sets exit code 3.

---

## 2. The IR

Package: `@markforge/ir`. Authoritative schema:
`packages/ir/schema/ir.v0.schema.json`. TypeScript types are **generated** from that
schema (ADR-0001); hand-written duplicates are forbidden.

### 2.1 Foundation: extended mdast (ADR-0001)

The semantic tree is mdast-compatible: mdast's node names, `children` arrays, and unist
`position` convention are used unchanged, so `unist-util-visit`, `remark-stringify`, and
third-party `unified` plugins work against our tree directly. Everything mdast lacks is
added as new node types or new fields, never by redefining existing ones.

Two things are deliberately **not** in the tree (ADR-0002): style evidence and provenance.
They live in id-keyed side tables on the document envelope. This keeps the tree a clean
semantic tree — a `heading` is a heading regardless of how we worked that out — and means a
consumer that only wants Markdown semantics can ignore the side tables entirely, while a
consumer building heading inference has everything it needs.

### 2.2 Document envelope

```ts
interface MarkForgeDocument {
  irVersion: string;              // semver of the IR schema, e.g. "0.1.0"
  id: string;                     // content-addressed document id, see §2.7
  body: Root;                     // mdast-compatible tree: the document's content
  furniture: Furniture[];         // running headers/footers/page numbers (ADR-0002)
  metadata: DocumentMetadata;
  sources: Record<SourceId, SourceFile>;
  resources: Record<ResourceId, Resource>;       // images, embedded files, by content hash
  styles: Record<StyleId, StyleDefinition>;      // the source document's style vocabulary
  numbering: Record<NumberingId, NumberingDefinition>;
  sidecar: Record<NodeId, StyleEvidence>;        // §2.4
  provenance: Record<NodeId, Provenance>;        // §2.5
  diagnostics: Diagnostic[];                     // §2.6
}
```

`furniture` exists because running headers, footers, and page numbers are neither body
content nor noise. Brief §5.2 asks for "header and footer stripping"; stripping them into
nothing would violate brief §3.3, so they are *routed* here instead. The idea is taken from
docling's `furniture` root and Unstructured's first-class `Header`/`Footer`/`PageNumber`
element types (see `PRIOR_ART.md` §3, §5).

Every node in `body` and `furniture` **MUST** carry `id: NodeId`. That id is the join key
for `sidecar` and `provenance`.

### 2.3 Node taxonomy (brief §4.1)

**Inherited from mdast unchanged (19):** `root`, `paragraph`, `heading`, `blockquote`,
`list`, `listItem`, `code`, `html`, `thematicBreak`, `definition`, `text`, `emphasis`,
`strong`, `inlineCode`, `break`, `link`, `image`, `linkReference`, `imageReference`.

**Inherited from GFM (6):** `table`, `tableRow`, `tableCell`, `delete`,
`footnoteDefinition`, `footnoteReference`.

**Inherited from other established extensions (4):** `yaml`, `toml` (front matter),
`inlineMath`, `math`.

**Fields added to inherited types:**

| Node | Added field | Meaning |
| --- | --- | --- |
| `heading` | `resolvedLevel: 1..9` | Semantic level; `depth` stays mdast-legal at 1..6 for stringify compatibility. Differs from `depth` only for levels 7–9. |
| `heading` | `numberLabel?: string` | Source-visible number, e.g. `"3.2.1"`, kept separate from the text so renderers can regenerate or preserve it |
| `list` | `numberingId?`, `level?` | Reference into `document.numbering` |
| `listItem` | `restartsAt?: number` | Explicit list restart (brief §5.1) |
| `tableCell` | `rowSpan: number = 1`, `colSpan: number = 1`, `isHeader: boolean` | Merged cells |
| `table` | `headerRowCount: number = 1`, `headerColCount: number = 0` | Header geometry beyond GFM's single header row |
| `code` | `lang?`, `meta?`, `filename?` | `lang`/`meta` are mdast; `filename` supports doc-tool fences |
| `image` | `resourceId?` | Points into `document.resources` instead of inlining base64 (the reference project's known weakness) |
| all | `id: NodeId` | Join key |

**MarkForge extension node types (24).** Each is listed with the source constructs that
produce it, because an extension type that no adapter can produce and no renderer consumes
is dead weight.

*Block:*

| Type | Fields | Produced by |
| --- | --- | --- |
| `section` | `resolvedLevel`, `headingId?` | `infer` only, never adapters. Optional grouping layer used by agentify §10 and by TOC generation |
| `figure` | `children: [content, caption?]` | DOCX drawing + adjacent caption paragraph; PDF figure + caption binding; HTML `<figure>` |
| `caption` | `for: "figure" \| "table" \| "equation" \| "listing"`, `numberLabel?` | Caption paragraphs bound to their target (brief §4.1) |
| `admonition` | `kind: note\|tip\|warning\|caution\|important\|custom`, `customKind?`, `title?` | MD directives, DOCX styled blocks, HTML `<aside>`, doc-tool callouts |
| `equationBlock` | `label?`, `numberLabel?`, `notation: "tex" \| "mathml" \| "omml"`, `source: string` | DOCX OMML, PDF math, MD `$$` |
| `descriptionList`, `descriptionTerm`, `descriptionDetails` | — | DOCX definition styles, HTML `<dl>`, Pandoc-flavour MD |
| `textBox` | `anchor: "inline" \| "floating"` | DOCX `wps:txbx`, PPTX shapes |
| `pageBreak`, `columnBreak` | — | Explicit breaks; distinct from spacing whitespace |
| `slide` | `slideNumber`, `layout?`, `title?`, `notes?: Root` | PPTX |
| `sheet` | `name`, `index`, `usedRange?` | XLSX; wraps a `table` |
| `unknown` | `construct: string`, `raw: string \| ResourceId`, `renderHint?` | **Any** adapter, for constructs the IR cannot express (brief §3.3, §5.2). Always paired with a diagnostic |

*Inline:*

| Type | Fields | Produced by |
| --- | --- | --- |
| `subscript`, `superscript` | — | DOCX `vertAlign`, HTML `<sub>`/`<sup>` |
| `underline` | — | DOCX `u`. Retained because DOCX round-trip needs it even though Markdown lacks a canonical form |
| `smallCaps` | — | DOCX `smallCaps` |
| `highlight` | `color?` | DOCX highlight, MD `==x==` |
| `crossReference` | `targetId?`, `targetKey?`, `kind: heading\|figure\|table\|equation\|footnote\|bibliography\|external`, `label?` | DOCX `REF` fields, PDF internal links, MD anchors |
| `citation` | `keys: string[]`, `prefix?`, `suffix?` | Pandoc-style `[@key]`, DOCX citation fields |
| `comment` | `commentId`, `author?`, `date?`, `resolved: boolean`, `body: Root`, `anchors: NodeId[]` | DOCX comments (brief §5.2) |
| `insertion`, `deletion` | `author?`, `date?`, `revisionId?` | DOCX tracked changes (brief §5.2) |

*Envelope-level:*

| Type | Fields |
| --- | --- |
| `Furniture` | `kind: header\|footer`, `scope: default\|firstPage\|evenPage\|oddPage`, `sectionIndex`, `content: Root` |

**`comment`, `insertion`, and `deletion` wrap content rather than annotating it**, because a
tracked deletion has a text range and a comment has an anchor range, and ranges that are
not tree nodes get corrupted by every tree transformation. The cost is that a consumer
ignorant of these types sees deleted text as present; mitigated by requiring renderers to
declare a `revisionMode` (§4.3).

### 2.4 Style provenance sidecar (brief §4.2)

Evidence about styling, **not styling itself**. Keyed by `NodeId`. This is the table every
other tool throws away (`PRIOR_ART.md` §8), and it is what makes brief §5.3 heading
inference and brief §5.1 template-faithful rendering possible.

```ts
interface StyleEvidence {
  sourceStyleId?: string;          // "Heading2"
  sourceStyleName?: string;        // "Heading 2", "Body Text", "ListParagraph"
  basedOn?: string[];              // resolved style inheritance chain, root last
  outlineLevel?: number;           // w:outlineLvl, 0-based as in OOXML
  font?: {
    family?: string;               // after theme1.xml resolution, never "+mn-lt"
    sizePt?: number;
    weight?: number;               // 400 | 700, or a real weight when known
    italic?: boolean; underline?: string; strike?: boolean;
    smallCaps?: boolean; allCaps?: boolean;
    color?: string; highlight?: string;
  };
  paragraph?: {
    alignment?: "left" | "center" | "right" | "justify";
    indentLeftPt?: number; indentRightPt?: number; firstLineIndentPt?: number;
    spaceBeforePt?: number; spaceAfterPt?: number;
    lineSpacing?: { value: number; rule: "auto" | "exact" | "atLeast" };
    keepWithNext?: boolean; keepLines?: boolean; pageBreakBefore?: boolean;
  };
  numbering?: {
    numId?: string; ilvl?: number;
    format?: "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman" | "bullet" | string;
    levelText?: string;            // "%1.%2."
    startAt?: number; restart?: boolean;
  };
  layout?: { bbox: BBox };
  cell?: {
    rowIndex: number; colIndex: number; rowSpan: number; colSpan: number;
    widthPt?: number; verticalMerge?: "start" | "continue";
    borders?: Record<"top"|"bottom"|"left"|"right", { style?: string; widthPt?: number }>;
  };
  origin: EvidenceOrigin;
}

type EvidenceOrigin =
  | "styleCascade"        // resolved through docDefaults -> style chain -> direct
  | "directFormatting"    // present only as inline run/paragraph properties
  | "layoutGeometry"      // measured from a paginated source
  | "ocr";

interface BBox {
  pageNumber: number;
  x: number; y: number; width: number; height: number;
  space: "pdfPoints" | "cssPixels" | "twips";
  origin: "topLeft" | "bottomLeft";
}
```

Two design points worth defending. **All lengths are normalized to points** (or declared
units on `BBox`), never left in source units — half-points, twips, and EMUs in the same
table is how unit bugs happen. **`BBox` names its coordinate space and origin**, a lesson
taken from Unstructured (`PRIOR_ART.md` §5): PDF is bottom-left origin in points, rendered
raster is top-left in pixels, and an unlabelled bbox silently mixes them.

`origin: "directFormatting"` is the flag that drives brief §5.1's core complaint. A DOCX
whose headings carry only direct formatting produces evidence with that origin, which is
exactly the signal that heading inference is needed and that a naive style-name mapping
will fail.

### 2.5 Provenance (brief §4.3, §3.7)

```ts
interface Provenance {
  sourceId: SourceId;
  locator: Locator;
  confidence?: number;                 // 0..1; absent means "certain"
  producedBy: Producer;
  derivedFrom?: NodeId[];              // set when normalize/infer replaced nodes
}

type Locator =
  | { kind: "ooxml"; part: string; xpath: string }                 // part: "word/document.xml"
  | { kind: "page";  pageNumber: number; bbox?: BBox }
  | { kind: "text";  startOffset: number; endOffset: number }      // byte offsets into the source
  | { kind: "markdown"; line: number; column: number; offset: number }
  | { kind: "cell";  sheet: string; ref: string }                  // "B7"
  | { kind: "slide"; slideNumber: number; shapeId?: string };

type Producer =
  | { kind: "adapter"; name: string; version: string }
  | { kind: "rule";    name: string; version: string }             // "heading/font-cluster@1"
  | { kind: "model";   model: string; promptVersion: string }      // brief §7.3, exact shape
  | { kind: "ocr";     engine: string; version: string };
```

Brief §3.7 requires every output artifact to map back to source file, page or paragraph,
and byte range. `Locator` covers all three shapes across formats, and `{kind:"text"}`
carries byte ranges for sources that have them. Brief §7.3's requirement that LLM-derived
nodes carry `producedBy: {model, promptVersion}` is satisfied by the `"model"` variant, and
it is the only variant that can appear on a node produced outside the deterministic core —
a property that is machine-checkable, so `markforge check --no-llm-provenance` can assert
that a document contains no model-derived nodes.

### 2.6 Diagnostics

```ts
interface Diagnostic {
  code: string;                      // "MF-DOCX-0007", stable forever once published
  severity: "info" | "warning" | "error";
  message: string;
  lossy: boolean;                    // true = information did not survive into the IR
  nodeId?: NodeId;
  locator?: Locator;
  construct?: string;                // "w:drawing/wps:txbx", the thing we could not model
  retained?: { as: "unknown" | "sidecar" | "resource"; ref: string };
  producedBy: Producer;
}
```

Code namespace: `MF-<AREA>-<NNNN>` where `<AREA>` is `IR`, `DOCX`, `PDF`, `MD`, `HTML`,
`PPTX`, `XLSX`, `OCR`, `RMD` (render-md), `RDOCX`, `RPDF`, `RHTML`, `INFER`, `LLM`,
`AGENTIFY`, or `CFG`. Codes are registered in `docs/DIAGNOSTICS.md` (Phase 1) and are
append-only.

Invariant, property-tested (brief §10): **for every construct present in the source and
absent from the IR, there is at least one `lossy: true` diagnostic.** Tested by taking
fixtures with a known inventory of constructs and asserting the diagnostic set covers the
difference.

### 2.7 Node ids and content hashing (ADR-0014)

Two distinct values, because change-detection and identity are different jobs.

**`NodeId`** — the join key. Computed bottom-up:

```
localDigest(node) = sha256( canonicalJson({
    type, salientAttrs(node), children: children.map(c => c.nodeId)
}) )
NodeId = "n_" + base32lower(localDigest).slice(0, 20) + ":" + occurrence
```

`salientAttrs` is a per-type allowlist declared in the schema — it excludes `position`,
excludes `id`, and excludes anything derived from the sidecar, so an id depends only on
semantic content. `occurrence` is a 0-based counter disambiguating nodes whose digest
collides within one document, assigned in document order. Both parts are needed: the digest
gives stability, the counter gives uniqueness for genuinely identical content (two `Yes`
cells in a table).

Consequences, stated because they are the point: an edit to paragraph 40 changes the ids of
paragraph 40 and its ancestors, and **nothing else** — not paragraph 41, not its siblings.
That is what makes brief §6.2 incremental regeneration produce a minimal `git diff`. A
positional path scheme (`/body/children/3`) would have been stable under content edits but
would renumber everything after an insertion, which is the more common editing operation.

**`contentHash`** — on `MarkForgeDocument` and on any node where a consumer needs
change-detection. Equal to `localDigest` in hex, i.e. covers the subtree. Used by agentify
(§10) and by the fidelity cache.

**Canonical JSON** for all hashing and for the on-disk `.mfir.json` form: UTF-8, NFC
normalization of all strings, object keys sorted by Unicode code point, no insignificant
whitespace, numbers in shortest round-trip form, and absent-vs-null distinguished by
omitting absent keys. Serialization round-trip is property-tested (brief §10).

#### 2.7.1 Amendment: table cells hold block *or* phrasing content

Recorded here because it changed the schema after Phase 0, and because the reason is the kind
that repeats.

`TableCell.children` originally accepted `PhrasingContent` only, following mdast literally.
That is right for Markdown and for a simple HTML cell, and wrong for everything else: a DOCX or
PPTX cell genuinely contains paragraphs, lists, and nested tables, and `CORPUS.md` §2.5 lists
"cells containing block content" as a construct under test. The schema therefore contradicted
the corpus plan, and the contradiction was invisible for two phases because **no test validated
a document containing a table**.

It now accepts either. Two further consequences of the same root cause, both fixed:

- `rowSpan`, `colSpan`, and `isHeader` are **required** on every cell. Four adapters omitted
  them at their defaults, so every table they produced failed validation. Cell construction now
  goes through `tableCell()` in `@markforge/ir`, which supplies them once rather than seven
  times, and a consumer never needs `?? 1`.
- The field is `headerRowCount`, not `headerRows`. Three adapters wrote the latter, which is
  not a field: it validated as an unevaluated property and every renderer read `undefined`, so
  header rows were silently lost.

`packages/ir/test/table-conformance.test.ts` exists to close the gap that hid all three.

### 2.8 Normalization

`normalize` runs after every adapter and is the **only** place whitespace rules are applied
(brief §5.1: "normalize whitespace once, at the IR level"). Rules, each individually
switchable in config (§7):

1. Empty paragraphs carrying no content become `spacingBefore` evidence on the following
   block and are removed from the tree, with an `info` diagnostic. Whitespace used as
   structure becomes structure.
2. Hard line breaks (`break`) are preserved as `break` and **MUST NOT** be promoted to
   paragraph splits (`whitespace.preserveHardBreaks`).
3. Trailing whitespace in `text` is trimmed at block boundaries; interior runs of
   whitespace collapse to a single space, except inside `code`, `inlineCode`, and `math`.
4. Adjacent `text` siblings merge. Adjacent identical inline marks merge
   (`**a****b**` → `**ab**`).
5. Unicode: NFC. Soft hyphens (U+00AD) removed. Non-breaking spaces preserved as-is —
   they are semantic, not whitespace.
6. A `figure` is formed when a caption-styled paragraph is adjacent to a single image or
   table, binding caption to target.

Every normalization is `derivedFrom`-tracked in provenance, so a report can explain why a
paragraph vanished.

**Idempotency (brief §3.5).** `normalize(normalize(x)) == normalize(x)`, property-tested
over generated IR documents, not just fixtures.

---

## 3. Adapter contract

```ts
interface Adapter<Opts = unknown> {
  readonly name: string;
  readonly version: string;
  readonly inputs: readonly InputMatcher[];        // media types + extensions + magic bytes
  sniff(bytes: Uint8Array, hint?: string): number; // 0..1 confidence, pure, cheap
  parse(input: AdapterInput, opts: Opts & CommonParseOptions): Promise<ParseResult>;
}

interface AdapterInput { bytes: Uint8Array; sourceId: SourceId; displayPath: string; }
interface ParseResult { document: MarkForgeDocument; report: ParseReport; }
interface CommonParseOptions { strict: boolean; resourceBudgetBytes?: number; signal?: AbortSignal; }
```

Rules, all testable:

- **A1** Deterministic per §1.1.
- **A2 No network.** Adapters run with network access denied in tests; a fetch attempt is a
  test failure. Includes not resolving external DTDs or OOXML external references.
- **A3 Diagnostics are mandatory** for every dropped or approximated construct (§2.6).
- **A4 Provenance for every node.** `provenance[node.id]` exists for every node the adapter
  creates. Checked by a validator, not by convention.
- **A5 Adapters record, they do not infer.** An adapter **MUST NOT** guess a heading level
  from a font size. It writes `font.sizePt` into the sidecar and, if the source states a
  level, writes `resolvedLevel`. Interpretation belongs to `infer` (§5). This separation is
  what makes inference independently testable and is why the same inference engine works
  for DOCX and PDF.
- **A6 Unknown before dropped.** If a construct cannot be modelled, emit an `unknown` node
  retaining the raw payload, plus a `lossy` diagnostic. Dropping outright is permitted only
  for constructs declared non-semantic in the adapter's documented ignore-list (e.g.
  `w:proofErr`).
- **A7 Streaming-safe resource handling.** Images and embedded files go to `resources` keyed
  by content hash, deduplicated. Never base64-inlined into the tree.

### 3.1 DOCX adapter (ADR-0005)

**Reads OOXML directly**; does not route through Mammoth or HTML. This is a deliberate
deviation from brief §5.2, recorded with full reasoning in ADR-0005 and
`PRIOR_ART.md` §8: Mammoth's documented behaviour is to discard fonts, sizes, and colours
in favour of semantic mapping, and those are precisely the sidecar inputs brief §4.2
requires.

Parts read: `word/document.xml`, `styles.xml`, `numbering.xml`, `theme1.xml`,
`settings.xml`, `footnotes.xml`, `endnotes.xml`, `comments.xml`,
`commentsExtended.xml`, `header*.xml`, `footer*.xml`, `_rels/*`, `docProps/*`, plus media.

**The style cascade resolver** is the heart of it, and it resolves in this order, matching
Word's own precedence:

```
docDefaults (w:docDefaults/w:rPrDefault, w:pPrDefault)
  → w:style chain via w:basedOn, root-first
    → table style conditional formatting (w:tblStylePr) where applicable
      → numbering-level properties (w:lvl/w:rPr, w:lvl/w:pPr)
        → paragraph mark properties (w:pPr/w:rPr)
          → direct run properties (w:r/w:rPr)
```

Theme font resolution (`+mn-lt`, `+mj-lt`, `+mn-ea`, …) is applied against `theme1.xml`, so
`font.family` in the sidecar is always a real font name. `origin` records the innermost
level that actually supplied each value, which is how `directFormatting` gets detected.

Also extracted: numbering definitions with `w:abstractNum`/`w:num` indirection resolved and
`w:lvlOverride`/`w:startOverride` producing `restartsAt`; comments with anchor ranges;
footnotes and endnotes; tracked changes (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`); text
boxes (`wps:txbx`, `v:textbox`); embedded images with `wp:docPr/@descr` alt text; fields
(`REF`, `PAGEREF`, `SEQ`, `TOC`, citations) mapped to `crossReference`/`citation` or to
`unknown` with the field code retained.

**Shared OOXML core.** The zip-plus-XML reader, part/relationship graph, cascade machinery,
and unit conversion live in `@markforge/ooxml` and are shared by the DOCX, XLSX, and PPTX
adapters, since SpreadsheetML and PresentationML are the same family. This also removes the
need for `xlsx`/`exceljs`, both of which are stale on npm (`PRIOR_ART.md` register).

### 3.2 Markdown adapter

`remark-parse` + `remark-gfm` + `remark-frontmatter` + `remark-math` +
`remark-directive`. Unknown constructs are **preserved**, not dropped (brief §5.2): unknown
directives become `unknown` nodes with the raw source retained, so `md → IR → md` is
lossless for content we do not understand.

### 3.3 PDF adapter (ADR-0012)

`pdfjs-dist` supplies positioned glyph runs, font names, sizes, and page geometry. Layout
analysis is ours:

1. **Line and block assembly** from glyph runs by baseline and gap clustering.
2. **Column detection** via vertical whitespace projection; reading order recovered per
   column, then columns ordered by page geometry.
3. **Header/footer detection** by cross-page repetition at consistent y-bands; routed to
   `furniture`, never dropped.
4. **Hyphenation and ligature repair**: line-final hyphens joined when the joined form is
   attested elsewhere in the document or in a wordlist; `ﬁ`/`ﬂ` expanded; soft hyphens
   removed.
5. **Table recovery**: ruling-line detection first, then whitespace-column alignment, then
   — only when geometry is ambiguous and only if enabled — the LLM path (§6). Confidence is
   recorded and low-confidence tables are diagnosed. This deterministic-first,
   confidence-gated escalation is copied from marker's architecture
   (`PRIOR_ART.md` §4).
6. **Figure and caption binding** by proximity and caption-pattern matching.
7. **Missing text layer**, tested **per page** rather than against a document average
   (OPEN_QUESTIONS §7i). An average hides the common real case — a born-digital report
   with a signed cover sheet, a photocopied appendix — which passes the document test
   while its scanned pages vanish. Three outcomes:
   - *every* page below the coverage threshold: `readPdf` returns `kind: "scan"` with the
     page images, and `parsePdf` throws, because a caller that asked for a document
     cannot be handed one;
   - *some* pages below: the readable pages convert, each unreadable page becomes an
     `unknown` placeholder node in reading position carrying a lossy diagnostic with its
     node id and page number, and only those pages are rasterised for a recogniser.
     Lossiness is what makes `--strict` exit non-zero;
   - *no* page below: the ordinary path.

   Either scanned branch routes to a recogniser with an `info` diagnostic recording the
   decision. **Two recognisers satisfy one interface** (`Recognizer` in
   `@markforge/adapters-ocr`, ADR-0017): tesseract.js locally, and a vision model behind
   `@markforge/llm`. That is what gives `--no-llm` a real scanned-page path rather than a
   refusal — tesseract is deterministic, offline, and needs no key. It is an
   `optionalDependency`, imported lazily on first use, and it refuses to run unless
   `langPath` names a local language-data directory or `allowDownload` is passed
   explicitly, because brief §3.6 makes every network call opt-in. A vision model reads
   structure tesseract cannot — it can see that a line is large and bold, where tesseract
   returns text and a confidence — so the two are ranked rather than interchangeable, and
   the difference is reported in the OCR rows of `FIDELITY.md`.

**Confidence is derived, not constant** (OPEN_QUESTIONS §7h). Every node this adapter
produces carries a `confidence` in provenance, computed from the evidence that produced it
rather than from a fixed value:

- *Reading order*, per page. One column scores 0.95 — near-certain, but deliberately not 1,
  because text laid out as a table with whitespace reads as one column and comes back as
  run-together lines. Multiple columns score on the narrowest gutter measured **in units of
  the page's own median word gap**, not in points: 12pt is a decisive break in 8pt type and
  ordinary word spacing in an 18pt display face. Below 2× is no evidence; 10× or more is as
  good as this measurement gets. The measurements themselves are kept in
  `PageLayout.readingOrderEvidence`.
- *Block type*. A heading scores on how far its size ratio clears the 1.15 threshold. A
  paragraph scores on how *few* of the four heading signals held — three of four is a near
  miss and is reported as such, because a near miss is precisely what a reviewer or a
  stronger model should be pointed at. A list scores highest of the three, because a marker
  is a character in the file rather than a measurement of one.

A node takes the weaker of the two, not their product: they are independent kinds of doubt,
and a node is only as trustworthy as its weakest link. The scale is **not calibrated and not
a probability**. It is required only to be monotonic in the strength of the evidence, which
is what makes "escalate the least confident decile to the vision model" a sentence that means
something — and what a constant made impossible.

### 3.4 Other adapters

**HTML**: `rehype-parse` to hast, then hast → IR. `<figure>`/`<figcaption>`,
`<aside>`, `<dl>`, `<sub>`/`<sup>`, `<table>` with `rowspan`/`colspan`, and `<!-- -->`
comments all map to real IR types. Inline `style` attributes become sidecar evidence, not
tree data.

**PPTX**: one `slide` per slide, `notes` as a `Root`, shapes as `textBox`/`figure`/`table`,
z-order and position into the sidecar.

**XLSX/CSV**: one `sheet` per sheet wrapping a `table`; merged ranges become spans; number
formats and formulas into the sidecar; formula results as cell text with the formula
retained.

**OCR**: `tesseract.js`, confidence propagated to `provenance.confidence` (brief §5.2),
`producedBy: {kind:"ocr", ...}` — or `{kind:"model", ...}` when a vision model transcribed the
page. The recogniser is an **injected function**, not an import
([ADR-0017](adr/0017-ocr-recognizer-boundary.md)): one of the two engines is the LLM layer,
which `adapters-*` may not depend on (§11), so `@markforge/core` composes the two and the
boundary stays mechanically enforceable. tesseract's language data must be supplied locally or
downloaded with explicit consent, because brief §3.6 makes no network call a default.

**RST, Notion, Confluence, EPUB**: Phase 2+; contract identical.

---

## 4. Renderer contract

```ts
interface Renderer<Opts = unknown> {
  readonly name: string;
  readonly version: string;
  readonly output: MediaType;
  readonly capabilities: RendererCapabilities;
  render(doc: MarkForgeDocument, profile: ResolvedProfile, opts?: Opts): Promise<RenderResult>;
}

interface RenderResult { files: OutputFile[]; report: RenderReport; }
interface OutputFile { path: string; bytes: Uint8Array; role: "primary" | "asset" | "sidecar"; }
```

- **R1** Deterministic per §1.1.
- **R2 The IR is the only input.** A renderer reads `doc` and `profile` and nothing else —
  no filesystem access outside declared profile assets, no network, no re-parsing of
  sources.
- **R3 Declare capabilities, diagnose gaps.** `capabilities` enumerates which IR node types
  the renderer can express. Any node type present in the document and absent from
  `capabilities` **MUST** produce a `lossy` diagnostic. This makes "Markdown cannot express
  tracked changes" a reported fact rather than a silent omission.
- **R4** Output paths are relative and stable.

### 4.1 Markdown renderer (ADR-0006)

`remark-stringify` with a fully pinned option set, configured so its output already
satisfies the lint rule set, then `markdownlint` in **check-only** mode as a CI gate, then a
re-parse check. Prettier is not in the pipeline (`PRIOR_ART.md` §16), and neither is
markdownlint autofix: ADR-0006 was amended on 2026-07-31 to drop the repair loop, because
two formatters that can disagree can each undo the other, and that mutual undoing was the
only reason a fixed point was ever in doubt. Measured at 34 files, zero violations, no
autofix pass (`scripts/check-markdown-lint.mjs`).

Flavour presets are **data**: CommonMark, GFM, MDX, Docusaurus, MkDocs Material, Obsidian,
Pandoc. A preset declares available syntax (footnote form, math delimiters, admonition
syntax, table style, front-matter language) plus a `remark-stringify` option set. Nothing
about a flavour lives in code.

**Table degradation policy** (OPEN_QUESTIONS §7e). A GFM pipe cell holds one line of inline
content, so it can express neither a merged cell nor a cell containing block content — and
our `TableCell.children` was deliberately widened to allow the latter (§2.7.1), which makes
the collision structural rather than incidental. The policy, `markdown.tables`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Pipe syntax when every cell fits it; a raw HTML `<table>` for the whole table when any cell does not. Nothing is lost, and an `info` diagnostic records the switch. |
| `gfm` | Always pipe syntax. Merges and block content are flattened, and every table it damages gets a `degraded` diagnostic naming what went. |
| `html` | Always an HTML table, so a downstream tool sees one syntax rather than two. |

The whole table degrades, not the offending cell: a table half in pipes and half in HTML is
not valid either way. HTML blocks are CommonMark, and the fragment is produced by
`renderHtmlFragment` — the same serializer our HTML adapter reads back — so `auto` output
round-trips into the same IR rather than into a second dialect nobody tests.

**Under no setting is the choice silent.** Writing a merged table as pipes does not merely
lose the merge: covered grid positions come back as empty cells, so a 6-cell table with two
merges re-parses as 8 cells with only 3 on their original coordinates. That measured at a
table-cell F1 of 42.9% on `fixtures/docx/messy-combined.docx`, undiagnosed, before this
policy existed — which is exactly the failure §1.3 forbids.

**Idempotency proof obligation.** `fmt(fmt(x)) == fmt(x)` for all `x`, established by:
(a) `stringify` is a total function of the tree; (b) `parse(stringify(t))` is
tree-equivalent to `t` under the flavour's normalization — property-tested by round-tripping
generated trees. There is no clause (c): with one authority in the pipeline the property
follows from (a) and (b) rather than needing a convergence argument. Exposed standalone as
`markforge fmt`, which brief §5.4 rightly notes is a useful product by itself, and as
`formatMarkdownSync` — the one synchronous entry point in `@markforge/core` (§7j).

### 4.2 DOCX renderer (ADR-0004)

Built on `docx@9.7.1`. Two hard rules from brief §5.1:

- **Named styles only.** Every block maps to a named paragraph style. Inline formatting is
  emitted **only** for genuine inline semantics: `strong`, `emphasis`, `inlineCode`,
  `subscript`, `superscript`, `delete`, `underline`, `smallCaps`, `highlight`. A heading
  **MUST NOT** carry direct font properties. This is the fix for "uneven fonts".
- **Render into a reference document.** The user supplies a `.docx`/`.dotx` via
  `docx.referenceDoc`; we resolve IR roles onto the style ids already defined there and copy
  the reference's `styles.xml`, `theme1.xml`, `numbering.xml`, and section properties verbatim.

**Role → style-name mapping uses Pandoc's vocabulary verbatim** (`PRIOR_ART.md` §11):
`Normal`, `Body Text`, `First Paragraph`, `Compact`, `Title`, `Subtitle`, `Author`, `Date`,
`Heading 1`–`Heading 9`, `Abstract`, `AbstractTitle`, `Bibliography`, `Block Text`,
`Footnote Block Text`, `Source Code`, `Footnote Text`, `Definition Term`, `Definition`,
`Caption`, `Table Caption`, `Image Caption`, `Figure`, `Captioned Figure`, `TOC Heading`;
character styles `Default Paragraph Font`, `Verbatim Char`, `Footnote Reference`,
`Hyperlink`, `Section Number`; table style `Table`. Consequence: **any existing Pandoc
reference document works with MarkForge unchanged.** Missing styles are reported, and
either synthesized or failed depending on `docx.onMissingStyle`.

Numbering maps to the reference document's definitions, preserving `restartsAt` (brief
§5.1).

#### 4.2.1 Shipped reference documents (brief §5.4)

Three defaults, all **authored by us and Apache-2.0** (ADR-0004): `clean-report.docx`,
`academic-manuscript.docx`, `technical-documentation.docx`.

`academic-manuscript.docx` is the **primary** template and the one the Phase 1 round-trip gate
runs against, on the reviewer's reasoning that journal manuscript templates are both carefully
typeset and construct-complete — title block, abstract, numbered multi-level sections,
display equations, numbered figure and table captions, footnotes, and a bibliography, which is
close to the full Pandoc style vocabulary above in one document. A template exercising more
constructs is a better gate than three exercising few.

It is **structurally modelled on the IEEE conference proceedings template**, which the reviewer
supplied as the starting point, with the constructs that template lacks added. `TEMPLATES.md`
§2.1 specifies its required contents row by row; §3.1 records the IEEE measurements it was
derived from.

**No publisher template file is redistributed.** The reason is verified rather than cautious:
IEEE publishes the conference templates for authors preparing IEEE submissions and grants no
redistribution right, and the alternatives are no better — MDPI's CC BY covers published
*articles*, not the blank `.dot` template file, which is frequently mistaken for a licence on
it. Shipping any of them inside an Apache-2.0 package (ADR-0008) would be an unrecorded licence
assumption in a distributed artifact — a worse problem than in a fixture, since it reaches every
user. Local copies live in gitignored `fixtures/local/`.

This costs nothing functionally, because **`docx.referenceDoc` accepts any template the user
already has.** A user who wants exact MDPI or PLOS output downloads that publisher's template
and points `referenceDoc` at it; the Pandoc style vocabulary is what makes it work. To make
that predictable rather than trial-and-error:

```
markforge check --reference-doc <path>
```

reports which of the style names above the template defines, which are missing, and what
`onMissingStyle: "synthesize"` would generate — so compatibility is answerable before a
conversion, offline, against a file we never had to ship. **`docs/TEMPLATES.md`** lists
known-good publisher templates with their download pages — links rather than copies, each
verified by running the check above rather than assumed — and carries the shipped templates'
authoring specification.

#### 4.2.2 Measured: third-party templates mostly do not use Pandoc's names

The check above was run by hand against the **IEEE conference proceedings template**
(43 defined styles, 112 paragraphs) on 2026-07-30. **It defines 8 of the 38 Pandoc style
names**: `Normal`, `Heading 1`–`Heading 3`, `Abstract`, `Caption`, `Default Paragraph Font`,
`Hyperlink`. The 30 missing include `Title`, `Author`, `Body Text`, `Block Text`,
`Footnote Text`, `Source Code`, `Bibliography`, `Table Caption`, `Heading 4`–`9`, and the
`Table` table style.

It is not that those constructs are absent. The template has all of them under **its own
names**: `paper title`, `Author Data`/`AuthorName`, `Body Text Indent`, `BlockQuote`,
`BulletList`, `NumberedList`, `Table Head`, `Table text`, `Source`. `TEMPLATES.md` §3.1 ships
the complete `styleMap` for it, and records what a `styleMap` cannot fix.

Those are `w:name` values; the same styles carry compressed `w:styleId`s (`papertitle`,
`AuthorData`, `TableHead`, `Tabletext`). **`styleMap` values resolve against `w:name` first,
then `w:styleId`**, so either works — Word's UI shows users the name while `w:pStyle` carries
the id, and requiring the user to know which is which would be a needless trap.

This corrects an assumption in ADR-0004. "Any existing Pandoc reference document works
unchanged" remains true and is still worth having, but **Pandoc reference documents are a
narrow population**; an arbitrary publisher template is not one. So:

- **`docx.styleMap` is the primary mechanism for third-party templates, not an edge case.**
  The config example in §7 shows it handling admonitions, which understates it. A realistic
  entry for the IEEE template (complete version in `TEMPLATES.md` §3.1):

  ```ts
  docx: {
    referenceDoc: "./fixtures/local/ieee-conference-template.docx",
    styleMap: {
      "title": "paper title", "author": "Author Data", "paragraph": "Body Text Indent",
      "blockquote": "BlockQuote", "list:unordered": "BulletList",
      "list:ordered": "NumberedList", "tableHeaderCell": "Table Head",
      "tableCell": "Table text", "figureAttribution": "Source",
    },
    onMissingStyle: "synthesize",
  }
  ```

- `markforge check --reference-doc` therefore **emits a `styleMap` skeleton**, pre-filled where
  a name matches and left blank where it does not, so adapting a template is an edit rather
  than an investigation. This is the difference between the feature being usable and being
  technically present.
- **`onMissingStyle: "synthesize"` is the common path for third-party templates**, so its
  output quality matters more than the "rare fallback" framing in ADR-0004 implied. A
  synthesized style **MUST** derive its properties from the reference document's
  `docDefaults` and nearest `basedOn` ancestor (§3.1's cascade, run in reverse), never from
  hardcoded defaults — otherwise a synthesized `Heading 4` in a Times 10pt two-column template
  arrives as Calibri 16pt and the output looks broken in exactly the way brief §5.1 complains
  about.

Two further observations from the same file, both now fixture material (`CORPUS.md` §2.3):
`heading 2` is `basedOn: Heading1` while `heading 3` is `basedOn: Normal`, an inconsistent
cascade that a naive resolver will get wrong; and the template's own equation example is the
literal text `a + b = c.` in a body paragraph with no OMML anywhere in the file, which is the
manual-formatting-instead-of-semantics defect in its purest form.

### 4.3 PDF renderer (ADR-0003)

Typst via `@myriaddreamin/typst.ts`. IR → Typst markup → PDF, with `SOURCE_DATE_EPOCH`
honoured, `pdf.ignoreSystemFonts` on by default and required for byte-identical output across
machines, and fonts supplied explicitly by the profile and embedded. Requirements from brief §5.4 and how each is met: no font substitution
(system fonts disabled, profile fonts embedded); deterministic pagination (Typst's own
layout engine, not a browser's); working TOC and internal links (`crossReference` →
Typst labels and references); correct table breaking (Typst table repeat-header); figure and
caption placement (`figure`/`caption` → Typst `figure` with `caption`). PDF/A and PDF/UA are
selectable per profile.

`revisionMode: "clean" | "showInsertions" | "showAll"` controls `insertion`/`deletion`
handling and applies to the DOCX and HTML renderers too (§2.3).

### 4.4 HTML renderer

Semantic elements, no inline style attributes, no class soup. A single stylesheet emitted as
an asset. Headings carry stable ids from `NodeId` so `crossReference` resolves. Targets
WCAG 2.2 AA structure: one `h1`, no level skips, table `scope`/`headers`, `figure`/
`figcaption`, `alt` on every image or an explicit `role="presentation"`.

---

## 5. Inference

Package `@markforge/infer`. Deterministic by default; the LLM may only break ties within a
candidate set (brief §5.3, §7.1).

### 5.1 Heading inference

Input: the sidecar. Output: `resolvedLevel` on headings, plus a `HeadingEvidence` record per
decision. Deterministic signals, in priority order:

1. **Explicit outline level** (`outlineLevel`) or a style name matching a known heading
   vocabulary (`Heading N`, `Title`, `Subtitle`, and localized equivalents held as data).
   Highest confidence; no clustering needed.
2. **Numbering pattern** in the text: `1.`, `1.1`, `1.1.1`, `A.`, `IV.`, `Chapter N`,
   `Section N`, `Article N`, `Appendix A`. Depth from separator count. Patterns are data,
   not regex literals in code, so localization is a data change.
3. **Font-size and weight clustering.** Collect `(sizePt, weight)` over all blocks; body
   text is the modal cluster by total character count, not by block count — a document with
   many short headings must not have a heading cluster mistaken for body. Clusters strictly
   larger or bolder than body become candidate heading levels, ordered by size descending.
4. **Position and spacing**: `spaceBeforePt`, `keepWithNext`, `pageBreakBefore`, short
   single-line blocks, and blocks isolated by whitespace.
5. **Monotonicity repair**: level sequences may not skip more than one level downward;
   violations are repaired to the nearest legal level and diagnosed.

Every heading gets a `HeadingEvidence` record listing signals used, candidate levels with
scores, the chosen level, and the deciding rule — written to provenance as
`producedBy: {kind:"rule", name:"heading/<rule>@<v>"}` and dumped by
`markforge convert --explain`. Brief §5.3 requires logging every inference with its
evidence; this is that log.

**Ambiguity is declared, not hidden.** When the top two candidates are within
`inference.ambiguityMargin`, the node is marked ambiguous. Only then may the LLM choose — **from the candidate
set**, never inventing a level (brief §5.3, §7.1). With `--no-llm`, the highest-scoring
candidate wins and a `warning` diagnostic records the ambiguity.

### 5.2 List reconstruction

From `numbering.numId`/`ilvl` when present. Otherwise from indent clustering plus marker
pattern continuity: a marker sequence that continues (`3.` after `2.`) binds to the same
list; a restart at `1.` with equal indent starts a new list unless `restartsAt` says
otherwise. Fixes the reference project's "numbered lists become bullet lists" defect.

### 5.3 Table structure inference

DOCX and HTML give spans directly. PDF does not: ruling lines first, whitespace-column
alignment second, LLM only when geometry is ambiguous and enabled. Confidence is recorded
per table.

---

## 6. LLM layer

Package `@markforge/llm`. `llm.enabled` defaults to `false` and nothing here runs until it is
set (brief §3.6). Transport and credential rules are in ADR-0009.

**Permitted** (brief §7.1): heading tie-breaking within a deterministic candidate set;
document role classification; context-unit extraction and summarization; scanned-page
transcription; table structure recovery when geometry is ambiguous; alt-text generation;
glossary extraction.

**Forbidden**: anything on the deterministic conversion path; generating structure not
evidenced in the source; any step whose failure would silently change conversion output.
Enforced structurally — `@markforge/render-*` and `@markforge/adapters-*` **MUST NOT**
declare `@markforge/llm` as a dependency, checked by a lint rule in CI, which turns a
policy into a build failure.

### 6.1 Endpoint and model selection (brief §7.2, simplified — ADR-0009)

**There is no model registry and no routing policy file.** Brief §7.2 asked for
`models.registry.json` generated from `Navigator-Models.xlsx` with cost, latency, and
hosted-vs-local capability tags. That was **descoped by the reviewer** (ADR-0009): the
gateway is a single OpenAI-compatible endpoint, access is flat-rate for UF affiliates, so
cost-aware routing has nothing to route on and a generated registry would be ceremony
around three model names.

The whole LLM configuration is three things — a URL, the name of an env var, and one model
name per role:

```ts
llm: {
  enabled: false,
  baseUrl: "https://api.ai.it.ufl.edu/v1",
  apiKeyEnv: "MODEL_API_KEY",
  models: {
    fast:   "gpt-oss-120b",                 // classification, extraction, alt text
    strong: "nemotron-3-super-120b-a12b",   // synthesis, conflict analysis, summarization
    vision: "gemma-4-31b-it",               // scanned pages, ambiguous table geometry
    embed:  "nomic-embed-text-v1.5",        // near-duplicate context units (§10.4)
  },
  // Optional. Overrides the §6.2 defaults, per task.
  taskRoles: { "heading-tiebreak": "strong" },
}
```

Four roles, `fast | strong | vision | embed`, each a bare model-name string passed straight
through as the OpenAI `model` parameter. Adding a model means editing one string, which is
the whole point of not having a registry.

**The role names are closed; the task → role bindings are open** (OPEN_QUESTIONS §7c). The two
differ in how they fail. A role is a capability distinction the code has to know how to *use* —
`vision` takes image parts, `embed` calls a different endpoint shape — so a fifth role is
properly a code change. A binding is only a preference, and bindings are where experience
actually changes its mind: a heading tie-break worth sending to `strong` on one corpus belongs
on `fast` for another, and that should be a config edit rather than a patch. So §6.2's table is
the default, `llm.taskRoles` overrides it per key, and an unknown task name is rejected rather
than silently ignored.

`embed` exists from the start rather than being added in Phase 4 because §10.4 merges
near-duplicate context units, and lexical similarity cannot do that job: the same constraint
stated in a PRD and in an ADR shares almost no tokens. `nomic-embed-text-v1.5` over
`sfr-embedding-mistral` because context units are short by construction, so 8K context is
ample and the smaller model is cheaper at the volume deduplication implies.

`Navigator-Models.xlsx` was read once, in-memory, to choose those three defaults (brief §7.2
required reading rather than assuming its schema; the inventory is recorded in
`OPEN_QUESTIONS.md` §1 for the record). **It is not a build input.** No artifact is generated
from it, no code reads it, and it does not appear in any package's dependency graph. Nothing
breaks if the file moves or changes.

Credentials come from environment variables only: `llm.apiKeyEnv` holds the *name* of the
variable, never a key. Default `MODEL_API_KEY`, matching the convention already used in the
reviewer's other projects against this gateway, so one exported key serves all of them. A
missing variable when `llm.enabled` is `true` is a startup error (exit 1), never a silent
fallback to `--no-llm`, because silently producing different output is worse than failing.

### 6.2 Task → role mapping

Defaults, overridable per task via `llm.taskRoles` (§6.1). The table below is
`DEFAULT_TASK_ROLES` in `@markforge/llm`:

| Task (all from brief §7.1's permitted list) | Role |
| --- | --- |
| Document role classification (§10.2) | `fast` |
| Context-unit extraction (§10.3) | `fast` |
| Alt-text generation | `fast` (`vision` when the image is the input) |
| Heading tie-breaking within a deterministic candidate set (§5.1) | `fast` |
| Context-unit summarization and merge (§10.4) | `strong` |
| Conflict analysis (§10.4 — analysis only; resolution is never automatic) | `strong` |
| Glossary extraction (§10.3) | `strong` |
| Scanned-page transcription (§3.3) | `vision` |
| Table structure recovery when geometry is ambiguous (ADR-0012) | `vision` |
| Near-duplicate context-unit merging (§10.4) | `embed` |

**No fallback chains.** If a call fails after its repair attempts, the call fails and the
deterministic fallback for that task applies, with a diagnostic. A fallback chain silently
substituting a weaker model would make output depend on transient endpoint health, which
breaks the determinism story in §1 for no real benefit.

**Budget is token-based only**, `llm.budget.maxTokens`. There is no `maxUsd`: the endpoint
exposes no pricing, so a dollar ceiling would be computed from invented numbers, and
ADR-0009 rejects inventing capability data.

Note for design purposes: this catalog contains **no frontier hosted model**; the strongest
general model is `nemotron-3-super-120b-a12b`. Everything downstream must assume competent
open-weight models rather than frontier reasoning, which raises the value of schema-validated
structured output and the repair loop below, and is a reason the verification gate in §10.6
is mandatory rather than advisory.

### 6.3 Reproducibility (brief §7.3)

- Temperature 0; `seed` and `response_format: {type:"json_schema"}` sent when the endpoint
  accepts them. **Capability is probed once, not assumed**: `markforge check --llm` issues two
  throwaway calls, records what the gateway accepted in `.markforge/llm-capabilities.json`,
  and the client degrades to prompt-instructed JSON plus the repair loop when guided decoding
  is unavailable. Probing beats a config flag because the answer is a property of the
  deployment, not of the user's intent, and it is cheap to discover.
- Prompts are **files**, not inline strings: `packages/llm/prompts/<task>/<version>.md`.
  The prompt version participates in the cache key.
- Structured output with JSON Schema validation via `ajv`, and a **bounded** repair loop:
  at most `maxRepairs` (default 2) attempts, each fed the validation error; on final failure
  the call fails and the deterministic fallback applies. Model responses are **never**
  regex-parsed.
- **Content-addressed cache**, key `sha256(inputContent + modelId + promptVersion +
  canonicalJson(params))`. A cached run is byte-reproducible and free. The cache is
  committable so CI is deterministic and offline (brief §10). Runtime details — what
  `params` contains, why the prompt's *content digest* joins its version in the key, and
  the `cache.mode: "readOnly"` offline mode that needs no API key — are in
  [ADR-0016](adr/0016-llm-runtime-cache-and-offline-mode.md). Measured against this
  deployment, guided decoding and `seed` are both available (`OPEN_QUESTIONS.md` §3), so
  the repair loop is a fallback here rather than the primary mechanism.
- Per-call token accounting aggregated into the run report; exceeding `budget.maxTokens`
  aborts rather than silently continuing.
- Every LLM-derived node carries `producedBy: {model, promptVersion}` (§2.5).

---

## 7. Configuration

`markforge.config.ts` with `defineConfig` for types, or `markforge.config.json` validated by
`schema/markforge.config.v0.schema.json`. Zod validates at runtime; the JSON Schema is
generated from the Zod schema so the two cannot drift.

```ts
import { defineConfig } from "@markforge/core";

export default defineConfig({
  $schema: "./node_modules/@markforge/core/schema/markforge.config.v0.schema.json",
  profile: "technical-documentation",     // named preset; everything below overrides it
  strict: false,

  markdown: {
    flavor: "gfm",
    headings: "atx",
    bullet: "-", emphasis: "_", strong: "*",
    fence: "`", fences: true,
    listIndent: "one",
    lineWidth: 0,                         // 0 = never reflow; reflowing breaks git diffs
    lint: { config: ".markdownlint.jsonc", autofix: true, maxIterations: 8 },
  },

  whitespace: {
    emptyParagraphsToSpacing: true,
    collapseInteriorWhitespace: true,
    preserveHardBreaks: true,
    trimTrailing: true,
  },

  docx: {
    referenceDoc: "./templates/technical-documentation.docx",
    styleMap: { "heading:1": "Heading 1", "admonition:warning": "Block Text" },
    onMissingStyle: "warn",               // "warn" | "error" | "synthesize"
    revisionMode: "clean",
  },

  pdf: {
    engine: "typst",
    theme: "./themes/technical.typ",
    fonts: [{ family: "Inter", files: ["./fonts/Inter.ttf"] }],
    standard: "pdf/a-3b",                 // or "pdf/ua-1" | "none"
    ignoreSystemFonts: true,
  },

  html: { stylesheet: "./themes/technical.css", singleFile: false },

  inference: { headings: true, lists: true, tables: true, ambiguityMargin: 0.15 },

  llm: {
    enabled: false,                       // brief §3.6: never a default
    baseUrl: "https://api.ai.it.ufl.edu/v1",
    apiKeyEnv: "MODEL_API_KEY",           // name only; the value is never in config
    models: {                             // §6.1 — three roles, no registry
      fast: "gpt-oss-120b",
      strong: "nemotron-3-super-120b-a12b",
      vision: "gemma-4-31b-it",
    },
    cache: { dir: ".markforge/llm-cache", mode: "readWrite" },
    budget: { maxTokens: 200000 },        // no maxUsd; the endpoint exposes no pricing
    maxRepairs: 2,
  },

  agentify: {
    targets: ["agents-md", "claude-md", "claude-skills", "mcp-manifest"],
    registry: "./targets",
    outDir: ".",
    conflicts: "report",                  // "report" | "failOnConflict"
    traceability: { required: 1.0 },
  },

  fidelity: { baseline: "./fidelity/baselines.json", tolerance: 0.005 },
});
```

Precedence: CLI flags > env (`MARKFORGE_*`) > config file > named profile > built-in
defaults. Resolution is reported by `markforge init --print-config`.

---

## 8. CLI surface

Every command supports `--json` (a stable machine-readable envelope), `--no-llm`,
`--strict`, `--config <path>`, `--profile <name>`, `--quiet`, `--verbose`, and
`--no-color`. `--json` emits exactly one JSON object on stdout; human output goes to stderr
when `--json` is set, so piping is safe.

| Command | Purpose |
| --- | --- |
| `convert <in...> -o <out>` | Any input → any output. `--to <fmt>`, `--explain`, `--emit-ir <path>`, `--report <path>` |
| `fmt [globs...]` | Markdown normalization. `--check` (no writes, exit 3 if changes needed), `--write`, `--stdin` |
| `agentify <sources...>` | The Agent Context Compiler (§10). `--targets`, `--budget`, `--dry-run`, `--explain-drops` |
| `check [paths...]` | Validate IR/config/output, run the fidelity harness against baselines, assert traceability |
| `diff <a> <b>` | Semantic IR diff, not a text diff. `--metric` to print fidelity scores for the pair |
| `serve` | Local HTTP API (brief §8), stateless, no document retention |
| `init` | Scaffold config, reference docs, and lint config. `--print-config` |

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success, no lossy diagnostics |
| 1 | Error: unreadable input, invalid config, usage error, internal failure |
| 2 | Completed with lossy diagnostics **and** `--strict` was set |
| 3 | `fmt --check` found files needing changes |
| 4 | Fidelity regression against baseline (`check`) |
| 5 | Agentify verification gate failed: traceability below `required` |

`--explain` on `convert` writes the full inference log (§5.1) — candidates, scores, and the
deciding rule per node.

---

## 9. Fidelity measurement

Package `@markforge/fidelity`. Brief §3.4: fidelity is measured, not asserted. All metrics
are in `[0, 1]`, higher is better, and all are computed on **IR pairs**, never on strings.

### 9.1 Structural similarity

Project each document's `body` into a labelled ordered tree. The label of a node is
`(type, salientProjection(type, node))` where `salientProjection` is a fixed per-type list
declared alongside the schema — for example `heading → (resolvedLevel)`,
`tableCell → (rowSpan, colSpan, isHeader)`, `list → (ordered)`, `code → (lang)`,
`text → ()` (text content is excluded here; §9.2 measures it).

Compute ordered tree edit distance (Zhang–Shasha) with unit cost for insert, delete, and
relabel. Then:

```
structural = 1 - TED(T_in, T_out) / (|T_in| + |T_out|)
```

The denominator is the sum of node counts, which bounds TED, so the result is in `[0,1]` and
is symmetric. Trees above a configured size use the same metric on a
section-decomposed basis to keep the O(n²) cost tractable; the decomposition boundary is
recorded in the report so scores stay comparable.

### 9.2 Text similarity

Extract text by in-order traversal: inline nodes concatenate with no separator, block nodes
join with `\n\n`, `break` yields `\n`. Two variants, **reported separately** (brief §10):

- **Whitespace-sensitive**: compare the extracted strings after NFC only.
- **Whitespace-insensitive**: additionally collapse each run of whitespace to one space and
  trim each block.

For each, `text = 1 - levenshtein(a, b) / max(|a|, |b|)`, computed over Unicode grapheme
clusters, not UTF-16 code units, so CJK and emoji fixtures score correctly.

### 9.3 Table similarity

Align tables between documents by document order (an unmatched table counts as all-miss).
Within an aligned pair, represent each table as a set of cells keyed
`(rowStart, colStart, rowSpan, colSpan)` with whitespace-insensitive normalized text.

- **Full cell F1**: a true positive requires key **and** text to match. Precision, recall,
  and F1 reported.
- **Content-only F1**: the same computation keyed on `(rowStart, colStart)` alone, ignoring
  spans.

Both are reported because the gap between them isolates span errors from content errors,
which is the difference between a table that reads correctly and one that does not.

### 9.4 Inline styling agreement

Build a span set over the whitespace-insensitive text stream: for each of `strong`,
`emphasis`, `inlineCode`, `delete`, `subscript`, `superscript`, `link`, each instance
contributes `(kind, startOffset, endOffset)`, and `link` additionally contributes its
resolved target. Precision, recall, and F1 per kind plus a macro-average. Offset-based
rather than tree-based, so `**a** **b**` versus `**a b**` is scored on the text it actually
emphasizes.

### 9.5 Round trips

Required loops (brief §10), for every applicable fixture:

| Loop | What it measures |
| --- | --- |
| `docx → md → docx` | Phase 1 gate: must beat `word-to-markdown-js` and Pandoc |
| `md → md` | Idempotency and normalization stability |
| `md → pdf → md` | The PDF loop. **The return leg uses our own PDF adapter**, so this number is a joint measure of the renderer and the extractor and must never be quoted as a renderer-only score |
| `docx → md → docx → md` | Second-generation stability; scores must not decay further |

### 9.6 Baselines, property tests, visual regression

**Baselines**: `fidelity/baselines.json`, one record per (fixture, loop, metric) with the
recorded score. CI recomputes and fails on any drop beyond `fidelity.tolerance` (default
0.005), exit 4. Improvements require an explicit baseline update commit, so a score change is
always visible in review.

**Scoreboard**: `docs/FIDELITY.md`, generated, including columns for
`word-to-markdown-js`, Pandoc, and markitdown on the same corpus. Brief §10 says be honest
where we lose; the generator therefore has no mechanism to omit a row.

**Property tests** (brief §10): `fmt` idempotency; `normalize` idempotency; IR canonical
serialization round-trip; and the loss invariant of §2.6 — no construct disappears without a
`lossy` diagnostic.

**LLM tests** run against the committed cache and are therefore deterministic and offline. A
separate non-blocking scheduled job runs live to detect model drift.

**Visual regression**: rasterize rendered DOCX (via a documented optional LibreOffice
container, isolated per brief §13 and used only in CI) and PDF (via Typst/pdfium), compare
against approved PNG snapshots with a perceptual threshold. This is the only check that
catches "it converted but it looks wrong", which is the complaint driving Surface B.

---

## 10. Agent Context Compiler

Package `@markforge/agentify`. Reuses Surface B machinery end to end (brief §6.1).

### 10.1 Ingest

Every source document → IR via the adapters of §3. No separate ingestion path.

### 10.2 Classify

Roles: `productSpec`, `architecture`, `codingConventions`, `domainGlossary`, `apiContract`,
`runbook`, `testPolicy`, `decisionRecord`, `meetingNotes`, `unknown`.

Rule-based priors first — filename patterns, heading vocabulary, keyword profile, document
structure — producing a scored distribution. The LLM classifier may adjust, never replace:
final role is the prior unless the model's choice exceeds it by a configured margin, and the
disagreement is logged either way. Never LLM-only (brief §6.2).

### 10.3 Extract context units

```ts
interface ContextUnit {
  id: string;                      // content-addressed, §2.7 scheme
  category: "constraint" | "invariant" | "convention" | "command" | "entity"
          | "glossaryTerm" | "decision" | "antiPattern" | "dependency" | "environmentVariable";
  text: string;                    // atomic, self-contained, imperative where applicable
  rationale?: string;              // required when category === "decision" (brief §6.1)
  sources: Array<{ sourceId: SourceId; nodeIds: NodeId[]; locator: Locator }>;
  documentRole: DocumentRole;
  authority: number;               // 0..1, from source recency and declared authority
  confidence: number;              // 0..1
  contentHash: string;
  supersedes?: string[];
  conflictsWith?: string[];
  producedBy: Producer;
}
```

Atomic and addressable: one fact per unit, so budgeting can drop a unit without corrupting a
neighbour. Deterministic extractors handle the mechanical categories — `command` from code
fences and runbook steps, `environmentVariable` from `NAME=value` and `process.env` patterns,
`dependency` from manifests, `glossaryTerm` from definition lists. The LLM handles the prose
categories, schema-validated.

### 10.4 Deduplicate and resolve

Near-duplicates merge by **cosine distance between embeddings**, not by normalized-text
similarity, with the merged unit retaining **all** source references — provenance is additive,
never replaced. The `embed` role serves this task (§6.1, `context-unit-dedup`).

This was a text threshold until OPEN_QUESTIONS §7c. The same constraint written in a PRD and
in an ADR shares almost no tokens, and the corpus now says so as a number rather than as an
argument: both near-duplicate pairs in `fixtures/agentify/clean/` score **Jaccard 0.000** on
content words, asserted on every run by `scripts/build-agentify-corpus.mjs`. No lexical
threshold can merge a pair at zero overlap, so a text-similarity design would have shipped
duplicate units into every agent file and only failed visibly once someone read one.

Normalized-text comparison is still used, but for the case it is actually good at: **exact and
near-exact restatement**, where it is cheaper than a model call and needs no network. It runs
first; embedding handles what survives it.

Contradictions are detected structurally where possible (same entity, incompatible
predicate: differing values for one env var, conflicting commands for one task) and by the
LLM otherwise. **Conflicts are surfaced in a conflict report with both sources, never
silently resolved** (brief §6.1). A preference for newer or higher-authority sources drives
ordering, but the report always shows both, and `agentify.conflicts: "failOnConflict"` makes
an unresolved conflict a build failure for teams that want that.

Output: `.markforge/conflicts.json` plus a human-readable section in the run report.

### 10.5 Budget and assemble

Each target declares a token budget. Units are ranked by
`value = f(category weight, authority, confidence, reference count)` with weights from the
target profile. Highest-value units fill the primary file; the remainder go to linked
secondary files — progressive disclosure (brief §6.1). Tokens per section are reported.

Token counting is per-target: for targets whose consumer model is known, the model's own
tokenizer; otherwise a documented approximation, with the method named in the report so no
one mistakes an estimate for a measurement.

### 10.6 Verify — the anti-hallucination gate (mandatory)

Emitted files are assembled **only** from unit-derived fragments, each carrying the unit ids
it came from. After assembly, the output is segmented into sentences and every sentence must
map to at least one unit id. Structural scaffolding (headings, list markers, code-fence
delimiters, front matter) is exempt and declared as such by the template, not inferred.

```
traceability = supportedSentences / totalSentences        // must equal 1.0
```

Unsupported content is **dropped and logged** (brief §6.1) to `--explain-drops`. Below
`agentify.traceability.required`, the run fails with exit 5. This gate is not optional and
has no bypass flag, because a bypass flag is how a mandatory gate becomes advisory.

### 10.7 Emit and the provenance manifest

`.markforge/provenance.json` maps every output file → section → sentence range → unit ids →
source locators. That chain is what makes Surface A trustworthy rather than a hallucination
machine (brief §3.7).

### 10.8 Incremental regeneration (brief §6.2)

On a source change: re-ingest only changed sources (detected by file content hash),
recompute their units, diff unit sets by `contentHash`, and regenerate only output regions
whose supporting unit set changed.

Output stability is a hard requirement, and three rules deliver it: units are ordered by
`(sectionOrder, categoryOrder, sourcePath, sourceOrder, id)` — a total order independent of
discovery order; text wrapping is fixed and never reflowed based on neighbours
(`markdown.lineWidth: 0`); and section boundaries are stable across runs. Consequence: editing
one sentence in one source document produces a `git diff` of one region. Property-tested by
mutating a fixture source and asserting the diff touches only the expected region.

**Amended in Phase 4 (ADR-0018, OPEN_QUESTIONS §7k).** The ordering above originally read
`(sectionOrder, categoryOrder, id)`. That is a total order and it is not diff-stable: `id` is
content-addressed (§10.3 → §2.7), so editing a unit's text changes its id and moves it within
its group, producing a deletion at the old position and an insertion at the new one. Measured
on `fixtures/agentify/clean/`, a one-word edit changed **three** rows under the original order
and **one** under the amended one. `sourceOrder` — the document-order index of the unit's first
supporting node — pins a unit to where its evidence sits, which an edit does not move; `id`
remains the final tiebreak, so the order is still total and still independent of discovery.

### 10.9 Target registry (brief §6.3) — data, not code

`AGENTS.md` is the **base** target and other flat-Markdown targets are declarative deltas on
it (ADR-0013). This is not a stylistic preference: `AGENTS.md` moved to the Linux
Foundation's Agentic AI Foundation and is read natively by Codex, Cursor, Copilot, Gemini
CLI, Aider, and Windsurf, so treating nine targets as peers would mean maintaining nine
near-identical profiles (`PRIOR_ART.md` — verified 2026-07-29).

A target profile declares: output paths, token budget, front-matter support and schema,
import/link support, section template, tone, and vendor-specific fields such as Cursor's
glob matching in `.mdc` front matter. The authoritative schema is
`packages/agentify/schema/target.v0.schema.json`, which makes `verifiedAgainst: {url, date}`
a **required** field — a profile whose conventions were never checked against a vendor doc
cannot be represented at all.

Confirmed priorities for Phase 4: `agents-md` and `claude-md` as first-class and fully
tested, plus the brief §6.3 stretch emitters promoted to planned — `claude-skills`
(`SKILL.md` packages), `claude-commands` (slash-command definitions), and `mcp-manifest`.
Cursor and Copilot profiles are expressed in the registry schema and shipped as stubs
without a fidelity gate until requested; the schema must nonetheless prove it can express
Cursor's glob-scoped front matter, since that is the one target with genuinely different
assembly semantics.

**Every path and filename MUST be re-verified against vendor documentation during
implementation** (brief §6.3), and `docs/TARGETS.md` must say so prominently, because these
conventions change.

### 10.10 Reverse direction (stretch, brief §6.4)

Repository → context units: detected stack, build and test commands, directory conventions,
lint configuration, naming patterns, hot paths from git history. Same `ContextUnit` shape,
`producedBy: {kind:"rule", name:"repo/<detector>@<v>"}`, so document-derived and
code-derived units merge, dedupe, and conflict-check through the identical path.

---

## 11. Packages

Monorepo, pnpm workspaces, TypeScript strict, Node ≥ 20 (brief §13, tooling choices in
ADR-0007). Adapters and renderers are independently publishable and independently testable
(brief §9); package boundaries and stability tiers are in ADR-0011.

```
packages/
  ir/            @markforge/ir            schema, generated types, validate, traverse, diff, hash
  ooxml/         @markforge/ooxml         shared zip+XML+cascade core for docx/xlsx/pptx (§3.1)
  adapters-docx/ adapters-pdf/ adapters-md/ adapters-html/ adapters-office/ adapters-ocr/
  render-md/     render-docx/  render-pdf/ render-html/
  infer/         @markforge/infer         heading, list, table inference (§5)
  fidelity/      @markforge/fidelity      metrics, baselines, scoreboard (§9)
  agentify/      @markforge/agentify      units, dedup, budget, targets, verification (§10)
  llm/           @markforge/llm           client, role map, cache, prompts, schemas (§6)
  core/          @markforge/core           pipeline orchestration, config, reporting
  cli/  http/  mcp/  browser/
fixtures/                                  golden corpus, licensing per file (docs/CORPUS.md)
docs/                                      SPEC.md, PRIOR_ART.md, adr/, FIDELITY.md, CORPUS.md
```

`@markforge/ooxml` and `@markforge/fidelity` are additions to the brief's §9 layout.
`ooxml` exists because three adapters share one reader (§3.1) and duplicating it three times
would be worse. `fidelity` is a package rather than test-suite code because brief §3.4 makes
fidelity a product feature reachable from `check` and `diff`, not a test helper.

Dependency rule, CI-enforced: `adapters-*` and `render-*` may depend on `ir`, `ooxml`, and
`core`, and **MUST NOT** depend on `llm`, on each other, or on `cli`.

Browser build (ADR-0015): `ir`, `adapters-md`, `adapters-html`, `adapters-docx`,
`render-md`, `render-html`, `render-docx`, `infer`, and `fidelity` run fully in-browser.
`render-pdf` requires the `typst.ts` WASM bundle; `adapters-pdf` requires `pdfjs-dist`;
`adapters-ocr` requires the `tesseract.js` WASM bundle — all three lazy-loaded. LLM features
degrade to unavailable, never to silently-different output.

---

## 12. Coverage checklist

Verification that this spec covers what the brief asked for.

**Prior art, brief §2 (16 entries):** all surveyed in `PRIOR_ART.md` with a verdict —
`word-to-markdown-js`, `markitdown`, `docling`, `marker`, `unstructured`,
`unified`/`remark`/`mdast`, `mammoth.js`, `turndown`, `docx`, Pandoc, Typst, Paged.js,
Tectonic, `pdfjs-dist`/`pdfplumber`/`tesseract.js`, `markdownlint`/`prettier`/
`remark-stringify`, plus `hast`. Agent-file conventions verified against current sources,
not training data (§10.9). ✔

**IR, brief §4:** semantic tree §2.3 covers headings with resolved levels, lists with
numbering definitions and nesting, tables with spans and header rows, footnotes and
endnotes, captions bound to figure or table, code blocks with language, inline and display
math, admonitions, comments, tracked changes, cross-references, definition lists, front
matter. Style sidecar §2.4 covers style name, computed font family and size, weight,
alignment, indent, numbering id and level, list restart, page and bbox, table cell geometry.
Provenance §2.5 covers source file, locator, confidence, producing rule or model, plus
document-level diagnostics §2.6. Versioned JSON Schema + generated types + own package. ✔

**Root causes, brief §5.1:** direct formatting → §4.2 named-styles-only; theme mismatch →
§4.2 reference document; lost numbering → §4.2 numbering mapping and §2.3 `restartsAt`;
whitespace as structure → §2.8; MD→PDF via Word → §4.3 direct from IR. ✔

**Adapters, brief §5.2:** DOCX §3.1, Markdown §3.2, PDF §3.3, HTML/PPTX/XLSX/OCR §3.4, in
the brief's priority order. ✔ **Inference, brief §5.3:** §5.1–5.3. ✔
**Renderers, brief §5.4:** §4.1–4.4, with the three shipped reference documents in §4.2.1
(`academic-manuscript` primary, per reviewer decision on manuscript-template construct
coverage). ✔ **Profiles, brief §5.5:** §7. ✔

**Agentify, brief §6.1 (7 stages):** ingest §10.1, classify §10.2, extract §10.3, dedupe and
conflict §10.4, budget and assemble §10.5, verify §10.6, emit §10.7. Incremental §10.8,
registry §10.9, reverse §10.10. All ten context-unit categories present in §10.3. ✔

**LLM, brief §7:** permitted and forbidden §6; endpoint and model selection §6.1 with the
spreadsheet schema read not assumed; task → role mapping §6.2; reproducibility §6.3 covering
temperature, seeding, capability probing, file prompts, schema validation, bounded repair,
content-addressed cache, token accounting, `producedBy`. ✔ **Deviation:** the registry,
routing policy, capability tags, and generator script of brief §7.2 are descoped by reviewer
decision (ADR-0009); three configured model names replace them, and the spreadsheet is not a
build input.

**Surfaces, brief §8:** CLI §8 with all seven subcommands, `--json` everywhere, exit-code
table; Node API §11; browser §11; HTTP `serve` §8; MCP `packages/mcp`; GitHub Action and
pre-commit hook are Phase 5 scope. VS Code extension deferred, and the renderer/adapter
contracts keep it possible. ✔

**Testing, brief §10:** structural §9.1, text with both whitespace variants §9.2, table
cell P/R/F1 with spans §9.3, inline styling §9.4, round trips §9.5, baselines and CI gate
§9.6, property tests §9.6, offline LLM tests §9.6, visual regression §9.6. Corpus plan in
`docs/CORPUS.md`. ✔

**Constraints, brief §13:** TypeScript strict, Node ≥ 20, maintenance recorded per
dependency (`PRIOR_ART.md` register); no hard LibreOffice or Pandoc dependency in core —
LibreOffice appears only as an isolated, optional CI rasterizer (§9.6); offline `--no-llm`
§1.1; not an editor, not a DMS, not a SaaS, with HTTP and browser surfaces not precluding
one. ✔
