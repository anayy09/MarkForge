# MarkForge

A Markdown toolkit with two surfaces on one engine.

**Surface A — Agent Context Compiler.** Point it at a pile of heterogeneous documents; get a
compiled, deduplicated, token-budgeted `AGENTS.md` / `CLAUDE.md` / skill set where **every
sentence traces back to a source document**. Conflicts between sources are reported, never
silently resolved.

**Surface B — Fidelity-preserving conversion.** Markdown ↔ DOCX / PDF / HTML that needs zero
manual cleanup. Named styles instead of direct formatting, so changing a heading font is one
edit rather than four hundred. Numbered lists stay numbered. Nothing is dropped silently.

---

## Status: Phase 2 — six formats read, three written

`markforge convert` and `markforge fmt` are real, and every number in
[docs/FIDELITY.md](docs/FIDELITY.md) is measured rather than claimed.

| Format | Read | Write |
| --- | :-: | :-: |
| Markdown | yes | yes |
| DOCX | yes | yes |
| HTML | yes | yes |
| PPTX | yes | — |
| XLSX | yes | — |
| PDF | yes | — |

PPTX, XLSX, and PDF are read-only. For the first two, nobody asked MarkForge to *generate* a
spreadsheet and building it on speculation would be machinery with no user. PDF output needs a
layout engine — [ADR-0003](docs/adr/0003-pdf-engine-typst.md) chose Typst — and is not built
yet. `--to xlsx` and `--to pdf` say so by name instead of failing somewhere internal.

Reading a PDF is the one place an *adapter* infers rather than recording evidence, because a
PDF states no structure at all: it has glyphs at coordinates. That inference is deterministic,
every threshold is derived from the document's own measurements rather than hardcoded, and the
provenance records `confidence: 0.8` so a consumer can tell a reconstructed heading from a
declared one.

```sh
pnpm install && pnpm build

node packages/cli/dist/index.js convert report.md   -o report.docx
node packages/cli/dist/index.js convert deck.pptx   -o deck.md
node packages/cli/dist/index.js convert data.xlsx   -o data.html
node packages/cli/dist/index.js convert paper.pdf   -o paper.md
node packages/cli/dist/index.js fmt docs/**/*.md --check
```

Not yet built: PDF *output* and OCR for scanned PDFs (Phase 3), the LLM layer (Phase 3), and
`agentify` (Phase 4).
Those subcommands exist in `--help` and **refuse rather than pretend** — a command that
silently does nothing is worse than one that says it does not exist yet.

## What to read, in order

| Document | What it is |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | The specification. IR, adapter/renderer contracts, config, CLI, fidelity metrics, agentify pipeline |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md) | 21 existing projects, each with a steal / benchmark / avoid verdict and verified maintenance status |
| [docs/adr/](docs/adr/) | 15 architecture decision records — every decision, with the alternatives rejected and why |
| [docs/CORPUS.md](docs/CORPUS.md) | The golden-corpus plan: 14 fixture categories, each naming the failure mode it catches |
| [docs/TEMPLATES.md](docs/TEMPLATES.md) | Reference documents: what ships, and how to use a publisher template we cannot ship |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Everything unresolved, and every decision made without asking |
| [docs/FIDELITY.md](docs/FIDELITY.md) | Measured conversion fidelity. Generated; every fixture appears |
| [docs/SCOREBOARD.md](docs/SCOREBOARD.md) | MarkForge against Pandoc on the same corpus, with the bias disclosed |
| [docs/STATUS.md](docs/STATUS.md) | Delivered against promised, per phase. Names what is missing |

Machine-readable contracts live beside the docs, not inside them:

- `packages/ir/schema/ir.v0.schema.json` — the intermediate representation (53 node types)
- `packages/agentify/schema/target.v0.schema.json` — agent-file target profiles
- `schema/markforge.config.v0.schema.json` — configuration

TypeScript types will be **generated** from these, never hand-written, so the schema and the
types cannot drift. Four worked examples are in [docs/examples/](docs/examples/).

## Design commitments

These are the load-bearing ones. Each is enforced mechanically somewhere, because a principle
that is only written down is a preference.

- **Deterministic core.** Same input, same bytes out. No wall clock, no RNG, no absolute paths,
  `SOURCE_DATE_EPOCH` honoured, canonical JSON with sorted keys.
- **Offline by default.** Everything works in `--no-llm` mode. Any network call, including every
  LLM call, is opt-in and explicit — never a default, and never an automatic fallback.
- **Nothing is lost silently.** Anything an adapter cannot represent emits a diagnostic. A
  construct that survives with reduced fidelity says so. "It looked fine" is not a test result.
- **Provenance for every node.** Every node records where it came from and what produced it —
  an adapter, a rule, a model, or OCR — so *"did a model touch this document?"* is a question you
  can answer by grepping, not by trusting.
- **The traceability gate has no bypass flag.** Surface A refuses to emit output whose sentences
  do not trace to sources. There is deliberately no way to turn this off.

## Licence

[Apache-2.0](LICENSE) — chosen over MIT for the patent grant, which matters for a tool
implementing OOXML and PDF handling ([ADR-0008](docs/adr/0008-license-apache-2.md)).

Two scope notes:

- **`fixtures/` is not covered by this licence.** Fixtures carry their own terms, recorded per
  file in `fixtures/LICENSES.md`. See [fixtures/README.md](fixtures/README.md).
- **No third-party document template is redistributed here.** Publisher templates are
  downloadable but not licensed for redistribution, and "freely downloadable" is not the same
  thing. `docs/TEMPLATES.md` links them instead, and MarkForge reads whichever one you supply.
