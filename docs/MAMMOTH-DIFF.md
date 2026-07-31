# Differential test: our OOXML reader against Mammoth

Status: current as of 2026-07-31. Regenerate with `node scripts/diff-mammoth.mjs`.

ADR-0005 deviates from brief §5.2 by building our own OOXML reader rather than using
Mammoth. The design argument holds up — Mammoth's style map targets HTML elements and
discards the computed style evidence IR §4.2 exists to carry — but the *risk* was never the
design. It was the accumulated edge cases: Mammoth encodes years of handling for style
inheritance chains, `numbering.xml` resolution, theme font indirection via `w:themeFont`,
field codes, and section properties, and a fresh reader gets some of those wrong in ways the
corpus does not obviously reveal.

This file is the reviewed list that converts that unknown risk into a known one. Both readers
run over `fixtures/docx/`, each reduced to plain text plus a structural outline, and every
divergence is classified. **A divergence is not a failure** — beating Mammoth is the point of
ADR-0005 — but an *untriaged* divergence is, and `--check` fails the build on one.

## What it found

**One real bug, now fixed.** On `messy-inconsistent-cascade.docx` Mammoth recovered an `<h4>`
where we produced a plain paragraph. The document references `w:pStyle w:val="Heading4"` and
never defines that style, so there was no style *name* to match and no inherited
`outlineLevel`. Our adapter did record `sourceStyleId: "Heading4"` — rule A5 held, the
evidence was not lost — but `@markforge/infer` only matched on the resolved style *name* and
so ignored it. Fixed by rule 2b in `packages/infer/src/index.ts`, scored 0.8 rather than the
0.95 a resolved name earns, because an id is a weaker witness than a definition. This is
exactly the class of edge case the differential test was asked for, and it would not have
surfaced any other way.

**Everything else is the thesis working.** All nine remaining divergences are the same shape:
we promote to headings blocks that Mammoth leaves as paragraphs, because the heading is
expressed by direct formatting rather than by a named style. The counts correspond exactly —
five headings gained is five paragraphs lost, on every file — which is what makes this
readable as one behaviour rather than nine.

**No text-level divergence remains.** Neither reader recovers a character the other misses
anywhere in the corpus. The three that were reported at first were all artefacts of the
reduction, not of either reader: a full-tree walk double-counted paragraphs nested inside list
items and table cells; `textContent` on a list item swallowed its nested list, gluing
`"…numbered item."` to `"A nested item."`; and the two reducers truncated table text at
different lengths, which cut `"Spans two rows"` to `"…row"` on one side only. All three are
fixed in the script. They are worth recording because a differential test that invents
divergences is worse than none — it trains you to skim the list.

## The list

| Divergence | Verdict | Detail |
| --- | --- | --- |
| `messy-ambiguous-headings.docx:count:heading:1` | improvement | heading:1 ours 1, mammoth 0. Bold 16pt with `keepWithNext`, no named style. We read the evidence; Mammoth has no element to map. |
| `messy-ambiguous-headings.docx:count:heading:4` | improvement | heading:4 ours 4, mammoth 0. Same cause, four more blocks. |
| `messy-ambiguous-headings.docx:count:paragraph` | improvement | paragraph ours 7, mammoth 12. The corollary of the two rows above: 5 blocks we call headings, Mammoth calls body text. |
| `messy-direct-formatting.docx:count:heading:1` | improvement | heading:1 ours 1, mammoth 0. The fixture's entire purpose is structure carried by direct formatting, which is the case ADR-0005 exists to handle. |
| `messy-direct-formatting.docx:count:heading:3` | improvement | heading:3 ours 2, mammoth 0. Same cause. |
| `messy-direct-formatting.docx:count:paragraph` | improvement | paragraph ours 7, mammoth 10. Corollary of the two rows above; 3 for 3. |
| `messy-combined.docx:count:heading:2` | improvement | heading:2 ours 1, mammoth 0. Same cause, in the combined fixture. |
| `messy-combined.docx:count:paragraph` | improvement | paragraph ours 7, mammoth 8. Corollary; 1 for 1. |
| `messy-combined.docx:count:listItem` | improvement | listItem ours 3, mammoth 2. We recover a nested list item that Mammoth's flat `<li>` mapping loses. |

## What this does not cover

Honest limits, so the green tick is not read as more than it is:

- **Nine synthetic fixtures**, all authored by `scripts/build-messy-fixtures.mjs`. They are
  deliberately defective in known ways, which is what makes them measurable, and equally what
  stops them from being a sample of documents in the wild.
- **The reduction is coarse by design** — block kinds and text, not runs, spacing, or inline
  formatting. Two readers disagreeing about where a run splits is noise; this cannot see it,
  and is not meant to.
- **Agreement with Mammoth is not correctness.** Mammoth is a second opinion, not an oracle.
  The `Heading4` case is the demonstration in the other direction: it was right and we were
  wrong, but on the direct-formatting fixtures the disagreement runs the other way.
- **Four of the five risk areas named in ADR-0005 are still untested here.** The corpus
  exercises style inheritance chains; it does not yet exercise `numbering.xml` resolution
  depth, `w:themeFont` indirection, field codes, or section properties against Mammoth.
  Extending the corpus is the way to close that, not extending the script.
