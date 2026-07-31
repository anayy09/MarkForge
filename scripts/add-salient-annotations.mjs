// One-shot migration: adds `x-salient` to every node type in the IR schema.
//
// docs/SPEC.md §2.7 says salientAttrs is "a per-type allowlist declared in the
// schema". It was not — the claim was true of the design and false of the file.
// This makes it true, so @markforge/ir can read the allowlist from the schema
// rather than carry a second copy that drifts.
//
// Why an allowlist rather than a derivation rule ("all properties except these
// four"): a derivation rule silently includes any property added later, so adding
// a sidecar-derived field would change every node id in every document. With an
// allowlist the default for a new property is *excluded*, which is the safe
// direction. A test asserts x-salient stays a subset of declared properties.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../packages/ir/schema/ir.v0.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(path, "utf8"));

// Never salient, per ADR-0014:
//   id           — the value being computed; including it would be circular
//   position     — source coordinates; the same content from a different offset
//                  is the same content
//   contentHash  — derived from the digest
//   children     — contributes as childIds, separately and by id, not by value
const NEVER = new Set(["id", "position", "contentHash", "children"]);

// A node type is any $def that composes NodeBase and pins `type` to a const.
const isNodeType = (def) =>
  Array.isArray(def?.allOf) &&
  def.allOf.some((s) => s?.$ref === "#/$defs/NodeBase") &&
  typeof def?.properties?.type?.const === "string";

let annotated = 0;
const report = [];
for (const [name, def] of Object.entries(schema.$defs)) {
  if (!isNodeType(def)) continue;
  const salient = Object.keys(def.properties).filter((k) => !NEVER.has(k));
  // `type` stays salient on purpose: a paragraph and a heading with identical
  // children are different nodes, and the digest must say so.
  def["x-salient"] = salient;
  annotated++;
  report.push(`  ${name.padEnd(20)} ${salient.join(", ")}`);
}

// Document the annotation in the schema itself, so a reader of the file alone
// understands what it means without consulting SPEC.md.
schema["x-salientDoc"] =
  "Per-node-type allowlist of properties that contribute to the content-addressed " +
  "NodeId digest (docs/SPEC.md section 2.7, ADR-0014). Excludes id, position, " +
  "contentHash, and children; children contribute via their own ids instead. A " +
  "property absent from x-salient does not affect node identity.";

writeFileSync(path, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(report.join("\n"));
console.log(`\nannotated ${annotated} node types with x-salient`);
