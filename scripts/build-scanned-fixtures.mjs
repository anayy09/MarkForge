// Builds the CORPUS.md §2.7 scanned-PDF corpus: our own authored document, rasterised
// at three DPI equivalents with controlled skew and noise, wrapped in a PDF that has no
// text layer at all.
//
//   node scripts/build-scanned-fixtures.mjs           write every fixture
//   node scripts/build-scanned-fixtures.mjs --check   fail if a committed one drifted
//
// Why synthesize rather than find a scan. CORPUS.md §2.7 asks for both, and the
// synthesized half is the half that can be *measured*: we hold exact ground truth,
// because the raster was produced from a Markdown file in this repo. No real scan comes
// with a transcript, so with a found document "the OCR is 94% accurate" is an opinion.
//
// Two honest limitations, stated here because they bound what these fixtures prove:
//
//   1. **The glyphs are a bitmap font authored below, not a real typeface.** There is no
//      font rasteriser in this repo and adding one — or shipping a TTF we are not
//      licensed to redistribute — is a bigger commitment than this fixture is worth.
//      So absolute OCR accuracy on these files is not comparable to accuracy on a real
//      scan. What *is* comparable: one engine against another on the same bytes, and one
//      DPI against another, which is what the per-DPI baselines are for.
//   2. **Bitonal, like a fax or a document scanner's default**, not 8-bit greyscale.
//      That keeps 600 DPI inside a sane file size and is a realistic scanner output, but
//      it means skew produces hard jaggies rather than antialiased edges.
//
// Determinism is load-bearing twice over. The committed LLM cache is keyed on the page
// image's digest (SPEC §6.3), so a rasteriser that changed its output by one pixel would
// invalidate every recorded vision response. Hence: a seeded PRNG, integer arithmetic,
// no wall clock, no floating-point accumulation across rows.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { generatorControl } from "./lib/control.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");

// --------------------------------------------------------------------------------
// The font: 5x7 cells, one line per glyph, rows separated by `/`.
//
// Written as pictures rather than as hex so a reviewer can see what a glyph looks like
// and fix it without a bitmap editor. Descenders live inside the seven rows, which is
// what 5x7 fonts have always done — cramped but legible, and legibility is measurable
// here rather than assumed: the OCR baselines in docs/FIDELITY.md are the measurement.
// --------------------------------------------------------------------------------
const GLYPHS = {
  " ": "...../...../...../...../...../...../.....",
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".###./#...#/#..../#..../#..../#...#/.###.",
  D: "####./#...#/#...#/#...#/#...#/#...#/####.",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".###./#...#/#..../#.###/#...#/#...#/.###.",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: "#####/..#../..#../..#../..#../..#../#####",
  J: "..###/...#./...#./...#./...#./#..#./.##..",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#...#/#...#/#...#/#...#",
  N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".####/#..../#..../.###./....#/....#/####.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  a: "...../...../.###./....#/.####/#...#/.####",
  b: "#..../#..../####./#...#/#...#/#...#/####.",
  c: "...../...../.####/#..../#..../#..../.####",
  d: "....#/....#/.####/#...#/#...#/#...#/.####",
  e: "...../...../.###./#...#/#####/#..../.###.",
  f: "..##./.#.../.#.../####./.#.../.#.../.#...",
  // Bowl three rows tall with the tail sweeping left, not a right-hanging stem: the
  // first draft's `g` read as a `9` in the rendered page, which put a systematic error
  // into every OCR measurement made against this corpus.
  g: "...../...../.###./#...#/#...#/.####/###..",
  h: "#..../#..../####./#...#/#...#/#...#/#...#",
  i: "..#../...../..#../..#../..#../..#../..#..",
  j: "...#./...../...#./...#./...#./#..#./.##..",
  k: "#..../#..#./#.#../##.../#.#../#..#./#....",
  l: ".##../..#../..#../..#../..#../..#../..###",
  m: "...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#",
  n: "...../...../####./#...#/#...#/#...#/#...#",
  o: "...../...../.###./#...#/#...#/#...#/.###.",
  p: "...../...../####./#...#/#...#/####./#....",
  q: "...../...../.####/#...#/#...#/.####/....#",
  r: "...../...../#.##./##.../#..../#..../#....",
  s: "...../...../.####/#..../.###./....#/####.",
  t: ".#.../.#.../####./.#.../.#.../.#.../..###",
  u: "...../...../#...#/#...#/#...#/#...#/.####",
  v: "...../...../#...#/#...#/#...#/.#.#./..#..",
  w: "...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.",
  x: "...../...../#...#/.#.#./..#../.#.#./#...#",
  y: "...../...../#...#/#...#/.####/....#/.###.",
  z: "...../...../#####/...#./..#../.#.../#####",
  0: ".###./#...#/#..##/#.#.#/##..#/#...#/.###.",
  1: "..#../.##../..#../..#../..#../..#../#####",
  2: ".###./#...#/....#/...#./..#../.#.../#####",
  3: ".###./#...#/....#/..##./....#/#...#/.###.",
  4: "...#./..##./.#.#./#..#./#####/...#./...#.",
  5: "#####/#..../####./....#/....#/#...#/.###.",
  6: "..##./.#.../#..../####./#...#/#...#/.###.",
  7: "#####/....#/...#./..#../.#.../.#.../.#...",
  8: ".###./#...#/#...#/.###./#...#/#...#/.###.",
  9: ".###./#...#/#...#/.####/....#/...#./.##..",
  ".": "...../...../...../...../...../.##../.##..",
  ",": "...../...../...../...../.##../..#../.#...",
  ":": "...../.##../.##../...../.##../.##../.....",
  ";": "...../.##../.##../...../.##../..#../.#...",
  "-": "...../...../...../.###./...../...../.....",
  "'": ".##../.##../..#../...../...../...../.....",
  '"': "##.##/##.##/...../...../...../...../.....",
  "!": "..#../..#../..#../..#../..#../...../..#..",
  "?": ".###./#...#/....#/...#./..#../...../..#..",
  "(": "...#./..#../.#.../.#.../.#.../..#../...#.",
  ")": ".#.../..#../...#./...#./...#./..#../.#...",
  "/": "....#/....#/...#./..#../.#.../#..../#....",
  "%": "#...#/#..#./...#./..#../.#.../.#..#/#...#",
  "&": ".##../#..#./#.#../.#.../#.#.#/#..#./.##.#",
  "+": "...../..#../..#../#####/..#../..#../.....",
  "=": "...../...../#####/...../#####/...../.....",
};

// Characters a source document may use that map onto a glyph we do have. Typographic
// quotes and dashes are the ones that actually turn up, and silently dropping them
// would put a hole in the ground truth.
const FOLD = {
  "’": "'", "‘": "'", "“": '"', "”": '"',
  "—": "-", "–": "-", " ": " ",
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const ADVANCE = 6; // one blank column between glyphs
const LINE_ROWS = 11; // glyph rows plus leading

// --------------------------------------------------------------------------------
// A deliberately restricted Markdown reader.
//
// Three constructs — ATX headings, paragraphs, and `- ` list items — and it *throws* on
// anything else. A rasteriser that quietly skipped a table would produce a fixture whose
// committed ground truth claims content the image does not contain, which is the one
// failure mode that would make every OCR number here meaningless.
// --------------------------------------------------------------------------------
function readSource(markdown) {
  const blocks = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ").replace(/\s+/g, " ").trim() });
    paragraph = [];
  };

  let previousWasItem = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") { flush(); previousWasItem = false; continue; }

    // An indented continuation of a list item. The first draft let this fall through to
    // the paragraph accumulator, so a wrapped list item became a *separate paragraph* in
    // the raster while the committed ground truth still called it one item — the exact
    // silent divergence between image and transcript that would make every OCR number
    // here meaningless. Refusing is better than joining: `markforge fmt` already
    // normalises these fixtures to one line per block, so a continuation line means the
    // file was edited by hand and not reformatted.
    if (previousWasItem && /^\s{2,}\S/.test(raw)) {
      throw new Error(
        `build-scanned-fixtures: line ${index + 1} continues a list item across a line ` +
          `break: ${JSON.stringify(raw)}. Run \`markforge fmt ${SOURCE}\` — this corpus ` +
          `needs one line per block so the raster and the committed ground truth cannot ` +
          `disagree about where a block ends.`,
      );
    }

    const heading = /^(#{1,3}) +(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      previousWasItem = false;
      continue;
    }

    const item = /^- +(.*)$/.exec(line);
    if (item) {
      flush();
      blocks.push({ kind: "listItem", text: item[1].trim() });
      previousWasItem = true;
      continue;
    }

    if (/^[#>|`*_\-+0-9]/.test(line) && !/^[A-Za-z(]/.test(line)) {
      throw new Error(
        `build-scanned-fixtures: line ${index + 1} of the source uses a construct this ` +
          `rasteriser does not draw: ${JSON.stringify(line)}. The fixture's ground truth ` +
          `must be exactly what the image shows, so the source is restricted to ATX ` +
          `headings, paragraphs, and "- " list items rather than silently degraded.`,
      );
    }
    paragraph.push(line.trim());
    previousWasItem = false;
  }
  flush();

  for (const block of blocks) {
    for (const ch of block.text) {
      const folded = FOLD[ch] ?? ch;
      if (!(folded in GLYPHS)) {
        throw new Error(
          `build-scanned-fixtures: no glyph for ${JSON.stringify(ch)} (U+${ch
            .codePointAt(0)
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")}) in ${JSON.stringify(block.text.slice(0, 40))}. Add it to ` +
            `GLYPHS or FOLD — a missing glyph would leave a gap the ground truth claims is text.`,
        );
      }
    }
  }
  return blocks;
}

// --------------------------------------------------------------------------------
// Bitmap: one byte per pixel while drawing (simple), packed to 1bpp on the way out.
// --------------------------------------------------------------------------------
function createBitmap(width, height) {
  return { width, height, ink: new Uint8Array(width * height) };
}

function setPixel(bmp, x, y) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  bmp.ink[y * bmp.width + x] = 1;
}

/** Draws one glyph at `scale`, optionally double-struck one pixel right for bold. */
function drawGlyph(bmp, ch, x, y, scale, bold) {
  const rows = GLYPHS[FOLD[ch] ?? ch].split("/");
  for (let r = 0; r < GLYPH_H; r++) {
    const row = rows[r];
    for (let c = 0; c < GLYPH_W; c++) {
      if (row[c] !== "#") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setPixel(bmp, x + c * scale + dx, y + r * scale + dy);
          if (bold) setPixel(bmp, x + c * scale + dx + 1, y + r * scale + dy);
        }
      }
    }
  }
}

function drawText(bmp, text, x, y, scale, bold) {
  let cursor = x;
  for (const ch of text) {
    drawGlyph(bmp, ch, cursor, y, scale, bold);
    cursor += ADVANCE * scale + (bold ? 1 : 0);
  }
  return cursor;
}

function wrap(text, scale, bold, maxWidth) {
  const advance = ADVANCE * scale + (bold ? 1 : 0);
  const perLine = Math.max(1, Math.floor(maxWidth / advance));
  const words = text.split(" ").filter((w) => w !== "");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= perLine) { current = candidate; continue; }
    if (current !== "") lines.push(current);
    // A word longer than a line is hard-split rather than left to overflow the page,
    // because pdf.js clips at the media box and the ground truth would then claim text
    // no reader could see.
    let rest = word;
    while (rest.length > perLine) {
      lines.push(rest.slice(0, perLine));
      rest = rest.slice(perLine);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// --------------------------------------------------------------------------------
// Layout and rasterisation.
// --------------------------------------------------------------------------------
const PAGE_PT = { width: 612, height: 792 }; // US Letter, matching the rest of the corpus
const MARGIN_PT = 72;

/** Integer scale per DPI, so glyph edges land on pixel boundaries at every size. */
const SCALE_BY_DPI = { 150: 2, 300: 4, 600: 8 };

function rasterise(blocks, dpi, options) {
  const scale = SCALE_BY_DPI[dpi];
  if (!scale) throw new Error(`build-scanned-fixtures: no scale defined for ${dpi} DPI`);
  const pxPerPt = dpi / 72;
  const width = Math.round(PAGE_PT.width * pxPerPt);
  const height = Math.round(PAGE_PT.height * pxPerPt);
  const margin = Math.round(MARGIN_PT * pxPerPt);
  const textWidth = width - 2 * margin;

  const pages = [];
  let bmp = createBitmap(width, height);
  let y = margin;

  const newPage = () => {
    pages.push(bmp);
    bmp = createBitmap(width, height);
    y = margin;
  };

  for (const block of blocks) {
    // Headings are larger and bold; list items are indented and marked. Everything is
    // an integer multiple of the base scale so no size is a rounding artefact.
    const heading = block.kind === "heading";
    const blockScale = heading ? (block.level === 1 ? scale * 2 : block.level === 2 ? scale * 2 - scale / 2 : scale) : scale;
    const glyphScale = Math.max(scale, Math.round(blockScale));
    const bold = heading;
    const indent = block.kind === "listItem" ? ADVANCE * scale * 2 : 0;
    const prefix = block.kind === "listItem" ? "- " : "";
    const lineHeight = LINE_ROWS * glyphScale;
    const spaceBefore = heading ? lineHeight : Math.round(lineHeight * 0.4);

    const lines = wrap(prefix + block.text, glyphScale, bold, textWidth - indent);
    const needed = spaceBefore + lines.length * lineHeight;
    if (y + needed > height - margin) newPage();

    y += spaceBefore;
    for (const [index, line] of lines.entries()) {
      // Continuation lines of a list item align under the text, not under the marker.
      const hang = block.kind === "listItem" && index > 0 ? ADVANCE * glyphScale * 2 : 0;
      drawText(bmp, line, margin + indent + hang, y, glyphScale, bold);
      y += lineHeight;
    }
  }
  pages.push(bmp);

  return pages.map((page) => degrade(page, options));
}

/**
 * Skew and speckle, the two things every scanner adds.
 *
 * Shear rather than true rotation: a shear is exact integer arithmetic per row, so the
 * output is bit-identical on every platform, where a rotation needs trigonometry and
 * would make the committed LLM cache depend on the host's floating-point library.
 */
function degrade(bmp, { skew, speckle, erode, seed }) {
  const out = createBitmap(bmp.width, bmp.height);
  const rand = mulberry32(seed);

  const centre = Math.floor(bmp.height / 2);
  for (let y = 0; y < bmp.height; y++) {
    const shift = Math.round((y - centre) * skew);
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.ink[y * bmp.width + x] === 1) setPixel(out, x + shift, y);
    }
  }

  for (let i = 0; i < out.ink.length; i++) {
    const r = rand();
    if (out.ink[i] === 1) {
      // Dropout inside a stroke: what a scanner does to thin ink.
      if (r < erode) out.ink[i] = 0;
    } else if (r < speckle) {
      out.ink[i] = 1;
    }
  }
  return out;
}

/** Deterministic PRNG. Any seeded generator would do; this one is small and stateless. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Packs to 1 bit per pixel, MSB first, rows padded to a byte — PDF's image layout. */
function packBitonal(bmp) {
  const rowBytes = Math.ceil(bmp.width / 8);
  const out = new Uint8Array(rowBytes * bmp.height).fill(0xff); // 1 = white in DeviceGray
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.ink[y * bmp.width + x] !== 1) continue;
      const index = y * rowBytes + (x >> 3);
      out[index] &= ~(0x80 >> (x & 7));
    }
  }
  return out;
}

// --------------------------------------------------------------------------------
// A minimal PDF writer: one full-page image per page, and no text layer whatsoever.
//
// Hand-written rather than via a library because the point of the fixture is what the
// file does *not* contain. A generator that helpfully embedded an invisible text layer —
// which is what every "searchable PDF" pipeline does — would make the scan detection it
// is meant to exercise trivially succeed.
// --------------------------------------------------------------------------------
function buildPdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const catalog = add(null); // 1, patched once the pages object number is known
  const pagesObj = add(null); // 2
  const kids = [];

  for (const page of pages) {
    const packed = packBitonal(page);
    const compressed = deflateSync(Buffer.from(packed), { level: 9 });
    const image = add({
      dict:
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode ` +
        `/Length ${compressed.length} >>`,
      stream: compressed,
    });
    const content = Buffer.from(
      `q ${PAGE_PT.width} 0 0 ${PAGE_PT.height} 0 0 cm /Im0 Do Q\n`,
      "latin1",
    );
    const contents = add({
      dict: `<< /Length ${content.length} >>`,
      stream: content,
    });
    const pageObj = add({
      dict:
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_PT.width} ${PAGE_PT.height}] ` +
        `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`,
    });
    kids.push(`${pageObj} 0 R`);
  }

  objects[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesObj} 0 R >>` };
  objects[pagesObj - 1] = {
    dict: `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`,
  };

  const chunks = [];
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };

  push(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));

  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    push(Buffer.from(`${index + 1} 0 obj\n${object.dict}\n`, "latin1"));
    if (object.stream) {
      push(Buffer.from("stream\n", "latin1"));
      push(Buffer.from(object.stream));
      push(Buffer.from("\nendstream\n", "latin1"));
    }
    push(Buffer.from("endobj\n", "latin1"));
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  // No /ID and no /Info: both are where a generator usually puts a timestamp, and a
  // fixture that changed every time it was built could not be committed or cached.
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(Buffer.from(xref, "latin1"));

  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------------------
// The fixtures.
//
// Only 150 DPI is committed. CORPUS.md §4 says anything genuinely large — and it names
// 600 DPI scans specifically — is produced by a committed deterministic script instead of
// living in git history forever. The higher two land in the gitignored
// fixtures/generated/, and CI runs this script to make them.
// --------------------------------------------------------------------------------
const SOURCE = "fixtures/md/scanned-source.md";

const VARIANTS = [
  {
    dpi: 150,
    out: "fixtures/pdf/scanned-150dpi.pdf",
    committed: true,
    // Mild: what a decent office scanner produces on a good day.
    degrade: { skew: 0.004, speckle: 0.0009, erode: 0.02, seed: 20260731 },
  },
  {
    dpi: 300,
    out: "fixtures/generated/scanned-300dpi.pdf",
    committed: false,
    degrade: { skew: 0.007, speckle: 0.0012, erode: 0.03, seed: 20260732 },
  },
  {
    dpi: 600,
    out: "fixtures/generated/scanned-600dpi.pdf",
    committed: false,
    // Worst of the three on purpose: more skew and more speckle at the DPI where a
    // reader has the most pixels to work with, so resolution and degradation are not
    // confounded into a single "better scan is better" story.
    degrade: { skew: 0.011, speckle: 0.0016, erode: 0.04, seed: 20260733 },
  },
];

const blocks = readSource(readFileSync(join(REPO, SOURCE), "utf8"));
let failures = 0;
/** Kept so the negative control can mutate one, rather than trusting the loop above it. */
const built = {};
let checkedCommitted = 0;

for (const variant of VARIANTS) {
  const pages = rasterise(blocks, variant.dpi, variant.degrade);
  const pdf = buildPdf(pages);
  built[variant.out] = new Uint8Array(pdf);
  if (variant.committed) checkedCommitted++;
  const path = join(REPO, variant.out);
  const digest = createHash("sha256").update(pdf).digest("hex").slice(0, 16);
  const label = `${variant.out}  ${pages.length} page(s)  ${(pdf.length / 1024).toFixed(1)} KiB  ${digest}`;

  if (CHECK) {
    if (!variant.committed) { console.log(`skip  ${label} (generated, not committed)`); continue; }
    if (!existsSync(path)) { console.log(`FAIL  ${variant.out} is missing`); failures++; continue; }
    const current = readFileSync(path);
    if (!current.equals(pdf)) {
      console.log(
        `FAIL  ${variant.out} does not match its generator — rerun ` +
          `node scripts/build-scanned-fixtures.mjs and commit`,
      );
      failures++;
    } else console.log(`ok    ${label}`);
    continue;
  }

  mkdirSync(join(REPO, variant.out.replace(/\/[^/]+$/, "")), { recursive: true });
  writeFileSync(path, pdf);
  console.log(`wrote ${label}`);
}

if (CHECK) {
  // Negative control, added in the Phase 6 gate audit. This gate is the one where vacuity
  // would do the most damage: two of the three variants are `skip`ped by design, so the
  // whole check rests on a single committed file, and a `committed: false` typo would turn
  // the run into three skips and a clean verdict. The committed LLM cache is keyed on the
  // page image's digest, so a rasteriser that drifted by one pixel and went unnoticed here
  // would surface later as a model failure rather than as a fixture change.
  console.log("\nNegative control");
  const ctlOk = (m) => console.log(`ok    ${m}`);
  const ctlFail = (m) => { console.log(`FAIL  ${m}`); failures++; };

  if (checkedCommitted >= 1) ctlOk(`${checkedCommitted} committed variant(s) actually compared`);
  else ctlFail("0 committed variants were compared — every variant skipped and the gate still passed");

  generatorControl({ artifacts: built, floor: 3, ok: ctlOk, fail: ctlFail });

  console.log(failures === 0 ? "\nScanned corpus matches its generator." : `\n${failures} fixture(s) drifted.`);
  process.exit(failures === 0 ? 0 : 1);
}
