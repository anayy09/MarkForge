# ADR-0006: Markdown renderer and the idempotency guarantee

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §5.4, §3.5, §10; `SPEC.md` §4.1
- Enforced by: scripts/check-markdown-lint.mjs

## Context

Brief §5.4 specifies deterministic `remark-stringify` plus markdownlint autofix, with
flavour profiles as data-driven presets, exposed as a standalone `markforge fmt`. Brief §3.5
requires `f(f(x)) == f(x)` for any normalizing operation, property-tested rather than
assumed. Brief §2 also lists `prettier` as a candidate for deterministic normalization.

## Decision

A single generator, then a **gate**, in a fixed order:

1. `remark-stringify` with a fully pinned option set from the flavour preset, configured so
   its output already satisfies the lint rule set.
2. `markdownlint` in **check-only** mode, in CI. A violation is a build failure meaning the
   stringify configuration has drifted — it is never repaired after the fact.
3. Re-parse and compare trees; a semantic difference is an error, not a warning.

### Amended 2026-07-31: the autofix loop is gone

This decision originally read *"`markdownlint` autofix applied to a fixed point, with
`maxIterations` (default 8); reaching the cap is an error"*, and `OPEN_QUESTIONS.md` §8
listed "is the pipeline genuinely idempotent, or does a fixed point need iteration?" as a
question only running code could answer.

It turned out to be the wrong question. The reviewer asked whether the iteration was
avoidable *by construction*, and it is. Two tools that can disagree — about emphasis
markers, list bullets, line wrapping — can each undo the other, and that mutual undoing is
the only reason a fixed point was ever in doubt. Remove the second author and the property
follows from `stringify` being a pure function of the tree. There is no loop, so there is no
cap, so there is nothing to oscillate and nothing to detect.

**Measured before adopting it** (`scripts/check-markdown-lint.mjs`): 34 rendered files,
**zero violations**, no autofix pass. Five rules are disabled, and every one conflicts with
a decision recorded elsewhere rather than being a rule the configuration could not meet:
`MD013` line length (ADR-0006's own no-reflow rule, below), `MD024`/`MD025`/`MD041` (all
properties of the *source* document, which a formatter may not rewrite), `MD033` inline HTML
(required by SPEC §4.1's table degradation policy), and `MD040` fenced-code language (a
formatter cannot invent one).

`MD029` is the exception worth recording, because it is a genuine conflict rather than a
category error. It wants every ordered list renumbered to start at 1. The IR carries
`restartsAt` precisely so a list starting at 7 survives a round trip — DOCX and HTML both
express it, and losing it is measurable fidelity loss. Our requirement wins and the rule is
off.

The cost of being wrong here is small and symmetric: if a flavour preset is ever added whose
rule set stringify genuinely cannot satisfy, the gate fails loudly and the autofix pass can
come back for that preset. That is a better failure than a silent 9th iteration.

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

**~~markdownlint as a gate rather than a repair pass.~~ Adopted 2026-07-31 — see the
amendment above.** Originally rejected on the grounds that it "pushes the work onto the user
for defects our own generator introduced, and brief §5.4 explicitly wants autofix." Both
halves turned out to be wrong in practice. The first assumed there would be defects to push:
measured, there are none, because the generator is configured to satisfy the rules rather
than to be corrected afterwards. The second reads brief §5.4 too literally — it asks for
lint-clean deterministic output, and autofix was its proposed means, not its requirement.
Getting the same output without a second authority in the pipeline satisfies the intent
better than obeying the letter would.

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
