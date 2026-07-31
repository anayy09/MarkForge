import { describe, it, expect } from "vitest";
import { renderDocx } from "../src/index.js";
import { parseDocx } from "@markforge/adapters-docx";
import { parseMarkdown } from "@markforge/adapters-md";
import { renderMarkdown } from "@markforge/render-md";
import { inferAll } from "@markforge/infer";
import { selectType, textContent, type AnyNode } from "@markforge/ir";
import { OpcPackage, Part, descendantsNamed, attr, childrenNamed } from "@markforge/ooxml";

/**
 * Regressions for three defects that made MarkForge score *worse than Pandoc* on the
 * structural fidelity metric, all of them in our own DOCX writer.
 *
 * They shared a cause worth naming: the fidelity metric was reported as an aggregate,
 * and an aggregate cannot say *which node types* differ. Diffing the node-type census
 * against ground truth found all three in minutes after weeks of them being invisible.
 * Each test below asserts the specific shape, not a score.
 */

/** md -> docx -> md, the loop where all three defects showed up. */
function roundTrip(markdown: string): { ir: ReturnType<typeof parseMarkdown>["document"]; md: string } {
  const truth = parseMarkdown(markdown).document;
  const bytes = renderDocx(truth, { onMissingStyle: "synthesize" }).bytes;
  const back = parseDocx(bytes).document;
  inferAll(back);
  return { ir: back, md: renderMarkdown(back).markdown };
}

/** The nesting shape of every list in a tree, as `depth:kind` strings. */
function listShape(root: AnyNode): string[] {
  const out: string[] = [];
  const walk = (n: AnyNode, depth: number): void => {
    if (n.type === "list") out.push(`${depth}:${n["ordered"] === true ? "ol" : "ul"}`);
    for (const c of (n.children as AnyNode[] | undefined) ?? []) {
      walk(c, n.type === "list" ? depth + 1 : depth);
    }
  };
  walk(root, 0);
  return out;
}

describe("nested lists survive the DOCX round trip", () => {
  // The writer allocated a numbering id per nesting *level*, so a reader grouping
  // paragraphs by numbering id — the only thing it can group by — saw a separate list
  // at every depth. Three nested bullet lists became five flat one-item lists.
  it("keeps three levels of bullet nesting", () => {
    const source = "- top\n  - second\n    - third\n  - back to second\n- top again\n";
    const before = listShape(parseMarkdown(source).document.body as unknown as AnyNode);
    const after = listShape(roundTrip(source).ir.body as unknown as AnyNode);
    expect(after).toEqual(before);
    expect(after).toEqual(["0:ul", "1:ul", "2:ul"]);
  });

  it("keeps item counts rather than splitting one list into many", () => {
    const source = "- one\n- two\n- three\n";
    const lists = selectType(roundTrip(source).ir.body, "list");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
  });

  // A bullet list inside a numbered list cannot share the parent's numbering
  // definition: one definition describes one sequence of level formats, so the nested
  // level would render with the parent's ordered marker. Pandoc gets this wrong too,
  // which is why matching Pandoc was not a good enough target.
  it("keeps a bullet list nested inside a numbered list, without splitting the parent", () => {
    const source = "1. ordered parent\n   - unordered child\n   - another child\n2. second parent\n";
    const after = roundTrip(source).ir;
    const lists = selectType(after.body, "list");
    const outer = lists.find((l) => l["ordered"] === true);
    expect(outer, "the ordered parent must survive as one list").toBeDefined();
    expect(outer!.children, "both parent items belong to the same list").toHaveLength(2);
    expect(listShape(after.body as unknown as AnyNode)).toEqual(["0:ol", "1:ul"]);
  });

  it("preserves a list that starts at seven", () => {
    const lists = selectType(roundTrip("7. seven\n8. eight\n").ir.body, "list");
    expect(lists[0]!["start"]).toBe(7);
  });

  it("writes one numbering definition per list tree, not per level", () => {
    const truth = parseMarkdown("- a\n  - b\n    - c\n").document;
    const pkg = OpcPackage.open(renderDocx(truth, { onMissingStyle: "synthesize" }).bytes);
    const numbering = pkg.xml(Part.NUMBERING)!;
    // Three levels, one definition. Three definitions is the bug.
    expect(childrenNamed(numbering, "num")).toHaveLength(1);
    const levels = descendantsNamed(pkg.xml(Part.DOCUMENT)!, "ilvl").map((e) => attr(e, "val"));
    expect(levels).toEqual(["0", "1", "2"]);
  });
});

describe("links keep their URL", () => {
  // The writer emitted the label underlined followed by "(url)" in body text, on the
  // reasoning that visible beats dropped. It was worse than dropped: the link type was
  // destroyed and the address became prose a reader has to untangle.
  it("writes a real hyperlink relationship, not the URL as prose", () => {
    const truth = parseMarkdown("See [the docs](https://example.com/guide) for more.\n").document;
    const pkg = OpcPackage.open(renderDocx(truth, { onMissingStyle: "synthesize" }).bytes);

    const document = pkg.xml(Part.DOCUMENT)!;
    expect(descendantsNamed(document, "hyperlink"), "a w:hyperlink element must exist").toHaveLength(1);

    const rels = pkg.text(Part.DOCUMENT_RELS) ?? "";
    expect(rels).toContain("https://example.com/guide");
    expect(rels).toContain('TargetMode="External"');
  });

  it("round-trips a link as a link, with its URL intact", () => {
    const { ir } = roundTrip("See [the docs](https://example.com/guide) for more.\n");
    const links = selectType(ir.body, "link");
    expect(links).toHaveLength(1);
    expect(links[0]!["url"]).toBe("https://example.com/guide");
    // The URL must not also appear as visible text.
    expect(textContent(ir.body)).not.toContain("https://example.com/guide");
    // And no invented underline where the link was.
    expect(selectType(ir.body, "underline")).toHaveLength(0);
  });

  it("reuses one relationship for a repeated URL", () => {
    const truth = parseMarkdown("[a](https://example.com) and [b](https://example.com)\n").document;
    const rels = OpcPackage.open(renderDocx(truth, { onMissingStyle: "synthesize" }).bytes)
      .text(Part.DOCUMENT_RELS) ?? "";
    expect((rels.match(/https:\/\/example\.com/g) ?? [])).toHaveLength(1);
  });

  it("does not collide with the styles and numbering relationship ids", () => {
    const truth = parseMarkdown("[a](https://example.com)\n").document;
    const rels = OpcPackage.open(renderDocx(truth, { onMissingStyle: "synthesize" }).bytes)
      .text(Part.DOCUMENT_RELS) ?? "";
    const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]);
    // A duplicate id produces a file Word refuses to open, with a generic error.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("rId1");
    expect(ids).toContain("rId2");
    expect(ids).toContain("rId3");
  });
});

describe("table cells do not accumulate wrapper paragraphs", () => {
  // Markdown cells hold phrasing content; a DOCX cell holds a paragraph. Both are
  // schema-legal, and leaving both in circulation meant a round trip returned a
  // structurally different document: one fixture gained sixteen nodes, one per cell.
  // Normalisation rule 7 now picks the flatter shape as canonical.
  it("returns a simple cell to phrasing content", () => {
    const source = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const cells = selectType(roundTrip(source).ir.body, "tableCell");
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      const kids = (cell.children as AnyNode[] | undefined) ?? [];
      expect(kids.some((k) => k.type === "paragraph"), "no wrapper paragraph").toBe(false);
    }
  });

  it("round-trips a table to the same node count as its source", () => {
    const source = "| h1 | h2 |\n| - | - |\n| a | b |\n| c | d |\n";
    const count = (doc: AnyNode): number => {
      let n = 0;
      const walk = (x: AnyNode): void => {
        n++;
        for (const c of (x.children as AnyNode[] | undefined) ?? []) walk(c);
      };
      walk(doc);
      return n;
    };
    const before = count(parseMarkdown(source).document.body as unknown as AnyNode);
    const after = count(roundTrip(source).ir.body as unknown as AnyNode);
    expect(after).toBe(before);
  });

  it("keeps real block structure in a cell that has some", () => {
    // Two paragraphs in one cell is genuine structure, not a wrapper, so unwrapping
    // must not touch it.
    const html = "<table><tr><td><p>one</p><p>two</p></td></tr></table>";
    const bytes = renderDocx(
      // Build the IR directly: Markdown cannot express a two-paragraph cell.
      (() => {
        const doc = parseMarkdown("| x |\n| - |\n| y |\n").document;
        const cell = selectType(doc.body, "tableCell")[1] ?? selectType(doc.body, "tableCell")[0]!;
        cell.children = [
          { type: "paragraph", children: [{ type: "text", value: "one" }] },
          { type: "paragraph", children: [{ type: "text", value: "two" }] },
        ] as never;
        return doc;
      })(),
      { onMissingStyle: "synthesize" },
    ).bytes;
    void html;
    const back = parseDocx(bytes).document;
    const multi = selectType(back.body, "tableCell").find(
      (c) => ((c.children as AnyNode[] | undefined) ?? []).filter((k) => k.type === "paragraph").length === 2,
    );
    expect(multi, "a two-paragraph cell keeps both paragraphs").toBeDefined();
  });
});

describe("the round trip is shape-preserving on the whole corpus", () => {
  // The aggregate guard. Each fixture's node-type census must survive md -> docx -> md
  // exactly; a difference of even one node means a construct changed shape, which is
  // what all three defects above looked like before anyone diffed the census.
  const SOURCES: [string, string][] = [
    ["headings and body", "# One\n\n## Two\n\nBody text.\n"],
    ["ordered list", "1. a\n2. b\n3. c\n"],
    ["nested bullets", "- a\n  - b\n    - c\n"],
    ["mixed nesting", "1. a\n   - x\n   - y\n2. b\n"],
    ["table", "| a | b |\n| - | - |\n| 1 | 2 |\n"],
    ["inline marks", "Text with **bold**, _italic_, and `code`.\n"],
    ["link", "A [link](https://example.com) inline.\n"],
    ["blockquote", "> quoted\n"],
  ];

  const census = (root: AnyNode): Record<string, number> => {
    const counts: Record<string, number> = {};
    const walk = (n: AnyNode): void => {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      for (const c of (n.children as AnyNode[] | undefined) ?? []) walk(c);
    };
    walk(root);
    return counts;
  };

  it.each(SOURCES)("%s keeps its node-type census", (_name, source) => {
    const before = census(parseMarkdown(source).document.body as unknown as AnyNode);
    const after = census(roundTrip(source).ir.body as unknown as AnyNode);
    expect(after).toEqual(before);
  });
});
