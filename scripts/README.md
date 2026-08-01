# scripts/

Repository-level verification: the checks that guard the documents and the package
architecture, as distinct from the unit tests that live beside each package's source.

`check-docs.mjs` began as a Phase 0 check asserting the repository contained *no* code. That
assertion was correct then and wrong the moment Phase 1 started, so it was replaced rather
than deleted — the underlying question, "is the package boundary still real?", outlives the
phase. It now asserts that every package is private and Apache-2.0, that no adapter or
renderer reaches the LLM layer (ADR-0009), that `@markforge/ir` depends on neither, that
generated files keep their do-not-edit banner, and that no build output is committed.

| Script | Dependencies | What it does |
| --- | --- | --- |
| `check-docs.mjs` | none | Deliverables agree with each other and with the brief; Phase 1 architecture invariants |
| `check-schemas.mjs` | `ajv`, `ajv-formats` | The three JSON Schemas compile in strict mode; the worked examples validate |
| `codegen-types.mjs` | `json-schema-to-typescript` | Generates TypeScript types from the schemas (`pnpm codegen`) |
| `add-salient-annotations.mjs` | none | One-shot migration that added `x-salient` to the IR schema |
| `check-fixtures.mjs` | none | Every fixture has a licence line, and every licence line has a fixture |
| `build-messy-fixtures.mjs` | none | Generates the deliberately defective DOCX corpus (`docs/CORPUS.md` §2.3, §2.15) |
| `build-scanned-fixtures.mjs` | none | Rasterises `fixtures/md/scanned-source.md` into scanned PDFs with no text layer (`docs/CORPUS.md` §2.7) |
| `build-agentify-corpus.mjs` | built packages | Authors the three Phase 4 source sets and their answer keys, and gates the near-duplicate pairs (`docs/CORPUS.md` §2.14) |
| `check-markdown-lint.mjs` | `markdownlint`, built packages | Lints the Markdown our renderer produces. A gate, not a repair pass (ADR-0006) |
| `diff-mammoth.mjs` | `mammoth`, built packages | Differential test of our OOXML reader against Mammoth; every divergence triaged in `docs/MAMMOTH-DIFF.md` (ADR-0005) |
| `fetch-ocr-assets.mjs` | network, once | Downloads tesseract language data and the found scan into gitignored `fixtures/local/` (`docs/CORPUS.md` §2.7) |
| `check-browser-bundle.mjs` | `esbuild`, built packages | Builds every package ADR-0015 claims runs in-browser at `platform=browser` and fails on any `node:` builtin or polyfill. The Phase 5 gate that took ADR-0015 off `Proposed` |
| `check-http-retention.mjs` | built packages | Measures brief §8's "stateless, no document retention" — filesystem delta, retrieval routes, minted ids, cross-request contamination — against a deliberately retaining control |
| `check-surface-parity.mjs` | `esbuild`, built packages | **Phase 5's done-criterion.** Every corpus fixture through the CLI, the HTTP API, the MCP server, and the browser build, compared byte for byte, with `MODEL_API_KEY` unset |
| `lib/browser-bundle.mjs` | `esbuild` | Not a check — the shared browser build and its web-platform-only sandbox, so the two gates above are talking about the same artifact |
| `run-fidelity.mjs` | built packages | Measures the corpus, writes `docs/FIDELITY.md`, gates on baselines |
| `run-scoreboard.mjs` | built packages, pandoc | Compares against Pandoc, writes `docs/SCOREBOARD.md` |
| `inspect-docx.ps1` | none (Windows PowerShell) | Read-only inspection of a DOCX: styles, provenance, numbering, theme fonts |

## Running them

```sh
node scripts/check-docs.mjs          # works on a fresh clone, no install needed

pnpm install                         # ajv is a workspace dev dependency
node scripts/check-schemas.mjs

pnpm verify                          # docs + schemas + fixtures + typecheck + tests
```

`check-schemas.mjs` **skips with exit 0** when ajv is absent, rather than failing: a missing dev
dependency is not a specification defect, and a check that fails for environmental reasons
teaches people to ignore it.

Both resolve the repository root from their own location, so neither contains an absolute path.
That is the same rule `SPEC.md` §1 imposes on MarkForge's own output, and it applies here for the
same reason: an absolute path makes a result unreproducible on another machine.

## `check-fixtures.mjs`

Enforces `docs/CORPUS.md` §1 rule 1 in **both** directions: a committed fixture with no licence
line fails, and a licence line naming a file that does not exist fails too. The second direction
matters as much as the first — a register describing files nobody can find is worse than no
register, because it looks like diligence.

It runs before the conversion tests in CI, so an unlicensed fixture cannot be used even by a
test that does not know it is unlicensed. Only `fixtures/local/` and `fixtures/generated/` are
exempt, and only because they are gitignored: nothing in them is distributed.

## `build-messy-fixtures.mjs`

Writes the DOCX fixtures for `docs/CORPUS.md` §2.3 (badly formatted real-world documents) and
§2.15 (library- and LLM-generated documents). Every other fixture in the corpus is *clean*
authored input, which measures the easy path and says nothing about the hard one — and Surface
B's whole claim is about documents whose structure has to be recovered rather than read.

```sh
node scripts/build-messy-fixtures.mjs           # write the fixtures
node scripts/build-messy-fixtures.mjs --check   # exit 1 if a committed file is stale
```

The OOXML is assembled from small local helpers rather than through `@markforge/render-docx`,
deliberately. A fixture built by the renderer could only ever contain markup the renderer knows
how to produce, so it could not test reading the things the renderer would never write —
direct formatting instead of styles, a broken `w:basedOn` chain, a missing `theme1.xml`.

**The output is committed and CI checks it is current.** `CORPUS.md` §2.15 originally said to
generate into gitignored `generated/`, which is right for 600 DPI scans and OCR language data.
These are 2–4 KB each, and committing them means a test needs no build step and a fixture cannot
silently change underneath a test. `--check` is what keeps the committed bytes honest.

## `build-scanned-fixtures.mjs`

Writes the scanned-PDF corpus for `docs/CORPUS.md` §2.7: `fixtures/md/scanned-source.md`
rasterised at 150, 300, and 600 DPI with controlled skew and speckle, wrapped in a PDF whose
pages are one bitonal image each and which contains **no text layer at all**.

```sh
node scripts/build-scanned-fixtures.mjs           # write the fixtures
node scripts/build-scanned-fixtures.mjs --check   # exit 1 if the committed 150 DPI file is stale
```

Only 150 DPI is committed (18 KB). The other two land in gitignored `fixtures/generated/`,
because `CORPUS.md` §4 names 600 DPI scans specifically as the kind of artifact produced by a
committed script rather than kept in git history forever.

Three things about it are deliberate:

- **The glyphs are a 5x7 bitmap font written out as pictures inside the script.** There is no
  font rasteriser here, and shipping a TTF we are not licensed to redistribute would be worse.
  The consequence is stated in `CORPUS.md` §2.7 and worth repeating: absolute OCR accuracy on
  these files is not comparable to accuracy on a real scan. Engine-against-engine and
  DPI-against-DPI, on identical bytes, is what they measure.
- **The PDF writer is hand-rolled** rather than borrowed, because the point of the fixture is
  what the file does *not* contain. Any "searchable PDF" pipeline would helpfully embed an
  invisible text layer and make the scan detection it exists to exercise pass trivially.
- **Every degradation is integer arithmetic from a seeded PRNG.** The committed LLM cache is
  keyed on the page image's digest (`SPEC.md` §6.3), so a rasteriser that changed its output by
  one pixel — or that used trigonometry whose last bit differs across platforms — would
  invalidate every recorded vision response.

The script also refuses rather than degrades: a source construct it cannot draw, or a list item
wrapped across two lines, throws with the reason. A rasteriser that quietly skipped a table
would produce a fixture whose committed ground truth claims content the image does not contain,
which would make every OCR number measured against it meaningless.

## `check-browser-bundle.mjs`

ADR-0015 named ten packages that "run fully in-browser" and three deferred behind a lazy
load. It carried `Status: Proposed` through four phases because nothing ever built it. This
script builds it.

Four sections, and the last one is why the first three mean anything:

1. Every eager package bundles at `platform=browser` with no `node:` builtin reachable.
   Measured from esbuild's resolution errors, so a builtin arriving through a transitive
   dependency counts the same as an import.
2. No Node global stands in for a builtin that is absent — `Dynamic require of`,
   `process.env`, `__dirname`, `__filename`, `globalThis.process`.
3. `core` is split into chunks, and its **entry** chunk must contain no builtin and none of
   `tesseract.js`, `pdfjs-dist`, or `typst`. Builtins are marked external only here, and
   only so the build gets far enough to answer *which chunk* rather than *whether*.
4. Negative controls: a direct `node:fs` import, a builtin two hops away behind a clean
   entry point, and a `process.env` read that bundles successfully and must still be caught.

**The first run failed all ten.** Every one failed through `@markforge/ir` — `node:crypto`
in `node-id.ts`, and a runtime `readFileSync` of `ir.v0.schema.json` in both `salient.ts`
and `validate.ts`, plus `createRequire` for ajv's CJS interop. `@markforge/ooxml` was the
only package in the repository that bundled. The ADR's central claim was not partly wrong;
it was wrong for every package it named, for one shared reason nobody had run.

Three of the notes it prints are findings rather than progress reports, and they are the
reason ADR-0015 is amended rather than simply ratified: `render-pdf` does not exist, so a
third of the lazy tier is untestable; the deferred `adapters-pdf` chunk still needs
`node:module`, `node:path`, and `node:zlib`, so "lazy" and "browser-capable" are not the
same property; and `adapters-ocr` bundles clean at 397 KB with no Tesseract in it at all,
because the recogniser is injected — so the ADR's lazy tier is drawn around packages when
the thing worth deferring is the WASM artifact.

Two of its own checks were wrong first, both caught by reading output against what is on
disk rather than by reasoning:

- **Check 3 reported the absent `render-pdf` as present.** It inferred existence from the
  shape of an esbuild error, and esbuild reports a missing entry point with the same
  `Could not resolve "…"` wording it uses for a builtin. It now uses `existsSync`.
- **Check 2's negative control tested nothing.** It read `process.env.NODE_ENV`, the one
  key esbuild constant-folds by default, so the control bundled to `var mode = "development"`
  with no `process` in it. Any other variable name survives.

## `check-http-retention.mjs`

Brief §8 says the HTTP API is "stateless, no document retention". That is a privacy claim,
and ADR-0015 rejected a server-side fallback for the browser's heavy paths on the same
grounds — so the surface only earns its exception if the claim can be checked.

Four probes, run against the shipped server and against a deliberately retaining control:
a filesystem hash delta over the working directory, a request for every URL a retaining
server would have to expose, an inspection of headers and the JSON envelope for a minted
handle, and a marker document followed by a second request that must contain no trace of
it. The fourth is the one that reaches an **in-memory** cache, which the first three
cannot see.

The control is a real retaining server rather than a simulated one: it writes each body to
disk, mints an id and returns it in a header, serves documents back by that id, and leaks
the last request through `/health`. All four probes must catch it. A retention check that
only found the file on disk would pass a server that kept everything in RAM, and that is
the failure this control is shaped to provoke.

**What it does not measure, stated rather than implied:** memory the process holds and
never exposes. Probe 4 catches retention that any observable behaviour depends on, which
is the part that can leak. A buffer nobody reads is not distinguishable from one the
allocator has not yet reclaimed, and claiming otherwise would be exactly the kind of
assertion this file exists to replace.

## `check-surface-parity.mjs`

Phase 5's done-criterion, and the reason it is byte equality rather than "all four work":
a surface that transformed anything on the way in or out — trimmed a trailing newline,
re-encoded a string, normalised a line ending — would pass every unit test in its own
package and show up nowhere except here.

Thirty conversions: ten fixtures across Markdown, HTML, and DOCX inputs, times three
output formats, each produced four ways. The CLI is spawned and writes real files; the
HTTP API is a listening server; the MCP server is spawned and driven over real stdio
JSON-RPC; the browser build is the bundle from `lib/browser-bundle.mjs` evaluated in a
`vm` context holding **only web-platform globals** — no `process`, no `Buffer`, no
`require`. `MODEL_API_KEY` is deleted from every child environment, so a surface that
reached the network fails here rather than quietly succeeding.

The negative control runs **per comparison rather than once**: a flipped byte in a copy of
the CLI output must be detected every time, so a comparator that stopped comparing partway
through the matrix is caught too.

**Two things it found.**

The browser build resolved `decode-named-character-reference` to `index.dom.js`, which
decodes HTML entities by writing them into a detached `<i>` element and reading
`textContent` back. Sensible in a page; a determinism hazard here, because it routes
entity decoding through the host's HTML parser and the criterion is byte equality with the
CLI. The `worker` export condition selects the same table-based module Node loads —
measured, that changes exactly one package's resolution and costs 47 KB.

And `--llm` against an unreachable endpoint exited **0** with `ok: true`. The first version
of this check missed it by using `clean-report.md`, which produces zero ambiguous heading
decisions, so `--llm` had nothing to ask; `messy-ambiguous-headings.docx` was authored in
Phase 3 to produce them and yields four. The check then reported the finding **wrongly**,
calling it a silent fallback — it was not silent, `llmFailures` carried all four and the
run report showed `failures: 4, liveCalls: 0`. What was true is narrower and still a
defect: no `Diagnostic` was emitted, so `--strict` could not see it and `MF-LLM-0001` had
an emission site for one case and none for this one, while `ok: true` made "the model was
never reached" indistinguishable from success.

**What it does not do:** run a real browser. ADR-0015's *Consequences* promise Playwright
against the same fixtures, and that remains unbuilt. The `vm` sandbox shares V8 with the
host, so it would not catch a genuine engine difference; what it does catch is the failure
that actually occurs — code reaching for a Node global — without a browser binary.

## `check-markdown-lint.mjs`

Renders every `docs/`, `docs/adr/`, and `fixtures/md/` Markdown file through
`formatMarkdownSync` and lints the result.

**It never fixes anything**, which is the point. ADR-0006 originally specified
`remark-stringify` followed by markdownlint autofix iterated to a fixed point, guarded by
`maxIterations: 8`. Two formatters that can disagree — about emphasis markers, list
bullets, line wrapping — can each undo the other, and that is what made the fixed point
uncertain enough to need a guard. Configuring `remark-stringify` to satisfy the rule set up
front and then *checking* gets idempotency from `stringify` being a pure function of the
tree instead: no loop, no cap, nothing to oscillate.

Measured before adopting it: 34 files, **zero violations**, no autofix pass. Five rules are
disabled, each because it conflicts with a decision recorded elsewhere rather than because
the configuration could not satisfy it — the reasons are in the file next to each one. The
one worth knowing about is `MD029`, which wants every ordered list renumbered to start at 1
and would therefore destroy `restartsAt`, the field the IR carries specifically so a list
starting at 7 survives a round trip.

A failure here means the stringify configuration has drifted from the rule set. Fix the
configuration in `@markforge/render-md`; do not post-process the output.

## `diff-mammoth.mjs`

Runs both OOXML readers over `fixtures/docx/`, reduces each to plain text plus a structural
outline, and diffs.

**A divergence is not a failure.** Beating Mammoth on documents whose structure is carried by
direct formatting is the entire point of ADR-0005, so the exit code is driven by the triage
file rather than by the diff: every divergence must appear in `docs/MAMMOTH-DIFF.md`
classified `improvement`, `bug`, or `accepted`, and `--check` fails on an untriaged one. That
is all this can honestly do — Mammoth is a second opinion, not an oracle.

It has already earned its keep once. It found that a `w:pStyle` referencing a style
`styles.xml` never defines was dropped by our inference rules while Mammoth recovered the
heading, which is fixed as rule 2b in `@markforge/infer`. See `docs/MAMMOTH-DIFF.md` for the
current list and for what the test deliberately does not cover.

Running without `--check` also writes `docs/.mammoth-diff.generated.md`, a starter table so
triage is an edit rather than a transcription job. That file is gitignored.

## `fetch-ocr-assets.mjs`

Downloads the two third-party files the OCR path needs into gitignored `fixtures/local/`:
`eng.traineddata` (4 MB, Apache-2.0, from `tessdata_fast`) and a 1973 NASA technical report
(1.2 MB, public domain) as the found scan of `docs/CORPUS.md` §2.7.

Neither is committed, per §4's size rule, and everything downstream degrades rather than
breaking when they are absent: the tesseract fidelity row is omitted and the real-engine tests
skip. Run this once to turn them on.

The reason the data is not simply downloaded on demand is ADR-0017: `createTesseractRecognizer`
refuses to start unless `langPath` names a local directory or `allowDownload` is passed
explicitly, because brief §3.6 makes every network call opt-in. "OCR quietly worked because a
CDN was up" is not an offline guarantee, so the fetch is a separate, deliberate step.

## `build-agentify-corpus.mjs`

Authors the `docs/CORPUS.md` §2.14 source sets — ten documents across Markdown, HTML, and
DOCX in three sets (clean, conflicting, oversized) — plus an `expected-units.json` answer key
per set. `--check` fails if a committed byte drifted.

**The answer keys are authored, not captured.** They record what a correct extractor *should*
find, written before the extractor exists. A file captured from a run would be a regression
snapshot: it tells you the output changed, never that it was wrong, and it blesses whatever
the first implementation happened to do.

**It also gates its own premise.** SPEC §10.4 merges near-duplicate context units by embedding
rather than by text similarity, on the argument that a constraint restated in another document
shares almost no tokens. The script computes content-word Jaccard for each near-duplicate pair
and **fails at or above 0.2** — at which point a text threshold would already merge the pair
and it would prove nothing. Both pairs currently score 0.000.

That gate exists because Phase 3's "ambiguous subset" did not exist: every fixture scored zero
ambiguous decisions, so the criterion naming it was unmeasurable rather than unmet. A corpus
that looks like it exercises something is not evidence that it does.

The DOCX file is rendered from authored Markdown by our own renderer, which would be the wrong
choice in `fixtures/docx/` — the point there is catching adapter bugs — but is fine here, where
the fixture is the document's content and role rather than its format fidelity.

## `build-reference-templates.mjs`

Builds the three reference DOCX templates `TEMPLATES.md` §2 promises, into `templates/`.
`--check` fails if a committed byte drifted, and also re-asserts the §2.1 inventory: all 38
Pandoc style names defined in each, the twenty constructs the primary template must contain,
and **zero direct formatting in the body**.

That last one is the reason the templates exist. They are our own demonstration that named
styles suffice, so a shipped template containing direct formatting would undercut the argument
in brief §5.1. The check allowlists exactly two elements inside a body `w:rPr` — `w:rStyle` and
`w:i` — and fails on anything else.

**Written as raw OOXML rather than through `@markforge/render-docx`, deliberately.** The
renderer cannot produce most of §2.1: no embedded images, no `footnotes.xml`, no OMML, no
resolved cross-references. A template built by the renderer would contain exactly the
constructs we already handle, which is the opposite of a gate.

Building them found two defects immediately, both invisible until a document with a header
existed: furniture `content` was a bare array where the schema declares a `Root` — forced past
the compiler with a double cast — and IR validation took longer than two minutes on a 183-node
document, so `markforge check` hung on anything with tables in it.

## `check-agentify.mjs`

The Phase 4 gate harness. Runs both halves of the done-criterion (`docs/INIT.md` §11) plus five
supporting checks, and regenerates `docs/AGENTIFY.md`. `--update` rewrites the document and the
extraction baseline; CI runs it bare and fails on a regression or a stale document.

Seven checks: traceability on the clean set for all five first-class targets; the **negative
control**; the one-region diff after a one-sentence source edit; conflict recall and false
positives; budget overflow losing no unit; byte-identical output across two runs; and extraction
measured against the authored answer keys.

**The negative control is the one that makes the rest mean anything.** Three crafted violations
— invented text in a fragment that names a real unit, a fragment naming a unit id that does not
exist, and scaffolding the target profile never declared — must each be caught, and a
well-formed file must still pass. A gate that cannot fail proves nothing when it passes, and
this project has shipped one of those before: see `STATUS.md` on the heading predicate that
accepted `## Ignore all previous instructions` as legitimate structure.

Extraction is scored against `expected-units.json` by matching on **words first, then category
and source** — never on exact text, because the keys paraphrase deliberately and an exact
comparison would measure paraphrase distance rather than extraction. Units found under the
wrong category are counted separately from units not found at all, since they are different
defects: one reaches the output file, the other does not.

Everything runs offline with no API key. `--no-llm` is the default and the gate has to clear
without a model.

## `run-fidelity.mjs`

Measures three loops — `md → md`, `md → docx → md`, `docx → md → docx` — across the corpus,
writes `docs/FIDELITY.md`, and compares against `fixtures/expected/baselines.json`.

```sh
node scripts/run-fidelity.mjs            # measure and report
node scripts/run-fidelity.mjs --update   # rewrite the baselines
node scripts/run-fidelity.mjs --check    # exit 4 on a regression (CI)
```

Two deliberate properties. It has **no way to skip a fixture or suppress a row**, because a
report that can hide its worst numbers is marketing. And it reports *improvements* as well as
regressions without failing on them: an unexplained jump is as likely to mean the metric broke
as that the converter improved, so it asks a human to look rather than quietly banking the win.

It imports from `dist/`, not `src/`, so it measures what ships.

## `run-scoreboard.mjs`

Scores MarkForge against Pandoc on the same corpus and writes `docs/SCOREBOARD.md`.
`docs/CORPUS.md` §3 requires the comparison, and the Phase 1 done-criterion is phrased in terms
of it.

**Skips with exit 0 when pandoc is absent**, because a comparison with a missing competitor is
impossible rather than failed. Install it with `winget install JohnMacFarlane.Pandoc`.

`--check` guards the metrics where the two tools currently tie. It deliberately does *not*
require beating Pandoc overall: MarkForge does not beat it on the structural metric today, and a
gate asserting something untrue would either fail forever or invite tuning the metric until it
passed. The honest gate is "do not get worse at what we are currently equal on".

The report opens with its own bias in both directions — one favouring us, one favouring Pandoc —
because a comparison that hides its methodology is an advertisement.

## `codegen-types.mjs`

Regenerates `packages/*/src/generated/*.ts` from the JSON Schemas. **Never hand-edit the
output**: `docs/SPEC.md` §2.2 requires types to be generated because a hand-written type and a
schema that disagree produce a validator accepting what the compiler rejects. That is not
hypothetical — an early draft of `packages/ir/src/document.ts` hand-declared `StyleEvidence`
with a flat `{ fontSizePt, bold }` shape while the schema specified nested
`{ font: { sizePt, weight } }`, and every document the DOCX adapter produced failed validation
until the duplication was removed.

`check-docs.mjs` asserts the generated files still carry their do-not-edit banner, so removing
the banner to make an edit look legitimate fails CI.

## `add-salient-annotations.mjs`

A one-shot migration, kept for the record rather than for re-running. `docs/SPEC.md` §2.7 said
the salient-attribute allowlist was "declared in the schema"; it was not, and this script made
the claim true by adding `x-salient` to all 53 node types. Re-running it is safe and
idempotent, and is the right move if a node type is added — the default for a new property is
*excluded*, which is the safe direction.

## `inspect-docx.ps1`

A hand tool, not a check. It prints what `markforge check --reference-doc` is specified to report
(`SPEC.md` §4.2.1) before that command exists, which is how the IEEE template measurements in
`docs/TEMPLATES.md` §3.1 were obtained.

```powershell
./scripts/inspect-docx.ps1 -Path fixtures/local/ieee-conference-template.docx
```

Reads the ZIP container in memory and extracts nothing to disk. Reports the part list with
sizes, `docProps` provenance, every defined style with its `basedOn` chain, numbering
definitions and `startOverride` count, theme font tokens, and the styles actually used in the
body with counts plus totals for paragraphs, tables, direct `w:rPr` runs, OMML equations, and
drawings.

Use it on any third-party document before deciding what a fixture or reference document is worth.
The style-name-versus-`styleId` distinction it surfaces is the one that matters most in practice
(`SPEC.md` §4.2.2).

## What these are not

They do not test MarkForge, because MarkForge does not exist yet. They test the *specification*
for internal consistency — that every node type in the schema is documented and reachable, every
ADR is cited, every link resolves, every config field in prose exists in the schema, and no
unlicensed binary is committable. Phase 1 adds real tests against real fixtures.
