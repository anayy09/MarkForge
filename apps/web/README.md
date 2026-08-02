# @markforge/web

The browser workbench. Three routes: a landing page, `/forge`, and `/fidelity`.

## It is not a fifth surface

`scripts/check-surface-parity.mjs` proves the CLI, HTTP, MCP and browser builds emit
byte-identical output. This app does not add a fifth implementation to that list: it loads the
**same artifact** the gate measures.

`scripts/prepare-assets.mjs` calls `buildBrowserBundle()` and `buildBrowserPdfBundle()` from
`scripts/lib/browser-bundle.mjs` (the functions the gate itself calls) and writes the IIFEs
into `public/markforge/`. The page loads them with a `<script>` tag and reads
`window.MarkForge`.

The alternative was importing `@markforge/browser` and letting Next resolve it. That was
rejected: `browser-bundle.mjs:51` builds with esbuild `conditions: ["worker"]` because under
`platform: "browser"`, `decode-named-character-reference` resolves to a decoder that routes
HTML entities through a detached `<i>` element. Output would then depend on the browser, and
byte parity is the property the whole project is arranged around. Reproducing that condition
in Next would mean keeping Turbopack's resolver and webpack's resolver matched to esbuild's,
forever. Loading the gate's own artifact makes the question not arise.

`@markforge/fidelity` **is** imported normally, which is not an inconsistency: its only
dependency is `@markforge/ir`, which reaches `@noble/hashes` and `ajv` and no Markdown parser.
The hazard above lives in the parsing path.

## What runs where

| Capability | Browser | Server |
| --- | :-: | :-: |
| md, docx, html read and write | yes | no |
| PDF write, via Typst WASM | yes | no |
| `fmt`, fidelity metrics, IR inspection | yes | no |
| PDF, PPTX, XLSX read | no | `/api/read` |
| OCR, agentify, the model layer | no | no, refused by name |

`/api/read` returns the parsed and inferred IR rather than rendered bytes, so the client does
the render half through the parity-gated bundle. Nothing is uploaded without an explicit
confirmation naming what is sent and what is kept.

## Generated assets

Everything under `public/markforge/` is produced by `scripts/prepare-assets.mjs` and
gitignored. Committing any of it would put a second copy of the engine, the baselines and the
corpus in the tree, and `check-docs.mjs` correctly fails a git-trackable office binary
anywhere.

| File | What it is |
| --- | --- |
| `markforge.js` | The eager browser bundle, 963 KB |
| `markforge-pdf.js` | The deferred PDF chunk, 361 KB |
| `typst.wasm` | The Typst compiler, 27 MB, fetched only when a user asks for a PDF |
| `fonts/` | The five shipped faces plus a manifest |
| `samples/` | Demo documents copied out of `fixtures/` |
| `flavors.json` | The seven presets and the renderer defaults, read from the built package |
| `node-types.json` | The 53 node types, extracted from the IR schema |
| `baselines.json` | The committed fidelity baselines, verbatim |
| `parity.json` | A real sha256, computed at build time |
| `examples.json` | Real conversions, run by the real engine |
| `rendered-page.svg` | A page compiled by the same Typst compiler the PDF writer uses |

`prepare-assets.mjs` **fails the build** if `tables-merged-horizontal.docx` stops emitting
`MF-RENDER-0007` under `tables: auto` or `MF-RENDER-0006` under `tables: gfm`. The landing page
quotes both as live measurements, so a change there has to be a decision rather than a drift.

## Commands

```sh
pnpm build:web       # pnpm -w build, then prepare:assets, then next build
pnpm dev:web         # prepare:assets, then next dev
pnpm typecheck:web   # runs in `pnpm verify` and in CI
```

`apps/web` is deliberately outside the `tsc -b` project graph in the root `tsconfig.json`:
Next needs `noEmit`, and TypeScript rejects that alongside `composite`. It still extends
`tsconfig.base.json`, so `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and
`verbatimModuleSyntax` all apply.

## Deployment

`vercel.json` at the repo root carries the build configuration. **One dashboard setting is
load-bearing and cannot move into the file: Root Directory must be `apps/web`.** Everything in
`vercel.json` is then resolved relative to that, which is the part that is easy to get wrong.

`outputDirectory` is `.next`, not `apps/web/.next`. The first deploy used the latter and failed
after a completely successful build:

```
Error: The Next.js output directory "apps/web/.next" was not found at
"/vercel/path0/apps/web/apps/web/.next"
```

Two things were wrong and only the first is obvious. The path is relative to the Root
Directory, so it doubles. And Vercel **stores** these fields on the project at first deploy, so
deleting `outputDirectory` from this file does not restore the default: the stale
`apps/web/.next` keeps being applied. The field has to be present with the right value to
override it.

Two limits worth knowing before relying on the hosted instance:

- **The request body cap is 4 MB.** That is the platform's, not MarkForge's. `/api/read`
  states it and the UI guards against it. The CLI and a self-hosted `markforge serve` have no
  such cap.
- **`typst.wasm` is 27 MB uncompressed.** It sits behind an explicit action with the size
  named beforehand, and is served `immutable` for a year. If a deployment target refuses a
  static asset that large, serve it from a route handler with `Content-Encoding: br` instead.
