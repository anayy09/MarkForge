/**
 * @markforge/adapters-docx — DOCX to IR.
 *
 * Built on our own OOXML reader (ADR-0005), which is a deliberate deviation from the
 * obvious route of extending Mammoth's style map. Mammoth emits HTML
 * and documents discarding fonts, sizes, and colours; routing through it would
 * leave the style sidecar (SPEC §2.4) empty, and that sidecar is the differentiator.
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
  base64,
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
  readProperties,
  parseRelationships,
  parseStyles,
  parseTheme,
  resolveListItem,
  resolveStyle,
  resolveTarget,
  serializeElement,
  textOf,
  val,
  type CascadeInput,
  type ParsedNumbering,
  type PartialEvidence,
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

/** The same wrapper for furniture, whose `content` the schema also declares as a `Root`. */
const rootOf = (children: AnyNode[]): Furniture["content"] =>
  ({ type: "root", children }) as unknown as Furniture["content"];

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
  /** Document-scoped guard so the missing-theme warning is emitted once. */
  reportedMissingTheme: Set<true>;
  /** Comment ids anchored in the body, so an orphan in comments.xml is not emitted. */
  commentAnchors: Set<string>;
  /** comments.xml, read before the body so a range can be wrapped as it is walked. */
  comments: Map<string, CommentRecord>;
}

interface CommentRecord {
  body: AnyNode;
  author?: string;
  date?: string;
  resolved: boolean;
  locator: string;
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
    reportedMissingTheme: new Set(),
    commentAnchors: new Set(),
    comments: new Map(),
  };

  collectResources(state, rels);
  // Before the body, not after: the range is wrapped as the walk passes it, so the body
  // must already be available when `w:commentRangeEnd` arrives.
  loadComments(state);

  const body = childNamed(documentXml, "body");
  if (!body) throw new Error("adapters-docx: document.xml has no w:body");

  const blocks = parseBlockContainer(body, state, "/w:document/w:body");
  // SPEC §3.1 lists footnotes and endnotes under "Also extracted", and nothing extracted
  // them until 2026-08-01: `footnoteReference` nodes were produced with no definition to
  // match, so rendered Markdown carried dangling `[^1]` — invalid output rather than
  // degraded output. Definitions are appended after the body content, which is where mdast
  // expects them and where a renderer emits them.
  blocks.push(...parseNotes(state));
  reportUnanchoredComments(state);
  doc.body = asBody(blocks);

  // A7: headers and footers become furniture. The obvious reading is "strip them", but
  // stripping would violate the no-silent-loss rule (SPEC §1.3), so they are routed
  // instead (ADR-0002, SPEC §2.2, flagged in OPEN_QUESTIONS §7b).
  doc.furniture = parseFurniture(state, rels);

  doc.metadata = parseMetadata(pkg);
  doc.resources = state.resources;

  assignIds(doc.body as unknown as AnyNode);
  // Furniture content is a `root` node, so its whole subtree is assigned in one call —
  // and the root itself gets an id, which the bare-array form could never give it.
  for (const f of doc.furniture) assignIds(f.content as unknown as AnyNode);

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
      /*
       * The bytes, retained as of 2026-08-01 (ADR-0022).
       *
       * Until then this function read them, hashed them, recorded the length, and dropped
       * them — and `path` points into the *source package*, which does not exist once
       * parsing is done. So every image was lost at parse time, in every adapter, and the
       * DOCX writer's `[alt text]` placeholder was a consequence rather than the cause.
       * `STATUS.md` carried it as a writer gap for six phases.
       */
      data: base64(bytes),
    };
    state.resourceIds.set(relId, resourceId);

    // TIFF inside DOCX is legal and no browser renders it (found in the IEEE
    // template, docs/TEMPLATES.md §3.1). Flagged at parse time so the HTML renderer
    // is not the first place anyone notices.
    if (mediaType === "image/tiff") {
      state.diagnostics.degraded(
        DiagnosticCode.RENDER_TIFF_UNSUPPORTED,
        partPath,
        "TIFF image: its bytes are retained in the IR, but no browser renders TIFF natively, so " +
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

    // Property and layout elements are not content. Missing one here does not
    // produce a missing feature, it produces a phantom `unknown` child on every
    // node that carries the property — which is how `w:tcPr` ended up inside every
    // table cell, failing schema validation.
    if (PROPERTY_ELEMENTS.has(el.local)) continue;

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
    const unknown: AnyNode = { type: "unknown", construct: el.name, raw: textOf(el).slice(0, 200) };
    state.pendingLocator.set(unknown, locator);
    out.push(unknown);
  }

  return out;
}

/**
 * Elements that describe a node rather than being one.
 *
 * `sectPr` is section geometry, captured via furniture. `bookmarkStart`/`End` are
 * link targets handled by crossReference resolution. The `*Pr` family and
 * `tblGrid` are properties of their parent. None of them is content, and treating
 * any of them as content produces a phantom child rather than a missing feature.
 */
const PROPERTY_ELEMENTS = new Set([
  "sectPr", "bookmarkStart", "bookmarkEnd",
  "tcPr", "trPr", "tblPr", "tblGrid", "tblPrEx", "pPr", "rPr",
  "proofErr",
  // `commentRangeStart`/`End`/`Reference` were in this list until 2026-08-01, which meant
  // DOCX comments were discarded as "not content" with no diagnostic — while SPEC §2.3
  // declares a `comment` node type and §3.1 lists comments with anchor ranges under "Also
  // extracted". They are anchors, not properties: they mark a range in the text, and the
  // body they point at lives in comments.xml. See `parseComments`.
]);

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
  // `restartsAt` belongs to `ListItem` (a mid-list restart), not to `List`; the list-level
  // fact is `start`. Setting both put an undeclared property on the list, and
  // `unevaluatedProperties: false` made the whole document invalid. Three adapters did it.
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

  const children = parseInlineContainer(p, state, locator);

  // A paragraph whose whole content is one display equation *is* the equation. Wrapping it
  // in a paragraph puts block content in a phrasing slot, which is invalid IR, and the
  // paragraph adds nothing a renderer can use.
  const equation = onlyEquation(children);
  if (equation) return equation;

  // An equation *among* text has no slot: SPEC §2.3 gives `equationBlock` for OMML and
  // `inlineMath` for a TeX string, and OMML markup in `inlineMath.value` would render as
  // `$<m:oMath>…$`, which is worse than admitting the gap. The markup is kept in `raw`, so
  // this loses the type, not the content. Recorded in docs/LIMITS.md.
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as AnyNode;
    if (child["type"] !== "equationBlock") continue;
    state.diagnostics.degraded(
      DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
      "m:oMath",
      `Inline equation in a paragraph with other content; the IR has no inline OMML node, ` +
        `so the markup is preserved as an unknown node.`,
    );
    const raw = String(child["source"] ?? "");
    const replacement: AnyNode = { type: "unknown", construct: "m:oMath", raw };
    state.pendingLocator.set(replacement, locator);
    children[i] = replacement;
  }

  const node: AnyNode = { type: "paragraph", children };

  // Fold the runs' shared direct formatting into the paragraph's evidence. In a
  // document that uses direct formatting instead of styles — the premise of
  // Surface B — the size and weight live on the runs and the paragraph mark is
  // bare, so without this heading inference has nothing to look at.
  state.pendingEvidence.set(node, withRunEvidence(resolved.evidence, p, state));
  state.pendingLocator.set(node, locator);
  return node;
}

/**
 * The single `equationBlock` a paragraph consists of, if that is all it holds.
 *
 * Whitespace-only text alongside it does not count as content: Word writes a bare `w:r`
 * with a space either side of a display equation often enough that requiring exactly one
 * child would miss most real ones.
 */
function onlyEquation(children: AnyNode[]): AnyNode | undefined {
  let found: AnyNode | undefined;
  for (const child of children) {
    if (child["type"] === "equationBlock") {
      if (found) return undefined; // two equations in one paragraph: not this shape.
      found = child;
      continue;
    }
    if (child["type"] === "text" && String(child["value"] ?? "").trim() === "") continue;
    return undefined;
  }
  return found;
}

/**
 * Adds the runs' *shared* direct formatting to a paragraph's evidence.
 *
 * Only properties every run agrees on are recorded. A paragraph whose runs differ
 * in size has no single size, and claiming one would be inventing a fact rather
 * than reading it — which also stops a single bold word mid-sentence from making
 * its paragraph look like a heading.
 *
 * Style-supplied values are left alone: this only fills gaps the cascade left, so
 * a properly styled document is unaffected.
 */
function withRunEvidence(
  base: StyleEvidence,
  p: XmlElement,
  state: ParseState,
): StyleEvidence {
  const runs = childrenNamed(p, "r");
  if (runs.length === 0) return base;

  const perRun = runs.map((r) => readProperties(undefined, childNamed(r, "rPr")));
  // A run with no properties at all cannot agree, so a paragraph mixing formatted
  // and unformatted runs is treated as having no shared formatting.
  const shared = <T,>(get: (e: PartialEvidence) => T | undefined): T | undefined => {
    const first = get(perRun[0]!);
    if (first === undefined) return undefined;
    return perRun.every((e) => get(e) === first) ? first : undefined;
  };

  const sizePt = shared((e) => e.font?.sizePt);
  const weight = shared((e) => e.font?.weight);
  const allCaps = shared((e) => e.font?.allCaps);
  const smallCaps = shared((e) => e.font?.smallCaps);

  // Direct run properties *override* what the cascade supplied, rather than only
  // filling gaps. This is layer 6 of the documented cascade beating layers 1 and 2, and
  // getting it backwards is not a subtle loss: docDefaults always supplies a size, so a
  // gap-filling version silently masked every run size and heading inference promoted
  // nothing at all on the one fixture built to require it.
  const font = { ...base.font };
  let touched = false;
  if (sizePt !== undefined && font.sizePt !== sizePt) { font.sizePt = sizePt; touched = true; }
  if (weight !== undefined && font.weight !== weight) { font.weight = weight; touched = true; }
  if (allCaps !== undefined && font.allCaps !== allCaps) { font.allCaps = allCaps; touched = true; }
  if (smallCaps !== undefined && font.smallCaps !== smallCaps) { font.smallCaps = smallCaps; touched = true; }
  if (!touched) return base;

  void state;
  // origin becomes directFormatting: the values came from runs the author formatted
  // by hand, and that is exactly the signal inference keys on.
  return { ...base, font, origin: "directFormatting" };
}

function parseInlineContainer(container: XmlElement, state: ParseState, locator: string): AnyNode[] {
  const out: AnyNode[] = [];
  const pPr = childNamed(container, "pPr");
  const styleId = val(pPr ? childNamed(pPr, "pStyle") : undefined);

  const ctx: RunContext = {
    cascade: state.cascade,
    diagnostics: state.diagnostics,
    relationships: state.relationships,
    resourceIds: state.resourceIds,
    recordEvidence: (node, evidence) => state.pendingEvidence.set(node, evidence),
    reportedMissingTheme: state.reportedMissingTheme,
    paragraphStyleId: styleId,
  };

  const walk = (el: XmlElement): AnyNode[] => {
    const acc: AnyNode[] = [];
    /** Comment id → where in `acc` its range opened. See `loadComments`. */
    const openComments = new Map<string, number>();
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
        // The anchors carry no text of their own: they mark where a range opens and
        // closes, and the comment wraps whatever the walk accumulated in between.
        // Swallowing them without recording the id is what made comments unrecoverable.
        case "commentRangeStart": {
          const id = attr(child, "id");
          if (id !== undefined) {
            state.commentAnchors.add(String(id));
            openComments.set(String(id), acc.length);
          }
          break;
        }
        case "commentRangeEnd": {
          const id = attr(child, "id");
          if (id === undefined) break;
          state.commentAnchors.add(String(id));
          const from = openComments.get(String(id));
          // No open mark means the range started in an earlier paragraph. The part in
          // this paragraph is reported by the paragraph that opened it, not wrapped twice.
          if (from === undefined) break;
          openComments.delete(String(id));
          const node = commentNode(state, String(id), acc.splice(from));
          if (node) acc.push(node);
          break;
        }
        case "commentReference": {
          // A reference with no range of its own is a point comment: Word anchors it at
          // this position and highlights nothing.
          const id = attr(child, "id");
          if (id === undefined) break;
          state.commentAnchors.add(String(id));
          if (openComments.has(String(id))) break;
          if (acc.some((n) => n["type"] === "comment" && n["commentId"] === String(id))) break;
          const node = commentNode(state, String(id), []);
          if (node) acc.push(node);
          break;
        }
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
        /*
         * OMML, as `equationBlock` with `notation: "omml"` — which is exactly what SPEC §2.3
         * declares the type is produced by, and what nothing produced until 2026-08-01.
         *
         * `m:oMathPara` wraps one or more `m:oMath` for display equations; a bare `m:oMath`
         * inline in a paragraph is the inline form. Both are captured, and the raw OMML is
         * kept in `source` rather than being flattened to its text: `t_ack = d/r` reduced to
         * the characters "tack = dr" is not an equation, it is the wreckage of one, and a
         * renderer that later learns OMML needs the markup rather than the residue.
         *
         * The node is emitted here and *unwrapped by `parseInlineContainer`'s caller* when
         * it is the paragraph's only content. `equationBlock` is block content, so a
         * paragraph holding one is not valid IR — which is what the first version produced
         * for every display equation in the corpus, four fixtures' worth, unnoticed because
         * nothing validated a parsed fixture.
         */
        case "oMathPara":
        case "oMath": {
          const node: AnyNode = {
            type: "equationBlock",
            notation: "omml",
            source: serializeElement(child),
          };
          state.pendingLocator.set(node, locator);
          acc.push(node);
          break;
        }

        default: {
          /*
           * Adapter rule A6: unknown before dropped.
           *
           * This branch was `break` — every unrecognised element inside a paragraph
           * vanished with no `unknown` node and no diagnostic, while the *block* walk
           * fifty lines above did exactly the right thing for its own unknowns. One
           * traversal obeyed A6 and its sibling did not.
           *
           * What that cost, measured before it was fixed: `templates/academic-manuscript.docx`
           * carries **five `<m:oMath>` display equations** — `build-reference-templates.mjs`
           * asserts they are there — and converting it produced a document with no equations
           * and **one** diagnostic, which was about something else. OMML is a sibling of
           * `w:r` inside `w:p`, so it took this path.
           *
           * The node-type census could not see it either, and the reason is worth recording:
           * the census diffs input IR against round-tripped IR, so it only sees types that
           * reach the IR at least once. A construct no adapter ever produces is absent from
           * both sides and scores as agreement. `equationBlock` read 0 against 0.
           */
          state.diagnostics.degraded(
            DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
            child.name,
            `Unhandled inline element ${child.name}; preserved as an unknown node so the ` +
              `loss is visible.`,
          );
          const unknown: AnyNode = {
            type: "unknown",
            construct: child.name,
            raw: textOf(child).slice(0, 200),
          };
          state.pendingLocator.set(unknown, locator);
          acc.push(unknown);
          break;
        }
      }
    }
    // A range that never closed: the comment covers text in a later paragraph, and a
    // phrasing node cannot. Truncated here, and said so.
    for (const [id, from] of openComments) {
      state.diagnostics.degraded(
        DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
        "w:commentRangeEnd",
        `Comment ${id} covers a range that crosses a paragraph boundary; the wrapping ` +
          `node holds only the part inside this paragraph.`,
        { locator: { kind: "ooxml", part: Part.DOCUMENT, xpath: locator } },
      );
      const node = commentNode(state, id, acc.splice(from));
      if (node) acc.push(node);
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

/**
 * Footnote and endnote bodies, as `footnoteDefinition` nodes.
 *
 * `runs.ts` has produced `footnoteReference` with `identifier: "fn<id>"` / `"en<id>"` since
 * Phase 1; nothing produced the other half, so every reference dangled. SPEC §3.1 claims both
 * are extracted, `CORPUS.md` §2.2 was never built, and no committed fixture had a footnote —
 * three conditions that between them kept it invisible for five phases. Mammoth recovers these
 * bodies, which is how `docs/MAMMOTH-DIFF.md` reported 21 tokens we lost on one file.
 *
 * Word writes two housekeeping entries into each part — `w:type="separator"` and
 * `"continuationSeparator"`, conventionally at ids -1 and 0 — carrying the horizontal rule
 * drawn above the notes. They are presentation, not content, and a reader that emitted them
 * would add two empty definitions to every document. They are skipped on the `w:type`
 * attribute rather than on the id, because the ids are a convention and the attribute is the
 * declaration.
 */
function parseNotes(state: ParseState): AnyNode[] {
  const out: AnyNode[] = [];
  const parts: Array<[string, string]> = [
    [Part.FOOTNOTES, "footnote"],
    [Part.ENDNOTES, "endnote"],
  ];

  for (const [partName, local] of parts) {
    const xml = state.pkg.xml(partName);
    if (!xml) continue;
    const prefix = local === "footnote" ? "fn" : "en";
    for (const note of childrenNamed(xml, local)) {
      // Presentation entries, not content.
      if (attr(note, "type")) continue;
      const id = attr(note, "id");
      if (id === undefined) continue;

      const locator = `/${partName}/w:${local}[@w:id='${id}']`;
      const children = parseBlockContainer(note, state, locator);
      if (children.length === 0) continue;

      const node: AnyNode = {
        type: "footnoteDefinition",
        identifier: `${prefix}${id}`,
        label: id,
        children,
      };
      state.pendingLocator.set(node, locator);
      out.push(node);
    }
  }
  return out;
}

/**
 * DOCX comments, read before the body so the walk can wrap the range they cover.
 *
 * SPEC §2.3 declares the type and §3.1 lists "comments with anchor ranges" under *Also
 * extracted*; nothing produced one until 2026-08-01, because `commentRangeStart`,
 * `commentRangeEnd`, and `commentReference` sat in `PROPERTY_ELEMENTS` and were dropped as
 * "not content" with no diagnostic. The specification described a capability that had never
 * been written — the class `docs/LIMITS.md` exists to stop.
 *
 * The first version of this reader emitted the comment at document level with an `anchors`
 * id list, on the reasoning that a range can cross paragraph boundaries and wrapping *that*
 * would mean restructuring the body. The reasoning was fine and the result was not: the
 * schema's `Comment` requires `children` and forbids everything else, so **every document
 * with a comment produced an invalid IR**, and no check noticed for a day. SPEC §2.3 chose
 * wrapping nodes deliberately — "so tree transforms cannot corrupt the anchor" — and an
 * adapter does not get to overrule the contract it writes to.
 *
 * So the range is wrapped where it can be: `w:commentRangeStart` marks a position in the
 * phrasing accumulator, `w:commentRangeEnd` splices everything after it into the comment's
 * children. A range that leaves the paragraph is truncated at the paragraph end with
 * MF-DOCX-0061 rather than silently, and a bare `w:commentReference` with no range is a
 * point comment with no children, which is what Word means by one.
 *
 * `commentsExtended.xml` carries the resolved flag (`w15:paraIdParent`/`w15:done`). It is read
 * when present; absent, `resolved` is false, which is what Word shows for a document written
 * before the extension existed.
 */
function loadComments(state: ParseState): void {
  const xml = state.pkg.xml(Part.COMMENTS);
  if (!xml) return;

  for (const c of childrenNamed(xml, "comment")) {
    const id = attr(c, "id");
    if (id === undefined) continue;
    const locator = `/${Part.COMMENTS}/w:comment[@w:id='${id}']`;
    const children = parseBlockContainer(c, state, locator);
    if (children.length === 0) continue;

    const record: CommentRecord = { body: rootOf(children) as unknown as AnyNode, resolved: false, locator };
    const author = attr(c, "author");
    const date = attr(c, "date");
    if (author) record.author = author;
    if (date) record.date = date;
    state.comments.set(id, record);
  }
}

/** Builds the wrapping node for one anchored comment id. */
function commentNode(state: ParseState, id: string, children: AnyNode[]): AnyNode | undefined {
  const record = state.comments.get(id);
  if (!record) return undefined;
  const node: AnyNode = {
    type: "comment",
    commentId: id,
    resolved: record.resolved,
    body: record.body,
    children,
  };
  if (record.author !== undefined) node["author"] = record.author;
  if (record.date !== undefined) node["date"] = record.date;
  state.pendingLocator.set(node, record.locator);
  return node;
}

/**
 * A comment in comments.xml that nothing in the body anchors.
 *
 * Word leaves these behind when an author deletes commented text. Emitting one would put
 * text in the document that no reader ever saw; dropping one silently is the loss this
 * project does not allow. So: dropped, and counted.
 */
function reportUnanchoredComments(state: ParseState): void {
  const orphans = [...state.comments.keys()].filter((id) => !state.commentAnchors.has(id));
  if (orphans.length === 0) return;
  state.diagnostics.lost(
    DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
    "w:comment",
    `${orphans.length} comment(s) in comments.xml are not anchored anywhere in the body ` +
      `(ids ${orphans.join(", ")}) and were dropped`,
    { locator: { kind: "ooxml", part: Part.COMMENTS, xpath: "/w:comments" } },
  );
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
      // OOXML distinguishes default/first/even headers via sectPr references. This reads
      // the parts themselves, so scope defaults to "default"; wiring sectPr up is not
      // implemented, and is recorded as such rather than guessed at.
      scope: "default",
      sectionIndex: 0,
      // A `root` node, not the bare children array.
      //
      // This was `parseBlockContainer(...) as unknown as Furniture["content"]` — a double
      // cast forcing an array into a field the schema declares as a `Root`, which is exactly
      // what a double cast is for and exactly why it was wrong. Every furniture-bearing
      // document failed `validateDocument` at `/furniture/0/content`, and nothing caught it
      // because no committed fixture had a header or a footer until the reference templates
      // of TEMPLATES.md §2.1 were built. ADR-0002 routes furniture rather than stripping it;
      // routing it into a shape the schema rejects is not much better than stripping it.
      content: rootOf(parseBlockContainer(xml, state, `/${partPath}`)),
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
  for (const f of doc.furniture) attach(f.content as unknown as AnyNode);
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
  for (const f of doc.furniture) walk(f.content as unknown as AnyNode);
  doc.provenance = next;
  doc.sidecar = nextSidecar;
}

export { parseRun } from "./runs.js";
