/**
 * @markforge/browser — the browser entry point (ADR-0015, ADR-0009, SPEC §8).
 *
 * ## Why this package exists at all
 *
 * `@markforge/core` is already pure — bytes in, bytes out — so a browser could import it
 * directly and this package could be nothing. A package that exists without a stated
 * justification is one nobody can safely delete, so here is this one's: **this file is the list of what is in the browser build.**
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
 * - **PDF *reading* and OCR.** As of 2026-08-01 the deferred `adapters-pdf` chunk still
 *   imports `node:module`, `node:path`, and `node:zlib`, so it is not merely un-bundled here
 *   — it would not run. `convertInBrowser` refuses PDF *input* by name rather than failing
 *   somewhere internal, and the message says which.
 *
 * ## What arrived on 2026-08-02
 *
 * - **PDF *writing* is supported**, and this comment previously said `render-pdf` did not
 *   exist. It has since 2026-08-01. The renderer reaches Typst through a compiler the
 *   **caller supplies** (`BrowserConvertOptions.pdf`), so no Typst artifact enters this
 *   package's chunk and `check-browser-bundle.mjs`'s heavy-artifact probe stays satisfied.
 *   That is ADR-0015's "browser entry points take bytes and an explicit config object"
 *   applied to a compiler rather than to a document.
 *
 *   Two properties of that compiler are the caller's responsibility and are documented on
 *   `BrowserPdfCompiler`: it must be given the shipped font set, and its CDN font fetch must
 *   be disabled. Both were measured on 2026-08-02 — without fonts the output is a PDF with
 *   **zero extractable text**, and by default the WASM compiler fetches fonts from jsdelivr
 *   at init, which is a network call this project does not make by default.
 * - **The LLM layer.** ADR-0015: LLM features degrade to unavailable, never to
 *   silently-different output. This package does not depend on `@markforge/llm` and takes
 *   no `assist`, so a browser run is exactly a `--no-llm` CLI run — including the ambiguity
 *   warnings that mode emits, which is what makes the two comparable byte for byte.
 */
import { convert, parse, render, formatMarkdownSync, formatFromPath, type Format } from "@markforge/core";
import type { Diagnostic, DiagnosticBag, MarkForgeDocument } from "@markforge/ir";

/** Formats the browser build can read. PDF, PPTX, and XLSX are not among them — see below. */
export const BROWSER_INPUT_FORMATS = ["md", "docx", "html"] as const;
/** Formats the browser build can write. `pdf` needs a caller-supplied compiler. */
export const BROWSER_OUTPUT_FORMATS = ["md", "docx", "html", "pdf"] as const;

export type BrowserInputFormat = (typeof BROWSER_INPUT_FORMATS)[number];
export type BrowserOutputFormat = (typeof BROWSER_OUTPUT_FORMATS)[number];

/**
 * Refusal messages, keyed by format **and role**.
 *
 * It was keyed by format alone, which was invisible while no format differed between the two
 * roles. `pdf` is now writable and not readable, so a lookup that ignored the role would have
 * answered an output request with the input explanation — telling a user that writing a PDF
 * needs `adapters-pdf` and `node:zlib`, which is both wrong and unactionable.
 */
const REFUSAL: Record<string, Partial<Record<"input" | "output", string>>> = {
  pdf: {
    input:
      "Reading a PDF needs `adapters-pdf`, which ADR-0015 defers behind a lazy load and which still imports node:module, node:path, and node:zlib as of 2026-08-01 — it is not browser-capable, only deferred. Writing a PDF *is* supported: pass `pdf.compile`.",
  },
  pptx: {
    input:
      "PPTX is readable in Node (`markforge convert`) but is not in the browser bundle, to keep the eager chunk to the DOCX/Markdown/HTML path (ADR-0015).",
  },
  xlsx: {
    input:
      "XLSX is readable in Node (`markforge convert`) but is not in the browser bundle, to keep the eager chunk to the DOCX/Markdown/HTML path (ADR-0015).",
  },
};

/**
 * Why the *input* list is shorter than the CLI's.
 *
 * (This note sat above `REFUSAL` while describing `BROWSER_INPUT_FORMATS`, two constants
 * away from the thing it documents.)
 *
 * `pptx` and `xlsx` are read by `@markforge/adapters-office`, which bundles for the
 * browser cleanly — they are excluded because including them would put their weight in
 * the eager chunk for formats the DOCX↔Markdown story does not need, and ADR-0015's
 * whole size argument is that the primary path stays small. Reversing that is one entry
 * in that array plus one import, which is the point of keeping the list here.
 */

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
  /** Required to write a PDF. Build one with `loadPdfRenderer` from `@markforge/browser/pdf`. */
  pdf?: { render: BrowserPdfRenderer };
}

/**
 * A ready PDF writer, supplied by the page.
 *
 * **This file must not name `@markforge/render-pdf`, in any form.** It was written first as
 * `pdf: { compile }` with a dynamic `import("@markforge/render-pdf")` here, on the reasoning
 * that a dynamic import defers the weight. `check-browser-bundle.mjs` failed it immediately:
 * *"browser (eager) reaches render-pdf, which is not eager"*. That is the measurement
 * `@markforge/core` already records two constants above — a bundler follows a dynamic import
 * like any other — arriving a second time, in the file whose own module comment cites it.
 *
 * So the renderer is assembled entirely inside `@markforge/browser/pdf`, a separate entry
 * point, and arrives here as an opaque function. The type is structurally identical to core's
 * `PdfRenderer` and is declared rather than imported for the same reason.
 */
export type BrowserPdfRenderer = (
  document: MarkForgeDocument,
) => Promise<{ bytes: Uint8Array; diagnostics: DiagnosticBag }>;

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
      (REFUSAL[format]?.[role] ?? `Supported: ${allowed.join(", ")}.`),
  );
}

/**
 * Converts one document, entirely in the browser.
 *
 * The output must be byte-identical to `markforge convert` on the same input, which
 * `scripts/check-surface-parity.mjs` asserts, so this
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

  if (to === "pdf" && !options.pdf?.render) {
    throw new Error(
      "markforge (browser): writing a PDF needs a renderer, and this entry point does not " +
        "bundle one — doing so would put the Typst artifact in the eager chunk for every " +
        "caller, including those who never render a PDF (ADR-0015). Build one with " +
        "`loadPdfRenderer` from `@markforge/browser/pdf` and pass it as `pdf.render`.",
    );
  }

  // No `assist`. See the module comment: a browser run is a `--no-llm` run.
  const result = await convert(bytes, {
    from: from as Format,
    to: to as Format,
    ...(options.path ? { path: options.path } : {}),
    ...(options.referenceDoc ? { docx: { referenceDoc: options.referenceDoc } } : {}),
    // Passed straight through. Nothing is assembled here — see `BrowserPdfRenderer`.
    ...(options.pdf ? { pdf: { render: options.pdf.render } } : {}),
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
