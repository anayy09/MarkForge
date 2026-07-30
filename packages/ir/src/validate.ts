/**
 * Schema validation for IR documents.
 *
 * The schema is the contract between adapters and renderers, so validating at the
 * boundary catches an adapter bug at the adapter rather than three packages later
 * as a confusing render failure.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

let validator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (validator) return validator;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  // MarkForge annotations (see scripts/add-salient-annotations.mjs). Declared so
  // strict mode still rejects a genuine typo.
  ajv.addVocabulary(["x-salient", "x-salientDoc"]);
  validator = ajv.compile(loadSchema());
  return validator;
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

export function validateDocument(doc: unknown): ValidationResult {
  const validate = getValidator();
  const valid = validate(doc) as boolean;
  if (valid) return { valid: true, errors: [] };
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
