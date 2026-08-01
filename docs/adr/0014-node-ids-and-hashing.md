# ADR-0014: Node ids and content hashing

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §3.7, §6.2; `SPEC.md` §2.7; ADR-0002
- Enforced by: packages/ir/test/node-id.test.ts

## Context

ADR-0002 puts style evidence and provenance in id-keyed side tables, which makes node ids
load-bearing. Brief §6.2 additionally requires that when one source document changes, only
affected sections regenerate, that every unit be content-hashed, and that output be
diff-friendly and stable in ordering so `git diff` shows only the real change.

Those two requirements pull in different directions and the tension has to be resolved
explicitly: a join key wants stability, while change detection wants ids to move when content
moves.

## Decision

**Two distinct values**, because identity and change-detection are different jobs.

**`NodeId`** — the join key, computed bottom-up:

```
localDigest(node) = sha256(canonicalJson({
    type, salientAttrs(node), children: children.map(c => c.nodeId)
}))
NodeId = "n_" + base32lower(localDigest).slice(0, 20) + ":" + occurrence
```

`salientAttrs` is a per-type allowlist declared alongside the schema. It excludes `position`,
excludes `id` itself, and excludes anything derived from the sidecar, so an id depends only on
semantic content. `occurrence` is a 0-based counter, assigned in document order, disambiguating
nodes whose digest collides within one document.

**`contentHash`** — hex `localDigest`, on the document and on any node where a consumer needs
change detection. Used by agentify and the fidelity cache.

**Canonical JSON** for all hashing and for the `.mfir.json` form: UTF-8, NFC normalization of
strings, keys sorted by Unicode code point, no insignificant whitespace, shortest round-trip
number form, absent keys omitted rather than set to null.

## Rejected alternatives

**Positional path ids** (`/body/children/3/children/1`). Stable under content edits, trivially
computed, human-readable. Rejected because they renumber every following sibling on insertion,
and insertion is the more common editing operation in a document. Under path ids, adding one
paragraph near the top of a source document invalidates the ids of everything below it, so
brief §6.2's minimal-diff requirement fails on the most ordinary edit.

**Random UUIDs.** Trivially unique. Rejected outright: they violate brief §3.1's
byte-identical-output requirement, since two runs on identical input would produce different
documents.

**Sequential counters** (`n1`, `n2`, …). Deterministic and compact. Rejected for the same
reason as path ids — they shift on insertion — with the extra downside of carrying no
information.

**Content hash alone, without the occurrence counter.** Cleanest formulation. Rejected because
genuinely identical content is common and legitimate: two `Yes` cells in a table, two identical
`---` separators, a repeated boilerplate paragraph. Without a disambiguator the side-table join
would silently merge distinct nodes, which is a data-corruption bug rather than a collision
inconvenience. The counter is ugly and necessary.

**Including `position` in the digest.** Would make ids unique without a counter. Rejected: it
couples ids to source byte offsets, so reformatting the source with no semantic change would
churn every id — the opposite of what brief §6.2 needs.

**A single value serving as both id and change hash.** Rejected: the id must be stable enough
to join against within a run, while change detection needs to compare across runs. Keeping them
separate costs one field and makes both jobs simple.

## Consequences

- An edit to paragraph 40 changes the ids of paragraph 40 and its ancestors, and nothing else —
  not paragraph 41, not its siblings. That property is the whole point, and it is what makes
  agentify's incremental regeneration produce a one-region `git diff`.
- Ancestor ids changing on any descendant edit means the root id changes on every edit. That is
  correct — the root's content did change — and is why `contentHash` exists separately for
  coarse comparison.
- 20 base32 characters is 100 bits, so accidental cross-document collisions are not a concern;
  the counter handles the in-document case, which is deliberate rather than accidental.
- `salientAttrs` becomes part of the IR contract: changing the allowlist changes every id, so it
  is versioned with the schema and a change is a breaking IR change.
- Canonical JSON must be implemented once, in `@markforge/ir`, and used by hashing,
  serialization, and the LLM cache key alike. Three implementations would drift.
