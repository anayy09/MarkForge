# Fixture Licences

Every committed file under `fixtures/` has exactly one row here. CI fails in both directions:
a file with no row, and a row with no file. See `README.md` for the procedure and
`../docs/CORPUS.md` §1 for the policy.

`local/` and `generated/` are gitignored and therefore exempt — nothing in them is committed.

The three files under `templates/` are listed here too. They live outside `fixtures/` because
they are shipped artifacts rather than test inputs, but they are committed binaries and the
question a reader asks is the same one, so they are answered in the same register rather than
in a second place. `TEMPLATES.md` §1 is the policy; these are the rows.

## Register

| Path | Source | Licence | Attribution | Derived from | Notes (failure mode caught) |
| --- | --- | --- | --- | --- | --- |
| md/clean-report.md | authored | Apache-2.0 | MarkForge | — | §2.1 baseline: if the easy path ever scores below near-perfect, something fundamental broke |
| md/nested-restarting-lists.md | authored | Apache-2.0 | MarkForge | — | §2.4: ordered-vs-unordered from numbering, three-level nesting, a list interrupted and resumed, and a list starting at 7 |
| md/inline-marks.md | authored | Apache-2.0 | MarkForge | — | Inline span fidelity: combined marks, hard breaks, and escaped characters that must not re-escape on a second pass |
| md/unicode-edge-cases.md | authored | Apache-2.0 | MarkForge | — | §2.11: ZWJ sequences, skin-tone modifiers, combining marks, non-breaking spaces that must survive whitespace collapsing, CJK, and RTL |
| md/tables.md | authored | Apache-2.0 | MarkForge | — | §2.5: alignment markers and inline formatting inside cells |
| html/spans-ground-truth.html | authored | Apache-2.0 | MarkForge | — | §2.5 ground truth: HTML states rowspan/colspan explicitly, so this is what the DOCX and PDF table paths are measured against. Also covers cells holding block content |
| html/semantic-structure.html | authored | Apache-2.0 | MarkForge | — | HTML-to-IR mapping breadth: nested and start-offset lists, description lists, figure/figcaption binding, fenced code with a language class |
| md/generated-profile-source.md | authored | Apache-2.0 | MarkForge | — | Shared input for the §2.15 generated DOCX fixtures, so the same content can be compared across the different ways a library emits it |
| agentify/clean/product-spec.md | authored | Apache-2.0 | MarkForge | — | §2.14(a) productSpec. Holds one half of each near-duplicate pair; the other half is in architecture.md |
| agentify/clean/architecture.md | authored | Apache-2.0 | MarkForge | — | §2.14(a) decisionRecord. Restates two of the spec's constraints with near-zero lexical overlap, which is what makes §10.4 need embeddings rather than a text threshold |
| agentify/clean/api-contract.html | authored | Apache-2.0 | MarkForge | — | §2.14(a) apiContract, and the HTML input in a mixed-format set — §10.1 claims ingest is just the adapters, and a single-format corpus would not test it |
| agentify/clean/runbook.md | authored | Apache-2.0 | MarkForge | — | §2.14(a) runbook. The deterministic extractor categories live here: commands in fences, NAME=value environment variables, and one antiPattern |
| agentify/clean/conventions.docx | authored | Apache-2.0 | MarkForge | — | §2.14(a) codingConventions, and the DOCX input. Rendered from authored Markdown by scripts/build-agentify-corpus.mjs |
| agentify/classification/weekly.md | authored | Apache-2.0 | MarkForge | — | Role-classification holdout: meeting notes with no role word in the filename and a date for a title, so the role is only in the body |
| agentify/classification/overview.md | authored | Apache-2.0 | MarkForge | — | Holdout: a product spec wearing a decision record's clothes — an `## Decision` heading and a `**Rationale:**` paragraph over requirements. Catches a classifier fooled by format |
| agentify/classification/README.md | authored | Apache-2.0 | MarkForge | — | Holdout: a filename that suggests anything over a body that is only coding conventions. Catches a classifier leaning on the filename |
| agentify/classification/platform.md | authored | Apache-2.0 | MarkForge | — | Holdout: architecture described in prose with none of the architecture heading vocabulary |
| agentify/classification/checks.md | authored | Apache-2.0 | MarkForge | — | Holdout: testPolicy, a role none of the other three sets contain, so nothing about it was exercised while the rules were written |
| agentify/classification/expected-units.json | authored | Apache-2.0 | MarkForge | — | The holdout key, fixed before the rules were run against it and not adjusted afterwards. The rules score 1 of 5 |
| agentify/conflicting/deploy-guide.md | authored | Apache-2.0 | MarkForge | — | §2.14(b) newer source: NIMBUS_BATCH_TIMEOUT_MS=30000 and `pnpm build` |
| agentify/conflicting/ops-runbook.md | authored | Apache-2.0 | MarkForge | — | §2.14(b) older source: the same two facts with different values, so the conflict is structural rather than a matter of phrasing |
| agentify/conflicting/service-overview.md | authored | Apache-2.0 | MarkForge | — | §2.14(b) third document with no conflict, so a detector that fires on it is producing a false positive |
| agentify/oversized/engineering-handbook.md | authored | Apache-2.0 | MarkForge | — | §2.14(c) thirty convention units, sized to overflow a small target budget and force §10.5's progressive disclosure |
| agentify/oversized/glossary.md | authored | Apache-2.0 | MarkForge | — | §2.14(c) eight glossaryTerm units from a definition list |
| agentify/clean/expected-units.json | authored | Apache-2.0 | MarkForge | — | Answer key for §2.14(a), written before the extractor existed: expected units, roles, and the two near-duplicate pairs. Authored ground truth, not a captured snapshot — a snapshot would bless whatever the first implementation happened to do |
| agentify/conflicting/expected-units.json | authored | Apache-2.0 | MarkForge | — | Answer key for §2.14(b): the two expected conflicts and one negative case, so a false positive is as visible as a miss |
| agentify/oversized/expected-units.json | authored | Apache-2.0 | MarkForge | — | Answer key for §2.14(c): the unit counts budgeting must place, and the rule that every unit appears somewhere even when the primary file overflows |
| agentify/dedup/signing-policy.md | authored | Apache-2.0 | MarkForge | — | §2.17. The live §10.4 grading set, authored 2026-08-01 after §2.16 was retired for contamination. Holds one side of all three recall pairs and of two hard negatives |
| agentify/dedup/sealing-operations.md | authored | Apache-2.0 | MarkForge | — | §2.17. The other side, plus both environment variables of the entityKey negative. Renamed from custody-handbook.md: `handbook` classified the document as codingConventions, which routed every sentence to a different category and blocked all six pairs (CORPUS §2.17.2) |
| agentify/dedup/expected-units.json | authored | Apache-2.0 | MarkForge | — | §2.17 answer key. Records the expected merge verdicts under §2.14.1, and the retired §2.16 cases with why each was contaminated |
| docx/messy-direct-formatting.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: headings are Normal paragraphs made bold and large by hand, so heading recovery must work from run-level evidence with nothing in the style cascade. Contains a bold phrase mid-sentence that must stay emphasis, and ALL-CAPS body text that must not become a heading |
| docx/messy-whitespace-as-structure.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: empty paragraphs used as spacing, `w:br` runs used as paragraph breaks, and leading tabs used as indentation — structure expressed as whitespace, which normalisation must collapse without losing the block boundaries |
| docx/messy-manual-numbering.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: list markers typed as literal text with no `numbering.xml` at all. Includes `1998 was the year…` as a trap: a paragraph starting with digits is not automatically a list item |
| docx/messy-inconsistent-cascade.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: `Heading2 basedOn Heading1` but `Heading3 basedOn Normal`, a 1→3 level skip, and a reference to an undefined `Heading4` — the style chain cannot be trusted to be well-formed |
| docx/messy-mixed-fonts.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: a `+mj-lt` theme token alongside explicitly named fonts, and three different sizes at one logical heading level, so size alone cannot determine level |
| docx/messy-combined.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3: every defect above in one document, plus a merged-cell table and an equation typed as plain text. The realistic case — defects co-occur, and a fix for one must not depend on the others being absent |
| docx/generated-no-theme.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.15: what a library emits — no `theme1.xml`, so font tokens cannot resolve; empty `dc:creator`; millisecond-precision timestamps; `ListParagraph` plus `numPr` instead of a list style; and declared-but-empty comments, footnotes, and endnotes parts |
| docx/generated-run-per-word.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.15: one `w:r` per word, which is what several generators produce. Runs must merge back into whole text nodes or every inline span measurement is wrong. Also a 1→3 heading skip |
| docx/messy-ambiguous-headings.docx | generated | Apache-2.0 | MarkForge | `../scripts/build-messy-fixtures.mjs` | §2.3 and the **ambiguous subset**: four lines at 12pt bold against an 11pt body, which scores 0.536 against 0.464 — a margin of 0.073, inside `ambiguityMargin`. Three are section labels and one is a bold lead-in sentence, identically formatted, so no font rule can separate them and the deterministic path is wrong about one by construction. Built because *no* existing fixture produced a single ambiguous decision |
| pdf/scanned-150dpi.pdf | generated | Apache-2.0 | MarkForge | `../scripts/build-scanned-fixtures.mjs` | §2.7: a page with no text layer at all, rasterised from `md/scanned-source.md` at 150 DPI with skew and speckle. Catches missing-text-layer detection, OCR routing, and confidence propagation. The 300 and 600 DPI variants are generated into the gitignored `generated/` per §4's size rule |
| md/scanned-source.md | authored | Apache-2.0 | MarkForge | — | Ground truth for the §2.7 scans: the exact text the raster contains, so OCR accuracy is measured rather than eyeballed. No real scan comes with a transcript |
| expected/ambiguous-headings-truth.md | authored | Apache-2.0 | MarkForge | — | Answer key for `docx/messy-ambiguous-headings.docx`. Its subheadings are level 4 because that is what a 1.09 size ratio yields and no tie-break can change it — writing `##` would measure the size-to-level mapping instead of the heading-versus-prose decision under test |
| expected/baselines.json | generated | Apache-2.0 | MarkForge | the five fixtures above | Committed measurements; CI fails on a regression beyond tolerance (ADR-0010) |
| templates/academic-manuscript.docx | authored | Apache-2.0 | MarkForge | — | The primary reference template and the round-trip gate document (TEMPLATES.md §2.1). Structurally modelled on the IEEE conference template but written from scratch with Pandoc style names, so no publisher template is redistributed. Contains OMML, footnotes, embedded images, and cross-references — constructs the DOCX writer cannot yet produce, which is what makes it a gate |
| templates/technical-documentation.docx | authored | Apache-2.0 | MarkForge | — | Reference template for software documentation. Full 38-name Pandoc set |
| templates/clean-report.docx | authored | Apache-2.0 | MarkForge | — | Reference template for business reports. Full 38-name Pandoc set, no figures — the one template that exercises the style vocabulary without images |
| expected/agentify-extraction.json | generated | Apache-2.0 | MarkForge | the agentify/ source sets | Committed agentify measurements: extraction recall and precision against the authored answer keys, and role-classification accuracy. CI fails on a regression and reports an improvement without failing, since an unexplained rise needs a human to confirm the metric did not simply break |
| expected/agentify-llm-diff.txt | generated | Apache-2.0 | MarkForge | — | What `--llm` changes about `agentify/dedup`, asserted rather than printed. Empty is the expected state since CORPUS §2.14.1 became a veto. Regenerated by `scripts/check-agentify.mjs --update` |
| expected/test-skips.json | generated | Apache-2.0 | MarkForge | — | Every conditional skip in the suite, with its reason and what would make it run. Regenerated by `scripts/check-test-collection.mjs --update` |

**Every fixture here is ours** — either authored directly or generated by a script in this
repo, which `../docs/CORPUS.md` §1 rule 3 prefers precisely because it lets us control which
construct is under test. A found document would exercise more constructs at once and tell us
less about which one regressed.

The `docx/` rows are `generated` rather than `authored`: they are written by
`../scripts/build-messy-fixtures.mjs`, and `node scripts/build-messy-fixtures.mjs --check`
fails if a committed file no longer matches its generator. Committing the output rather than
building it on demand means a test needs no build step and a fixture cannot silently change
underneath one. They are still ours to license, so `derived` — which is for upstream work —
does not apply.

Categories still to come: §2.12 (tracked changes and comments), §2.2 (scanned documents), and
the rest of `../docs/CORPUS.md` §2. Their absence is a stated gap, not an oversight — see
`../docs/CORPUS.md` §5 and `../docs/STATUS.md`.

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
| `local/tessdata/eng.traineddata` | Apache-2.0, from `tesseract-ocr/tessdata_fast`. Not committed: 4 MB of third-party model weights, and `../docs/CORPUS.md` §4 keeps anything that size out of git when a committed script reproduces it. Fetched by `../scripts/fetch-ocr-assets.mjs`. |
| `local/found-scans/nasa-19730010146.pdf` | **Public domain** as a work of the US federal government (NASA NTRS 19730010146). Licence is not the reason it is gitignored — size is, under the same §4 rule. It is the found scan of `../docs/CORPUS.md` §2.7. |
| `local/sample002.docx` | Owner's own work, but a **confidential conference peer review** identifying an unpublished submission by paper ID and title. Committing it would publish a review of someone else's unpublished paper. **Permanently local — not an anonymization candidate.** |

This table exists so that "why isn't the obvious fixture here?" has a written answer, rather
than looking like an oversight. Note that two of the three rows fail on grounds *other* than
licensing: rule 4 and confidentiality are independent gates, and a file can be fully ours to
license and still belong nowhere near the corpus.
