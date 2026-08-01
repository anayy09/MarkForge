/**
 * The target registry — data, not code (SPEC §10.9, ADR-0013).
 *
 * A profile is JSON on disk. Nothing in this file knows that Cursor uses globs or that
 * Claude Code's import syntax is `@path`; it knows how to read a profile, apply a delta to
 * its base, and refuse a profile that does not validate. Adding a target is adding a file,
 * which is the whole claim ADR-0013 makes and the reason the escape hatch is
 * `vendorFields` rather than a plugin interface.
 *
 * **Deltas merge shallowly, at the top level only.** `claude-md` overriding `budget`
 * replaces the whole budget object rather than merging into it. Deep merge was rejected
 * for a reason that shows up the first time someone debugs a profile: with deep merge,
 * reading a delta no longer tells you what the resolved profile contains, because any
 * absent leaf might be inherited from three levels away. Shallow merge means the delta
 * *is* the diff.
 *
 * **Only the resolved profile is validated.** A delta on its own is not a target profile
 * and would fail the schema's `required` list by design — `claude-md` declares no
 * `sections` because it wants the base's. Validating after resolution is the single
 * honest checkpoint, and `additionalProperties: false` still catches a typo'd key in a
 * delta, because the merge carries the typo through into the resolved object.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import type { UnitCategory } from "./units.js";

interface AjvInstance {
  compile(schema: object): ValidateFunction;
}

// Same CJS interop shape as @markforge/ir's validator, for the same reason: ajv's typings
// expose a namespace rather than a constructable class under NodeNext.
const require = createRequire(import.meta.url);
type Ajv2020Ctor = new (opts: Record<string, unknown>) => AjvInstance;
const Ajv2020: Ajv2020Ctor = require("ajv/dist/2020.js").default ?? require("ajv/dist/2020.js");
const addFormats: (ajv: AjvInstance) => void =
  require("ajv-formats").default ?? require("ajv-formats");

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

function loadSchema(): object {
  const candidates = [
    new URL("../schema/target.v0.schema.json", import.meta.url),
    new URL("../../schema/target.v0.schema.json", import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as object;
  }
  throw new Error("agentify: target.v0.schema.json not found next to the built package");
}

let validator: ValidateFunction | undefined;

function targetValidator(): ValidateFunction {
  if (validator) return validator;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  validator = ajv.compile(loadSchema());
  return validator;
}

export interface Registry {
  get(id: string): TargetProfile;
  ids(): string[];
  /** How stale each profile's vendor check is, for the run report and the CI warning. */
  verificationAges(today: Date): { id: string; date: string; ageDays: number }[];
}

/**
 * Reads every `*.json` in a directory as a profile and returns a resolver.
 *
 * Resolution is lazy and memoised: a registry of twelve profiles where a run uses one
 * should not pay to resolve eleven, and more importantly should not *fail* because an
 * unrelated stub has a bad `extends`. A broken profile fails when it is asked for.
 */
export function loadRegistry(dir: string): Registry {
  if (!existsSync(dir)) {
    throw new Error(
      `agentify: no target registry at "${dir}". Targets are data, not code ` +
        `(SPEC §10.9) — the registry is a directory of profile JSON files. Point ` +
        `agentify.registry at one, or use the repository's ./targets.`,
    );
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const raw = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    // Editor affordance only, and not part of the schema, so it is stripped before the
    // resolved object is validated under additionalProperties: false.
    delete parsed["$schema"];
    const id = parsed["id"];
    if (typeof id !== "string") {
      throw new Error(`agentify: ${file} has no string "id"`);
    }
    if (raw.has(id)) throw new Error(`agentify: two profiles claim id "${id}"`);
    raw.set(id, parsed);
  }

  const resolved = new Map<string, TargetProfile>();

  function resolve(id: string, chain: string[]): TargetProfile {
    const memo = resolved.get(id);
    if (memo) return memo;
    if (chain.includes(id)) {
      throw new Error(`agentify: circular target extends: ${[...chain, id].join(" -> ")}`);
    }
    const profile = raw.get(id);
    if (!profile) {
      throw new Error(
        `agentify: no target profile "${id}" in ${dir}. Available: ${[...raw.keys()].sort().join(", ")}.`,
      );
    }
    let merged: Record<string, unknown>;
    if (typeof profile["extends"] === "string") {
      const base = resolve(profile["extends"], [...chain, id]) as unknown as Record<string, unknown>;
      merged = { ...base, ...profile };
      delete merged["extends"];
      // The base's identity must not leak into the delta. Shallow merge already
      // overwrites these because every profile declares them, but a profile that
      // forgot one would silently inherit the base's id and emit to the base's path.
      for (const key of ["id", "targetVersion", "displayName", "verifiedAgainst"]) {
        if (!(key in profile)) {
          throw new Error(
            `agentify: profile "${id}" extends "${profile["extends"] as string}" but does not ` +
              `declare its own "${key}". A delta inheriting that field would emit under the ` +
              `base's identity — for verifiedAgainst it would also inherit a vendor check that ` +
              `was never done for this target (ADR-0013).`,
          );
        }
      }
    } else {
      merged = { ...profile };
    }

    const validate = targetValidator();
    if (!validate(merged)) {
      const errors = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "/"} ${e.message ?? ""}`)
        .join("\n");
      throw new Error(
        `agentify: target profile "${id}" does not validate against ` +
          `packages/agentify/schema/target.v0.schema.json after resolving its deltas:\n${errors}`,
      );
    }
    const out = merged as unknown as TargetProfile;
    resolved.set(id, out);
    return out;
  }

  return {
    get: (id) => resolve(id, []),
    ids: () => [...raw.keys()].sort(),
    verificationAges: (today) =>
      [...raw.keys()].sort().map((id) => {
        const date = String((raw.get(id) as { verifiedAgainst?: { date?: string } }).verifiedAgainst?.date ?? "");
        const ageDays = date
          ? Math.floor((today.getTime() - Date.parse(date + "T00:00:00Z")) / 86_400_000)
          : Number.NaN;
        return { id, date, ageDays };
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
