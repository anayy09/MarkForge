/**
 * @markforge/adapters-html — HTML to IR.
 *
 * HTML is the format where table span semantics are unambiguous, which is why
 * `docs/CORPUS.md` §2.5 uses HTML fixtures as ground truth for checking the DOCX
 * and PDF table paths. So this adapter's table handling has to be exactly right:
 * it is the reference the others are measured against.
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
  type StyleEvidence,
} from "@markforge/ir";
import {
  parseHtml,
  isElement,
  isText,
  textOf,
  type HtmlElement,
  type HtmlNode,
} from "./parse.js";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-html", version: "0.1.0" };

export interface HtmlParseOptions {
  path?: string;
  normalize?: boolean;
}

export interface HtmlParseResult {
  document: MarkForgeDocument;
  diagnostics: DiagnosticBag;
}

/** Elements carrying no semantics of their own; their children are the content. */
const TRANSPARENT = new Set([
  "#root", "html", "body", "div", "span", "main", "article", "section",
  "header", "footer", "nav", "aside", "center", "font", "tbody", "thead", "tfoot",
  "colgroup", "form", "fieldset", "label", "small", "big", "abbr", "cite", "time",
]);

/** Elements dropped entirely, with a diagnostic. */
const NON_CONTENT = new Set(["script", "style", "head", "meta", "link", "title", "base", "noscript"]);

const INLINE_MARK: Record<string, string> = {
  strong: "strong", b: "strong",
  em: "emphasis", i: "emphasis",
  del: "delete", s: "delete", strike: "delete",
  u: "underline", ins: "insertion",
  mark: "highlight",
  sub: "subscript", sup: "superscript",
};

export function parseHtmlDocument(
  source: string | Uint8Array,
  options: HtmlParseOptions = {},
): HtmlParseResult {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);

  const tree = parseHtml(text);
  const doc = emptyDocument();
  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "document.html",
    mediaType: "text/html",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  const evidence = new Map<AnyNode, StyleEvidence>();
  const blocks = convertChildren(tree, diagnostics, evidence);
  doc.body = { type: "root", children: blocks } as unknown as MarkForgeDocument["body"];

  doc.metadata = extractMetadata(tree);

  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
  attachSideTables(doc, sourceId, evidence);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    attachSideTables(doc, sourceId, evidence);
  }

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
}

function convertChildren(
  el: HtmlElement,
  diagnostics: DiagnosticBag,
  evidence: Map<AnyNode, StyleEvidence>,
): AnyNode[] {
  const out: AnyNode[] = [];
  for (const child of el.children) {
    const converted = convert(child, diagnostics, evidence);
    if (Array.isArray(converted)) out.push(...converted);
    else if (converted) out.push(converted);
  }
  return out;
}

function convert(
  node: HtmlNode,
  diagnostics: DiagnosticBag,
  evidence: Map<AnyNode, StyleEvidence>,
): AnyNode | AnyNode[] | null {
  if (isText(node)) {
    // Whitespace-only text between block elements is layout, not content. Keeping
    // it would put stray empty text nodes between every block.
    if (node.text.trim() === "") return node.text.includes("\n") ? null : { type: "text", value: node.text };
    return { type: "text", value: node.text };
  }
  if (!isElement(node)) return null;

  const tag = node.tag;

  if (NON_CONTENT.has(tag)) {
    if (tag === "script" || tag === "style") {
      diagnostics.info(
        DiagnosticCode.MD_UNKNOWN_CONSTRUCT,
        `<${tag}> dropped: it is presentation or behaviour, not document content.`,
      );
    }
    return null;
  }

  if (TRANSPARENT.has(tag)) return convertChildren(node, diagnostics, evidence);

  const kids = (): AnyNode[] => convertChildren(node, diagnostics, evidence);

  switch (tag) {
    case "p":
      return { type: "paragraph", children: kids() };

    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const depth = Number(tag[1]);
      const heading: AnyNode = { type: "heading", depth, resolvedLevel: depth, children: kids() };
      evidence.set(heading, { origin: "styleCascade", outlineLevel: depth - 1 });
      return heading;
    }

    case "ul": case "ol": {
      const list: AnyNode = {
        type: "list",
        ordered: tag === "ol",
        spread: false,
        children: kids().filter((c) => c.type === "listItem"),
      };
      const start = node.attrs["start"];
      if (tag === "ol" && start !== undefined) {
        const n = Number.parseInt(start, 10);
        if (Number.isFinite(n)) {
          list["start"] = n;
          if (n !== 1) list["restartsAt"] = n;
        }
      }
      return list;
    }

    case "li":
      // A list item's inline content is wrapped in a paragraph so the IR shape
      // matches what the DOCX and Markdown adapters produce; otherwise the same
      // document would have two shapes depending on which format it came from.
      return { type: "listItem", spread: false, children: ensureBlocks(kids()) };

    case "blockquote":
      return { type: "blockquote", children: ensureBlocks(kids()) };

    case "pre": {
      // <pre><code> is the standard pair; the language usually rides on a class.
      const code = node.children.find((c): c is HtmlElement => isElement(c) && c.tag === "code");
      const value = textOf(code ?? node);
      const className = (code ?? node).attrs["class"] ?? "";
      const lang = /language-([\w+-]+)/.exec(className)?.[1];
      const out: AnyNode = { type: "code", value: value.replace(/\n$/, "") };
      if (lang) out["lang"] = lang;
      return out;
    }

    case "code":
      return { type: "inlineCode", value: textOf(node) };

    case "hr":
      return { type: "thematicBreak" };

    case "br":
      return { type: "break" };

    case "a": {
      const href = node.attrs["href"];
      if (href === undefined) return kids();
      if (href.startsWith("#")) {
        return { type: "crossReference", targetKey: href.slice(1), kind: "heading", children: kids() };
      }
      const link: AnyNode = { type: "link", url: href, children: kids() };
      const title = node.attrs["title"];
      if (title) link["title"] = title;
      return link;
    }

    case "img": {
      const image: AnyNode = { type: "image", url: node.attrs["src"] ?? "" };
      const alt = node.attrs["alt"];
      // Absent alt and empty alt mean different things in HTML: empty is an
      // explicit "decorative", absent is "nobody said". The IR keeps them distinct.
      if (alt !== undefined) image["alt"] = alt;
      const title = node.attrs["title"];
      if (title) image["title"] = title;
      return image;
    }

    case "table":
      return convertTable(node, diagnostics, evidence);

    case "figure": {
      const children = kids();
      return { type: "figure", children };
    }
    case "figcaption":
      return { type: "caption", children: kids() };

    case "dl":
      return { type: "descriptionList", children: kids() };
    case "dt":
      return { type: "descriptionTerm", children: kids() };
    case "dd":
      return { type: "descriptionDetails", children: ensureBlocks(kids()) };

    default: {
      const mark = INLINE_MARK[tag];
      if (mark) return { type: mark, children: kids() };

      // A6: never drop silently. The tag name and its text survive so a renderer
      // can put something back and a reader can see what was lost.
      diagnostics.degraded(
        DiagnosticCode.MD_UNKNOWN_CONSTRUCT,
        `<${tag}>`,
        `HTML element <${tag}> has no IR node type; preserved as an unknown node with ` +
          `its text so nothing vanishes.`,
      );
      return { type: "unknown", originalType: `html:${tag}`, raw: textOf(node) };
    }
  }
}

const BLOCK = new Set([
  "paragraph", "heading", "list", "blockquote", "code", "table",
  "thematicBreak", "figure", "descriptionList",
]);

/**
 * Wraps *runs* of inline content in paragraphs, so a block container holds blocks.
 *
 * Run-wise, not all-or-nothing. `<li>text<ul>…</ul></li>` is the common shape and
 * mixes both: an all-or-nothing check sees the nested list, decides the children
 * are already blocks, and leaves the bare text as a direct child of the list item —
 * where every block renderer then ignores it, because a renderer walking blocks has
 * no reason to expect a text node. The text disappears with no diagnostic, which is
 * precisely the silent loss brief §3.3 forbids.
 */
function ensureBlocks(children: AnyNode[]): AnyNode[] {
  if (children.length === 0) return [];
  if (!children.some((c) => BLOCK.has(c.type))) return [{ type: "paragraph", children }];

  const out: AnyNode[] = [];
  let pending: AnyNode[] = [];
  const flush = (): void => {
    // Whitespace-only runs between blocks are layout, not content, and wrapping
    // them would add an empty paragraph between every pair of blocks.
    if (pending.length > 0 && pending.some((c) => c.type !== "text" || String(c["value"] ?? "").trim() !== "")) {
      out.push({ type: "paragraph", children: pending });
    }
    pending = [];
  };
  for (const child of children) {
    if (BLOCK.has(child.type)) {
      flush();
      out.push(child);
    } else {
      pending.push(child);
    }
  }
  flush();
  return out;
}

/**
 * Tables, including the span semantics that make HTML the ground truth for this
 * construct (`docs/CORPUS.md` §2.5).
 *
 * `rowspan` and `colspan` are read verbatim rather than reconstructed from an
 * occupancy grid, because in HTML they are stated rather than implied — which is
 * exactly why HTML is the reference the DOCX and PDF paths get compared against.
 */
function convertTable(
  el: HtmlElement,
  diagnostics: DiagnosticBag,
  evidence: Map<AnyNode, StyleEvidence>,
): AnyNode {
  const rows: AnyNode[] = [];
  let headerRows = 0;

  const collectRows = (container: HtmlElement, isHead: boolean): void => {
    for (const child of container.children) {
      if (!isElement(child)) continue;
      if (child.tag === "thead") { collectRows(child, true); continue; }
      if (child.tag === "tbody" || child.tag === "tfoot") { collectRows(child, false); continue; }
      if (child.tag !== "tr") continue;

      const cells: AnyNode[] = [];
      let allHeaderCells = child.children.length > 0;
      for (const cellEl of child.children) {
        if (!isElement(cellEl)) continue;
        if (cellEl.tag !== "td" && cellEl.tag !== "th") continue;
        if (cellEl.tag !== "th") allHeaderCells = false;

        const rowSpan = Number.parseInt(cellEl.attrs["rowspan"] ?? "1", 10);
        const colSpan = Number.parseInt(cellEl.attrs["colspan"] ?? "1", 10);
        cells.push(
          makeCell(ensureBlocks(convertChildren(cellEl, diagnostics, evidence)), {
            rowSpan: Number.isFinite(rowSpan) ? rowSpan : 1,
            colSpan: Number.isFinite(colSpan) ? colSpan : 1,
            isHeader: cellEl.tag === "th",
          }),
        );
      }

      rows.push({ type: "tableRow", children: cells });
      // A row inside <thead>, or made entirely of <th>, is a header row. Both
      // conventions appear in real documents and neither is a guess.
      if (isHead || allHeaderCells) headerRows = Math.max(headerRows, rows.length);
    }
  };

  collectRows(el, false);

  const tableNode: AnyNode = { type: "table", children: rows };
  if (headerRows > 0) tableNode["headerRowCount"] = headerRows;

  const caption = el.children.find((c): c is HtmlElement => isElement(c) && c.tag === "caption");
  if (caption) {
    return {
      type: "figure",
      children: [
        { type: "caption", children: convertChildren(caption, diagnostics, evidence) },
        tableNode,
      ],
    };
  }
  return tableNode;
}

function extractMetadata(root: HtmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (el: HtmlElement): void => {
    for (const c of el.children) {
      if (!isElement(c)) continue;
      if (c.tag === "title") out["title"] = textOf(c).trim();
      if (c.tag === "meta") {
        const name = (c.attrs["name"] ?? c.attrs["property"] ?? "").toLowerCase();
        const content = c.attrs["content"];
        if (!content) continue;
        if (name === "author") out["authors"] = [content];
        if (name === "keywords") out["keywords"] = content.split(",").map((k) => k.trim());
      }
      if (c.tag === "html" && c.attrs["lang"]) out["language"] = c.attrs["lang"];
      walk(c);
    }
  };
  walk(root);
  return out;
}

function attachSideTables(
  doc: MarkForgeDocument,
  sourceId: string,
  evidence: Map<AnyNode, StyleEvidence>,
): void {
  const provenance: Record<string, Provenance> = {};
  const sidecar: Record<string, StyleEvidence> = {};
  visit(doc.body as unknown as AnyNode, (n) => {
    if (typeof n.id !== "string") return;
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      // Byte offsets are not tracked by this parser, so the locator points at the
      // document. Rule A4 requires an entry to exist; a weak-but-true locator is
      // better than making provenance optional in practice.
      locator: { kind: "text", startOffset: 0, endOffset: 0 },
    };
    const e = evidence.get(n);
    if (e) sidecar[n.id] = e;
  });
  doc.provenance = provenance;
  doc.sidecar = sidecar;
}

export { parseHtml, decodeEntities, textOf } from "./parse.js";
export type { HtmlElement, HtmlNode } from "./parse.js";
