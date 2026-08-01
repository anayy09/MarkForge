/**
 * Schema validation for IR documents.
 *
 * The schema is the contract between adapters and renderers, so validating at the
 * boundary catches an adapter bug at the adapter rather than three packages later
 * as a confusing render failure.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";

/**
 * The parts of ajv this module uses. Written out rather than imported because ajv's
 * CJS typings expose a namespace, not a constructable class, under NodeNext — and a
 * three-method structural type is clearer here than fighting the interop.
 */
interface AjvInstance {
  addVocabulary(keywords: string[]): unknown;
  compile(schema: object): ValidateFunction;
}

// ajv and ajv-formats are CommonJS packages whose runtime export is `module.exports
// = Class` with an added `.default` for interop. Under NodeNext, TypeScript sees the
// namespace and neither `import X from` nor the namespace itself is constructable.
// createRequire loads the real CJS value, which is unambiguous at runtime and does
// not depend on which interop flag is set.
const require = createRequire(import.meta.url);
type Ajv2020Ctor = new (opts: Record<string, unknown>) => AjvInstance;
const Ajv2020: Ajv2020Ctor = require("ajv/dist/2020.js").default ?? require("ajv/dist/2020.js");
const addFormats: (ajv: AjvInstance) => void =
  require("ajv-formats").default ?? require("ajv-formats");
import type { MarkForgeDocument } from "./document.js";

function loadSchema(): object {
  const candidates = [
    new URL("../schema/ir.v0.schema.json", import.meta.url),
    new URL("../../schema/ir.v0.schema.json", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as object;
    } catch {
      continue;
    }
  }
  throw new Error("@markforge/ir: could not locate ir.v0.schema.json");
}

/**
 * Two validators, and the reason is a defect that made `markforge check` unusable.
 *
 * `allErrors: true` tells ajv to collect every error, which means it cannot stop at the
 * first matching branch of a union. The IR's content unions have 24 and 25 branches, they
 * nest — a table holds cells, which hold paragraphs, which hold phrasing — and the cost
 * multiplies at every level. A 183-node document with two tables **did not finish
 * validating in 120 seconds**. `markforge check` on any real document simply hung, and the
 * table-conformance suite quietly took 154 seconds.
 *
 * The schema half of the fix was `oneOf` → `anyOf` (every union is discriminated by a
 * distinct `type` const, so they accept exactly the same documents, but `oneOf` must
 * evaluate all branches to prove exactly one matched while `anyOf` may stop at the first).
 * That alone was not enough, because `allErrors: true` re-disables the short-circuit.
 *
 * So: the fast validator answers *whether* a document is valid, and the thorough one is
 * compiled lazily and run only when the answer is no — paying for good error messages
 * exactly when there are errors to describe. Same 183-node document: **22 ms**.
 */
let fastValidator: ValidateFunction | undefined;
let thoroughValidator: ValidateFunction | undefined;

function compile(allErrors: boolean): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors, allowUnionTypes: true });
  addFormats(ajv);
  // MarkForge annotations (see scripts/add-salient-annotations.mjs). Declared so
  // strict mode still rejects a genuine typo.
  ajv.addVocabulary(["x-salient", "x-salientDoc"]);
  return ajv.compile(loadSchema());
}

function getValidator(): ValidateFunction {
  fastValidator ??= compile(false);
  return fastValidator;
}

function getThoroughValidator(): ValidateFunction {
  thoroughValidator ??= compile(true);
  return thoroughValidator;
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

export function validateDocument(doc: unknown): ValidationResult {
  if (getValidator()(doc) as boolean) return { valid: true, errors: [] };
  // Invalid: now spend the time to say why, in full.
  const validate = getThoroughValidator();
  validate(doc);
  return {
    valid: false,
    errors: (validate.errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: `${e.message ?? "invalid"}${
        e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""
      }`,
    })),
  };
}

/** Validates and throws with a readable report. For use at package boundaries. */
export function assertValidDocument(doc: unknown): asserts doc is MarkForgeDocument {
  const result = validateDocument(doc);
  if (result.valid) return;
  const shown = result.errors.slice(0, 12);
  const more = result.errors.length - shown.length;
  throw new Error(
    `@markforge/ir: document does not satisfy ir.v0.schema.json\n` +
      shown.map((e) => `  ${e.path}: ${e.message}`).join("\n") +
      (more > 0 ? `\n  ...and ${more} more` : ""),
  );
}
