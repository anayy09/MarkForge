/**
 * Page images out of a scanned PDF, plus the PNG encoder that makes them portable.
 *
 * A scan is a PDF whose pages are one big raster each, so getting at the raster is
 * getting at the document. pdf.js exposes it through the page's operator list rather
 * than through a document API: walk the operators, find the `paintImageXObject`, and
 * fetch the object by name. That is more indirect than it should be, and it is still the
 * right route — the alternative is *rendering* the page, which needs a canvas
 * implementation pdf.js cannot polyfill in Node, so a native dependency would be the
 * price of reading a scan.
 *
 * Consequence worth stating: this reads the image a scan **contains**, not a picture of
 * what a page **looks like**. For a scan those are the same thing. For a born-digital
 * page with vector graphics and a text layer they are not, which is fine, because that
 * page has a text layer and never comes here.
 *
 * The PNG encoder is thirty lines and deterministic (fixed deflate level, no timestamp
 * chunk), which matters because the committed LLM cache is keyed on these bytes.
 */
import { deflateSync } from "node:zlib";
import { DiagnosticBag, DiagnosticCode } from "@markforge/ir";

/**
 * Structurally identical to `PageImage` in `@markforge/adapters-ocr`, and deliberately
 * not imported from it: SPEC §11 forbids one adapter from depending on another. The
 * duplication is ten lines and `packages/core/test/ocr.test.ts` asserts the two types are
 * mutually assignable, so drift fails the build rather than surfacing as a cast.
 */
export interface PageImage {
  pageNumber: number;
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

/** The subset of a pdf.js page this module touches. */
interface PdfPageLike {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: {
    has?(name: string): boolean;
    get(name: string, callback: (value: unknown) => void): void;
  };
  commonObjs?: {
    has?(name: string): boolean;
    get(name: string, callback: (value: unknown) => void): void;
  };
}

interface RawImage {
  width: number;
  height: number;
  /** pdf.js image kinds: 1 = grey 1bpp, 2 = RGB 24bpp, 3 = RGBA 32bpp. */
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

export interface ExtractOptions {
  /** `OPS` from the pdf.js module, passed in so this file imports nothing heavy. */
  ops: Record<string, number>;
  diagnostics: DiagnosticBag;
}

/**
 * The largest raster painted on the page, as a PNG.
 *
 * Largest rather than first: a scanned page occasionally carries a small logo or a
 * scanner watermark alongside the page image, and the page image is always the big one.
 */
export async function pageImage(
  page: PdfPageLike,
  pageNumber: number,
  { ops, diagnostics }: ExtractOptions,
): Promise<PageImage | undefined> {
  const list = await page.getOperatorList();
  const paintOps = new Set(
    [ops["paintImageXObject"], ops["paintImageMaskXObject"], ops["paintInlineImageXObject"]].filter(
      (n): n is number => typeof n === "number",
    ),
  );

  let best: RawImage | undefined;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (fn === undefined || !paintOps.has(fn)) continue;
    const args = list.argsArray[i] ?? [];
    const first = args[0];

    // An inline image arrives as the argument itself; an XObject arrives as a name to
    // look up in the page's object store, or the document's shared one.
    const raw =
      typeof first === "string"
        ? await lookup(page, first)
        : isRawImage(first)
          ? first
          : undefined;
    if (!raw || !raw.data) continue;
    if (!best || raw.width * raw.height > best.width * best.height) best = raw;
  }

  if (!best || !best.data) {
    diagnostics.lost(
      DiagnosticCode.PDF_PAGE_IMAGE_UNAVAILABLE,
      "page",
      `Page ${pageNumber} has no text layer and no raster this reader can extract, so ` +
        `there is nothing to transcribe. Pages drawn with vector operators need a page ` +
        `rasteriser, which would mean a native canvas dependency (ADR-0012).`,
      { locator: { kind: "page", pageNumber } },
    );
    return undefined;
  }

  return {
    pageNumber,
    bytes: encodePng(best),
    mediaType: "image/png",
    width: best.width,
    height: best.height,
  };
}

/**
 * Fetches an image object by name, from the page's store or the document's shared one.
 *
 * **Do not gate this on `objs.has(name)`.** The first version did, and extracted nothing:
 * pdf.js's `has` reports whether an object is *already resolved*, while the callback form
 * of `get` registers interest and fires when it is. So `has` answered false for an image
 * that `get` produced immediately afterwards, and every scanned page came back with "no
 * raster this reader can extract" — a plausible-looking diagnostic for a file that was
 * fine. Caught by running the pipeline end to end after a scratch script had already
 * proved the extraction worked, which is why both were worth doing.
 */
async function lookup(page: PdfPageLike, name: string): Promise<RawImage | undefined> {
  for (const store of [page.objs, page.commonObjs]) {
    if (!store) continue;
    const value = await new Promise<unknown>((resolve) => {
      try {
        store.get(name, resolve);
      // degradation: emits MF-PDF-0002 — the caller raises PDF_PAGE_IMAGE_UNAVAILABLE for the page whose raster came back undefined (pages.ts:102)
      } catch {
        // `get` throws for an object this store does not know about at all. A missing
        // image is a diagnostic, not a crash.
        resolve(undefined);
      }
    });
    if (isRawImage(value)) return value;
  }
  return undefined;
}

function isRawImage(value: unknown): value is RawImage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as RawImage;
  return typeof v.width === "number" && typeof v.height === "number";
}

const GREY_1BPP = 1;
const RGB_24BPP = 2;

/** Encodes to PNG: greyscale for a bitonal scan, RGB otherwise. */
export function encodePng(image: RawImage): Uint8Array {
  const { width, height, kind, data } = image;
  if (!data) throw new Error("adapters-pdf: cannot encode an image with no pixel data");

  const grey = kind === GREY_1BPP;
  const channels = grey ? 1 : 3;
  const stride = width * channels + 1; // one filter byte per row
  const raw = new Uint8Array(stride * height);

  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    let p = y * stride;
    raw[p++] = 0; // filter type 0 (None): the smallest, simplest, and most portable
    for (let x = 0; x < width; x++) {
      if (grey) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0xff;
        // 1 is white in pdf.js's 1bpp greyscale, matching PDF's DeviceGray.
        raw[p++] = (byte >> (7 - (x & 7))) & 1 ? 0xff : 0x00;
      } else if (kind === RGB_24BPP) {
        const i = (y * width + x) * 3;
        raw[p++] = data[i] ?? 0;
        raw[p++] = data[i + 1] ?? 0;
        raw[p++] = data[i + 2] ?? 0;
      } else {
        // RGBA, composited onto white: a scan has no meaningful transparency, and a
        // transparent PNG sent to a vision model renders as black on most stacks.
        const i = (y * width + x) * 4;
        const a = (data[i + 3] ?? 255) / 255;
        raw[p++] = Math.round((data[i] ?? 0) * a + 255 * (1 - a));
        raw[p++] = Math.round((data[i + 1] ?? 0) * a + 255 * (1 - a));
        raw[p++] = Math.round((data[i + 2] ?? 0) * a + 255 * (1 - a));
      }
    }
  }

  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = grey ? 0 : 2; // colour type: 0 greyscale, 2 truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  writeUint32(out, 0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const crcInput = out.subarray(4, 8 + body.length);
  writeUint32(out, 8 + body.length, crc32(crcInput));
  return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
