# ADR-0008: License — Apache-2.0

- Status: **Confirmed by reviewer**
- Date: 2026-07-29
- Relates to: brief §0 (expensive-to-reverse decisions), `PRIOR_ART.md` §1

## Context

Brief §0 lists the license as a decision expensive enough to reverse that it should be
raised rather than assumed. The reference project, `benbalter/word-to-markdown-js`, is
Apache-2.0. Brief §4 wants third parties writing adapters against the IR, which makes
contributor-friendliness a functional requirement rather than a preference.

## Decision

**Apache-2.0** for all packages in the monorepo.

Fixture licensing is a separate matter with its own rules; see `CORPUS.md`. Fixtures are not
covered by the project license and each one records its own.

## Rejected alternatives

**MIT.** Shortest text, broadest familiarity, maximum adoption. Rejected because it carries
no patent grant, and this project implements OOXML and PDF handling — format territory with a
long history of patent claims. Apache-2.0's explicit grant and its patent-retaliation clause
are worth the extra length for a document-format toolkit specifically.

**AGPL-3.0 with a commercial exception.** Would keep a hosted-SaaS offering exclusive.
Brief §13 says SaaS is out of scope but should not be precluded, so this was a real option.
Rejected: AGPL would deter the third-party adapter contributions that brief §4 treats as a
design goal, and it blocks adoption at most companies, which is where messy DOCX and PDF
files actually live. The strategic option value is not worth the ecosystem cost.

**Split licensing** — Apache-2.0 for `ir`, `adapters-*`, and `render-*`; source-available for
`cli`, `http`, and `mcp`. Rejected: more licensing surface to maintain, confusing for
contributors, and the boundary would need policing on every PR. The complexity buys a
protection nobody has asked for.

## Consequences

- `LICENSE` at the repository root; `license: "Apache-2.0"` in every `package.json`; a
  `NOTICE` file listing attributions.
- Dependency licence compatibility is checked in CI. All currently selected dependencies are
  MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or ISC, which are all compatible.
- Two consequences already recorded elsewhere follow from this choice:
  `marker`'s model weights (modified AI Pubs Open RAIL-M, with a revenue threshold) cannot be
  a dependency, so marker is BENCHMARK not STEAL (`PRIOR_ART.md` §4); and `jszip`'s dual
  MIT/GPL-3.0-or-later licence is an avoidable complication, so `fflate` is used instead.
- **Institutional constraints: none applicable.** The reviewer confirmed on 2026-07-30 that
  this is personal, non-commercial work, so no UF IP review is required. Recorded because the
  premise is what makes it true: if the project later becomes commercial, or is used in funded
  research, that assumption expires and the question reopens. Apache-2.0 is a permissive
  outbound licence, so a later change of status does not retroactively taint anything already
  released — but a *relicensing* would need every contributor's agreement, which is the reason
  to note the boundary now rather than discover it later.
- Third-party licence discipline is unaffected by the non-commercial framing: several
  dependency licences (`marker`'s RAIL-M revenue threshold, AGPL, source-available terms) gate
  on *distribution*, not on revenue, and publishing an Apache-2.0 package is distribution.
  "Non-commercial" therefore relaxes nothing about which dependencies are admissible.
