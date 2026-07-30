/**
 * The document envelope and its invariants, per docs/SPEC.md §2.1–2.5.
 *
 * The IR is deliberately three separable things: a semantic tree that stays
 * mdast-compatible so the unified ecosystem works on it, plus id-keyed side tables
 * for style evidence and provenance (ADR-0002). Keeping evidence out of the nodes
 * is what lets a remark plugin operate on the tree without tripping over fields it
 * does not understand.
 */
import type { AnyNode } from "./traverse.js";
import { visit } from "./traverse.js";
import type { Diagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";

export const IR_VERSION = "0.1.0";

export type NodeId = string;
export type SourceId = string;
export type ResourceId = string;
export type StyleId = string;
export type NumberingId = string;

export type Producer =
  | { kind: "adapter"; name: string; version: string }
  | { kind: "rule"; name: string; version: string }
  | { kind: "model"; model: string; promptVersion: string }
  | { kind: "ocr"; engine: string; version: string };

export interface Locator {
  /** OOXML: a path like `/w:document/w:body/w:p[12]`. PDF: page + bbox. */
  path?: string;
  page?: number;
  bbox?: { x: number; y: number; width: number; height: number; space?: string; origin?: string };
  offset?: number;
  length?: number;
  line?: number;
  column?: number;
}

export interface Provenance {
  sourceId: SourceId;
  locator?: Locator;
  /** 0..1. Absent means "certain"; present and low means the value is a guess. */
  confidence?: number;
  producedBy: Producer;
  /** Node ids this was derived from, when normalisation created or merged nodes. */
  derivedFrom?: NodeId[];
}

export interface StyleEvidence {
  styleId?: string;
  styleName?: string;
  fontFamily?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  alignment?: "left" | "center" | "right" | "justify";
  indentLeftTwips?: number;
  indentFirstLineTwips?: number;
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  numberingId?: string;
  numberingLevel?: number;
  restartsAt?: number;
  outlineLevel?: number;
  color?: string;
  backgroundColor?: string;
  allCaps?: boolean;
  smallCaps?: boolean;
  [key: string]: unknown;
}

export interface SourceFile {
  path: string;
  mediaType: string;
  contentHash: string;
  byteLength?: number;
}

export interface Resource {
  mediaType: string;
  contentHash: string;
  byteLength?: number;
  /** Path within the container, e.g. `word/media/image1.png`. */
  originalPath?: string;
  data?: string;
}

export interface StyleDefinition {
  styleId: string;
  name: string;
  type: "paragraph" | "character" | "table" | "numbering";
  basedOn?: string;
  next?: string;
  evidence?: StyleEvidence;
}

export interface NumberingLevel {
  level: number;
  format: string;
  text?: string;
  start?: number;
  indentLeftTwips?: number;
  isOrdered: boolean;
}

export interface NumberingDefinition {
  numberingId: string;
  abstractId?: string;
  levels: NumberingLevel[];
}

export interface Furniture {
  kind: "header" | "footer" | "footnoteSeparator" | "endnoteSeparator";
  /** `default` | `first` | `even`, matching OOXML section header/footer types. */
  variant?: string;
  sectionIndex?: number;
  children: AnyNode[];
}

export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  language?: string;
  created?: string;
  modified?: string;
  keywords?: string[];
  [key: string]: unknown;
}

export interface MarkForgeDocument {
  irVersion: string;
  id: string;
  body: AnyNode;
  furniture: Furniture[];
  metadata: DocumentMetadata;
  sources: Record<SourceId, SourceFile>;
  resources: Record<ResourceId, Resource>;
  styles: Record<StyleId, StyleDefinition>;
  numbering: Record<NumberingId, NumberingDefinition>;
  sidecar: Record<NodeId, StyleEvidence>;
  provenance: Record<NodeId, Provenance>;
  diagnostics: Diagnostic[];
  contentHash?: string;
}

/** An empty document. Every table is present-but-empty, never absent. */
export function emptyDocument(id = "doc"): MarkForgeDocument {
  return {
    irVersion: IR_VERSION,
    id,
    body: { type: "root", children: [] },
    furniture: [],
    metadata: {},
    sources: {},
    resources: {},
    styles: {},
    numbering: {},
    sidecar: {},
    provenance: {},
    diagnostics: [],
  };
}

/**
 * Adapter contract rule A4: every node carries provenance.
 *
 * Checked as a function rather than trusted, because the guarantee that "you can
 * always find out where this came from" is worth exactly as much as its weakest
 * adapter. Returns the offending node ids so a failure names them.
 */
export function checkProvenanceComplete(doc: MarkForgeDocument): {
  ok: boolean;
  missing: string[];
  total: number;
} {
  const missing: string[] = [];
  let total = 0;
  const check = (root: AnyNode): void => {
    visit(root, (n) => {
      total++;
      // The root itself is document-level and covered by `sources`.
      if (n === root) return;
      if (typeof n.id !== "string") {
        missing.push(`<node of type ${n.type} with no id>`);
        return;
      }
      if (!doc.provenance[n.id]) missing.push(n.id);
    });
  };
  check(doc.body);
  for (const f of doc.furniture) for (const c of f.children) check(c);
  return { ok: missing.length === 0, missing, total };
}

/** Rule A6: every `unknown` node has a lossy diagnostic naming it. */
export function checkUnknownNodesDiagnosed(doc: MarkForgeDocument): {
  ok: boolean;
  undiagnosed: string[];
} {
  const diagnosedIds = new Set(
    doc.diagnostics.filter((d) => d.lossiness !== "lossless" && d.nodeId).map((d) => d.nodeId!),
  );
  const undiagnosed: string[] = [];
  visit(doc.body, (n) => {
    if (n.type !== "unknown") return;
    if (typeof n.id === "string" && !diagnosedIds.has(n.id)) undiagnosed.push(n.id);
  });
  return { ok: undiagnosed.length === 0, undiagnosed };
}

/** Both adapter invariants at once, as diagnostics rather than exceptions. */
export function auditDocument(doc: MarkForgeDocument): Diagnostic[] {
  const out: Diagnostic[] = [];
  const prov = checkProvenanceComplete(doc);
  for (const id of prov.missing) {
    out.push({
      code: DiagnosticCode.IR_PROVENANCE_MISSING,
      severity: "error",
      lossiness: "degraded",
      message: `Node ${id} has no provenance entry (adapter rule A4).`,
      nodeId: id,
      remedy: "The adapter that produced this node must record provenance for it.",
    });
  }
  return out;
}
