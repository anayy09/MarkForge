/**
 * Reading a target registry off a filesystem — the half of `targets.ts` that needs Node.
 *
 * ## Why this is a separate entry point
 *
 * `@markforge/agentify/registry-node`, not `@markforge/agentify`. The package's index must
 * bundle for a browser with no Node builtin reachable, because `check-browser-bundle.mjs`
 * probes it by building it and evaluating the result against web-platform globals only.
 * Anything this file imports — `node:fs`, `node:url`, `node:module`, `node:path`, ajv —
 * would fail that probe from three hops away if the index re-exported `loadRegistry`.
 *
 * It must therefore stay out of `index.ts`. That is not a style preference: it is the
 * mechanism, and re-exporting this module from the index is the one edit that silently
 * undoes the whole split and puts the Agent Context Compiler back out of the browser's
 * reach. The gate would catch it, which is the point of stating it here.
 *
 * Everything about *what a profile means* is in `./targets.js` and is shared. This file
 * only knows how to acquire one.
 *
 * ## Two properties worth keeping, both inherited from the original
 *
 * **Deltas merge shallowly, at the top level only.** `claude-md` overriding `budget`
 * replaces the whole budget object rather than merging into it. Deep merge was rejected for
 * a reason that shows up the first time someone debugs a profile: with deep merge, reading a
 * delta no longer tells you what the resolved profile contains, because any absent leaf
 * might be inherited from three levels away. Shallow merge means the delta *is* the diff.
 *
 * **Only the resolved profile is validated.** A delta on its own is not a target profile and
 * would fail the schema's `required` list by design — `claude-md` declares no `sections`
 * because it wants the base's. Validating after resolution is the single honest checkpoint,
 * and `additionalProperties: false` still catches a typo'd key in a delta, because the merge
 * carries the typo through into the resolved object.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { verificationAge, type Registry, type TargetProfile } from "./targets.js";

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
        return { id, date, ageDays: verificationAge(date, today) };
      }),
  };
}

/**
 * Every profile in the directory, resolved and validated, as plain data.
 *
 * The bridge to `registryFromProfiles`: a build step calls this in Node, serialises the
 * result, and a browser reconstitutes a registry from it without needing ajv or a
 * filesystem. Resolution is forced here rather than left lazy, because a caller
 * serialising the output wants every profile to have been checked — a lazy failure would
 * become a runtime failure in a browser that cannot explain it.
 */
export function resolveAllProfiles(dir: string): TargetProfile[] {
  const registry = loadRegistry(dir);
  return registry.ids().map((id) => registry.get(id));
}
