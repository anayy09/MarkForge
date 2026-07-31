/**
 * @markforge/adapters-docx — DOCX to IR.
 *
 * Built on our own OOXML reader (ADR-0005), which is a deliberate deviation from
 * brief §5.2's "build on Mammoth's style-map extension point". Mammoth emits HTML
 * and documents discarding fonts, sizes, and colours; routing through it would
 * leave the style sidecar — the thing §4.2 calls the differentiator — empty.
 *
 * Adapter contract (docs/SPEC.md §3):
 *   A1  parse(bytes, opts) -> { ir, diagnostics }
 *   A4  every node carries provenance
 *   A5  adapters record, they do not infer
 *   A6  anything unrepresentable emits a lossy diagnostic and an `unknown` node
 *   A7  headers and footers are routed to `furniture`, never stripped (ADR-0002)
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  assignIds,
  contentHashOfBytes,
  emptyDocument,
  normalize,
  tableCell as makeCell,
  type AnyNode,
  type Furniture,
  type MarkForgeDocument,
  type Provenance,
  type Resource,
  type StyleEvidence,
} from "@markforge/ir";
import {
  OpcPackage,
  Part,
  RelType,
  attr,
  childElements,
  childNamed,
  childrenNamed,
  intVal,
  parseDocDefaults,
  parseNumbering,
  parseRelationships,
  parseStyles,
  parseTheme,
  resolveListItem,
  resolveStyle,
  resolveTarget,
  textOf,
  val,
  type CascadeInput,
  type ParsedNumbering,
  type XmlElement,
} from "@markforge/ooxml";
import { parseRun, parseHyperlink, type RunContext } from "./runs.js";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-docx", version: "0.1.0" };

/**
 * The generated node types require `id` on every node, because they describe a
 * *finished* document. Construction is necessarily intermediate: ids are
 * content-addressed and assigned bottom-up once the tree exists (ADR-0014), so
 * during parsing there is genuinely no id to supply. The adapter therefore builds
 * `AnyNode` and casts once, at the boundary — and the cast is safe because
 * `validateDocument` checks the result against the schema, which is a stronger
 * guarantee than the cast gives up.
 */
const asBody = (children: AnyNode[]): MarkForgeDocument["body"] =>
  ({ type: "root", children }) as unknown as MarkForgeDocument["body"];

export interface DocxParseOptions {
  /** Path recorded in provenance. Relative paths keep output machine-independent. */
  path?: string;
  /** Run IR normalisation after parsing. Off only for adapter unit tests. */
  normalize?: boolean;
}

export interface DocxParseResult {
  document: MarkForgeDocument;
  diagnostics: DiagnosticBag;
}

interface ParseState {
  pkg: OpcPackage;
  cascade: CascadeInput;
  numbering: ParsedNumbering;
  diagnostics: DiagnosticBag;
  sourceId: string;
  sidecar: Record<string, StyleEvidence>;
  provenance: Record<string, Provenance>;
  resources: Record<string, Resource>;
  /** Evidence recorded against object identity, before ids exist. */
  pendingEvidence: Map<AnyNode, StyleEvidence>;
  pendingLocator: Map<AnyNode, string>;
  relationships: Map<string, { type: string; target: string }>;
  resourceIds: Map<string, string>;
}

export function parseDocx(bytes: Uint8Array, options: DocxParseOptions = {}): DocxParseResult {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const pkg = OpcPackage.open(bytes);
  const doc = emptyDocument();

  const documentXml = pkg.xml(Part.DOCUMENT);
  if (!documentXml) {
    throw new Error(
      "adapters-docx: no word/document.xml. The file is a ZIP but not a WordprocessingML " +
        "document — an XLSX or PPTX renamed to .docx would look like this.",
    );
  }

  const sourceId = "s0";
  const path = options.path ?? "document.docx";
  doc.sources[sourceId] = {
    sourceId,
    // Relative, never absolute: the schema forbids absolute paths because they make
    // output machine-dependent and break the determinism guarantee (SPEC §1).
    displayPath: path,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  const styles = parseStyles(pkg.xml(Part.STYLES));
  const docDefaults = parseDocDefaults(pkg.xml(Part.STYLES));
  const themeXml = pkg.xml(Part.THEME);
  if (!themeXml) {
    // Not an error. Machine-generated DOCX routinely omits the theme
    // (docs/CORPUS.md §2.15) and the cascade falls back to docDefaults.
    diagnostics.info(
      DiagnosticCode.DOCX_MISSING_THEME,
      "No theme1.xml: font tokens such as +mn-lt cannot be resolved to names. " +
        "Typical of library-generated documents; the cascade falls back to docDefaults.",
    );
  }
  const theme = parseTheme(themeXml);
  const numbering = parseNumbering(pkg.xml(Part.NUMBERING));

  const cascade: CascadeInput = { styles, docDefaults, theme, numbering: numbering.definitions };
  doc.styles = styles;
  doc.numbering = numbering.definitions;

  const rels = parseRelationships(pkg, Part.DOCUMENT_RELS);
  const relationships = new Map<string, { type: string; target: string }>();
  for (const [id, r] of rels) relationships.set(id, { type: r.type, target: r.target });

  const state: ParseState = {
    pkg,
    cascade,
    numbering,
    diagnostics,
    sourceId,
    sidecar: {},
    provenance: {},
    resources: {},
    pendingEvidence: new Map(),
    pendingLocator: new Map(),
    relationships,
    resourceIds: new Map(),
  };

  collectResources(state, rels);

  const body = childNamed(documentXml, "body");
  if (!body) throw new Error("adapters-docx: document.xml has no w:body");

  const blocks = parseBlockContainer(body, state, "/w:document/w:body");
  doc.body = asBody(blocks);

  // A7: headers and footers become furniture. Brief §5.2 says "stripping", but
  // stripping would violate §3.3's no-silent-loss rule, so they are routed instead
  // (ADR-0002, flagged in OPEN_QUESTIONS §7b).
  doc.furniture = parseFurniture(state, rels);

  doc.metadata = parseMetadata(pkg);
  doc.resources = state.resources;

  assignIds(doc.body as unknown as AnyNode);
  for (const f of doc.furniture) for (const child of f.content as unknown as AnyNode[]) assignIds(child);

  // The document id is the root node's id. Content-addressing the document for free
  // is the point: two parses of the same bytes produce the same document id, and a
  // changed document announces itself without anyone diffing it.
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;

  // Evidence and provenance were accumulated against node identity; now that ids
  // exist, they are keyed by id. Doing it this way avoids a second traversal per
  // node and keeps id assignment strictly bottom-up.
  materializeSideTables(doc, state);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    // Normalisation can delete nodes and merge text, so ids are stale. Recomputing
    // is cheap and leaves the document self-consistent; leaving them stale would
    // break the sidecar join.
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    reattachProvenance(doc, state);
  }

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
}

function collectResources(state: ParseState, rels: Map<string, { type: string; target: string }>): void {
  let n = 0;
  for (const [relId, rel] of rels) {
    if (rel.type !== RelType.IMAGE) continue;
    const partPath = resolveTarget(Part.DOCUMENT, rel.target);
    const bytes = state.pkg.bytes(partPath);
    if (!bytes) continue;
    const resourceId = `r${n++}`;
    const mediaType = mediaTypeFor(partPath);
    state.resources[resourceId] = {
      resourceId,
      mediaType,
      contentHash: contentHashOfBytes(bytes),
      byteLength: bytes.byteLength,
      path: partPath,
    };
    state.resourceIds.set(relId, resourceId);

    // TIFF inside DOCX is legal and no browser renders it (found in the IEEE
    // template, docs/TEMPLATES.md §3.1). Flagged at parse time so the HTML renderer
    // is not the first place anyone notices.
    if (mediaType === "image/tiff") {
      state.diagnostics.degraded(
        DiagnosticCode.RENDER_TIFF_UNSUPPORTED,
        partPath,
        "TIFF image: preserved in the IR, but no browser renders TIFF natively, so " +
          "HTML and Markdown output will need it transcoded. Converting the image to " +
          "PNG in the source document avoids this.",
      );
    }
  }
}

function mediaTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    tiff: "image/tiff",
    tif: "image/tiff",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Parses a sequence of block-level elements, grouping consecutive list paragraphs
 * into `list` nodes.
 *
 * OOXML has no list element: a list is a run of paragraphs that happen to share a
 * `w:numId`. Reconstructing the tree is the adapter's job, and it is where the
 * "numbered lists become bullets" defect lives — the decision comes from
 * numbering.xml, never from the paragraph's style name.
 */
function parseBlockContainer(container: XmlElement, state: ParseState, basePath: string): AnyNode[] {
  const out: AnyNode[] = [];
  let index = 0;

  const children = childElements(container);
  for (let i = 0; i < children.length; i++) {
    const el = children[i]!;
    const locator = `${basePath}/${el.name}[${index++}]`;

    if (el.local === "p") {
      const info = listInfoFor(el, state);
      if (info) {
        // Consume the whole run of adjacent list paragraphs at once.
        //
        // The run continues while a paragraph either shares the run's numbering id, or
        // sits at a *deeper* level than the run started at — whatever its numbering id.
        //
        // That second clause matters. A bullet list nested inside a numbered list needs
        // its own numbering definition, because one definition describes one sequence of
        // level formats. Grouping strictly by numId therefore cut the parent list in two
        // at the nested child: `1. a / - x / 2. b` came back as three sibling lists
        // instead of one list with a nested child. Depth is the reliable signal for
        // nesting; the numbering id only tells you which definition supplies the marker.
        const items: { el: XmlElement; level: number; ordered: boolean; restartsAt?: number }[] = [];
        let j = i;
        const baseNumberingId = info.numberingId;
        const baseLevel = info.level;
        while (j < children.length) {
          const candidate = children[j]!;
          if (candidate.local !== "p") break;
          const candidateInfo = listInfoFor(candidate, state);
          if (!candidateInfo) break;
          const sameList = candidateInfo.numberingId === baseNumberingId;
          const nestedDeeper = candidateInfo.level > baseLevel;
          if (!sameList && !nestedDeeper) break;
          const item: { el: XmlElement; level: number; ordered: boolean; restartsAt?: number } = {
            el: candidate,
            level: candidateInfo.level,
            ordered: candidateInfo.isOrdered,
          };
          if (candidateInfo.restartsAt !== undefined) item.restartsAt = candidateInfo.restartsAt;
          items.push(item);
          j++;
        }
        out.push(buildList(items, state, basePath, 0));
        i = j - 1;
        continue;
      }
      out.push(parseParagraph(el, state, locator));
      continue;
    }

    if (el.local === "tbl") {
      out.push(parseTable(el, state, locator));
      continue;
    }

    if (el.local === "sectPr" || el.local === "bookmarkStart" || el.local === "bookmarkEnd") {
      // sectPr is section geometry, captured via furniture; bookmarks are link
      // targets handled by crossReference resolution. Neither is content.
      continue;
    }

    if (el.local === "sdt") {
      // A structured document tag (content control). Its content lives in sdtContent
      // and is real content, so it is unwrapped rather than dropped.
      const content = childNamed(el, "sdtContent");
      if (content) out.push(...parseBlockContainer(content, state, locator));
      continue;
    }

    state.diagnostics.degraded(
      DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
      el.name,
      `Unhandled block element ${el.name}; preserved as an unknown node so the loss is visible.`,
    );
    const unknown: AnyNode = { type: "unknown", originalType: el.name, raw: textOf(el).slice(0, 200) };
    state.pendingLocator.set(unknown, locator);
    out.push(unknown);
  }

  return out;
}

function listInfoFor(p: XmlElement, state: ParseState) {
  const pPr = childNamed(p, "pPr");
  if (!pPr) return undefined;
  const numPr = childNamed(pPr, "numPr");
  const styleId = val(childNamed(pPr, "pStyle"));

  // numPr can also come from the paragraph's style, which is how Word encodes
  // "ListParagraph with numbering baked into the style". Checking only the direct
  // numPr misses those.
  let numId = numPr ? val(childNamed(numPr, "numId")) : undefined;
  let ilvl = numPr ? intVal(childNamed(numPr, "ilvl")) : undefined;
  if (numId === undefined && styleId) {
    const fromStyle = state.cascade.styles[styleId]?.evidence;
    numId = fromStyle?.numbering?.numId;
    ilvl = ilvl ?? fromStyle?.numbering?.ilvl;
  }
  return resolveListItem(state.numbering, numId, ilvl);
}

/** Builds a nested list from a flat run of items carrying levels. */
function buildList(
  items: { el: XmlElement; level: number; ordered: boolean; restartsAt?: number }[],
  state: ParseState,
  basePath: string,
  depth: number,
): AnyNode {
  const first = items[0]!;
  const listChildren: AnyNode[] = [];
  const list: AnyNode = {
    type: "list",
    ordered: first.ordered,
    spread: false,
    children: listChildren,
  };
  if (first.restartsAt !== undefined) list["restartsAt"] = first.restartsAt;
  if (first.ordered) list["start"] = first.restartsAt ?? 1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.level > first.level) {
      // Deeper items belong to the previous item as a nested list.
      const nested: typeof items = [];
      let j = i;
      while (j < items.length && items[j]!.level > first.level) {
        nested.push(items[j]!);
        j++;
      }
      const sub = buildList(nested, state, basePath, depth + 1);
      const prev = listChildren[listChildren.length - 1];
      if (prev && Array.isArray(prev.children)) prev.children.push(sub);
      else listChildren.push({ type: "listItem", spread: false, children: [sub] });
      i = j - 1;
      continue;
    }
    const paragraph = parseParagraph(item.el, state, `${basePath}/list[${depth}]/item[${i}]`);
    listChildren.push({ type: "listItem", spread: false, children: [paragraph] });
  }

  return list;
}

function parseParagraph(p: XmlElement, state: ParseState, locator: string): AnyNode {
  const pPr = childNamed(p, "pPr");
  const styleId = val(pPr ? childNamed(pPr, "pStyle") : undefined);
  const markRPr = pPr ? childNamed(pPr, "rPr") : undefined;

  const resolved = resolveStyle(state.cascade, {
    ...(styleId !== undefined ? { styleId } : {}),
    pPr,
    rPr: markRPr,
  });
  if (resolved.brokenChain && styleId) {
    state.diagnostics.degraded(
      DiagnosticCode.DOCX_BROKEN_STYLE_CHAIN,
      styleId,
      `Paragraph style "${styleId}" is referenced but not defined in styles.xml, or its ` +
        `basedOn chain is cyclic. Formatting falls back to docDefaults.`,
    );
  }

  const children = parseInlineContainer(p, state);
  const node: AnyNode = { type: "paragraph", children };
  state.pendingEvidence.set(node, resolved.evidence);
  state.pendingLocator.set(node, locator);
  return node;
}

function parseInlineContainer(container: XmlElement, state: ParseState): AnyNode[] {
  const out: AnyNode[] = [];
  const pPr = childNamed(container, "pPr");
  const styleId = val(pPr ? childNamed(pPr, "pStyle") : undefined);

  const ctx: RunContext = {
    cascade: state.cascade,
    diagnostics: state.diagnostics,
    relationships: state.relationships,
    resourceIds: state.resourceIds,
    recordEvidence: (node, evidence) => state.pendingEvidence.set(node, evidence),
    paragraphStyleId: styleId,
  };

  const walk = (el: XmlElement): AnyNode[] => {
    const acc: AnyNode[] = [];
    for (const child of childElements(el)) {
      switch (child.local) {
        case "r":
          acc.push(...parseRun(child, ctx));
          break;
        case "hyperlink":
          acc.push(parseHyperlink(child, ctx, walk));
          break;
        case "ins": {
          // Tracked insertion. Wrapped rather than range-marked, because ranges
          // corrupt under overlapping revisions from two authors (SPEC §2.3).
          const node: AnyNode = { type: "insertion", children: walk(child) };
          const author = attr(child, "author");
          const date = attr(child, "date");
          if (author) node["author"] = author;
          if (date) node["date"] = date;
          acc.push(node);
          break;
        }
        case "del": {
          const node: AnyNode = { type: "deletion", children: walkDeleted(child) };
          const author = attr(child, "author");
          const date = attr(child, "date");
          if (author) node["author"] = author;
          if (date) node["date"] = date;
          acc.push(node);
          break;
        }
        case "commentRangeStart":
        case "commentRangeEnd":
        case "bookmarkStart":
        case "bookmarkEnd":
        case "proofErr":
        case "pPr":
          break;
        case "smartTag":
        case "sdt": {
          const content = childNamed(child, "sdtContent") ?? child;
          acc.push(...walk(content));
          break;
        }
        case "fldSimple": {
          // A field. Its cached result is the visible text; the instruction is lost.
          const instr = attr(child, "instr") ?? "";
          state.diagnostics.degraded(
            DiagnosticCode.DOCX_FIELD_AS_TEXT,
            "w:fldSimple",
            `Field (${instr.trim().split(/\s+/)[0] ?? "unknown"}) flattened to its cached ` +
              `result; the field will not update.`,
          );
          acc.push(...walk(child));
          break;
        }
        default:
          break;
      }
    }
    return acc;
  };

  // Deleted runs store text in w:delText rather than w:t.
  const walkDeleted = (el: XmlElement): AnyNode[] => {
    const acc: AnyNode[] = [];
    for (const r of childrenNamed(el, "r")) {
      let text = "";
      for (const c of childElements(r)) if (c.local === "delText") text += textOf(c);
      if (text) acc.push({ type: "text", value: text });
    }
    return acc;
  };

  out.push(...walk(container));
  return out;
}

function parseTable(tbl: XmlElement, state: ParseState, locator: string): AnyNode {
  const rows: AnyNode[] = [];
  const rowEls = childrenNamed(tbl, "tr");

  // vMerge continuation cells carry no content and must extend the cell above.
  // Tracking the open vertical merge per column is what turns them into rowSpan.
  const openMerge = new Map<number, AnyNode>();

  rowEls.forEach((tr, rowIndex) => {
    const cells: AnyNode[] = [];
    let col = 0;
    const trPr = childNamed(tr, "trPr");
    const headerMarked = trPr !== undefined && childNamed(trPr, "tblHeader") !== undefined;
    for (const tc of childrenNamed(tr, "tc")) {
      const tcPr = childNamed(tc, "tcPr");
      const gridSpan = intVal(tcPr ? childNamed(tcPr, "gridSpan") : undefined) ?? 1;
      const vMerge = tcPr ? childNamed(tcPr, "vMerge") : undefined;
      const vMergeVal = vMerge ? (val(vMerge) ?? "continue") : undefined;

      if (vMergeVal === "continue") {
        const anchor = openMerge.get(col);
        if (anchor) {
          anchor["rowSpan"] = ((anchor["rowSpan"] as number | undefined) ?? 1) + 1;
          col += gridSpan;
          continue;
        }
      }

      const cell = makeCell(
        parseBlockContainer(tc, state, `${locator}/tr[${rowIndex}]/tc[${col}]`),
        { colSpan: gridSpan, isHeader: headerMarked },
      );
      if (vMergeVal === "restart") openMerge.set(col, cell);
      else if (vMergeVal === undefined) openMerge.delete(col);

      cells.push(cell);
      col += gridSpan;
    }
    rows.push({ type: "tableRow", children: cells });
  });

  // The header row is whatever w:tblHeader marks, and only that. Inferring "row 0
  // is a header" is a decision, and decisions belong in @markforge/infer (A5).
  const headerRows = rowEls.reduce<number>((acc, tr, idx) => {
    const trPr = childNamed(tr, "trPr");
    return trPr && childNamed(trPr, "tblHeader") ? Math.max(acc, idx + 1) : acc;
  }, 0);

  // `headerRowCount`, the schema's name for it. An earlier version wrote
  // `headerRows`, which is not a field: it validated as an unevaluated property and
  // every renderer read undefined, so header rows were silently lost.
  const tableNode: AnyNode = { type: "table", children: rows };
  if (headerRows > 0) tableNode["headerRowCount"] = headerRows;
  state.pendingLocator.set(tableNode, locator);
  return tableNode;
}

function parseFurniture(state: ParseState, rels: Map<string, { type: string; target: string }>): Furniture[] {
  const out: Furniture[] = [];
  for (const [, rel] of rels) {
    const isHeader = rel.type === RelType.HEADER;
    const isFooter = rel.type === RelType.FOOTER;
    if (!isHeader && !isFooter) continue;
    const partPath = resolveTarget(Part.DOCUMENT, rel.target);
    const xml = state.pkg.xml(partPath);
    if (!xml) continue;
    out.push({
      kind: isHeader ? "header" : "footer",
      // OOXML distinguishes default/first/even headers via sectPr references. Phase 1
      // reads the parts themselves, so scope defaults to "default"; wiring sectPr is
      // Phase 2 work and recorded as such rather than guessed.
      scope: "default",
      sectionIndex: 0,
      content: parseBlockContainer(xml, state, `/${partPath}`) as unknown as Furniture["content"],
    });
  }
  // Sorted so furniture order does not depend on relationship-map iteration order,
  // which would make output non-deterministic across runs.
  return out.sort((a, b) => a.kind.localeCompare(b.kind));
}

function parseMetadata(pkg: OpcPackage): Record<string, unknown> {
  const core = pkg.xml(Part.CORE_PROPS);
  if (!core) return {};
  const read = (local: string): string | undefined => {
    const el = childNamed(core, local);
    const t = el ? textOf(el).trim() : "";
    return t.length > 0 ? t : undefined;
  };
  const out: Record<string, unknown> = {};
  const title = read("title");
  const creator = read("creator");
  const created = read("created");
  const modified = read("modified");
  const language = read("language");
  if (title) out["title"] = title;
  if (creator) out["authors"] = [creator];
  if (created) out["created"] = created;
  if (modified) out["modified"] = modified;
  if (language) out["language"] = language;
  return out;
}

/**
 * Builds the schema's OOXML locator variant.
 *
 * `locator` is required on every Provenance entry, so a node whose XPath was not
 * tracked still gets one pointing at the part. A locator that says "somewhere in
 * word/document.xml" is weak but true; omitting it would make provenance optional
 * in practice, which is the thing rule A4 exists to prevent.
 */
function toLocator(xpath: string | undefined): Provenance["locator"] {
  return { kind: "ooxml", part: Part.DOCUMENT, xpath: xpath ?? "/w:document/w:body" };
}

/** Moves identity-keyed evidence and provenance onto the id-keyed side tables. */
function materializeSideTables(doc: MarkForgeDocument, state: ParseState): void {
  const attach = (root: AnyNode): void => {
    const walk = (node: AnyNode): void => {
      const id = node.id;
      if (typeof id === "string") {
        const evidence = state.pendingEvidence.get(node);
        if (evidence && Object.keys(evidence).length > 0) doc.sidecar[id] = evidence;

        const locator = state.pendingLocator.get(node);
        // A4: every node gets provenance, with a locator when one is known.
        doc.provenance[id] = {
          sourceId: state.sourceId,
          producedBy: ADAPTER,
          locator: toLocator(locator),
        };
      }
      for (const key of ["children", "body"] as const) {
        const arr = node[key];
        if (Array.isArray(arr)) for (const c of arr) walk(c as AnyNode);
      }
    };
    walk(root);
  };
  attach(doc.body as unknown as AnyNode);
  for (const f of doc.furniture) for (const c of f.content as unknown as AnyNode[]) attach(c);
}

/**
 * After normalisation, ids change and some nodes are gone. Provenance is rebuilt so
 * A4 still holds — a node with no provenance entry would fail the audit, and
 * silently dropping the check would defeat the point of having it.
 */
function reattachProvenance(doc: MarkForgeDocument, state: ParseState): void {
  const next: Record<string, Provenance> = {};
  const nextSidecar: Record<string, StyleEvidence> = {};
  const walk = (node: AnyNode): void => {
    const id = node.id;
    if (typeof id === "string") {
      const evidence = state.pendingEvidence.get(node);
      if (evidence && Object.keys(evidence).length > 0) nextSidecar[id] = evidence;
      const existingSidecar = doc.sidecar[id];
      if (existingSidecar) nextSidecar[id] = { ...existingSidecar, ...nextSidecar[id] };
      const locator = state.pendingLocator.get(node);
      next[id] = {
        sourceId: state.sourceId,
        producedBy: ADAPTER,
        locator: toLocator(locator),
      };
    }
    for (const key of ["children", "body"] as const) {
      const arr = node[key];
      if (Array.isArray(arr)) for (const c of arr) walk(c as AnyNode);
    }
  };
  walk(doc.body as unknown as AnyNode);
  for (const f of doc.furniture) for (const c of f.content as unknown as AnyNode[]) walk(c);
  doc.provenance = next;
  doc.sidecar = nextSidecar;
}

export { parseRun } from "./runs.js";
