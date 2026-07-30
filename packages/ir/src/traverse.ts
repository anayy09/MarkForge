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

/** Concatenated text content of a subtree. Used by fidelity metrics and agentify. */
export function textContent(node: AnyNode): string {
  let out = "";
  visit(node, (n) => {
    if (n.type === "text" && typeof n["value"] === "string") out += n["value"];
    else if (n.type === "inlineCode" && typeof n["value"] === "string") out += n["value"];
    else if (n.type === "break") out += "\n";
  });
  return out;
}
