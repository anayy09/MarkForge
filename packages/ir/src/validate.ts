/**
 * Schema validation for IR documents.
 *
 * The schema is the contract between adapters and renderers, so validating at the
 * boundary catches an adapter bug at the adapter rather than three packages later
 * as a confusing render failure.
 */
import Ajv2020Cjs from "ajv/dist/2020.js";
import addFormatsCjs from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { IR_SCHEMA } from "./generated/schema.js";

/**
 * The parts of ajv this module uses. Written out rather than imported because ajv's
 * CJS typings expose a namespace, not a constructable class, under NodeNext — and a
 * three-method structural type is clearer here than fighting the interop.
 */
interface AjvInstance {
  addVocabulary(keywords: string[]): unknown;
  addSchema(schema: object): unknown;
  compile(schema: object): ValidateFunction;
}

// ajv and ajv-formats are CommonJS packages whose runtime export is `module.exports =
// Class` with an added `.default` for interop. Under NodeNext, TypeScript sees the
// namespace and neither `import X from` nor the namespace itself is constructable.
//
// This used to be `createRequire(import.meta.url)`, which is unambiguous at runtime and
// pulls in `node:module` — one of the four builtins that kept every ADR-0015 in-browser
// package from bundling. A default import plus the `.default ?? ` unwrap resolves the
// same value in Node and in a bundler, where `createRequire` resolves nothing at all.
// The unwrap is not defensive: it is which of the two shapes the CJS interop produced,
// and both occur depending on who is loading the module.
type Ajv2020Ctor = new (opts: Record<string, unknown>) => AjvInstance;
const Ajv2020 = ((Ajv2020Cjs as unknown as { default?: Ajv2020Ctor }).default ??
  Ajv2020Cjs) as Ajv2020Ctor;
const addFormats = ((addFormatsCjs as unknown as { default?: (a: AjvInstance) => void })
  .default ?? addFormatsCjs) as (ajv: AjvInstance) => void;
import type { MarkForgeDocument } from "./document.js";

/** The schema, embedded at build time. See the note in `salient.ts` for why. */
function loadSchema(): object {
  return IR_SCHEMA;
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

/**
 * The second half of that fix, which the first half made necessary.
 *
 * Running the thorough validator only when the document is invalid bounds the cost on
 * *valid* documents — which is all the original measurement covered. On an invalid one the
 * explosion comes back: every union branch fails, every failure is recorded, and the count
 * multiplies through the nesting. A **46-node** DOCX fixture with a merged table exhausted a
 * 4 GB heap and killed the process; three other fixtures produced 2541, 18576, and 2044
 * errors before it. So `markforge check` did not hang on large documents, it aborted on
 * small invalid ones, which is the case the flag exists for.
 *
 * The fix is to explain a smaller thing. Descend to the deepest node that fails on its own
 * merits — a parent is invalid because a child is, so the child is the real answer — and run
 * the thorough validator against *that node's* `$defs` entry alone. The culprit's children
 * are known-valid by construction, so the branch count cannot multiply.
 *
 * Measured on `fixtures/docx/tables-merged-combined.docx` with one `rowSpan` deleted from one
 * cell — the exact defect the Markdown adapter shipped: whole-document explanation produces
 * **1,054,471 errors**, localised explanation produces **1**, and it is the right one.
 */
const typeDefs = new Map<string, string>();
const subValidators = new Map<string, ValidateFunction | null>();

function defNameFor(type: string): string | undefined {
  if (typeDefs.size === 0) {
    const defs = (loadSchema() as { $defs?: Record<string, { properties?: { type?: { const?: string } } }> })
      .$defs;
    for (const [name, def] of Object.entries(defs ?? {})) {
      const konst = def?.properties?.type?.const;
      if (typeof konst === "string") typeDefs.set(konst, name);
    }
  }
  return typeDefs.get(type);
}

/** A validator for one node type, compiled on demand. `null` records "no such def". */
function subValidator(type: string, allErrors: boolean, pointer?: string): ValidateFunction | undefined {
  const key = `${allErrors ? "all" : "one"}:${type}`;
  const cached = subValidators.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const name = pointer !== undefined ? pointer.split("/").pop() : defNameFor(type);
  if (name === undefined) {
    subValidators.set(key, null);
    return undefined;
  }
  const schema = loadSchema() as { $id: string };
  const ajv = new Ajv2020({ strict: true, allErrors, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addVocabulary(["x-salient", "x-salientDoc"]);
  ajv.addSchema(schema);
  const compiled = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  subValidators.set(key, compiled);
  return compiled;
}

interface NodeLike {
  type?: unknown;
  children?: unknown;
}

/** The deepest node under `node` whose own children all validate. */
function findCulprit(node: NodeLike, path: string): { node: NodeLike; path: string } {
  const children = Array.isArray(node.children) ? (node.children as NodeLike[]) : [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === null || typeof child !== "object" || typeof child.type !== "string") continue;
    const check = subValidator(child.type, false);
    if (check === undefined) continue;
    if (!(check(child) as boolean)) return findCulprit(child, `${path}/children/${i}`);
  }
  return { node, path };
}

/**
 * "Child 0 must have required property 'children'" when the truth is "an image cannot sit
 * directly in a figure".
 *
 * A union failure reports every branch it tried, and the first branch is rarely the one the
 * author meant. Twice in one afternoon that message sent the reader looking for a missing
 * field on a node that had every field it needed and was simply in the wrong place — an
 * `equationBlock` inside a paragraph, an `image` inside a figure. So before the branch
 * errors, say the thing directly: this child does not satisfy the content model its parent
 * declares.
 */
function misplacedChildren(culprit: { node: NodeLike; path: string }): { path: string; message: string }[] {
  const type = culprit.node.type;
  if (typeof type !== "string") return [];
  const name = defNameFor(type);
  const defs = (loadSchema() as { $defs?: Record<string, ContentModel> }).$defs ?? {};
  const ref = name ? defs[name]?.properties?.children?.items?.$ref : undefined;
  if (typeof ref !== "string") return [];
  const model = ref.split("/").pop();
  if (model === undefined) return [];

  const check = subValidator(`@model:${model}`, false, ref);
  if (check === undefined) return [];

  const out: { path: string; message: string }[] = [];
  const children = Array.isArray(culprit.node.children) ? (culprit.node.children as NodeLike[]) : [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === null || typeof child !== "object") continue;
    if (check(child) as boolean) continue;
    out.push({
      path: `${culprit.path}/children/${i}`,
      message:
        `a node of type "${String(child.type)}" is not valid ${model} — ` +
        `"${type}" holds ${model}, so this child is in the wrong position`,
    });
  }
  return out;
}

interface ContentModel {
  properties?: { children?: { items?: { $ref?: string } } };
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

export function validateDocument(doc: unknown): ValidationResult {
  if (getValidator()(doc) as boolean) return { valid: true, errors: [] };

  const body = (doc as { body?: NodeLike } | null)?.body;
  if (body !== null && typeof body === "object" && typeof body.type === "string") {
    const root = subValidator(body.type, false);
    if (root !== undefined && !(root(body) as boolean)) {
      const culprit = findCulprit(body, "/body");
      const explain = subValidator(culprit.node.type as string, true);
      if (explain !== undefined) {
        explain(culprit.node);
        const errors = misplacedChildren(culprit).concat(
          (explain.errors ?? []).map((e) => ({
          path: `${culprit.path}${e.instancePath}` || "/",
          message: `${e.message ?? "invalid"}${
            e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""
          }`,
          })),
        );
        if (errors.length > 0) return { valid: false, errors };
      }
    }
  }

  // Either the failure is outside the node tree (metadata, resources, a missing `body`), or
  // localising did not reproduce it. Explain the whole document, which is the cost this
  // function used to pay every time.
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
