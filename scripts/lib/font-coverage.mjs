/**
 * Which characters the shipped fonts can actually draw, read from their `cmap` tables.
 *
 * ## Why this exists rather than "did Typst substitute a font"
 *
 * `check-pdf-fonts.mjs` §2 first asked whether rendering a fixture pulled in a face we do not
 * ship. That question is **machine-dependent**, which is the exact property the gate was built
 * to eliminate, and CI proved it within one run of the first push:
 *
 *   | fixture              | Windows dev box            | Linux CI runner          |
 *   | -------------------- | -------------------------- | ------------------------ |
 *   | `unicode-edge-cases` | SimSun, ArialMT, SegoeUI…  | DejaVuSans               |
 *   | `rtl-arabic`         | Arial-BoldMT, ArialMT      | DejaVuSans-Bold, DejaVuSans |
 *   | `cjk-chinese`        | SimSun                     | **nothing at all**       |
 *   | `cjk-japanese`       | SimSun, YuGothic           | **nothing at all**       |
 *
 * The runner has no CJK face installed, so Typst had nothing to substitute *with* and the two
 * CJK fixtures came back looking perfectly closed. The exemption list — written from the
 * Windows column — was then rejected as unearned. Both observations are true; neither is a
 * property of this repository.
 *
 * The machine-independent question is the one the exemption actually claims: **does this
 * document contain a character no shipped font can draw?** That is answerable from the font
 * files alone, so it gives the same answer on every machine, which is what a gate needs.
 *
 * A `cmap` lookup returning glyph 0 is `.notdef` — declared-but-not-drawable — so it counts as
 * uncovered rather than covered. Formats 4 and 12 are implemented because those are what the
 * shipped OTF/TTF files carry; an unrecognised subtable is reported rather than skipped, so a
 * font we cannot read never silently reads as "covers nothing".
 */
import { readFileSync } from "node:fs";

const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

/** Every code point the font can draw, as a Set of numbers. */
export function coveredCodePoints(fontPath) {
  const b = readFileSync(fontPath);
  const numTables = u16(b, 4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString("latin1", rec, rec + 4) === "cmap") cmapOffset = u32(b, rec + 8);
  }
  if (cmapOffset < 0) throw new Error(`${fontPath}: no cmap table`);

  // Prefer a format 12 subtable (full Unicode) over format 4 (BMP only).
  const subtables = [];
  const n = u16(b, cmapOffset + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmapOffset + 4 + i * 8;
    subtables.push({
      platform: u16(b, rec),
      encoding: u16(b, rec + 2),
      offset: cmapOffset + u32(b, rec + 4),
    });
  }

  const covered = new Set();
  let read = 0;
  for (const st of subtables) {
    const format = u16(b, st.offset);
    if (format === 4) {
      readFormat4(b, st.offset, covered);
      read++;
    } else if (format === 12) {
      readFormat12(b, st.offset, covered);
      read++;
    }
  }
  if (read === 0) {
    throw new Error(
      `${fontPath}: no cmap subtable in format 4 or 12 (saw ${subtables.map((s) => u16(b, s.offset)).join(", ")}). ` +
        `Reading it as "covers nothing" would silently mark every document uncoverable.`,
    );
  }
  return covered;
}

function readFormat4(b, off, out) {
  const segX2 = u16(b, off + 6);
  const seg = segX2 / 2;
  const ends = off + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let i = 0; i < seg; i++) {
    const end = u16(b, ends + i * 2);
    const start = u16(b, starts + i * 2);
    if (start > end) continue;
    const delta = u16(b, deltas + i * 2);
    const ro = u16(b, rangeOffsets + i * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid;
      if (ro === 0) {
        gid = (c + delta) & 0xffff;
      } else {
        const gi = rangeOffsets + i * 2 + ro + (c - start) * 2;
        if (gi + 1 >= b.length) continue;
        gid = u16(b, gi);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      // glyph 0 is .notdef: the font declares the code point and cannot draw it.
      if (gid !== 0) out.add(c);
    }
  }
}

function readFormat12(b, off, out) {
  const nGroups = u32(b, off + 12);
  for (let i = 0; i < nGroups; i++) {
    const g = off + 16 + i * 12;
    const start = u32(b, g);
    const end = u32(b, g + 4);
    const startGid = u32(b, g + 8);
    if (startGid === 0) continue;
    for (let c = start; c <= end; c++) out.add(c);
  }
}

/** The union of every shipped face's coverage. */
export function shippedCoverage(fontDir, files) {
  const all = new Set();
  for (const f of files) for (const cp of coveredCodePoints(`${fontDir}/${f}`)) all.add(cp);
  return all;
}

/**
 * Characters in `text` that no shipped face can draw.
 *
 * Whitespace and control characters are excluded: they are laid out rather than drawn, and a
 * font without a glyph for U+000A has not failed at anything.
 */
export function uncoveredIn(text, covered) {
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp < 0x21) continue;
    if (!covered.has(cp)) missing.add(ch);
  }
  return [...missing];
}
