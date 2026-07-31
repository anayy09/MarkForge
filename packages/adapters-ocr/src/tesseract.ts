/**
 * The local recogniser: tesseract.js (ADR-0012).
 *
 * Two properties of tesseract.js drive this file's shape, and both are constraints the
 * rest of the project takes seriously rather than conveniences to paper over:
 *
 *   1. **It fetches a language model at runtime.** `eng.traineddata` is about 15 MB and
 *      tesseract.js downloads it from a CDN by default. That is a network call, and
 *      brief §3.6 says a network call is opt-in and explicit — *never* a default. So
 *      `langPath` is **required** here, or `allowDownload: true` must be passed
 *      deliberately. An offline promise that quietly depends on a CDN is not a promise.
 *   2. **It is a WASM bundle.** Loading it for a Markdown conversion would be absurd, so
 *      the import is dynamic and happens on first use, and the package is an
 *      `optionalDependency` so an install that will never OCR anything does not pay for
 *      it (ADR-0015's lazy-loading rule).
 *
 * **What this recogniser cannot do, stated because it is measured.** Tesseract returns
 * text and confidence; it does not tell us that a line was set 20pt and bold. So it
 * produces paragraphs and list items and never a heading, and `@markforge/infer` has
 * nothing to work from because a raster carries no style sidecar. A vision model *can*
 * see that a line is large and bold, so it recovers structure this path cannot. That
 * difference shows up in the structural column of the OCR rows in `docs/FIDELITY.md`,
 * which is the honest way to present it.
 */
import type { PageImage, RecognizedBlock, RecognizedPage } from "./index.js";

export const TESSERACT_VERSION = "6.x";

export interface TesseractOptions {
  /**
   * Directory holding `<lang>.traineddata` (or its `.gz`). Required, because the
   * alternative is an undeclared network fetch.
   */
  langPath?: string;
  lang?: string;
  /** Explicit consent to let tesseract.js fetch its language data over the network. */
  allowDownload?: boolean;
  /** Where tesseract.js may cache what it fetched. */
  cachePath?: string;
}

/**
 * Builds a recogniser. Nothing is loaded until the first page is recognised, and the
 * worker is created once and reused across pages — worker startup dominates the cost of
 * a short document.
 */
export function createTesseractRecognizer(options: TesseractOptions = {}) {
  const lang = options.lang ?? "eng";
  if (options.langPath === undefined && options.allowDownload !== true) {
    throw new Error(
      `adapters-ocr: tesseract needs its language data. Pass langPath pointing at a ` +
        `directory containing ${lang}.traineddata (from ` +
        `https://github.com/tesseract-ocr/tessdata_fast), or pass allowDownload: true to ` +
        `let tesseract.js fetch it. It is not downloaded by default because brief §3.6 ` +
        `makes every network call opt-in and explicit, and "OCR quietly worked because a ` +
        `CDN was up" is not an offline guarantee.`,
    );
  }

  let worker: TesseractWorker | undefined;

  const ensureWorker = async (): Promise<TesseractWorker> => {
    if (worker) return worker;
    let module: { createWorker: CreateWorker };
    try {
      module = (await import("tesseract.js")) as unknown as { createWorker: CreateWorker };
    } catch (error) {
      throw new Error(
        `adapters-ocr: tesseract.js is not installed (${(error as Error).message}). It is ` +
          `an optional dependency because it is a WASM bundle most conversions never ` +
          `touch. Install it, or use the vision recogniser instead.`,
      );
    }
    worker = await module.createWorker(lang, 1, {
      ...(options.langPath !== undefined ? { langPath: options.langPath } : {}),
      ...(options.cachePath !== undefined ? { cachePath: options.cachePath } : {}),
      // No logger: tesseract.js's default logger writes progress to stdout, which would
      // corrupt `--json` output on the one command most likely to be piped.
      logger: () => {},
    });
    return worker;
  };

  const recognize = async (page: PageImage): Promise<RecognizedPage> => {
    const w = await ensureWorker();
    const result = await w.recognize(Buffer.from(page.bytes));
    const data = result.data;
    return {
      blocks: blocksFrom(data),
      // Tesseract reports 0–100. Rounded to two places so a committed baseline does not
      // churn on floating-point noise.
      confidence: Math.round(Math.max(0, Math.min(100, data.confidence ?? 0))) / 100,
      engine: { kind: "ocr", engine: "tesseract.js", version: TESSERACT_VERSION },
    };
  };

  recognize.close = async (): Promise<void> => {
    await worker?.terminate();
    worker = undefined;
  };

  return recognize;
}

const BULLET = /^\s*[•·▪◦‣*-]\s+(\S.*)$/;

/**
 * Paragraphs from the flat text, because that is the part of the API that has been
 * stable across tesseract.js versions.
 *
 * v5 stopped returning `blocks`/`paragraphs` unless they are explicitly requested, and
 * dropped the font attributes older versions exposed. Depending on that shape would make
 * this file break on a minor upgrade of an optional dependency, which is a bad trade for
 * structure this recogniser cannot reliably supply anyway.
 */
function blocksFrom(data: { text?: string }): RecognizedBlock[] {
  const text = (data.text ?? "").replace(/\r\n/g, "\n");
  const out: RecognizedBlock[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;

    // A chunk whose every line carries a bullet is a list; one where only some do is
    // prose that happened to wrap after a dash, and merging is the safer reading.
    const bulleted = lines.map((l) => BULLET.exec(l));
    if (bulleted.every((m) => m !== null)) {
      for (const match of bulleted) out.push({ kind: "listItem", text: match![1]! });
      continue;
    }
    out.push({ kind: "paragraph", text: joinHyphenated(lines) });
  }
  return out;
}

/** Rejoins a word split across a line break by hyphenation, as SPEC §3.3 requires. */
function joinHyphenated(lines: string[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (next !== undefined && /[a-z]-$/.test(line) && /^[a-z]/.test(next)) {
      out += line.slice(0, -1);
      continue;
    }
    out += line;
    if (next !== undefined) out += " ";
  }
  return out;
}

// The slice of tesseract.js's surface this file uses. Written out rather than imported
// so the package typechecks whether or not the optional dependency is installed.
type CreateWorker = (
  lang: string,
  oem: number,
  options: Record<string, unknown>,
) => Promise<TesseractWorker>;

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<void>;
}
