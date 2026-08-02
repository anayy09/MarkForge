/**
 * Traversal, per the contract in docs/SPEC.md §2.
 *
 * Every consumer needs to walk the tree, and every consumer that writes its own
 * walker gets the child-bearing properties slightly wrong — `body` on a comment and
 * `caption` bindings are easy to miss, and a walker that misses them silently skips
 * subtrees. One implementation, used everywhere.
 */

export interface AnyNode {
  type: string;
  id?: string;
  children?: AnyNode[];
  [key: string]: unknown;
}

/**
 * Properties that hold child nodes. `children` is the mdast standard; `body` is the
 * MarkForge extension used by `comment`, which wraps block content rather than
 * carrying a range (SPEC §2.3 — ranges corrupt under overlapping revisions).
 */
const CHILD_KEYS = ["children", "body"] as const;

export interface VisitContext {
  /** Parent chain, root first, excluding the node itself. */
  readonly ancestors: readonly AnyNode[];
  /** Index within its parent's child array, or -1 for the root. */
  readonly index: number;
  /** The property of the parent that holds this node. */
  readonly key: string | undefined;
  readonly parent: AnyNode | undefined;
  readonly depth: number;
}

export type Visitor<T = void> = (node: AnyNode, ctx: VisitContext) => T;

/** Signal from a visitor to skip a node's children. */
export const SKIP = Symbol("markforge.skip");
/** Signal from a visitor to stop the walk entirely. */
export const STOP = Symbol("markforge.stop");

export function visit(root: AnyNode, visitor: Visitor<void | typeof SKIP | typeof STOP>): void {
  const walk = (node: AnyNode, ctx: VisitContext): typeof STOP | undefined => {
    const signal = visitor(node, ctx);
    if (signal === STOP) return STOP;
    if (signal === SKIP) return undefined;

    const ancestors = [...ctx.ancestors, node];
    for (const key of CHILD_KEYS) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const child = arr[i] as AnyNode | undefined;
        if (!child || typeof child !== "object" || typeof child.type !== "string") continue;
        const result = walk(child, {
          ancestors,
          index: i,
          key,
          parent: node,
          depth: ctx.depth + 1,
        });
        if (result === STOP) return STOP;
      }
    }
    return undefined;
  };

  walk(root, { ancestors: [], index: -1, key: undefined, parent: undefined, depth: 0 });
}

/** All nodes in document order, root first. */
export function flatten(root: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  visit(root, (n) => {
    out.push(n);
  });
  return out;
}

/** Nodes of a given type, in document order. */
export function selectType<T extends AnyNode = AnyNode>(root: AnyNode, type: string): T[] {
  const out: T[] = [];
  visit(root, (n) => {
    if (n.type === type) out.push(n as T);
  });
  return out;
}

/** The first node satisfying a predicate, or undefined. */
export function find(root: AnyNode, predicate: Visitor<boolean>): AnyNode | undefined {
  let found: AnyNode | undefined;
  visit(root, (n, ctx) => {
    if (predicate(n, ctx)) {
      found = n;
      return STOP;
    }
    return undefined;
  });
  return found;
}

/** Index from node id to node. Throws on duplicate ids, which indicate an id bug. */
export function indexById(root: AnyNode): Map<string, AnyNode> {
  const map = new Map<string, AnyNode>();
  visit(root, (n) => {
    if (typeof n.id !== "string") return;
    if (map.has(n.id)) {
      throw new Error(
        `@markforge/ir: duplicate node id ${n.id}. Ids are content-addressed with an ` +
          `occurrence counter (ADR-0014), so a duplicate means assignIds did not run or ` +
          `two subtrees were merged without reassigning.`,
      );
    }
    map.set(n.id, n);
  });
  return map;
}

/** Node count, cheaper than `flatten().length` for large documents. */
export function countNodes(root: AnyNode): number {
  let n = 0;
  visit(root, () => {
    n++;
  });
  return n;
}

/**
 * Replaces nodes in place via a mapping function. Returning an array splices
 * multiple nodes into the parent's position; returning null removes the node.
 *
 * Used by normalisation (SPEC §2.8), where rules like "empty paragraph becomes
 * spacing evidence on the next block" need to delete a node while keeping its
 * information.
 */
export function transformChildren(
  root: AnyNode,
  fn: (node: AnyNode, ctx: VisitContext) => AnyNode | AnyNode[] | null,
): void {
  const walk = (node: AnyNode, ancestors: readonly AnyNode[]): void => {
    for (const key of CHILD_KEYS) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      const next: AnyNode[] = [];
      for (let i = 0; i < arr.length; i++) {
        const child = arr[i] as AnyNode;
        if (!child || typeof child !== "object" || typeof child.type !== "string") {
          next.push(child);
          continue;
        }
        walk(child, [...ancestors, node]);
        const replacement = fn(child, {
          ancestors: [...ancestors, node],
          index: i,
          key,
          parent: node,
          depth: ancestors.length + 1,
        });
        if (replacement === null) continue;
        if (Array.isArray(replacement)) next.push(...replacement);
        else next.push(replacement);
      }
      (node as Record<string, unknown>)[key] = next;
    }
  };
  walk(root, []);
}

/**
 * Block-level types, for `textContent`'s separator rule.
 *
 * SPEC §9.2: "inline nodes concatenate with no separator, block nodes join with `\n\n`,
 * `break` yields `\n`". Only the first and third clauses were implemented.
 */
const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "code",
  "listItem",
  "tableCell",
  "tableRow",
  "caption",
  "figure",
  "admonition",
  "descriptionTerm",
  "descriptionDetails",
  "equationBlock",
  "footnoteDefinition",
  "section",
  "slide",
  "sheet",
  "thematicBreak",
]);

/**
 * Concatenated text content of a subtree, per SPEC §9.2.
 *
 * Inline nodes concatenate with no separator; block nodes join with a blank line; `break`
 * yields a newline.
 *
 * **The block clause was missing until 2026-08-01**, and the way it stayed missing is the
 * interesting part. Every block boundary vanished, so a table cell holding three paragraphs
 * returned `Stop the intake.Wait for depth to reach zero.Confirm with the dashboard.` and a
 * nested table returned `keyvaluemodestrict`.
 *
 * `docs/FIDELITY.md` could not see it. The text metric calls this function on **both** sides
 * of a round trip, so the same wrong string was compared against itself and agreed perfectly:
 * `fixtures/docx/tables-block-content.docx` scored 100% on every metric while carrying the
 * defect. A defect applied symmetrically to both sides of a round trip is invisible to a
 * round-trip metric — the same shape as the census's own blind spot, reached from the other
 * direction.
 *
 * What made it real rather than cosmetic is the one consumer that is *not* symmetric:
 * agentify segments this string into sentences, so a cell whose paragraphs ran together
 * produced context units spanning a boundary that did not exist.
 *
 * Held by `scripts/check-ir-structure.mjs`, which compares parsed IR against an authored
 * declaration rather than against its own round trip.
 */
export function textContent(node: AnyNode): string {
  const parts: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      parts.push(current);
      current = "";
    }
  };

  const walk = (n: AnyNode): void => {
    if (n.type === "text" && typeof n["value"] === "string") {
      current += n["value"];
      return;
    }
    if (n.type === "inlineCode" && typeof n["value"] === "string") {
      current += n["value"];
      return;
    }
    if (n.type === "code" && typeof n["value"] === "string") {
      // A fence's text lives in `value`, not in child `text` nodes, so walking children
      // would return nothing at all for it.
      flush();
      parts.push(n["value"]);
      return;
    }
    if (n.type === "break") {
      current += "\n";
      return;
    }

    const isBlock = TEXT_BLOCK_TYPES.has(n.type);
    if (isBlock) flush();
    for (const child of childrenOf(n)) walk(child);
    if (isBlock) flush();
  };

  walk(node);
  flush();
  return parts.join("\n\n");
}

/** Children of a node across every array-valued key, matching `visit`'s own traversal. */
function childrenOf(n: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(n)) {
    const value = (n as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as AnyNode).type === "string") {
          out.push(item as AnyNode);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
      out.push(value as AnyNode);
    }
  }
  return out;
}

/**
 * Base64, without `Buffer`.
 *
 * `@markforge/ir` is in ADR-0015's eager browser tier and
 * `scripts/check-browser-bundle.mjs` fails on any `node:` reach, so `Buffer.from(...)` is
 * not available here — the same constraint that replaced `node:crypto` with
 * `@noble/hashes`. Two implementations selected by platform would be two things that must
 * agree about every byte forever, with the agreement untested on whichever platform CI does
 * not run, so there is one.
 */
export function base64(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 63];
  }
  return out;
}

/** The inverse of `base64`, for a renderer that needs the bytes back. */
export function fromBase64(text: string): Uint8Array {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (ALPHABET.indexOf(clean[i] as string) << 18) |
      (ALPHABET.indexOf(clean[i + 1] as string) << 12) |
      (Math.max(0, ALPHABET.indexOf(clean[i + 2] ?? "A")) << 6) |
      Math.max(0, ALPHABET.indexOf(clean[i + 3] ?? "A"));
    if (p < out.length) out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out;
}
