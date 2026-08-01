/**
 * @markforge/browser — the browser entry point (ADR-0015, brief §3.6 and §8).
 *
 * ## Why this package exists at all
 *
 * `@markforge/core` is already pure — bytes in, bytes out — so a browser could import it
 * directly and this package could be nothing. Brief §13 forbids a package without a
 * justification, so here it is: **this file is the list of what is in the browser build.**
 * The bundle's contents are a decision recorded in a module rather than whatever a
 * tree-shaker happened to keep, and `scripts/check-surface-parity.mjs` builds exactly this
 * entry point. Adding something Node-only to the browser build means editing this file,
 * which is a diff someone reviews.
 *
 * ## What "no filesystem, no ambient config" means here
 *
 * ADR-0015: "Browser entry points take bytes and an explicit config object." So there is
 * no `Host`, no path argument that could be opened, and no environment read. `path` on
 * `BrowserConvertOptions` is a **label** used for provenance and for format inference —
 * nothing in this package can open it, which is a property of the code rather than a
 * promise about how it will be called.
 *
 * ## What is deliberately absent
 *
 * - **PDF, OCR, and PDF rendering.** ADR-0015 defers all three behind a lazy load. As of
 *   2026-08-01 the deferred `adapters-pdf` chunk still imports `node:module`, `node:path`,
 *   and `node:zlib`, so it is not merely un-bundled here — it would not run. `render-pdf`
 *   does not exist. `convertInBrowser` refuses these formats by name rather than failing
 *   somewhere internal, and the message says which.
 * - **The LLM layer.** ADR-0015: LLM features degrade to unavailable, never to
 *   silently-different output. This package does not depend on `@markforge/llm` and takes
 *   no `assist`, so a browser run is exactly a `--no-llm` CLI run — including the ambiguity
 *   warnings that mode emits, which is what makes the two comparable byte for byte.
 */
import { convert, parse, render, formatMarkdownSync, formatFromPath, type Format } from "@markforge/core";
import type { Diagnostic, MarkForgeDocument } from "@markforge/ir";

/** Formats the browser build can read. PDF, PPTX, and XLSX are not among them — see below. */
export const BROWSER_INPUT_FORMATS = ["md", "docx", "html"] as const;
/** Formats the browser build can write. */
export const BROWSER_OUTPUT_FORMATS = ["md", "docx", "html"] as const;

export type BrowserInputFormat = (typeof BROWSER_INPUT_FORMATS)[number];
export type BrowserOutputFormat = (typeof BROWSER_OUTPUT_FORMATS)[number];

/**
 * Why the input list is shorter than the CLI's.
 *
 * `pptx` and `xlsx` are read by `@markforge/adapters-office`, which bundles for the
 * browser cleanly — they are excluded because including them would put their weight in
 * the eager chunk for formats the DOCX↔Markdown story does not need, and ADR-0015's
 * whole size argument is that the primary path stays small. Reversing that is one entry
 * in this array plus one import, which is the point of keeping the list here.
 */
const REFUSAL: Record<string, string> = {
  pdf: "PDF needs `adapters-pdf`, which ADR-0015 defers behind a lazy load and which still imports node:module, node:path, and node:zlib as of 2026-08-01 — it is not browser-capable yet, only deferred.",
  pptx: "PPTX is readable in Node (`markforge convert`) but is not in the browser bundle, to keep the eager chunk to the DOCX/Markdown/HTML path (ADR-0015).",
  xlsx: "XLSX is readable in Node (`markforge convert`) but is not in the browser bundle, to keep the eager chunk to the DOCX/Markdown/HTML path (ADR-0015).",
};

export interface BrowserConvertOptions {
  from?: BrowserInputFormat;
  to?: BrowserOutputFormat;
  /**
   * A label, not a path. Used for format inference and for provenance locators; nothing
   * in this package can open it, because nothing here has a filesystem.
   */
  path?: string;
  /** A reference DOCX, supplied as bytes by the caller. There is no path to read one from. */
  referenceDoc?: Uint8Array;
}

export interface BrowserConvertResult {
  bytes: Uint8Array;
  document: MarkForgeDocument;
  diagnostics: Diagnostic[];
}

function assertBrowserFormat(format: string, role: "input" | "output"): void {
  const allowed: readonly string[] = role === "input" ? BROWSER_INPUT_FORMATS : BROWSER_OUTPUT_FORMATS;
  if (allowed.includes(format)) return;
  throw new Error(
    `markforge (browser): ${format} is not a supported ${role} format here. ` +
      (REFUSAL[format] ?? `Supported: ${allowed.join(", ")}.`),
  );
}

/**
 * Converts one document, entirely in the browser.
 *
 * The output must be byte-identical to `markforge convert` on the same input — that is
 * Phase 5's done-criterion and `scripts/check-surface-parity.mjs` asserts it, so this
 * function deliberately adds nothing to the pipeline: no defaults of its own, no
 * normalisation, no post-processing. Anything it added would be a divergence.
 */
export async function convertInBrowser(
  bytes: Uint8Array,
  options: BrowserConvertOptions = {},
): Promise<BrowserConvertResult> {
  const from = options.from ?? (options.path ? (formatFromPath(options.path) as BrowserInputFormat) : undefined);
  if (!from) throw new Error("markforge (browser): `from` is required when `path` does not imply a format");
  const to = options.to ?? "md";
  assertBrowserFormat(from, "input");
  assertBrowserFormat(to, "output");

  // No `assist`. See the module comment: a browser run is a `--no-llm` run.
  const result = await convert(bytes, {
    from: from as Format,
    to: to as Format,
    ...(options.path ? { path: options.path } : {}),
    ...(options.referenceDoc ? { docx: { referenceDoc: options.referenceDoc } } : {}),
  });
  return { bytes: result.bytes, document: result.document, diagnostics: result.diagnostics };
}

/** `markforge fmt`, in the browser. Synchronous, matching `formatMarkdownSync`. */
export function formatMarkdownInBrowser(source: string): { markdown: string; changed: boolean } {
  const result = formatMarkdownSync(source);
  return { markdown: result.markdown, changed: result.changed };
}

export { parse, render };
export type { Diagnostic, MarkForgeDocument };
