/**
 * Diagnostics, per docs/SPEC.md §2.6.
 *
 * The load-bearing rule of the whole project (SPEC §1.3): anything an adapter
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
  MD_EMBEDDED_HTML_RECOVERED: "MF-MD-0013",

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
  RENDER_TABLE_SPANS_FLATTENED: "MF-RENDER-0006",
  RENDER_TABLE_AS_HTML: "MF-RENDER-0007",

  // --- PDF ----------------------------------------------------------------
  PDF_NO_TEXT_LAYER: "MF-PDF-0001",
  PDF_PAGE_IMAGE_UNAVAILABLE: "MF-PDF-0002",

  // --- OCR and vision transcription ---------------------------------------
  OCR_PAGE_TRANSCRIBED: "MF-OCR-0001",
  OCR_LOW_CONFIDENCE: "MF-OCR-0002",
  OCR_EMPTY_PAGE: "MF-OCR-0003",
  OCR_ENGINE_UNAVAILABLE: "MF-OCR-0004",

  // --- LLM layer ----------------------------------------------------------
  // The LLM is assistive, so its failures are never fatal: each of these records that
  // the deterministic result stands, which is what makes "did a model change this
  // document?" answerable from the diagnostics alone.
  LLM_CALL_FAILED: "MF-LLM-0001",
  LLM_TIEBREAK_APPLIED: "MF-LLM-0002",
  LLM_BUDGET_EXCEEDED: "MF-LLM-0003",
  LLM_DISABLED_AMBIGUITY_STANDS: "MF-LLM-0004",

  // --- Agent Context Compiler (SPEC §10) -----------------------------------
  // Surface A loses information in ways Surface B cannot: a unit can be merged into
  // another, ranked below a budget, or refused by the traceability gate. Each of those
  // is a decision about someone's document, so each says so. The two that are `lossy`
  // are the two where a fact present in a source reaches no output file.
  AGENTIFY_ROLE_UNCERTAIN: "MF-AGENT-0001",
  AGENTIFY_ROLE_LLM_DISAGREED: "MF-AGENT-0002",
  AGENTIFY_UNITS_MERGED: "MF-AGENT-0003",
  AGENTIFY_CONFLICT: "MF-AGENT-0004",
  AGENTIFY_UNIT_OVERFLOWED: "MF-AGENT-0005",
  AGENTIFY_UNIT_DROPPED: "MF-AGENT-0006",
  AGENTIFY_UNIT_UNROUTED: "MF-AGENT-0007",
  AGENTIFY_SENTENCE_UNSUPPORTED: "MF-AGENT-0008",
  AGENTIFY_TRACEABILITY_FAILED: "MF-AGENT-0009",
  AGENTIFY_TOKENIZER_UNAVAILABLE: "MF-AGENT-0010",
  AGENTIFY_SOURCE_UNCHANGED: "MF-AGENT-0011",

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

  /**
   * A capability the caller explicitly asked for did not happen, and nothing was lost.
   *
   * Distinct from `degraded()` above, which means a construct survived with reduced
   * fidelity and is therefore `lossy`. This one is for the case where the **output is
   * exactly right** — it is what the deterministic path would have produced — and the
   * defect is that a requested step was skipped: a model that could not be reached, an
   * optional recogniser that was absent.
   *
   * It exists because `--strict` keyed on `lossy` alone, so a degradation of this kind was
   * invisible to the one flag whose job is to fail on degradation. That is the failure
   * mode by construction: no exit code could ever reflect it, whatever the diagnostic said.
   */
  capabilityUnavailable(
    code: DiagnosticCodeValue,
    message: string,
    extra: Partial<Diagnostic> = {},
  ): void {
    this.add({ code, severity: "warning", lossy: false, degraded: true, message, ...extra });
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

  /** Diagnostics reporting real information loss. */
  lossy(): Diagnostic[] {
    return this.all().filter((d) => d.lossy);
  }

  /**
   * Everything `--strict` fails on: information lost, **or** a requested capability that
   * did not happen (exit code 2).
   *
   * Widened from `lossy` alone. `--strict` means "fail if anything did not go as it should
   * have", and keyed on loss it could not see a model that was asked for and never
   * reached — so that degradation was invisible to the flag whose purpose is to catch
   * degradation, no matter what the diagnostic said. One instance means the invariant was
   * never held, which is why this is a widening rather than a new flag.
   */
  strictFailing(): Diagnostic[] {
    return this.all().filter((d) => d.lossy || d.degraded === true);
  }

  get size(): number {
    return this.items.length;
  }

  merge(other: DiagnosticBag): void {
    for (const d of other.items) this.items.push(d);
  }
}

export const CODE_PATTERN = /^MF-[A-Z]+-\d{4}$/;
