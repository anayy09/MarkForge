/**
 * Layout analysis: positioned glyph runs to lines, columns, blocks.
 *
 * A PDF has no paragraphs, no headings, and no reading order. It has glyphs at
 * coordinates. Everything structural has to be reconstructed, which makes this the
 * only part of MarkForge where the *adapter* infers — and ADR-0012 accepts that
 * because there is no alternative: refusing to infer would mean refusing to read
 * PDFs.
 *
 * The inference is still deterministic and still explainable. Every threshold below
 * is named, derived from the document's own measurements rather than hardcoded in
 * absolute points, and reported in a diagnostic when it decides something ambiguous.
 * A constant tuned to letter-size 11pt body text would be wrong for a two-column
 * A4 paper at 9pt, which is most of the documents anyone wants converted.
 */

/** One positioned text run, as pdf.js reports it. */
export interface TextRun {
  text: string;
  /** Left edge, in PDF points from the page's left. */
  x: number;
  /** Baseline, in PDF points from the page's *top* (already flipped). */
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface Line {
  runs: TextRun[];
  text: string;
  x: number;
  y: number;
  width: number;
  /** The dominant glyph height on this line, used as a font-size proxy. */
  height: number;
}

export interface Column {
  left: number;
  right: number;
  lines: Line[];
}

export interface PageLayout {
  columns: Column[];
  /** Median line height across the page — the body-text size proxy. */
  bodyHeight: number;
  /** Median gap between consecutive lines within a column. */
  bodyLeading: number;
  /**
   * How strongly this page's geometry supported the reading order it produced, 0–1
   * (OPEN_QUESTIONS §7h).
   *
   * Not a probability and not calibrated. It is required only to be **monotonic in the
   * strength of the evidence**, so that "review the least confident pages" and "escalate
   * the bottom decile to a vision model" are sentences that mean something. A flat
   * constant made the field decorative: single-column reading order is near-certain,
   * while two columns separated by a gutter barely wider than a word space is a guess,
   * and both reported the same number.
   */
  readingOrderConfidence: number;
  /** The measurements `readingOrderConfidence` was derived from, for the record. */
  readingOrderEvidence: {
    columnCount: number;
    /** Narrowest gap between adjacent columns, in points. Undefined at one column. */
    narrowestGutterPt?: number;
    /** Median gap between words within a line, in points — the unit of comparison. */
    wordGapPt?: number;
  };
}

/**
 * Groups runs into lines.
 *
 * Runs sharing a baseline within a tolerance are one line. The tolerance is a
 * fraction of glyph height rather than an absolute value, because a superscript or
 * a slightly-raised inline formula sits a point or two off the baseline and must
 * still join its line.
 */
export function groupIntoLines(runs: TextRun[], baselineTolerance = 0.4): Line[] {
  if (runs.length === 0) return [];

  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];

  for (const run of sorted) {
    const tolerance = Math.max(1, run.height * baselineTolerance);
    const existing = lines.find((l) => Math.abs(l.y - run.y) <= tolerance);
    if (existing) existing.runs.push(run);
    else lines.push({ runs: [run], text: "", x: run.x, y: run.y, width: 0, height: run.height });
  }

  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.x = Math.min(...line.runs.map((r) => r.x));
    const right = Math.max(...line.runs.map((r) => r.x + r.width));
    line.width = right - line.x;
    line.height = median(line.runs.map((r) => r.height)) ?? line.height;
    line.text = joinRuns(line.runs);
  }

  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Joins runs into a line's text, inserting spaces where the geometry implies one.
 *
 * PDFs frequently emit each word, or each kerned pair, as a separate run with no
 * space characters at all. Concatenating naively produces `Thequickbrownfox`. The
 * gap threshold is a fraction of the glyph height rather than an absolute width,
 * so it scales with the font.
 */
function joinRuns(runs: TextRun[], gapRatio = 0.2): string {
  let out = "";
  let previousRight: number | undefined;
  let previousHeight = 0;

  for (const run of runs) {
    if (previousRight !== undefined) {
      const gap = run.x - previousRight;
      const threshold = Math.max(previousHeight, run.height) * gapRatio;
      const endsWithSpace = /\s$/.test(out);
      const startsWithSpace = /^\s/.test(run.text);
      if (gap > threshold && !endsWithSpace && !startsWithSpace) out += " ";
    }
    out += run.text;
    previousRight = run.x + run.width;
    previousHeight = run.height;
  }

  return out;
}

/**
 * Detects columns by finding vertical gutters — x-ranges no line crosses.
 *
 * The alternative, clustering line x-positions, fails on the common case of a
 * full-width figure or heading spanning both columns: those lines look like
 * outliers to a clusterer and like exactly what they are to a gutter test.
 *
 * A gutter must be wide enough to be deliberate. `minGutterRatio` is a fraction of
 * page width, because a 20pt gap is a gutter on a narrow page and word spacing on
 * a wide one.
 */
export function detectColumns(
  lines: Line[],
  pageWidth: number,
  options: { minGutterRatio?: number; maxColumns?: number } = {},
): Column[] {
  const minGutter = pageWidth * (options.minGutterRatio ?? 0.03);
  const maxColumns = options.maxColumns ?? 3;

  if (lines.length < 4) return [singleColumn(lines, pageWidth)];

  // Sample occupancy across the page in 1pt buckets, ignoring full-width lines,
  // which by definition cross every gutter and would erase all of them.
  const fullWidthThreshold = pageWidth * 0.75;
  const bodyLines = lines.filter((l) => l.width < fullWidthThreshold);
  if (bodyLines.length < 4) return [singleColumn(lines, pageWidth)];

  const buckets = new Uint8Array(Math.ceil(pageWidth) + 1);
  for (const line of bodyLines) {
    const from = Math.max(0, Math.floor(line.x));
    const to = Math.min(buckets.length - 1, Math.ceil(line.x + line.width));
    for (let i = from; i <= to; i++) buckets[i] = 1;
  }

  // Empty runs inside the occupied span are candidate gutters. Leading and trailing
  // empties are margins, not gutters.
  const firstOccupied = buckets.indexOf(1);
  const lastOccupied = buckets.lastIndexOf(1);
  if (firstOccupied === -1) return [singleColumn(lines, pageWidth)];

  const gutters: { from: number; to: number }[] = [];
  let runStart = -1;
  for (let i = firstOccupied; i <= lastOccupied; i++) {
    if (buckets[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= minGutter) gutters.push({ from: runStart, to: i });
      runStart = -1;
    }
  }

  if (gutters.length === 0 || gutters.length >= maxColumns) {
    return [singleColumn(lines, pageWidth)];
  }

  const bounds: { left: number; right: number }[] = [];
  let left = firstOccupied;
  for (const g of gutters) {
    bounds.push({ left, right: g.from });
    left = g.to;
  }
  bounds.push({ left, right: lastOccupied + 1 });

  const columns: Column[] = bounds.map((b) => ({ left: b.left, right: b.right, lines: [] }));

  for (const line of lines) {
    const centre = line.x + line.width / 2;
    // A full-width line belongs to the first column it starts in, so a spanning
    // heading reads before the columns beneath it rather than being duplicated or
    // dropped.
    const index = columns.findIndex((c) => centre >= c.left && centre <= c.right);
    const target = index === -1 ? nearestColumn(columns, centre) : index;
    columns[target]!.lines.push(line);
  }

  for (const c of columns) c.lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return columns.filter((c) => c.lines.length > 0);
}

function nearestBound(bounds: { left: number; right: number }[], x: number): number {
  let best = 0;
  let bestDistance = Infinity;
  bounds.forEach((b, i) => {
    const d = Math.abs((b.left + b.right) / 2 - x);
    if (d < bestDistance) { bestDistance = d; best = i; }
  });
  return best;
}

function nearestColumn(columns: Column[], x: number): number {
  let best = 0;
  let bestDistance = Infinity;
  columns.forEach((c, i) => {
    const centre = (c.left + c.right) / 2;
    const d = Math.abs(centre - x);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

function singleColumn(lines: Line[], pageWidth: number): Column {
  return { left: 0, right: pageWidth, lines: [...lines].sort((a, b) => a.y - b.y || a.x - b.x) };
}

/**
 * Column bounds from raw *runs*, before any line grouping.
 *
 * Order matters here and it took a failing test to see why: in a two-column layout
 * the two columns share baselines constantly, so grouping runs into lines first
 * merges "left column line one" and "right column line one" into a single
 * full-width line. Every line then looks full-width, the gutter test finds nothing,
 * and the page reads interleaved — which is the single most visible PDF conversion
 * defect (docs/CORPUS.md §2.6), reintroduced by doing two correct steps in the wrong
 * order.
 *
 * So: find the gutters from run positions, assign runs to columns, then group lines
 * inside each column where a shared baseline really does mean one line.
 */
function detectColumnBounds(
  runs: TextRun[],
  pageWidth: number,
  options: { minGutterRatio?: number; maxColumns?: number } = {},
): { left: number; right: number }[] {
  const minGutter = pageWidth * (options.minGutterRatio ?? 0.03);
  const maxColumns = options.maxColumns ?? 3;
  const whole = [{ left: 0, right: pageWidth }];

  // Whitespace-only runs are excluded, and this is the difference between working on
  // two-column documents and not.
  //
  // pdf.js synthesises a run containing a single space to represent a horizontal gap,
  // and gives it the *width of the gap*. On a two-column page that means a 170pt-wide
  // " " sitting exactly across the gutter. Counting it as occupancy fills the gutter,
  // no columns are found, and the page reads interleaved — which looked like a bug in
  // the gutter arithmetic and was actually a helpful parser filling in a blank.
  const glyphRuns = runs.filter((r) => r.text.trim() !== "");
  if (glyphRuns.length < 6) return whole;

  const buckets = new Uint8Array(Math.ceil(pageWidth) + 1);
  for (const run of glyphRuns) {
    const from = Math.max(0, Math.floor(run.x));
    const to = Math.min(buckets.length - 1, Math.ceil(run.x + run.width));
    for (let i = from; i <= to; i++) buckets[i] = 1;
  }

  const firstOccupied = buckets.indexOf(1);
  const lastOccupied = buckets.lastIndexOf(1);
  if (firstOccupied === -1) return whole;

  const gutters: { from: number; to: number }[] = [];
  let runStart = -1;
  for (let i = firstOccupied; i <= lastOccupied; i++) {
    if (buckets[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= minGutter) gutters.push({ from: runStart, to: i });
      runStart = -1;
    }
  }

  if (gutters.length === 0 || gutters.length >= maxColumns) return whole;

  const bounds: { left: number; right: number }[] = [];
  let left = firstOccupied;
  for (const g of gutters) {
    bounds.push({ left, right: g.from });
    left = g.to;
  }
  bounds.push({ left, right: lastOccupied + 1 });
  return bounds;
}

export function analysePage(allRuns: TextRun[], pageWidth: number): PageLayout {
  // Gap-filling whitespace runs are dropped here too, not only from the gutter test.
  // A 170pt-wide space assigned to whichever column its centre lands in would add a
  // stray space to that column's text and skew its measured width.
  const runs = allRuns.filter((r) => r.text.trim() !== "");
  const bounds = detectColumnBounds(runs, pageWidth);

  const columns: Column[] = bounds.map((b) => ({ left: b.left, right: b.right, lines: [] }));
  for (const run of runs) {
    const centre = run.x + run.width / 2;
    const index = bounds.findIndex((b) => centre >= b.left && centre <= b.right);
    const target = index === -1 ? nearestBound(bounds, centre) : index;
    columns[target]!.lines.push({
      runs: [run], text: run.text, x: run.x, y: run.y, width: run.width, height: run.height,
    });
  }

  // Group within each column, where a shared baseline really does mean one line.
  for (const column of columns) {
    column.lines = groupIntoLines(column.lines.flatMap((l) => l.runs));
  }

  const lines = columns.flatMap((c) => c.lines);

  const populated = columns.filter((c) => c.lines.length > 0);
  const heights = lines.map((l) => l.height).filter((h) => h > 0);
  const bodyHeight = median(heights) ?? 11;

  // Leading is measured within a column, not across the page: consecutive lines in
  // different columns have a meaningless vertical gap.
  const gaps: number[] = [];
  for (const column of columns) {
    for (let i = 1; i < column.lines.length; i++) {
      const gap = column.lines[i]!.y - column.lines[i - 1]!.y;
      if (gap > 0 && gap < bodyHeight * 4) gaps.push(gap);
    }
  }
  const bodyLeading = median(gaps) ?? bodyHeight * 1.2;

  const final = populated.length > 0 ? populated : columns;
  const { confidence, evidence } = readingOrderConfidenceOf(final, lines);

  return {
    columns: final,
    bodyHeight,
    bodyLeading,
    readingOrderConfidence: confidence,
    readingOrderEvidence: evidence,
  };
}

/**
 * Reading-order confidence, derived from the geometry that produced the segmentation.
 *
 * The comparison that matters is **gutter width against the page's own word spacing**,
 * not against an absolute point value. A 12pt gap is a decisive column break in 8pt type
 * and is ordinary word spacing in a loosely tracked 18pt display face, so a constant
 * threshold would be confident about the wrong pages. Measuring in units of the
 * document's own word gap makes the number mean the same thing at every size.
 *
 * One column is near-certain but deliberately not 1: text laid out as a table with
 * whitespace reads as a single column and comes back as run-together lines, which is a
 * real failure this measurement cannot see.
 */
function readingOrderConfidenceOf(
  columns: Column[],
  lines: Line[],
): { confidence: number; evidence: PageLayout["readingOrderEvidence"] } {
  const columnCount = columns.length;
  if (columnCount <= 1) {
    return { confidence: 0.95, evidence: { columnCount } };
  }

  const gutters: number[] = [];
  for (let i = 1; i < columns.length; i++) {
    gutters.push(columns[i]!.left - columns[i - 1]!.right);
  }
  const narrowestGutterPt = Math.min(...gutters);
  const wordGapPt = medianWordGap(lines);
  const evidence: PageLayout["readingOrderEvidence"] = {
    columnCount,
    narrowestGutterPt,
    ...(wordGapPt !== undefined ? { wordGapPt } : {}),
  };

  // No measurable word spacing means no unit to compare against, so the segmentation is
  // unsupported rather than merely weak.
  if (wordGapPt === undefined || wordGapPt <= 0) {
    return { confidence: 0.5, evidence };
  }

  // Calibrated against what real pages do rather than against intuition. In 11pt type a
  // word space is about 3pt and a two-column gutter is 20–25pt, so an ordinary academic
  // two-column layout sits near 7x. The dangerous case — justified text whose inter-word
  // spacing stretches far enough to look like a column break — sits at 2–3x. So 2x is
  // where this stops being evidence and 10x is where it stops improving; an earlier
  // version saturated at 6x, which reported a 20pt gutter and an 80pt one as equally
  // certain and would have made the bottom decile meaningless.
  const separation = narrowestGutterPt / wordGapPt;
  const t = Math.max(0, Math.min(1, (separation - 2) / 8));
  return { confidence: round2(0.55 + 0.4 * t), evidence };
}

/** Median gap between adjacent runs on a line: the page's own word-space width. */
function medianWordGap(lines: Line[]): number | undefined {
  const gaps: number[] = [];
  for (const line of lines) {
    for (let i = 1; i < line.runs.length; i++) {
      const gap = line.runs[i]!.x - (line.runs[i - 1]!.x + line.runs[i - 1]!.width);
      // Negative is kerning overlap; a very large gap is a layout column inside the
      // line, not a word space, and would inflate the unit we divide by.
      if (gap > 0 && gap < line.height * 3) gaps.push(gap);
    }
  }
  return median(gaps);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Groups a column's lines into paragraphs.
 *
 * A paragraph break is a vertical gap materially larger than the column's own
 * leading. Using the measured leading rather than a constant is what makes this work
 * across documents: 14pt is a paragraph break in a 10pt single-spaced paper and
 * ordinary leading in a 12pt double-spaced manuscript.
 */
export function groupIntoBlocks(column: Column, leading: number, gapRatio = 1.35): Line[][] {
  const blocks: Line[][] = [];
  let current: Line[] = [];

  for (let i = 0; i < column.lines.length; i++) {
    const line = column.lines[i]!;
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const previous = current[current.length - 1]!;
    const gap = line.y - previous.y;
    const sizeChanged = Math.abs(line.height - previous.height) > previous.height * 0.15;

    // A size change starts a new block even without a gap: a heading immediately
    // followed by body text is one continuous run of baselines but two blocks.
    if (gap > leading * gapRatio || sizeChanged) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * Joins a block's lines into paragraph text, repairing hyphenation.
 *
 * A line ending in `-` where the next line starts lowercase is a hyphenated word
 * split across lines, and joining without repair produces `hyphen- ation`. Only
 * lowercase continuations are joined: `well-` followed by `Known` is a real hyphen
 * in a proper noun, and removing it would be a different kind of wrong.
 */
/**
 * Typographic ligatures, expanded to their component letters.
 *
 * ADR-0012 clause 2, unbuilt from Phase 2 until 2026-08-01. A PDF's text layer stores what the
 * *font* encoded, and a font that renders `fi` as one glyph stores one codepoint — so
 * "efficient" extracts as "eﬃcient" and every downstream consumer sees a word that does not
 * match a search, a diff, or a dictionary. Search is the one users notice.
 *
 * The full Alphabetic Presentation Forms block, not a subset: `ﬅ` and `ﬆ` are rare in English
 * and ordinary in older typesetting, and this corpus includes a pre-1930 scholarly article for
 * exactly that reason.
 *
 * Applied at join time rather than at extraction, because a ligature is a property of the text
 * and not of the layout — the same reasoning that puts hyphenation repair here.
 */
const LIGATURES: ReadonlyMap<string, string> = new Map([
  ["ﬀ", "ff"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"],
  ["ﬄ", "ffl"], ["ﬅ", "st"], ["ﬆ", "st"],
  // Not ligatures but the same class of defect: a font-encoded presentation form that is not
  // the character anyone searches for.
  ["‐", "-"], ["‑", "-"],
]);

export function expandLigatures(text: string): string {
  let out = text;
  for (const [glyph, letters] of LIGATURES) out = out.split(glyph).join(letters);
  return out;
}

export function joinBlockText(lines: Line[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    const next = lines[i + 1];
    if (next && /[a-z]-$/.test(text) && /^[a-z]/.test(next.text)) {
      out += text.slice(0, -1);
      continue;
    }
    out += text;
    if (next) out += " ";
  }
  // Ligatures expanded after joining, so a ligature spanning a hyphenation repair is
  // handled once rather than twice.
  return expandLigatures(out.replace(/\s+/g, " ").trim());
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Running headers and footers, found by cross-page repetition in consistent y-bands.
 *
 * ADR-0012 clause 1, unbuilt from Phase 2 until 2026-08-01. Brief §5.2 asks for "header and
 * footer stripping"; ADR-0002 routes them to `furniture` instead, because stripping violates
 * the no-silent-loss rule — so the destination has existed since Phase 0 and nothing ever
 * wrote to it. The PDF adapter never produced a single `furniture` entry.
 *
 * **Repetition is the only available evidence.** A PDF has no notion of a header: a running
 * title is a line of text near the top of the page, indistinguishable from a heading except
 * that it appears on *every* page in the *same place*. So the rule is:
 *
 *   - the line sits in the top or bottom band of its page (12% by default — a header that
 *     reaches further down is not a running header, it is content);
 *   - a line with the same normalised text, or the same shape with a different number,
 *     appears in the same band on at least half the pages.
 *
 * The second clause is what makes page numbers work: `Page 3 of 12` and `Page 4 of 12` are the
 * same furniture, and comparing raw text would treat every page as unique. Digits are masked
 * before comparison for exactly that reason.
 *
 * **A single-page document has no repetition and therefore no furniture**, which is correct
 * rather than a limitation: with one page there is no evidence that a top line is a running
 * header rather than a title, and inventing one would be structure not evidenced in the
 * source.
 */
export interface FurnitureCandidate {
  pageNumber: number;
  kind: "header" | "footer";
  text: string;
  /** The line, so the caller can exclude it from body content. */
  line: Line;
}

export function detectFurniture(
  pages: { pageNumber: number; layout: PageLayout; height: number }[],
  bandRatio = 0.12,
): FurnitureCandidate[] {
  // One page cannot repeat. Two is the minimum that can, and half of two is one, so the
  // threshold below would accept anything — hence three.
  if (pages.length < 3) return [];

  /** Digits masked, so `Page 3 of 12` and `Page 4 of 12` compare equal. */
  const shape = (text: string): string => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

  const seen = new Map<string, { pages: Set<number>; kind: "header" | "footer" }>();
  const candidates: { key: string; c: FurnitureCandidate }[] = [];

  for (const page of pages) {
    const band = page.height * bandRatio;
    for (const column of page.layout.columns) {
      for (const line of column.lines) {
        // `y` increases downward here: every reading-order sort in this file is
        // ascending by `y`, so small `y` is the top of the page. Stated because PDF's own
        // coordinate space is bottom-left origin and SPEC §2.4 makes `BBox` name its
        // orientation precisely because an unlabelled one silently mixes the two.
        const isHeader = line.y < band;
        const isFooter = line.y > page.height - band;
        if (!isHeader && !isFooter) continue;
        const kind = isHeader ? "header" : "footer";
        const key = `${kind}:${shape(line.text)}`;
        if (shape(line.text) === "") continue;
        const entry = seen.get(key) ?? { pages: new Set<number>(), kind };
        entry.pages.add(page.pageNumber);
        seen.set(key, entry);
        candidates.push({ key, c: { pageNumber: page.pageNumber, kind, text: line.text, line } });
      }
    }
  }

  const threshold = Math.ceil(pages.length / 2);
  return candidates.filter(({ key }) => (seen.get(key)?.pages.size ?? 0) >= threshold).map(({ c }) => c);
}
