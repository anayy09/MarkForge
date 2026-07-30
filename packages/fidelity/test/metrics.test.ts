import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  structuralSimilarity,
  textSimilarity,
  tableSimilarity,
  spanSimilarity,
  treeEditDistance,
  levenshtein,
  graphemes,
  extractCells,
  extractSpans,
  compareToBaselines,
  renderFidelityMarkdown,
  type BaselineEntry,
} from "../src/index.js";
import type { AnyNode } from "@markforge/ir";

const p = (text: string): AnyNode => ({ type: "paragraph", children: [{ type: "text", value: text }] });
const doc = (...kids: AnyNode[]): AnyNode => ({ type: "root", children: kids });

describe("tree edit distance", () => {
  it("is zero for identical trees", () => {
    expect(treeEditDistance(doc(p("a")), doc(p("a")))).toBe(0);
  });

  it("counts each inserted node, not each inserted block", () => {
    // Adding one paragraph adds two nodes: the paragraph and its text child. The
    // metric counts nodes, which is what makes it comparable across documents whose
    // blocks contain different amounts of inline structure.
    expect(treeEditDistance(doc(p("a")), doc(p("a"), p("b")))).toBe(2);
    expect(treeEditDistance(doc(p("a")), doc(p("a"), { type: "thematicBreak" }))).toBe(1);
  });

  it("counts a relabel as one edit", () => {
    const a = doc({ type: "heading", resolvedLevel: 1, children: [] });
    const b = doc({ type: "heading", resolvedLevel: 2, children: [] });
    expect(treeEditDistance(a, b)).toBe(1);
  });

  it("is symmetric", () => {
    const a = doc(p("x"), p("y"));
    const b = doc(p("x"));
    expect(treeEditDistance(a, b)).toBe(treeEditDistance(b, a));
  });

  it("satisfies the triangle inequality", () => {
    // A distance that violates this is not a metric, and "how far apart" would
    // stop meaning anything.
    const a = doc(p("a"));
    const b = doc(p("a"), p("b"));
    const c = doc(p("a"), p("b"), p("c"));
    const ab = treeEditDistance(a, b)!;
    const bc = treeEditDistance(b, c)!;
    const ac = treeEditDistance(a, c)!;
    expect(ac).toBeLessThanOrEqual(ab + bc);
  });

  it("skips rather than hangs on an oversized tree", () => {
    const huge = doc(...Array.from({ length: 60 }, (_, i) => p(String(i))));
    expect(treeEditDistance(huge, huge, 10)).toBeUndefined();
  });
});

describe("structural similarity", () => {
  it("scores identical documents 1.0", () => {
    expect(structuralSimilarity(doc(p("a")), doc(p("a"))).score).toBe(1);
  });

  it("scores completely different documents well below 1", () => {
    const a = doc(p("a"), p("b"), p("c"));
    const b = doc({ type: "table", children: [] });
    expect(structuralSimilarity(a, b).score).toBeLessThan(0.5);
  });

  // Text belongs to the text metric. Folding it in here would report one typo as
  // both a text failure and a structural failure.
  it("ignores text content, which the text metric covers", () => {
    expect(structuralSimilarity(doc(p("hello")), doc(p("goodbye"))).score).toBe(1);
  });

  it("notices a heading level change", () => {
    const a = doc({ type: "heading", resolvedLevel: 1, children: [] });
    const b = doc({ type: "heading", resolvedLevel: 3, children: [] });
    expect(structuralSimilarity(a, b).score).toBeLessThan(1);
  });

  it("notices a list changing from ordered to unordered", () => {
    const a = doc({ type: "list", ordered: true, children: [] });
    const b = doc({ type: "list", ordered: false, children: [] });
    expect(structuralSimilarity(a, b).score).toBeLessThan(1);
  });
});

describe("text similarity", () => {
  it("scores identical text 1.0 on both variants", () => {
    const s = textSimilarity("hello world", "hello world");
    expect(s.sensitive).toBe(1);
    expect(s.insensitive).toBe(1);
  });

  // The gap between the two variants is the diagnostic: it means whitespace moved
  // and content did not.
  it("separates a whitespace-only change from a content change", () => {
    const ws = textSimilarity("hello world", "hello   world");
    expect(ws.insensitive).toBe(1);
    expect(ws.sensitive).toBeLessThan(1);

    const content = textSimilarity("hello world", "hello there");
    expect(content.insensitive).toBeLessThan(1);
  });

  it("measures in grapheme clusters, not UTF-16 units", () => {
    // A skin-toned emoji is one character to a reader and several UTF-16 units to a
    // naive implementation, which would report a large distance for a one-character
    // difference.
    const withEmoji = "wave 👋🏽";
    expect(graphemes(withEmoji)).toHaveLength(6);
    const s = textSimilarity(withEmoji, "wave 👋🏻");
    expect(1 - s.sensitive).toBeCloseTo(1 / 6, 5);
  });

  it("treats a combining sequence as one grapheme", () => {
    expect(graphemes("é")).toHaveLength(1);
  });

  it("handles empty input on both sides", () => {
    expect(textSimilarity("", "").sensitive).toBe(1);
    expect(textSimilarity("abc", "").sensitive).toBe(0);
  });
});

describe("levenshtein", () => {
  it("matches known values", () => {
    expect(levenshtein([..."kitten"], [..."sitting"])).toBe(3);
    expect(levenshtein([..."flaw"], [..."lawn"])).toBe(2);
  });

  it("is symmetric and zero on identity", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), (a, b) => {
        expect(levenshtein([...a], [...a])).toBe(0);
        expect(levenshtein([...a], [...b])).toBe(levenshtein([...b], [...a]));
      }),
      { numRuns: 200 },
    );
  });

  it("never exceeds the longer input's length", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), (a, b) => {
        expect(levenshtein([...a], [...b])).toBeLessThanOrEqual(Math.max(a.length, b.length));
      }),
      { numRuns: 200 },
    );
  });
});

describe("table metrics", () => {
  const table = (rows: { text: string; rowSpan?: number; colSpan?: number }[][]): AnyNode => ({
    type: "table",
    children: rows.map((cells) => ({
      type: "tableRow",
      children: cells.map((c) => ({
        type: "tableCell",
        ...(c.rowSpan ? { rowSpan: c.rowSpan } : {}),
        ...(c.colSpan ? { colSpan: c.colSpan } : {}),
        children: [{ type: "text", value: c.text }],
      })),
    })),
  });

  it("scores an identical table 1.0", () => {
    const t = table([[{ text: "a" }, { text: "b" }], [{ text: "c" }, { text: "d" }]]);
    const s = tableSimilarity(t, t);
    expect(s.full.f1).toBe(1);
    expect(s.contentOnly.f1).toBe(1);
  });

  // The gap that names the failure: content in the right place, spans lost.
  it("distinguishes a flattened merge from lost content", () => {
    const merged = table([[{ text: "wide", colSpan: 2 }], [{ text: "a" }, { text: "b" }]]);
    const flattened = table([[{ text: "wide" }], [{ text: "a" }, { text: "b" }]]);
    const s = tableSimilarity(merged, flattened);
    expect(s.full.f1).toBeLessThan(1);
    expect(s.contentOnly.f1).toBe(1);
  });

  it("accounts for row spans when assigning column positions", () => {
    // A cell spanning two rows pushes the next row's cells rightward. Ignoring that
    // misaligns every subsequent column and makes the score meaningless.
    const t = table([
      [{ text: "tall", rowSpan: 2 }, { text: "x" }],
      [{ text: "y" }],
    ]);
    const cells = extractCells(t);
    const y = cells.find((c) => c.text === "y")!;
    expect(y.colStart).toBe(1);
  });

  it("counts duplicate cells as a multiset", () => {
    const a = table([[{ text: "yes" }, { text: "yes" }]]);
    const b = table([[{ text: "yes" }, { text: "no" }]]);
    const s = tableSimilarity(a, b);
    expect(s.full.f1).toBeLessThan(1);
    expect(s.full.f1).toBeGreaterThan(0);
  });

  it("scores two empty documents 1.0 rather than dividing by zero", () => {
    expect(tableSimilarity(doc(), doc()).full.f1).toBe(1);
  });
});

describe("inline spans", () => {
  const strong = (t: string): AnyNode => ({ type: "strong", children: [{ type: "text", value: t }] });
  const em = (t: string): AnyNode => ({ type: "emphasis", children: [{ type: "text", value: t }] });

  it("records marks as offset ranges", () => {
    const node: AnyNode = { type: "paragraph", children: [{ type: "text", value: "ab" }, strong("cd")] };
    const spans = extractSpans(node);
    expect(spans).toEqual([{ mark: "strong", start: 2, end: 4 }]);
  });

  // Offsets, not tree positions: two nestings of the same visible formatting must
  // compare equal, because they look identical to a reader.
  it("treats differently nested but visually identical marks as equal", () => {
    const a: AnyNode = { type: "paragraph", children: [{ type: "strong", children: [em("x")] }] };
    const b: AnyNode = { type: "paragraph", children: [{ type: "emphasis", children: [strong("x")] }] };
    expect(spanSimilarity(a, b).f1).toBe(1);
  });

  it("notices a missing mark", () => {
    const a: AnyNode = { type: "paragraph", children: [strong("x")] };
    const b: AnyNode = { type: "paragraph", children: [{ type: "text", value: "x" }] };
    expect(spanSimilarity(a, b).f1).toBe(0);
  });
});

describe("baselines (ADR-0010)", () => {
  const entry = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({
    fixture: "f", loop: "docx->md->docx",
    structural: 0.9, textSensitive: 0.9, textInsensitive: 0.95,
    tableF1: 0.9, tableContentF1: 0.95, spanF1: 0.9, ...over,
  });

  it("passes when scores match", () => {
    const base = { version: 1, tolerance: 0.005, entries: [entry()] };
    expect(compareToBaselines(base, [entry()]).regressions).toEqual([]);
  });

  it("fails on a drop beyond tolerance", () => {
    const base = { version: 1, tolerance: 0.005, entries: [entry()] };
    const result = compareToBaselines(base, [entry({ structural: 0.8 })]);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]!.metric).toBe("structural");
  });

  it("tolerates noise within tolerance", () => {
    const base = { version: 1, tolerance: 0.01, entries: [entry()] };
    expect(compareToBaselines(base, [entry({ structural: 0.895 })]).regressions).toEqual([]);
  });

  // An unexplained jump is as likely to mean the metric broke as that the
  // converter improved, so it gets reported too.
  it("reports improvements as well as regressions", () => {
    const base = { version: 1, tolerance: 0.005, entries: [entry()] };
    expect(compareToBaselines(base, [entry({ structural: 1 })]).improvements).toHaveLength(1);
  });

  it("reports fixtures that vanished from the corpus", () => {
    const base = { version: 1, tolerance: 0.005, entries: [entry(), entry({ fixture: "gone" })] };
    expect(compareToBaselines(base, [entry()]).missing).toEqual(["gone::docx->md->docx"]);
  });
});

describe("FIDELITY.md generation", () => {
  const entries: BaselineEntry[] = [
    { fixture: "b", loop: "md->md", structural: 1, textSensitive: 1, textInsensitive: 1, tableF1: 1, tableContentF1: 1, spanF1: 1 },
    { fixture: "a", loop: "docx->md->docx", structural: 0.5, textSensitive: 0.6, textInsensitive: 0.7, tableF1: 0.4, tableContentF1: 0.8, spanF1: 0.3 },
  ];

  // The honesty property: there is no filter, so the worst row cannot be omitted.
  it("emits every measured fixture, including the bad ones", () => {
    const md = renderFidelityMarkdown(entries, { generatedFrom: "test", corpusSize: 2 });
    expect(md).toContain("| a | docx->md->docx |");
    expect(md).toContain("| b | md->md |");
    expect(md).toContain("40.0%"); // the worst score is present
  });

  it("sorts deterministically regardless of input order", () => {
    const a = renderFidelityMarkdown(entries, { generatedFrom: "t", corpusSize: 2 });
    const b = renderFidelityMarkdown([...entries].reverse(), { generatedFrom: "t", corpusSize: 2 });
    expect(a).toBe(b);
  });

  it("includes a mean row so a corpus cannot hide behind its best fixture", () => {
    const md = renderFidelityMarkdown(entries, { generatedFrom: "t", corpusSize: 2 });
    expect(md).toContain("**mean**");
  });

  it("explains how to read each metric", () => {
    const md = renderFidelityMarkdown(entries, { generatedFrom: "t", corpusSize: 2 });
    expect(md).toContain("Zhang");
    expect(md).toContain("grapheme");
    expect(md).toContain("merged cells are being flattened");
  });
});
