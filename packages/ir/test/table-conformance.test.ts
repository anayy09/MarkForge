import { describe, it, expect } from "vitest";
import {
  assignIds,
  emptyDocument,
  validateDocument,
  tableCell,
  tableRow,
  table,
  cellSpan,
  headerRowCount,
  type AnyNode,
  type MarkForgeDocument,
} from "../src/index.js";

/**
 * These tests exist because of a specific gap.
 *
 * Four adapters and three renderers built table cells, and every one of them
 * produced a cell that failed schema validation: `rowSpan`, `colSpan`, and
 * `isHeader` are *required* by the schema, and each adapter omitted them when they
 * equalled 1. Nothing caught it for two phases, because every
 * "produces-a-document-that-validates" test happened to use a document without a
 * table.
 *
 * So the fix is not only the helper — it is validating a table on purpose.
 */
function validate(child: AnyNode): { valid: boolean; errors: { path: string; message: string }[] } {
  const doc = emptyDocument();
  const body: AnyNode = { type: "root", children: [child] };
  assignIds(body);
  doc.body = body as unknown as MarkForgeDocument["body"];
  doc.id = body.id as string;
  const result = validateDocument(doc);
  // Provenance is the adapter's job, not the builder's; these tests are about node shape.
  return { valid: result.valid, errors: result.errors.filter((e) => !e.path.startsWith("/provenance")) };
}

const text = (value: string): AnyNode => ({ type: "text", value });
const para = (value: string): AnyNode => ({ type: "paragraph", children: [text(value)] });

describe("table nodes validate against the schema", () => {
  it("a minimal table validates", () => {
    const t = table([tableRow([tableCell([text("a")])])]);
    expect(validate(t).errors).toEqual([]);
  });

  it("the helper always emits the three required span fields", () => {
    const cell = tableCell([text("x")]);
    // Required by the schema, so present even at their defaults. A consumer reading
    // cell.colSpan should never need `?? 1`, because the version that forgets the
    // fallback works on every unmerged table and breaks on the first merged one.
    expect(cell["rowSpan"]).toBe(1);
    expect(cell["colSpan"]).toBe(1);
    expect(cell["isHeader"]).toBe(false);
  });

  it("a cell omitting the span fields does not validate", () => {
    // The shape every adapter used to produce.
    const bad: AnyNode = {
      type: "table",
      children: [{ type: "tableRow", children: [{ type: "tableCell", children: [text("a")] }] }],
    };
    expect(validate(bad).valid).toBe(false);
  });

  it("merged cells validate", () => {
    const t = table(
      [
        tableRow([tableCell([text("wide")], { colSpan: 3 })]),
        tableRow([tableCell([text("tall")], { rowSpan: 2 }), tableCell([text("b")])]),
      ],
      { headerRowCount: 1 },
    );
    expect(validate(t).errors).toEqual([]);
  });

  // Both shapes occur in real input, so both must validate. Phrasing content is what
  // Markdown and HTML produce for a simple cell; block content is what DOCX and PPTX
  // produce, and docs/CORPUS.md §2.5 lists it as a construct under test.
  it("a cell holding phrasing content validates", () => {
    expect(validate(table([tableRow([tableCell([text("plain")])])])).errors).toEqual([]);
  });

  it("a cell holding block content validates", () => {
    const t = table([tableRow([tableCell([para("one"), para("two")])])]);
    expect(validate(t).errors).toEqual([]);
  });

  it("a cell holding a nested table validates", () => {
    const inner = table([tableRow([tableCell([text("inner")])])]);
    expect(validate(table([tableRow([tableCell([inner])])])).errors).toEqual([]);
  });

  it("a cell holding a list validates", () => {
    const list: AnyNode = {
      type: "list",
      ordered: false,
      spread: false,
      children: [{ type: "listItem", spread: false, children: [para("item")] }],
    };
    expect(validate(table([tableRow([tableCell([list])])])).errors).toEqual([]);
  });

  it("an empty cell gets a paragraph, which OOXML requires", () => {
    // A DOCX cell with no paragraph makes the file unopenable rather than merely
    // empty, so the helper supplies one and no renderer has to remember to.
    const cell = tableCell([]);
    expect((cell.children as AnyNode[])).toHaveLength(1);
    expect((cell.children as AnyNode[])[0]!.type).toBe("paragraph");
    expect(validate(table([tableRow([cell])])).errors).toEqual([]);
  });

  it("uses headerRowCount, the schema's name", () => {
    const t = table([tableRow([tableCell([text("h")])])], { headerRowCount: 1 });
    expect(t["headerRowCount"]).toBe(1);
    // `headerRows` is not a field: it validated as an unevaluated property and every
    // renderer read undefined, so header rows were silently lost.
    expect(t["headerRows"]).toBeUndefined();
    expect(validate(t).errors).toEqual([]);
  });

  it("omits headerRowCount rather than writing zero", () => {
    expect(table([tableRow([tableCell([text("a")])])])["headerRowCount"]).toBeUndefined();
  });

  it("rejects an unknown table property rather than ignoring it", () => {
    const bad = table([tableRow([tableCell([text("a")])])]);
    bad["truncated"] = true;
    // unevaluatedProperties: false is what makes a typo'd field an error instead of
    // a value nobody reads.
    expect(validate(bad).valid).toBe(false);
  });
});

describe("span readers", () => {
  it("reads spans from a well-formed cell", () => {
    expect(cellSpan(tableCell([text("a")], { rowSpan: 2, colSpan: 3, isHeader: true }))).toEqual({
      rowSpan: 2,
      colSpan: 3,
      isHeader: true,
    });
  });

  it("defaults spans for a cell built before the fields were required", () => {
    expect(cellSpan({ type: "tableCell", children: [] })).toEqual({
      rowSpan: 1,
      colSpan: 1,
      isHeader: false,
    });
  });

  it("reads headerRowCount, defaulting to zero", () => {
    expect(headerRowCount({ type: "table", children: [], headerRowCount: 2 })).toBe(2);
    expect(headerRowCount({ type: "table", children: [] })).toBe(0);
  });
});
