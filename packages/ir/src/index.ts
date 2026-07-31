/**
 * @markforge/ir — the intermediate representation.
 *
 * Everything in MarkForge is a function to or from this type. Adapters produce it,
 * renderers consume it, inference refines it, and fidelity compares two of them.
 * Keeping the IR in its own package with no dependencies on any adapter is what
 * makes that a real boundary rather than a diagram.
 *
 * See docs/SPEC.md §2 and ADR-0001, ADR-0002, ADR-0014.
 */

export {
  canonicalJson,
  canonicalBytes,
  canonicalJsonPretty,
} from "./canonical-json.js";

export {
  assignIds,
  reassignIds,
  localDigest,
  parseNodeId,
  base32lower,
  sha256Hex,
  contentHashOfBytes,
  NODE_ID_PATTERN,
} from "./node-id.js";

export { salientAttrsFor, knownNodeTypes } from "./salient.js";

export {
  visit,
  flatten,
  selectType,
  find,
  indexById,
  countNodes,
  transformChildren,
  textContent,
  SKIP,
  STOP,
} from "./traverse.js";
export type { AnyNode, VisitContext, Visitor } from "./traverse.js";

export {
  DiagnosticBag,
  DiagnosticCode,
  CODE_PATTERN,
} from "./diagnostics.js";
export type {
  Diagnostic,
  Severity,
  DiagnosticCodeValue,
} from "./diagnostics.js";

export {
  IR_VERSION,
  emptyDocument,
  checkProvenanceComplete,
  checkUnknownNodesDiagnosed,
  auditDocument,
} from "./document.js";
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
} from "./document.js";

export { normalize, DEFAULT_NORMALIZE_OPTIONS } from "./normalize.js";
export { styleEvidence } from "./document.js";
export type { NormalizeOptions, NormalizeResult } from "./normalize.js";

export { validateDocument, assertValidDocument } from "./validate.js";
export type { ValidationResult } from "./validate.js";

// Generated node types. Re-exported so consumers get one import path, and named
// with the schema's own vocabulary so SPEC.md §2.3 matches the code.
export type * from "./generated/ir.js";
