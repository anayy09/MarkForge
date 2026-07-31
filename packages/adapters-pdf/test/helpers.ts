/**
 * Builds minimal, uncompressed PDFs in memory.
 *
 * Authored rather than committed as binaries, for the reason `docs/CORPUS.md` §1
 * rule 3 gives: we control exactly which construct is under test. A found PDF
 * exercises twenty things at once and tells you nothing about which one regressed.
 *
 * Text is placed by absolute coordinate, which is the whole point — layout analysis
 * is the thing being tested, and a helper that let us declare "a heading" would test
 * nothing.
 */

export interface TextItem {
  text: string;
  /** Points from the page's left edge. */
  x: number;
  /** Points from the page's *top* edge; converted to PDF's bottom-origin here. */
  y: number;
  sizePt?: number;
}

export interface PageSpec {
  items: TextItem[];
  width?: number;
  height?: number;
}

/**
 * WinAnsi code points for the non-ASCII characters these fixtures need.
 *
 * A standard-14 font such as Helvetica uses WinAnsiEncoding, so writing the content
 * stream as UTF-8 makes a bullet (U+2022, three UTF-8 bytes) arrive as three
 * unrelated glyphs — the first run of this helper produced "¢" where "•" was
 * intended. Each character maps to its single WinAnsi byte instead, written as an
 * octal escape so the file itself stays ASCII.
 */
const WIN_ANSI: Record<string, number> = {
  "\u2022": 0x95, // bullet
  "\u00b7": 0xb7, // middle dot
  "\u2013": 0x96, // en dash
  "\u2014": 0x97, // em dash
  "\u2018": 0x91,
  "\u2019": 0x92,
  "\u201c": 0x93,
  "\u201d": 0x94,
  "\u2026": 0x85, // ellipsis
};

/** Escapes a PDF string literal, mapping non-ASCII through WinAnsi. */
const pdfString = (s: string): string => {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") { out += "\\\\"; continue; }
    if (ch === "(") { out += "\\("; continue; }
    if (ch === ")") { out += "\\)"; continue; }
    const code = WIN_ANSI[ch];
    if (code !== undefined) { out += "\\" + code.toString(8).padStart(3, "0"); continue; }
    out += (ch.codePointAt(0) ?? 63) < 128 ? ch : "?";
  }
  return out;
};

export function buildPdf(pages: PageSpec[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 1-based object numbers
  };

  // Object 1 is the catalog and 2 is the page tree; both need forward references, so
  // they are reserved before the pages exist.
  objects.push("", "");

  // /Encoding is required, not optional. Without it Helvetica uses StandardEncoding,
  // where byte 0x95 is undefined — so a bullet written as WinAnsi 0x95 arrives as
  // nothing at all, and a list silently becomes a paragraph. This took two rounds of
  // debugging to find because the failure is a *missing* character rather than a wrong
  // one.
  const fontObj = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  );

  const pageObjs: number[] = [];
  for (const page of pages) {
    const width = page.width ?? 612;
    const height = page.height ?? 792;

    const ops = page.items
      .map((item) => {
        const size = item.sizePt ?? 12;
        // PDF's origin is bottom-left; the helper takes y from the top so tests read
        // the way a document does.
        const y = height - item.y;
        return `BT /F1 ${size} Tf 1 0 0 1 ${item.x} ${y} Tm (${pdfString(item.text)}) Tj ET`;
      })
      .join("\n");

    const contentObj = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageObjs.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Contents ${contentObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
      ),
    );
  }

  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] =
    `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjs.length} >>`;

  // Serialise with a real xref table. pdf.js can often reconstruct a broken one, but
  // relying on its recovery path would mean testing the recovery path.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += `0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(out);
}

/** A page of body text at a fixed leading, for the common case. */
export function paragraphPage(
  lines: string[],
  options: { x?: number; startY?: number; leading?: number; sizePt?: number } = {},
): PageSpec {
  const x = options.x ?? 72;
  const leading = options.leading ?? 14;
  const startY = options.startY ?? 72;
  return {
    items: lines.map((text, i) => ({
      text,
      x,
      y: startY + i * leading,
      ...(options.sizePt !== undefined ? { sizePt: options.sizePt } : {}),
    })),
  };
}
