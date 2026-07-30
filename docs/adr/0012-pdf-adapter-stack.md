# ADR-0012: PDF adapter — pdfjs-dist plus our own layout analysis

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §5.2, §7.1; `SPEC.md` §3.3

## Context

Brief §5.2 requires PDF ingestion that is "layout-aware, not naive text extraction": column
detection, reading-order recovery, header and footer stripping, table structure recovery,
figure and caption binding, ligature and hyphenation repair, and detection of a missing text
layer routing to OCR or a vision model.

`marker` is the strongest prior art here, with published olmocr-bench scores of 76.0% overall
and 83.5% on born-digital PDFs — but its model weights are under a modified AI Pubs Open
RAIL-M licence with a revenue threshold, which is incompatible with an Apache-2.0 toolkit
(ADR-0008, `PRIOR_ART.md` §4).

## Decision

Three layers, deterministic-first.

**Extraction: `pdfjs-dist`** (6.2.108, Apache-2.0, published 2026-07-28, Mozilla-backed).
Supplies positioned glyph runs, font names and sizes, and page geometry. It does not supply
document structure, and we do not pretend it does.

**Layout analysis: ours.** Line and block assembly by baseline and gap clustering; column
detection by vertical whitespace projection with reading order recovered per column;
header/footer detection by cross-page repetition in consistent y-bands, **routed to
`furniture` rather than stripped** (ADR-0002); hyphenation and ligature repair; figure and
caption binding by proximity and caption-pattern matching.

**Table recovery, confidence-gated escalation:** ruling-line detection first, then
whitespace-column alignment, then — only when geometry is ambiguous and only if the LLM is
enabled — a vision model. Confidence is recorded per table and low-confidence tables are
diagnosed. This escalation shape is copied deliberately from marker's architecture, which does
CPU heuristics first and falls back to its VLM only on low confidence; it is brief §3.1's
deterministic-core principle validated by someone else's production system.

**Missing text layer**: detected by absent or below-threshold glyph coverage, routed to
`tesseract.js` (7.0.0, Apache-2.0) with per-word confidence propagated into
`provenance.confidence`, or to a NaviGator vision model. The routing decision itself is
recorded as an `info` diagnostic.

## Rejected alternatives

**`marker` as a dependency.** Best accuracy available. Rejected on licence: the model weights'
revenue threshold cannot be a dependency of an Apache-2.0 project, and a licence that changes
obligations based on the user's revenue is not something we can pass through to users. It
remains the benchmark to beat on the PDF subset.

**`docling` as a dependency.** MIT, and its layout work is excellent. Rejected: Python, and
brief §13 rules out a non-JS core. Its document-model ideas were adopted instead (ADR-0002).

**ML layout models of our own** (an rf-detr-class detector, or a fine-tuned layout model).
Rejected for Phase 2: it makes the deterministic core depend on model weights, which breaks
brief §3.1's byte-identical guarantee and the offline `--no-llm` promise. Revisit only as an
optional, clearly-isolated adapter with its own fidelity column.

**`pdfplumber`.** Referenced in brief §2 for evaluation. Rejected as a dependency for the same
reason as docling — Python — though its table-detection strategies (explicit lines versus
inferred from text alignment) directly informed the two-stage approach above, and that debt is
recorded here.

**Naive text extraction with `getTextContent()` and heuristic newlines.** What most JS PDF
converters do. Rejected explicitly by brief §5.2, and it is the reason multi-column PDFs come
out interleaved in existing tools.

**Stripping headers and footers.** What brief §5.2 literally asks for. Rejected as written
because it violates brief §3.3; they are routed to `furniture` instead, which satisfies both
requirements. Recorded in ADR-0002.

## Consequences

- The layout analysis is the largest single piece of original algorithmic work in the project,
  and the multi-column and scanned fixtures in `CORPUS.md` exist to hold it honest.
- Born-digital PDFs should be competitive; scanned PDFs will lose to marker until the VLM path
  matures, and `docs/FIDELITY.md` will show that plainly (ADR-0010).
- OCR and VLM confidence flows into IR provenance, so downstream consumers — especially the
  agentify verification gate — can weight or exclude low-confidence content.
- `md → pdf → md` round-trip scores measure this adapter jointly with the Typst renderer, and
  `SPEC.md` §9.5 requires that to be stated whenever the number is quoted.
