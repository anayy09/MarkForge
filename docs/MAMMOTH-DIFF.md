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

**~~No text-level divergence remains.~~ Six do, added 2026-08-01 with `CORPUS.md` §2.2, §2.5,
and §2.12.** The sentence below was true of the corpus as it stood, and the corpus was missing
the three categories that would contradict it — which is the same shape as every other finding
in this repository: the claim was safe because nothing could test it.

What the new fixtures found is worth more than the correction, and **two of the three are now
fixed** — the rows below are kept at their original verdicts so the record shows what was
found rather than only what survived.

**Mammoth recovered footnote and endnote bodies and we recovered none**, because
`footnotes.xml` and `endnotes.xml` were never read — 21 tokens on one fixture, 15 on another,
plus the ordered list Mammoth renders them into. Not a difference in philosophy like the
heading rows below; a reader gap, found by the reference implementation getting something we
did not. **Fixed 2026-08-01**: both parts are read and the divergence is now the opposite
shape, three extra paragraphs of ours against Mammoth's list items, triaged as improvements at
the end of the table.

**Block content inside a table cell was concatenated without a separator** (`intake.Wait`,
`keyvaluemodestrict`). **Fixed 2026-08-01** in `textContent`, which was joining block siblings
with nothing against SPEC §9.2.

**Deleted text was rendered adjacent to inserted text** (`fortyfifty`, `someall`) under a
`revisionMode` default of `clean` that should have dropped it. **Fixed 2026-08-02** in
`@markforge/render-md`, which had never read the option the DOCX writer and the PDF renderer
both honoured. The comparison itself needed the same fix: it reduced our side with
`textContent`, which returns the whole IR subtree including deletions, so it kept reporting the
divergence after the renderer stopped producing it. Both rows are in **Resolved** below.

**As of 2026-08-02 no divergence is triaged `bug`.** Twenty remain: fourteen `improvement` and
six `accepted`. That is not a claim of superiority — it means every difference between the two
readers is now either a construct we recover and Mammoth does not, or a representation choice
with a stated reason. A new `bug` row would be a new finding, which is what this document is
for.

The paragraph below still holds for the pre-2026-08-01 corpus, and is kept because its account
of *reduction artefacts* is what makes the six new rows readable as real:

The three that were reported at first were all artefacts of the
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
| `manuscript-endnotes-crossrefs.docx:count:caption` | improvement | caption ours 1, mammoth 0. We bind an equation caption to the equation it labels; Mammoth's HTML has no caption model, so the words survive as an ordinary paragraph. Same on the other manuscript. |
| `manuscript-footnotes-equations.docx:count:caption` | improvement | caption ours 1, mammoth 0. Same cause as the row above. |
| `comments-anchored.docx:text-only-ours` | improvement | 16 tokens we recover and Mammoth does not, all of them comment bodies: *Is this the statutory minimum or our own policy?* and the second reviewer's note. **Mammoth drops comments entirely.** We wrap the commented range in a `comment` node and render the reviewer's note as an HTML comment beside it, so the annotation survives the conversion without entering the prose — the tokens are in the file, not in the sentence. |
| `manuscript-endnotes-crossrefs.docx:text-only-mammoth` | accepted | **Was a bug and is not one any more.** It read *"Mammoth reads `endnotes.xml` and we do not"*, and 15 tokens of endnote body were genuinely missing; `endnotes.xml` is read as of 2026-08-01. What is left, re-measured 2026-08-02, is 6 tokens of marker punctuation: `[1]`, `[2]`, `↑`, and the sentence-final `.`/`period`/`closes` that Mammoth splits around its `<sup>` where we write `[^1]`. Two spellings of a footnote marker, not two amounts of text. |
| `manuscript-endnotes-crossrefs.docx:text-only-ours` | accepted | `2` and `closes.` — the cached result of a `REF` field, which we flatten to text with `MF-DOCX-0053`, and a token boundary that differs because Mammoth splits at the endnote marker we never emit. Both are corollaries of the row above. |
| `manuscript-endnotes-crossrefs.docx:count:listItem` | accepted | listItem ours 0, mammoth 2. Mammoth renders endnotes as an ordered `<ol>` at the end of the document; we emit `footnoteDefinition` nodes, which the Markdown renderer writes as `[^1]: …`. Both carry the bodies. A list is Mammoth's representation choice, not a count of recovered content. |
| `manuscript-footnotes-equations.docx:text-only-mammoth` | accepted | **Was a bug and is not one any more.** It read *"`footnotes.xml` is never read"* and 21 tokens of footnote body were missing; the reader was built 2026-08-01. Re-measured 2026-08-02: 5 tokens remain, all marker spelling — `[1]`, `[2]`, `[3]`, `↑`, and a comma Mammoth splits around its `<sup>`. |
| `manuscript-footnotes-equations.docx:text-only-ours` | accepted | One token, `rate,` — a boundary artefact of the footnote marker we do not emit, not a recovered character. |
| `manuscript-footnotes-equations.docx:count:listItem` | accepted | listItem ours 0, mammoth 3. Mammoth's footnote `<ol>`; we emit `footnoteDefinition`. See the endnote row above. |
| `manuscript-endnotes-crossrefs.docx:count:paragraph` | improvement | paragraph ours 7, mammoth 5. We now read `endnotes.xml` and emit each body as a `footnoteDefinition` containing a paragraph; Mammoth renders the same bodies as an ordered list, so its paragraph count is lower by exactly the two notes. The two `text-only` rows above, which recorded us losing those bodies entirely, are the state this replaced. |
| `manuscript-footnotes-equations.docx:count:paragraph` | improvement | paragraph ours 9, mammoth 6. Same cause, three footnotes rather than two. The counts correspond exactly, which is what makes this readable as one behaviour rather than two files disagreeing. |

## Resolved, and removed from the list

A verdict is a claim about today's code. When the defect it describes is fixed, the divergence
stops occurring and the row has to go — `scripts/diff-mammoth.mjs` fails on a verdict with no
divergence as of 2026-08-02, having previously only failed on the reverse. What was here:

- **`tracked-changes-single-author.docx` and `tracked-changes-two-authors.docx`,
  `text-only-ours`** — *"deleted text is emitted adjacent to inserted text with no separator"*,
  reported as `scriptthe`, `fortyfifty`, `someall`. Two defects were tangled here. The renderer
  ignored `revisionMode` and emitted both sides of every edit, fixed 2026-08-02 so `clean`
  emits the accepted text and diagnoses each dropped deletion. And *this script* reduced our
  side with `textContent`, which returns the whole IR subtree, deletions included — so it kept
  reporting the divergence after the renderer stopped producing it. It now compares accepted
  text, which is what the shipped default writes.
- **`tracked-changes-*`, `count:paragraph` and `text-only-mammoth`** — the other side of the
  same pair. Both said we keep both sides of a revision where Mammoth applies it, which was
  true of the IR and is no longer true of the comparison: reduced as accepted text, our reading
  and Mammoth's agree on every token and on the paragraph count. The IR still keeps both sides,
  which is what `insertion`/`deletion` are for; `revisionMode` decides what a *renderer* does
  with them.
- **`tables-block-content.docx`, both directions** — *"Block content inside a table cell is
  concatenated with no separator"*. `textContent` joined block-level siblings with nothing, so
  three paragraphs in a cell read as `intake.Wait` and a nested table as `keyvaluemodestrict`.
  Fixed by applying SPEC §9.2's blank-line rule to every block container;
  `scripts/check-ir-structure.mjs` asserts both strings against a hand-written declaration, and
  scans the whole corpus for the general rule rather than the two cells we found.

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
