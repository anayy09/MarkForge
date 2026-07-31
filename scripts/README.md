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
