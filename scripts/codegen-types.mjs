// Generates TypeScript types from the JSON Schemas.
//
// docs/SPEC.md §2.2: "TypeScript types are generated from this schema, never
// hand-written." The reason is drift — a hand-written type and a schema that
// disagree produce a validator that accepts what the compiler rejects, and the
// bug surfaces as a runtime failure in a downstream package. Generating removes
// the possibility rather than testing for it.
//
// Run: pnpm codegen   (then commit the output; it is reviewable by design)
import { compileFromFile } from "json-schema-to-typescript";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const banner = (source) => `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: ${source}
 * Regenerate: pnpm codegen
 *
 * Hand edits are lost on the next run. If a type is wrong here, the schema is
 * wrong; fix the schema (docs/SPEC.md §2.2).
 */

`;

const targets = [
  {
    schema: "packages/ir/schema/ir.v0.schema.json",
    out: "packages/ir/src/generated/ir.ts",
    name: "MarkForgeDocument",
  },
  {
    schema: "schema/markforge.config.v0.schema.json",
    out: "packages/core/src/generated/config.ts",
    name: "MarkForgeConfig",
  },
  {
    schema: "packages/agentify/schema/target.v0.schema.json",
    out: "packages/agentify/src/generated/target.ts",
    name: "TargetProfile",
  },
];

let generated = 0;
for (const t of targets) {
  // A package may not be scaffolded yet; skip rather than fail, so this script stays
  // correct as packages land.
  const outDir = join(REPO, t.out, "..");
  const pkgRoot = join(REPO, t.out.split("/").slice(0, 2).join("/"));
  try {
    readFileSync(join(pkgRoot, "package.json"));
  } catch {
    console.log(`skip  ${t.out}  (package not scaffolded yet)`);
    continue;
  }

  const ts = await compileFromFile(join(REPO, t.schema), {
    bannerComment: "",
    additionalProperties: false,
    declareExternallyReferenced: true,
    enableConstEnums: false,
    style: { singleQuote: false, semi: true, printWidth: 100 },
    // Keep $defs names verbatim: the schema is the vocabulary the spec documents,
    // and renaming here would make SPEC.md §2.3 not match the code.
    unreachableDefinitions: true,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(REPO, t.out), banner(t.schema) + ts, "utf8");
  console.log(`ok    ${t.out}  (${t.name}, ${ts.length} bytes)`);
  generated++;
}
// ---------------------------------------------------------------------------
// The schema itself, embedded as a module.
//
// `salient.ts` and `validate.ts` used to `readFileSync` the IR schema at runtime, which
// is correct in Node and impossible in a browser — and it was the single reason **all
// ten** packages ADR-0015 claims run in-browser failed to bundle (scripts/check-browser-bundle.mjs,
// first run). Embedding it here rather than hand-copying it into a `.ts` file keeps the
// property those two modules' comments care about: the schema stays the one source of
// truth for the salient-attribute allowlist, because this file *is* the schema and the
// existing "Generated types are up to date" CI step fails if it drifts.
//
// Emitted as a JSON string parsed at load rather than as an object literal. 62 KB of
// nested literal would be a real cost to typecheck for a value every consumer treats as
// `object` anyway, and `JSON.parse` is what the two call sites already did.
const SCHEMA_MODULES = [
  {
    schema: "packages/ir/schema/ir.v0.schema.json",
    out: "packages/ir/src/generated/schema.ts",
    symbol: "IR_SCHEMA",
  },
];

for (const s of SCHEMA_MODULES) {
  const raw = readFileSync(join(REPO, s.schema), "utf8");
  // Round-trips through parse/stringify so the embedded text is canonical: whitespace
  // in the source file cannot change the generated module, so reformatting the schema
  // does not produce a spurious "generated types are stale" failure.
  const canonical = JSON.stringify(JSON.parse(raw));
  const body =
    banner(s.schema) +
    `export const ${s.symbol}: Record<string, unknown> = JSON.parse(\n  ${JSON.stringify(canonical)}\n) as Record<string, unknown>;\n`;
  mkdirSync(join(REPO, s.out, ".."), { recursive: true });
  writeFileSync(join(REPO, s.out), body, "utf8");
  console.log(`ok    ${s.out}  (${s.symbol}, ${canonical.length} bytes of schema)`);
  generated++;
}

console.log(`\ngenerated ${generated} type module(s)`);
