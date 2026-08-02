/**
 * @markforge/adapters-pdf — PDF to IR via the text layer.
 *
 * ADR-0012: `pdfjs-dist` for extraction, our own layout analysis on top. pdf.js is
 * the most battle-tested PDF parser available and is not opinionated about
 * structure, which suits us — structure is exactly the part we want to control.
 *
 * **This adapter infers, and that is a documented exception to rule A5.** Every
 * other adapter records evidence and leaves decisions to `@markforge/infer`, because
 * every other format states its own structure. A PDF does not: it has glyphs at
 * coordinates and nothing else. Refusing to infer here would mean refusing to read
 * PDFs, so the inference happens, is deterministic, and reports itself.
 *
 * A PDF with no text layer is a scan. This adapter says so and stops rather than
 * returning an empty document — OCR is a separate, opt-in route (ADR-0012), and an
 * empty document that looks like a successful conversion is the worst possible outcome.
 *
 * **Known limitation, in pdf.js rather than here:** text extending beyond the page's
 * MediaBox is clipped during extraction, and the items arrive truncated with no flag.
 * Measured: a 125-character line at 16pt on a 612pt-wide page came back as 78
 * characters, cut mid-word. Badly generated PDFs do this. We cannot recover the
 * missing text, so we emit a diagnostic whenever a run reaches the page edge — a
 * "this may be incomplete" that is honest rather than a silence that is not.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  assignIds,
  contentHashOfBytes,
  emptyDocument,
  normalize,
  visit,
  type AnyNode,
  type MarkForgeDocument,
  type Provenance,
  type StyleEvidence,
} from "@markforge/ir";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  analysePage,
  detectFurniture,
  groupIntoBlocks,
  joinBlockText,
  median,
  type Line,
  type TextRun,
} from "./layout.js";
import { pageImage, type PageImage } from "./pages.js";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-pdf", version: "0.1.0" };

export interface PdfParseOptions {
  path?: string;
  normalize?: boolean;
  /** Page cap, so a thousand-page report cannot hang a conversion. */
  maxPages?: number;
}

/**
 * What a PDF turned out to be.
 *
 * A PDF is either a document with a text layer or a picture of one, and which it is
 * cannot be known until it has been opened. Returning the answer rather than throwing on
 * one branch lets `@markforge/core` route a scan to OCR in a single pass — the earlier
 * shape threw, so the only way to reach the scan branch was to catch an error and reopen
 * the file, which is control flow by exception and doubles the work.
 *
 * `parsePdf` still throws when *every* page is a scan (OPEN_QUESTIONS §7i), because a
 * caller that asked for a document and cannot be handed one deserves an error rather than
 * a union. A document where only *some* pages are scans is a `text` result: see below.
 */
export type PdfReadResult =
  | {
      kind: "text";
      document: MarkForgeDocument;
      /**
       * Page images for pages that had no text layer in an otherwise readable document.
       * Empty for the ordinary case.
       *
       * The mixed document is the common real one — a born-digital report with a signed
       * cover sheet, a photocopied appendix, a submission bundle — and the two obvious
       * rules both fail it. Throwing loses the readable 90 percent; passing silently
       * drops the scanned pages, which violates SPEC §1.3. So the readable pages
       * convert, each unreadable page becomes an `unknown` placeholder node carrying its
       * page number and a lossy diagnostic (so `--strict` exits non-zero), and its image
       * is handed back here for a recogniser to fill in.
       */
      scannedPages: PageImage[];
      diagnostics: DiagnosticBag;
    }
  | {
      kind: "scan";
      /** One PNG per page, for a recogniser. Empty when no raster could be extracted. */
      pages: PageImage[];
      charsPerPage: number;
      pageCount: number;
      diagnostics: DiagnosticBag;
    };

const DEFAULT_MAX_PAGES = 200;

/**
 * Below this many characters, a *page* is a scan.
 *
 * Some scanned PDFs carry a few characters of junk text — a stamp, a watermark, a
 * form field — so "zero characters" is the wrong test. But the threshold has to stay
 * low: an earlier value of 40 rejected a genuine one-line document, which is a false
 * positive on the most annoying possible input. A scan that carries a watermark and
 * squeaks past this will produce a document containing the watermark, which is at
 * least honest about what the text layer held.
 *
 * **Applied per page, not to a document average** (OPEN_QUESTIONS §7i). An average
 * hides exactly the case that matters: forty readable pages and four scanned ones
 * average out well above the threshold, so the document passes and four pages vanish
 * with no diagnostic anywhere. The per-page test cannot express that outcome.
 */
const SCAN_THRESHOLD_CHARS_PER_PAGE = 8;

/**
 * Reads a PDF, and says which kind of PDF it was.
 *
 * `parsePdf` is this function plus a throw on the scan branch; everything below is one
 * pass over the file either way.
 */
export async function readPdf(
  bytes: Uint8Array,
  options: PdfParseOptions = {},
): Promise<PdfReadResult> {
  const diagnostics = new DiagnosticBag(ADAPTER);

  // The legacy build is the one that runs in Node without a DOM. Imported lazily so
  // that requiring @markforge/core does not pull a PDF parser into memory for a
  // Markdown conversion (ADR-0015's lazy-loading rule, applied on the server too).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = emptyDocument();
  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "document.pdf",
    mediaType: "application/pdf",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  // A copy: pdf.js transfers ownership of the buffer it is given and leaves the
  // caller's view detached, which would make the contentHash above unreadable if it
  // ran afterwards.
  // Standard font data is required even for text-only extraction. Without it pdf.js
  // cannot map every glyph in the standard-14 fonts and silently drops the ones it
  // cannot resolve — a bullet character disappeared entirely before this was wired,
  // which turned a list into a paragraph with no diagnostic anywhere.
  // createRequire rather than import.meta.resolve: the latter is unavailable under
  // some bundlers and test transforms, and this path has to work in both the built
  // artifact and the test run.
  const standardFontDataUrl =
    dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")) +
    "/standard_fonts/";

  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    // Rendering fonts is not needed for text extraction, and is where most of the
    // time and most of the failure modes are. Glyph *mapping* still needs the data
    // above; this only disables installing the faces for display.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const maxPages = Math.min(pdf.numPages, options.maxPages ?? DEFAULT_MAX_PAGES);
  if (pdf.numPages > maxPages) {
    diagnostics.degraded(
      DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
      "pdf",
      `Document has ${pdf.numPages} pages; only the first ${maxPages} were read. Raise ` +
        `maxPages to include the rest.`,
    );
  }

  const blocks: AnyNode[] = [];
  const evidence = new Map<AnyNode, StyleEvidence>();
  const pageOf = new Map<AnyNode, number>();
  const confidenceOf = new Map<AnyNode, number>();
  let totalChars = 0;
  const allHeights: number[] = [];

  // Two passes: the first measures the document so heading detection compares
  // against the *document's* body size rather than each page's. A page of nothing but
  // a large heading would otherwise treat that heading as body text.
  const pages: {
    pageNumber: number;
    layout: ReturnType<typeof analysePage>;
    /** Page height, needed by furniture detection to know where the bands are. */
    height: number;
    chars: number;
  }[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    let pageChars = 0;
    const runs: TextRun[] = [];
    for (const item of content.items) {
      // Whitespace-only items are pdf.js's gap fillers, not content: they carry no
      // glyphs, and counting them toward the text-layer total would make a scan with
      // wide blank areas look like a document with text.
      if (!("str" in item) || typeof item.str !== "string" || item.str.trim() === "") continue;
      const transform = item.transform as number[];
      const x = transform[4] ?? 0;
      const yFromBottom = transform[5] ?? 0;
      // pdf.js reports y from the page bottom; flipping once here means every
      // downstream comparison reads top-to-bottom like the document does.
      runs.push({
        text: item.str,
        x,
        y: viewport.height - yFromBottom,
        width: typeof item.width === "number" ? item.width : 0,
        height: typeof item.height === "number" && item.height > 0 ? item.height : Math.abs(transform[3] ?? 10),
        fontName: "fontName" in item && typeof item.fontName === "string" ? item.fontName : "",
      });
      totalChars += item.str.trim().length;
      pageChars += item.str.trim().length;
    }

    // pdf.js clips text extending past the MediaBox and reports the survivors with
    // no indication that anything was cut — a 125-character line at 16pt on a
    // letter-width page came back as 78 characters, mid-word. The loss happens before
    // we see the items, so it cannot be detected directly. A run reaching the page
    // edge is the only available signal, and saying "this may be incomplete" beats
    // saying nothing.
    const atEdge = runs.filter((r) => r.x + r.width >= viewport.width - 1);
    if (atEdge.length > 0) {
      diagnostics.degraded(
        DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
        "pdf:overflow",
        `Page ${pageNumber}: ${atEdge.length} text run(s) reach the page edge. Text ` +
          `extending past the media box is clipped by the PDF text layer itself, so those ` +
          `run(s) may be truncated and the missing characters are not recoverable from ` +
          `this file.`,
      );
    }

    const layout = analysePage(runs, viewport.width);
    pages.push({ pageNumber, layout, chars: pageChars, height: viewport.height });
    for (const column of layout.columns) for (const line of column.lines) allHeights.push(line.height);

    page.cleanup();
  }

  const charsPerPage = maxPages > 0 ? totalChars / maxPages : 0;

  // The scan test is per page (OPEN_QUESTIONS §7i). Three outcomes, not two: every page
  // a scan, no page a scan, or the mixed document that both simpler rules get wrong.
  const scannedPageNumbers = pages
    .filter((p) => p.chars < SCAN_THRESHOLD_CHARS_PER_PAGE)
    .map((p) => p.pageNumber);
  const allScanned = maxPages > 0 && scannedPageNumbers.length === maxPages;

  const rasterise = async (pageNumbers: number[]): Promise<PageImage[]> => {
    const images: PageImage[] = [];
    for (const pageNumber of pageNumbers) {
      const page = await pdf.getPage(pageNumber);
      const image = await pageImage(
        page as unknown as Parameters<typeof pageImage>[0],
        pageNumber,
        { ops: pdfjs.OPS as unknown as Record<string, number>, diagnostics },
      );
      if (image) images.push(image);
      page.cleanup();
    }
    return images;
  };

  if (allScanned) {
    // A scan. The routing decision itself is recorded as an `info` diagnostic, which
    // ADR-0012 requires: "we OCR'd this" is a fact about the output that a reader
    // should not have to infer from the provenance table.
    diagnostics.info(
      DiagnosticCode.PDF_NO_TEXT_LAYER,
      `No usable text layer (${Math.round(charsPerPage)} character(s) per page across ` +
        `${maxPages} page(s)), so this file is a scan and its pages were extracted as ` +
        `images for a recogniser. Everything downstream of here is a reading of a ` +
        `picture, recorded with a confidence in provenance.`,
    );

    const images = await rasterise(scannedPageNumbers);
    await pdf.destroy();

    return { kind: "scan", pages: images, charsPerPage, pageCount: maxPages, diagnostics };
  }

  // The mixed document: some pages readable, some not. Rasterise only the unreadable
  // ones, so a recogniser can be pointed at exactly the pages that need it.
  const scannedSet = new Set(scannedPageNumbers);
  const scannedImages = scannedPageNumbers.length > 0 ? await rasterise(scannedPageNumbers) : [];
  if (scannedPageNumbers.length > 0) {
    diagnostics.info(
      DiagnosticCode.PDF_NO_TEXT_LAYER,
      `Page(s) ${scannedPageNumbers.join(", ")} of ${maxPages} have no usable text layer ` +
        `while the rest do. The readable pages were converted; each unreadable page is a ` +
        `placeholder node in reading position, and its image was extracted for a ` +
        `recogniser. This document is incomplete until those pages are transcribed.`,
    );
  }

  const documentBodyHeight = median(allHeights) ?? 11;
  const placeholders: { node: AnyNode; pageNumber: number }[] = [];

  /*
   * ADR-0012 clause 1, built 2026-08-01: running headers and footers, routed to `furniture`.
   *
   * ADR-0002 chose routing over brief §5.2's "stripping" so the no-silent-loss rule holds,
   * and the destination has existed since Phase 0 with nothing writing to it — this adapter
   * produced zero furniture entries for four phases while the ADR read as delivered.
   *
   * The lines are collected first and excluded from the body second, because a line can only
   * be recognised as furniture by comparing it against *other pages*, which means the whole
   * document has to be laid out before any page's body is decided.
   */
  const furnitureLines = detectFurniture(pages);
  const furnitureByPage = new Map<number, Set<Line>>();
  for (const f of furnitureLines) {
    const set = furnitureByPage.get(f.pageNumber) ?? new Set<Line>();
    set.add(f.line);
    furnitureByPage.set(f.pageNumber, set);
  }
  if (furnitureLines.length > 0) {
    diagnostics.info(
      DiagnosticCode.PDF_NO_TEXT_LAYER,
      `${furnitureLines.length} running header/footer line(s) across ${maxPages} page(s) ` +
        `were routed to furniture rather than left in the body (ADR-0002). A repeated line ` +
        `in the same band on at least half the pages is furniture; digits are masked first, ` +
        `so "Page 3 of 12" and "Page 4 of 12" count as the same running footer.`,
    );
  }

  for (const { pageNumber, layout } of pages) {
    if (scannedSet.has(pageNumber)) {
      // In reading position, so the placeholder sits where the page's content would
      // have been rather than being appended as a footnote to the document.
      const node: AnyNode = {
        type: "unknown",
        construct: "pdf:scanned-page",
        raw: `Page ${pageNumber} is a scanned image with no text layer.`,
      };
      pageOf.set(node, pageNumber);
      placeholders.push({ node, pageNumber });
      blocks.push(node);
      continue;
    }

    if (layout.columns.length > 1) {
      diagnostics.info(
        DiagnosticCode.INFER_AMBIGUOUS_HEADING,
        `Page ${pageNumber}: detected ${layout.columns.length} columns. Reading order is ` +
          `column-by-column, which is right for a multi-column article and wrong for a ` +
          `table laid out with whitespace — inspect the output if the page had one.`,
      );
    }

    const pageFurniture = furnitureByPage.get(pageNumber);
    for (const column of layout.columns) {
      const bodyColumn = pageFurniture
        ? { ...column, lines: column.lines.filter((l) => !pageFurniture.has(l)) }
        : column;
      for (const lines of groupIntoBlocks(bodyColumn, layout.bodyLeading)) {
        const node = blockToNode(lines, documentBodyHeight, evidence, confidenceOf);
        if (node) {
          pageOf.set(node, pageNumber);
          // The weaker of the two doubts, not their product. They are independent kinds
          // of doubt — "is this a heading" and "did we read the page in the right order"
          // — and a node is only as trustworthy as its weakest link. Multiplying would
          // punish a confident node on a confident page for no reason.
          confidenceOf.set(
            node,
            Math.min(confidenceOf.get(node) ?? 0.8, layout.readingOrderConfidence),
          );
          blocks.push(node);
        }
      }
    }
  }

  await pdf.destroy();

  doc.body = { type: "root", children: blocks } as unknown as MarkForgeDocument["body"];

  // One furniture entry per distinct running line, carrying the pages it appeared on in its
  // `sectionIndex`. Grouped by kind and text so a header repeated on forty pages is one
  // entry rather than forty.
  const grouped = new Map<string, { kind: "header" | "footer"; text: string; first: number }>();
  for (const f of furnitureLines) {
    const key = `${f.kind}:${f.text}`;
    if (!grouped.has(key)) grouped.set(key, { kind: f.kind, text: f.text, first: f.pageNumber });
  }
  doc.furniture = [...grouped.values()].map((g) => ({
    kind: g.kind,
    scope: "default" as const,
    sectionIndex: 0,
    content: {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: g.text }] }],
    },
  })) as unknown as MarkForgeDocument["furniture"];

  const metadata = await Promise.resolve().then(() => ({}));
  doc.metadata = metadata;

  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
  attachSideTables(doc, sourceId, evidence, pageOf, confidenceOf);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    attachSideTables(doc, sourceId, evidence, pageOf, confidenceOf);
  }

  // Emitted after the last `assignIds`, so each diagnostic names the node it describes.
  // Rule A6 requires every `unknown` node to carry a lossy diagnostic with its id, and
  // that lossiness is also what makes `--strict` exit non-zero on a mixed document —
  // which is the half of §7i that keeps "no silent loss" true.
  for (const { node, pageNumber } of placeholders) {
    const nodeId = (node as { id?: unknown }).id;
    diagnostics.lost(
      DiagnosticCode.PDF_NO_TEXT_LAYER,
      "pdf:scanned-page",
      `Page ${pageNumber} has no text layer and was not transcribed, so its content is ` +
        `absent from this document. Transcribe it with \`markforge convert --ocr\` ` +
        `(tesseract locally, or --llm for a vision model).`,
      {
        ...(typeof nodeId === "string" ? { nodeId } : {}),
        locator: { kind: "page", pageNumber },
      },
    );
  }

  doc.diagnostics = diagnostics.all();
  return { kind: "text", document: doc, scannedPages: scannedImages, diagnostics };
}

/**
 * Reads a PDF that has a text layer. Throws, by name, when it does not.
 *
 * The refusal is deliberate (OPEN_QUESTIONS §7i), and the message names the OCR route
 * this build has rather than only reporting failure, so the error says what to do next.
 */
export async function parsePdf(
  bytes: Uint8Array,
  options: PdfParseOptions = {},
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
  const result = await readPdf(bytes, options);
  if (result.kind === "scan") {
    throw new Error(
      `adapters-pdf: this PDF has no usable text layer ` +
        `(${Math.round(result.charsPerPage)} characters per page across ` +
        `${result.pageCount} page(s)). It is almost certainly a scan, and returning an ` +
        `almost-empty document would look like success. Its ${result.pages.length} page ` +
        `image(s) can be transcribed: use readPdf and a recogniser, or run ` +
        `\`markforge convert --ocr\` (tesseract locally, or --llm for a vision model).`,
    );
  }
  return { document: result.document, diagnostics: result.diagnostics };
}

/**
 * A block of lines becomes a paragraph, a heading, or a list item.
 *
 * The heading test is *evidence recorded plus a shape chosen*, not a score: a block
 * meaningfully larger than the document's body text, short, and without terminal
 * punctuation is a heading. The evidence goes to the sidecar with
 * `origin: "layoutGeometry"`, so `@markforge/infer` can revisit the decision and a
 * reader can see what it was based on.
 */
function blockToNode(
  lines: Line[],
  bodyHeight: number,
  evidence: Map<AnyNode, StyleEvidence>,
  confidenceOf: Map<AnyNode, number>,
): AnyNode | undefined {
  const text = joinBlockText(lines);
  if (text === "") return undefined;

  const height = median(lines.map((l) => l.height)) ?? bodyHeight;
  const ratio = height / bodyHeight;

  // A list is detected per *line*, not per block.
  //
  // Real lists are set at ordinary leading, so every item of a list lands in the same
  // block as its siblings. An earlier version tested only the block's first character
  // and produced a single list item containing every item's text run together — which
  // passed a fixture with wide gaps between items and would fail on every real
  // document.
  //
  // Marker recognition has to happen here rather than in @markforge/infer: once the
  // block is a paragraph the marker is ordinary text, indistinguishable from a
  // sentence that begins with a numeral.
  const listItems = splitListItems(lines);
  if (listItems) {
    // A marker is a character in the file, not a measurement of one — the strongest
    // evidence this adapter ever has, short of a declared style.
    confidenceOf.set(listItems, 0.9);
    return listItems;
  }

  const isShort = text.length <= 90;
  const noTerminalPunctuation = !/[.!?;:,]\s*$/.test(text);
  const singleLine = lines.length <= 2;

  if (ratio >= HEADING_MIN_RATIO && isShort && noTerminalPunctuation && singleLine) {
    // Coarse levels, because the evidence is coarse. Claiming six distinguishable
    // heading levels from font size alone would imply a precision the geometry does
    // not carry.
    const level = ratio >= 1.7 ? 1 : ratio >= 1.4 ? 2 : 3;
    const node: AnyNode = {
      type: "heading",
      depth: level,
      resolvedLevel: level,
      children: [{ type: "text", value: text }],
    };
    evidence.set(node, {
      origin: "layoutGeometry",
      font: { sizePt: round(height) },
      outlineLevel: level - 1,
    });
    // How far above the threshold the size sits. A block at 1.15× only just cleared it
    // and could as easily be emphasised body text; one at 1.7× could not.
    const margin = (ratio - HEADING_MIN_RATIO) / (1.7 - HEADING_MIN_RATIO);
    confidenceOf.set(node, round2(0.55 + 0.4 * clamp01(margin)));
    return node;
  }

  const node: AnyNode = { type: "paragraph", children: [{ type: "text", value: text }] };
  evidence.set(node, { origin: "layoutGeometry", font: { sizePt: round(height) } });
  // Paragraph is the default interpretation, so its confidence is the confidence that
  // nothing else fit — which falls as the block gets closer to being a heading. Three of
  // the four heading signals holding is a near miss, and a near miss is exactly what a
  // reviewer or a stronger model should be pointed at. A constant would have hidden it.
  const nearMisses = [ratio >= HEADING_MIN_RATIO, isShort, noTerminalPunctuation, singleLine]
    .filter(Boolean).length;
  confidenceOf.set(node, nearMisses >= 3 ? 0.65 : nearMisses === 2 ? 0.85 : 0.95);
  return node;
}

/** Size ratio at which a block becomes eligible to be a heading. */
const HEADING_MIN_RATIO = 1.15;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

const BULLET = /^\s*([\u2022\u00b7\u25aa\u25e6\u2023\u2013\u2014*-])\s+(\S.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(\S.*)$/;

/**
 * Splits a block into list items, or returns undefined if it is not a list.
 *
 * A line beginning with a marker starts an item; a line that does not is a
 * continuation of the item above, which is how a wrapped list item appears. The
 * block is only treated as a list if its *first* line has a marker — otherwise a
 * paragraph that happens to contain a wrapped line starting with "1998" would become
 * a numbered list.
 */
function splitListItems(lines: Line[]): AnyNode | undefined {
  const first = lines[0];
  if (!first) return undefined;

  const firstBullet = BULLET.exec(first.text);
  const firstNumber = NUMBERED.exec(first.text);
  if (!firstBullet && !firstNumber) return undefined;

  const ordered = firstNumber !== null;
  const items: string[][] = [];

  for (const line of lines) {
    const bullet = ordered ? null : BULLET.exec(line.text);
    const numbered = ordered ? NUMBERED.exec(line.text) : null;
    const marked = bullet ?? numbered;
    if (marked) items.push([marked[2]!]);
    else if (items.length > 0) items[items.length - 1]!.push(line.text);
    else items.push([line.text]);
  }

  const children = items.map((parts) => ({
    type: "listItem",
    spread: false,
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: joinContinuation(parts) }],
      },
    ],
  }));

  const list: AnyNode = { type: "list", ordered, spread: false, children };
  if (ordered && firstNumber) {
    const start = Number(firstNumber[1]);
    if (Number.isFinite(start)) {
      // `start` only: `restartsAt` is a `ListItem` field. See the note in adapters-docx.
      list["start"] = start;
    }
  }
  return list;
}

/** Joins an item's wrapped lines, repairing hyphenation the same way blocks do. */
function joinContinuation(parts: string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!;
    const next = parts[i + 1];
    if (next && /[a-z]-$/.test(text) && /^[a-z]/.test(next)) {
      out += text.slice(0, -1);
      continue;
    }
    out += text;
    if (next) out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

const round = (n: number): number => Math.round(n * 100) / 100;

function attachSideTables(
  doc: MarkForgeDocument,
  sourceId: string,
  evidence: Map<AnyNode, StyleEvidence>,
  pageOf: Map<AnyNode, number>,
  confidenceOf: Map<AnyNode, number>,
): void {
  const provenance: Record<string, Provenance> = {};
  const sidecar: Record<string, StyleEvidence> = {};
  let currentPage = 1;
  let currentConfidence = 0.8;

  visit(doc.body as unknown as AnyNode, (n) => {
    const page = pageOf.get(n);
    if (page !== undefined) currentPage = page;
    // Inherited, like the page number: a heading's own text node is exactly as much of
    // a guess as the heading, and re-deriving it per child would invent precision.
    const confidence = confidenceOf.get(n);
    if (confidence !== undefined) currentConfidence = confidence;
    if (typeof n.id !== "string") return;
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      locator: { kind: "page", pageNumber: currentPage },
      // Confidence is stated because this adapter genuinely guessed. Every other
      // adapter reads structure the file declares; this one reconstructed it, and a
      // consumer deciding whether to trust a heading deserves to know which. It is
      // derived from the evidence rather than constant (OPEN_QUESTIONS §7h) so that
      // ranking by it is meaningful.
      confidence: currentConfidence,
    };
    const e = evidence.get(n);
    if (e) sidecar[n.id] = e;
  });

  doc.provenance = provenance;
  doc.sidecar = sidecar;
}

export {
  analysePage,
  groupIntoLines,
  groupIntoBlocks,
  detectColumns,
  joinBlockText,
} from "./layout.js";
export type { TextRun, Line, Column, PageLayout } from "./layout.js";
export { encodePng } from "./pages.js";
export type { PageImage } from "./pages.js";
