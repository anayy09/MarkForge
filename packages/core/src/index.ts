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
import { documentFromPages, type Recognizer } from "@markforge/adapters-ocr";

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
 * Absent assistance is `--no-llm`, which is the default (brief §3.6).
 */
export interface Assist {
  /** Resolves an ambiguous heading level from its own candidate set (SPEC §5.1). */
  headingTiebreak?: HeadingTiebreaker;
  /** Transcribes a page image when a PDF has no text layer (SPEC §3.3). */
  recognize?: Recognizer;
}

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

/** Parses bytes into the IR. */
export function parse(
  bytes: Uint8Array,
  format: Format,
  path?: string,
): { document: MarkForgeDocument; diagnostics: DiagnosticBag } {
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
      // PDF extraction is async, so it cannot be served here. Throwing names the
      // function that can, rather than returning undefined and failing later.
      throw new Error(
        "markforge: PDF parsing is asynchronous. Use parseAsync or convertAsync instead " +
          "of parse or convert.",
      );
  }
}

/**
 * Parses bytes into the IR, including the formats whose parsers are async.
 *
 * PDF extraction is inherently asynchronous (pdf.js is), so it needs this rather than
 * the synchronous `parse`. Kept separate instead of making everything async: a
 * Markdown conversion does no I/O and should not force every caller to await.
 */
export async function parseAsync(
  bytes: Uint8Array,
  format: Format,
  path?: string,
  assist?: Assist,
): Promise<{ document: MarkForgeDocument; diagnostics: DiagnosticBag }> {
  if (format === "pdf") return parsePdfOrScan(bytes, path, assist);
  return parse(bytes, format, path);
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
  const { readPdf } = await import("@markforge/adapters-pdf");
  const result = await readPdf(bytes, path !== undefined ? { path } : {});
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

/** Renders the IR into bytes. Throws for input-only formats, by name. */
export function render(
  document: MarkForgeDocument,
  format: Format,
  options: ConvertOptions = {},
): { bytes: Uint8Array; diagnostics: DiagnosticBag } {
  switch (format) {
    case "md": {
      const result = renderMarkdown(document, options.markdown ?? {});
      return { bytes: new TextEncoder().encode(result.markdown), diagnostics: result.diagnostics };
    }
    case "docx": {
      const result = renderDocx(document, options.docx ?? {});
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
export function convert(
  bytes: Uint8Array,
  options: ConvertOptions & { from: Format; to: Format; path?: string },
): ConvertResult {
  const all = new DiagnosticBag(CORE);

  if (options.assist?.headingTiebreak || options.assist?.recognize) {
    // A tie-break is a network call, so it cannot happen inside a synchronous function.
    // Naming the alternative beats silently ignoring the option, which would produce a
    // deterministic document while the caller believed a model had been consulted.
    throw new Error(
      "markforge: assistance (heading tie-breaking, OCR) is asynchronous. Use " +
        "convertAsync instead of convert, or drop the assist option to convert " +
        "deterministically.",
    );
  }

  const parsed = parse(bytes, options.from, options.path);
  all.merge(parsed.diagnostics);

  let decisions: Decision[] = [];
  if (options.infer !== false) {
    const inferred = inferAll(parsed.document, options.infer ?? {});
    all.merge(inferred.diagnostics);
    decisions = inferred.decisions;
  }

  const rendered = render(parsed.document, options.to, options);
  all.merge(rendered.diagnostics);

  const diagnostics = all.all();
  parsed.document.diagnostics = diagnostics;

  const result: ConvertResult = {
    bytes: rendered.bytes,
    document: parsed.document,
    diagnostics,
    decisions,
  };
  if (options.explain) result.explanation = explainDecisions(decisions);
  return result;
}

/** `convert`, for input formats whose parser is async (currently PDF). */
export async function convertAsync(
  bytes: Uint8Array,
  options: ConvertOptions & { from: Format; to: Format; path?: string },
): Promise<ConvertResult> {
  const all = new DiagnosticBag(CORE);

  const parsed = await parseAsync(bytes, options.from, options.path, options.assist);
  all.merge(parsed.diagnostics);

  let decisions: Decision[] = [];
  if (options.infer !== false) {
    const inferred = inferAll(parsed.document, options.infer ?? {});
    all.merge(inferred.diagnostics);
    decisions = inferred.decisions;

    // The one place a model may influence a conversion (brief §5.3, §7.1): decisions the
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

  const rendered = render(parsed.document, options.to, options);
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
 */
export function formatMarkdown(
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

export type { Decision, AmbiguousDecision, HeadingTiebreaker, TiebreakAnswer } from "@markforge/infer";
export { explainDecisions } from "@markforge/infer";
export type { PageImage, RecognizedPage, Recognizer } from "@markforge/adapters-ocr";
export type { MarkForgeConfig } from "./generated/config.js";
