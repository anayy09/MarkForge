# ADR-0002: Provenance and style evidence as id-keyed side tables

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §4.2, §4.3, §3.7; `SPEC.md` §2.2, §2.4, §2.5; ADR-0001, ADR-0014
- Enforced by: scripts/check-schemas.mjs

## Context

Brief §4.2 requires a style provenance sidecar — evidence about styling, keyed by node id —
and §4.3 requires per-node provenance. The open question is where these live: inline on
each node, or in separate tables on the document envelope.

## Decision

Both live in **id-keyed side tables** on the document envelope: `document.sidecar` and
`document.provenance`, both `Record<NodeId, ...>`. Every node carries `id`, which is the
join key. Running headers, footers, and page numbers similarly live in a separate
`document.furniture` array rather than in the body tree.

All lengths in the sidecar are normalized to points, and every `BBox` declares its
coordinate `space` and `origin`.

## Rejected alternatives

**Inline fields on each node** (`node.style`, `node.provenance`). The obvious approach.
Rejected on three counts. It breaks mdast compatibility, because a third-party `unified`
plugin that reconstructs nodes will drop unknown fields and silently destroy provenance —
and silent provenance loss is the failure mode this project is built to prevent. It couples
the semantic tree to extraction concerns, so a consumer that only wants Markdown semantics
must skip over evidence it does not care about. And it makes the tree unusable as a
comparison target, because the fidelity metrics of `SPEC.md` §9 need to compare semantics
with evidence excluded, which is trivial with side tables and requires a stripping pass
without them.

**A parallel tree mirroring the body's shape.** Rejected: the two trees drift the moment
any transformation runs, and there is no way to detect the drift. A flat map keyed by a
content-addressed id cannot drift — a stale key is an absent key.

**Provenance as a separate sidecar file only** (not part of the document object). Rejected:
it makes provenance optional in practice, and brief §3.7 requires it everywhere. It stays
in the document and is serialized with it; splitting to a separate file is an output option,
not a model decision.

**Dropping headers and footers**, which is what brief §5.2's "header and footer stripping"
literally describes. Rejected as written because it violates brief §3.3's no-silent-loss
principle. They are *routed* to `furniture` instead, which satisfies both. The idea is taken
from docling's `furniture` root and Unstructured's first-class `Header`/`Footer`/
`PageNumber` types (`PRIOR_ART.md` §3, §5).

**Leaving bbox units implicit.** Rejected after seeing Unstructured declare coordinate
systems explicitly: PDF is bottom-left origin in points, rasterized output is top-left in
pixels, and an unlabelled bbox mixes them silently. The two extra fields cost nothing.

## Consequences

- Node ids become load-bearing, which is why ADR-0014 specifies them carefully.
- A transformation that replaces nodes must migrate side-table entries. The IR package
  therefore owns the transformation helpers, and `provenance.derivedFrom` records the
  lineage so a report can explain why a node changed.
- The validator can check join completeness mechanically: every node id present in
  `provenance`, no orphan keys in either table. This is enforced in the Phase 0 example
  check and becomes a Phase 1 test.
- Serialized documents are larger than the tree alone. Acceptable: the sidecar is the
  product's differentiator, and `.mfir.json` is an intermediate artifact, not a shipping
  format.
