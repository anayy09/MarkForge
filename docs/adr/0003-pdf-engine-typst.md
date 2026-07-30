# ADR-0003: PDF rendering engine — Typst

- Status: **Confirmed by reviewer**
- Date: 2026-07-29
- Relates to: brief §5.4, §3.1, §8; `SPEC.md` §4.3

## Context

Brief §5.4 asks for one primary PDF engine with a documented rationale, and lists hard
requirements: embedded fonts, no font substitution, deterministic pagination, working table
of contents and internal links, correct table breaking, figure and caption placement. Brief
§3.1 additionally requires byte-identical output for identical input, and brief §8 requires
a browser build.

Brief §5.1 also identifies "Markdown to PDF routed through Word" as a root cause of poor
output, so the engine must render directly from the IR.

## Decision

**Typst**, via `@myriaddreamin/typst.ts` (0.7.0, Apache-2.0, published 2026-06-01). The IR
is rendered to Typst markup, then compiled to PDF. `--ignore-system-fonts` is always on,
fonts come from the profile and are embedded, and `SOURCE_DATE_EPOCH` supplies any
timestamp.

Verified properties that decided it: deterministic output regardless of OS or installed
fonts; its own layout engine rather than a browser's; `SOURCE_DATE_EPOCH` honoured per the
reproducible-builds specification; `--ignore-system-fonts` plus `--font-path` to eliminate
substitution; PDF/A and PDF/UA output; and a WASM build.

## Rejected alternatives

**HTML + Paged.js + headless Chromium.** The tempting choice, since we need an HTML
renderer anyway and it would mean one template language instead of two. Rejected on three
grounds, any one of which is disqualifying: pagination shifts between Chrome versions, so
brief §3.1's byte-identical requirement is unachievable, not merely hard; Chromium is a very
large binary dependency for a toolkit whose core must be offline-installable; and it cannot
run inside a web page, so the browser surface in brief §8 would lose PDF entirely. Retained
as a comparison target in the visual-regression suite.

**LaTeX via Tectonic.** Best typography available and unmatched math handling. Rejected on
toolchain weight, compile speed, and hostile error messages — but the deciding factor is
that escaping arbitrary user document text into LaTeX safely is an unbounded source of
correctness bugs. Every document containing `\`, `$`, `%`, `&`, `#`, `_`, `{`, or `}` in
unexpected combinations is a potential silent corruption. Typst's data model does not have
that failure class.

**Direct PDF construction with `pdf-lib`.** Total control, minimal dependency. Rejected: it
has no layout engine, so we would write pagination, line breaking, widow/orphan control, and
table breaking ourselves. That is a multi-year project and not the one we are doing. Also
`pdf-lib@1.17.1` was last published 2021-11-06 and is stale.

**Routing through DOCX and converting with LibreOffice.** Rejected explicitly by brief §5.1
as a root cause of poor output, and by brief §13 which forbids a hard LibreOffice dependency
in core. LibreOffice survives only as an isolated, optional CI rasterizer for visual
regression.

## Consequences

- We author and maintain Typst templates for each shipped profile: clean report, academic
  manuscript, technical documentation. This is real ongoing work and is the accepted cost.
- Typst's accessibility support arrived in 0.14, so tagged-PDF quality must be measured
  rather than assumed. `SPEC.md` §4.4's accessibility posture is verified for HTML; the PDF
  equivalent is a Phase 2 measurement task.
- `typst.ts` is a single-maintainer binding to a well-funded upstream. The risk is the
  binding, not Typst. Mitigation: the renderer talks to a narrow internal interface
  (`compile(typstSource, fonts) → pdfBytes`), so swapping to the official Typst WASM
  artifact or a CLI invocation is a one-file change. That interface is a requirement of this
  ADR, not an optional nicety.
- Two template languages exist in the project (Typst for PDF, none for DOCX since DOCX uses
  a reference document). Accepted.
