# ADR-0015: Browser build boundaries

- Status: **Accepted, amended 2026-07-31** — the decision stands; three of its claims were
  measured and two were wrong. See *What building it found*.
- Date: 2026-07-29
- Relates to: brief §3.6, §8; `SPEC.md` §11
- Gated by: `scripts/check-browser-bundle.mjs`, CI job `build`
- Enforced by: scripts/check-browser-bundle.mjs

## Context

Brief §3.6 requires that local and browser-only operation be fully supported, matching the
reference project's privacy story. Brief §8 requires a browser build where the deterministic
core works fully in-browser and LLM features degrade gracefully.

The reference project achieves this with an Astro site doing client-side conversion at
word2md.com, which is a real precedent rather than an aspiration — but its pipeline is
JS-only. Ours includes three WASM artifacts of meaningful size.

## Decision

**Fully in-browser, eagerly loaded:** `ir`, `adapters-md`, `adapters-html`, `adapters-docx`,
`render-md`, `render-html`, `render-docx`, `infer`, `core`, `fidelity`, `agentify`. This set
covers the DOCX ↔ Markdown path that is the project's Phase 1 gate, so the privacy story
holds for the primary use case with no large download.

> **Amended 2026-08-02.** `agentify` was added to this list, having been `nodeOnly` since it
> was written. Nothing about the package changed to earn the promotion: every module in it
> was already pure, and `compile.ts`'s own header said this ADR "wants this to run in a
> browser". What made it `nodeOnly` was a single file, `targets.ts`, which opened the target
> registry with `node:fs`, `node:url`, `node:module` and ajv — four builtins spent on
> *acquiring* profiles rather than on understanding them.
>
> That one import list kept the Agent Context Compiler (SPEC §10) out of every browser, which
> is why the web app shipped without the product's headline feature. Loading now lives in
> `@markforge/agentify/registry-node`, reached through a subpath that `index.ts` must never
> re-export, and the pure half takes resolved profiles as data through `registryFromProfiles`.
> That is this ADR's own rule — *"browser entry points take bytes and an explicit config
> object"* — applied to a registry, the same way ADR-0003's compile seam applies it to a
> compiler.
>
> Measured: `agentify` bundles and evaluates on web-platform globals at 435 KB, and the
> shipped `browser` entry point went from 961 KB to 1,033 KB. Both figures come from
> `scripts/check-browser-bundle.mjs`, which is what would have caught the promotion had it
> been made without splitting the file.

**Lazy-loaded WASM, fetched only when the user asks for that capability:**
`render-pdf`, `adapters-pdf` (`pdfjs-dist`), `adapters-ocr` (the Tesseract bundle and its
language data).

> **Amended 2026-08-02.** This entry read *"`render-pdf` (the `typst.ts` bundle)"*, naming the
> wrong artifact: the package contains **no Typst at all** — 358 KB of renderer, measured —
> because ADR-0003's compile seam is injected. Correction 3 below already established that the
> package is the wrong unit for weight; this is the same error one line higher up. The Typst
> WASM artifact is real and is lazy, but it lives behind `@markforge/browser/pdf`, a separate
> entry point the caller loads, not behind this package.

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

## What building it found

This ADR sat at `Proposed` from 2026-07-29 to 2026-07-31 and every claim in it was
untested. Phase 5 built `scripts/check-browser-bundle.mjs`, which bundles each named
package at `platform=browser` and fails on any Node builtin or polyfill.

**The first run failed all ten packages of the eager set.** Not partly — every one.

Nine failed for one shared reason: they all depend on `@markforge/ir`, and `ir` reached
Node in three files. `node-id.ts` imported `node:crypto` for `createHash("sha256")`;
`salient.ts` and `validate.ts` each `readFileSync`-ed `schema/ir.v0.schema.json` at
runtime; and `validate.ts` used `createRequire` for ajv's CJS interop. `@markforge/ooxml`
was the only package in the repository that bundled for a browser. The tenth, `core`,
additionally reached `adapters-pdf`.

The decision survives because the fix was small and local — which is the argument the
*Rejected alternatives* section makes for not deferring the browser build, arriving two
years early in miniature. What did not survive is the assumption that stating the boundary
puts the boundary there. Three corrections:

**1. The eager set is now true, and it is true because a gate holds it there.** The schema
is embedded by `scripts/codegen-types.mjs` into `packages/ir/src/generated/schema.ts`
rather than read from disk, so it remains one source of truth with a staleness check
instead of becoming a second copy that drifts. ajv is a plain ESM import; measured, it
bundles at 299 KB. `node:crypto` is replaced by `@noble/hashes` — MIT, dependency-free,
audited, synchronous. **Justification (brief §13): the browser has no synchronous SHA-256
and node ids are synchronous by construction.** It is used in Node as well as the browser,
because two implementations selected by platform are two things that must agree about
every byte forever, with the agreement untested on whichever platform CI does not run.
Verified: node ids are byte-identical across all seven Markdown fixtures, measured on both
sides of the change, and the digest matches `node:crypto` over 306 inputs.

**2. "Lazy-loaded" and "browser-capable" are not the same property, and this ADR conflated
them.** The deferred `adapters-pdf` chunk still imports `node:module`, `node:path`, and
`node:zlib`. Deferring it means a user converting DOCX to Markdown does not download it —
which is the size argument, and that argument holds. It does not mean PDF works in a
browser today. The gate reports this as a note on every run rather than letting the word
"lazy" imply a capability nobody has built.

**3. The lazy tier is drawn around packages, and the package is the wrong unit.** This
ADR's own stated reason for deferring three packages is their weight: "Typst, pdf.js, and
Tesseract plus language data together are tens of megabytes". Measured,
`@markforge/adapters-ocr` bundles at **397 KB and contains no Tesseract at all** —
`documentFromPages` builds IR from already-recognised pages, and the `Recognizer` is
injected (ADR-0017), so the heavy artifact sits behind the injection point rather than
behind the import. Gating on package names would have failed `core` for eagerly importing
a pure function. The gate therefore asserts on the artifacts — `tesseract.js`,
`pdfjs-dist`, `typst` — and this ADR is amended to match the measurement rather than the
measurement bent to match the ADR.

**~~`render-pdf` remains untestable.~~ Built 2026-08-01; the lazy tier is now ratified for all
three members, and the third one is the only one that is actually browser-capable.**

Measured: `render-pdf` bundles at **357 KB with no Typst in it**, because ADR-0003's narrow
`compile(source, fonts) → bytes` interface is *injected* rather than imported — the same shape
ADR-0017 uses for the OCR recogniser, and with the same result. So it is deferred by **size**,
not by capability.

That sharpens correction 2 above rather than softening it. Of the three deferred packages,
`adapters-pdf` is deferred *and* not browser-capable (it still reaches `node:module`,
`node:path`, `node:zlib`), `adapters-ocr` bundles at 397 KB with the heavy artifact behind an
injection point, and `render-pdf` bundles clean. "Lazy" describes download strategy for all
three and capability for exactly one, which is the distinction this ADR originally conflated.

**The Playwright leg is STRUCK** (OPEN_QUESTIONS §7ah, 2026-08-01). The *Consequences* below
promised it; what exists is `scripts/check-surface-parity.mjs`, which evaluates the bundle in a
`vm` context holding only web-platform globals and compares its bytes against the CLI, the HTTP
API, and the MCP server across 30 conversions.

That is a real check and it is not a browser. `vm` has no DOM, no `fetch`, no worker, and no
real event loop — so the entity-decoding hazard recorded above, where a browser build routes
decoding through the *host's HTML parser*, would be caught by the bundler-condition check and
**not** by executing the bundle, because there is no parser in `vm` to route to. The label is
corrected rather than the check weakened.

**Amended 2026-08-02: the sandbox now grants `WebAssembly`, opt-in.** The PDF leg needs it to
instantiate the Typst compiler, so `webPlatformSandbox()` takes `{ wasm: true }` and the parity
harness is the only caller that passes it. It is opt-in rather than default because the *same*
function is the eager-package evaluation probe in `check-browser-bundle.mjs`, where the short
global list is the point: every global added is a global an eager package could reach without
the probe noticing. Widening the default would have quietly weakened an unrelated gate.

One limit of the PDF leg specifically, stated because the paragraph above exists to state
limits: the compiler *module* is handed to the sandbox from the host realm, since a `vm`
context cannot resolve a package. The renderer, the font wiring and `renderPdf` are all the
bundled browser code, so byte equality is a real claim about what a page would produce — but
the WASM is instantiated next door. This is the leg Playwright would improve on most.

## Fourth correction, 2026-08-02: PDF output is reachable in a browser

The three corrections above concern what the tiers *said*. This one concerns what the build can
do. `convertInBrowser` writes PDF, and the reason it can without violating anything above is
that the compiler is a **caller-supplied argument** rather than an import — ADR-0015's own
"browser entry points take bytes and an explicit config object", applied to a compiler instead
of a document.

The first attempt did violate it, and the gate caught it in one run: `pdf: { compile }` with a
dynamic `import("@markforge/render-pdf")` inside `index.ts` failed with *"browser (eager)
reaches render-pdf, which is not eager"*. That is the measurement `@markforge/core` already
records for `PdfReader` — **a bundler follows a dynamic import like any other** — arriving a
second time, in a file whose own module comment cites it. The renderer is now assembled
entirely inside `@markforge/browser/pdf` and arrives as an opaque function, so the main entry
names `render-pdf` nowhere.

Two properties the caller must supply, both measured and both silent failures otherwise: the
shipped font set (without it the compiler emits a PDF with zero embedded fonts and zero
extractable text) and `assets: false` (without it `typst.ts` fetches fonts from a jsdelivr CDN
at init — a runtime network call, pinned to a different Typst version than the Node surfaces).

## Consequences

- The host interface is a real abstraction layer, so per brief §13 the justification is stated:
  it exists so the deterministic core can run identically in Node and the browser without
  `node:` imports leaking into shared code.
- ~~Playwright tests run the browser build against the same fixtures as the Node tests.~~
  **Struck** (§7ah). Byte-equality across four surfaces is asserted by
  `scripts/check-surface-parity.mjs` in a `vm` sandbox; `docs/LIMITS.md` records what that
  sandbox cannot see.
- Lazy WASM loading means the first PDF conversion in a browser session has a visible delay.
  Acceptable, and surfaced in the UI rather than hidden.
- Tesseract language data is large and per-language, so the browser OCR path loads only the
  languages the user selects.
