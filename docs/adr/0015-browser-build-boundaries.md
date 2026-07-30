# ADR-0015: Browser build boundaries

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §3.6, §8; `SPEC.md` §11

## Context

Brief §3.6 requires that local and browser-only operation be fully supported, matching the
reference project's privacy story. Brief §8 requires a browser build where the deterministic
core works fully in-browser and LLM features degrade gracefully.

The reference project achieves this with an Astro site doing client-side conversion at
word2md.com, which is a real precedent rather than an aspiration — but its pipeline is
JS-only. Ours includes three WASM artifacts of meaningful size.

## Decision

**Fully in-browser, eagerly loaded:** `ir`, `adapters-md`, `adapters-html`, `adapters-docx`,
`render-md`, `render-html`, `render-docx`, `infer`, `core`, `fidelity`. This set covers the
DOCX ↔ Markdown path that is the project's Phase 1 gate, so the privacy story holds for the
primary use case with no large download.

**Lazy-loaded WASM, fetched only when the user asks for that capability:**
`render-pdf` (the `typst.ts` bundle), `adapters-pdf` (`pdfjs-dist`), `adapters-ocr`
(the Tesseract bundle and its language data).

**Zip handling uses `fflate`** (0.8.3, MIT, 2026-05-16) rather than `jszip` — smaller, actively
maintained, and avoids `jszip`'s dual MIT/GPL-3.0-or-later licence in an Apache-2.0 tree
(ADR-0008).

**LLM features degrade to unavailable, never to silently-different output.** In the browser the
LLM layer is disabled unless the user supplies an endpoint and key explicitly, and a disabled
LLM produces the same deterministic result as `--no-llm` on the CLI — with the ambiguity
warnings that mode emits. There is no path where the browser quietly produces different output
than the CLI for the same input.

**No filesystem, no ambient config.** Browser entry points take bytes and an explicit config
object. `@markforge/core` therefore abstracts file access behind a small host interface
implemented once for Node and once for the browser, rather than importing `node:fs` anywhere
outside that implementation. Enforced by a CI check that the browser bundle contains no
`node:` imports.

## Rejected alternatives

**Node-only, with the browser build deferred.** Faster to Phase 1. Rejected: brief §3.6 makes
privacy-first operation a principle rather than a feature, and retrofitting a browser build
after the fact reliably fails, because `node:fs` and `process.env` accrete throughout the
codebase in the meantime. The host interface is cheap now and expensive later.

**Eagerly bundling all WASM.** Simplest to build, one artifact. Rejected on size: Typst,
pdf.js, and Tesseract plus language data together are tens of megabytes, and a user converting a
DOCX to Markdown should not download a PDF engine and an OCR engine to do it.

**A server-side fallback for the heavy paths** — send the PDF to our HTTP API when the browser
lacks the WASM. Rejected: it silently transmits the user's document to a network service, which
inverts brief §3.6. The HTTP API exists and is stateless, but using it must be the user's
explicit choice, never an automatic fallback.

**Dropping PDF support in the browser entirely.** Would simplify the story. Rejected: Typst's
WASM build was a decisive factor in ADR-0003 precisely because it makes browser PDF possible,
and discarding that capability would waste the reason we chose the engine.

**Allowing the browser build to skip inference for bundle size.** Rejected: it would make
browser and CLI output differ for the same input, which breaks the determinism guarantee more
seriously than any size concern justifies. `infer` is deterministic, pure, and small.

## Consequences

- The host interface is a real abstraction layer, so per brief §13 the justification is stated:
  it exists so the deterministic core can run identically in Node and the browser without
  `node:` imports leaking into shared code.
- Playwright tests run the browser build against the same fixtures as the Node tests, and both
  must produce byte-identical output. This is the strongest available check that the two
  surfaces have not diverged.
- Lazy WASM loading means the first PDF conversion in a browser session has a visible delay.
  Acceptable, and surfaced in the UI rather than hidden.
- Tesseract language data is large and per-language, so the browser OCR path loads only the
  languages the user selects.
