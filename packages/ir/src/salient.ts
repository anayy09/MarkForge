/**
 * The salient-attribute allowlist, read from the IR schema's `x-salient`
 * annotations (docs/SPEC.md §2.7).
 *
 * Reading it from the schema rather than duplicating it here is the point: a second
 * copy would drift, and a drifted copy would change every node id in every document
 * without any test necessarily noticing. The schema is the single source of truth
 * for what makes a node the node it is.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface NodeDef {
  properties?: { type?: { const?: string } };
  "x-salient"?: string[];
}

interface IrSchema {
  $defs: Record<string, NodeDef>;
}

function loadSchema(): IrSchema {
  // Resolved relative to this module so it works from src/ under vitest and from
  // dist/ once built. `files` in package.json ships schema/, so it is present in a
  // published tarball too.
  const candidates = [
    new URL("../schema/ir.v0.schema.json", import.meta.url), // dist/  -> ../schema
    new URL("../../schema/ir.v0.schema.json", import.meta.url), // src/ -> ../../schema
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as IrSchema;
    } catch {
      continue;
    }
  }
  throw new Error(
    "@markforge/ir: could not locate ir.v0.schema.json. The salient-attribute " +
      "allowlist lives in the schema (SPEC §2.7), so node ids cannot be computed " +
      "without it.",
  );
}

let cache: Map<string, readonly string[]> | undefined;

function table(): Map<string, readonly string[]> {
  if (cache) return cache;
  const schema = loadSchema();
  const map = new Map<string, readonly string[]>();
  for (const def of Object.values(schema.$defs)) {
    const typeName = def.properties?.type?.const;
    const salient = def["x-salient"];
    if (typeof typeName === "string" && Array.isArray(salient)) {
      map.set(typeName, Object.freeze([...salient]));
    }
  }
  cache = map;
  return map;
}

/**
 * The properties of `type` that contribute to its identity.
 *
 * An unknown node type throws rather than defaulting to "all properties" or "no
 * properties". Both defaults are wrong in a way that is hard to notice: "all" would
 * fold `position` into the hash and make identical content in two places distinct;
 * "none" would make every node of that type collide, so `occurrence` would carry
 * all the distinguishing information and ids would renumber on any insertion. A
 * missing `x-salient` is a schema bug, and this is where it surfaces.
 */
export function salientAttrsFor(type: string): readonly string[] {
  const attrs = table().get(type);
  if (!attrs) {
    throw new Error(
      `@markforge/ir: no x-salient declared for node type "${type}". ` +
        `Add it to packages/ir/schema/ir.v0.schema.json — a node type with no ` +
        `declared salient attributes has no well-defined identity.`,
    );
  }
  return attrs;
}

/** Every node type the schema declares. Used by tests to assert full coverage. */
export function knownNodeTypes(): readonly string[] {
  return Object.freeze([...table().keys()].sort());
}
