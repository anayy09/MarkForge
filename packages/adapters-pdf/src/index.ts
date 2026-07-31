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
 * returning an empty document — OCR is Phase 3 (ADR-0012), and an empty document
 * that looks like a successful conversion is the worst possible outcome.
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
  groupIntoBlocks,
  joinBlockText,
  median,
  type Line,
  type TextRun,
} from "./layout.js";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-pdf", version: "0.1.0" };

export interface PdfParseOptions {
  path?: string;
  normalize?: boolean;
  /** Page cap, so a thousand-page report cannot hang a conversion. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 200;

/**
 * Below this many characters per page, we call it a scan.
 *
 * Some scanned PDFs carry a few characters of junk text — a stamp, a watermark, a
 * form field — so "zero characters" is the wrong test. But the threshold has to stay
 * low: an earlier value of 40 rejected a genuine one-line document, which is a false
 * positive on the most annoying possible input. A scan that carries a watermark and
 * squeaks past this will produce a document containing the watermark, which is at
 * least honest about what the text layer held.
 */
const SCAN_THRESHOLD_CHARS_PER_PAGE = 8;

export async function parsePdf(
  bytes: Uint8Array,
  options: PdfParseOptions = {},
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
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
  let totalChars = 0;
  const allHeights: number[] = [];

  // Two passes: the first measures the document so heading detection compares
  // against the *document's* body size rather than each page's. A page of nothing but
  // a large heading would otherwise treat that heading as body text.
  const pages: { pageNumber: number; layout: ReturnType<typeof analysePage> }[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

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
    pages.push({ pageNumber, layout });
    for (const column of layout.columns) for (const line of column.lines) allHeights.push(line.height);

    page.cleanup();
  }

  const charsPerPage = maxPages > 0 ? totalChars / maxPages : 0;
  if (charsPerPage < SCAN_THRESHOLD_CHARS_PER_PAGE) {
    // Failing loudly rather than returning an almost-empty document. A conversion
    // that "succeeds" with three words of a forty-page scan is worse than one that
    // says what is wrong.
    await pdf.destroy();
    throw new Error(
      `adapters-pdf: this PDF has no usable text layer (${Math.round(charsPerPage)} ` +
        `characters per page across ${maxPages} page(s)). It is almost certainly a scan. ` +
        `OCR is Phase 3 (docs/adr/0012-pdf-adapter-stack.md); until then MarkForge cannot ` +
        `read it, and returning an empty document would look like success.`,
    );
  }

  const documentBodyHeight = median(allHeights) ?? 11;

  for (const { pageNumber, layout } of pages) {
    if (layout.columns.length > 1) {
      diagnostics.info(
        DiagnosticCode.INFER_AMBIGUOUS_HEADING,
        `Page ${pageNumber}: detected ${layout.columns.length} columns. Reading order is ` +
          `column-by-column, which is right for a multi-column article and wrong for a ` +
          `table laid out with whitespace — inspect the output if the page had one.`,
      );
    }

    for (const column of layout.columns) {
      for (const lines of groupIntoBlocks(column, layout.bodyLeading)) {
        const node = blockToNode(lines, documentBodyHeight, evidence);
        if (node) {
          pageOf.set(node, pageNumber);
          blocks.push(node);
        }
      }
    }
  }

  await pdf.destroy();

  doc.body = { type: "root", children: blocks } as unknown as MarkForgeDocument["body"];

  const metadata = await Promise.resolve().then(() => ({}));
  doc.metadata = metadata;

  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
  attachSideTables(doc, sourceId, evidence, pageOf);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    attachSideTables(doc, sourceId, evidence, pageOf);
  }

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
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
  if (listItems) return listItems;

  const isShort = text.length <= 90;
  const noTerminalPunctuation = !/[.!?;:,]\s*$/.test(text);
  const singleLine = lines.length <= 2;

  if (ratio >= 1.15 && isShort && noTerminalPunctuation && singleLine) {
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
    return node;
  }

  const node: AnyNode = { type: "paragraph", children: [{ type: "text", value: text }] };
  evidence.set(node, { origin: "layoutGeometry", font: { sizePt: round(height) } });
  return node;
}

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
      list["start"] = start;
      if (start !== 1) list["restartsAt"] = start;
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
): void {
  const provenance: Record<string, Provenance> = {};
  const sidecar: Record<string, StyleEvidence> = {};
  let currentPage = 1;

  visit(doc.body as unknown as AnyNode, (n) => {
    const page = pageOf.get(n);
    if (page !== undefined) currentPage = page;
    if (typeof n.id !== "string") return;
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      locator: { kind: "page", pageNumber: currentPage },
      // Confidence is stated because this adapter genuinely guessed. Every other
      // adapter reads structure the file declares; this one reconstructed it, and a
      // consumer deciding whether to trust a heading deserves to know which.
      confidence: 0.8,
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
