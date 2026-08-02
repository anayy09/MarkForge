/**
 * PPTX to IR.
 *
 * A slide is a bag of shapes at absolute coordinates, so "reading order" is not
 * given by the file — it has to be reconstructed from geometry. That reconstruction
 * is the only inference here, it is deterministic, and it is stated rather than
 * hidden: shapes sort top-to-bottom, then left-to-right, with a row tolerance so two
 * shapes at nearly the same height read as a row rather than a column.
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
  boolVal,
  childElements,
  childNamed,
  childrenNamed,
  descendantsNamed,
  intVal,
  textOf,
  val,
  type XmlElement,
} from "@markforge/ooxml";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-office", version: "0.1.0" };

/** EMU per point. PowerPoint stores geometry in English Metric Units. */
const EMU_PER_POINT = 12700;

/**
 * Two shapes within this many points vertically count as the same row.
 *
 * 20pt is about two lines of body text. Below that, side-by-side captions and
 * two-column layouts read as columns; above it, genuinely stacked shapes would be
 * merged into one row. The value is a judgement, so it is named and adjustable
 * rather than buried as a literal.
 */
const ROW_TOLERANCE_PT = 20;

export interface PptxParseOptions {
  path?: string;
  normalize?: boolean;
}

export function parsePptx(
  bytes: Uint8Array,
  options: PptxParseOptions = {},
): { document: MarkForgeDocument; diagnostics: DiagnosticBag } {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const pkg = OpcPackage.open(bytes);
  const doc = emptyDocument();

  const slidePaths = pkg
    .pathsUnder("ppt/slides/")
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    // Numeric sort, not lexicographic: slide10 must not come between slide1 and
    // slide2, which is exactly what sorting the strings would do.
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slidePaths.length === 0) {
    throw new Error(
      "adapters-office: no ppt/slides/*.xml. The file is a ZIP but not a PresentationML " +
        "document — a DOCX renamed to .pptx would look like this.",
    );
  }

  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "presentation.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  const slides: AnyNode[] = [];
  slidePaths.forEach((path, index) => {
    const xml = pkg.xml(path);
    if (!xml) return;
    const slideNo = index + 1;
    const children = parseSlide(xml, diagnostics, slideNo);

    // Speaker notes are content, not chrome. Dropping them would lose the half of a
    // deck that carries the argument.
    //
    // They go into `children` as an admonition rather than into the schema's
    // `notes` slot, which takes a whole Root. A nested Root would need its own node
    // ids, and `assignIds` walks `children` and `body` only — so notes hung there
    // would validate as a missing id rather than as notes. An admonition is already
    // legal BlockContent and renders as a visible aside in every output format.
    const notesPath = `ppt/notesSlides/notesSlide${slideNumber(path)}.xml`;
    const notesXml = pkg.xml(notesPath);
    if (notesXml) {
      const notes = parseSlide(notesXml, diagnostics, slideNo).filter(
        (n) => plainText(n).trim().length > 0,
      );
      if (notes.length > 0) {
        children.push({
          type: "admonition",
          kind: "note",
          children: notes,
        });
      }
    }

    slides.push({ type: "slide", slideNumber: slideNo, children });
  });

  doc.body = { type: "root", children: slides } as unknown as MarkForgeDocument["body"];
  doc.metadata = { title: `Presentation (${slides.length} slides)` };

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

const slideNumber = (path: string): number => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

interface PositionedShape {
  top: number;
  left: number;
  nodes: AnyNode[];
  isTitle: boolean;
}

function parseSlide(root: XmlElement, diagnostics: DiagnosticBag, slideNo: number): AnyNode[] {
  const spTree = descendantsNamed(root, "spTree")[0];
  if (!spTree) return [];

  const shapes: PositionedShape[] = [];

  for (const shape of childElements(spTree)) {
    if (shape.local === "sp") {
      const { top, left } = shapePosition(shape);
      const isTitle = shapeIsTitle(shape);
      const nodes = parseTextBody(shape, isTitle);
      if (nodes.length > 0) shapes.push({ top, left, nodes, isTitle });
      continue;
    }
    if (shape.local === "graphicFrame") {
      const table = descendantsNamed(shape, "tbl")[0];
      if (table) {
        const { top, left } = shapePosition(shape);
        shapes.push({ top, left, nodes: [parseTable(table)], isTitle: false });
        continue;
      }
      // A chart, diagram, or SmartArt. Its data is not text and has no IR node.
      const { top, left } = shapePosition(shape);
      diagnostics.lost(
        DiagnosticCode.DOCX_EMBEDDED_OBJECT,
        "p:graphicFrame",
        `Slide ${slideNo}: a chart, diagram, or SmartArt frame has no text representation ` +
          `and was preserved as an unknown node. Its underlying data is not recoverable ` +
          `from the slide alone.`,
      );
      shapes.push({
        top, left,
        nodes: [{ type: "unknown", construct: "p:graphicFrame", raw: textOf(shape).slice(0, 200) }],
        isTitle: false,
      });
      continue;
    }
    if (shape.local === "pic") {
      const { top, left } = shapePosition(shape);
      const alt = descendantsNamed(shape, "cNvPr")[0];
      const description = alt ? (attr(alt, "descr") ?? attr(alt, "name")) : undefined;
      const image: AnyNode = { type: "image", url: "" };
      if (description) image["alt"] = description;
      shapes.push({ top, left, nodes: [{ type: "paragraph", children: [image] }], isTitle: false });
      continue;
    }
    if (shape.local === "grpSp") {
      // A group is a container; its children are laid out in the same coordinate
      // space, so flattening keeps them in reading order rather than nesting them
      // where the sort cannot see them.
      const { top, left } = shapePosition(shape);
      const nested = parseSlide(shape, diagnostics, slideNo);
      if (nested.length > 0) shapes.push({ top, left, nodes: nested, isTitle: false });
    }
  }

  // Reading order: title first regardless of geometry, then top-to-bottom and
  // left-to-right. The title exception matters because a title placeholder is
  // sometimes positioned below other content while still being the slide's heading.
  shapes.sort((a, b) => {
    if (a.isTitle !== b.isTitle) return a.isTitle ? -1 : 1;
    if (Math.abs(a.top - b.top) > ROW_TOLERANCE_PT) return a.top - b.top;
    return a.left - b.left;
  });

  return shapes.flatMap((s) => s.nodes);
}

function shapePosition(shape: XmlElement): { top: number; left: number } {
  const off = descendantsNamed(shape, "off")[0];
  const x = off ? Number(attr(off, "x") ?? 0) : 0;
  const y = off ? Number(attr(off, "y") ?? 0) : 0;
  return { top: y / EMU_PER_POINT, left: x / EMU_PER_POINT };
}

/** True when the shape occupies a title placeholder. */
function shapeIsTitle(shape: XmlElement): boolean {
  const ph = descendantsNamed(shape, "ph")[0];
  const type = ph ? attr(ph, "type") : undefined;
  return type === "title" || type === "ctrTitle";
}

/**
 * A shape's text body.
 *
 * Outline level becomes list nesting, because that is what it means on a slide: a
 * body placeholder with `lvl="1"` is a sub-bullet, not an indented paragraph.
 */
function parseTextBody(shape: XmlElement, isTitle: boolean): AnyNode[] {
  const txBody = childNamed(shape, "txBody");
  if (!txBody) return [];

  const paragraphs = childrenNamed(txBody, "p");
  const out: AnyNode[] = [];
  let currentList: AnyNode | undefined;

  for (const p of paragraphs) {
    const pPr = childNamed(p, "pPr");
    const level = pPr ? (intVal(childNamed(pPr, "lvl")) ?? Number(attr(pPr, "lvl") ?? 0)) : 0;
    const buNone = pPr ? childNamed(pPr, "buNone") : undefined;
    const buAutoNum = pPr ? childNamed(pPr, "buAutoNum") : undefined;

    const inline = parseRuns(p);
    if (inline.length === 0) {
      currentList = undefined;
      continue;
    }

    if (isTitle) {
      out.push({ type: "heading", depth: 2, resolvedLevel: 2, children: inline });
      continue;
    }

    // A body paragraph with no explicit "no bullet" is a bullet. That is the
    // PowerPoint default, and treating it as a plain paragraph would flatten every
    // deck into prose.
    const isBullet = !buNone;
    if (!isBullet) {
      currentList = undefined;
      out.push({ type: "paragraph", children: inline });
      continue;
    }

    const item: AnyNode = {
      type: "listItem",
      spread: false,
      children: [{ type: "paragraph", children: inline }],
    };

    if (!currentList || (currentList["__level"] as number) !== level) {
      currentList = {
        type: "list",
        ordered: buAutoNum !== undefined,
        spread: false,
        children: [],
        __level: level,
      };
      out.push(currentList);
    }
    (currentList.children as AnyNode[]).push(item);
  }

  // `__level` is bookkeeping, not content. Leaving it on the node would put it in
  // the content hash and into every serialised document.
  for (const node of out) delete node["__level"];
  return out;
}

function parseRuns(p: XmlElement): AnyNode[] {
  const out: AnyNode[] = [];
  for (const child of childElements(p)) {
    if (child.local === "br") {
      out.push({ type: "break" });
      continue;
    }
    if (child.local !== "r") continue;

    const text = childNamed(child, "t");
    const value = text ? textOf(text) : "";
    if (value === "") continue;

    const rPr = childNamed(child, "rPr");
    let node: AnyNode = { type: "text", value };
    if (rPr) {
      // DrawingML spells these as attributes on rPr, not child elements as
      // WordprocessingML does — the same concepts, a different encoding.
      if (attr(rPr, "u") && attr(rPr, "u") !== "none") node = { type: "underline", children: [node] };
      if (attr(rPr, "strike") && attr(rPr, "strike") !== "noStrike") node = { type: "delete", children: [node] };
      if (attr(rPr, "i") === "1" || boolVal(childNamed(rPr, "i")) === true) node = { type: "emphasis", children: [node] };
      if (attr(rPr, "b") === "1" || boolVal(childNamed(rPr, "b")) === true) node = { type: "strong", children: [node] };
    }
    out.push(node);
  }
  return out;
}

function parseTable(tbl: XmlElement): AnyNode {
  const rows: AnyNode[] = [];
  let headerRows = 0;

  const tblPr = childNamed(tbl, "tblPr");
  if (tblPr && attr(tblPr, "firstRow") === "1") headerRows = 1;

  const openMerge = new Map<number, AnyNode>();
  childrenNamed(tbl, "tr").forEach((tr) => {
    const cells: AnyNode[] = [];
    let col = 0;
    for (const tc of childrenNamed(tr, "tc")) {
      const gridSpan = Number(attr(tc, "gridSpan") ?? 1);
      const rowSpan = Number(attr(tc, "rowSpan") ?? 1);
      const isVMerge = attr(tc, "vMerge") === "1";
      const isHMerge = attr(tc, "hMerge") === "1";

      if (isVMerge) {
        const anchor = openMerge.get(col);
        if (anchor) anchor["rowSpan"] = ((anchor["rowSpan"] as number | undefined) ?? 1) + 1;
        col += gridSpan;
        continue;
      }
      // hMerge cells are continuations already accounted for by the anchor's
      // gridSpan; emitting them would double-count the columns.
      if (isHMerge) { col += gridSpan; continue; }

      const cell = makeCell(parseTextBody(tc, false), {
        colSpan: gridSpan,
        rowSpan,
        isHeader: headerRows > 0 && rows.length === 0,
      });
      if (rowSpan > 1) openMerge.set(col, cell);
      else openMerge.delete(col);
      cells.push(cell);
      col += gridSpan;
    }
    rows.push({ type: "tableRow", children: cells });
  });

  const tableNode: AnyNode = { type: "table", children: rows };
  if (headerRows > 0) tableNode["headerRowCount"] = headerRows;
  return tableNode;
}

function plainText(node: AnyNode): string {
  let out = "";
  const walk = (n: AnyNode): void => {
    if (n.type === "text" && typeof n["value"] === "string") out += n["value"];
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(node);
  return out;
}

function attachProvenance(doc: MarkForgeDocument, sourceId: string): void {
  const provenance: Record<string, Provenance> = {};
  let slideNo = 0;
  visit(doc.body as unknown as AnyNode, (n, ctx) => {
    if (n.type === "slide") slideNo = typeof n["slideNumber"] === "number" ? n["slideNumber"] : slideNo + 1;
    if (typeof n.id !== "string") return;
    void ctx;
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      locator: { kind: "slide", slideNumber: Math.max(1, slideNo) },
    };
  });
  doc.provenance = provenance;
}

export { val };
