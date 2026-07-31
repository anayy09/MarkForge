# ADR-0005: DOCX adapter — own OOXML reader, not Mammoth

- Status: **Confirmed by reviewer.** Deliberate deviation from brief §5.2.
- Date: 2026-07-29
- Relates to: brief §5.2, §4.2, §5.3; `SPEC.md` §3.1; ADR-0004

## Context

Brief §5.2 says: "**DOCX**: build on Mammoth's style-map extension point rather than fighting
its defaults." Brief §4.2 separately requires a style provenance sidecar carrying source
style name, computed font family and size, weight, alignment, indent, numbering id and level,
list restart, and table cell geometry — and calls that sidecar "what every existing tool
throws away." Brief §5.3 requires heading inference by clustering font sizes and weights from
that sidecar.

These two requirements are in tension, and the tension is decisive. Mammoth's output is HTML.
Its documented philosophy is to map to semantics and discard presentation: table formatting
such as borders "is currently ignored", and fonts, text size, and colours are "generally
ignored in favor of semantic mapping" (verified from Mammoth's documentation, 2026-07-29).

Routing DOCX → HTML → IR therefore produces an empty style sidecar, which makes §4.2 vacuous
and reduces §5.3 heading inference to what the reference project already does — the exact
limitation brief §1 lists as the gap we are filling.

> **Guarded since 2026-07-31 by a differential test against Mammoth**
> (`scripts/diff-mammoth.mjs`, triage in [MAMMOTH-DIFF.md](../MAMMOTH-DIFF.md)). The design
> argument below is unchanged; what was missing was evidence about the accumulated edge cases
> Mammoth encodes and a fresh reader does not. Both readers now run over the corpus and every
> divergence is classified. It found one real bug on its first run — an undefined `Heading4`
> style id that Mammoth recovered and our inference rules dropped — and confirmed that every
> other divergence is this ADR's thesis working.

## Decision

The DOCX adapter **reads OOXML directly** and does not route through Mammoth or HTML.

Parts read: `word/document.xml`, `styles.xml`, `numbering.xml`, `theme1.xml`, `settings.xml`,
`footnotes.xml`, `endnotes.xml`, `comments.xml`, `commentsExtended.xml`, `header*.xml`,
`footer*.xml`, `_rels/*`, `docProps/*`, and media.

The core of it is an explicit **style cascade resolver** matching Word's precedence:

```
docDefaults → style chain via w:basedOn (root first) → table conditional formatting
  → numbering level properties → paragraph mark properties → direct run properties
```

Theme font tokens (`+mn-lt`, `+mj-lt`, …) are resolved against `theme1.xml`, so
`font.family` in the sidecar is always a real font name. Each resolved value records the
innermost cascade level that supplied it, which is how `origin: "directFormatting"` — the
signal that heading inference is needed — gets detected at all.

The zip-plus-XML reader, part/relationship graph, cascade machinery, and unit conversion live
in a shared `@markforge/ooxml` package used by the DOCX, XLSX, and PPTX adapters, since
SpreadsheetML and PresentationML are the same family.

Mammoth stays in the repository as a **benchmark baseline** for the `docs/FIDELITY.md`
scoreboard, not as a dependency of the parse path.

## Rejected alternatives

**Mammoth → HTML → IR, i.e. brief §5.2 as written.** Fastest route to Phase 1 and gives
parity with the reference project. Rejected because parity is not the goal: it leaves the
§4.2 sidecar empty, so §5.3 heading inference has nothing to cluster and template-faithful
DOCX rendering has nothing to resolve. It would reproduce the limitation the project exists
to remove.

**Mammoth's `transformDocument` hook.** Closer: it exposes an internal element model where
paragraphs carry `styleId` and `styleName`, with `mammoth.transforms.paragraph`,
`mammoth.transforms.run`, and `getDescendantsOfType` helpers. Rejected for two reasons. It is
documented as unstable, so we would pin a private API in a core code path. More importantly
it is still insufficient: `styleName` without the resolved cascade is not enough, because
inference needs effective point size after `docDefaults` → style chain → direct formatting,
and font family after theme resolution. Mammoth computes neither.

**Hybrid: Mammoth for body traversal, our own readers for `styles.xml` / `numbering.xml` /
`theme1.xml`, joined by `styleId`.** Genuinely reasonable, and it was the closest call.
Rejected because it means two parse layers whose models must be kept consistent, and because
Mammoth's AST has already discarded some of what we would want to join against — so the join
would be lossy in ways that are hard to detect. Once we are reading three of the four parts
ourselves, reading the fourth removes a dependency instead of adding a seam.

**Depending on `xlsx` or `exceljs` for the spreadsheet path instead of extending our
reader.** Rejected on maintenance grounds: `xlsx@0.18.5` on npm dates from 2022-03-24 and
`exceljs@4.4.0` from 2023-10-19, and brief §13 makes maintenance a selection criterion. With
both stale, sharing one OOXML core across three adapters is the better answer anyway.

## Consequences

- Significantly more work than the brief's route: we own the OOXML reading, the cascade, and
  the edge cases Mammoth has already absorbed over a decade. This is the accepted cost, and
  it is concentrated in one shared package.
- We inherit responsibility for OOXML quirks: `w:altChunk`, `mc:AlternateContent` fallbacks,
  vertical merge continuation cells, `w:lvlOverride` indirection, RTL and bidi runs. The
  golden corpus (`CORPUS.md`) is designed to cover these, and anything unhandled produces an
  `unknown` node plus a lossy diagnostic rather than silent corruption.
- The style-map *concept* from Mammoth is still adopted: DOCX style mapping is declarative
  and selector-based, expressed in the config profile rather than in code.
- One reader core serves three adapters, which is brief §3.2's "one adapter, not N
  converters" applied one level deeper than the brief asked for.
- Because Mammoth remains present as a benchmark, the scoreboard will show directly whether
  this decision paid off. If it did not, that will be visible in numbers rather than argued.
