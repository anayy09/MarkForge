/**
 * @markforge/adapters-ocr — page images to IR.
 *
 * The adapter for the one input that has no structure to read: a picture of a document.
 * Everything else in the project reads a format that states what it is; here there is a
 * raster and a recogniser's opinion about it, so **confidence is a first-class output**
 * and every node this package produces carries one in its provenance (SPEC §3).
 *
 * **Why a recogniser is injected rather than imported.** ADR-0009 forbids any
 * `adapters-*` package from depending on `@markforge/llm`, and SPEC §11 forbids adapters
 * from depending on each other. But the two recognisers worth having are tesseract.js
 * (local, offline, ours to bundle) and a NaviGator vision model (which lives behind
 * `@markforge/llm`). So the contract is a function type: this package defines
 * `Recognizer`, ships the tesseract implementation, and `@markforge/core` — the only
 * place allowed to know about both — supplies the vision one. The boundary rule stays
 * mechanically true instead of being an aspiration with an exception.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  assignIds,
  contentHashOfBytes,
  emptyDocument,
  visit,
  type AnyNode,
  type MarkForgeDocument,
  type Producer,
  type Provenance,
} from "@markforge/ir";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-ocr", version: "0.1.0" };

/**
 * One page, as bytes a recogniser can read.
 *
 * PNG or JPEG rather than a pixel buffer: both recognisers want an encoded image, and
 * an encoded image is also what the content-addressed LLM cache keys on — so the digest
 * of this field is stable across hosts, where a raw buffer's layout would not be.
 *
 * **This shape is duplicated in `@markforge/adapters-pdf`** because the two packages may
 * not depend on each other (SPEC §11) and the PDF adapter is what produces page images
 * from a scan. Structural typing makes them interchangeable; a test in `@markforge/core`
 * asserts assignability in both directions, so drift is a build failure rather than a
 * runtime surprise.
 */
export interface PageImage {
  pageNumber: number;
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export type RecognizedBlockKind = "heading" | "paragraph" | "listItem" | "caption";

export interface RecognizedBlock {
  kind: RecognizedBlockKind;
  level?: number;
  text: string;
}

/** What produced a transcription: an OCR engine, or a vision model. */
export type RecognizerEngine =
  | { kind: "ocr"; engine: string; version: string }
  | { kind: "model"; model: string; promptVersion: string };

export interface RecognizedPage {
  blocks: RecognizedBlock[];
  /** 0–1, how much of the page the recogniser read with certainty. */
  confidence: number;
  engine: RecognizerEngine;
}

export type Recognizer = (page: PageImage) => Promise<RecognizedPage>;

export interface OcrParseOptions {
  path?: string;
  /**
   * Below this, a page is reported as a lossy diagnostic rather than an info one, so
   * `--strict` fails on a transcription nobody should trust silently.
   */
  lowConfidence?: number;
  /** Content hash source, when the caller has the original file bytes. */
  sourceBytes?: Uint8Array;
  mediaType?: string;
}

export const DEFAULT_LOW_CONFIDENCE = 0.6;

/**
 * Transcribes pages and assembles them into one document.
 *
 * Pages are recognised in order and awaited one at a time. Sequential rather than
 * parallel on purpose: a vision model call is the expensive thing here, and firing
 * forty of them at a shared university gateway at once is how a rate limit turns a
 * conversion into a partial failure.
 */
export async function documentFromPages(
  pages: PageImage[],
  recognize: Recognizer,
  options: OcrParseOptions = {},
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const lowConfidence = options.lowConfidence ?? DEFAULT_LOW_CONFIDENCE;

  const doc = emptyDocument();
  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "scan",
    mediaType: options.mediaType ?? "image/png",
    contentHash: contentHashOfBytes(options.sourceBytes ?? concatDigestInput(pages)),
    byteLength: (options.sourceBytes ?? concatDigestInput(pages)).byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  const blocks: AnyNode[] = [];
  const pageOf = new Map<AnyNode, number>();
  const producerOf = new Map<AnyNode, Producer>();
  const confidenceOf = new Map<AnyNode, number>();

  for (const page of pages) {
    const recognized = await recognize(page);
    const producer = producerFor(recognized.engine);
    const engineLabel = describeEngine(recognized.engine);

    if (recognized.blocks.length === 0) {
      // A blank page is legitimate and a failed transcription is not, and from here
      // they are indistinguishable — so this is reported as a loss and let the human
      // decide, rather than silently producing a document that skips a page.
      diagnostics.lost(
        DiagnosticCode.OCR_EMPTY_PAGE,
        "page",
        `Page ${page.pageNumber} transcribed to nothing by ${engineLabel}. Either the page ` +
          `is blank or the recogniser failed, and this file cannot tell those apart.`,
        { locator: { kind: "page", pageNumber: page.pageNumber } },
      );
      continue;
    }

    const message =
      `Page ${page.pageNumber} was transcribed by ${engineLabel} at confidence ` +
      `${recognized.confidence.toFixed(2)}. Its text is a recogniser's reading of an ` +
      `image, not text the file contained.`;
    if (recognized.confidence < lowConfidence) {
      diagnostics.degraded(DiagnosticCode.OCR_LOW_CONFIDENCE, "page", message, {
        locator: { kind: "page", pageNumber: page.pageNumber },
      });
    } else {
      diagnostics.info(DiagnosticCode.OCR_PAGE_TRANSCRIBED, message, {
        locator: { kind: "page", pageNumber: page.pageNumber },
      });
    }

    const unbind = (caption: string): void => {
      diagnostics.degraded(
        DiagnosticCode.OCR_LOW_CONFIDENCE,
        "caption",
        `Page ${page.pageNumber}: ${engineLabel} read "${caption.slice(0, 60)}" as a caption, ` +
          `but a caption must be bound to a figure or a table and this adapter extracts ` +
          `neither. The text is kept as a paragraph; the binding is lost.`,
        { locator: { kind: "page", pageNumber: page.pageNumber } },
      );
    };

    for (const node of toNodes(recognized.blocks, unbind)) {
      pageOf.set(node, page.pageNumber);
      producerOf.set(node, producer);
      confidenceOf.set(node, recognized.confidence);
      blocks.push(node);
    }
  }

  doc.body = { type: "root", children: blocks } as unknown as MarkForgeDocument["body"];
  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;

  const provenance: Record<string, Provenance> = {};
  let currentPage = pages[0]?.pageNumber ?? 1;
  let currentProducer: Producer = ADAPTER;
  let currentConfidence = 1;
  visit(doc.body as unknown as AnyNode, (n) => {
    const page = pageOf.get(n);
    if (page !== undefined) currentPage = page;
    const producer = producerOf.get(n);
    if (producer !== undefined) currentProducer = producer;
    const confidence = confidenceOf.get(n);
    if (confidence !== undefined) currentConfidence = confidence;
    if (typeof n.id !== "string") return;
    provenance[n.id] = {
      sourceId,
      producedBy: currentProducer,
      locator: { kind: "page", pageNumber: currentPage },
      confidence: currentConfidence,
    };
  });
  doc.provenance = provenance;

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
}

/**
 * Blocks to nodes, with consecutive list items collected into one list.
 *
 * The recogniser reports items, not lists, because a page image shows items — deciding
 * where a list begins and ends is a structural judgement, and doing it here keeps it out
 * of the prompt where it could not be inspected.
 */
function toNodes(blocks: RecognizedBlock[], onUnboundCaption?: (text: string) => void): AnyNode[] {
  const out: AnyNode[] = [];
  let items: AnyNode[] = [];

  const flush = (): void => {
    if (items.length === 0) return;
    out.push({ type: "list", ordered: false, spread: false, children: items });
    items = [];
  };

  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (text === "") continue;

    if (block.kind === "listItem") {
      items.push({
        type: "listItem",
        spread: false,
        children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
      });
      continue;
    }
    flush();

    if (block.kind === "heading") {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      out.push({
        type: "heading",
        depth: level,
        resolvedLevel: level,
        children: [{ type: "text", value: text }],
      });
      continue;
    }
    if (block.kind === "caption") {
      // A `caption` node has to be bound to a figure or a table (SPEC §2.3), and this
      // adapter has neither: it transcribes a page, it does not extract the sub-images on
      // it. So the text survives as a paragraph and the *construct* is reported lost. The
      // alternatives were both worse — emitting a bare caption produces a document that
      // fails schema validation, and synthesising an empty figure to hang it on would be
      // inventing structure the source does not evidence, which SPEC §6.2 forbids.
      onUnboundCaption?.(text);
      out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
      continue;
    }
    out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
  }
  flush();
  return out;
}

function producerFor(engine: RecognizerEngine): Producer {
  return engine.kind === "ocr"
    ? { kind: "ocr", engine: engine.engine, version: engine.version }
    : { kind: "model", model: engine.model, promptVersion: engine.promptVersion };
}

function describeEngine(engine: RecognizerEngine): string {
  return engine.kind === "ocr"
    ? `${engine.engine} ${engine.version}`
    : `the vision model ${engine.model} (prompt ${engine.promptVersion})`;
}

/** Stand-in content hash when the caller has no single source file. */
function concatDigestInput(pages: PageImage[]): Uint8Array {
  let total = 0;
  for (const p of pages) total += p.bytes.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of pages) {
    out.set(p.bytes, offset);
    offset += p.bytes.byteLength;
  }
  return out;
}

export { createTesseractRecognizer, TESSERACT_VERSION } from "./tesseract.js";
export type { TesseractOptions } from "./tesseract.js";
