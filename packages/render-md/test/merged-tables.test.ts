/**
 * Merged table cells across the Markdown boundary.
 *
 * GFM pipe syntax has no `rowspan`/`colspan`. Writing a merged table as pipes does not
 * merely lose the merge: covered grid positions come back as *empty cells*, so a
 * 6-cell table becomes 8 cells with only 3 on their original coordinates — measured
 * at 42.9% table cell F1 on `fixtures/docx/messy-combined.docx`, and for a long while
 * it happened with no diagnostic at all.
 *
 * These tests pin both halves of the fix: the default HTML path is lossless, and the
 * `gfm` path says what it broke. The DOCX writer's half — synthesizing the `w:vMerge`
 * continuation cells OOXML needs — is pinned in
 * `packages/render-docx/test/merged-tables.test.ts`, which is where that dependency
 * already exists.
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/index.js";
import { parseMarkdown } from "@markforge/adapters-md";
import { emptyDocument, table, tableRow, tableCell, type MarkForgeDocument } from "@markforge/ir";

/** A 2-column table with one horizontal and one vertical merge. */
function mergedTableDocument(): MarkForgeDocument {
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({
    ...tableCell([{ type: "text", value: text } as never]),
    ...extra,
  });
  const doc = emptyDocument();
  doc.body = {
    type: "root",
    children: [
      table(
        [
          tableRow([cell("Merged header", { colSpan: 2, isHeader: true })]),
          tableRow([cell("Metric"), cell("Value")]),
          tableRow([cell("Spans two rows", { rowSpan: 2 }), cell("first")]),
          tableRow([cell("second")]),
        ] as never,
        { headerRowCount: 1 },
      ),
    ],
  } as never;
  return doc;
}

interface CellShape {
  rowSpan: number;
  colSpan: number;
  isHeader: boolean;
  text: string;
}

function cellsOf(doc: MarkForgeDocument): CellShape[] {
  const out: CellShape[] = [];
  const textOf = (n: Record<string, unknown>): string =>
    n["type"] === "text"
      ? String(n["value"] ?? "")
      : ((n["children"] as Record<string, unknown>[] | undefined) ?? []).map(textOf).join("");
  const walk = (n: Record<string, unknown>): void => {
    if (n["type"] === "tableCell") {
      out.push({
        rowSpan: Number(n["rowSpan"] ?? 1),
        colSpan: Number(n["colSpan"] ?? 1),
        isHeader: Boolean(n["isHeader"]),
        text: textOf(n),
      });
    }
    for (const c of ((n["children"] as Record<string, unknown>[] | undefined) ?? [])) walk(c);
  };
  walk(doc.body as unknown as Record<string, unknown>);
  return out;
}

describe("merged cells and the Markdown boundary", () => {
  it("writes a merged table as HTML by default, keeping both spans", () => {
    const { markdown, diagnostics } = renderMarkdown(mergedTableDocument());

    expect(markdown).toContain("<table>");
    expect(markdown).toContain('colspan="2"');
    expect(markdown).toContain('rowspan="2"');
    // Not pipe syntax: a pipe table here would be the silent loss.
    expect(markdown).not.toContain("| Metric |");

    const codes = diagnostics.all().map((d) => d.code);
    expect(codes).toContain("MF-RENDER-0007");
    // Nothing was lost, so nothing is reported as lossy.
    expect(diagnostics.lossy()).toHaveLength(0);
  });

  it("round-trips a merged table through Markdown with every span intact", () => {
    const before = cellsOf(mergedTableDocument());
    const { markdown } = renderMarkdown(mergedTableDocument());
    const after = cellsOf(parseMarkdown(markdown).document);

    expect(after).toEqual(before);
  });

  it("keeps pipe syntax for a table with no merges, so readability is not taxed", () => {
    const doc = emptyDocument();
    doc.body = {
      type: "root",
      children: [
        table(
          [
            tableRow([
              tableCell([{ type: "text", value: "A" } as never]),
              tableCell([{ type: "text", value: "B" } as never]),
            ]),
            tableRow([
              tableCell([{ type: "text", value: "1" } as never]),
              tableCell([{ type: "text", value: "2" } as never]),
            ]),
          ] as never,
          { headerRowCount: 1 },
        ),
      ],
    } as never;

    const { markdown, diagnostics } = renderMarkdown(doc);
    expect(markdown).toContain("| A ");
    expect(markdown).not.toContain("<table>");
    expect(diagnostics.all()).toHaveLength(0);
  });

  it('reports the damage when tables: "gfm" forces pipe syntax', () => {
    const { markdown, diagnostics } = renderMarkdown(mergedTableDocument(), { tables: "gfm" });

    expect(markdown).toContain("| Metric ");
    const flattened = diagnostics.all().filter((d) => d.code === "MF-RENDER-0006");
    expect(flattened).toHaveLength(1);
    expect(flattened[0]!.message).toContain("2 merged cell(s)");
    // Explicitly lossy: `--strict` must be able to fail on this.
    expect(diagnostics.lossy().length).toBeGreaterThan(0);
  });
});

describe("embedded HTML blocks in Markdown", () => {
  it("reads an HTML table as structure rather than as an opaque string", () => {
    const md = "<table><tr><td rowspan=\"2\">a</td><td>b</td></tr><tr><td>c</td></tr></table>\n";
    const { document, diagnostics } = parseMarkdown(md);

    expect(cellsOf(document)).toEqual([
      { rowSpan: 2, colSpan: 1, isHeader: false, text: "a" },
      { rowSpan: 1, colSpan: 1, isHeader: false, text: "b" },
      { rowSpan: 1, colSpan: 1, isHeader: false, text: "c" },
    ]);
    expect(diagnostics.all().map((d) => d.code)).toContain("MF-MD-0013");
  });

  it("leaves an HTML comment alone, because that is how unknown nodes round-trip", () => {
    const md = "<!-- markforge:unknown thing -->\n";
    const { document } = parseMarkdown(md);
    const types = new Set<string>();
    const walk = (n: Record<string, unknown>): void => {
      types.add(String(n["type"]));
      for (const c of ((n["children"] as Record<string, unknown>[] | undefined) ?? [])) walk(c);
    };
    walk(document.body as unknown as Record<string, unknown>);
    expect(types).toContain("html");
    expect(types).not.toContain("table");
  });

  it("leaves an unbalanced HTML block alone rather than swallowing the document", () => {
    // A CommonMark HTML block ends at a blank line, so this reaches mdast as three
    // nodes. Parsing the opening fragment would pull the following content inside it.
    const md = "<blockquote>\n\nA paragraph outside the fragment.\n\n</blockquote>\n";
    const { document } = parseMarkdown(md);
    const kids = (document.body as unknown as { children: { type: string }[] }).children;

    expect(kids.map((k) => k.type)).toEqual(["html", "paragraph", "html"]);
  });

  it("does not recover a div, which carries nothing worth recovering", () => {
    const { document } = parseMarkdown("<div><p>text</p></div>\n");
    const kids = (document.body as unknown as { children: { type: string }[] }).children;
    expect(kids.map((k) => k.type)).toEqual(["html"]);
  });
});
