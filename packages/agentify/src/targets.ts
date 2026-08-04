/**
 * What a target profile *is* — data, not code (SPEC §10.9, ADR-0013).
 *
 * Nothing in this file knows that Cursor uses globs or that Claude Code's import syntax is
 * `@path`. It declares the shape of a profile, the three pure functions that read one, and
 * the `Registry` interface `compile()` consumes. Adding a target is adding a file, which is
 * the whole claim ADR-0013 makes and the reason the escape hatch is `vendorFields` rather
 * than a plugin interface.
 *
 * ## Why reading the directory lives somewhere else
 *
 * This file used to open the registry itself: `node:fs` for the directory, `node:module`
 * for ajv, `node:url` for the schema next to the built package. Four builtins, all of them
 * in service of *acquiring* profiles rather than of understanding them — and they made
 * `@markforge/agentify` a `nodeOnly` package in `check-browser-bundle.mjs`.
 *
 * That tier was load-bearing in the wrong direction. Every other module in this package is
 * already pure: `extract`, `dedup`, `budget`, `assemble`, `verify` and `compile` take data
 * and return data, and `compile()`'s own header says ADR-0015 "wants this to run in a
 * browser". One file's import list was the only thing making the Agent Context Compiler —
 * SPEC §10, the product's headline feature — unreachable from any browser, which is why the
 * web app shipped without it.
 *
 * So loading is now `./registry-node.js`, reached through the `@markforge/agentify/registry-node`
 * subpath. This is the same split `@markforge/browser` already makes for the PDF compiler:
 * the pure half takes an explicit config object, and the half that needs a filesystem is a
 * separate entry point nobody bundles by accident. A caller with a directory calls
 * `loadRegistry`; a caller holding already-resolved profiles calls `registryFromProfiles`
 * below.
 */
import type { UnitCategory } from "./units.js";

export type TargetKind =
  | "flatMarkdown"
  | "scopedRuleSet"
  | "skillPackage"
  | "commandSet"
  | "manifest";

export type SectionRender = "bulletList" | "table" | "prose" | "codeBlock" | "definitionList";

export interface TargetSection {
  id: string;
  heading: string;
  headingLevel?: number;
  categories: UnitCategory[];
  categoryWeight?: number;
  render?: SectionRender;
  maxUnits?: number;
  scaffoldOnly?: boolean;
  omitWhenEmpty?: boolean;
}

export interface TargetOutput {
  path: string;
  role: "primary" | "secondary" | "manifest" | "asset";
  condition?: string;
}

export interface TargetProfile {
  id: string;
  targetVersion: string;
  displayName: string;
  extends?: string;
  kind: TargetKind;
  tier?: "firstClass" | "stub";
  vendor?: string;
  docsUrl?: string;
  verifiedAgainst: { url: string; date: string; note?: string };
  outputs: TargetOutput[];
  budget: {
    primaryTokens: number;
    secondaryTokens?: number;
    counter: { method: "modelTokenizer" | "approximate"; model?: string; charsPerToken?: number };
    overflow?: "linkToSecondary" | "truncateLowestValue" | "fail";
  };
  frontMatter?: {
    supported: boolean;
    language?: "yaml" | "toml";
    required?: string[];
    schema?: Record<string, unknown>;
  };
  imports?: { supported: boolean; syntax?: string; maxDepth?: number };
  scoping?: { byGlob?: boolean; globField?: string; alwaysApplyField?: string };
  sections?: TargetSection[];
  tone?: { voice?: "imperative" | "declarative"; person?: "second" | "third"; maxSentenceWords?: number };
  traceability?: { required?: number; sentenceSegmenter?: "icu" | "simple" };
  vendorFields?: Record<string, unknown>;
}

export interface Registry {
  get(id: string): TargetProfile;
  ids(): string[];
  /** How stale each profile's vendor check is, for the run report and the CI warning. */
  verificationAges(today: Date): { id: string; date: string; ageDays: number }[];
}

/**
 * How stale one vendor check is. Shared so both registries answer this identically.
 *
 * `NaN` for a missing date rather than `0` or `Infinity`: an absent check is not a fresh
 * one and is not an infinitely old one, and every caller formats it as "unknown". A
 * numeric stand-in would sort.
 */
export function verificationAge(date: string, today: Date): number {
  return date ? Math.floor((today.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) : Number.NaN;
}

/**
 * A registry over profiles that are **already resolved and already validated**.
 *
 * This is the browser's way in, and the honesty of it rests entirely on that sentence. It
 * runs no `extends` merge and no schema validation, because it has no ajv and no schema to
 * validate against — so it must never be handed raw profile JSON straight off disk. What it
 * is for is the case where resolution already happened somewhere that could do it properly:
 * `apps/web/scripts/prepare-assets.mjs` calls `loadRegistry` at build time, in Node, with
 * the schema present, and serialises the twelve resolved profiles. The browser then gets
 * objects that a validating loader produced, rather than objects it chose to trust.
 *
 * Passing an unresolved delta here does not silently half-work. A delta declares no
 * `sections` and no `kind`, so `assemble()` would emit an empty file and `verify()` would
 * pass it at 100% traceability — a gate reporting perfect provenance over nothing. The
 * `extends` check below refuses that case by name instead.
 */
export function registryFromProfiles(profiles: readonly TargetProfile[]): Registry {
  const byId = new Map<string, TargetProfile>();
  for (const profile of profiles) {
    if (typeof profile?.id !== "string") {
      throw new Error("agentify: registryFromProfiles received a profile with no string \"id\"");
    }
    if ((profile as { extends?: unknown }).extends !== undefined) {
      throw new Error(
        `agentify: profile "${profile.id}" still declares "extends", so it has not been ` +
          `resolved. registryFromProfiles takes resolved profiles only — it has no schema and ` +
          `no ajv, and an unresolved delta carries no sections, which assemble() would turn ` +
          `into an empty file that verify() then passes at 100%. Resolve it with loadRegistry ` +
          `from @markforge/agentify/registry-node first.`,
      );
    }
    if (byId.has(profile.id)) throw new Error(`agentify: two profiles claim id "${profile.id}"`);
    byId.set(profile.id, profile);
  }

  return {
    get: (id) => {
      const found = byId.get(id);
      if (!found) {
        throw new Error(
          `agentify: no target profile "${id}". Available: ${[...byId.keys()].sort().join(", ")}.`,
        );
      }
      return found;
    },
    ids: () => [...byId.keys()].sort(),
    verificationAges: (today) =>
      [...byId.keys()].sort().map((id) => {
        const date = byId.get(id)?.verifiedAgainst?.date ?? "";
        return { id, date, ageDays: verificationAge(date, today) };
      }),
  };
}

/** Section that accepts a category, or undefined when the profile routes it nowhere. */
export function sectionForCategory(
  profile: TargetProfile,
  category: UnitCategory,
): TargetSection | undefined {
  return (profile.sections ?? []).find((s) => s.categories.includes(category));
}

/**
 * Token count for a string, by the profile's declared method.
 *
 * `modelTokenizer` refuses rather than approximating. SPEC §10.5 requires the counting
 * method to be named in the report "so no one mistakes an estimate for a measurement" —
 * quietly substituting an estimate for the tokenizer a profile asked for would defeat
 * exactly that sentence. No tokenizer is bundled today (ADR-0019), so a profile wanting
 * one is a configuration error with a named cause, not a silent downgrade.
 */
export function countTokens(text: string, profile: TargetProfile): number {
  const counter = profile.budget.counter;
  if (counter.method === "modelTokenizer") {
    throw new Error(
      `agentify: target "${profile.id}" asks for budget.counter.method "modelTokenizer"` +
        `${counter.model ? ` (model ${counter.model})` : ""}, but no tokenizer is bundled ` +
        `(ADR-0019). Falling back to the approximation silently would put an estimate in the ` +
        `report under the name of a measurement, which SPEC §10.5 forbids. Set the method to ` +
        `"approximate".`,
    );
  }
  const charsPerToken = counter.charsPerToken ?? 3.8;
  return Math.ceil([...text].length / charsPerToken);
}

/** Human-readable description of how tokens were counted, for the run report. */
export function counterDescription(profile: TargetProfile): string {
  const c = profile.budget.counter;
  return c.method === "approximate"
    ? `approximate (${c.charsPerToken ?? 3.8} characters per token) — an estimate, not a measurement`
    : `model tokenizer${c.model ? ` (${c.model})` : ""}`;
}
