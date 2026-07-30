# Fixtures

The golden corpus. `docs/CORPUS.md` is the plan — what categories exist, why each one exists,
and how each is sourced. This file is the operating procedure.

**The Apache-2.0 licence in the repository root does not cover this directory.** Fixtures carry
their own terms, recorded per file in `LICENSES.md`.

## The one hard rule

**No fixture lands without a licence line in `LICENSES.md`.** CI fails if a file exists under
`fixtures/` with no entry, and fails if an entry names a file that does not exist. Both
directions matter: the first stops an unlicensed fixture being used accidentally, the second
stops the register rotting into fiction. The check runs *before* any conversion test, so an
unlicensed fixture cannot be used even by a test that does not know it is unlicensed.

Exempt from the rule, because nothing in them is committed: `local/` and `generated/`.

## Adding a fixture

1. **Name the failure mode it catches**, in one line, in the `Notes` column. A fixture whose
   failure mode cannot be named does not belong here — nobody will know what a regression on it
   means. This is the most common reason to reject a fixture, ahead of licensing.
2. **Establish provenance** — one of the four acceptable classes in `CORPUS.md` §1 rule 3.
   Preferred is *authored by us*, because we control exactly which construct is under test.
3. **Add the `LICENSES.md` entry** before adding the file, so the two cannot diverge.
4. **Add a construct inventory** under `expected/` listing the source constructs the fixture
   contains. This is what makes the "nothing is lost silently" invariant (`SPEC.md` §2.6)
   testable: compare the inventory against the IR and the diagnostics must account for the
   difference. Without inventories that claim is unfalsifiable.
5. **Keep it under 1 MB** where the failure mode allows. Large binaries in git history are
   permanent. Anything genuinely large — 600 DPI scans, OCR language data — is produced into
   `generated/` by a committed deterministic script instead, documented here.

## No real personal data, and no scraped documents

Names, addresses, emails, and identifiers in fixtures are invented. Where a fixture needs to
look like a real business document, it is **authored** to look like one.

The temptation this rule exists to resist is specific: the messiest, most realistic documents
are always someone's internal report or a publisher's template. Authoring a messy document is
not merely the licensed option, it is the *better* one — a document containing exactly the seven
defects under test tells you which one regressed, and a found document does not.

## `local/` — third-party files, never committed

Gitignored. For publisher templates and real-world documents used as local reference documents
or conversion targets during development. Nothing here is redistributed, so nothing here needs a
licence entry — but nothing here can be a CI fixture either, because CI must be reproducible
from a clone.

Current contents, none of which is committed:

| File | Provenance | Why it is here rather than in the corpus | Used for |
| --- | --- | --- | --- |
| `ieee-conference-template.docx` | IEEE, obtained from the [IEEE templates page](https://www.ieee.org/conferences/publishing/templates) | IEEE grants no redistribution right | Structural model for our authored `academic-manuscript.docx` (`docs/TEMPLATES.md` §3.1) |
| `sample001.docx` | Authored by the project owner — a research collaboration proposal | Contains real names, including a third party's | Real-world DOCX conversion target; a specimen of **machine-generated** OOXML (`CORPUS.md` §2.3) |
| `sample002.docx` | Authored by the project owner — a conference peer review | **Confidential**: identifies an unpublished submission by ID and title | Real-world conversion target; the corpus's densest direct-formatting specimen |

The two `sample*.docx` files are the owner's own work, so **copyright is not the obstacle** —
the obstacles are `CORPUS.md` rule 4 (no real personal data) and, for `sample002.docx`,
confidentiality. Peer review is confidential to the conference, and the file names the paper ID,
the title, and the reviewer's assessment. Committing it would publish a review of someone else's
unpublished paper. It stays here permanently; it is not an anonymization candidate.

`sample001.docx` *could* become a committed fixture after replacing the real names with invented
ones, since the defects it exercises survive anonymization intact. `CORPUS.md` §2.3 records what
it is worth.

When a file you need is here rather than committed, the resolution is to **author an equivalent**
with the defects documented. `docs/TEMPLATES.md` §3.1 and `CORPUS.md` §2.3 record these files'
characteristics precisely enough to do that without them.

## Layout

```
fixtures/
  LICENSES.md              # mandatory, CI-enforced, one line per committed file
  README.md                # this file
  docx/  pdf/  pptx/  xlsx/  html/  md/  images/
  agentify/{clean,conflicting,oversized}/
  expected/                # ground truth: expected-units.json, construct inventories
  local/                   # gitignored: third-party, never committed
  generated/               # gitignored: produced by script, never committed
```
