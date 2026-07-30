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

## Status: specification complete, no implementation

**There is no code in this repository yet, and that is deliberate.** Phase 0 delivers the
specification and architecture; implementation begins once the spec is approved. A verification
check asserts the absence of code so this cannot drift by accident.

If you are looking for something to run, there is nothing yet. If you are looking for something
to review, start with `docs/SPEC.md`.

## What to read, in order

| Document | What it is |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | The specification. IR, adapter/renderer contracts, config, CLI, fidelity metrics, agentify pipeline |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md) | 21 existing projects, each with a steal / benchmark / avoid verdict and verified maintenance status |
| [docs/adr/](docs/adr/) | 15 architecture decision records — every decision, with the alternatives rejected and why |
| [docs/CORPUS.md](docs/CORPUS.md) | The golden-corpus plan: 14 fixture categories, each naming the failure mode it catches |
| [docs/TEMPLATES.md](docs/TEMPLATES.md) | Reference documents: what ships, and how to use a publisher template we cannot ship |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Everything unresolved, and every decision made without asking |

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
