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
    expect(sidecar[survivor.id as string]?.paragraph?.spaceBeforePt).toBe(24);
    const diag = diagnostics.all().find((d) => d.code === "MF-NORM-0001");
    expect(diag).toBeDefined();
    // The estimate is described as an estimate rather than presented as measurement.
    expect(diag!.message).toMatch(/estimate/i);
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

  // A fixed seed, deliberately.
  //
  // fast-check defaults to a random seed per run, which is excellent at finding bugs
  // and terrible at keeping them found: seed 1458972494 caught normalize being
  // non-idempotent on `["! ", " ", "!"]`, and it caught it on CI rather than locally
  // purely by luck. A pinned seed makes the suite reproducible — the same 500 cases on
  // every machine, so a failure is a failure everywhere and a pass means something.
  //
  // The cost is that a pinned seed explores less over time. That is paid back by
  // raising numRuns and by adding each counterexample as a named case below, which is
  // what actually keeps a fixed bug fixed. To hunt for new ones, run with
  // `--fc-seed` locally or temporarily drop the seed.
  const SEED = 20260731;

  const document = fc.record({
    type: fc.constant("root"),
    children: fc.array(block, { maxLength: 6 }),
  }) as fc.Arbitrary<AnyNode>;

  // Seed 1458972494's counterexample, kept by name. Collapsing ran once per text node
  // *before* the merge, so each node held a single space and collapsed to itself; the
  // merge then produced a two-space run across the old boundary that nothing revisited.
  it("collapses whitespace created by merging adjacent text nodes", () => {
    const tree: AnyNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "! " },
            { type: "text", value: " " },
            { type: "text", value: "!" },
          ],
        },
      ],
    } as AnyNode;
    normalize(tree);
    expect(canonicalJson(tree)).toContain('"value":"! !"');

    const again = structuredClone(tree);
    normalize(again);
    expect(canonicalJson(again)).toBe(canonicalJson(tree));
  });

  it("normalize(normalize(x)) === normalize(x)", () => {
    fc.assert(
      fc.property(document, (tree) => {
        const once = structuredClone(tree);
        normalize(once);
        const twice = structuredClone(once);
        normalize(twice);
        expect(canonicalJson(twice)).toBe(canonicalJson(once));
      }),
      { numRuns: 500, seed: SEED },
    );
  });

  // Stated per block, not per document. Rule 3 trims at *block boundaries*, so
  // concatenating every block's text into one string and comparing that is not the
  // invariant — a heading of " !" followed by a heading of "!" legitimately becomes
  // "!" and "!", and the naive whole-document comparison reads that as "! !" losing
  // a space. The first version of this test made exactly that mistake and failed on
  // correct behaviour.
  it("preserves each block's visible text up to whitespace collapsing and edge trimming", () => {
    const blockTexts = (tree: AnyNode): string[] =>
      (tree.children as AnyNode[]).map((b) => textContent(b).replace(/\s+/g, " ").trim());

    fc.assert(
      fc.property(document, (tree) => {
        const before = blockTexts(tree);
        const copy = structuredClone(tree);
        normalize(copy);
        // Empty paragraphs are deliberately removed (rule 1), so compare only the
        // blocks that carried visible text in the first place.
        expect(blockTexts(copy).filter((t) => t !== "")).toEqual(before.filter((t) => t !== ""));
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("never invents or drops non-whitespace characters", () => {
    fc.assert(
      fc.property(document, (tree) => {
        const strip = (n: AnyNode): string => textContent(n).replace(/\s+/g, "");
        const before = strip(tree);
        const copy = structuredClone(tree);
        normalize(copy);
        expect(strip(copy)).toBe(before);
      }),
      { numRuns: 300, seed: SEED },
    );
  });
});
