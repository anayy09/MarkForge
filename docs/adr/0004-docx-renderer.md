# ADR-0004: DOCX renderer — `docx` + reference document + Pandoc style names

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §5.1, §5.4; `SPEC.md` §4.2
- Enforced by: scripts/build-reference-templates.mjs

## Context

Brief §5.1 diagnoses the user-visible complaint precisely: generators emit inline run
properties per run instead of resolving to named styles, so changing a heading font means
touching every heading, and mixed theme defaults produce "uneven fonts". The prescribed fix
is named styles only, rendered into a user-supplied reference document.

## Decision

Three parts.

**Writer: `docx` (dolanmiu), 9.7.1, MIT, published 2026-05-27.** Actively maintained, typed,
browser-capable, supports named styles and numbering definitions programmatically.

**Named styles only.** Every block maps to a named paragraph style. Inline formatting is
emitted only for genuine inline semantics: `strong`, `emphasis`, `inlineCode`, `subscript`,
`superscript`, `delete`, `underline`, `smallCaps`, `highlight`. A heading may not carry
direct font properties. Enforced by config (`docx.namedStylesOnly`, default true) and by a
renderer assertion, not by developer discipline.

**Reference document.** The user supplies a `.docx`/`.dotx`; we resolve IR roles onto the
style ids already defined there and copy its `styles.xml`, `theme1.xml`, `numbering.xml`,
and section properties verbatim.

**Role → style name uses Pandoc's vocabulary verbatim**: `Normal`, `Body Text`,
`First Paragraph`, `Compact`, `Title`, `Subtitle`, `Author`, `Date`, `Heading 1`–`Heading 9`,
`Abstract`, `AbstractTitle`, `Bibliography`, `Block Text`, `Footnote Block Text`,
`Source Code`, `Footnote Text`, `Definition Term`, `Definition`, `Caption`,
`Table Caption`, `Image Caption`, `Figure`, `Captioned Figure`, `TOC Heading`; character
styles `Default Paragraph Font`, `Verbatim Char`, `Footnote Reference`, `Hyperlink`,
`Section Number`; table style `Table`.

## Rejected alternatives

**Inventing our own style-name vocabulary.** Cleaner names were available. Rejected because
adopting Pandoc's list means **any existing Pandoc reference document works with MarkForge
unchanged** — a large interoperability win for one paragraph of specification, in a
population of users who already have reference docs.

**Raw OOXML templating with placeholder substitution.** Full control. Rejected: it is
string manipulation of XML, which brief §3.2 bans in the core, and it makes structural
output (nested lists with correct numbering) very hard.

**`docxtemplater`.** Mature and good at its job. Rejected: it is a mail-merge tool, designed
to fill placeholders in a fixed template, not to generate arbitrary document structure. The
shape of our problem is the opposite.

**LibreOffice or Word automation.** Rejected by brief §13 (no hard LibreOffice dependency)
and by brief §3.1 — shelling out to an office suite is neither deterministic nor
browser-capable.

**Emitting direct formatting to guarantee visual fidelity.** This is what current tools do,
and it does make the first render look right. Rejected because it *is* the bug in brief
§5.1: the output is unmaintainable, and "changing a heading font requires touching every
heading" is the complaint we exist to fix.

**Redistributing a publisher manuscript template as the shipped default.** The reviewer asked
for "legit publicly available templates... since they are usually well formatted and cover all
the cases", supplied the **IEEE conference proceedings template** as the starting point, and
the reasoning is sound — this is why `academic-manuscript.docx` is the primary template and the
Phase 1 gate, and why it is structurally modelled on that file (`TEMPLATES.md` §2.1).

Rejected only on redistribution, on a verified rather than assumed basis: **IEEE publishes the
conference templates for authors preparing IEEE submissions and grants no redistribution
right.** The same holds for the alternatives — MDPI's CC BY covers published *articles*, not
the blank `.dot` template file, a distinction that is easy to get wrong in exactly this
direction. Shipping any of them inside an Apache-2.0 package (ADR-0008) would put an
unrecorded licence assumption into an artifact reaching every user.

**The intent is honoured without the file.** Three things make the deviation cost nothing:
our authored template reproduces the IEEE template's structure and adds the constructs it
lacks; `docx.referenceDoc` accepts the user's own downloaded copy for publisher-exact output;
and `docs/TEMPLATES.md` §3.1 ships a ready-made `styleMap` for the IEEE template, measured
against the real file, so using it is an edit rather than an investigation. The local copy
lives in gitignored `fixtures/local/`.

## Consequences

- A reference document is effectively required for good output. We ship three authored,
  Apache-2.0 defaults — `clean-report`, `academic-manuscript`, `technical-documentation` —
  and `docx.onMissingStyle` (`warn` | `error` | `synthesize`) decides behaviour when a role
  has no matching style.
- **Authoring `academic-manuscript.docx` well is real work**, not a placeholder task: it must
  define the full style vocabulary above, multi-level numbering, and equation and caption
  styles, or the Phase 1 gate tests less than it appears to. It is the one shipped asset whose
  quality directly bounds measured fidelity. `TEMPLATES.md` §2.1 specifies it row by row so
  Phase 1 has nothing left to decide.
- **The Pandoc-vocabulary claim needed narrowing.** Measuring the IEEE template found it
  defines **8 of the 38 Pandoc names** (`SPEC.md` §4.2.2). "Any Pandoc reference document works
  unchanged" is still true and still worth having, but Pandoc reference documents are a narrow
  population, and an arbitrary publisher template is not one. Consequences: `docx.styleMap` is
  the *primary* mechanism for third-party templates rather than an edge case,
  `check --reference-doc` must emit a `styleMap` skeleton, and `onMissingStyle: "synthesize"` is
  a common path whose output quality matters more than "rare fallback" implied — a synthesized
  style must derive from the reference document's `docDefaults` and nearest `basedOn` ancestor,
  never from hardcoded defaults.
- `docs/TEMPLATES.md` links publisher templates rather than copying them, and must be
  maintained as those download URLs change — a small ongoing cost, and the price of not
  redistributing.
- Some IR constructs have no natural named style (admonitions, for instance). These are
  mapped through the configurable `docx.styleMap` with a documented default, and a missing
  mapping is reported rather than silently inlined.
- **Open risk to settle in Phase 1:** whether `docx` can write a document that *references*
  style ids defined in the reference package without redefining them. If it cannot, we merge
  our body part into the reference package ourselves using the OOXML writer that is the
  inverse of ADR-0005's reader. This is a known, scoped fallback rather than a surprise.
