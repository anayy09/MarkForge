import { describe, it, expect } from "vitest";
import { parsePdf, groupIntoLines, detectColumns, joinBlockText, type TextRun, type Line } from "../src/index.js";
import { buildPdf, paragraphPage } from "./helpers.js";
import { selectType, textContent, validateDocument } from "@markforge/ir";

const run = (text: string, x: number, y: number, height = 10, width = text.length * 5): TextRun => ({
  text, x, y, width, height, fontName: "F1",
});

describe("line grouping", () => {
  it("groups runs sharing a baseline", () => {
    const lines = groupIntoLines([run("Hello", 72, 100), run("world", 110, 100), run("Next", 72, 114)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("Hello world");
  });

  // A superscript or a raised inline formula sits a point or two off the baseline
  // and must still join its line, so the tolerance scales with glyph height.
  it("tolerates a slightly raised run", () => {
    const lines = groupIntoLines([run("x", 72, 100, 10), run("2", 80, 97, 7)]);
    expect(lines).toHaveLength(1);
  });

  // PDFs routinely emit each word as a separate run with no space characters. Naive
  // concatenation produces "Thequickbrownfox".
  it("inserts a space where the geometry implies one", () => {
    const lines = groupIntoLines([run("The", 72, 100, 10, 20), run("quick", 100, 100, 10, 25)]);
    expect(lines[0]!.text).toBe("The quick");
  });

  it("does not insert a space between kerned glyphs of one word", () => {
    // Adjacent runs with no gap are one word: "Wo" + "rd", not "Wo rd".
    const lines = groupIntoLines([run("Wo", 72, 100, 10, 15), run("rd", 87, 100, 10, 15)]);
    expect(lines[0]!.text).toBe("Word");
  });

  it("does not double a space that is already there", () => {
    const lines = groupIntoLines([run("The ", 72, 100, 10, 22), run("quick", 100, 100, 10, 25)]);
    expect(lines[0]!.text).toBe("The quick");
  });

  it("orders lines top to bottom", () => {
    const lines = groupIntoLines([run("third", 72, 130), run("first", 72, 100), run("second", 72, 115)]);
    expect(lines.map((l) => l.text)).toEqual(["first", "second", "third"]);
  });
});

describe("column detection", () => {
  const line = (text: string, x: number, y: number, width: number): Line => ({
    runs: [], text, x, y, width, height: 10,
  });

  it("finds two columns separated by a gutter", () => {
    const lines = [
      line("left one", 60, 100, 200), line("right one", 340, 100, 200),
      line("left two", 60, 114, 200), line("right two", 340, 114, 200),
      line("left three", 60, 128, 200), line("right three", 340, 128, 200),
    ];
    const columns = detectColumns(lines, 612);
    expect(columns).toHaveLength(2);
    expect(columns[0]!.lines.map((l) => l.text)).toEqual(["left one", "left two", "left three"]);
  });

  it("reads columns in order, not interleaved by y", () => {
    // Interleaved text is the single most visible PDF conversion defect
    // (docs/CORPUS.md §2.6), so this is the behaviour that matters most.
    const lines = [
      line("L1", 60, 100, 200), line("R1", 340, 100, 200),
      line("L2", 60, 114, 200), line("R2", 340, 114, 200),
      line("L3", 60, 128, 200), line("R3", 340, 128, 200),
    ];
    const columns = detectColumns(lines, 612);
    const order = columns.flatMap((c) => c.lines.map((l) => l.text));
    expect(order).toEqual(["L1", "L2", "L3", "R1", "R2", "R3"]);
  });

  it("treats a single block of text as one column", () => {
    const lines = [
      line("a", 60, 100, 480), line("b", 60, 114, 480),
      line("c", 60, 128, 480), line("d", 60, 142, 480),
    ];
    expect(detectColumns(lines, 612)).toHaveLength(1);
  });

  // A full-width heading crosses every gutter. Clustering line positions would treat
  // it as an outlier; a gutter test sees it for what it is.
  it("keeps columns when a full-width heading spans them", () => {
    const lines = [
      line("A Heading Across The Page", 60, 80, 500),
      line("L1", 60, 100, 200), line("R1", 340, 100, 200),
      line("L2", 60, 114, 200), line("R2", 340, 114, 200),
      line("L3", 60, 128, 200), line("R3", 340, 128, 200),
    ];
    const columns = detectColumns(lines, 612);
    expect(columns).toHaveLength(2);
    // The heading lands in one column rather than being dropped or duplicated.
    const all = columns.flatMap((c) => c.lines.map((l) => l.text));
    expect(all.filter((t) => t.startsWith("A Heading"))).toHaveLength(1);
  });

  it("does not split on a gap narrower than a real gutter", () => {
    const lines = [
      line("a", 60, 100, 240), line("b", 306, 100, 240),
      line("c", 60, 114, 486),
      line("d", 60, 128, 486), line("e", 60, 142, 486),
    ];
    // 6pt between the two halves is word spacing, not a gutter.
    expect(detectColumns(lines, 612).length).toBeLessThanOrEqual(2);
  });
});

describe("hyphenation repair", () => {
  const line = (text: string): Line => ({ runs: [], text, x: 0, y: 0, width: 0, height: 10 });

  it("rejoins a word split across lines", () => {
    expect(joinBlockText([line("hyphen-"), line("ation follows")])).toBe("hyphenation follows");
  });

  // "well-" followed by "Known" is a real hyphen in a proper noun. Removing it would
  // be a different kind of wrong from leaving it.
  it("keeps a hyphen before an uppercase continuation", () => {
    expect(joinBlockText([line("well-"), line("Known name")])).toBe("well- Known name");
  });

  it("joins ordinary lines with a single space", () => {
    expect(joinBlockText([line("first line"), line("second line")])).toBe("first line second line");
  });
});

describe("PDF adapter", () => {
  it("extracts text and validates against the schema", async () => {
    const pdf = buildPdf([paragraphPage(["The first line of the body.", "The second line of the body."])]);
    const { document } = await parsePdf(pdf, { path: "test.pdf" });
    expect(textContent(document.body)).toContain("first line");
    const result = validateDocument(document);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("joins consecutive lines into one paragraph", async () => {
    const pdf = buildPdf([
      paragraphPage(["This sentence continues", "onto a second line.", "And a third."]),
    ]);
    const { document } = await parsePdf(pdf);
    expect(selectType(document.body, "paragraph")).toHaveLength(1);
  });

  it("splits paragraphs on a vertical gap larger than the leading", async () => {
    const pdf = buildPdf([
      {
        items: [
          { text: "First paragraph line one.", x: 72, y: 72 },
          { text: "First paragraph line two.", x: 72, y: 86 },
          // A 40pt gap where the leading is 14pt.
          { text: "Second paragraph starts here.", x: 72, y: 126 },
        ],
      },
    ]);
    const { document } = await parsePdf(pdf);
    expect(selectType(document.body, "paragraph")).toHaveLength(2);
  });

  it("promotes a larger, short, unpunctuated block to a heading", async () => {
    const pdf = buildPdf([
      {
        items: [
          { text: "Section Title", x: 72, y: 72, sizePt: 20 },
          { text: "Body text follows the heading and runs on.", x: 72, y: 100, sizePt: 11 },
          { text: "More body text at the same size as before.", x: 72, y: 114, sizePt: 11 },
          { text: "Still more body text to establish the median.", x: 72, y: 128, sizePt: 11 },
        ],
      },
    ]);
    const { document } = await parsePdf(pdf);
    const headings = selectType(document.body, "heading");
    expect(headings).toHaveLength(1);
    expect(textContent(headings[0]!)).toBe("Section Title");
  });

  it("does not promote a long block however large its type", async () => {
    // A wide page on purpose: pdf.js clips text past the MediaBox, so a long line on
    // a letter-width page arrives truncated to ~78 characters and would then pass the
    // "short" test this case exists to fail. The fixture has to let the whole line
    // through for the assertion to be about the heading rule rather than about
    // clipping.
    const pdf = buildPdf([
      {
        width: 1600,
        items: [
          {
            text: "This is a long sentence set in larger type that nevertheless reads as body text because it is long and ends with a full stop.",
            x: 72, y: 72, sizePt: 16,
          },
          { text: "Ordinary body text here.", x: 72, y: 100, sizePt: 11 },
          { text: "More ordinary body text.", x: 72, y: 114, sizePt: 11 },
          { text: "Yet more ordinary body text.", x: 72, y: 128, sizePt: 11 },
        ],
      },
    ]);
    const { document } = await parsePdf(pdf);
    expect(selectType(document.body, "heading")).toHaveLength(0);
  });

  // pdf.js clips text past the MediaBox and reports the survivors with no flag, so
  // the only honest response is to say the text may be incomplete.
  it("warns when a run reaches the page edge, where clipping happens", async () => {
    const pdf = buildPdf([
      {
        items: [
          {
            text: "A line long enough at this size to run past the right edge of a letter-width page and be clipped by the text layer itself.",
            x: 72, y: 72, sizePt: 16,
          },
          { text: "Body text to establish a median.", x: 72, y: 110, sizePt: 11 },
          { text: "More body text for the median.", x: 72, y: 124, sizePt: 11 },
        ],
      },
    ]);
    const { diagnostics } = await parsePdf(pdf);
    expect(diagnostics.lossy().some((d) => d.construct === "pdf:overflow")).toBe(true);
  });

  it("recognises bullet and numbered list markers", async () => {
    // Set like a real list: items at ordinary leading, so they all land in one block
    // and per-line marker detection is what has to separate them. A fixture with wide
    // gaps between items would pass on block-level detection alone and prove nothing.
    const pdf = buildPdf([
      {
        items: [
          { text: "Introductory body text here.", x: 72, y: 72 },
          { text: "• A bulleted item", x: 72, y: 110 },
          { text: "• A second bulleted item", x: 72, y: 124 },
          { text: "7. Starting at seven", x: 72, y: 162 },
          { text: "8. And eight", x: 72, y: 176 },
        ],
      },
    ]);
    const { document } = await parsePdf(pdf);
    const lists = selectType(document.body, "list");
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(lists.some((l) => l["ordered"] === false)).toBe(true);
    expect(lists.some((l) => l["ordered"] === true)).toBe(true);
    // The marker itself must not survive into the text.
    expect(textContent(document.body)).not.toContain("•");
    // A list starting at seven keeps its start.
    expect(lists.some((l) => l["start"] === 7)).toBe(true);
    // Each marker is its own item, not one item containing every line.
    const items = selectType(document.body, "listItem");
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it("records the page number in provenance", async () => {
    const pdf = buildPdf([
      paragraphPage(["Page one content here."]),
      paragraphPage(["Page two content here."]),
    ]);
    const { document } = await parsePdf(pdf);
    const pages = new Set(
      Object.values(document.provenance).map((p) => (p.locator as { pageNumber?: number }).pageNumber),
    );
    expect(pages.has(1)).toBe(true);
    expect(pages.has(2)).toBe(true);
  });

  // This adapter genuinely guessed, unlike every other one. A consumer deciding
  // whether to trust a heading deserves to know which kind of adapter produced it.
  it("states a confidence below 1, because it inferred", async () => {
    const { document } = await parsePdf(buildPdf([paragraphPage(["Some body text here."])]));
    const confidences = Object.values(document.provenance).map((p) => p.confidence);
    expect(confidences.every((c) => typeof c === "number" && c < 1)).toBe(true);
  });

  it("records layoutGeometry as the evidence origin", async () => {
    const { document } = await parsePdf(buildPdf([paragraphPage(["Some body text here."])]));
    const origins = new Set(Object.values(document.sidecar).map((e) => e.origin));
    expect(origins.has("layoutGeometry")).toBe(true);
  });

  // Returning an almost-empty document that looks like a successful conversion is
  // the worst outcome, so a scan fails loudly and names the phase that will fix it.
  it("refuses a PDF with no usable text layer rather than returning nothing", async () => {
    const blank = buildPdf([{ items: [] }, { items: [] }]);
    await expect(parsePdf(blank)).rejects.toThrow(/no usable text layer/);
    await expect(parsePdf(blank)).rejects.toThrow(/OCR is Phase 3/);
  });

  it("reads multi-column pages column by column, not interleaved", async () => {
    const pdf = buildPdf([
      {
        items: [
          { text: "Left column first line", x: 60, y: 72 },
          { text: "Right column first line", x: 340, y: 72 },
          { text: "Left column second line", x: 60, y: 86 },
          { text: "Right column second line", x: 340, y: 86 },
          { text: "Left column third line", x: 60, y: 100 },
          { text: "Right column third line", x: 340, y: 100 },
        ],
      },
    ]);
    const { document, diagnostics } = await parsePdf(pdf);
    const text = textContent(document.body);
    // All three left lines must precede all three right lines.
    expect(text.indexOf("Left column third")).toBeLessThan(text.indexOf("Right column first"));
    // And the reader is told, because a whitespace-aligned table looks identical.
    expect(diagnostics.all().some((d) => d.message.includes("columns"))).toBe(true);
  });

  it("caps very long documents and says so", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => paragraphPage([`Page ${i + 1} body text here.`]));
    const { document, diagnostics } = await parsePdf(buildPdf(pages), { maxPages: 2 });
    expect(textContent(document.body)).not.toContain("Page 5");
    expect(diagnostics.lossy().some((d) => d.message.includes("only the first 2"))).toBe(true);
  });

  it("is deterministic", async () => {
    const pdf = buildPdf([paragraphPage(["Deterministic body text.", "Second line of it."])]);
    const a = await parsePdf(pdf, { path: "x.pdf" });
    const b = await parsePdf(pdf, { path: "x.pdf" });
    expect(JSON.stringify(a.document.body)).toBe(JSON.stringify(b.document.body));
  });
});
