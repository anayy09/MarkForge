import { describe, it, expect } from "vitest";
import { assignIds, reassignIds, parseNodeId, NODE_ID_PATTERN } from "../src/node-id.js";
import { salientAttrsFor, knownNodeTypes } from "../src/salient.js";
import { flatten } from "../src/traverse.js";
import type { AnyNode } from "../src/traverse.js";

const para = (text: string): AnyNode => ({
  type: "paragraph",
  children: [{ type: "text", value: text }],
});

const doc = (...paras: string[]): AnyNode => ({
  type: "root",
  children: paras.map(para),
});

describe("node ids", () => {
  it("assigns ids matching the ADR-0014 shape", () => {
    const tree = doc("one", "two");
    assignIds(tree);
    for (const node of flatten(tree)) {
      expect(node.id).toMatch(NODE_ID_PATTERN);
      const parsed = parseNodeId(node.id as string);
      expect(parsed).not.toBeNull();
      expect(parsed!.prefix).toHaveLength(20);
    }
  });

  it("is deterministic across runs", () => {
    const a = doc("one", "two");
    const b = doc("one", "two");
    assignIds(a);
    assignIds(b);
    expect(flatten(a).map((n) => n.id)).toEqual(flatten(b).map((n) => n.id));
  });

  it("disambiguates identical leaves with the occurrence counter", () => {
    const tree = doc("same", "same");
    assignIds(tree);
    // Leaves genuinely collide: two `text` nodes with value "same" have the same
    // digest, so the counter is what separates them.
    const leaves = (tree.children as AnyNode[]).map((p) => (p.children as AnyNode[])[0]!.id as string);
    expect(parseNodeId(leaves[0]!)!.prefix).toBe(parseNodeId(leaves[1]!)!.prefix);
    expect(parseNodeId(leaves[0]!)!.occurrence).toBe(0);
    expect(parseNodeId(leaves[1]!)!.occurrence).toBe(1);
  });

  it("gives identical parents distinct digests, because child ids differ", () => {
    const tree = doc("same", "same");
    assignIds(tree);
    const ids = (tree.children as AnyNode[]).map((n) => n.id as string);
    expect(ids[0]).not.toBe(ids[1]);
    // SPEC §2.7 folds `children.map(c => c.nodeId)` — the full id, occurrence
    // included — into the parent digest. So the counter fires at the leaves and the
    // distinction propagates upward as differing digests, rather than every level
    // needing its own counter.
    expect(parseNodeId(ids[0]!)!.prefix).not.toBe(parseNodeId(ids[1]!)!.prefix);
    expect(parseNodeId(ids[0]!)!.occurrence).toBe(0);
    expect(parseNodeId(ids[1]!)!.occurrence).toBe(0);
  });

  // An honest limit of any content-addressed scheme, recorded as a test so it is a
  // known property rather than a surprise: duplicates are numbered in document
  // order, so changing an earlier duplicate renumbers the later ones. The ids are
  // stable while the *set* of identical siblings is stable, which is the common case.
  it("renumbers later duplicates when an earlier duplicate changes (known limit)", () => {
    const before = doc("same", "same");
    assignIds(before);
    const secondBefore = (before.children as AnyNode[])[1]!.id;

    const after = doc("different", "same");
    assignIds(after);
    const secondAfter = (after.children as AnyNode[])[1]!.id;

    expect(secondAfter).not.toBe(secondBefore);
  });

  // This is the property the whole scheme exists for (SPEC §2.7): editing one
  // paragraph must not renumber its siblings, because that is what keeps an
  // incremental regeneration diff minimal.
  it("an edit changes only the edited node and its ancestors", () => {
    const before = doc("alpha", "beta", "gamma");
    assignIds(before);
    const beforeIds = (before.children as AnyNode[]).map((n) => n.id as string);

    const after = doc("alpha", "BETA CHANGED", "gamma");
    assignIds(after);
    const afterIds = (after.children as AnyNode[]).map((n) => n.id as string);

    expect(afterIds[0]).toBe(beforeIds[0]);
    expect(afterIds[1]).not.toBe(beforeIds[1]);
    expect(afterIds[2]).toBe(beforeIds[2]);
  });

  it("an insertion does not renumber following siblings", () => {
    const before = doc("alpha", "beta");
    assignIds(before);
    const betaId = (before.children as AnyNode[])[1]!.id;

    const after = doc("alpha", "inserted", "beta");
    assignIds(after);
    const afterBetaId = (after.children as AnyNode[])[2]!.id;

    // A positional scheme like /body/children/1 would have changed this. The whole
    // point of content addressing is that it does not.
    expect(afterBetaId).toBe(betaId);
  });

  it("changes ancestor ids when a descendant changes", () => {
    const before = doc("alpha");
    assignIds(before);
    const rootBefore = before.id;

    const after = doc("alpha changed");
    assignIds(after);
    expect(after.id).not.toBe(rootBefore);
  });

  it("ignores position, so identical content at different offsets shares a digest", () => {
    const a: AnyNode = { type: "paragraph", children: [{ type: "text", value: "x" }] };
    const b: AnyNode = {
      type: "paragraph",
      position: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } },
      children: [{ type: "text", value: "x" }],
    };
    assignIds(a);
    assignIds(b);
    expect(parseNodeId(a.id as string)!.prefix).toBe(parseNodeId(b.id as string)!.prefix);
  });

  it("distinguishes node types with identical children", () => {
    const p: AnyNode = { type: "paragraph", children: [{ type: "text", value: "x" }] };
    const h: AnyNode = { type: "heading", depth: 1, resolvedLevel: 1, children: [{ type: "text", value: "x" }] };
    assignIds(p);
    assignIds(h);
    expect(parseNodeId(p.id as string)!.prefix).not.toBe(parseNodeId(h.id as string)!.prefix);
  });

  it("sets contentHash to the full subtree digest", () => {
    const tree = doc("x");
    assignIds(tree);
    expect(tree["contentHash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reassignIds reports which ids changed", () => {
    const tree = doc("alpha", "beta");
    assignIds(tree);
    const kids = tree.children as AnyNode[];
    (kids[1]!.children as AnyNode[])[0]!["value"] = "beta changed";
    const { changed } = reassignIds(tree);
    // The edited paragraph, its text node, and the root. Not the untouched sibling.
    expect(changed).toHaveLength(3);
  });
});

describe("salient attributes", () => {
  it("declares an allowlist for every node type in the schema", () => {
    const types = knownNodeTypes();
    expect(types.length).toBe(53);
    for (const t of types) expect(salientAttrsFor(t).length).toBeGreaterThan(0);
  });

  it("never includes id, position, contentHash, or children", () => {
    for (const t of knownNodeTypes()) {
      const attrs = salientAttrsFor(t);
      for (const forbidden of ["id", "position", "contentHash", "children"]) {
        expect(attrs, `${t} must not treat ${forbidden} as salient`).not.toContain(forbidden);
      }
    }
  });

  it("throws for an unknown node type rather than guessing", () => {
    expect(() => salientAttrsFor("notARealType")).toThrow(/no x-salient declared/);
  });
});
