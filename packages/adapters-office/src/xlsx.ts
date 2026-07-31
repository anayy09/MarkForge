/**
 * XLSX to IR.
 *
 * A sheet becomes a table. The interesting decisions are all about what a cell
 * *is*:
 *
 *   - **Formula versus cached result.** A formula cell stores both. We emit the
 *     cached result, because that is what the spreadsheet displays and what a
 *     reader of the converted document expects — and we emit a diagnostic saying
 *     the formula was dropped, because silently discarding `=SUM(A1:A10)` loses the
 *     only part that explains the number.
 *   - **Shared strings.** Text lives in a separate part, indexed by number.
 *     Resolving it is not optional; a reader that skips it produces a sheet of
 *     integers.
 *   - **Sparse rows.** Spreadsheets omit empty cells entirely, so `A1, C1` means
 *     `B1` is blank. Reconstructing the gaps is what keeps columns aligned.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  assignIds,
  contentHashOfBytes,
  emptyDocument,
  normalize,
  tableCell as makeCell,
  visit,
  type AnyNode,
  type MarkForgeDocument,
  type Provenance,
} from "@markforge/ir";
import {
  OpcPackage,
  attr,
  childNamed,
  childrenNamed,
  descendantsNamed,
  textOf,
  val,
  type XmlElement,
} from "@markforge/ooxml";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-office", version: "0.1.0" };

export interface XlsxParseOptions {
  path?: string;
  normalize?: boolean;
  /** Cap on rows read per sheet, so a million-row export cannot hang a conversion. */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 5000;

export function parseXlsx(
  bytes: Uint8Array,
  options: XlsxParseOptions = {},
): { document: MarkForgeDocument; diagnostics: DiagnosticBag } {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const pkg = OpcPackage.open(bytes);
  const doc = emptyDocument();
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  const workbook = pkg.xml("xl/workbook.xml");
  if (!workbook) {
    throw new Error(
      "adapters-office: no xl/workbook.xml. The file is a ZIP but not a SpreadsheetML " +
        "document.",
    );
  }

  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "workbook.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  const sharedStrings = parseSharedStrings(pkg);
  const sheetNames = readSheetNames(workbook);

  const sheetPaths = pkg
    .pathsUnder("xl/worksheets/")
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  const sheets: AnyNode[] = [];
  sheetPaths.forEach((path, index) => {
    const xml = pkg.xml(path);
    if (!xml) return;
    const name = sheetNames[index] ?? `Sheet${index + 1}`;
    const table = parseSheet(xml, sharedStrings, diagnostics, name, maxRows);
    sheets.push({
      type: "sheet",
      name,
      index,
      children: [
        { type: "heading", depth: 2, resolvedLevel: 2, children: [{ type: "text", value: name }] },
        table,
      ],
    });
  });

  doc.body = { type: "root", children: sheets } as unknown as MarkForgeDocument["body"];
  doc.metadata = { title: `Workbook (${sheets.length} sheet${sheets.length === 1 ? "" : "s"})` };

  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
  attachProvenance(doc, sourceId);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    attachProvenance(doc, sourceId);
  }

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
}

const sheetNumber = (path: string): number => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

function readSheetNames(workbook: XmlElement): string[] {
  const sheets = childNamed(workbook, "sheets");
  if (!sheets) return [];
  return childrenNamed(sheets, "sheet").map((s) => attr(s, "name") ?? "");
}

/**
 * The shared string table.
 *
 * Rich text splits one string across several `<r>` runs; concatenating them is
 * required, because taking only the first run truncates every formatted cell at its
 * first formatting change.
 */
function parseSharedStrings(pkg: OpcPackage): string[] {
  const xml = pkg.xml("xl/sharedStrings.xml");
  if (!xml) return [];
  return childrenNamed(xml, "si").map((si) => {
    const direct = childNamed(si, "t");
    if (direct) return textOf(direct);
    return childrenNamed(si, "r")
      .map((r) => {
        const t = childNamed(r, "t");
        return t ? textOf(t) : "";
      })
      .join("");
  });
}

/** `A1` → `{ col: 0, row: 0 }`. Column letters are base-26 with no zero digit. */
export function parseCellRef(ref: string): { col: number; row: number } | undefined {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function parseSheet(
  root: XmlElement,
  sharedStrings: string[],
  diagnostics: DiagnosticBag,
  sheetName: string,
  maxRows: number,
): AnyNode {
  const sheetData = childNamed(root, "sheetData");
  const rowsXml = sheetData ? childrenNamed(sheetData, "row") : [];

  let truncated = false;
  const limited = rowsXml.length > maxRows ? rowsXml.slice(0, maxRows) : rowsXml;
  if (rowsXml.length > maxRows) {
    truncated = true;
    diagnostics.degraded(
      DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
      "worksheet",
      `Sheet "${sheetName}" has ${rowsXml.length} rows; only the first ${maxRows} were read. ` +
        `Raise maxRows to include the rest — the limit exists so a very large export cannot ` +
        `hang a conversion, not because the data is unimportant.`,
    );
  }

  // Merged ranges are declared once for the sheet, not on the cells. Indexing them
  // by their anchor is what turns them into rowSpan/colSpan.
  const merges = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const merge of descendantsNamed(root, "mergeCell")) {
    const ref = attr(merge, "ref");
    if (!ref) continue;
    const [fromRef, toRef] = ref.split(":");
    const from = fromRef ? parseCellRef(fromRef) : undefined;
    const to = toRef ? parseCellRef(toRef) : undefined;
    if (!from || !to) continue;
    merges.set(`${from.row},${from.col}`, {
      rowSpan: to.row - from.row + 1,
      colSpan: to.col - from.col + 1,
    });
    for (let r = from.row; r <= to.row; r++) {
      for (let c = from.col; c <= to.col; c++) {
        if (r !== from.row || c !== from.col) covered.add(`${r},${c}`);
      }
    }
  }

  let formulaCount = 0;
  let maxCol = 0;
  const parsedRows: { index: number; cells: Map<number, { text: string; formula?: string }> }[] = [];

  for (const row of limited) {
    const rowIndex = Number(attr(row, "r") ?? 0) - 1;
    const cells = new Map<number, { text: string; formula?: string }>();
    for (const c of childrenNamed(row, "c")) {
      const ref = attr(c, "r");
      const pos = ref ? parseCellRef(ref) : undefined;
      if (!pos) continue;
      maxCol = Math.max(maxCol, pos.col);

      const type = attr(c, "t");
      const f = childNamed(c, "f");
      const v = childNamed(c, "v");
      const is = childNamed(c, "is");

      let text = "";
      if (type === "s") {
        // Shared string: the value is an index into the table.
        const index = v ? Number(textOf(v)) : NaN;
        text = Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
      } else if (type === "inlineStr" && is) {
        text = textOf(is);
      } else if (type === "b") {
        text = v && textOf(v) === "1" ? "TRUE" : "FALSE";
      } else if (v) {
        text = textOf(v);
      }

      const entry: { text: string; formula?: string } = { text };
      if (f) {
        entry.formula = textOf(f);
        formulaCount++;
      }
      cells.set(pos.col, entry);
    }
    parsedRows.push({ index: rowIndex >= 0 ? rowIndex : parsedRows.length, cells });
  }

  if (formulaCount > 0) {
    // The decision, stated: the displayed value survives and the formula does not.
    diagnostics.degraded(
      DiagnosticCode.DOCX_FIELD_AS_TEXT,
      "formula",
      `Sheet "${sheetName}": ${formulaCount} formula cell(s) were converted to their cached ` +
        `results. The displayed value is preserved; the formula that produced it is not, so ` +
        `the converted document shows the number without the reasoning.`,
    );
  }

  const rows: AnyNode[] = [];
  for (const { index, cells } of parsedRows) {
    const rowCells: AnyNode[] = [];
    for (let col = 0; col <= maxCol; col++) {
      // A covered cell belongs to a merge anchored elsewhere; emitting it would
      // duplicate the anchor's content and shift every column after it.
      if (covered.has(`${index},${col}`)) continue;

      // Sparse rows: an omitted cell is genuinely empty, and skipping it rather
      // than emitting a placeholder would misalign the columns.
      const cell = cells.get(col);
      const merge = merges.get(`${index},${col}`);
      rowCells.push(
        makeCell(
          [
            {
              type: "paragraph",
              children: cell && cell.text !== "" ? [{ type: "text", value: cell.text }] : [],
            },
          ],
          { rowSpan: merge?.rowSpan, colSpan: merge?.colSpan },
        ),
      );
    }
    rows.push({ type: "tableRow", children: rowCells });
  }

  // Row 1 is *not* assumed to be a header. That is a convention, not a fact in the
  // file, and adapter rule A5 keeps the guess out of the adapter.
  //
  // Truncation is recorded as a diagnostic only, not as a property on the table:
  // the schema has no field for it, and inventing one would put a value in the
  // content hash that describes how we read the file rather than what it contains.
  void truncated;
  return { type: "table", children: rows };
}

function attachProvenance(doc: MarkForgeDocument, sourceId: string): void {
  const provenance: Record<string, Provenance> = {};
  let sheetName = "Sheet1";
  visit(doc.body as unknown as AnyNode, (n) => {
    if (n.type === "sheet" && typeof n["name"] === "string") sheetName = n["name"];
    if (typeof n.id !== "string") return;
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      locator: { kind: "cell", sheet: sheetName, ref: "A1" },
    };
  });
  doc.provenance = provenance;
}

export { val };
