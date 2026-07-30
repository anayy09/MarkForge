# Fixture Licences

Every committed file under `fixtures/` has exactly one row here. CI fails in both directions:
a file with no row, and a row with no file. See `README.md` for the procedure and
`../docs/CORPUS.md` §1 for the policy.

`local/` and `generated/` are gitignored and therefore exempt — nothing in them is committed.

## Register

| Path | Source | Licence | Attribution | Derived from | Notes (failure mode caught) |
| --- | --- | --- | --- | --- | --- |
| _(none yet — Phase 1 populates this)_ | | | | | |

**The register is empty and that is correct.** Phase 0 delivers specification only
(`../docs/OPEN_QUESTIONS.md`), so no fixture exists yet. Phase 1 adds the categories listed in
`../docs/CORPUS.md` §5: 2.1, 2.3, 2.4, 2.5 (DOCX and HTML), 2.11, 2.12, and 2.13.

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
