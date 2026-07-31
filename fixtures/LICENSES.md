# Fixture Licences

Every committed file under `fixtures/` has exactly one row here. CI fails in both directions:
a file with no row, and a row with no file. See `README.md` for the procedure and
`../docs/CORPUS.md` §1 for the policy.

`local/` and `generated/` are gitignored and therefore exempt — nothing in them is committed.

## Register

| Path | Source | Licence | Attribution | Derived from | Notes (failure mode caught) |
| --- | --- | --- | --- | --- | --- |
| md/clean-report.md | authored | Apache-2.0 | MarkForge | — | §2.1 baseline: if the easy path ever scores below near-perfect, something fundamental broke |
| md/nested-restarting-lists.md | authored | Apache-2.0 | MarkForge | — | §2.4: ordered-vs-unordered from numbering, three-level nesting, a list interrupted and resumed, and a list starting at 7 |
| md/inline-marks.md | authored | Apache-2.0 | MarkForge | — | Inline span fidelity: combined marks, hard breaks, and escaped characters that must not re-escape on a second pass |
| md/unicode-edge-cases.md | authored | Apache-2.0 | MarkForge | — | §2.11: ZWJ sequences, skin-tone modifiers, combining marks, non-breaking spaces that must survive whitespace collapsing, CJK, and RTL |
| md/tables.md | authored | Apache-2.0 | MarkForge | — | §2.5: alignment markers and inline formatting inside cells |
| expected/baselines.json | generated | Apache-2.0 | MarkForge | the five fixtures above | Committed measurements; CI fails on a regression beyond tolerance (ADR-0010) |

**Every fixture here is authored**, which `../docs/CORPUS.md` §1 rule 3 prefers precisely
because it lets us control which construct is under test. A found document would exercise more
constructs at once and tell us less about which one regressed.

Categories still to come in Phase 1: §2.3 (badly formatted real-world documents), §2.12
(tracked changes and comments), and §2.15 (library- and LLM-generated documents). Their absence
is a stated gap, not an oversight — see `../docs/CORPUS.md` §5.

## Row format

```
| docx/nested-restarting-lists.docx | authored | Apache-2.0 | MarkForge | — | Exercises w:startOverride |
```

- **Source** — one of `authored`, `public domain`, `permissive`, or `derived`
  (`../docs/CORPUS.md` §1 rule 3, in order of preference).
- **Licence** — the actual licence, not the project's. Apache-2.0 in the root does not cover
  this directory.
- **Attribution** — the credit line the licence requires, verbatim. `MarkForge` for our own work.
- **Derived from** — for `derived` rows, the upstream file and the conversion applied, so the
  chain is auditable. `—` otherwise.
- **Notes** — the failure mode this fixture catches, in one line. Not optional: a fixture whose
  failure mode cannot be named does not belong in the corpus.

## Not in the register, deliberately

| File | Why not |
| --- | --- |
| `local/ieee-conference-template.docx` | IEEE provides it for authors preparing IEEE submissions and grants no redistribution right, so it is gitignored rather than committed. It is the structural model for our authored `academic-manuscript.docx`; see `../docs/TEMPLATES.md` §3.1. |
| `local/sample001.docx` | Owner's own work, so copyright is not the obstacle — but it contains real names including a third party's, which `../docs/CORPUS.md` rule 4 forbids. **Committable after substituting invented names**; every defect it exercises survives that edit. Measurements in `../docs/CORPUS.md` §2.3. |
| `local/sample002.docx` | Owner's own work, but a **confidential conference peer review** identifying an unpublished submission by paper ID and title. Committing it would publish a review of someone else's unpublished paper. **Permanently local — not an anonymization candidate.** |

This table exists so that "why isn't the obvious fixture here?" has a written answer, rather
than looking like an oversight. Note that two of the three rows fail on grounds *other* than
licensing: rule 4 and confidentiality are independent gates, and a file can be fully ours to
license and still belong nowhere near the corpus.
