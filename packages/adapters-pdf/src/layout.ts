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

  return { columns: populated.length > 0 ? populated : columns, bodyHeight, bodyLeading };
}

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
  return out.replace(/\s+/g, " ").trim();
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
