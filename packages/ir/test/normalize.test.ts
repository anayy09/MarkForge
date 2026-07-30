import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { normalize } from "../src/normalize.js";
import { assignIds } from "../src/node-id.js";
import { canonicalJson } from "../src/canonical-json.js";
import { textContent } from "../src/traverse.js";
import type { AnyNode } from "../src/traverse.js";
import type { StyleEvidence } from "../src/document.js";

const text = (value: string): AnyNode => ({ type: "text", value });
const para = (...kids: AnyNode[]): AnyNode => ({ type: "paragraph", children: kids });
const root = (...kids: AnyNode[]): AnyNode => ({ type: "root", children: kids });

describe("normalize", () => {
  it("merges adjacent text siblings", () => {
    const tree = root(para(text("a"), text("b"), text("c")));
    normalize(tree);
    expect((tree.children as AnyNode[])[0]!.children).toHaveLength(1);
    expect(textContent(tree)).toBe("abc");
  });

  it("merges adjacent identical marks to a fixed point", () => {
    // Three adjacent marks: a single pass merges two and leaves one, which would
    // break idempotency. The loop must converge.
    const em = (s: string): AnyNode => ({ type: "emphasis", children: [text(s)] });
    const tree = root(para(em("a"), em("b"), em("c")));
    normalize(tree);
    const kids = (tree.children as AnyNode[])[0]!.children as AnyNode[];
    expect(kids).toHaveLength(1);
    expect(textContent(kids[0]!)).toBe("abc");
  });

  it("does not merge marks with different attributes", () => {
    const hl = (color: string): AnyNode => ({
      type: "highlight",
      color,
      children: [text("x")],
    });
    const tree = root(para(hl("yellow"), hl("green")));
    normalize(tree);
    expect((tree.children as AnyNode[])[0]!.children).toHaveLength(2);
  });

  it("collapses interior whitespace but not inside code", () => {
    const tree = root(
      para(text("a    b")),
      { type: "code", lang: "js", value: "a    b" },
    );
    normalize(tree);
    expect(textContent((tree.children as AnyNode[])[0]!)).toBe("a b");
    expect((tree.children as AnyNode[])[1]!["value"]).toBe("a    b");
  });

  it("preserves non-breaking spaces, which are semantic not whitespace", () => {
    const tree = root(para(text("10 km")));
    normalize(tree);
    expect(textContent(tree)).toBe("10 km");
  });

  it("removes soft hyphens and reports it", () => {
    const tree = root(para(text("hy­phen")));
    const { diagnostics } = normalize(tree);
    expect(textContent(tree)).toBe("hyphen");
    expect(diagnostics.all().some((d) => d.code === "MF-NORM-0003")).toBe(true);
  });

  it("NFC-normalises so equivalent sequences compare equal", () => {
    const a = root(para(text("é")));
    const b = root(para(text("é")));
    normalize(a);
    normalize(b);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("turns empty paragraphs into spacing evidence on the next block", () => {
    const target = para(text("real content"));
    const tree = root(para(text("  ")), para(text("")), target);
    assignIds(tree);
    const sidecar: Record<string, StyleEvidence> = {};
    const { diagnostics } = normalize(tree, sidecar);

    expect(tree.children).toHaveLength(1);
    const survivor = (tree.children as AnyNode[])[0]!;
    expect(sidecar[survivor.id as string]?.spacingBeforePt).toBe(24);
    const diag = diagnostics.all().find((d) => d.code === "MF-NORM-0001");
    expect(diag).toBeDefined();
    // The estimate is marked as an estimate rather than presented as measurement.
    expect(diag!.data?.["estimated"]).toBe(true);
  });

  it("trims block edges without touching interior spacing", () => {
    const tree = root(para(text("  hello world  ")));
    normalize(tree);
    expect(textContent(tree)).toBe("hello world");
  });

  it("keeps hard breaks as breaks", () => {
    const tree = root(para(text("a"), { type: "break" }, text("b")));
    normalize(tree);
    const kids = (tree.children as AnyNode[])[0]!.children as AnyNode[];
    expect(kids.map((k) => k.type)).toEqual(["text", "break", "text"]);
  });
});

describe("normalize idempotency (brief §3.5)", () => {
  // Arbitrary inline content, biased toward the shapes that stress the merge rules:
  // adjacent texts, nested identical marks, whitespace runs, and combining marks.
  const inline = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      fc.record({ type: fc.constant("text"), value: fc.string({ maxLength: 8 }) }),
      fc.constant({ type: "break" }),
      fc.record({
        type: fc.constantFrom("emphasis", "strong", "delete", "underline"),
        children: fc.array(tie("node"), { maxLength: 3 }),
      }),
    ),
  })).node as fc.Arbitrary<AnyNode>;

  const block = fc.oneof(
    fc.record({ type: fc.constant("paragraph"), children: fc.array(inline, { maxLength: 5 }) }),
    fc.record({
      type: fc.constant("heading"),
      depth: fc.integer({ min: 1, max: 6 }),
      resolvedLevel: fc.integer({ min: 1, max: 6 }),
      children: fc.array(inline, { maxLength: 4 }),
    }),
    fc.record({ type: fc.constant("code"), value: fc.string({ maxLength: 12 }) }),
  ) as fc.Arbitrary<AnyNode>;

  const document = fc.record({
    type: fc.constant("root"),
    children: fc.array(block, { maxLength: 6 }),
  }) as fc.Arbitrary<AnyNode>;

  it("normalize(normalize(x)) === normalize(x)", () => {
    fc.assert(
      fc.property(document, (tree) => {
        const once = structuredClone(tree);
        normalize(once);
        const twice = structuredClone(once);
        normalize(twice);
        expect(canonicalJson(twice)).toBe(canonicalJson(once));
      }),
      { numRuns: 500 },
    );
  });

  it("normalisation preserves visible text up to whitespace collapsing", () => {
    fc.assert(
      fc.property(document, (tree) => {
        const before = textContent(tree).replace(/\s+/g, " ").trim();
        const copy = structuredClone(tree);
        normalize(copy);
        const after = textContent(copy).replace(/\s+/g, " ").trim();
        expect(after).toBe(before);
      }),
      { numRuns: 300 },
    );
  });
});
