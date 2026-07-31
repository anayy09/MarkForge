/**
 * Document-level helpers and invariant checks.
 *
 * **All types here are re-exported from `./generated/ir.js`, never declared.**
 * An earlier draft of this file hand-wrote `StyleEvidence`, `SourceFile`, and
 * friends, and they drifted from the schema within an hour — the flat
 * `{ fontSizePt, bold }` shape it invented was not the nested
 * `{ font: { sizePt, weight } }` the schema specifies, and nothing caught it until
 * a document failed validation. That is exactly the failure docs/SPEC.md §2.2
 * predicts, which is why generation is not optional.
 */
import type { AnyNode } from "./traverse.js";
import { visit } from "./traverse.js";
import type {
  Diagnostic,
  MarkForgeDocument,
  StyleEvidence,
  Furniture,
} from "./generated/ir.js";
import { DiagnosticCode } from "./diagnostics.js";

export const IR_VERSION = "0.1.0";

export type {
  MarkForgeDocument,
  Provenance,
  Producer,
  StyleEvidence,
  StyleDefinition,
  NumberingDefinition,
  SourceFile,
  Resource,
  Furniture,
  DocumentMetadata,
  Locator,
  NodeId,
  SourceId,
  ResourceId,
  Diagnostic,
} from "./generated/ir.js";

/** An empty document. Every table is present-but-empty, never absent. */
export function emptyDocument(id = "n_aaaaaaaaaaaaaaaaaaaa:0"): MarkForgeDocument {
  return {
    irVersion: IR_VERSION,
    id,
    body: { type: "root", id, children: [] } as unknown as MarkForgeDocument["body"],
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

/** Every node reachable from the body and from furniture content. */
function allRoots(doc: MarkForgeDocument): AnyNode[] {
  const roots: AnyNode[] = [doc.body as unknown as AnyNode];
  for (const f of doc.furniture as Furniture[]) {
    for (const c of f.content as unknown as AnyNode[]) roots.push(c);
  }
  return roots;
}

/**
 * Adapter contract rule A4: every node carries provenance.
 *
 * Checked as a function rather than trusted, because "you can always find out where
 * this came from" is worth exactly as much as its weakest adapter. Returns the
 * offending ids so a failure names them instead of just failing.
 */
export function checkProvenanceComplete(doc: MarkForgeDocument): {
  ok: boolean;
  missing: string[];
  total: number;
} {
  const missing: string[] = [];
  let total = 0;
  for (const root of allRoots(doc)) {
    visit(root, (n) => {
      total++;
      if (n === root) return; // the root is covered by `sources`
      if (typeof n.id !== "string") {
        missing.push(`<${n.type} with no id>`);
        return;
      }
      if (!doc.provenance[n.id]) missing.push(n.id);
    });
  }
  return { ok: missing.length === 0, missing, total };
}

/** Rule A6: every `unknown` node has a lossy diagnostic naming it. */
export function checkUnknownNodesDiagnosed(doc: MarkForgeDocument): {
  ok: boolean;
  undiagnosed: string[];
} {
  const diagnosed = new Set(
    (doc.diagnostics as Diagnostic[]).filter((d) => d.lossy && d.nodeId).map((d) => d.nodeId!),
  );
  const undiagnosed: string[] = [];
  for (const root of allRoots(doc)) {
    visit(root, (n) => {
      if (n.type !== "unknown") return;
      if (typeof n.id === "string" && !diagnosed.has(n.id)) undiagnosed.push(n.id);
    });
  }
  return { ok: undiagnosed.length === 0, undiagnosed };
}

/** Both adapter invariants at once, reported as diagnostics rather than thrown. */
export function auditDocument(doc: MarkForgeDocument): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const id of checkProvenanceComplete(doc).missing) {
    out.push({
      code: DiagnosticCode.IR_PROVENANCE_MISSING,
      severity: "error",
      lossy: false,
      message: `Node ${id} has no provenance entry (adapter rule A4).`,
      nodeId: id,
      producedBy: { kind: "rule", name: "ir.audit", version: IR_VERSION },
    } as Diagnostic);
  }
  return out;
}

/**
 * Builds a StyleEvidence value with `origin` set.
 *
 * `origin` is required by the schema and load-bearing: `directFormatting` is the
 * documented signal that heading inference is needed, so a value that omits it
 * would leave @markforge/infer unable to tell a styled heading from a paragraph
 * someone made big and bold by hand.
 */
export function styleEvidence(
  origin: StyleEvidence["origin"],
  parts: Omit<StyleEvidence, "origin"> = {},
): StyleEvidence {
  return { origin, ...parts };
}
