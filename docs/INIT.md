# Project Brief: `markforge` (working name)

## 0. How to use this brief

You are Claude Code. This is a greenfield project brief, not a task ticket.

**Do not write implementation code in your first pass.** Your first deliverable is a
specification and architecture plan (see Section 12). I will review it, then you build.

Where this brief is underspecified, make a reasoned decision, record it as an ADR with
the alternatives you rejected, and continue. Only stop and ask when a decision is
expensive to reverse (public API shape, IR schema, license, hosting model).

---

## 1. Mission

Build the markdown toolkit that developers and coding agents actually need. Two product
surfaces, one shared engine:

**Surface A: Agent Context Compiler.**
Ingest an arbitrary pile of documents (PDF, DOCX, PPTX, XLSX, HTML, Markdown, RST,
Confluence exports, Notion exports, plain text, images of documents) and compile them
into agent-native context files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, `.cursor/rules/*.mdc`, and so on. Not a dump. A
compiled, deduplicated, token-budgeted, provenance-tracked context set that a coding
agent can actually use.

**Surface B: Fidelity-preserving conversion.**
Bidirectional conversion between Markdown and DOCX/PDF/HTML that produces output
requiring **zero manual cleanup**. This is the part every existing tool gets wrong.

The reference project, `benbalter/word-to-markdown-js`, is the closest prior art and the
right starting point in spirit: TypeScript, actively maintained dependencies,
client-side capable, CLI plus web plus HTTP API. Its pipeline is
Mammoth.js to Turndown to markdownlint. Read its source before you plan. Its limits are
the gap we are filling:

- One direction only (DOCX to MD), one input format.
- No heading-level inference from visual formatting (called out explicitly in its README).
- No PDF, PPTX, XLSX, or scanned input.
- No fidelity measurement, so "did the conversion lose something" is unanswerable.
- Structural, not semantic. No notion of what the document *means*.

---

## 2. Prior art to survey before planning

Spend real effort here. Report findings in `docs/PRIOR_ART.md` with a
steal / avoid / benchmark-against verdict per project. Do not reinvent a solved layer.

| Project | What to evaluate |
| --- | --- |
| `benbalter/word-to-markdown-js` | Pipeline, test approach, browser build, markdownlint config |
| `microsoft/markitdown` | Breadth of input adapters, output quality, LLM integration points |
| `docling` (IBM) | Layout-aware PDF parsing, table structure recovery, document model design |
| `VikParuchuri/marker` | PDF to MD with ML layout models, table and equation handling |
| `Unstructured-IO/unstructured` | Element taxonomy and partitioning strategy |
| `unified` / `remark` / `mdast` | Candidate foundation for the IR. Study `mdast` and `hast` specs closely |
| `mammoth.js` | DOCX style-map API, which is the correct extension point for style-aware mapping |
| `turndown` | Rule system and where it loses whitespace fidelity |
| `docx` (npm, dolanmiu) | Programmatic DOCX generation and named-style support |
| Pandoc | `--reference-doc` mechanism, AST design, round-trip behavior. Study the design even if we do not depend on it |
| Typst, Paged.js, Tectonic | Candidates for deterministic PDF rendering that does not route through Word |
| `pdfjs-dist`, `pdfplumber`, `tesseract.js` | PDF text-layer extraction versus OCR fallback |
| `markdownlint`, `prettier`, `remark-stringify` | Deterministic Markdown normalization and idempotent formatting |

Also survey the current, real filenames and conventions for agent context files. Do not
trust the list in Section 6 or your training data. Verify against vendor documentation at
build time and encode the result as data, not code.

---

## 3. Non-negotiable architecture principles

1. **Deterministic core, LLM periphery.**
   The conversion path must be fully deterministic and produce byte-identical output for
   identical input. LLMs are an *optional enrichment layer* that runs beside the
   deterministic path, never inside it. `--no-llm` must be a first-class mode that works
   offline and passes the entire fidelity test suite.

2. **One IR, many adapters.**
   No format-to-format code paths. Every input goes to the IR. Every output comes from
   the IR. Adding a format is one adapter, not N converters. String-to-string pipelines
   are banned in the core.

3. **Never lose information silently.**
   Anything the IR cannot express must be recorded in a sidecar with its source location,
   surfaced in a conversion report, and exit-coded in strict mode. No silent degradation.

4. **Fidelity is measured, not asserted.**
   Round-trip fidelity is a numeric metric in CI with a baseline that cannot regress.
   See Section 10.

5. **Idempotency.**
   For any normalizing operation `f`, `f(f(x)) == f(x)`. Property-tested, not assumed.

6. **Privacy-first, matching the reference project.**
   Local and browser-only operation must be fully supported. Any network call, including
   LLM calls, is opt-in and explicit. Never a default.

7. **Provenance everywhere.**
   Every output artifact maps back to source file, page or paragraph, and byte range.
   This is what makes Surface A trustworthy instead of a hallucination machine.

---

## 4. The canonical IR (the core design task)

This is the single most important design decision in the project. Spend the most planning
effort here.

Define a typed, serializable document IR. Recommended starting point: extend `mdast` so
we inherit the `unified` ecosystem, but the IR must carry three things `mdast` does not.

**4.1 Semantic tree.** Blocks and inlines with real semantics: headings with resolved
levels, lists with numbering definitions and nesting, tables with spans and header rows,
footnotes and endnotes, captions bound to their figure or table, code blocks with
language, math (inline and display), admonitions and callouts, comments and tracked
changes, cross-references, definition lists, front matter.

**4.2 Style provenance sidecar.** Not styling itself. Evidence about styling, keyed by
node id: source style name (`Heading 2`, `Body Text`, `ListParagraph`), computed font
family and size, weight, alignment, indent, numbering id and level, list restart, page
and bbox for paginated sources, table cell geometry. This sidecar is what makes
heading-level inference, list reconstruction, and template-faithful rendering possible.
It is also what every existing tool throws away.

**4.3 Provenance and diagnostics.** Per node: source file, locator (page, paragraph
index, XML path, char offsets), extraction confidence, and the rule or model that
produced it. Plus a document-level diagnostics list of unrepresentable constructs.

Deliver the IR as a versioned JSON Schema plus generated TypeScript types. Publish it as
its own package. Third parties should be able to write adapters against it.

---

## 5. Surface B: the conversion engine

### 5.1 Why current tools produce a mess (design against these causes)

The user-visible symptoms are stray blank lines, inconsistent fonts, broken lists, and
hours of manual cleanup. Root causes to design against explicitly:

- **Direct formatting instead of named styles.** Generators emit inline run properties
  (`rPr`) per run rather than resolving to named paragraph and character styles. Result:
  a document where changing a heading font requires touching every heading. This is the
  primary cause of "uneven fonts". Our DOCX renderer must emit *named styles only*, with
  inline formatting reserved for genuine inline semantics (strong, emphasis, code, sub,
  sup, strike).
- **Theme part mismatch.** Mixed Calibri/Cambria/Aptos defaults from a partially written
  `theme1.xml` and `styles.xml`. Fix: render into a reference document supplied by the
  user, resolving our IR roles onto that document's existing style ids.
- **Lost numbering definitions.** `numbering.xml` is not reconstructed, so nested lists
  lose indentation or restart. Fix: map to reference-document numbering definitions and
  preserve list restart semantics from the IR.
- **Whitespace as structure.** Empty paragraphs used as spacing, hard line breaks treated
  as paragraph breaks, and trailing spaces surviving into Markdown. Fix: normalize
  whitespace once, at the IR level, with explicit rules.
- **Markdown to PDF routed through Word.** Two lossy hops. Fix: render PDF directly from
  the IR.

### 5.2 Input adapters

Priority order: DOCX, Markdown, PDF (text layer), HTML, PPTX, XLSX/CSV, PDF (scanned,
via OCR or VLM), RST, Notion and Confluence exports, EPUB.

Requirements per adapter:

- **DOCX**: build on Mammoth's style-map extension point rather than fighting its
  defaults. Extract comments, footnotes, endnotes, tracked changes, text boxes, embedded
  images with alt text, and numbering definitions.
- **PDF**: layout-aware, not naive text extraction. Column detection, reading-order
  recovery, header and footer stripping, table structure recovery, figure and caption
  binding, ligature and hyphenation repair. Detect a missing text layer and route to OCR
  or a vision model.
- **Markdown**: `remark` with GFM, front matter, math, directives. Preserve unknown
  constructs rather than dropping them.
- **Images and scans**: OCR path with confidence scores propagated into IR provenance.

### 5.3 Heading and structure inference

The reference project explicitly does not do this. It is a differentiator.

Deterministic first: cluster font sizes and weights from the style sidecar, use outline
level and style names when present, detect numbering patterns (`1.`, `1.1`, `A.`,
`Chapter N`), use position and whitespace. Produce candidate levels with confidence.
Only when the deterministic result is ambiguous does the optional LLM layer break ties,
and it must choose among the candidate set, never invent structure. Log every inference
with its evidence.

### 5.4 Output renderers

- **Markdown**: deterministic `remark-stringify` configuration plus markdownlint autofix.
  Flavor profiles (CommonMark, GFM, MDX, Docusaurus, MkDocs Material, Obsidian, Pandoc)
  as data-driven presets. Expose this as a standalone `markforge fmt` command, which is a
  useful product on its own.
- **DOCX**: template-driven, styles-only, as described in 5.1. Accept a `.dotx` or
  `.docx` reference document. Ship two or three good defaults (clean report, academic
  manuscript, technical documentation).
- **PDF**: direct from IR. Evaluate Typst versus HTML plus Paged.js versus LaTeX and pick
  one primary with a documented rationale. Requirements: embedded fonts, no font
  substitution, deterministic pagination, working table of contents and internal links,
  correct table breaking, figure and caption placement.
- **HTML**: semantic, accessible, no inline style soup.

### 5.5 Style profiles

A single declarative profile controls Markdown flavor, DOCX reference document and style
mapping, PDF theme, whitespace rules, and lint rules. One file, versionable, shareable.
`markforge.config.ts` with schema validation and a JSON alternative.

---

## 6. Surface A: the Agent Context Compiler

### 6.1 Pipeline

1. **Ingest** every input document to IR (Surface B machinery, reused).
2. **Classify** each document by role: product spec, architecture, coding conventions,
   domain glossary, API contract, runbook, test policy, decision record, meeting notes.
   Rule-based priors (filename, headings, keyword profile) with an optional LLM classifier
   on top. Never LLM-only.
3. **Extract context units.** Atomic, addressable facts. Each unit has: stable id,
   category (constraint, invariant, convention, command, entity, glossary term, decision
   with rationale, anti-pattern, dependency, environment variable), text, source
   provenance, confidence, and a content hash.
4. **Deduplicate and resolve conflicts.** Near-duplicate units merge. Contradictory units
   across documents are surfaced in a conflict report with both sources rather than
   silently resolved. Prefer the newer or higher-authority source, but always report.
5. **Budget and assemble.** Each target has a token budget. Fit the highest-value units
   into the primary file; push detail into linked secondary files (progressive
   disclosure). Report tokens per section.
6. **Verify.** Every sentence in every generated file must trace to at least one context
   unit. Unsupported content is dropped and logged. This is the anti-hallucination gate
   and it is mandatory, not optional.
7. **Emit** with a provenance manifest at `.markforge/provenance.json`.

### 6.2 Incremental regeneration

When one source document changes, only affected sections regenerate. Content-hash every
unit; diff unit sets; regenerate only the touched output regions. Output must be
diff-friendly and stable in ordering, so `git diff` after a source edit shows only the
real change. No existing tool does this and it is what makes the toolkit usable in a real
repo over time.

### 6.3 Target registry

Targets are **data, not code**. A target profile declares: output file paths, token
budget, whether the format supports front matter, whether it supports file imports or
links, section template, tone, and any vendor-specific fields such as Cursor's glob
matching in `.mdc` front matter.

Ship profiles for Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor,
Windsurf, Cline, Aider, and a generic fallback. **Verify every path and filename against
current vendor documentation during implementation.** These conventions change; the
registry must be trivially updatable and the docs must say so.

Stretch targets worth planning for: emit Claude Code skills (`SKILL.md` packages) and
slash-command definitions; emit an MCP server manifest.

### 6.4 Reverse direction (stretch)

Given an existing repository, generate agent context files from the code itself: detected
stack, build and test commands, directory conventions, lint configuration, naming
patterns, hot paths. Combine with document-derived units when both are present.

---

## 7. LLM layer

### 7.1 Where LLMs are allowed

Permitted: heading-level tie-breaking within a deterministic candidate set; document role
classification; context-unit extraction and summarization; scanned-page transcription;
table structure recovery when geometry is ambiguous; alt-text generation; glossary
extraction.

Forbidden: anything on the deterministic conversion path; generating structure not
evidenced in the source; any step whose failure would silently change conversion output.

### 7.2 Model registry from `Navigator-Models.xlsx`

There is a spreadsheet at `C:\Users\sinha\Dev\Navigator-Models.xlsx` listing available
models and endpoints. **Do not assume its schema.** Write a script that reads it, prints
the inferred schema and a sample of rows, and asks me to confirm the column mapping
before generating anything from it.

Then generate:

- `models.registry.json` plus generated TypeScript types, committed and reviewable.
- Capability tags per model: vision, long context, structured output, cost tier, latency
  tier, local versus hosted, context window.
- A **routing policy**: cheap and fast model for classification, strong model for
  synthesis and conflict resolution, vision model for scanned pages, with declared
  fallback chains and a hard budget ceiling.
- Credentials from environment variables only. Never read keys from the spreadsheet into
  committed artifacts. The spreadsheet is a capability catalog, not a secret store.
- An OpenAI-compatible client abstraction so self-hosted endpoints work identically to
  hosted APIs.

### 7.3 Reproducibility requirements for LLM calls

- Temperature 0, seeded where supported.
- Versioned prompts stored as files, not inline strings. Prompt version participates in
  the cache key.
- Structured output with JSON Schema validation and a bounded repair loop. Never
  regex-parse a model response.
- **Content-addressed response cache**: key is `hash(input_content + model_id +
  prompt_version + params)`. A cached run is byte-reproducible and costs nothing. Cache
  is committable for CI.
- Per-call token and cost accounting, aggregated into the run report.
- Every LLM-derived node carries `producedBy: {model, promptVersion}` in IR provenance.

---

## 8. Surfaces and packaging

- **CLI** as the primary interface. Subcommands: `convert`, `fmt`, `agentify`, `check`,
  `diff`, `serve`, `init`. Human-readable and `--json` output for every command. Correct
  exit codes.
- **Node API**, typed, tree-shakeable, the CLI's only dependency for logic.
- **Browser build** for the privacy story, matching the reference project. Deterministic
  core must work fully in-browser; LLM features degrade gracefully.
- **HTTP API** with a `POST /convert` style endpoint, stateless, no document retention.
- **MCP server** so coding agents can call the converter at runtime. This closes the loop:
  the agent that consumes `CLAUDE.md` can also generate it.
- **GitHub Action** and a pre-commit hook for `fmt` and `check`.
- **VS Code extension** (deferred, plan the API so it stays possible).

---

## 9. Repository layout

Monorepo, pnpm workspaces, TypeScript strict. Proposed:

```
packages/
  ir/                 # schema, types, validators, traversal, diff
  adapters-docx/
  adapters-pdf/
  adapters-md/
  adapters-html/
  adapters-office/    # pptx, xlsx
  adapters-ocr/
  render-md/
  render-docx/
  render-pdf/
  render-html/
  infer/              # heading, list, table structure inference
  agentify/           # context units, budgeting, targets, verification
  llm/                # registry, router, cache, prompts, schemas
  core/               # pipeline orchestration, config, reporting
  cli/
  http/
  mcp/
  browser/
fixtures/             # golden corpus, licensing documented per file
docs/                 # SPEC.md, PRIOR_ART.md, adr/, FIDELITY.md
```

Adapters and renderers must be independently publishable and independently testable.

---

## 10. Testing and fidelity measurement

**Golden corpus.** Build `fixtures/` deliberately, with licensing recorded per file:
clean Word reports, academic manuscripts with footnotes and equations, badly formatted
real-world documents, nested and restarting lists, complex tables with merged cells,
multi-column PDFs, scanned PDFs, slide decks, spreadsheets, RTL and CJK text, emoji,
documents with tracked changes and comments.

**Fidelity metrics** (implement these; they are the product's credibility):

- *Structural*: normalized tree edit distance between input IR and round-tripped IR.
- *Text*: normalized edit distance on extracted text, whitespace-insensitive and
  whitespace-sensitive variants reported separately.
- *Table*: cell-level precision, recall, and F1 including span correctness.
- *Inline styling*: span-level agreement on emphasis, strong, code, links.
- *Round trip*: `docx -> md -> docx`, `md -> pdf -> md`, `md -> md` for every fixture.

Store baselines. CI fails on regression. Publish the scoreboard in `docs/FIDELITY.md`,
including scores for competing tools on the same corpus. Be honest where we lose.

**Property tests**: idempotency of `fmt`; IR round-trip through serialization; no
information loss without a corresponding diagnostic.

**LLM tests** run against the committed cache, so the suite is deterministic and offline.
A separate, non-blocking live job detects model drift.

**Visual regression**: rasterize rendered DOCX and PDF, compare against approved
snapshots. This is the only way to catch "it technically converted but it looks wrong",
which is the exact complaint driving Surface B.

---

## 11. Phases and definition of done

**Phase 0: Specification.** `docs/SPEC.md`, `docs/PRIOR_ART.md`, IR JSON Schema, target
registry schema, config schema, ADRs for IR foundation, PDF rendering engine, and monorepo
tooling. Corpus plan. No implementation.
*Done when* I approve the spec.

**Phase 1: Deterministic spine.** IR package. DOCX and Markdown adapters. Markdown and
DOCX renderers with template-driven styles. `convert` and `fmt`. Fidelity harness with
baselines. Golden corpus v1.
*Done when* `docx -> md -> docx` beats the reference project and Pandoc on our corpus, and
`fmt` is provably idempotent.

**Phase 2: Breadth.** PDF (text layer), HTML, PPTX, XLSX. PDF renderer. Structure
inference, deterministic only. Visual regression suite.
*Done when* a real-world messy PDF and a real-world messy DOCX both convert with zero
manual cleanup, verified by inspection against the fidelity report.

**Phase 3: LLM layer.** Model registry from the spreadsheet, router, cache, prompt
versioning, schema-validated outputs. Vision and OCR path. LLM tie-breaking for
inference.
*Done when* `--no-llm` and cached-LLM runs are both byte-reproducible and the LLM path
measurably improves fidelity on the scanned and ambiguous subsets.

**Phase 4: Agent Context Compiler.** Context units, dedup, conflict reporting, budgeting,
target registry, verification gate, provenance manifest, incremental regeneration.
*Done when* a folder of mixed source documents produces a `CLAUDE.md` set that passes the
verification gate at 100 percent traceability, and editing one source document produces a
minimal, readable git diff.

**Phase 5: Distribution.** HTTP API, browser build, MCP server, GitHub Action,
~~documentation site~~, ~~published packages~~.
*Done when* the same input produces byte-identical output through the CLI, the HTTP API, the
MCP server, and the browser build — with `MODEL_API_KEY` unset — and the browser bundle's
freedom from `node:` builtins and the HTTP API's no-retention claim are each measured by a
check that has been seen to fail.

> **Amended 2026-08-01, by the reviewer.** This phase was the only one in this section with
> no *done when*, which is a gap in a brief whose whole discipline is measurable criteria;
> the sentence above was proposed and agreed before any Phase 5 code was written.
>
> Two deliverables are struck. **Published packages** contradicted `OPEN_QUESTIONS.md` §5,
> which defers the name, the npm scope, and public-versus-private, and keeps every package
> `"private": true` so an accidental publish is impossible — §5 stays open and nothing is
> published (§7r). The **documentation site** is replaced by per-surface quickstarts whose
> commands are executed in CI, because a site can be built and be wrong with nothing
> noticing (§7s).

---

## 12. Your first deliverable

Produce, in this order:

1. `docs/PRIOR_ART.md` with the survey from Section 2 and a per-project verdict.
2. `docs/SPEC.md`: the IR design in full, adapter and renderer contracts, config schema,
   CLI surface, and the fidelity metric definitions.
3. `docs/adr/` with numbered ADRs for every decision you made on my behalf, each with
   rejected alternatives and the reason for rejection.
4. `docs/CORPUS.md`: the golden-corpus plan, including how to source or synthesize each
   fixture category and how licensing will be handled.
5. `docs/OPEN_QUESTIONS.md`: everything you need from me, ordered by how much it blocks
   you. Include at minimum the `Navigator-Models.xlsx` column mapping, license choice,
   the PDF engine decision if you want my input, and which agent targets matter most to
   me in Phase 4.

Then stop and wait for review.

---

## 13. Constraints and non-goals

- TypeScript, strict mode. ~~Node 20 or later.~~ **Node 22 or later** (amended 2026-08-01,
  `OPEN_QUESTIONS.md` §7y): pnpm 11.9.0, which `packageManager` pins, uses a builtin module
  Node 20 lacks and dies with `ERR_UNKNOWN_BUILTIN_MODULE` before install starts. The Node 20
  entry in the CI matrix was therefore never capable of passing, and `engines.node` claimed
  `>=20.11` while the toolchain required 22. Actively maintained dependencies only; the
  reference project's rewrite was motivated by abandoned dependencies, so treat
  maintenance status as a selection criterion and record it.
- No hard dependency on LibreOffice or a Pandoc binary in the core. Optional adapters are
  acceptable if clearly isolated and clearly optional.
- Everything works offline in `--no-llm` mode.
- **Not** a WYSIWYG editor. **Not** a general document management system. **Not** a
  hosted SaaS in scope, though the HTTP API and browser build should not preclude one.
- Do not add a dependency, a package, or an abstraction layer without a one-line
  justification in the ADR or the PR description.
