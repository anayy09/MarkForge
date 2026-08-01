# ADR-0010: Fidelity baselines and the CI regression gate

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §3.4, §10, §11; `SPEC.md` §9
- Enforced by: scripts/run-fidelity.mjs

## Context

Brief §3.4 makes fidelity "a numeric metric in CI with a baseline that cannot regress", and
brief §10 requires storing baselines, failing CI on regression, and publishing a scoreboard in
`docs/FIDELITY.md` that includes competing tools on the same corpus — being honest where we
lose.

## Decision

**`fidelity/baselines.json`**, committed: one record per `(fixture, loop, metric)` with the
recorded score, the toolkit version that produced it, and the metric definition version.

CI recomputes every score and fails (exit 4) on any drop beyond `fidelity.tolerance`
(default 0.005). Improvements do **not** auto-update: raising a baseline requires an explicit
commit to `baselines.json`, so every score change is visible in review.

`docs/FIDELITY.md` is **generated**, not written, and includes columns for
`word-to-markdown-js`, Pandoc, and markitdown on the same corpus. The generator has no
mechanism to omit a row or a column — honesty is enforced by the absence of a suppression
feature rather than by discipline.

`@markforge/fidelity` is a published package, not test-suite code, because brief §3.4 makes
fidelity a product capability reachable from `markforge check` and `markforge diff`.

Metric definitions are versioned. Changing a definition changes `metricVersion` and requires
recomputing all baselines in the same commit, so a score is never compared against a number
computed by different rules.

## Rejected alternatives

**Assertion-based tests only** ("this DOCX converts to this exact Markdown"). Rejected by
brief §3.4. Exact-output assertions are brittle in a different way from metrics: they fail on
cosmetically irrelevant changes and, worse, they cannot answer "did this change make
conversion better or worse", which is the only question that matters when tuning inference.
Golden-file assertions are still used, but for determinism, not for quality.

**Auto-updating baselines on improvement.** Convenient. Rejected: it hides the moment a score
changed, and a metric that silently drifts upward can mask a regression on one fixture behind
gains on others. Explicit updates keep the history readable.

**A single aggregate fidelity score.** Attractive for a README badge. Rejected: it averages
away exactly the information needed to act. `SPEC.md` §9 deliberately reports
whitespace-sensitive and -insensitive text scores separately, and full-cell versus
content-only table F1 separately, because the gap between each pair localizes the defect.

**Omitting competitor columns, or publishing only favourable ones.** Rejected by brief §10.
The credibility of the whole project rests on this table being trustworthy, and a scoreboard
that can hide a loss is worth less than no scoreboard.

**A tolerance of zero.** Tempting for a project claiming determinism. Rejected: tree edit
distance normalization and grapheme-level edit distance involve floating-point arithmetic, so
a strict zero tolerance would produce platform-dependent flakes. 0.005 is loose enough to
absorb float noise and tight enough that a real regression cannot hide in it. Note this
tolerance applies to *quality metrics*; byte-identical output determinism (brief §3.1) is
tested separately and has no tolerance at all.

## Consequences

- Adding a fixture requires computing and committing its baselines, so fixtures cannot be
  added without being measured.
- Running competitors in CI means Pandoc and markitdown in the CI image. Both are isolated to
  the scoreboard job and are not dependencies of the toolkit, consistent with brief §13.
- The scoreboard will publicly show where we lose, particularly on scanned PDFs against
  marker's published olmocr-bench numbers (`PRIOR_ART.md` §4). That is the intended outcome.
- Visual regression snapshots are stored separately from numeric baselines, since they need
  perceptual thresholds and human approval rather than a scalar comparison.
