# Architecture Decision Records

Every decision made on the reviewer's behalf during Phase 0, with the alternatives that
were rejected and why. Brief §0 requires this; brief §13 additionally requires a one-line
justification for every dependency, package, or abstraction layer, which lives in the ADR
that introduced it.

Format per record: Context, Decision, Rejected alternatives, Consequences. "Confirmed"
status means the reviewer chose it explicitly; "Proposed" means it was decided on their
behalf and is open to reversal at review.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-ir-foundation.md) | IR foundation: extended mdast | Proposed |
| [0002](0002-provenance-side-tables.md) | Provenance and style evidence as id-keyed side tables | Proposed |
| [0003](0003-pdf-engine-typst.md) | PDF rendering engine: Typst | **Confirmed** |
| [0004](0004-docx-renderer.md) | DOCX renderer: `docx` + reference document + Pandoc style names | Proposed |
| [0005](0005-docx-adapter-own-ooxml-reader.md) | DOCX adapter: own OOXML reader, not Mammoth | **Confirmed** |
| [0006](0006-markdown-renderer-idempotency.md) | Markdown renderer and the idempotency guarantee | Proposed |
| [0007](0007-monorepo-tooling.md) | Monorepo tooling | Proposed |
| [0008](0008-license-apache-2.md) | License: Apache-2.0 | **Confirmed** |
| [0009](0009-llm-openai-compatible-only.md) | LLM access: OpenAI-compatible client, three named models, no registry | **Confirmed** |
| [0010](0010-fidelity-baselines.md) | Fidelity baselines and the CI regression gate | Proposed |
| [0011](0011-package-scope-and-public-api.md) | Package scope and public API shape | Proposed |
| [0012](0012-pdf-adapter-stack.md) | PDF adapter: pdfjs-dist + own layout analysis | Proposed |
| [0013](0013-target-registry-agents-md-base.md) | Target registry: AGENTS.md as base, others as deltas | **Confirmed** |
| [0014](0014-node-ids-and-hashing.md) | Node ids and content hashing | Proposed |
| [0015](0015-browser-build-boundaries.md) | Browser build boundaries | Proposed |
| [0016](0016-llm-runtime-cache-and-offline-mode.md) | LLM runtime: committable cache, offline `readOnly` mode, failure semantics | Accepted |
| [0017](0017-ocr-recognizer-boundary.md) | The OCR path: an injected recogniser, and tesseract's language data | Accepted |
| [0018](0018-unit-ordering-diff-stability.md) | Source position orders context units, ahead of the content-addressed id | Accepted |
| [0019](0019-token-counting-approximation.md) | No tokenizer is bundled; `modelTokenizer` refuses rather than approximating | Accepted |
| [0020](0020-dedup-embedding-shortlist-model-decides.md) | The embedding shortlists near-duplicates; a model decides | Accepted |

## Records that deviate from the brief

Collected here so a reviewer can find every deviation without reading fifteen records. Each
is argued in place; `OPEN_QUESTIONS.md` §7 lists the ones decided without asking.

| ADR | Brief section | Deviation |
| --- | --- | --- |
| [0005](0005-docx-adapter-own-ooxml-reader.md) | §5.2 | Own OOXML reader instead of building on Mammoth's style-map extension point. **Confirmed by reviewer.** |
| [0009](0009-llm-openai-compatible-only.md) | §7.2 | No model registry, routing policy, capability tags, or generator script. **Confirmed by reviewer.** |
| [0002](0002-provenance-side-tables.md) | §5.2 | Headers and footers routed to `furniture` rather than stripped, since stripping violates §3.3. Decided without asking. |
| [0004](0004-docx-renderer.md) | §5.4 | Shipped reference documents are authored rather than redistributed publisher templates, on licence grounds. Partial deviation from the reviewer's instruction; the intent is met via `docx.referenceDoc`. |
| [0011](0011-package-scope-and-public-api.md) | §9 | `@markforge/ooxml` and `@markforge/fidelity` added to the package layout. Decided without asking. |
| [0018](0018-unit-ordering-diff-stability.md) | §6.2 | Amends `SPEC.md` §10.8's unit ordering, which was not diff-stable against its own criterion. Decided without asking; measured before deciding. |
| [0019](0019-token-counting-approximation.md) | §6.1 | No tokenizer bundled, so every token figure is a named estimate. Decided without asking. |
| [0020](0020-dedup-embedding-shortlist-model-decides.md) | §6.1 | Supersedes half of OPEN_QUESTIONS §7c: cosine shortlists, a model decides. Measurement refuted the original design. Decided without asking. |
