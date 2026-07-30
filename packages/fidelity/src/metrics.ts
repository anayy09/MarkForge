/**
 * Fidelity metrics, per docs/SPEC.md §9.
 *
 * These numbers are the project's claim about itself, so every one of them is
 * defined precisely enough to reimplement, and none of them is a single "quality
 * score". A single number hides which half of the document broke; four numbers with
 * names tell you where to look.
 */
import { textContent, visit, type AnyNode } from "@markforge/ir";

// ---------------------------------------------------------------------------
// Structural: Zhang–Shasha ordered tree edit distance
// ---------------------------------------------------------------------------

interface LabelledNode {
  label: string;
  children: LabelledNode[];
}

/**
 * Reduces an IR node to the label the metric compares.
 *
 * Type plus the attributes that change meaning — a heading's level, a list's
 * orderedness, a cell's spans. Deliberately *not* the text, which the text metric
 * covers: folding text into the structural label would make a typo look like a
 * structural failure and double-count the same error.
 */
function label(node: AnyNode): string {
  switch (node.type) {
    case "heading":
      return `heading:${node["resolvedLevel"] ?? node["depth"] ?? 1}`;
    case "list":
      return `list:${node["ordered"] === true ? "ordered" : "unordered"}`;
    case "tableCell":
      return `tableCell:${node["rowSpan"] ?? 1}x${node["colSpan"] ?? 1}`;
    case "code":
      return `code:${typeof node["lang"] === "string" ? node["lang"] : ""}`;
    default:
      return node.type;
  }
}

function toLabelled(node: AnyNode): LabelledNode {
  const children = Array.isArray(node.children)
    ? (node.children as AnyNode[]).map(toLabelled)
    : [];
  return { label: label(node), children };
}

/** Post-order traversal plus leftmost-leaf indices, the Zhang–Shasha preprocessing. */
function postorder(root: LabelledNode): { nodes: LabelledNode[]; leftmost: number[] } {
  const nodes: LabelledNode[] = [];
  const leftmost: number[] = [];

  const walk = (n: NodeInfo): number => {
    let first = -1;
    for (const c of n.node.children) {
      const idx = walk({ node: c });
      if (first === -1) first = idx;
    }
    nodes.push(n.node);
    const self = nodes.length - 1;
    leftmost.push(first === -1 ? self : leftmost[first]!);
    return self;
  };
  interface NodeInfo {
    node: LabelledNode;
  }
  walk({ node: root });
  return { nodes, leftmost };
}

/**
 * Zhang–Shasha ordered tree edit distance with unit costs.
 *
 * O(n²·min(depth,leaves)²) in the worst case, which is fine for documents and would
 * not be for arbitrary trees. A size guard keeps a pathological input from hanging
 * CI rather than failing it.
 */
export function treeEditDistance(a: AnyNode, b: AnyNode, maxNodes = 4000): number | undefined {
  const ta = postorder(toLabelled(a));
  const tb = postorder(toLabelled(b));
  if (ta.nodes.length > maxNodes || tb.nodes.length > maxNodes) return undefined;

  const n = ta.nodes.length;
  const m = tb.nodes.length;
  const treedist: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));

  const keyroots = (t: { nodes: LabelledNode[]; leftmost: number[] }): number[] => {
    const seen = new Set<number>();
    const roots: number[] = [];
    for (let i = t.nodes.length - 1; i >= 0; i--) {
      const l = t.leftmost[i]!;
      if (!seen.has(l)) {
        seen.add(l);
        roots.push(i);
      }
    }
    return roots.reverse();
  };

  for (const i of keyroots(ta)) {
    for (const j of keyroots(tb)) {
      const li = ta.leftmost[i]!;
      const lj = tb.leftmost[j]!;
      const rows = i - li + 2;
      const cols = j - lj + 2;
      const fd: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

      for (let x = 1; x < rows; x++) fd[x]![0] = fd[x - 1]![0]! + 1;
      for (let y = 1; y < cols; y++) fd[0]![y] = fd[0]![y - 1]! + 1;

      for (let x = 1; x < rows; x++) {
        for (let y = 1; y < cols; y++) {
          const ai = li + x - 1;
          const bj = lj + y - 1;
          const del = fd[x - 1]![y]! + 1;
          const ins = fd[x]![y - 1]! + 1;
          if (ta.leftmost[ai] === li && tb.leftmost[bj] === lj) {
            const rename = ta.nodes[ai]!.label === tb.nodes[bj]!.label ? 0 : 1;
            const sub = fd[x - 1]![y - 1]! + rename;
            fd[x]![y] = Math.min(del, ins, sub);
            treedist[ai]![bj] = fd[x]![y]!;
          } else {
            const pi = ta.leftmost[ai]! - li;
            const pj = tb.leftmost[bj]! - lj;
            fd[x]![y] = Math.min(del, ins, fd[pi]![pj]! + treedist[ai]![bj]!);
          }
        }
      }
    }
  }

  return treedist[n - 1]![m - 1]!;
}

export interface StructuralScore {
  distance: number;
  sizeA: number;
  sizeB: number;
  /** `1 - TED / (|T1| + |T2|)`. 1.0 is identical. */
  score: number;
  /** True when the trees were too large to compare exactly. */
  skipped: boolean;
}

export function structuralSimilarity(a: AnyNode, b: AnyNode): StructuralScore {
  const sizeA = countNodes(a);
  const sizeB = countNodes(b);
  const distance = treeEditDistance(a, b);
  if (distance === undefined) {
    return { distance: -1, sizeA, sizeB, score: -1, skipped: true };
  }
  // Normalised by the sum of sizes rather than by the max, so deleting a whole
  // document and inserting a different one scores 0 rather than something positive.
  const denominator = sizeA + sizeB;
  const score = denominator === 0 ? 1 : 1 - distance / denominator;
  return { distance, sizeA, sizeB, score, skipped: false };
}

function countNodes(node: AnyNode): number {
  let n = 0;
  visit(node, () => {
    n++;
  });
  return n;
}

// ---------------------------------------------------------------------------
// Text: grapheme-cluster Levenshtein
// ---------------------------------------------------------------------------

/**
 * Splits into grapheme clusters, not code points or UTF-16 units.
 *
 * A skin-toned emoji is one character to a reader and up to seven UTF-16 units to a
 * naive implementation. Measuring in code units would report a large edit distance
 * for a document that is visually identical, and would do so *inconsistently*
 * depending on which emoji appear (SPEC §9.2 mandates graphemes for this reason).
 */
export function graphemes(s: string): string[] {
  // Intl.Segmenter is in every Node ≥16 and every current browser.
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...seg.segment(s)].map((x) => x.segment);
}

/** Levenshtein over arbitrary token arrays, with the usual two-row optimisation. */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export interface TextScore {
  /** Exact comparison, whitespace included. */
  sensitive: number;
  /** Whitespace runs collapsed and edges trimmed. */
  insensitive: number;
  lengthA: number;
  lengthB: number;
}

/**
 * Both variants, always reported separately (SPEC §9.2).
 *
 * Reporting only the insensitive score would hide every whitespace regression;
 * reporting only the sensitive one would make a harmless reflow look like data
 * loss. The gap between them is itself the diagnostic.
 */
export function textSimilarity(a: string, b: string): TextScore {
  const ga = graphemes(a);
  const gb = graphemes(b);
  const sensitiveDistance = levenshtein(ga, gb);
  const sensitiveDenominator = Math.max(ga.length, gb.length);

  const na = graphemes(a.replace(/\s+/g, " ").trim());
  const nb = graphemes(b.replace(/\s+/g, " ").trim());
  const insensitiveDistance = levenshtein(na, nb);
  const insensitiveDenominator = Math.max(na.length, nb.length);

  return {
    sensitive: sensitiveDenominator === 0 ? 1 : 1 - sensitiveDistance / sensitiveDenominator,
    insensitive: insensitiveDenominator === 0 ? 1 : 1 - insensitiveDistance / insensitiveDenominator,
    lengthA: ga.length,
    lengthB: gb.length,
  };
}

// ---------------------------------------------------------------------------
// Tables: cell precision / recall / F1
// ---------------------------------------------------------------------------

export interface TableCell {
  rowStart: number;
  colStart: number;
  rowSpan: number;
  colSpan: number;
  text: string;
}

/** Extracts cells with resolved grid coordinates, accounting for spans. */
export function extractCells(root: AnyNode): TableCell[] {
  const out: TableCell[] = [];
  visit(root, (node) => {
    if (node.type !== "table") return;
    const rows = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
    // Occupancy grid: a cell spanning rows pushes later rows' cells rightward, and
    // ignoring that misaligns every subsequent column.
    const occupied = new Set<string>();
    rows.forEach((row, rowStart) => {
      const cells = Array.isArray(row.children) ? (row.children as AnyNode[]) : [];
      let colStart = 0;
      for (const cell of cells) {
        while (occupied.has(`${rowStart},${colStart}`)) colStart++;
        const rowSpan = typeof cell["rowSpan"] === "number" ? cell["rowSpan"] : 1;
        const colSpan = typeof cell["colSpan"] === "number" ? cell["colSpan"] : 1;
        for (let r = rowStart; r < rowStart + rowSpan; r++) {
          for (let c = colStart; c < colStart + colSpan; c++) occupied.add(`${r},${c}`);
        }
        out.push({
          rowStart,
          colStart,
          rowSpan,
          colSpan,
          text: textContent(cell).replace(/\s+/g, " ").trim(),
        });
        colStart += colSpan;
      }
    });
  });
  return out;
}

export interface TableScore {
  /** Keyed by position *and* span — the strict measure. */
  full: { precision: number; recall: number; f1: number };
  /** Keyed by position and text only — spans ignored. */
  contentOnly: { precision: number; recall: number; f1: number };
  expected: number;
  actual: number;
}

/**
 * Both keyings, and the gap between them is the point (SPEC §9.3).
 *
 * `full` requires the spans to be right. `contentOnly` requires only that the text
 * landed in the right cell. A high content-only score with a low full score says
 * precisely one thing: merged cells are being flattened. One number could not.
 */
export function tableSimilarity(expected: AnyNode, actual: AnyNode): TableScore {
  const e = extractCells(expected);
  const a = extractCells(actual);

  const fullKey = (c: TableCell): string =>
    `${c.rowStart},${c.colStart},${c.rowSpan},${c.colSpan},${c.text}`;
  const contentKey = (c: TableCell): string => `${c.rowStart},${c.colStart},${c.text}`;

  return {
    full: prf(e.map(fullKey), a.map(fullKey)),
    contentOnly: prf(e.map(contentKey), a.map(contentKey)),
    expected: e.length,
    actual: a.length,
  };
}

/** Multiset precision/recall/F1, so duplicate cells count correctly. */
function prf(expected: string[], actual: string[]): { precision: number; recall: number; f1: number } {
  if (expected.length === 0 && actual.length === 0) return { precision: 1, recall: 1, f1: 1 };
  const pool = new Map<string, number>();
  for (const k of expected) pool.set(k, (pool.get(k) ?? 0) + 1);

  let matched = 0;
  for (const k of actual) {
    const remaining = pool.get(k) ?? 0;
    if (remaining > 0) {
      matched++;
      pool.set(k, remaining - 1);
    }
  }

  const precision = actual.length === 0 ? (expected.length === 0 ? 1 : 0) : matched / actual.length;
  const recall = expected.length === 0 ? (actual.length === 0 ? 1 : 0) : matched / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

export interface InlineSpan {
  mark: string;
  start: number;
  end: number;
}

const INLINE_MARKS = new Set([
  "strong", "emphasis", "delete", "inlineCode", "underline",
  "smallCaps", "highlight", "subscript", "superscript", "link",
]);

/**
 * Inline marks as offset ranges over the plain text.
 *
 * Offsets rather than tree positions, because the same visible formatting can be
 * nested differently in two trees — `<strong><em>x</em></strong>` against
 * `<em><strong>x</strong></em>` — and a tree comparison would call that a
 * difference when a reader would not.
 */
export function extractSpans(root: AnyNode): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let offset = 0;

  const walk = (node: AnyNode): void => {
    if (node.type === "text" || node.type === "inlineCode") {
      const value = typeof node["value"] === "string" ? node["value"] : "";
      if (node.type === "inlineCode") {
        spans.push({ mark: "inlineCode", start: offset, end: offset + value.length });
      }
      offset += value.length;
      return;
    }
    const start = offset;
    if (Array.isArray(node.children)) for (const c of node.children) walk(c as AnyNode);
    if (INLINE_MARKS.has(node.type) && node.type !== "inlineCode") {
      spans.push({ mark: node.type, start, end: offset });
    }
  };

  walk(root);
  return spans.sort((x, y) => x.start - y.start || x.end - y.end || x.mark.localeCompare(y.mark));
}

export function spanSimilarity(expected: AnyNode, actual: AnyNode): { precision: number; recall: number; f1: number } {
  const key = (s: InlineSpan): string => `${s.mark}:${s.start}-${s.end}`;
  return prf(extractSpans(expected).map(key), extractSpans(actual).map(key));
}
