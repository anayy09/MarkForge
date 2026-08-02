/**
 * A node that reports a loss must not stop the walk.
 *
 * ## The rule, and the defect that produced it
 *
 * This is adapter rule A6 applied to a renderer: when a construct has no Typst mapping, the
 * *semantics* are declared lost and the *text* still survives. The order matters and it is
 * the whole subject of this file — **report, then walk.**
 *
 * The first version walked first and reported only childless nodes, so a `textBox` with an
 * empty `children` array was walked into nothing and reported nothing: silently deleted. That
 * was caught by `check-pdf-determinism.mjs`'s own negative control on its first run, which is
 * luck rather than coverage — the control happened to use `textBox`, and nothing generalised
 * it.
 *
 * ## Why these cases are not reachable from the gates
 *
 * `check-pdf-determinism.mjs` asserts that a construct with no mapping *is reported*, on one
 * probe node. It cannot see whether the walk continued afterwards, because a document that
 * lost its second half still compiles and still produces stable bytes. The `md->pdf->md`
 * fidelity loop scores what survives, but it scores it as a *number*: a paragraph vanishing
 * after an image moves structural fidelity by a couple of points, which is indistinguishable
 * from the ordinary noise of that loop and would never be read as "traversal aborted".
 *
 * Both math paths and `image` report as of 2026-08-02, which gives this file three real
 * reporting nodes to test with rather than a synthetic one.
 */
import { describe, it, expect } from "vitest";
import { toTypst, renderPdf } from "../src/index.js";
import type { AnyNode, MarkForgeDocument } from "@markforge/ir";

const fromNodes = (...children: AnyNode[]): MarkForgeDocument =>
  ({ body: { type: "root", children } }) as unknown as MarkForgeDocument;

const text = (value: string): AnyNode => ({ type: "text", value }) as unknown as AnyNode;
const para = (...kids: AnyNode[]): AnyNode =>
  ({ type: "paragraph", children: kids }) as unknown as AnyNode;

const lostTypes = (doc: MarkForgeDocument): string[] => toTypst(doc).lost.map((l) => l.type);
const sourceOf = (doc: MarkForgeDocument): string => toTypst(doc).source;

/** The three shipped reporters, each with the payload it should still emit. */
const REPORTERS: { name: string; node: AnyNode; type: string }[] = [
  {
    name: "image",
    type: "image",
    node: { type: "image", url: "x.png", alt: "ALTTEXT" } as unknown as AnyNode,
  },
  {
    name: "inlineMath",
    type: "inlineMath",
    node: { type: "inlineMath", value: "t_{ack}" } as unknown as AnyNode,
  },
  {
    name: "math",
    type: "math",
    node: { type: "math", value: "\\max(a,b)" } as unknown as AnyNode,
  },
];

describe("report-then-walk: a reported loss does not abort the document", () => {
  for (const { name, node, type } of REPORTERS) {
    it(`${name} reports, and the sibling *after* it still emits`, () => {
      const doc = fromNodes(
        para(text("BEFORE")),
        // `math` is block content; the other two are phrasing. Wrapping in a paragraph is
        // harmless for both and keeps one shape across the three.
        type === "math" ? node : para(node),
        para(text("AFTER")),
      );
      const { source, lost } = toTypst(doc);
      expect(lost.map((l) => l.type)).toContain(type);
      // The assertion that matters: the walk did not stop at the loss.
      expect(source).toContain("BEFORE");
      expect(source).toContain("AFTER");
    });

    it(`${name} reports once per occurrence, not once per document`, () => {
      // A reporter that deduplicated by type would hide how much was lost, and the run
      // report counts diagnostics rather than distinct constructs.
      const doc = fromNodes(type === "math" ? node : para(node), type === "math" ? node : para(node));
      expect(lostTypes(doc).filter((t) => t === type)).toHaveLength(2);
    });
  }

  it("an image still emits its alt text, so the words survive even though the figure does not", () => {
    const doc = fromNodes(para({ type: "image", url: "x.png", alt: "ALTTEXT" } as unknown as AnyNode));
    const { source, lost } = toTypst(doc);
    expect(lost.map((l) => l.type)).toContain("image");
    expect(source).toContain("ALTTEXT");
  });

  it("a reported inline loss does not swallow its own paragraph's other text", () => {
    // The narrower version of the sibling case: the loss is mid-sentence, not mid-document.
    const doc = fromNodes(
      para(
        text("before "),
        { type: "inlineMath", value: "x_{i}" } as unknown as AnyNode,
        text(" after"),
      ),
    );
    const source = sourceOf(doc);
    expect(source).toContain("before");
    expect(source).toContain("after");
  });

  it("two different reporters in one document both report; neither masks the other", () => {
    const doc = fromNodes(
      para({ type: "image", url: "a.png", alt: "A" } as unknown as AnyNode),
      { type: "math", value: "\\int x" } as unknown as AnyNode,
      para(text("TAIL")),
    );
    const { source, lost } = toTypst(doc);
    expect(lost.map((l) => l.type).sort()).toEqual(["image", "math"]);
    expect(source).toContain("TAIL");
  });
});

describe("report-then-walk: the unmapped-node default", () => {
  const unknown = (children: AnyNode[] | undefined): AnyNode =>
    ({ type: "somethingTypstCannotDo", ...(children ? { children } : {}) }) as unknown as AnyNode;

  it("reports the loss and still emits the children", () => {
    const doc = fromNodes(unknown([para(text("CHILDTEXT"))]));
    const { source, lost } = toTypst(doc);
    expect(lost.map((l) => l.type)).toContain("somethingTypstCannotDo");
    // Report *then* walk: the construct's semantics are declared lost and its text survives.
    expect(source).toContain("CHILDTEXT");
  });

  it("reports a node with an EMPTY children array — the textBox defect", () => {
    // The original ordering walked first and reported only what produced nothing, so a node
    // with `children: []` was walked into an empty string and never reported. It looked
    // identical to a node that legitimately rendered nothing.
    const doc = fromNodes(unknown([]));
    expect(lostTypes(doc)).toContain("somethingTypstCannotDo");
  });

  it("reports a node with NO children property at all", () => {
    const doc = fromNodes(unknown(undefined));
    expect(lostTypes(doc)).toContain("somethingTypstCannotDo");
  });

  it("does not abort the document: siblings on both sides of an unmapped node emit", () => {
    const doc = fromNodes(
      para(text("HEAD")),
      unknown([para(text("MIDDLE"))]),
      para(text("TAIL")),
    );
    const source = sourceOf(doc);
    for (const marker of ["HEAD", "MIDDLE", "TAIL"]) expect(source).toContain(marker);
  });

  it("reports a nested unmapped node inside another unmapped node", () => {
    // A walk that reported only at the top level would lose the inner construct silently
    // while appearing to honour the rule.
    const doc = fromNodes(unknown([unknown([para(text("DEEP"))])]));
    const { source, lost } = toTypst(doc);
    expect(lost.filter((l) => l.type === "somethingTypstCannotDo")).toHaveLength(2);
    expect(source).toContain("DEEP");
  });
});

describe("report-then-walk: losses reach the caller as diagnostics", () => {
  it("renderPdf turns every reported loss into a degraded diagnostic", async () => {
    // `toTypst` collects; `renderPdf` is what a surface actually calls. A loss recorded and
    // never surfaced would satisfy every test above and still be invisible to `--strict`.
    const doc = fromNodes(
      para({ type: "image", url: "a.png", alt: "A" } as unknown as AnyNode),
      { type: "math", value: "\\int x" } as unknown as AnyNode,
    );
    const result = await renderPdf(doc, {
      compile: () => new Uint8Array([1]),
      // Non-empty so the "no profile fonts" info diagnostic does not join the count.
      fonts: [{ family: "f", bytes: new Uint8Array() }],
    });
    const all = result.diagnostics.all();
    const degraded = all.filter((d) => d.severity === "warning" && d.lossy);
    expect(degraded).toHaveLength(2);
    // The construct is carried in `construct`, not in the prose. Asserting the message here
    // would have passed on a diagnostic that named the wrong node.
    expect(degraded.map((d) => d.construct).sort()).toEqual(["image", "math"]);
  });

  it("a clean document reports nothing, so the diagnostic path is not always-on", () => {
    const doc = fromNodes(para(text("ordinary prose")));
    expect(toTypst(doc).lost).toHaveLength(0);
  });
});
