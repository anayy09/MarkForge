# ADR-0021: Markdown flavour presets are built, as data, and gated on distinctness

- Status: **Accepted**
- Date: 2026-08-01
- Relates to: `SPEC.md` §4.1, brief §5.4; `CORPUS.md` §2.13
- Enforced by: scripts/check-flavor-distinctness.mjs

## Context

`SPEC.md` §4.1 states, in the present tense, that flavour presets are **data**: CommonMark,
GFM, MDX, Docusaurus, MkDocs Material, Obsidian, Pandoc, each declaring available syntax and a
`remark-stringify` option set, with *"nothing about a flavour lives in code"*.

`schema/markforge.config.v0.schema.json` has enumerated those seven values since Phase 0. They
are generated into `packages/core/src/generated/config.ts`. **Nothing read them.** Setting
`flavor: "commonmark"` produced GFM, silently.

This was found in Phase 6 while trying to close `CORPUS.md` §2.13, whose target was "every
flavour `SPEC.md` §4.1 names". Authoring seven fixtures against a setting nothing reads would
have produced seven files that round-trip identically — a fixture set that passes while
measuring nothing, which is the trap ground rule 2 exists for.

It is worse than an unbuilt feature. An unbuilt feature is absent; this one was *advertised*.
A JSON-schema-aware editor autocompletes `flavor` from the config schema, so a user could
select a value, see it validate, and get output that ignored it.

## Decision

**Build the presets as data** in `packages/render-md/src/flavors.ts`, and gate them on
**distinctness** rather than on coverage.

A preset declares two separable things:

- `syntax` — which constructs the flavour can express *at all*. `render-md` reads this to
  decide whether to emit or to degrade-and-diagnose.
- `stringify` — how it spells the ones it can. Presentation only, never capability.

**The gate is that seven presets produce seven byte-distinct renders** of one construct-dense
document (`fixtures/md/flavor-probe.md`: front matter, a footnote, inline and display math, an
admonition, a table). A preset that ties with another is not a flavour, it is a duplicate name
implying a distinction that does not exist, and it is struck rather than kept.

That converts the trap into a pass/fail. Seven files agreeing is indistinguishable from seven
files being ignored; seven files *differing* cannot be produced by a setting nothing reads.

**CommonMark carries a second job.** It genuinely cannot express a footnote, and every other
no-silent-loss check in this repository runs against a target that can hold the construct and
merely spells it differently. This is the first that runs against one that cannot, so the gate
asserts the diagnostic and the retention, not only the bytes.

## Rejected alternatives

**Strike flavours from `SPEC.md` §4.1 and the config schema, shipping `gfm` only.** Smaller,
honest, and genuinely tempting mid-phase. Rejected because §4.1 is normative and the option is
already public in a published schema: removing it is a breaking change to a documented
interface, while building it is additive. The strike would also have removed the one target
(CommonMark) that can exercise no-silent-loss against a genuinely incapable format.

**Leave `markdown.flavor` in the schema and unimplemented, documenting it as reserved.** The
worst option and the one that required no work, which is why it is written down. A setting that
validates and does nothing is a lie with a schema behind it.

**Presets as code — a module per flavour with an `emit()` function.** More expressive; a
flavour with genuinely odd assembly could do anything. Rejected by §4.1's own words, and by the
same argument ADR-0013 makes for target profiles: a convention that changes on someone else's
timeline should be editable by someone who does not write TypeScript.

**Gate on coverage — one fixture per flavour, asserting each renders.** The obvious reading of
§2.13's "every flavour SPEC §4.1 names", and vacuous: all seven would have passed before any of
this existed.

## Consequences

- Adding a flavour is an entry in `flavors.ts` plus a passing distinctness check. No renderer
  change unless the flavour needs a spelling nothing else uses.
- `resolveFlavor` **throws** on an unknown id rather than falling back to GFM. A silent
  fallback is precisely how the setting spent five phases doing nothing.
- Four defects surfaced while building it, all found by the gate rather than by review:
  `strong: "**"` is not a legal option value (it names a character, not a delimiter); a block
  `math` node degraded to an *inline* node collapsed an entire document onto one line and still
  passed distinctness, which is why section 1 now has a length floor; a capability check placed
  at the end of a shared `case` group was reached by every label in that group, including
  `root`; and the Markdown adapter never produced an `admonition` node at all, so three presets
  differed only in how they spelled a type nothing created.
- That last one is a second fix this ADR carries: `@markforge/adapters-md` now reads GFM alert
  syntax (`> [!NOTE]`) back into an `admonition`. `render-md` had emitted that shape since
  Phase 2 and nothing read it, so an admonition round-tripped to a blockquote and the type was
  destroyed on every loop.
- GFM alerts are upper-case (`[!NOTE]`) and Obsidian callouts are lower-case (`[!note]`); each
  renderer ignores the other's casing. Treating them as one spelling made the two presets
  byte-identical, and the gate reported it.
- `docs/LIMITS.md` records what the fenced admonition forms cannot carry: a list inside a
  `:::note` loses its markers, because those forms are emitted as raw blocks.
