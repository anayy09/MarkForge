/**
 * @markforge/fidelity — measurement, and the baseline gate.
 *
 * A package rather than test code because SPEC §9 makes fidelity a product
 * capability: `check` and `diff` reach it, not just CI. Recorded as a deviation
 * from the package layout in SPEC §11, in docs/OPEN_QUESTIONS.md §7a.
 */
import { textContent, type AnyNode, type MarkForgeDocument } from "@markforge/ir";
import {
  structuralSimilarity,
  textSimilarity,
  tableSimilarity,
  spanSimilarity,
  type StructuralScore,
  type TextScore,
  type TableScore,
} from "./metrics.js";

export interface FidelityScore {
  structural: StructuralScore;
  text: TextScore;
  table: TableScore;
  spans: { precision: number; recall: number; f1: number };
  /** Node types whose counts differ, worst first. Empty when the trees agree. */
  census: CensusDelta[];
}

/** One node type that appears a different number of times on each side. */
export interface CensusDelta {
  nodeType: string;
  expected: number;
  actual: number;
}

export function compare(expected: MarkForgeDocument, actual: MarkForgeDocument): FidelityScore {
  const a = expected.body as unknown as AnyNode;
  const b = actual.body as unknown as AnyNode;
  return {
    structural: structuralSimilarity(a, b),
    text: textSimilarity(textContent(a), textContent(b)),
    table: tableSimilarity(a, b),
    spans: spanSimilarity(a, b),
    census: censusDelta(a, b),
  };
}

/** Counts nodes by type. */
export function nodeCensus(root: AnyNode): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (n: AnyNode): void => {
    counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(root);
  return counts;
}

/**
 * Names the node types two trees disagree about.
 *
 * This exists because an aggregate score cannot say *what* changed, and five
 * format-destroying bugs have hidden behind one. A structural score of 92.8% is a
 * number to argue about; "list: 4 expected, 9 actual" is a bug report. Every one of
 * those five was found by dumping exactly this diff by hand, so the harness should
 * produce it rather than waiting for someone to suspect something.
 *
 * Sorted by the size of the disagreement, because the largest delta is usually the
 * cause and the rest are its consequences.
 */
export function censusDelta(expected: AnyNode, actual: AnyNode): CensusDelta[] {
  const a = nodeCensus(expected);
  const b = nodeCensus(actual);
  const deltas: CensusDelta[] = [];
  for (const type of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(type) ?? 0;
    const y = b.get(type) ?? 0;
    if (x !== y) deltas.push({ nodeType: type, expected: x, actual: y });
  }
  // Ties broken by name so the output is deterministic (ADR-0010 needs comparable runs).
  return deltas.sort(
    (p, q) =>
      Math.abs(q.expected - q.actual) - Math.abs(p.expected - p.actual) ||
      p.nodeType.localeCompare(q.nodeType),
  );
}

// ---------------------------------------------------------------------------
// Baselines (ADR-0010)
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  fixture: string;
  loop: string;
  /**
   * Node types whose counts differ across the loop, worst first.
   *
   * Carried in the baseline rather than computed for display only: this is the field
   * that turns "structural dropped to 92.8%" into "list: 4 expected, 9 actual", and a
   * reviewer reading the diff of a committed baseline should see which node type moved.
   */
  census?: CensusDelta[];
  structural: number;
  textSensitive: number;
  textInsensitive: number;
  tableF1: number;
  tableContentF1: number;
  spanF1: number;
}

export interface Baselines {
  version: number;
  /** Absolute tolerance. A score may drop by at most this much before CI fails. */
  tolerance: number;
  entries: BaselineEntry[];
}

export interface Regression {
  fixture: string;
  loop: string;
  metric: string;
  baseline: number;
  measured: number;
  delta: number;
}

export interface BaselineComparison {
  regressions: Regression[];
  improvements: Regression[];
  missing: string[];
  added: string[];
}

/**
 * Compares measurements against committed baselines.
 *
 * Improvements are reported too, and this is not symmetry for its own sake: a score
 * that jumps is as likely to mean the *metric* broke as that the converter improved,
 * and an unexplained improvement deserves the same look as a regression.
 */
export function compareToBaselines(
  baselines: Baselines,
  measured: BaselineEntry[],
): BaselineComparison {
  const key = (e: { fixture: string; loop: string }): string => `${e.fixture}::${e.loop}`;
  const byKey = new Map(baselines.entries.map((e) => [key(e), e]));
  const measuredKeys = new Set(measured.map(key));

  const regressions: Regression[] = [];
  const improvements: Regression[] = [];

  const METRICS: (keyof BaselineEntry)[] = [
    "structural", "textSensitive", "textInsensitive", "tableF1", "tableContentF1", "spanF1",
  ];

  for (const m of measured) {
    const base = byKey.get(key(m));
    if (!base) continue;
    for (const metric of METRICS) {
      const baseline = base[metric] as number;
      const value = m[metric] as number;
      if (typeof baseline !== "number" || typeof value !== "number") continue;
      const delta = value - baseline;
      const record: Regression = {
        fixture: m.fixture, loop: m.loop, metric: String(metric), baseline, measured: value, delta,
      };
      if (delta < -baselines.tolerance) regressions.push(record);
      else if (delta > baselines.tolerance) improvements.push(record);
    }
  }

  return {
    regressions,
    improvements,
    missing: [...byKey.keys()].filter((k) => !measuredKeys.has(k)),
    added: [...measuredKeys].filter((k) => !byKey.has(k)),
  };
}

/**
 * Renders the FIDELITY.md table.
 *
 * **There is no row-suppression mechanism here, deliberately.** Every measured
 * fixture appears. A report that can hide its worst rows is marketing, and the
 * absence of a filter is the only thing that makes the numbers worth reading.
 */
export function renderFidelityMarkdown(
  entries: BaselineEntry[],
  meta: { generatedFrom: string; corpusSize: number },
): string {
  const sorted = [...entries].sort(
    (a, b) => a.fixture.localeCompare(b.fixture) || a.loop.localeCompare(b.loop),
  );

  const pct = (n: number): string => (n < 0 ? "n/a" : (n * 100).toFixed(1) + "%");

  const lines: string[] = [
    "# Fidelity",
    "",
    "Measured, not claimed. Generated by `pnpm fidelity` from the golden corpus;",
    "every measured fixture appears, and there is no mechanism to omit a row.",
    "",
    `Corpus: ${meta.corpusSize} fixture(s). Source: ${meta.generatedFrom}.`,
    "",
    "| Fixture | Loop | Structural | Text (ws-sensitive) | Text (ws-insensitive) | Table F1 | Table content F1 | Span F1 |",
    "| --- | --- | --: | --: | --: | --: | --: | --: |",
  ];

  for (const e of sorted) {
    lines.push(
      `| ${e.fixture} | ${e.loop} | ${pct(e.structural)} | ${pct(e.textSensitive)} | ` +
        `${pct(e.textInsensitive)} | ${pct(e.tableF1)} | ${pct(e.tableContentF1)} | ${pct(e.spanF1)} |`,
    );
  }

  if (sorted.length > 0) {
    const mean = (get: (e: BaselineEntry) => number): number => {
      const values = sorted.map(get).filter((v) => v >= 0);
      return values.length === 0 ? -1 : values.reduce((a, b) => a + b, 0) / values.length;
    };
    lines.push(
      `| **mean** | | ${pct(mean((e) => e.structural))} | ${pct(mean((e) => e.textSensitive))} | ` +
        `${pct(mean((e) => e.textInsensitive))} | ${pct(mean((e) => e.tableF1))} | ` +
        `${pct(mean((e) => e.tableContentF1))} | ${pct(mean((e) => e.spanF1))} |`,
    );
  }

  const lossy = sorted.filter((e) => (e.census ?? []).length > 0);
  lines.push("", "## Where the losses are", "");
  if (lossy.length === 0) {
    lines.push(
      "No loop changes any node-type count: every tree that goes out comes back with the",
      "same census. This section is generated, so it says this only when it is true.",
    );
  } else {
    lines.push(
      "Node types whose counts differ, worst first. A score says something regressed; this",
      "says which construct did, which is the difference between a number to argue about and",
      "a bug report. Every entry here is a real loss with a named cause or a known format",
      "limit — nothing is rounded away.",
      "",
      "| Fixture | Loop | Node type | Expected | Actual |",
      "| --- | --- | --- | --: | --: |",
    );
    for (const e of lossy) {
      for (const d of e.census ?? []) {
        lines.push(
          `| ${e.fixture} | ${e.loop} | \`${d.nodeType}\` | ${d.expected} | ${d.actual} |`,
        );
      }
    }
  }

  lines.push(
    "",
    "## How to read these",
    "",
    "**Structural** is `1 - TED/(|T1|+|T2|)` over Zhang–Shasha ordered tree edit distance,",
    "where node labels carry type plus meaning-changing attributes but *not* text — text is",
    "the next column's job, and folding it in here would double-count one error.",
    "",
    "**Text** is grapheme-cluster Levenshtein, reported in both variants because the gap",
    "between them is itself the diagnostic: a large gap means whitespace changed and content",
    "did not.",
    "",
    "**Table F1** keys cells on `(rowStart, colStart, rowSpan, colSpan, text)`; **content F1**",
    "drops the spans. A high content score beside a low full score says one specific thing:",
    "merged cells are being flattened.",
    "",
    "**Span F1** compares inline marks as offset ranges rather than tree positions, so",
    "`<strong><em>x</em></strong>` and `<em><strong>x</strong></em>` compare equal — as they",
    "look to a reader.",
    "",
    "## Where the low numbers come from",
    "",
    "Some rows are low because a target format genuinely cannot express the construct, not",
    "because the conversion is broken. They are listed here so a reader does not have to guess",
    "which is which — and so that a row moving *off* this list is visible.",
    "",
    "- **Any loop through Markdown on a table with merged cells.** Markdown has no rowspan or",
    "  colspan. The cells survive, the merges do not, which is why table F1 drops while",
    "  content F1 stays high. `fixtures/html/spans-ground-truth.html` exists to measure that",
    "  gap, not to pass.",
    "- **html to docx to html, on text.** Constructs with no DOCX equivalent — description",
    "  lists, captions bound to an image — degrade to the nearest available structure, each",
    "  with a diagnostic.",
    "- **Structural scores in the 85 to 95 band through DOCX.** The round trip adds and removes",
    "  wrapper nodes: a list item gains a paragraph, a cell loses one. The text is intact and",
    "  the tree shape differs by a few nodes.",
    "- **Text around 65 to 72% on the two manuscripts, from 2026-08-02.** These carry OMML",
    "  equations, and neither Markdown nor HTML has an OMML syntax. Both renderers now emit the",
    "  *source* — a fenced ```omml block, a `<pre>` inside the math div — where they previously",
    "  emitted an empty `$$` pair and an empty `<div>`. The markup was never text in the DOCX,",
    "  so counting it as output text costs both text metrics. That cost buys a document a reader",
    "  can see the equation in, and an equation a future converter can still read; the",
    "  alternative scored higher by discarding it.",
    "- **The two `tracked-changes` fixtures on text, from 2026-08-02.** `revisionMode` defaults to",
    "  `clean` (SPEC §7), which means *accept every revision*: insertions in, deletions out, each",
    "  drop diagnosed. The deleted words are in the source document and not in the output, so the",
    "  text metrics count them as lost — correctly. The harness measures the pipeline we ship, so",
    "  it measures the default; rendering these two fixtures under `showAll` to score higher would",
    "  be measuring a pipeline nobody runs.",
    "- **`comments-anchored` structural, from 2026-08-02.** The commented *range* is now wrapped",
    "  by the `comment` node, which the schema always required. That is one extra node per",
    "  comment on one side of the comparison, so the tree shape differs by exactly the fix.",
    "- **Every `md->pdf->md` row, from 2026-08-02, and the lowest scores in this table.** SPEC",
    "  §9.5 requires this loop and says what it is: a **joint** measure of the PDF renderer and",
    "  the PDF *extractor*, which must never be quoted as a renderer-only score. A PDF states no",
    "  structure at all — it is glyphs at coordinates — so the return leg reconstructs shape from",
    "  geometry, and what it cannot reconstruct is what these numbers report. The census names it",
    "  exactly: **tables go to zero** (`table`, `tableRow`, `tableCell` all 0, so table F1 reads",
    "  0.0% wherever a table existed) and **every inline mark goes to zero** (`strong`,",
    "  `emphasis`, `delete`, `inlineCode`, `link`), because bold text in a PDF is a different",
    "  font, not a tagged span. `nested-restarting-lists` is the floor at 16.5% — 9 lists and 16",
    "  list items become flat paragraphs. Two of ADR-0012's four clauses, table recovery and",
    "  figure/caption binding, are *struck* rather than unbuilt (OPEN_QUESTIONS §7af), so these",
    "  are the measured cost of that ruling rather than a regression against it. `scanned-source`",
    "  scores highest at 89.7% for the reason that makes the point: it is plain prose, so there",
    "  is almost no structure to lose.",
    "",
    "A low score for a reason *not* listed here is a defect. Fix it, or add it here with its",
    "reason — those are the only two honest options.",
    "",
  );

  return lines.join("\n");
}

export {
  structuralSimilarity,
  textSimilarity,
  tableSimilarity,
  spanSimilarity,
  treeEditDistance,
  levenshtein,
  graphemes,
  extractCells,
  extractSpans,
} from "./metrics.js";
export type { StructuralScore, TextScore, TableScore, TableCell, InlineSpan } from "./metrics.js";
