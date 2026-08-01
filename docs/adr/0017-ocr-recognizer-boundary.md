# ADR-0017: The OCR path — an injected recogniser, and why tesseract must be asked twice

- Status: **Accepted** (Phase 3)
- Date: 2026-07-31
- Relates to: brief §5.2, §3.6, §7.1; `SPEC.md` §3.3, §3.4, §11; [ADR-0012](0012-pdf-adapter-stack.md), [ADR-0009](0009-llm-openai-compatible-only.md)
- Enforced by: scripts/check-browser-bundle.mjs

## Context

ADR-0012 committed to two recognisers for a PDF with no text layer: `tesseract.js` locally, or
a NaviGator vision model. Building both ran into a boundary that the package rules make
genuinely hard rather than merely awkward.

`SPEC.md` §11's CI-enforced rule is that `adapters-*` and `render-*` **must not** depend on
`@markforge/llm`, nor on each other. But one of the two recognisers *is* the LLM layer, and the
page images it needs come from `@markforge/adapters-pdf`. Written naively, the OCR adapter would
depend on both of the things it may not depend on.

The second problem is smaller and sharper: **tesseract.js downloads a 15 MB language model from
a CDN by default.** Brief §3.6 says any network call is opt-in and explicit, never a default.
An OCR path that works because a CDN happens to be up is not the offline guarantee this project
claims.

## Decision

**The recogniser is a function type, injected.** `@markforge/adapters-ocr` defines
`Recognizer = (page: PageImage) => Promise<RecognizedPage>`, ships the tesseract
implementation, and knows nothing about models. `@markforge/llm` exports `visionRecognizer`,
which produces a function of that shape without importing the OCR package. `@markforge/core`
composes: it takes a `PdfReadResult`, and if the PDF is a scan it hands the extracted page
images to whichever recogniser the caller supplied. The dependency rule stays mechanically
true — there is no import to forbid — rather than becoming a rule with an exception.

**`readPdf` returns a discriminated result rather than throwing on the scan branch.** A PDF is
either a document or a picture of one, and which it is cannot be known until it is opened. The
scan branch carries the page images with it, so the OCR route is one pass over the file.
`parsePdf` still throws for a scan, unchanged from Phase 2 (`OPEN_QUESTIONS.md` §7i), because a
caller that asked for a document and cannot be given one deserves an error rather than a union.

**Page images come from the raster the PDF contains, via pdf.js's operator list**, not from
rendering the page. Rendering needs a canvas implementation pdf.js cannot polyfill in Node, so
a native dependency would be the price of reading a scan. For a scanned page these are the same
thing; for a page drawn with vector operators they are not, and that case emits
`MF-PDF-0002` and transcribes nothing rather than guessing.

**`PageImage` is declared in two packages**, identically, and structural typing makes them
interchangeable. `packages/core/test/assist.test.ts` asserts mutual assignability, so a
divergence is a compile error. Ten duplicated lines with a mechanical check is the honest cost
of the no-cross-adapter-dependency rule; the alternatives are worse (below).

**`createTesseractRecognizer` refuses to be constructed without `langPath` or an explicit
`allowDownload: true`.** Not a warning, not a default with a note in the docs — a thrown error
naming the flag and where to get the file. And tesseract.js is an `optionalDependency`,
lazily imported, so an install that will never OCR anything does not pay for a WASM bundle.

**Confidence is a first-class output.** Every node this adapter produces carries the
recogniser's confidence in its provenance and `producedBy` records *which kind* of reader
produced it (`{kind:"ocr"}` or `{kind:"model"}`). A page below `lowConfidence` (default 0.6) is
a **lossy** diagnostic, so `--strict` fails on a transcription nobody should trust quietly; a
page that transcribed to nothing is also lossy, because a blank page and a failed recogniser are
indistinguishable from here and skipping the page silently is the one unacceptable outcome.

## Rejected alternatives

**Putting the recogniser contract in `@markforge/ir`.** It is the shared-contract package, so
this is the obvious home and it would remove the duplication. Rejected: the IR is a document
representation, and a function type describing how to read an image is not part of it. Widening
`ir` to hold whatever two packages need to agree on is how a contract package becomes a utility
bin.

**Letting `adapters-ocr` depend on `adapters-pdf`** for page extraction, or `adapters-pdf`
depend on `adapters-ocr` for the recogniser. Either would work and either breaks the §11 rule
that keeps adapters independently publishable. The rule is CI-enforced; earning an exception for
convenience would make the next exception easier.

**A `render-pdf`-style page rasteriser via `@napi-rs/canvas`.** It would handle vector pages and
scans uniformly, and it is what pdf.js expects in Node. Rejected for Phase 3: a native
dependency for the sake of a page class our corpus does not yet contain, and it would put a
platform binary in the install path of a toolkit whose selling point is running anywhere.
Revisit when a fixture demands it.

**Downloading tesseract's language data on first use, with a progress message.** What
tesseract.js does by default and what most integrations keep. Rejected under brief §3.6: the
message would be the only thing distinguishing it from a silent network call, and "offline
except the first time" is not offline.

**Bundling `eng.traineddata` in the repository.** 15 MB of Apache-2.0 data would make the OCR
path work with no flags. Rejected on `CORPUS.md` §4's size discipline — it names Tesseract
language data specifically as the kind of artifact that is fetched rather than committed — and
because a language file per language is not a scaling story.

**Synthesising a `figure` node to hold a caption the vision model reports.** It would preserve
the caption construct instead of degrading it to a paragraph. Rejected: brief §7.1 forbids
generating structure not evidenced in the source, and a figure we did not extract is not
evidence. The text survives and the lost binding is diagnosed.

## Consequences

- **The tesseract path is implemented but not measured in CI**, because CI cannot download the
  language model. Its rows in `docs/FIDELITY.md` are absent rather than estimated, and the
  vision path is what the Phase 3 numbers report. This is a real gap and is stated as one.
- **Tesseract returns text and confidence, not font sizes**, so it produces paragraphs and list
  items and never a heading — and `@markforge/infer` cannot help, because a raster carries no
  style sidecar. A vision model can see that a line is large and bold. So the two recognisers
  differ in *structural* fidelity, not only in accuracy, and that difference is a property of
  the engines rather than of our wiring.
- A scanned PDF with `--no-llm` and no `--ocr` still fails, by design, with a message naming
  both routes. "MarkForge cannot read this file" remains preferable to a document containing
  three words of a forty-page scan.
- `documentFromPages` recognises pages sequentially. A forty-page scan is forty round trips
  rather than forty concurrent ones, which is slower and does not rate-limit a shared
  university gateway into failing half the pages.
