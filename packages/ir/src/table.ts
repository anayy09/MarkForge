/**
 * Table cell construction, in one place.
 *
 * The IR schema **requires** `rowSpan`, `colSpan`, and `isHeader` on every
 * `tableCell` — always present, not only when they differ from the default. That is
 * the right call and it is worth stating why: a consumer reading `cell.colSpan`
 * should never have to write `?? 1`, because the version that forgets the fallback
 * works on every test document and breaks on the first merged cell.
 *
 * Four adapters and three renderers touch table cells. Every one of them had this
 * wrong — each omitted the fields when they were 1, and every table they produced
 * failed schema validation. Nothing caught it because the schema-validation tests
 * all happened to use documents without tables. So the construction lives here now,
 * and the defaults are supplied once rather than seven times.
 */
import type { AnyNode } from "./traverse.js";

export interface TableCellOptions {
  rowSpan?: number | undefined;
  colSpan?: number | undefined;
  isHeader?: boolean | undefined;
  widthPt?: number | undefined;
}

/** A schema-valid `tableCell`, with the required span fields always present. */
export function tableCell(children: AnyNode[], options: TableCellOptions = {}): AnyNode {
  return {
    type: "tableCell",
    rowSpan: options.rowSpan ?? 1,
    colSpan: options.colSpan ?? 1,
    isHeader: options.isHeader ?? false,
    // OOXML requires at least one paragraph per cell, and a cell that renders to
    // nothing makes the file unopenable rather than merely empty. Supplying the
    // empty paragraph here means no renderer has to remember to.
    children: children.length > 0 ? children : [{ type: "paragraph", children: [] }],
  };
}

export function tableRow(cells: AnyNode[]): AnyNode {
  return { type: "tableRow", children: cells };
}

export interface TableOptions {
  /** Number of leading rows that are header rows. The schema calls this
   * `headerRowCount`; `headerRows` is not a field and silently does nothing. */
  headerRowCount?: number | undefined;
  headerColCount?: number | undefined;
  align?: ("left" | "center" | "right" | null)[] | undefined;
}

export function table(rows: AnyNode[], options: TableOptions = {}): AnyNode {
  const node: AnyNode = { type: "table", children: rows };
  if (options.headerRowCount !== undefined && options.headerRowCount > 0) {
    node["headerRowCount"] = options.headerRowCount;
  }
  if (options.headerColCount !== undefined && options.headerColCount > 0) {
    node["headerColCount"] = options.headerColCount;
  }
  if (options.align !== undefined) node["align"] = options.align;
  return node;
}

/** Reads a cell's span, tolerating documents built before the fields were required. */
export function cellSpan(cell: AnyNode): { rowSpan: number; colSpan: number; isHeader: boolean } {
  return {
    rowSpan: typeof cell["rowSpan"] === "number" ? cell["rowSpan"] : 1,
    colSpan: typeof cell["colSpan"] === "number" ? cell["colSpan"] : 1,
    isHeader: cell["isHeader"] === true,
  };
}

/** Reads a table's header row count. */
export function headerRowCount(node: AnyNode): number {
  return typeof node["headerRowCount"] === "number" ? node["headerRowCount"] : 0;
}
