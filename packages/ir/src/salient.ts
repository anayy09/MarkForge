/**
 * The salient-attribute allowlist, read from the IR schema's `x-salient`
 * annotations (docs/SPEC.md §2.7).
 *
 * Reading it from the schema rather than duplicating it here is the point: a second
 * copy would drift, and a drifted copy would change every node id in every document
 * without any test necessarily noticing. The schema is the single source of truth
 * for what makes a node the node it is.
 */
import { IR_SCHEMA } from "./generated/schema.js";

interface NodeDef {
  properties?: { type?: { const?: string } };
  "x-salient"?: string[];
}

interface IrSchema {
  $defs: Record<string, NodeDef>;
}

/**
 * The schema, embedded at build time rather than read from disk.
 *
 * It used to be a `readFileSync` of `../schema/ir.v0.schema.json`, which works in Node
 * and cannot work in a browser — and that one line, shared with `validate.ts`, is why
 * **all ten** packages ADR-0015 claims run in-browser failed to bundle on the first run
 * of `scripts/check-browser-bundle.mjs`.
 *
 * The property the old comment cared about is unchanged: this is still the schema and not
 * a second copy of it. `scripts/codegen-types.mjs` emits `generated/schema.ts` from
 * `schema/ir.v0.schema.json`, and CI's "Generated types are up to date" step fails if the
 * two drift — so a hand-edited allowlist is caught rather than silently renumbering every
 * node id in every document, which is the drift the original comment was guarding against.
 */
function loadSchema(): IrSchema {
  return IR_SCHEMA as unknown as IrSchema;
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
