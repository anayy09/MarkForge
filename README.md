# MarkForge

A Markdown toolkit for document conversion and agent context generation, built on a single
document model.

- **Convert** between Markdown, DOCX, HTML, and PDF with named styles, preserved list
  numbering, and reported losses — output that needs no manual cleanup.
- **Compile agent context** from a folder of mixed documents into `AGENTS.md`, `CLAUDE.md`,
  and related files, where every generated sentence traces back to a source.

Deterministic, offline by default, and identical across every interface.

---

## Installation

MarkForge is not published to a registry. Build from source:

```sh
git clone https://github.com/anayy09/MarkForge.git
cd MarkForge
pnpm install && pnpm build
```

Requires Node 22 or later and pnpm 11.

```sh
alias markforge="node $PWD/packages/cli/dist/index.js"
```

## Quick start

```sh
# Convert
markforge convert report.docx -o report.md
markforge convert report.md   -o report.pdf
markforge convert deck.pptx   -o deck.md

# Format Markdown in place, or check it in CI
markforge fmt docs/**/*.md
markforge fmt docs/**/*.md --check

# Validate a document and report what a conversion would lose
markforge check report.docx --strict

# Compile agent context files from a document folder
markforge agentify ./specs --targets claude-md,agents-md
```

## Formats

| Format | Read | Write |
| --- | :-: | :-: |
| Markdown | ● | ● |
| DOCX | ● | ● |
| HTML | ● | ● |
| PDF | ● | ● |
| PPTX | ● | — |
| XLSX | ● | — |

Markdown output supports seven flavour presets — CommonMark, GFM, MDX, Docusaurus, MkDocs
Material, Obsidian, and Pandoc — selected with `--md-flavor`.

DOCX output is written entirely in named styles against a reference document, so changing a
heading font is one edit rather than one per heading. Three reference templates ship in
[`templates/`](templates/); supply your own with `--reference-doc`.

## Conversion fidelity

Round-trip fidelity is measured across a 32-fixture corpus and published in
[docs/FIDELITY.md](docs/FIDELITY.md), alongside a comparison against Pandoc on the same corpus
in [docs/SCOREBOARD.md](docs/SCOREBOARD.md). Both are generated from the measurements, and CI
fails on regression.

Anything a target format cannot express produces a diagnostic naming the construct. `--strict`
turns any loss into a non-zero exit, so a lossy conversion can fail a pipeline rather than pass
quietly.

## Interfaces

The same engine is reachable through a CLI, a Node API, an HTTP server, an MCP server, a
browser build, and a GitHub Action. The CLI, HTTP, MCP, and browser paths are verified to
produce byte-identical output for the same input across the corpus.

```sh
# HTTP — stateless, no document retention, loopback by default
markforge serve --port 3000
curl -X POST --data-binary @report.md \
  'http://127.0.0.1:3000/convert?from=md&to=docx' -o report.docx

# MCP over stdio — convert, fmt, and agentify as tools
markforge mcp --root .
```

```yaml
# GitHub Action
- uses: anayy09/MarkForge@main
  with:
    command: fmt
    paths: "docs/**/*.md"
```

**Node API** — `@markforge/core` exposes `convert`, `parse`, `render`, and `formatMarkdownSync`.

**Browser** — `@markforge/browser` takes bytes and an explicit config object, with no filesystem
access and no Node builtins in the bundle. It reads and writes Markdown, DOCX, and HTML, and
writes PDF when the page supplies a Typst WASM compiler via the `@markforge/browser/pdf` entry
point.

A pre-commit hook for `fmt` and `check` is available via `pnpm install-hooks`.

## Optional model assistance

MarkForge is deterministic and offline by default. `--no-llm` is the default mode and the full
conversion pipeline runs without any network access.

When explicitly enabled, a model may do exactly two things: break a tie between heading levels
the deterministic scorer has already declared too close to call, choosing from that candidate
set, and transcribe a scanned page that has no text layer.

```sh
export MODEL_API_KEY=...

markforge check --llm                                   # probe endpoint capabilities
markforge convert scan.pdf -o scan.md --llm             # vision transcription
markforge convert scan.pdf -o scan.md --ocr --tessdata ./tessdata   # local OCR

# Replay from the committed cache: no key, no network, reproducible
markforge convert scan.pdf -o scan.md --llm --llm-cache-mode readOnly
```

Every model-influenced node records `producedBy: { kind: "model", model, promptVersion }` in
its provenance. Responses are content-addressed and cacheable, so a cached run is byte-
reproducible and costs nothing. The HTTP, MCP, and browser interfaces have no model path at
all.

## Agent context compilation

`markforge agentify` ingests a folder of documents, classifies them by role, extracts atomic
context units with provenance, deduplicates them, reports contradictions between sources
rather than silently resolving them, fits the result to a token budget, and emits agent
context files.

Every sentence in the output must trace to a source unit. Unsupported content is dropped and
logged, and the gate has no bypass flag. Twelve target profiles ship in [`targets/`](targets/),
covering Claude Code, Codex, Gemini CLI, Copilot, Cursor, Windsurf, Cline, Aider, and a generic
fallback. Profiles are data, not code — see [docs/TARGETS.md](docs/TARGETS.md).

Output is diff-stable: unchanged sources are detected by content hash, and editing one source
document produces a minimal change in the generated files.

## Configuration

A single `markforge.config.ts` controls Markdown flavour, DOCX reference document and style
mapping, PDF options, whitespace rules, and lint rules. Generate a starting point with
`markforge init`. The schema is at
[`schema/markforge.config.v0.schema.json`](schema/markforge.config.v0.schema.json).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | Specification: document model, adapter and renderer contracts, configuration, CLI surface, fidelity metrics |
| [docs/FIDELITY.md](docs/FIDELITY.md) | Measured conversion fidelity across the corpus |
| [docs/SCOREBOARD.md](docs/SCOREBOARD.md) | Comparison against Pandoc on the same corpus |
| [docs/LIMITS.md](docs/LIMITS.md) | Known limitations, format constraints, and uncalibrated figures |
| [docs/TARGETS.md](docs/TARGETS.md) | Agent target profiles |
| [docs/TEMPLATES.md](docs/TEMPLATES.md) | Reference documents and how to use your own |
| [docs/CORPUS.md](docs/CORPUS.md) | The test corpus and the failure mode each fixture covers |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md) | Survey of existing tools, with a verdict per project |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Unresolved questions and recorded decisions |
| [docs/STATUS.md](docs/STATUS.md) | Delivery record against specification |

Machine-readable contracts live beside the code: the document model at
`packages/ir/schema/ir.v0.schema.json`, target profiles at
`packages/agentify/schema/target.v0.schema.json`, and configuration at
`schema/markforge.config.v0.schema.json`. TypeScript types are generated from these rather
than hand-written.

## Design principles

- **Deterministic core.** Identical input produces identical bytes. No wall clock, no RNG, no
  absolute paths in output; `SOURCE_DATE_EPOCH` is honoured.
- **One document model, many adapters.** Every input becomes the IR; every output comes from
  it. There are no format-to-format code paths.
- **Nothing is lost silently.** Any construct that cannot be represented emits a diagnostic
  with its source location.
- **Provenance everywhere.** Every node records its source file, location, and what produced
  it — an adapter, a rule, OCR, or a model.
- **Offline by default.** Network access is opt-in and explicit, never a fallback.

## Limitations

Known limitations are documented in [docs/LIMITS.md](docs/LIMITS.md), including format
constraints, uncalibrated figures, and capabilities that were specified and deliberately not
built. Two worth noting up front:

- **PDF output covers Latin and monospace text.** The shipped font set is Libertinus Serif and
  DejaVu Sans Mono. Documents requiring CJK, emoji, or Arabic are reported rather than rendered
  with a substituted system font.
- **Style profiles do not yet reach the PDF renderer.** All profiles currently produce the same
  PDF typography.

## Licence

[Apache-2.0](LICENSE), chosen for its patent grant.

Two scope notes:

- **`fixtures/` is not covered by this licence.** Test fixtures carry their own terms, recorded
  per file in `fixtures/LICENSES.md`.
- **No third-party document template is redistributed.** Publisher templates are linked in
  [docs/TEMPLATES.md](docs/TEMPLATES.md) rather than bundled; MarkForge reads whichever one you
  supply.
