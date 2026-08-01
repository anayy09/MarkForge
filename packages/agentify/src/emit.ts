/**
 * The provenance manifest — SPEC §10.7.
 *
 * "`.markforge/provenance.json` maps every output file → section → sentence range → unit
 * ids → source locators. That chain is what makes Surface A trustworthy rather than a
 * hallucination machine (brief §3.7)."
 *
 * The manifest is committed, so it obeys the same rule as the LLM cache: **no wall clock
 * anywhere**. A timestamp would produce a diff on every run and nobody would commit it,
 * and an uncommitted provenance manifest cannot be reviewed — which is the only thing it
 * is for. Source identity is by content hash instead, which is both stable and more useful:
 * it is what §10.8's incremental regeneration compares.
 */
import { canonicalJsonPretty, sha256Hex } from "@markforge/ir";
import type { EmittedFile } from "./assemble.js";
import type { ContextUnit } from "./units.js";
import type { Conflict } from "./conflicts.js";

export interface ProvenanceSentence {
  /** Character range in the emitted file, half-open. */
  start: number;
  end: number;
  text: string;
  unitIds: string[];
}

export interface ProvenanceSection {
  id: string;
  heading: string;
  sentences: ProvenanceSentence[];
}

export interface ProvenanceFile {
  path: string;
  target: string;
  role: string;
  contentHash: string;
  tokens: number;
  sections: ProvenanceSection[];
}

export interface ProvenanceManifest {
  version: 0;
  /** Every source that contributed, by content hash — the incremental-regeneration key. */
  sources: { path: string; contentHash: string; role: string; units: number }[];
  units: {
    id: string;
    category: string;
    contentHash: string;
    text: string;
    rationale?: string;
    sources: { path: string; nodeIds: string[]; locator: unknown }[];
    conflictsWith?: string[];
  }[];
  files: ProvenanceFile[];
  conflicts: Conflict[];
}

export function buildManifest(input: {
  files: { file: EmittedFile; target: string }[];
  units: ContextUnit[];
  sources: { path: string; contentHash: string; role: string }[];
  conflicts: Conflict[];
}): ProvenanceManifest {
  const unitsById = new Map(input.units.map((u) => [u.id, u]));
  const unitCountBySource = new Map<string, number>();
  for (const unit of input.units) {
    for (const source of unit.sources) {
      unitCountBySource.set(source.path, (unitCountBySource.get(source.path) ?? 0) + 1);
    }
  }

  return {
    version: 0,
    sources: [...input.sources]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((s) => ({
        path: s.path,
        contentHash: s.contentHash,
        role: s.role,
        units: unitCountBySource.get(s.path) ?? 0,
      })),
    units: [...input.units]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((u) => ({
        id: u.id,
        category: u.category,
        contentHash: u.contentHash,
        text: u.text,
        ...(u.rationale !== undefined ? { rationale: u.rationale } : {}),
        sources: u.sources.map((s) => ({
          path: s.path,
          nodeIds: s.nodeIds,
          locator: s.locator,
        })),
        ...(u.conflictsWith !== undefined ? { conflictsWith: u.conflictsWith } : {}),
      })),
    files: input.files
      .map(({ file, target }) => ({
        path: file.path,
        target,
        role: file.role,
        contentHash: sha256Hex(file.content),
        tokens: file.tokens,
        sections: sectionsOf(file, unitsById),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    conflicts: input.conflicts,
  };
}

/**
 * Sentence ranges per section, recovered from the emitted content and the fragment spans.
 *
 * Derived from the same two things the gate uses, so a manifest cannot claim a chain the
 * gate did not check.
 */
function sectionsOf(file: EmittedFile, unitsById: Map<string, ContextUnit>): ProvenanceSection[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const bySection = new Map<string, ProvenanceSentence[]>();

  for (const s of segmenter.segment(file.content)) {
    if (s.segment.trim() === "") continue;
    const from = s.index;
    const to = s.index + s.segment.length;
    const covering = file.fragments.filter(
      (f) => f.scaffold === undefined && f.start < to && f.end > from,
    );
    if (covering.length === 0) continue;
    const unitIds = [...new Set(covering.flatMap((f) => f.unitIds))]
      .filter((id) => unitsById.has(id))
      .sort();
    if (unitIds.length === 0) continue;
    const sectionId = covering[0]!.sectionId;
    const bucket = bySection.get(sectionId);
    const entry: ProvenanceSentence = { start: from, end: to, text: s.segment.trim(), unitIds };
    if (bucket) bucket.push(entry);
    else bySection.set(sectionId, [entry]);
  }

  return file.sections
    .filter((section) => bySection.has(section.id))
    .map((section) => ({
      id: section.id,
      heading: section.heading,
      sentences: bySection.get(section.id) ?? [],
    }));
}

export function serializeManifest(manifest: ProvenanceManifest): string {
  return canonicalJsonPretty(manifest) + "\n";
}
