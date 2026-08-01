/**
 * Conflict detection and reporting — SPEC §10.4.
 *
 * The rule the whole stage exists to obey: **conflicts are surfaced with both sources,
 * never silently resolved** (SPEC §10). Authority orders the report. It does not decide
 * it, and there is no code path here that drops a side.
 *
 * Detection is structural: one entity, two incompatible values. That covers the shapes the
 * corpus authored — one environment variable with two values, one build task with two
 * commands — and covers them without a model, which matters because `--no-llm` is the
 * default and a conflict nobody was told about is worse than one reported twice.
 *
 * **The false positive is a first-class failure here.** `fixtures/agentify/conflicting/`
 * ships a third document and a `nonConflicts` list precisely so that over-reporting is as
 * visible as under-reporting: `NIMBUS_QUEUE_URL` is declared identically by both runbooks,
 * and a detector that flags it is broken in a way that a recall-only test would call a pass.
 */
import { DiagnosticCode, type DiagnosticBag } from "@markforge/ir";
import type { ContextUnit, UnitCategory } from "./units.js";

export interface ConflictSide {
  unitId: string;
  value: string;
  text: string;
  path: string;
  authority: number;
}

export interface Conflict {
  entity: string;
  category: UnitCategory;
  /** Highest authority first. Ordering is a convenience; both sides always appear. */
  sides: ConflictSide[];
}

export interface ConflictReport {
  conflicts: Conflict[];
  /** Entities checked and found consistent, so the report shows what it ruled out. */
  agreements: { entity: string; category: UnitCategory; value: string; sources: string[] }[];
}

/**
 * Groups units by `(category, entityKey)` and reports groups holding more than one value.
 *
 * Only units that carry an `entityKey` participate. That is a deliberate limit rather than
 * an oversight: "same entity, incompatible predicate" needs an entity, and inferring one
 * from free prose is the LLM half of §10.4 that this corpus gives no way to measure. What
 * the rules cannot see is stated in docs/AGENTIFY.md rather than left to be discovered.
 */
export function detectConflicts(units: ContextUnit[], diagnostics: DiagnosticBag): ConflictReport {
  const groups = new Map<string, ContextUnit[]>();
  for (const unit of units) {
    if (unit.entityKey === undefined || unit.entityValue === undefined) continue;
    const key = `${unit.category}\u0000${unit.entityKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(unit);
    else groups.set(key, [unit]);
  }

  const conflicts: Conflict[] = [];
  const agreements: ConflictReport["agreements"] = [];

  for (const [key, bucket] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [category, entity] = key.split("\u0000") as [UnitCategory, string];
    const values = new Set(bucket.map((u) => u.entityValue!));

    // A conflict is between *documents*: contradictory units across two of them.
    // Several values for one entity inside a single document are a sequence,
    // not a disagreement, and the first run of this detector proved the distinction has to
    // be enforced rather than assumed: the clean corpus's three deploy commands, all under
    // one `## Deploy` heading in one runbook, were reported as three incompatible answers
    // to one question. That is exactly the false positive `expected-units.json` keeps a
    // `nonConflicts` list to catch, and it surfaced on the set that has no conflicts in it.
    const distinctSources = new Set(bucket.flatMap((u) => u.sources.map((s) => s.path)));
    if (values.size > 1 && distinctSources.size < 2) {
      agreements.push({
        entity,
        category,
        value: `${values.size} values within one document — a sequence, not a conflict`,
        sources: [...distinctSources].sort(),
      });
      continue;
    }

    if (values.size <= 1) {
      // Recorded, not skipped. "We looked at NIMBUS_QUEUE_URL and both documents agree" is
      // information; silence would leave a reader unable to tell it from "we never looked".
      agreements.push({
        entity,
        category,
        value: bucket[0]!.entityValue!,
        sources: [...new Set(bucket.flatMap((u) => u.sources.map((s) => s.path)))].sort(),
      });
      continue;
    }

    const sides: ConflictSide[] = bucket
      .map((u) => ({
        unitId: u.id,
        value: u.entityValue!,
        text: u.text,
        path: u.sources[0]!.path,
        authority: u.authority,
      }))
      .sort((a, b) => b.authority - a.authority || a.path.localeCompare(b.path));

    conflicts.push({ entity, category, sides });

    for (const unit of bucket) {
      unit.conflictsWith = bucket.filter((u) => u.id !== unit.id).map((u) => u.id).sort();
    }

    diagnostics.add({
      code: DiagnosticCode.AGENTIFY_CONFLICT,
      severity: "warning",
      // Not lossy: nothing was lost. Both values reach the report and both units survive
      // into the output. `lossy` drives --strict's exit 2, and a reported conflict is the
      // stage working rather than failing.
      lossy: false,
      message:
        `agentify: ${category} "${entity}" has ${values.size} incompatible values — ` +
        sides.map((s) => `${s.value} (${s.path})`).join(" vs ") +
        `. Both are reported and neither was chosen; ordering prefers the ` +
        `higher-authority source. Set agentify.conflicts to "failOnConflict" to make this ` +
        `a build failure.`,
    });
  }

  return { conflicts, agreements };
}

/** The human-readable section of the run report (SPEC §10.4). */
export function renderConflictReport(report: ConflictReport): string {
  if (report.conflicts.length === 0) {
    return report.agreements.length === 0
      ? "No entities carried a comparable value, so no conflict check ran.\n"
      : `No conflicts. ${report.agreements.length} entit${report.agreements.length === 1 ? "y" : "ies"} ` +
          `checked and consistent: ${report.agreements.map((a) => a.entity).join(", ")}.\n`;
  }
  const lines: string[] = [
    `${report.conflicts.length} conflict(s). Nothing was resolved automatically — each entry `,
    `shows every source so a human can decide.\n`,
  ];
  for (const conflict of report.conflicts) {
    lines.push(`\n${conflict.entity}  (${conflict.category})\n`);
    for (const side of conflict.sides) {
      lines.push(`  ${side.value}\n      ${side.path}  (authority ${side.authority.toFixed(2)})\n`);
    }
  }
  if (report.agreements.length > 0) {
    lines.push(`\nChecked and consistent: ${report.agreements.map((a) => a.entity).join(", ")}.\n`);
  }
  return lines.join("");
}
