/**
 * Assembly — SPEC §10.5 and §10.6's precondition.
 *
 * §10.6 opens with the sentence this module exists to make true: "Emitted files are
 * assembled **only** from unit-derived fragments, each carrying the unit ids it came from."
 * So nothing here writes a string directly into a file. Every byte goes through
 * `FileBuilder`, which requires each chunk to declare itself as either unit-derived (with
 * ids) or scaffolding (with a *kind*, from a closed set the verifier re-checks against the
 * target profile).
 *
 * **Why scaffolding carries a kind rather than a boolean.** §10.6 exempts structural
 * scaffolding from the gate and says it is "declared as such by the template, not
 * inferred". A boolean `scaffold: true` would satisfy the letter of that and destroy its
 * point: any hallucinated sentence could be waved through by marking it scaffolding, and
 * the mandatory gate with no bypass flag would have acquired one. A kind can be validated —
 * a `heading` fragment must equal a heading the profile declares, a `marker` must be one of
 * four literals — so scaffolding cannot be used to smuggle prose.
 *
 * Line wrapping is fixed and never reflowed (§10.8): one unit is one line, however long.
 * Wrapping would make a unit's rendering depend on its neighbours, and then inserting a
 * short unit would rewrap the paragraph after it and produce the multi-region diff §10.8
 * exists to prevent.
 */
import type { BudgetPlan, RankedUnit } from "./budget.js";
import type { TargetProfile, TargetSection } from "./targets.js";
import { countTokens } from "./targets.js";
import type { ContextUnit, DocumentRole } from "./units.js";

export type ScaffoldKind =
  | "heading"
  | "marker"
  | "fence"
  | "frontMatter"
  | "link"
  | "blank"
  | "manifestKey";

export interface Fragment {
  text: string;
  /** Empty exactly when `scaffold` is set. */
  unitIds: string[];
  scaffold?: ScaffoldKind;
  sectionId: string;
  start: number;
  end: number;
}

export interface EmittedSection {
  id: string;
  heading: string;
  units: number;
  tokens: number;
}

export interface EmittedFile {
  path: string;
  role: "primary" | "secondary" | "manifest" | "asset";
  content: string;
  fragments: Fragment[];
  tokens: number;
  sections: EmittedSection[];
  /** Set for partitioned kinds (skillPackage, commandSet, scopedRuleSet). */
  slug?: string;
}

/** The four literal list/definition markers scaffolding may use. Closed on purpose. */
export const MARKERS = ["- ", "  - ", "\n", ": "] as const;

class FileBuilder {
  private readonly chunks: Fragment[] = [];
  private offset = 0;

  constructor(
    readonly path: string,
    readonly role: EmittedFile["role"],
  ) {}

  private push(text: string, sectionId: string, unitIds: string[], scaffold?: ScaffoldKind): void {
    if (text === "") return;
    const fragment: Fragment = {
      text,
      unitIds,
      sectionId,
      start: this.offset,
      end: this.offset + text.length,
      ...(scaffold !== undefined ? { scaffold } : {}),
    };
    this.chunks.push(fragment);
    this.offset += text.length;
  }

  scaffold(text: string, kind: ScaffoldKind, sectionId = "-"): void {
    this.push(text, sectionId, [], kind);
  }

  /**
   * Writes unit-derived text.
   *
   * The text must come from the unit. It is not checked here — it is checked by the
   * verifier, against the emitted file, which is the only check that means anything.
   */
  unit(text: string, unit: ContextUnit, sectionId: string): void {
    this.push(text, sectionId, [unit.id]);
  }

  build(sections: EmittedSection[], profile: TargetProfile, slug?: string): EmittedFile {
    const content = this.chunks.map((c) => c.text).join("");
    return {
      path: this.path,
      role: this.role,
      content,
      fragments: this.chunks,
      tokens: countTokens(content, profile),
      sections,
      ...(slug !== undefined ? { slug } : {}),
    };
  }

  get isEmpty(): boolean {
    return this.chunks.every((c) => c.unitIds.length === 0);
  }
}

export interface AssembleInput {
  profile: TargetProfile;
  plan: BudgetPlan;
  /** Used by partitioned kinds to name their files. */
  units: ContextUnit[];
}

export function assemble(input: AssembleInput): EmittedFile[] {
  switch (input.profile.kind) {
    case "flatMarkdown":
    case "scopedRuleSet":
      return assembleFlat(input);
    case "skillPackage":
      return assemblePartitioned(input, "skill");
    case "commandSet":
      return assemblePartitioned(input, "command");
    case "manifest":
      return assembleManifest(input);
  }
}

function outputPath(profile: TargetProfile, role: EmittedFile["role"], slug?: string): string {
  const output = profile.outputs.find((o) => o.role === role);
  if (!output) throw new Error(`agentify: target "${profile.id}" declares no ${role} output`);
  return slug !== undefined ? output.path.replace("{slug}", slug) : output.path;
}

/** One primary file, plus one secondary holding whatever overflowed. */
function assembleFlat(input: AssembleInput): EmittedFile[] {
  const { profile, plan } = input;
  const files: EmittedFile[] = [];

  const secondaryPath =
    plan.secondary.length > 0 && profile.outputs.some((o) => o.role === "secondary")
      ? outputPath(profile, "secondary", "overflow")
      : undefined;

  const primary = new FileBuilder(outputPath(profile, "primary"), "primary");
  const primarySections = writeSections(primary, profile, plan.primary, secondaryPath);
  files.push(primary.build(primarySections, profile));

  if (secondaryPath) {
    const secondary = new FileBuilder(secondaryPath, "secondary");
    secondary.scaffold(`# ${profile.displayName} — additional context\n\n`, "heading");
    const sections = writeSections(secondary, profile, plan.secondary, undefined);
    files.push(secondary.build(sections, profile));
  }
  return files;
}

/**
 * One file per document role — SPEC §10.5 progressive disclosure, applied to a target whose
 * unit of selection is a package rather than a section.
 *
 * The partition is `documentRole` and the profile says so in `vendorFields.partitionBy`,
 * because it is a design decision rather than a vendor requirement and belongs where a
 * reader can disagree with it.
 */
function assemblePartitioned(input: AssembleInput, flavour: "skill" | "command"): EmittedFile[] {
  const { profile, plan } = input;
  const byRole = new Map<DocumentRole, RankedUnit[]>();
  for (const item of plan.primary) {
    const bucket = byRole.get(item.unit.documentRole);
    if (bucket) bucket.push(item);
    else byRole.set(item.unit.documentRole, [item]);
  }

  const files: EmittedFile[] = [];
  for (const [role, items] of [...byRole.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const slug = kebab(role);
    // `condition: hasCategory(command)` on the claude-commands output. A slash command with
    // no steps is worse than a missing one, so the file is not written at all.
    const condition = profile.outputs.find((o) => o.role === "primary")?.condition;
    if (condition && !satisfiesCondition(condition, items.map((i) => i.unit))) continue;

    const builder = new FileBuilder(outputPath(profile, "primary", slug), "primary");
    writeFrontMatter(builder, profile, slug, role, items.map((i) => i.unit));
    if (flavour === "skill") {
      builder.scaffold(`# ${titleCase(role)}\n\n`, "heading");
    }
    const sections = writeSections(builder, profile, items, undefined);
    files.push(builder.build(sections, profile, slug));
  }
  return files;
}

/**
 * `.mcp.json` — the one target whose output is not prose.
 *
 * Traceability over JSON is per derived value, not per sentence: the server entry is
 * template scaffolding declared in `vendorFields.serverScaffold`, and the `env` block is
 * the only unit-derived part. Segmenting JSON into sentences would be meaningless, so the
 * profile declares `sentenceSegmenter: "simple"` and the verifier takes the value path.
 */
function assembleManifest(input: AssembleInput): EmittedFile[] {
  const { profile, plan } = input;
  const vendor = (profile.vendorFields ?? {}) as {
    serverName?: string;
    serverScaffold?: { command?: string; args?: string[] };
  };
  const serverName = vendor.serverName ?? "project-context";
  const scaffold = vendor.serverScaffold ?? {};

  const envUnits = plan.primary
    .filter((i) => i.unit.category === "environmentVariable" && i.unit.entityKey !== undefined)
    .map((i) => i.unit);
  if (envUnits.length === 0) return [];

  const builder = new FileBuilder(outputPath(profile, "manifest"), "manifest");
  builder.scaffold(`{\n  "mcpServers": {\n    ${JSON.stringify(serverName)}: {\n`, "manifestKey");
  builder.scaffold(`      "command": ${JSON.stringify(scaffold.command ?? "npx")},\n`, "manifestKey");
  builder.scaffold(`      "args": ${JSON.stringify(scaffold.args ?? [])},\n`, "manifestKey");
  builder.scaffold(`      "env": {\n`, "manifestKey");

  envUnits.forEach((unit, i) => {
    const comma = i === envUnits.length - 1 ? "" : ",";
    builder.scaffold(`        `, "marker", "environment");
    builder.unit(`${JSON.stringify(unit.entityKey!)}: ${JSON.stringify(unit.entityValue ?? "")}`, unit, "environment");
    builder.scaffold(`${comma}\n`, "marker", "environment");
  });

  builder.scaffold(`      }\n    }\n  }\n}\n`, "manifestKey");
  return [
    builder.build(
      [{ id: "environment", heading: "env", units: envUnits.length, tokens: 0 }],
      profile,
    ),
  ];
}

function writeFrontMatter(
  builder: FileBuilder,
  profile: TargetProfile,
  slug: string,
  role: DocumentRole,
  units: ContextUnit[],
): void {
  if (!profile.frontMatter?.supported) return;
  const required = profile.frontMatter.required ?? [];
  builder.scaffold("---\n", "frontMatter");
  if (required.includes("name")) {
    // The Agent Skills spec requires `name` to match the parent directory, be at most 64
    // characters, and use lowercase alphanumerics and single hyphens. `kebab` guarantees
    // the character class; the assertion guarantees the rest rather than trusting it.
    if (slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(
        `agentify: "${slug}" is not a valid skill name (agentskills.io/specification: ` +
          `1–64 characters, lowercase alphanumerics and single hyphens, no leading or ` +
          `trailing hyphen).`,
      );
    }
    builder.scaffold(`name: ${slug}\n`, "frontMatter");
  }
  if (required.includes("description")) {
    const description = describeRole(role, units);
    builder.scaffold(`description: ${JSON.stringify(description)}\n`, "frontMatter");
  }
  builder.scaffold("---\n\n", "frontMatter");
}

/**
 * The `description` front-matter value.
 *
 * This is the one string in the whole pipeline that is generated rather than unit-derived,
 * and it is confined to front matter for that reason: the spec makes `description` required
 * and it is what an agent uses to decide whether to load the skill at all, so it cannot be
 * omitted. It is assembled from counted facts — the role and its category tallies — so it
 * states nothing that is not true of the unit set, and front matter is scaffolding the
 * profile declares, so the traceability gate sees it as such rather than as unsupported
 * prose. Recorded in docs/AGENTIFY.md as the single generated string.
 */
function describeRole(role: DocumentRole, units: ContextUnit[]): string {
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.category, (counts.get(unit.category) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, n]) => `${n} ${category}${n === 1 ? "" : "s"}`);
  return (
    `Project context compiled from ${titleCase(role).toLowerCase()} documents: ${parts.join(", ")}. ` +
    `Use when working in this repository and you need its ${titleCase(role).toLowerCase()} rules.`
  );
}

function writeSections(
  builder: FileBuilder,
  profile: TargetProfile,
  items: RankedUnit[],
  secondaryPath: string | undefined,
): EmittedSection[] {
  const sections = profile.sections ?? [];
  const emitted: EmittedSection[] = [];

  for (const section of sections) {
    const mine = items.filter((i) => i.section.id === section.id);
    if (mine.length === 0 && (section.omitWhenEmpty ?? true)) continue;

    const hashes = "#".repeat(section.headingLevel ?? 2);
    builder.scaffold(`${hashes} ${section.heading}\n\n`, "heading", section.id);
    writeSectionBody(builder, section, mine);
    builder.scaffold("\n", "blank", section.id);

    emitted.push({
      id: section.id,
      heading: section.heading,
      units: mine.length,
      tokens: mine.reduce((sum, i) => sum + i.tokens, 0),
    });
  }

  if (secondaryPath && profile.imports?.supported) {
    const syntax = profile.imports.syntax ?? "[{title}]({path})";
    const link = syntax
      .replace("{path}", secondaryPath)
      .replace("{title}", "Additional context");
    builder.scaffold(`## More\n\n${link}\n`, "link");
  }
  return emitted;
}

function writeSectionBody(builder: FileBuilder, section: TargetSection, items: RankedUnit[]): void {
  const render = section.render ?? "bulletList";

  if (render === "codeBlock") {
    builder.scaffold("```\n", "fence", section.id);
    for (const item of items) {
      builder.unit(item.unit.text, item.unit, section.id);
      builder.scaffold("\n", "marker", section.id);
    }
    builder.scaffold("```\n", "fence", section.id);
    return;
  }

  for (const item of items) {
    const unit = item.unit;
    switch (render) {
      case "prose":
        builder.unit(unit.text, unit, section.id);
        builder.scaffold("\n\n", "blank", section.id);
        break;
      case "definitionList":
      case "bulletList":
      case "table":
      default:
        builder.scaffold("- ", "marker", section.id);
        builder.unit(unit.text, unit, section.id);
        builder.scaffold("\n", "marker", section.id);
        if (unit.rationale !== undefined && unit.rationale !== "") {
          builder.scaffold("  - ", "marker", section.id);
          builder.unit(unit.rationale, unit, section.id);
          builder.scaffold("\n", "marker", section.id);
        }
        break;
    }
  }
}

/** `hasCategory(x)` — the only condition form the schema's `condition` field needs today. */
export function satisfiesCondition(condition: string, units: ContextUnit[]): boolean {
  const match = /^hasCategory\(([a-zA-Z]+)\)$/.exec(condition.trim());
  if (!match) {
    throw new Error(
      `agentify: unsupported output condition "${condition}". The only form implemented is ` +
        `hasCategory(<category>); anything else would be silently treated as true, and an ` +
        `output emitted on a condition nobody evaluated is worse than a build failure.`,
    );
  }
  return units.some((u) => u.category === match[1]);
}

export function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(role: string): string {
  const spaced = role.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
