/**
 * @markforge/core — pipeline orchestration and the host interface.
 *
 * The host interface exists because of ADR-0015: the deterministic core has to run
 * identically in Node and in a browser, and that only stays true if `node:fs` never
 * leaks into shared code. Retrofitting this later reliably fails, because `node:fs`
 * and `process.env` accrete throughout a codebase in the meantime.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  type Diagnostic,
  type MarkForgeDocument,
} from "@markforge/ir";
import { parseDocx } from "@markforge/adapters-docx";
import { parseMarkdown } from "@markforge/adapters-md";
import { renderMarkdown, type MarkdownRenderOptions } from "@markforge/render-md";
import { renderDocx, type DocxRenderOptions } from "@markforge/render-docx";
import { parseHtmlDocument } from "@markforge/adapters-html";
import { renderHtml, DEFAULT_STYLESHEET, type HtmlRenderOptions } from "@markforge/render-html";
import { parsePptx, parseXlsx } from "@markforge/adapters-office";
import {
  inferAll,
  explainDecisions,
  resolveAmbiguities,
  type Decision,
  type HeadingTiebreaker,
  type InferOptions,
} from "@markforge/infer";
import { documentFromPages, type PageImage, type Recognizer } from "@markforge/adapters-ocr";

const CORE = { kind: "rule" as const, name: "@markforge/core", version: "0.1.0" };

/**
 * Everything the pipeline needs from its environment.
 *
 * Deliberately tiny. A host is a few functions, not a framework, and keeping it
 * that way is what makes the browser implementation trivial rather than a project.
 */
export interface Host {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Formats the pipeline understands.
 *
 * Input-only formats are listed too: PPTX and XLSX have adapters but no renderers,
 * because nobody asked to *generate* a spreadsheet and building one on speculation
 * would be machinery with no user. `render` rejects them by name rather than by
 * falling through to a default, so the limit is a message rather than a surprise.
 */
export type Format = "md" | "docx" | "html" | "pptx" | "xlsx" | "pdf";

/** Formats that can be written, as opposed to only read. */
export const OUTPUT_FORMATS = ["md", "docx", "html"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const isOutputFormat = (f: Format): f is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(f);

/** Detects a format from a file extension. An explicit `--to`/`--from` always wins. */
export function formatFromPath(path: string): Format | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "md";
    case "docx":
      return "docx";
    case "html":
    case "htm":
      return "html";
    case "pptx":
      return "pptx";
    case "xlsx":
      return "xlsx";
    case "pdf":
      return "pdf";
    default:
      return undefined;
  }
}

/**
 * The optional assistance the deterministic pipeline will accept.
 *
 * **Both fields are functions, and neither type comes from `@markforge/llm`.** Core does
 * not import the LLM layer at all — not for a policy reason but for two structural ones:
 * ADR-0015 requires this package to run unchanged in a browser, where `node:fs` (which the
 * prompt loader and the cache need) does not exist; and ADR-0009's rule that the conversion
 * path cannot reach a model is only enforceable if the path has no such import to enforce
 * against. So the CLI composes: it builds these two functions from a session and hands them
 * in. `@markforge/llm` exports `headingTiebreaker` and `visionRecognizer` for exactly this.
 *
 * Absent assistance is `--no-llm`, which is the default (ADR-0009).
 */
export interface Assist {
  /** Resolves an ambiguous heading level from its own candidate set (SPEC §5.1). */
  headingTiebreak?: HeadingTiebreaker;
  /** Transcribes a page image when a PDF has no text layer (SPEC §3.3). */
  recognize?: Recognizer;
  /**
   * Reads a PDF. **Injected, not imported** — see `PdfReader`.
   *
   * Absent means this build cannot read PDFs, and `parse` says so by name rather than
   * failing somewhere internal.
   */
  readPdf?: PdfReader;
}

/**
 * The PDF reader, supplied by the host rather than imported by this package.
 *
 * `core` used to reach `@markforge/adapters-pdf` through `await import(...)`, on the
 * reasoning that a dynamic import is the lazy boundary ADR-0015 asks for. Measured, it is
 * not: a bundler follows a dynamic import like any other, so **`@markforge/core` and
 * `@markforge/browser` failed to bundle for a browser under every standard esbuild
 * configuration**, including `splitting: true` — splitting decides which *chunk* a module
 * lands in, not whether `node:zlib` resolves. The browser gate only passed because it
 * supplied a stub plugin, which meant a build-tool flag was standing in for a property of
 * the code.
 *
 * Injection is the pattern this codebase already chose for exactly this problem: ADR-0017
 * made the OCR recogniser an injected function, and `@markforge/adapters-ocr` bundles for
 * a browser cleanly as a direct result. The PDF reader is the same shape and gets the same
 * treatment, so `core` now has no reference of any kind to `adapters-pdf` and both it and
 * the browser entry bundle with no plugin, no external, and no stub.
 */
export type PdfReader = (
  bytes: Uint8Array,
  options: { path?: string },
) => Promise<
  | { kind: "text"; document: MarkForgeDocument; diagnostics: DiagnosticBag }
  | { kind: "scan"; pages: PageImage[]; charsPerPage: number; pageCount: number; diagnostics: DiagnosticBag }
>;

export interface ConvertOptions {
  from?: Format;
  to?: Format;
  /** Off means no heading promotion — evidence stays evidence. */
  infer?: InferOptions | false;
  markdown?: MarkdownRenderOptions;
  docx?: Omit<DocxRenderOptions, "referenceDoc"> & { referenceDoc?: Uint8Array };
  html?: HtmlRenderOptions;
  /** Collect the inference decision log for `--explain`. */
  explain?: boolean;
  /** Optional, opt-in, and off by default. See `Assist`. */
  assist?: Assist;
}

export interface ConvertResult {
  bytes: Uint8Array;
  document: MarkForgeDocument;
  diagnostics: Diagnostic[];
  decisions: Decision[];
  explanation?: string;
}

/**
 * Parses bytes into the IR.
 *
 * **Async, like every entry point here** (OPEN_QUESTIONS §7j). There was briefly a
 * `parse`/`parseAsync` pair, on the reasoning that a Markdown conversion does no I/O and
 * should not force callers to await. Reversed: the sync half could only ever cover
 * Markdown-to-Markdown, because `typst.ts` needs async WASM init, the DOCX renderer reads
 * a reference document, and the browser build has no synchronous file access at all — so
 * the pair bought one saved `await` in exchange for a second public surface that every
 * adapter and renderer had to keep in parity, plus a "which variant does this go in"
 * decision on every future contribution. `formatMarkdownSync` is the single, deliberately
 * narrow exception.
 */
export async function parse(
  bytes: Uint8Array,
  format: Format,
  path?: string,
  assist?: Assist,
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
  const opts = path !== undefined ? { path } : {};
  switch (format) {
    case "docx":
      return parseDocx(bytes, opts);
    case "md":
      return parseMarkdown(bytes, opts);
    case "html":
      return parseHtmlDocument(bytes, opts);
    case "pptx":
      return parsePptx(bytes, opts);
    case "xlsx":
      return parseXlsx(bytes, opts);
    case "pdf":
      return parsePdfOrScan(bytes, path, assist);
  }
}

/**
 * Reads a PDF, routing to a recogniser when it turns out to be a scan.
 *
 * The routing decision belongs here rather than in either adapter: `adapters-pdf` may not
 * depend on `adapters-ocr` and vice versa (SPEC §11), so this is the one place that knows
 * both exist. `readPdf` reports which kind of PDF it found in a single pass, and the scan
 * branch carries the page images with it.
 */
async function parsePdfOrScan(
  bytes: Uint8Array,
  path: string | undefined,
  assist: Assist | undefined,
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
  if (!assist?.readPdf) {
    throw new Error(
      `markforge: reading "${path ?? "a PDF"}" needs a PDF reader, and this build has none. ` +
        `The Node CLI injects @markforge/adapters-pdf; the browser build does not, because ` +
        `that package requires node:module, node:path, and node:zlib (ADR-0015 defers it, ` +
        `and deferred is not the same as browser-capable).`,
    );
  }
  const result = await assist.readPdf(bytes, path !== undefined ? { path } : {});
  if (result.kind === "text") {
    return { document: result.document, diagnostics: result.diagnostics };
  }

  if (!assist?.recognize) {
    throw new Error(
      `markforge: "${path ?? "this PDF"}" has no text layer ` +
        `(${Math.round(result.charsPerPage)} character(s) per page across ` +
        `${result.pageCount} page(s)) — it is a scan, and ${result.pages.length} page ` +
        `image(s) were extracted but no recogniser was supplied. Pass --ocr to transcribe ` +
        `it locally with tesseract, or --llm to use a vision model. Returning an empty ` +
        `document would look like a successful conversion.`,
    );
  }

  const ocr = await documentFromPages(result.pages, assist.recognize, {
    ...(path !== undefined ? { path } : {}),
    sourceBytes: bytes,
    mediaType: "application/pdf",
  });
  // Both bags: the PDF adapter's says why OCR happened, the OCR adapter's says what it
  // produced and how confident it was. Dropping either would make the output's provenance
  // incomplete in one direction or the other.
  ocr.diagnostics.merge(result.diagnostics);
  ocr.document.diagnostics = ocr.diagnostics.all();
  return ocr;
}

/**
 * Renders the IR into bytes. Throws for input-only formats, by name.
 *
 * Async even though every renderer built so far is synchronous, because the next one is
 * not: ADR-0003 chose Typst, and `typst.ts` needs asynchronous WASM initialisation. A
 * signature that changed the day PDF output landed would break every caller then instead
 * of costing one `await` now (OPEN_QUESTIONS §7j).
 */
export async function render(
  document: MarkForgeDocument,
  format: Format,
  options: ConvertOptions = {},
): Promise<{ bytes: Uint8Array; diagnostics: DiagnosticBag }> {
  switch (format) {
    case "md": {
      const result = renderMarkdown(document, options.markdown ?? {});
      return { bytes: new TextEncoder().encode(result.markdown), diagnostics: result.diagnostics };
    }
    case "docx": {
      /*
       * `onMissingStyle` defaults to "synthesize" **here**, not in the CLI.
       *
       * It was a CLI default, so `markforge convert` synthesized missing styles and the HTTP
       * API, the MCP server, and the browser build did not — four surfaces, two behaviours.
       * `scripts/check-surface-parity.mjs` caught it the moment W1 added styles to the
       * fallback stylesheet that made the two paths produce different bytes: CLI 3430,
       * the other three 3444.
       *
       * The divergence predates that change; it was simply invisible while both paths
       * happened to emit the same styles.xml. A default that lives in one surface is a
       * default the other surfaces do not have, which is what "four surfaces, one engine"
       * is supposed to rule out.
       */
      const result = renderDocx(document, { onMissingStyle: "synthesize", ...(options.docx ?? {}) });
      return { bytes: result.bytes, diagnostics: result.diagnostics };
    }
    case "html": {
      const result = renderHtml(document, {
        stylesheet: DEFAULT_STYLESHEET,
        ...(options.html ?? {}),
      });
      return { bytes: new TextEncoder().encode(result.html), diagnostics: result.diagnostics };
    }
    case "pptx":
    case "xlsx":
    case "pdf":
      throw new Error(
        `markforge: ${format} is an input format only. MarkForge reads presentations, ` +
          `spreadsheets, and PDFs but does not generate them — PDF output needs a layout ` +
          `engine (ADR-0003 chose Typst) and is not built yet, and nobody asked to ` +
          `generate a spreadsheet. Convert to md, docx, or html instead.`,
      );
  }
}

/**
 * The whole pipeline: parse, infer, render.
 *
 * Inference sits between the two on purpose. Adapters record evidence (A5) and
 * renderers consume structure, so the one place that turns evidence into structure
 * is here, in the open, where it can be logged and turned off.
 */
export async function convert(
  bytes: Uint8Array,
  options: ConvertOptions & { from: Format; to: Format; path?: string },
): Promise<ConvertResult> {
  const all = new DiagnosticBag(CORE);

  const parsed = await parse(bytes, options.from, options.path, options.assist);
  all.merge(parsed.diagnostics);

  let decisions: Decision[] = [];
  if (options.infer !== false) {
    const inferred = inferAll(parsed.document, options.infer ?? {});
    all.merge(inferred.diagnostics);
    decisions = inferred.decisions;

    // The one place a model may influence a conversion (SPEC §5.1, §6.2): decisions the
    // deterministic scorer already declared too close to call, resolved from their own
    // candidate set. With no tie-breaker the rule's choice stands and the ambiguity is
    // already reported as a warning by `inferAll`, so the two paths differ only here.
    if (inferred.ambiguous.length > 0) {
      if (options.assist?.headingTiebreak) {
        const resolved = await resolveAmbiguities(
          parsed.document,
          inferred.ambiguous,
          options.assist.headingTiebreak,
        );
        all.merge(resolved.diagnostics);
        decisions = [...decisions, ...resolved.decisions];
      } else {
        all.info(
          DiagnosticCode.LLM_DISABLED_AMBIGUITY_STANDS,
          `${inferred.ambiguous.length} heading decision(s) were too close to call and the ` +
            `highest-scoring candidate was used. This run had no tie-breaker, which is the ` +
            `default: pass --llm to let a model choose among the candidates, and see ` +
            `--explain for the scores.`,
        );
      }
    }
  }

  const rendered = await render(parsed.document, options.to, options);
  all.merge(rendered.diagnostics);

  const diagnostics = all.all();
  parsed.document.diagnostics = diagnostics;

  const result: ConvertResult = {
    bytes: rendered.bytes, document: parsed.document, diagnostics, decisions,
  };
  if (options.explain) result.explanation = explainDecisions(decisions);
  return result;
}

/**
 * `fmt`: read Markdown, normalise, write Markdown.
 *
 * Idempotent by construction — the same parse and render the round-trip tests
 * exercise. `changed` is what `--check` reports, and it compares bytes rather than
 * trees so a whitespace-only difference still counts as a change.
 *
 * **The only synchronous entry point in this package, and it will not be generalised**
 * (OPEN_QUESTIONS §7j). Markdown-to-Markdown genuinely does no I/O, and `fmt` over a
 * thousand files should not pay for a thousand promises. The `Sync` suffix is the whole
 * point: it marks this as the exception rather than one of a matched pair, so there is no
 * "which variant does this belong in" question for anything added later. Every other
 * entry point — `parse`, `render`, `convert` — is async.
 */
export function formatMarkdownSync(
  source: string,
  options: MarkdownRenderOptions = {},
): { markdown: string; changed: boolean; diagnostics: Diagnostic[] } {
  const all = new DiagnosticBag(CORE);
  const parsed = parseMarkdown(source);
  all.merge(parsed.diagnostics);
  const rendered = renderMarkdown(parsed.document, options);
  all.merge(rendered.diagnostics);
  return {
    markdown: rendered.markdown,
    changed: rendered.markdown !== source,
    diagnostics: all.all(),
  };
}

/**
 * Exit codes, per docs/SPEC.md §8.
 *
 * Distinct codes rather than a single failure: a script needs to tell "the file was
 * unreadable" from "the file converted but lost something", and those call for
 * different responses.
 */
export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  /** Completed with lossy diagnostics **and** `--strict` was set. */
  STRICT_LOSSY: 2,
  /** `fmt --check` found files needing changes. */
  NEEDS_FORMATTING: 3,
  /** Fidelity regression against baseline. */
  FIDELITY_REGRESSION: 4,
  /** Agentify traceability gate failed. */
  TRACEABILITY: 5,
} as const;

/**
 * Re-exported so a surface can offer the flavour list without depending on the renderer.
 * One list, in `flavors.ts`; core is already the composition root that owns which renderer
 * is in use, and a CLI-local copy would be the thing that drifts.
 */
export { FLAVORS, resolveFlavor, type FlavorPreset } from "@markforge/render-md";

export type { Decision, AmbiguousDecision, HeadingTiebreaker, TiebreakAnswer } from "@markforge/infer";
export { explainDecisions } from "@markforge/infer";
export type { PageImage, RecognizedPage, Recognizer } from "@markforge/adapters-ocr";
export type { MarkForgeConfig } from "./generated/config.js";
