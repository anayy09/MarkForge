/**
 * Diagnostics, per docs/SPEC.md §2.6.
 *
 * The load-bearing rule of the whole project (brief §3.3): anything an adapter
 * cannot represent emits a diagnostic. "Nothing is lost silently" is only a real
 * guarantee if losing something is *expensive* — so the loss invariant is testable
 * by comparing a fixture's construct inventory against the diagnostics, and any
 * difference the diagnostics do not account for is a bug.
 */

// The Diagnostic shape is defined by the schema and generated, not declared here
// (docs/SPEC.md §2.2). `lossy` is a boolean rather than a three-way enum because
// the invariant that matters is binary: either information was lost or it was not,
// and `--strict` needs exactly that bit.
import type { Diagnostic, Producer } from "./generated/ir.js";
export type { Diagnostic } from "./generated/ir.js";

export type Severity = Diagnostic["severity"];

/**
 * Code namespace: `MF-<AREA>-<NNNN>`.
 *
 * Codes are stable identifiers, so they are declared once here rather than written
 * as string literals at emit sites. A literal typo'd at an emit site produces a
 * diagnostic nobody can filter on, and filtering is the reason codes exist.
 */
export const DiagnosticCode = {
  // --- DOCX adapter -------------------------------------------------------
  DOCX_UNKNOWN_ELEMENT: "MF-DOCX-0052",
  DOCX_UNSUPPORTED_FIELD: "MF-DOCX-0061",
  DOCX_MISSING_THEME: "MF-DOCX-0070",
  DOCX_STYLE_NOT_FOUND: "MF-DOCX-0071",
  DOCX_NUMBERING_NOT_FOUND: "MF-DOCX-0072",
  DOCX_BROKEN_STYLE_CHAIN: "MF-DOCX-0073",
  DOCX_EMBEDDED_OBJECT: "MF-DOCX-0080",
  DOCX_TEXTBOX_FLATTENED: "MF-DOCX-0081",
  DOCX_FIELD_AS_TEXT: "MF-DOCX-0082",

  // --- Markdown adapter ---------------------------------------------------
  MD_UNKNOWN_CONSTRUCT: "MF-MD-0010",
  MD_RAW_HTML_PRESERVED: "MF-MD-0011",
  MD_FRONTMATTER_UNPARSEABLE: "MF-MD-0012",

  // --- Normalisation ------------------------------------------------------
  NORM_EMPTY_PARAGRAPH_REMOVED: "MF-NORM-0001",
  NORM_WHITESPACE_COLLAPSED: "MF-NORM-0002",
  NORM_SOFT_HYPHEN_REMOVED: "MF-NORM-0003",
  NORM_FIGURE_BOUND: "MF-NORM-0004",
  NORM_MARKS_MERGED: "MF-NORM-0005",

  // --- Inference ----------------------------------------------------------
  INFER_AMBIGUOUS_HEADING: "MF-INFER-0001",
  INFER_HEADING_LEVEL_SKIP: "MF-INFER-0002",
  INFER_LIST_KIND_FROM_NUMBERING: "MF-INFER-0003",

  // --- Renderers ----------------------------------------------------------
  RENDER_STYLE_SYNTHESIZED: "MF-RENDER-0001",
  RENDER_STYLE_MISSING: "MF-RENDER-0002",
  RENDER_DEPTH_CLAMPED: "MF-RENDER-0003",
  RENDER_CONSTRUCT_DROPPED: "MF-RENDER-0004",
  RENDER_TIFF_UNSUPPORTED: "MF-RENDER-0005",

  // --- IR -----------------------------------------------------------------
  IR_SCHEMA_INVALID: "MF-IR-0001",
  IR_PROVENANCE_MISSING: "MF-IR-0002",
} as const;

export type DiagnosticCodeValue = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

/**
 * Collects diagnostics during a pipeline stage.
 *
 * Every diagnostic records its producer, so "which component decided this was
 * lossy?" is answerable from the document alone.
 */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  constructor(private readonly producedBy: Producer) {}

  add(d: Omit<Diagnostic, "producedBy"> & { producedBy?: Producer }): void {
    this.items.push({ producedBy: this.producedBy, ...d } as Diagnostic);
  }

  /** A construct that could not be represented at all. */
  lost(
    code: DiagnosticCodeValue,
    construct: string,
    message: string,
    extra: Partial<Diagnostic> = {},
  ): void {
    this.add({ code, severity: "warning", lossy: true, construct, message, ...extra });
  }

  /** A construct that survived with reduced fidelity. Still lossy: something changed. */
  degraded(
    code: DiagnosticCodeValue,
    construct: string,
    message: string,
    extra: Partial<Diagnostic> = {},
  ): void {
    this.add({ code, severity: "warning", lossy: true, construct, message, ...extra });
  }

  info(code: DiagnosticCodeValue, message: string, extra: Partial<Diagnostic> = {}): void {
    this.add({ code, severity: "info", lossy: false, message, ...extra });
  }

  error(code: DiagnosticCodeValue, message: string, extra: Partial<Diagnostic> = {}): void {
    this.add({ code, severity: "error", lossy: true, message, ...extra });
  }

  /**
   * Sorted for determinism. Emission order depends on traversal, which is stable,
   * but merging bags from several adapters is not — so the order is pinned here
   * rather than left to whoever concatenated last.
   */
  all(): Diagnostic[] {
    return [...this.items].sort(
      (a, b) =>
        a.code.localeCompare(b.code) ||
        (a.nodeId ?? "").localeCompare(b.nodeId ?? "") ||
        a.message.localeCompare(b.message),
    );
  }

  /** Diagnostics reporting real information loss. Drives `--strict` (exit code 2). */
  lossy(): Diagnostic[] {
    return this.all().filter((d) => d.lossy);
  }

  get size(): number {
    return this.items.length;
  }

  merge(other: DiagnosticBag): void {
    for (const d of other.items) this.items.push(d);
  }
}

export const CODE_PATTERN = /^MF-[A-Z]+-\d{4}$/;
