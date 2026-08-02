"use client";

import type { BrowserPdfRenderer } from "@markforge/browser";
import { loadScript } from "@/lib/engine";

export type PdfRenderer = BrowserPdfRenderer;

/**
 * The PDF path, and why it is a button rather than a background task.
 *
 * Writing a PDF needs the Typst compiler as WebAssembly plus the shipped font set. That is
 * roughly 29 MB before compression, and ADR-0015's whole argument for a second entry point is
 * that people who never render a PDF should not pay for one. So nothing here runs until a
 * user asks for a PDF, and the size is stated before the download starts rather than after.
 */

export const PDF_ASSET_BYTES = 28_325_178 + 1_637_000; // typst.wasm + the five faces

export interface PdfLoadProgress {
  /** Bytes of the WASM received so far. The fonts are small enough not to bother reporting. */
  received: number;
  total: number;
  stage: "compiler" | "fonts" | "starting";
}

interface FontManifestEntry {
  family: string;
  file: string;
}

async function fetchWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  // No streaming body (an old browser, or a proxy that buffered): fall back to the whole
  // thing at once. The progress bar just jumps, which beats failing.
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

let rendererPromise: Promise<PdfRenderer> | undefined;

/**
 * Loads the compiler once and returns a renderer bound to the shipped fonts.
 *
 * The font set is not optional. Compiling without it produces a structurally valid PDF with
 * zero extractable text and throws nothing, which is the failure this whole function is
 * arranged to make impossible rather than merely unlikely.
 */
export function loadPdfRenderer(onProgress?: (p: PdfLoadProgress) => void): Promise<PdfRenderer> {
  rendererPromise ??= (async () => {
    onProgress?.({ received: 0, total: PDF_ASSET_BYTES, stage: "compiler" });

    await loadScript("/markforge/markforge-pdf.js");
    const pdfEngine = window.MarkForgePdf;
    if (!pdfEngine) throw new Error("markforge-pdf.js loaded but defined no MarkForgePdf global.");

    const wasm = await fetchWithProgress("/markforge/typst.wasm", (received, total) =>
      onProgress?.({ received, total: total || PDF_ASSET_BYTES, stage: "compiler" }),
    );

    onProgress?.({ received: wasm.length, total: PDF_ASSET_BYTES, stage: "fonts" });
    const manifest = (await fetch("/markforge/fonts/manifest.json").then((r) =>
      r.json(),
    )) as FontManifestEntry[];
    const fonts = await Promise.all(
      manifest.map(async (f) => {
        const response = await fetch(`/markforge/fonts/${f.file}`);
        const buffer: ArrayBuffer = await response.arrayBuffer();
        return { family: f.family, bytes: new Uint8Array(buffer) };
      }),
    );

    onProgress?.({ received: PDF_ASSET_BYTES, total: PDF_ASSET_BYTES, stage: "starting" });

    // `loadFonts` lives in options.init.mjs and is not re-exported from ./compiler, so the
    // namespace the loader wants is assembled from two imports. Same two files
    // scripts/check-surface-parity.mjs uses, for the same reason.
    const [compiler, init] = await Promise.all([
      import("@myriaddreamin/typst.ts/compiler"),
      import("@myriaddreamin/typst.ts/dist/esm/options.init.mjs"),
    ]);

    /*
     * Cast through `unknown`, deliberately.
     *
     * `TypstCompilerModule` in @markforge/browser/pdf is a structural description of the
     * three things the loader touches, declared rather than imported so that package has no
     * dependency on the binding. The binding's real types are far more specific: `compile`
     * is an overload set keyed on a format enum, and `loadFonts` takes a mutable array of
     * strings, byte arrays or lazy fonts. Neither is assignable to a `Record<string, unknown>`
     * signature in either direction, and no amount of restating the structural type fixes
     * that, because the two are describing the same function at different resolutions.
     *
     * The cast is safe for the reason the shapes disagree: every call the loader makes is a
     * strict subset of what the binding accepts. The version is pinned to 0.7.0 in this
     * package and at the repo root, so this cannot silently drift onto a different API.
     */
    const compilerModule = {
      createTypstCompiler: compiler.createTypstCompiler,
      CompileFormatEnum: compiler.CompileFormatEnum,
      loadFonts: (init as unknown as { loadFonts: TypstLoadFonts }).loadFonts,
    } as unknown as Parameters<typeof pdfEngine.loadPdfRenderer>[0]["compilerModule"];

    const { render } = await pdfEngine.loadPdfRenderer({ wasm, fonts, compilerModule });

    return render;
  })().catch((e: unknown) => {
    // Not cached as a permanent failure. A 29 MB download can fail for reasons that go away.
    rendererPromise = undefined;
    throw e;
  });

  return rendererPromise;
}

type TypstLoadFonts = (paths: readonly string[], options: Record<string, unknown>) => unknown;

/** True once the compiler is resident, without starting a download. */
export function pdfRendererLoaded(): boolean {
  return rendererPromise !== undefined;
}

/**
 * What the UI states before the download and again beside the result.
 *
 * Every line is a limit recorded in docs/LIMITS.md §7. A converter that offered PDF output
 * without saying these would be the one dishonest surface in the project.
 */
export const PDF_LIMITS = [
  "Fonts are Latin and mono only. A document needing CJK, emoji or Arabic is not covered, and the missing glyphs are reported rather than substituted from your machine.",
  "Images are not embedded. Alt text is written in their place, with a diagnostic.",
  "Style profiles do not reach this renderer. All three render identically.",
  "TeX math is emitted as literal text, not typeset. Typst math is a different language.",
] as const;
