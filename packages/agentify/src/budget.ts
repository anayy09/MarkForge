/**
 * Ranking and budget partition — SPEC §10.5.
 *
 * "Units are ranked by `value = f(category weight, authority, confidence, reference count)`
 * with weights from the target profile. Highest-value units fill the primary file; the
 * remainder go to linked secondary files — progressive disclosure."
 *
 * Two properties this stage must not violate:
 *
 *   - **Overflow is not loss.** A unit pushed to a secondary file is still emitted, still
 *     traceable, still in the provenance manifest. Only `truncateLowestValue` actually
 *     drops a unit, and it says so with a lossy diagnostic, because SPEC §1.3 does not
 *     stop applying because the thing being lost is a sentence rather than a table.
 *   - **A category the target routes nowhere is a loss and must be reported.** A profile
 *     whose sections omit `dependency` silently discards every dependency unit otherwise.
 *     That is the exact shape of the defect the node-type census found one layer up.
 */
import { DiagnosticCode, type DiagnosticBag } from "@markforge/ir";
import { compareUnits, type ContextUnit } from "./units.js";
import { countTokens, sectionForCategory, type TargetProfile, type TargetSection } from "./targets.js";

export interface RankedUnit {
  unit: ContextUnit;
  value: number;
  section: TargetSection;
  sectionIndex: number;
  tokens: number;
}

export interface BudgetPlan {
  primary: RankedUnit[];
  secondary: RankedUnit[];
  dropped: RankedUnit[];
  unrouted: ContextUnit[];
  primaryTokens: number;
  secondaryTokens: number;
}

/**
 * `value = categoryWeight × (0.4 + 0.3·authority + 0.2·confidence + 0.1·references)`.
 *
 * The constant 0.4 floor matters: without it a unit from an undated source with modest
 * confidence would rank at nearly zero and be indistinguishable from noise, so a target
 * with a tight budget would keep only units from documents that happened to carry a review
 * date. The floor makes category weight the dominant term, which is what a target profile
 * is actually expressing when it sets one.
 */
export function valueOf(unit: ContextUnit, section: TargetSection): number {
  const references = Math.min(1, Math.max(0, unit.sources.length - 1) / 2);
  return (
    (section.categoryWeight ?? 1) *
    (0.4 + 0.3 * unit.authority + 0.2 * unit.confidence + 0.1 * references)
  );
}

export function planBudget(
  units: ContextUnit[],
  profile: TargetProfile,
  diagnostics: DiagnosticBag,
  overrides: { primaryTokens?: number } = {},
): BudgetPlan {
  const sections = profile.sections ?? [];
  const sectionIndexOf = new Map(sections.map((s, i) => [s.id, i] as const));

  const ranked: RankedUnit[] = [];
  const unrouted: ContextUnit[] = [];

  for (const unit of units) {
    const section = sectionForCategory(profile, unit.category);
    if (!section) {
      unrouted.push(unit);
      continue;
    }
    ranked.push({
      unit,
      value: valueOf(unit, section),
      section,
      sectionIndex: sectionIndexOf.get(section.id) ?? 0,
      tokens: countTokens(renderableLength(unit), profile),
    });
  }

  if (unrouted.length > 0) {
    const categories = [...new Set(unrouted.map((u) => u.category))].sort();
    diagnostics.lost(
      DiagnosticCode.AGENTIFY_UNIT_UNROUTED,
      categories.join(", "),
      `agentify: target "${profile.id}" has no section accepting ${categories.join(", ")}, so ` +
        `${unrouted.length} unit(s) reach no output file. Add a section carrying ` +
        `${categories.length === 1 ? "that category" : "those categories"} to the profile, or ` +
        `accept the loss knowingly — it is reported here rather than left to be noticed.`,
    );
  }

  // Value decides *what* is kept; the unit order decides *where* it goes once kept. Sorting
  // by value and then re-sorting the two partitions is deliberate: ranking by value inside a
  // file would make the output order depend on a floating-point score, so a confidence
  // nudge anywhere would reshuffle a file and destroy §10.8's diff stability.
  const byValue = [...ranked].sort(
    (a, b) => b.value - a.value || compareUnitsIn(profile)(a.unit, b.unit),
  );

  const primaryLimit = overrides.primaryTokens ?? profile.budget.primaryTokens;
  const overflow = profile.budget.overflow ?? "linkToSecondary";
  const secondaryLimit = profile.budget.secondaryTokens ?? 0;

  const primary: RankedUnit[] = [];
  const secondary: RankedUnit[] = [];
  const dropped: RankedUnit[] = [];

  let primarySpend = 0;
  let secondarySpend = 0;
  const perSectionCount = new Map<string, number>();

  for (const item of byValue) {
    const used = perSectionCount.get(item.section.id) ?? 0;
    const capped = item.section.maxUnits !== undefined && used >= item.section.maxUnits;

    if (!capped && primarySpend + item.tokens <= primaryLimit) {
      primary.push(item);
      primarySpend += item.tokens;
      perSectionCount.set(item.section.id, used + 1);
      continue;
    }
    if (overflow === "fail") {
      throw new Error(
        `agentify: target "${profile.id}" sets budget.overflow "fail" and its primary budget ` +
          `of ${primaryLimit} tokens is exhausted at ${primarySpend}. ${byValue.length - primary.length} ` +
          `unit(s) do not fit. Raise budget.primaryTokens, or set overflow to "linkToSecondary".`,
      );
    }
    if (overflow === "truncateLowestValue" || secondaryLimit === 0) {
      dropped.push(item);
      continue;
    }
    if (secondarySpend + item.tokens <= secondaryLimit) {
      secondary.push(item);
      secondarySpend += item.tokens;
    } else {
      dropped.push(item);
    }
  }

  if (dropped.length > 0) {
    diagnostics.lost(
      DiagnosticCode.AGENTIFY_UNIT_DROPPED,
      "contextUnit",
      `agentify: ${dropped.length} unit(s) fit neither the primary budget (${primaryLimit} tokens) ` +
        `nor the secondary budget (${secondaryLimit} tokens) for target "${profile.id}" and were ` +
        `dropped, lowest value first. They are listed under --explain-drops. This is real loss: ` +
        `raise a budget or narrow the source set.`,
    );
  }
  if (secondary.length > 0) {
    diagnostics.info(
      DiagnosticCode.AGENTIFY_UNIT_OVERFLOWED,
      `agentify: ${secondary.length} unit(s) exceeded the primary budget for "${profile.id}" and ` +
        `moved to linked secondary file(s) — progressive disclosure, not loss (SPEC §10.5).`,
    );
  }

  const order = compareUnitsIn(profile);
  primary.sort((a, b) => order(a.unit, b.unit));
  secondary.sort((a, b) => order(a.unit, b.unit));
  dropped.sort((a, b) => b.value - a.value || order(a.unit, b.unit));

  return {
    primary,
    secondary,
    dropped,
    unrouted,
    primaryTokens: primarySpend,
    secondaryTokens: secondarySpend,
  };
}

/** §10.8's total order, bound to one profile's section layout. */
export function compareUnitsIn(profile: TargetProfile): (a: ContextUnit, b: ContextUnit) => number {
  const sections = profile.sections ?? [];
  const sectionIndex = new Map<string, number>();
  const categoryIndex = new Map<string, number>();
  sections.forEach((section, i) => {
    sectionIndex.set(section.id, i);
    section.categories.forEach((category, j) => {
      if (!categoryIndex.has(category)) categoryIndex.set(category, j);
    });
  });
  const sectionOf = (unit: ContextUnit): number => {
    const section = sectionForCategory(profile, unit.category);
    return section ? (sectionIndex.get(section.id) ?? 0) : sections.length;
  };
  const categoryOf = (unit: ContextUnit): number => categoryIndex.get(unit.category) ?? 0;
  return (a, b) => compareUnits(a, b, sectionOf, categoryOf);
}

/** What a unit costs, counted over the text that will actually be written. */
function renderableLength(unit: ContextUnit): string {
  return unit.rationale ? `${unit.text} ${unit.rationale}` : unit.text;
}
