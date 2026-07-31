import { describe, it, expect } from "vitest";
import { parsePptx, parseXlsx, parseCellRef } from "../src/index.js";
import { OpcPackage } from "@markforge/ooxml";
import { selectType, textContent, validateDocument, type AnyNode } from "@markforge/ir";

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** EMU per point, so tests can state positions in readable units. */
const pt = (n: number): number => n * 12700;

function shape(
  text: string,
  opts: { x?: number; y?: number; title?: boolean; level?: number; bullet?: boolean; bold?: boolean } = {},
): string {
  const ph = opts.title ? `<p:ph type="title"/>` : "";
  const pPr =
    opts.level !== undefined || opts.bullet === false
      ? `<a:pPr${opts.level ? ` lvl="${opts.level}"` : ""}>${opts.bullet === false ? "<a:buNone/>" : ""}</a:pPr>`
      : "";
  const rPr = opts.bold ? `<a:rPr b="1"/>` : "";
  return (
    `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${pt(opts.x ?? 0)}" y="${pt(opts.y ?? 0)}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:p>${pPr}<a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function buildPptx(slides: string[], notes: Record<number, string> = {}): Uint8Array {
  const pkg = OpcPackage.create();
  pkg.set(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  slides.forEach((body, i) => {
    pkg.set(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld ${P} ${A}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  for (const [n, text] of Object.entries(notes)) {
    pkg.set(
      `ppt/notesSlides/notesSlide${n}.xml`,
      `<?xml version="1.0"?><p:notes ${P} ${A}><p:cSld><p:spTree>${shape(text)}</p:spTree></p:cSld></p:notes>`,
    );
  }
  return pkg.toBytes();
}

describe("PPTX adapter", () => {
  it("produces a document that validates against the schema", () => {
    const { document } = parsePptx(buildPptx([shape("Title", { title: true }) + shape("Body")]));
    const result = validateDocument(document);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("makes one slide node per slide", () => {
    const { document } = parsePptx(buildPptx([shape("one"), shape("two"), shape("three")]));
    expect(selectType(document.body, "slide")).toHaveLength(3);
  });

  // Lexicographic sorting puts slide10 between slide1 and slide2, silently
  // reordering any deck with ten or more slides.
  it("orders slides numerically, not lexicographically", () => {
    const { document } = parsePptx(buildPptx(Array.from({ length: 12 }, (_, i) => shape(`s${i + 1}`))));
    const slides = selectType(document.body, "slide");
    expect(slides).toHaveLength(12);
    expect(textContent(slides[1]!)).toContain("s2");
    expect(textContent(slides[9]!)).toContain("s10");
  });

  it("promotes a title placeholder to a heading", () => {
    const { document } = parsePptx(buildPptx([shape("The Title", { title: true }) + shape("body text")]));
    const headings = selectType(document.body, "heading");
    expect(headings).toHaveLength(1);
    expect(textContent(headings[0]!)).toBe("The Title");
  });

  // A title placeholder is sometimes positioned below other content while still
  // being the slide's heading, so geometry alone gets reading order wrong.
  it("reads the title first even when it sits lower on the slide", () => {
    const { document } = parsePptx(
      buildPptx([shape("body", { y: 10 }) + shape("Title", { y: 400, title: true })]),
    );
    const text = textContent(document.body);
    expect(text.indexOf("Title")).toBeLessThan(text.indexOf("body"));
  });

  it("orders shapes top-to-bottom then left-to-right", () => {
    const { document } = parsePptx(
      buildPptx([
        shape("bottom", { y: 300, x: 0 }) +
          shape("top-right", { y: 10, x: 400 }) +
          shape("top-left", { y: 12, x: 0 }),
      ]),
    );
    const text = textContent(document.body);
    // top-left and top-right are within the row tolerance, so they read as a row.
    expect(text.indexOf("top-left")).toBeLessThan(text.indexOf("top-right"));
    expect(text.indexOf("top-right")).toBeLessThan(text.indexOf("bottom"));
  });

  // PowerPoint's default for a body paragraph is a bullet. Treating it as a plain
  // paragraph would flatten every deck into prose.
  it("treats body paragraphs as bullets unless buNone says otherwise", () => {
    const bulleted = parsePptx(buildPptx([shape("point")])).document;
    expect(selectType(bulleted.body, "list")).toHaveLength(1);

    const plain = parsePptx(buildPptx([shape("prose", { bullet: false })])).document;
    expect(selectType(plain.body, "list")).toHaveLength(0);
    expect(selectType(plain.body, "paragraph").length).toBeGreaterThan(0);
  });

  it("reads run formatting from DrawingML attributes", () => {
    // DrawingML spells bold as an attribute on rPr, not a child element the way
    // WordprocessingML does.
    const { document } = parsePptx(buildPptx([shape("strong text", { bold: true })]));
    expect(selectType(document.body, "strong")).toHaveLength(1);
  });

  it("keeps speaker notes, which carry half the argument", () => {
    const { document } = parsePptx(buildPptx([shape("Slide body")], { 1: "The speaker note" }));
    expect(textContent(document.body)).toContain("The speaker note");
    expect(selectType(document.body, "admonition")).toHaveLength(1);
  });

  it("reads a table on a slide, including merges", () => {
    const table =
      `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/></p:xfrm><a:graphic><a:graphicData><a:tbl>` +
      `<a:tblPr firstRow="1"/>` +
      `<a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>wide</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>a</a:t></a:r></a:p></a:txBody></a:tc>` +
      `<a:tc><a:txBody><a:p><a:r><a:t>b</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const { document } = parsePptx(buildPptx([table]));
    const cells = selectType(document.body, "tableCell");
    expect(cells[0]!["colSpan"]).toBe(2);
    expect(selectType(document.body, "table")[0]!["headerRowCount"]).toBe(1);
  });

  it("reports a chart as lost rather than dropping it", () => {
    const chart =
      `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="chart"><c:chart/></a:graphicData></a:graphic></p:graphicFrame>`;
    const { document, diagnostics } = parsePptx(buildPptx([chart]));
    expect(selectType(document.body, "unknown")).toHaveLength(1);
    expect(diagnostics.lossy().length).toBeGreaterThan(0);
  });

  it("rejects a ZIP that is not a presentation", () => {
    const notPptx = OpcPackage.create({ "word/document.xml": "<x/>" }).toBytes();
    expect(() => parsePptx(notPptx)).toThrow(/not a PresentationML/);
  });

  it("is deterministic", () => {
    const bytes = buildPptx([shape("Title", { title: true }) + shape("body")]);
    const a = parsePptx(bytes).document;
    const b = parsePptx(bytes).document;
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });
});

// --- XLSX -------------------------------------------------------------------

function buildXlsx(opts: {
  sheets: { name: string; rows: string }[];
  shared?: string[];
  merges?: string[];
}): Uint8Array {
  const pkg = OpcPackage.create();
  pkg.set(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  pkg.set(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook ${S}><sheets>` +
      opts.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
  );
  if (opts.shared) {
    pkg.set(
      "xl/sharedStrings.xml",
      `<?xml version="1.0"?><sst ${S}>` + opts.shared.map((t) => `<si><t>${t}</t></si>`).join("") + `</sst>`,
    );
  }
  opts.sheets.forEach((s, i) => {
    const merges = opts.merges && i === 0
      ? `<mergeCells>${opts.merges.map((r) => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`
      : "";
    pkg.set(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0"?><worksheet ${S}><sheetData>${s.rows}</sheetData>${merges}</worksheet>`,
    );
  });
  return pkg.toBytes();
}

const row = (n: number, cells: string): string => `<row r="${n}">${cells}</row>`;
const num = (ref: string, v: string): string => `<c r="${ref}"><v>${v}</v></c>`;
const str = (ref: string, index: number): string => `<c r="${ref}" t="s"><v>${index}</v></c>`;
const formula = (ref: string, f: string, cached: string): string =>
  `<c r="${ref}"><f>${f}</f><v>${cached}</v></c>`;

describe("XLSX adapter", () => {
  it("produces a document that validates against the schema", () => {
    const { document } = parseXlsx(
      buildXlsx({ sheets: [{ name: "Data", rows: row(1, num("A1", "1")) }] }),
    );
    const result = validateDocument(document);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("makes one sheet node per worksheet, named", () => {
    const { document } = parseXlsx(
      buildXlsx({
        sheets: [
          { name: "First", rows: row(1, num("A1", "1")) },
          { name: "Second", rows: row(1, num("A1", "2")) },
        ],
      }),
    );
    const sheets = selectType(document.body, "sheet");
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!["name"]).toBe("First");
    expect(textContent(document.body)).toContain("Second");
  });

  // Without the shared-string table, a spreadsheet of text reads as a grid of
  // integers — the indices.
  it("resolves shared strings", () => {
    const { document } = parseXlsx(
      buildXlsx({
        shared: ["Alpha", "Beta"],
        sheets: [{ name: "S", rows: row(1, str("A1", 0) + str("B1", 1)) }],
      }),
    );
    const text = textContent(document.body);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
  });

  it("concatenates rich-text runs in a shared string", () => {
    const pkg = OpcPackage.create();
    pkg.set("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
    pkg.set("xl/workbook.xml", `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`);
    pkg.set("xl/sharedStrings.xml", `<?xml version="1.0"?><sst ${S}><si><r><t>Hello </t></r><r><t>world</t></r></si></sst>`);
    pkg.set("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet ${S}><sheetData>${row(1, str("A1", 0))}</sheetData></worksheet>`);
    const { document } = parseXlsx(pkg.toBytes());
    // Taking only the first run would truncate every formatted cell at its first
    // formatting change.
    expect(textContent(document.body)).toContain("Hello world");
  });

  // The stated decision: the displayed value survives, the formula does not, and a
  // diagnostic says so rather than the loss being silent.
  it("emits the cached result and reports the dropped formula", () => {
    const { document, diagnostics } = parseXlsx(
      buildXlsx({ sheets: [{ name: "S", rows: row(1, formula("A1", "SUM(B1:B9)", "42")) }] }),
    );
    expect(textContent(document.body)).toContain("42");
    expect(textContent(document.body)).not.toContain("SUM");
    const diag = diagnostics.lossy().find((d) => d.construct === "formula");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("cached results");
  });

  // Spreadsheets omit empty cells, so A1,C1 means B1 is blank. Skipping the gap
  // would shift C1 into B1's column.
  it("reconstructs sparse rows so columns stay aligned", () => {
    const { document } = parseXlsx(
      buildXlsx({ sheets: [{ name: "S", rows: row(1, num("A1", "1") + num("C1", "3")) }] }),
    );
    const cells = selectType(document.body, "tableCell");
    expect(cells).toHaveLength(3);
    expect(textContent(cells[1]!)).toBe("");
    expect(textContent(cells[2]!)).toBe("3");
  });

  it("turns merged ranges into rowSpan and colSpan", () => {
    const { document } = parseXlsx(
      buildXlsx({
        merges: ["A1:B1"],
        sheets: [{ name: "S", rows: row(1, num("A1", "1") + num("B1", "2")) }],
      }),
    );
    const cells = selectType(document.body, "tableCell");
    // Two grid positions, one cell: the covered position is not emitted, which is
    // what keeps later columns from shifting.
    expect(cells).toHaveLength(1);
    expect(cells[0]!["colSpan"]).toBe(2);
  });

  it("reads booleans as TRUE and FALSE", () => {
    const { document } = parseXlsx(
      buildXlsx({ sheets: [{ name: "S", rows: row(1, `<c r="A1" t="b"><v>1</v></c>`) }] }),
    );
    expect(textContent(document.body)).toContain("TRUE");
  });

  it("caps very large sheets and says so", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, num(`A${i + 1}`, String(i)))).join("");
    const { document, diagnostics } = parseXlsx(buildXlsx({ sheets: [{ name: "Big", rows }] }), {
      maxRows: 10,
    });
    expect(selectType(document.body, "tableRow")).toHaveLength(10);
    expect(diagnostics.lossy().some((d) => d.message.includes("only the first 10"))).toBe(true);
  });

  // A5: row 1 being a header is a convention, not a fact in the file.
  it("does not assume row 1 is a header", () => {
    const { document } = parseXlsx(
      buildXlsx({ sheets: [{ name: "S", rows: row(1, num("A1", "1")) + row(2, num("A2", "2")) }] }),
    );
    expect(selectType(document.body, "table")[0]!["headerRowCount"]).toBeUndefined();
  });

  it("rejects a ZIP that is not a workbook", () => {
    expect(() => parseXlsx(OpcPackage.create({ "word/document.xml": "<x/>" }).toBytes())).toThrow(
      /not a SpreadsheetML/,
    );
  });
});

describe("cell reference parsing", () => {
  it("handles single and multi-letter columns", () => {
    expect(parseCellRef("A1")).toEqual({ col: 0, row: 0 });
    expect(parseCellRef("B2")).toEqual({ col: 1, row: 1 });
    expect(parseCellRef("Z1")).toEqual({ col: 25, row: 0 });
    // Base-26 with no zero digit: AA is 26, not 27.
    expect(parseCellRef("AA1")).toEqual({ col: 26, row: 0 });
    expect(parseCellRef("AB1")).toEqual({ col: 27, row: 0 });
  });

  it("returns undefined for a malformed reference", () => {
    expect(parseCellRef("1A")).toBeUndefined();
    expect(parseCellRef("")).toBeUndefined();
  });
});
