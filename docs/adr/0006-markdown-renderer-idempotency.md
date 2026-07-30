# ADR-0006: Markdown renderer and the idempotency guarantee

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §5.4, §3.5, §10; `SPEC.md` §4.1

## Context

Brief §5.4 specifies deterministic `remark-stringify` plus markdownlint autofix, with
flavour profiles as data-driven presets, exposed as a standalone `markforge fmt`. Brief §3.5
requires `f(f(x)) == f(x)` for any normalizing operation, property-tested rather than
assumed. Brief §2 also lists `prettier` as a candidate for deterministic normalization.

## Decision

A single generator, then a repair pass, in a fixed order:

1. `remark-stringify` with a fully pinned option set from the flavour preset.
2. `markdownlint` autofix applied to a fixed point, with `maxIterations` (default 8).
   Reaching the cap is an **error**, not a silent stop.
3. Re-parse and compare trees; a semantic difference is an error, not a warning.

Flavour presets are data: CommonMark, GFM, MDX, Docusaurus, MkDocs Material, Obsidian,
Pandoc. A preset declares available syntax (footnote form, math delimiters, admonition
syntax, table style, front-matter language) plus a `remark-stringify` option set. No flavour
logic lives in code.

`markdown.lineWidth` defaults to `0`, meaning never reflow.

The idempotency proof obligation is discharged by: (a) `stringify` is a total function of the
tree; (b) `parse(stringify(t))` is tree-equivalent to `t` under the flavour's normalization,
property-tested by round-tripping generated trees rather than only fixtures; (c) autofix
reaches a fixed point within the cap.

## Rejected alternatives

**Prettier in the pipeline** (either instead of or after `remark-stringify`). Rejected: two
formatters with overlapping opinions is exactly how the idempotency property is lost —
`A(B(x))` and `B(A(x))` differ, and neither is a fixed point of the other. Prettier's
Markdown behaviour is instead treated as a *conformance target* for one flavour preset, so
`markforge fmt` output can be Prettier-stable for teams that run both. That gets the
compatibility benefit without putting two authorities in one pipeline.

**markdownlint as a gate rather than a repair pass.** Simpler and avoids the fixed-point
question entirely: generate, then fail if lint complains. Rejected because it pushes the work
onto the user for defects our own generator introduced, and brief §5.4 explicitly wants
autofix.

**Reflowing prose to a line width.** Produces prettier source. Rejected because it destroys
diff stability: editing one word reflows a paragraph and the `git diff` shows the whole
block. Brief §6.2 requires that a source edit produce a minimal diff, and that requirement
wins. Available as a non-default option.

**Turndown for any HTML-shaped input.** Rejected in `PRIOR_ART.md` §9: HTML-intermediate
paths discard the style sidecar, and `turndown-plugin-gfm` was last published 2018-05-11.

**Letting the autofix loop stop silently at the cap.** Rejected: a non-converging fixer means
`fmt` is not idempotent, which is a correctness bug in a tool whose selling point is
determinism. Better to fail loudly with the oscillating rule named.

## Consequences

- `markforge fmt` is a standalone product with a real guarantee, which brief §5.4 correctly
  identifies as valuable on its own.
- Flavour support is a data contribution, so adding MkDocs or Obsidian support does not
  require touching the renderer.
- A construct expressible in the IR but not in the target flavour (tracked changes in
  CommonMark, multi-row table headers in GFM) produces a lossy diagnostic per renderer rule
  R3, so degradation is reported rather than silent.
- The autofix cap can in principle fire on a pathological document. That is a bug report with
  a reproducible fixture attached, which is the outcome we want.
