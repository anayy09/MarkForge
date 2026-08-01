# ADR-0001: IR foundation — extended mdast

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §4, `SPEC.md` §2, ADR-0002
- Enforced by: scripts/check-schemas.mjs

## Context

Brief §4 calls the IR "the single most important design decision in the project" and
recommends extending `mdast` while noting the IR must carry three things mdast does not: a
richer semantic tree, style evidence, and provenance.

Verified against the mdast specification (2026-07-29), mdast has 18 core node types plus 6
GFM types plus frontmatter. It explicitly does not model whitespace preservation, concrete
syntax, comments, table cell spans, math, admonitions, tracked changes, captions bound to
figures, cross-references, definition lists, or any styling information.

## Decision

The semantic tree is **mdast-compatible and extended**: mdast node names, `children`
arrays, and the unist `position` convention are used unchanged, with 24 new node types and a
small set of added fields (`SPEC.md` §2.3). Style evidence and provenance are **not** in the
tree; see ADR-0002.

The schema is authored as JSON Schema (`packages/ir/schema/ir.v0.schema.json`) and
TypeScript types are generated from it with `json-schema-to-typescript`. Hand-written type
duplicates are forbidden, because two definitions of one contract always diverge.

Published as its own package, `@markforge/ir`, so third parties can write adapters against
it (brief §4).

## Rejected alternatives

**A bespoke document tree.** Maximum design freedom and no legacy compromises. Rejected
because it discards `remark-stringify`, `remark-gfm`, `unist-util-visit`, `remark-directive`,
and every third-party `unified` plugin, all of which we would then reimplement. The freedom
buys nothing we need: mdast is extensible, and the extensions are additive.

**`hast`.** Rejected: hast has five node types and models markup, not documents. Heading
level in hast is a tag name; in our IR it is a resolved semantic level carrying confidence
and evidence. Choosing hast would force re-deriving semantics on every render. It is still
the right *parse target* inside the HTML adapter.

**Pandoc's AST.** Well-proven across more formats than anything else, and worth studying.
Rejected as our IR: no TypeScript ecosystem, no JS tooling, and it has the same gap as
mdast — no styling evidence, no provenance — so we would extend it anyway while gaining no
library reuse.

**docling's `DoclingDocument`.** The best existing provenance-aware model, and three of its
ideas were adopted (see ADR-0002). Rejected as a foundation because it is Pydantic/Python
and brief §13 rules out a non-JS core. Adopting the ideas costs nothing; adopting the
runtime costs the whole platform.

**Extending mdast by overloading existing types** — e.g. modelling admonitions as
`blockquote` with a `data` field, the common remark-ecosystem practice. Rejected because it
makes every consumer parse conventions out of `data` bags, and because a renderer cannot
tell "a blockquote" from "an admonition that happens to be encoded as one", which is
precisely the semantic loss the project exists to prevent.

## Consequences

- We inherit the `unified` ecosystem for free, including a mature Markdown stringifier.
- `heading.depth` must stay within mdast's legal 1–6 for `remark-stringify` compatibility,
  so `resolvedLevel` carries semantic levels 7–9 separately. Slight redundancy, checked by
  an invariant (`depth === min(resolvedLevel, 6)`) in the validator.
- Third-party mdast plugins operating on our tree will encounter unknown node types. The
  IR package therefore ships a `downcast()` helper producing a strictly-mdast tree with
  extensions lowered or dropped, and every drop emits a diagnostic.
- Schema-first means a schema change regenerates types, so a breaking IR change cannot be
  made silently in TypeScript alone.
