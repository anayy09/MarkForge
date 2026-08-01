# ADR-0018: Source position orders context units, ahead of the content-addressed id

- Status: **Accepted** — amends `SPEC.md` §10.8, flagged for reversal in `OPEN_QUESTIONS.md` §7k
- Date: 2026-07-31
- Relates to: `SPEC.md` §10.8, §10.3, §2.7; brief §6.2; ADR-0014
- Enforced by: scripts/check-agentify.mjs

## Context

Brief §6.2 makes diff-friendliness a product requirement: "Output must be diff-friendly and
stable in ordering, so `git diff` after a source edit shows only the real change. No existing
tool does this and it is what makes the toolkit usable in a real repo over time." Phase 4's
done-criterion restates it as *editing one source document produces a minimal, readable git
diff*.

`SPEC.md` §10.8 specifies the mechanism: units are ordered by
`(sectionOrder, categoryOrder, id)`, described as "a total order independent of discovery
order". It is that. It is also, on its own, **not diff-stable**, and diff stability is the
only reason the rule exists.

The collision is with §10.3, which makes a unit's `id` content-addressed under the §2.7
scheme. Editing a unit's text changes its content hash, which changes its id, which moves it
within its `(section, category)` group. The regenerated file then shows a deletion where the
unit used to sort and an insertion where it now sorts — and displaces every unit in between.

**Measured rather than argued.** Changing "thirty days" to "ninety days" in one sentence of
`fixtures/agentify/clean/product-spec.md`:

| Order | Rows changed | What happened |
| --- | --- | --- |
| `(section, category, id)` — §10.8 as written | 3 | the edited unit moved from row 6 to row 4, displacing two neighbours |
| `(section, category, sourceOrder, id)` — this ADR | 1 | the edited unit stayed where it was |

The experiment is reproducible from `scripts/check-agentify.mjs` check 3, which asserts the
one-row result on every run; the counterfactual column was measured once, by hand, before
this decision was taken.

Worth naming: ADR-0014 chose content-addressed ids over a positional path scheme precisely
*because* positional paths renumber on insertion, and §2.7 states the consequence as a
feature — "an edit to paragraph 40 changes the ids of paragraph 40 and its ancestors, and
nothing else". That is true and remains the right choice for node ids. The mistake was
carrying it into a *sort key*: an identifier that changes when content changes is exactly
what you want for a join key and exactly what you do not want for deciding row order.

## Decision

Context units are ordered by **`(sectionOrder, categoryOrder, sourcePath, sourceOrder, id)`**.

`sourceOrder` is the document-order index of the unit's first supporting node, recorded at
extraction time in `UnitSource.order`. For a unit merged from several documents, the
comparison uses the earliest `(path, order)` pair it carries, so a merged unit stays where
its first statement was and does not move when a *different* source is edited.

`id` remains the final tiebreak, so the order is still total, still deterministic, and still
independent of discovery order — the property §10.8 asked for is preserved, not traded away.

Implemented in `compareUnits` and `sourceOrderOf` (`packages/agentify/src/units.ts`) and bound
to a profile by `compareUnitsIn` (`packages/agentify/src/budget.ts`).

A related consequence, recorded because it looks like an oversight otherwise:
`unitContentHash` deliberately excludes `sources`, `authority`, and `confidence`. Gaining a
source is what deduplication does, and if that changed a unit's hash then every merge would
register as a content change and rewrite a region nobody edited.

## Rejected alternatives

**Leave §10.8 as written and accept a two-hunk diff.** Rejected because the criterion says
*minimal*, and a one-word edit producing three changed rows is not minimal — it is the
failure mode brief §6.2 says no existing tool avoids. Shipping it would have meant the
done-criterion passed on a technicality while the property it names was absent.

**Order by value (the §10.5 ranking) inside the file.** Tempting, since ranking already
exists. Rejected: value is a float derived from authority and confidence, so any nudge to
either — a source gaining a review date, a confidence constant being retuned — would reshuffle
whole files. Value decides *what is kept*; unit order decides *where it goes*. Keeping those
separate is what makes the second one stable.

**Order alphabetically by text.** Diff-stable under an edit only if the edit does not change
the first characters, which is a coin toss. It also scatters related units, since alphabetical
order over sentences is meaningless to a reader.

**Make ids positional instead of content-addressed.** This would fix ordering and break the
thing ids are for. A unit's id is the join key in `provenance.json` and the key §10.8 uses to
detect which units actually changed; making it positional would mean inserting one sentence
renumbered every downstream unit and invalidated the manifest wholesale. ADR-0014 rejected
positional schemes for the same reason and that reasoning still holds.

**Keep a separate stable "display order" field alongside the sort key.** More machinery for
the same result. `sourceOrder` already exists as extraction metadata; promoting it into the
comparison costs one line and no new concept.

## Consequences

- `SPEC.md` §10.8's ordering sentence is amended, with a pointer here.
- Two units extracted from the same node in the same document order fall back to `id`, so
  the order stays total. This is rare and the tiebreak is arbitrary but deterministic.
- Reordering a source document *does* move its units, which is correct: the source changed.
- The one-region property is asserted on every CI run rather than believed. If a future
  change reintroduces id-first ordering, check 3 of `scripts/check-agentify.mjs` fails with
  the row count, not with a vague complaint about diffs.
- Cheap to reverse: it is one comparator.
