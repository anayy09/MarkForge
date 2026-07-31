/**
 * Merged table cells in the DOCX writer.
 *
 * A vertical merge in OOXML is not one tall `w:tc`. It is a `w:vMerge w:val="restart"`
 * anchor plus a `w:tc` carrying a bare `w:vMerge` in *every* row it covers. The IR
 * stores the merge as a `rowSpan` on the anchor and has no cell at the covered
 * positions, so those continuation cells must be synthesized — and until they were,
 * Word saw a short row and no merge, which silently dropped `rowSpan` on every
 * `docx -> md -> docx` round trip.
 */
import { describe, it, expect } from "vitest";
import { renderDocx } from "../src/index.js";
import { parseDocx } from "@markforge/adapters-docx";
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

describe("merged cells in the DOCX writer", () => {
  it("writes w:vMerge continuation cells so a vertical merge exists in the DOCX", () => {
    const { bytes } = renderDocx(mergedTableDocument(), { onMissingStyle: "synthesize" });
    const after = cellsOf(parseDocx(bytes).document);

    expect(after).toEqual(cellsOf(mergedTableDocument()));
  });

  it("declares a w:tblGrid wide enough for a row that is entirely one wide cell", () => {
    // Column count came from the largest *cell count* per row, so a table whose widest
    // row is a single colSpan=3 cell declared one column and skewed in Word.
    const doc = emptyDocument();
    doc.body = {
      type: "root",
      children: [
        table(
          [
            tableRow([
              { ...tableCell([{ type: "text", value: "Wide" } as never]), colSpan: 3 } as never,
            ]),
          ] as never,
          { headerRowCount: 0 },
        ),
      ],
    } as never;

    const { bytes } = renderDocx(doc, { onMissingStyle: "synthesize" });
    const after = cellsOf(parseDocx(bytes).document);
    expect(after).toEqual([{ rowSpan: 1, colSpan: 3, isHeader: false, text: "Wide" }]);
  });
});
