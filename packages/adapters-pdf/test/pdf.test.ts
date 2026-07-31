import { describe, it, expect } from "vitest";
import { analysePage, parsePdf, readPdf, groupIntoLines, detectColumns, joinBlockText, type TextRun, type Line } from "../src/index.js";
import { buildPdf, paragraphPage } from "./helpers.js";
import { checkUnknownNodesDiagnosed, selectType, textContent, validateDocument } from "@markforge/ir";

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

  // OPEN_QUESTIONS §7h. A constant 0.8 on every inference made the field decorative:
  // reading order in a clean single-column page is near-certain, column segmentation
  // across a narrow gutter is a guess, and both reported the same number. These assert
  // the property the reviewer actually asked for — the value is monotonic in the
  // strength of the evidence — rather than any particular calibration.
  describe("confidence is derived from the evidence", () => {
    /** Confidence of the first node whose text matches. */
    const confidenceOf = async (pdf: Uint8Array, needle: string): Promise<number> => {
      const { document } = await parsePdf(pdf);
      const children = (document.body as { children: { id?: string }[] }).children;
      for (const child of children) {
        if (!textContent(child as never).includes(needle)) continue;
        return document.provenance[child.id as string]!.confidence as number;
      }
      throw new Error(`no node containing ${JSON.stringify(needle)}`);
    };

    /**
     * A lead block, then body at ordinary leading with a wide gap between.
     *
     * The gap has to be generous: `groupIntoBlocks` splits on a vertical gap materially
     * larger than the column's own measured leading, so a lead line only 28pt above
     * 18pt-leaded body lands in the *same* block and the test would measure a paragraph
     * containing everything.
     */
    const leadThenBody = (lead: { text: string; sizePt: number }) =>
      buildPdf([
        {
          items: [
            { text: lead.text, x: 72, y: 72, sizePt: lead.sizePt },
            { text: "Body text establishing the document median size.", x: 72, y: 140, sizePt: 11 },
            { text: "A second sentence of ordinary body prose here.", x: 72, y: 158, sizePt: 11 },
            { text: "A third sentence, so the leading is unambiguous.", x: 72, y: 176, sizePt: 11 },
            { text: "A fourth, which fixes the median gap at eighteen.", x: 72, y: 194, sizePt: 11 },
          ],
        },
      ]);

    it("is more confident about a clearly oversized heading than a marginal one", async () => {
      // 11pt body. 12.7pt is 1.15x — only just over the threshold. 22pt is not in doubt.
      const marginal = await confidenceOf(
        leadThenBody({ text: "Marginal Heading", sizePt: 12.7 }),
        "Marginal Heading",
      );
      const obvious = await confidenceOf(
        leadThenBody({ text: "Obvious Heading", sizePt: 22 }),
        "Obvious Heading",
      );
      expect(obvious).toBeGreaterThan(marginal);
    });

    it("is less confident about a paragraph that nearly became a heading", async () => {
      // Short, no terminal punctuation, single line, but below the size threshold —
      // three of the four heading signals. Exactly what a reviewer should look at.
      const nearMiss = await confidenceOf(
        leadThenBody({ text: "Results And Discussion", sizePt: 11 }),
        "Results And Discussion",
      );
      const plainBody = await confidenceOf(
        leadThenBody({ text: "A lead sentence that ends in a full stop.", sizePt: 11 }),
        "A lead sentence",
      );
      expect(nearMiss).toBeLessThan(plainBody);
    });

    it("is more confident about a wide gutter than a narrow one", () => {
      const twoColumns = (gutterPt: number) => {
        const rightX = 72 + 200 + gutterPt;
        const lines: Line[] = [];
        for (let i = 0; i < 4; i++) {
          const y = 100 + i * 14;
          lines.push({ runs: [], text: `left ${i}`, x: 72, y, width: 200, height: 10 });
          lines.push({ runs: [], text: `right ${i}`, x: rightX, y, width: 200, height: 10 });
        }
        return lines;
      };
      // detectColumns is the segmentation; analysePage is what scores it. Drive the
      // scorer through a real page so the word-gap unit is measured, not supplied.
      const page = (gutterPt: number) => {
        const runs: TextRun[] = [];
        const rightX = 72 + 200 + gutterPt;
        for (let i = 0; i < 4; i++) {
          const y = 100 + i * 14;
          // Two runs per line, 3pt apart: that 3pt is the page's word-space unit.
          runs.push(run("left", 72, y, 10, 98), run("side", 173, y, 10, 99));
          runs.push(run("right", rightX, y, 10, 98), run("side", rightX + 101, y, 10, 99));
        }
        return analysePage(runs, 612);
      };
      expect(twoColumns(60)).toHaveLength(8); // the helper is sane
      const wide = page(80);
      const narrow = page(20);
      expect(wide.columns.length).toBe(2);
      expect(narrow.columns.length).toBe(2);
      expect(wide.readingOrderConfidence).toBeGreaterThan(narrow.readingOrderConfidence);
      // And the measurements behind the number are recorded, not just the number.
      expect(wide.readingOrderEvidence.narrowestGutterPt).toBeGreaterThan(
        narrow.readingOrderEvidence.narrowestGutterPt!,
      );
      expect(wide.readingOrderEvidence.wordGapPt).toBeGreaterThan(0);
    });

    it("treats a single column as near-certain, and never as certain", () => {
      const runs: TextRun[] = [];
      for (let i = 0; i < 4; i++) runs.push(run("a single column of text", 72, 100 + i * 14, 10, 400));
      const layout = analysePage(runs, 612);
      expect(layout.columns).toHaveLength(1);
      expect(layout.readingOrderConfidence).toBeGreaterThan(0.9);
      // Never 1: whitespace-laid-out tables read as one column and come back wrong.
      expect(layout.readingOrderConfidence).toBeLessThan(1);
    });

    it("does not report one value for every node, which is the whole point", async () => {
      const { document } = await parsePdf(
        leadThenBody({ text: "A Clear Section Heading", sizePt: 20 }),
      );
      const distinct = new Set(Object.values(document.provenance).map((p) => p.confidence));
      expect(distinct.size).toBeGreaterThan(1);
    });
  });

  it("records layoutGeometry as the evidence origin", async () => {
    const { document } = await parsePdf(buildPdf([paragraphPage(["Some body text here."])]));
    const origins = new Set(Object.values(document.sidecar).map((e) => e.origin));
    expect(origins.has("layoutGeometry")).toBe(true);
  });

  // Returning an almost-empty document that looks like a successful conversion is
  // the worst outcome, so a scan fails loudly and names the route that reads it.
  //
  // This assertion used to require the phrase "OCR is Phase 3". It is now Phase 3 and
  // OCR exists, so the message names the recogniser route instead — the durable
  // invariant is that the error says what to do, not that it names a phase.
  it("refuses a PDF with no usable text layer rather than returning nothing", async () => {
    const blank = buildPdf([{ items: [] }, { items: [] }]);
    await expect(parsePdf(blank)).rejects.toThrow(/no usable text layer/);
    await expect(parsePdf(blank)).rejects.toThrow(/readPdf and a recogniser/);
  });

  // The same file through the route that does not throw. This is the branch
  // @markforge/core takes, and it must reach the OCR handoff in one pass over the PDF
  // rather than by catching the error above and reopening the file.
  it("reports a scan as a scan through readPdf, with a diagnostic naming the decision", async () => {
    const blank = buildPdf([{ items: [] }, { items: [] }]);
    const result = await readPdf(blank);
    expect(result.kind).toBe("scan");
    if (result.kind !== "scan") return;
    expect(result.pageCount).toBe(2);
    expect(result.charsPerPage).toBe(0);
    expect(
      result.diagnostics.all().some((d) => d.code === "MF-PDF-0001" && d.severity === "info"),
    ).toBe(true);
    // These synthetic pages carry no raster at all, so there is nothing to transcribe
    // and that is itself reported as a loss rather than as an empty success.
    expect(result.pages).toHaveLength(0);
    expect(result.diagnostics.lossy().some((d) => d.code === "MF-PDF-0002")).toBe(true);
  });

  // The case the document-level rule got wrong (OPEN_QUESTIONS §7i): a born-digital
  // report with a scanned page dropped into it. Averaging characters over the document
  // puts this comfortably above the threshold, so the old rule converted it and page 2
  // vanished with no diagnostic anywhere — a silent loss, which brief §3.3 forbids.
  describe("a document that is only partly scanned", () => {
    const mixed = () =>
      buildPdf([
        { items: [{ text: "First page of a readable report with a text layer.", x: 72, y: 72 }] },
        { items: [] },
        { items: [{ text: "Third page, also readable, after the inserted scan.", x: 72, y: 72 }] },
      ]);

    it("converts the readable pages instead of refusing the whole document", async () => {
      const { document } = await parsePdf(mixed());
      const text = textContent(document.body);
      expect(text).toContain("First page of a readable report");
      expect(text).toContain("Third page, also readable");
    });

    it("leaves a placeholder for the scanned page, in reading position", async () => {
      const { document } = await parsePdf(mixed());
      const placeholders = selectType(document.body, "unknown");
      expect(placeholders).toHaveLength(1);
      expect((placeholders[0] as { originalType?: string }).originalType).toBe("pdf:scanned-page");

      // Between the two readable pages, not appended at the end: the reader should see
      // where the missing content belongs.
      const children = (document.body as { children: { id?: string }[] }).children;
      const at = children.findIndex((c) => c.id === (placeholders[0] as { id?: string }).id);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(children.length - 1);
    });

    it("reports the loss as lossy and names both the node and the page", async () => {
      const { document, diagnostics } = await parsePdf(mixed());
      const placeholder = selectType(document.body, "unknown")[0] as { id?: string };
      const lost = diagnostics
        .lossy()
        .filter((d) => d.code === "MF-PDF-0001" && d.construct === "pdf:scanned-page");

      expect(lost).toHaveLength(1);
      expect(lost[0]!.nodeId).toBe(placeholder.id);
      expect(lost[0]!.locator).toMatchObject({ kind: "page", pageNumber: 2 });
      // Lossiness is what makes `--strict` exit non-zero on this document.
      expect(lost[0]!.lossy).toBe(true);
    });

    it("satisfies adapter rule A6: every unknown node is diagnosed by id", async () => {
      const { document } = await parsePdf(mixed());
      expect(checkUnknownNodesDiagnosed(document).ok).toBe(true);
    });

    it("hands back the scanned page's image only, so OCR is not re-run on readable pages", async () => {
      const result = await readPdf(mixed());
      expect(result.kind).toBe("text");
      if (result.kind !== "text") return;
      // These synthetic pages carry no raster, so the list is empty and the failure to
      // extract one is itself reported — the same honesty as the all-scanned branch.
      expect(result.scannedPages.every((p) => p.pageNumber === 2)).toBe(true);
      expect(result.diagnostics.all().some((d) => d.code === "MF-PDF-0002")).toBe(true);
    });

    it("still throws when every page is a scan", async () => {
      await expect(parsePdf(buildPdf([{ items: [] }, { items: [] }]))).rejects.toThrow(
        /no usable text layer/,
      );
    });
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
