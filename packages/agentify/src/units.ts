/**
 * The context unit — SPEC §10.3's shape, and the ordering rule everything downstream
 * depends on.
 *
 * A unit is one fact. That is not a style preference: §10.5 budgets by dropping units,
 * and dropping half a sentence corrupts its neighbour, so atomicity is what makes
 * budgeting safe rather than destructive.
 *
 * **On ordering, and why `id` is not the last word.** SPEC §10.8 specifies the total
 * order `(sectionOrder, categoryOrder, id)` and justifies it as "independent of discovery
 * order", which it is. It is also, on its own, not diff-stable — and diff stability is the
 * property §10.8 exists to deliver. `id` is content-addressed (§10.3 → §2.7), so editing a
 * unit's text changes its id, which moves it within its group: the regenerated file shows a
 * deletion where it used to sort and an insertion where it now sorts. Two hunks for a
 * one-word edit. `sourceOrder` is therefore inserted ahead of `id`, pinning a unit to where
 * its evidence appears in the source document, which an edit does not move. `id` remains the
 * final tiebreak, so the order is still total and still independent of discovery. Measured
 * rather than argued: see docs/AGENTIFY.md, and ADR-0018 for the amendment.
 */
import { canonicalJson, sha256Hex, type Locator, type NodeId, type Producer, type SourceId } from "@markforge/ir";

/** SPEC §10.2's closed role set. `unknown` is a real answer, not a failure. */
export const DOCUMENT_ROLES = [
  "productSpec",
  "architecture",
  "codingConventions",
  "domainGlossary",
  "apiContract",
  "runbook",
  "testPolicy",
  "decisionRecord",
  "meetingNotes",
  "unknown",
] as const;
export type DocumentRole = (typeof DOCUMENT_ROLES)[number];

/** SPEC §10.3's closed category set. Mirrored by the target schema's section enum. */
export const UNIT_CATEGORIES = [
  "constraint",
  "invariant",
  "convention",
  "command",
  "entity",
  "glossaryTerm",
  "decision",
  "antiPattern",
  "dependency",
  "environmentVariable",
] as const;
export type UnitCategory = (typeof UNIT_CATEGORIES)[number];

export interface UnitSource {
  sourceId: SourceId;
  nodeIds: NodeId[];
  locator: Locator;
  /**
   * Position of the unit's first supporting node in its source document, in document
   * order. The diff-stability key described in this module's header.
   */
  order: number;
  /** Repo-relative path, carried so a conflict report can name a file a human knows. */
  path: string;
}

export interface ContextUnit {
  id: string;
  category: UnitCategory;
  /** Atomic, self-contained, imperative where applicable. */
  text: string;
  /** Required when `category === "decision"` (SPEC §10), enforced by `makeUnit`. */
  rationale?: string;
  sources: UnitSource[];
  documentRole: DocumentRole;
  /** 0..1, from source recency and declared authority. */
  authority: number;
  /** 0..1. */
  confidence: number;
  contentHash: string;
  supersedes?: string[];
  conflictsWith?: string[];
  producedBy: Producer;
  /**
   * The entity this unit is *about*, when it has one: an environment variable's name, a
   * command's task. Conflict detection is "same entity, incompatible predicate" (§10.4),
   * so the entity has to be a field rather than something re-derived from the text by two
   * separate code paths that could disagree.
   */
  entityKey?: string;
  /** The value bound to `entityKey`, for the same reason. */
  entityValue?: string;
}

/**
 * Content hash over the semantic fields only.
 *
 * Deliberately excludes `sources`, `authority`, and `confidence`. Two documents stating the
 * same constraint must produce the same hash or §10.8's change detection would report an
 * edit every time a unit gained a second source — and gaining a source is exactly what
 * deduplication does. What the hash answers is "is this the same fact", not "did anything
 * about this row change".
 */
export function unitContentHash(parts: {
  category: UnitCategory;
  text: string;
  rationale?: string;
}): string {
  return sha256Hex(
    canonicalJson({
      category: parts.category,
      text: normalizeUnitText(parts.text),
      ...(parts.rationale !== undefined ? { rationale: normalizeUnitText(parts.rationale) } : {}),
    }),
  );
}

/**
 * The id: `u_` + 20 base32 characters of the content hash.
 *
 * The §2.7 node scheme with the prefix changed, and without the occurrence counter —
 * two identical facts are one unit by definition, so there is nothing to disambiguate.
 */
export function unitId(contentHash: string): string {
  return "u_" + base32lower(contentHash).slice(0, 20);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32lower(hex: string): string {
  let bits = "";
  for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/**
 * Comparison form for the cheap deduplication pass (§10.4).
 *
 * Case, surrounding whitespace, and trailing punctuation only. Nothing clever: this
 * function's job is to catch *exact restatement*, and every rule added here that is
 * cleverer than that widens what silently counts as "the same fact".
 */
export function normalizeUnitText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.;:,]+$/u, "")
    .trim();
}

export interface MakeUnitInput {
  category: UnitCategory;
  text: string;
  rationale?: string;
  source: UnitSource;
  documentRole: DocumentRole;
  authority: number;
  confidence: number;
  producedBy: Producer;
  entityKey?: string;
  entityValue?: string;
}

export function makeUnit(input: MakeUnitInput): ContextUnit {
  const text = input.text.replace(/\s+/gu, " ").trim();
  if (text === "") throw new Error("agentify: a context unit cannot have empty text");
  // SPEC §10 names the rationale as part of what a decision unit *is*. Enforced here
  // rather than checked later, because a decision that reached an output file without one
  // has already cost the reader the only thing that made it a decision.
  if (input.category === "decision" && (input.rationale ?? "").trim() === "") {
    throw new Error(
      `agentify: a decision unit requires a rationale (SPEC §10) — "${text.slice(0, 60)}"`,
    );
  }
  const contentHash = unitContentHash({
    category: input.category,
    text,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  });
  return {
    id: unitId(contentHash),
    category: input.category,
    text,
    ...(input.rationale !== undefined ? { rationale: input.rationale.trim() } : {}),
    sources: [input.source],
    documentRole: input.documentRole,
    authority: input.authority,
    confidence: input.confidence,
    contentHash,
    producedBy: input.producedBy,
    ...(input.entityKey !== undefined ? { entityKey: input.entityKey } : {}),
    ...(input.entityValue !== undefined ? { entityValue: input.entityValue } : {}),
  };
}

/**
 * The earliest source position, which is what a merged unit sorts by.
 *
 * Merging is additive (§10.4), so a unit can carry sources from several documents. Sorting
 * by the earliest keeps a merged unit where its first statement was, rather than letting it
 * move when a *different* document is edited.
 */
export function sourceOrderOf(unit: ContextUnit): { path: string; order: number } {
  let best = unit.sources[0]!;
  for (const s of unit.sources) {
    if (s.path < best.path || (s.path === best.path && s.order < best.order)) best = s;
  }
  return { path: best.path, order: best.order };
}

/**
 * SPEC §10.8's total order, amended per this module's header (ADR-0018).
 *
 * `sectionOrder` and `categoryOrder` come from the target profile and are supplied by the
 * caller, because the same unit set is ordered differently for different targets.
 */
export function compareUnits(
  a: ContextUnit,
  b: ContextUnit,
  sectionOrder: (u: ContextUnit) => number,
  categoryOrder: (u: ContextUnit) => number,
): number {
  const sa = sectionOrder(a);
  const sb = sectionOrder(b);
  if (sa !== sb) return sa - sb;
  const ca = categoryOrder(a);
  const cb = categoryOrder(b);
  if (ca !== cb) return ca - cb;
  const oa = sourceOrderOf(a);
  const ob = sourceOrderOf(b);
  if (oa.path !== ob.path) return oa.path < ob.path ? -1 : 1;
  if (oa.order !== ob.order) return oa.order - ob.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
