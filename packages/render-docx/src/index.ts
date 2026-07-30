/**
 * @markforge/render-docx — IR to DOCX.
 *
 * Two hard rules from brief §5.1, which diagnoses the user-visible complaint
 * precisely: generators emit inline run properties per run instead of resolving to
 * named styles, so changing a heading font means touching every heading.
 *
 *   1. **Named styles only.** Every block maps to a named paragraph style. Inline
 *      formatting is emitted only for genuine inline semantics. A heading may not
 *      carry direct font properties — asserted by a test, not by care.
 *   2. **Render into a reference document.** Its `styles.xml`, `theme1.xml`,
 *      `numbering.xml`, and section properties are copied verbatim.
 *
 * The writer is our own OOXML emitter rather than the `docx` library. ADR-0004
 * proposed `docx` and flagged the open risk that it may not reference style ids
 * defined in a reference package without redefining them — which is exactly the
 * thing rule 2 requires. Writing `document.xml` directly is a few hundred lines,
 * has no such risk, and is the inverse of the reader ADR-0005 already committed to.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  cellSpan,
  headerRowCount,
  type AnyNode,
  type MarkForgeDocument,
} from "@markforge/ir";
import {
  OpcPackage,
  Part,
  childrenNamed,
  attr,
  childNamed,
  val,
  encodeEntities,
  type XmlElement,
} from "@markforge/ooxml";
import { resolveStyle, reportCoverage, type AvailableStyle } from "./styles.js";

const RENDERER = { kind: "adapter" as const, name: "@markforge/render-docx", version: "0.1.0" };

export interface DocxRenderOptions {
  /** The `.docx`/`.dotx` whose styles are used. Required for good output. */
  referenceDoc?: Uint8Array;
  /** IR role → style name or style id. The primary path for third-party templates. */
  styleMap?: Record<string, string>;
  /** What to do when a role has no matching style. */
  onMissingStyle?: "warn" | "error" | "synthesize";
  revisionMode?: "clean" | "showInsertions" | "showAll";
}

export interface DocxRenderResult {
  bytes: Uint8Array;
  diagnostics: DiagnosticBag;
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function renderDocx(doc: MarkForgeDocument, options: DocxRenderOptions = {}): DocxRenderResult {
  const diagnostics = new DiagnosticBag(RENDERER);
  const styleMap = options.styleMap ?? {};
  const onMissing = options.onMissingStyle ?? "warn";

  const pkg = options.referenceDoc ? OpcPackage.open(options.referenceDoc) : OpcPackage.create();

  // The fallback styles.xml is installed *before* rendering, not after. Written the
  // other way round, `collectStyles` sees an empty package, every role resolves to
  // nothing, and the renderer synthesizes duplicates of styles the fallback was
  // about to define — producing a warning per role on every conversion that did not
  // supply a reference document, which is the common case.
  if (!pkg.has(Part.STYLES)) {
    pkg.set(Part.STYLES, minimalStyles());
    diagnostics.info(
      DiagnosticCode.RENDER_STYLE_MISSING,
      "No reference document supplied, so a minimal styles.xml is used. Output will be " +
        "structurally correct but visually plain; supply docx.referenceDoc for a document " +
        "that looks like your house style.",
    );
  }

  const available = collectStyles(pkg);

  const ctx: RenderContext = {
    diagnostics,
    styleMap,
    available,
    onMissing,
    revisionMode: options.revisionMode ?? "clean",
    synthesized: new Map(),
    numberingIds: new Map(),
    nextNumId: 1,
  };

  const bodyXml = renderBlocks(doc.body as unknown as AnyNode, ctx, doc);

  // Section properties come from the reference document when there is one, so page
  // size, margins, and columns are preserved rather than reset to defaults.
  const sectPr = options.referenceDoc ? extractSectPr(pkg) : DEFAULT_SECT_PR;

  ensureScaffold(pkg, ctx);
  pkg.set(
    Part.DOCUMENT,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${W_NS}><w:body>${bodyXml}${sectPr}</w:body></w:document>`,
  );

  if (ctx.synthesized.size > 0) {
    injectSynthesizedStyles(pkg, ctx);
  }

  return { bytes: pkg.toBytes(), diagnostics };
}

interface RenderContext {
  diagnostics: DiagnosticBag;
  styleMap: Record<string, string>;
  available: AvailableStyle[];
  onMissing: "warn" | "error" | "synthesize";
  revisionMode: "clean" | "showInsertions" | "showAll";
  synthesized: Map<string, string>;
  numberingIds: Map<string, number>;
  nextNumId: number;
}

function collectStyles(pkg: OpcPackage): AvailableStyle[] {
  const root = pkg.xml(Part.STYLES);
  if (!root) return [];
  const out: AvailableStyle[] = [];
  for (const style of childrenNamed(root, "style")) {
    const styleId = attr(style, "styleId");
    if (!styleId) continue;
    out.push({ styleId, name: val(childNamed(style, "name")) ?? styleId });
  }
  return out;
}

/**
 * Resolves a role to a style id, applying `onMissingStyle`.
 *
 * Synthesis derives from the reference document's own defaults rather than from
 * hardcoded values (SPEC §4.2.2). The difference is visible: a synthesized
 * `Heading 4` in a Times 10pt two-column paper must not arrive as Calibri 16pt,
 * which is the "uneven fonts" complaint we exist to fix, caused by us.
 */
function styleFor(role: string, ctx: RenderContext): string | undefined {
  const resolution = resolveStyle(role, ctx.styleMap, ctx.available);
  if (resolution.styleId) return resolution.styleId;

  const existing = ctx.synthesized.get(role);
  if (existing) return existing;

  if (ctx.onMissing === "error") {
    throw new Error(
      `render-docx: the reference document defines no style for role "${role}" ` +
        `(looked for "${resolution.wanted}"). Set docx.styleMap["${role}"] to a style ` +
        `the document actually defines, or use onMissingStyle: "synthesize".`,
    );
  }

  if (ctx.onMissing === "synthesize") {
    const styleId = synthesizeId(resolution.wanted);
    ctx.synthesized.set(role, styleId);
    ctx.diagnostics.degraded(
      DiagnosticCode.RENDER_STYLE_SYNTHESIZED,
      role,
      `No style named "${resolution.wanted}" in the reference document; synthesized one ` +
        `deriving from its docDefaults. Mapping this role explicitly via docx.styleMap ` +
        `gives better results than synthesis can.`,
    );
    return styleId;
  }

  ctx.diagnostics.degraded(
    DiagnosticCode.RENDER_STYLE_MISSING,
    role,
    `No style named "${resolution.wanted}" in the reference document; the paragraph is ` +
      `emitted with no named style and will inherit Normal. Set docx.styleMap["${role}"] ` +
      `to fix this.`,
  );
  return undefined;
}

const synthesizeId = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "") || "MarkForgeStyle";

function renderBlocks(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument): string {
  const children = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  return children.map((c) => renderBlock(c, ctx, doc)).join("");
}

function renderBlock(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument, listContext?: { numId: number; level: number }): string {
  switch (node.type) {
    case "paragraph":
      return paragraph(inlineRuns(node, ctx), styleFor("paragraph", ctx), listContext);

    case "heading": {
      const level = clampLevel(node, ctx);
      return paragraph(inlineRuns(node, ctx), styleFor(`heading:${level}`, ctx));
    }

    case "list":
      return renderList(node, ctx, doc);

    case "blockquote":
      return (Array.isArray(node.children) ? (node.children as AnyNode[]) : [])
        .map((c) =>
          c.type === "paragraph"
            ? paragraph(inlineRuns(c, ctx), styleFor("blockquote", ctx))
            : renderBlock(c, ctx, doc),
        )
        .join("");

    case "code": {
      // Each source line becomes its own paragraph: OOXML has no multi-line
      // paragraph, and a single paragraph with breaks loses the line structure that
      // makes code readable when the document is edited.
      const value = typeof node["value"] === "string" ? node["value"] : "";
      const style = styleFor("code", ctx);
      return value
        .split("\n")
        .map((line) => paragraph(`<w:r><w:t xml:space="preserve">${encodeEntities(line)}</w:t></w:r>`, style))
        .join("");
    }

    case "table":
      return renderTable(node, ctx, doc);

    case "thematicBreak":
      // A bottom border on an empty paragraph is how Word draws a horizontal rule.
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`;

    case "pageBreak":
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

    case "root":
    case "section":
      return renderBlocks(node, ctx, doc);

    case "footnoteDefinition":
      // Footnote bodies live in footnotes.xml, which Phase 1 does not write. The
      // content is emitted inline rather than dropped, and the diagnostic says so.
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "footnoteDefinition",
        "Footnote bodies are emitted as body paragraphs: writing footnotes.xml is Phase 2 " +
          "work. The text is preserved, its placement is not.",
      );
      return renderBlocks(node, ctx, doc);

    case "html":
    case "unknown": {
      const raw = typeof node["value"] === "string" ? node["value"] : String(node["raw"] ?? "");
      if (raw.trim().length === 0) return "";
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        node.type,
        `Raw ${node.type} content has no DOCX representation; emitted as literal text so ` +
          `it survives visibly rather than vanishing.`,
      );
      return paragraph(`<w:r><w:t xml:space="preserve">${encodeEntities(raw)}</w:t></w:r>`, undefined);
    }

    case "yaml":
    case "toml":
      // Front matter is document metadata, not body content. Dropping it here is
      // correct, and it is preserved in doc.metadata.
      return "";

    default: {
      if (Array.isArray(node.children)) return renderBlocks(node, ctx, doc);
      return "";
    }
  }
}

function clampLevel(node: AnyNode, ctx: RenderContext): number {
  const resolved = typeof node["resolvedLevel"] === "number" ? node["resolvedLevel"] : 1;
  if (resolved > 9) {
    ctx.diagnostics.degraded(
      DiagnosticCode.RENDER_DEPTH_CLAMPED,
      "heading",
      `Heading level ${resolved} clamped to 9: Word defines Heading 1 through Heading 9.`,
    );
    return 9;
  }
  return Math.max(1, resolved);
}

function paragraph(runs: string, styleId: string | undefined, list?: { numId: number; level: number }): string {
  const parts: string[] = [];
  if (styleId) parts.push(`<w:pStyle w:val="${encodeEntities(styleId)}"/>`);
  if (list) {
    parts.push(`<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.numId}"/></w:numPr>`);
  }
  const pPr = parts.length > 0 ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runs}</w:p>`;
}

/**
 * Inline content to runs.
 *
 * This is where rule 1 lives. The mark stack produces `w:rPr` containing **only**
 * inline semantics — bold, italic, strike, underline, sub/superscript, small caps,
 * highlight. Never a font family, never a size, never a colour from a style. Those
 * belong to the named style, which is the entire argument of brief §5.1.
 */
function inlineRuns(node: AnyNode, ctx: RenderContext, marks: Set<string> = new Set()): string {
  const children = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  let out = "";

  for (const child of children) {
    switch (child.type) {
      case "text": {
        const value = typeof child["value"] === "string" ? child["value"] : "";
        if (value === "") break;
        out += run(value, marks, ctx);
        break;
      }
      case "inlineCode": {
        const value = typeof child["value"] === "string" ? child["value"] : "";
        const style = styleFor("inlineCode", ctx);
        const rPr = style ? `<w:rPr><w:rStyle w:val="${encodeEntities(style)}"/></w:rPr>` : "";
        out += `<w:r>${rPr}<w:t xml:space="preserve">${encodeEntities(value)}</w:t></w:r>`;
        break;
      }
      case "strong":
        out += inlineRuns(child, ctx, new Set([...marks, "b"]));
        break;
      case "emphasis":
        out += inlineRuns(child, ctx, new Set([...marks, "i"]));
        break;
      case "delete":
        out += inlineRuns(child, ctx, new Set([...marks, "strike"]));
        break;
      case "underline":
        out += inlineRuns(child, ctx, new Set([...marks, "u"]));
        break;
      case "smallCaps":
        out += inlineRuns(child, ctx, new Set([...marks, "smallCaps"]));
        break;
      case "subscript":
        out += inlineRuns(child, ctx, new Set([...marks, "sub"]));
        break;
      case "superscript":
        out += inlineRuns(child, ctx, new Set([...marks, "sup"]));
        break;
      case "highlight":
        out += inlineRuns(child, ctx, new Set([...marks, "highlight"]));
        break;
      case "break":
        out += `<w:r><w:br/></w:r>`;
        break;
      case "link": {
        // Without writing a relationship part, the URL would be lost. Emitting it as
        // visible text keeps the information in the document rather than dropping it.
        const label = textOf(child);
        const url = typeof child["url"] === "string" ? child["url"] : "";
        out += run(label, new Set([...marks, "u"]), ctx);
        if (url && url !== label) out += run(` (${url})`, marks, ctx);
        break;
      }
      case "deletion":
        if (ctx.revisionMode === "clean") break;
        out += inlineRuns(child, ctx, new Set([...marks, "strike"]));
        break;
      case "insertion":
        out += inlineRuns(child, ctx, marks);
        break;
      case "image": {
        const alt = typeof child["alt"] === "string" ? child["alt"] : "image";
        ctx.diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          "image",
          "Images are emitted as alt-text placeholders: embedding image parts and their " +
            "relationships is Phase 2 work.",
        );
        out += run(`[${alt}]`, marks, ctx);
        break;
      }
      default:
        if (Array.isArray(child.children)) out += inlineRuns(child, ctx, marks);
        break;
    }
  }

  return out;
}

function run(text: string, marks: Set<string>, _ctx: RenderContext): string {
  if (text === "") return "";
  const props: string[] = [];
  // Emitted in a fixed order so identical formatting always produces identical
  // bytes; Set iteration order would otherwise depend on insertion order.
  if (marks.has("b")) props.push("<w:b/>");
  if (marks.has("i")) props.push("<w:i/>");
  if (marks.has("strike")) props.push("<w:strike/>");
  if (marks.has("u")) props.push('<w:u w:val="single"/>');
  if (marks.has("smallCaps")) props.push("<w:smallCaps/>");
  if (marks.has("highlight")) props.push('<w:highlight w:val="yellow"/>');
  if (marks.has("sub")) props.push('<w:vertAlign w:val="subscript"/>');
  if (marks.has("sup")) props.push('<w:vertAlign w:val="superscript"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${encodeEntities(text)}</w:t></w:r>`;
}

function renderList(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument, level = 0): string {
  const ordered = node["ordered"] === true;
  const start = typeof node["start"] === "number" ? node["start"] : 1;
  const key = `${ordered ? "ol" : "ul"}:${start}:${level}`;
  let numId = ctx.numberingIds.get(key);
  if (numId === undefined) {
    numId = ctx.nextNumId++;
    ctx.numberingIds.set(key, numId);
  }

  const items = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  let out = "";
  for (const item of items) {
    const blocks = Array.isArray(item.children) ? (item.children as AnyNode[]) : [];
    for (const block of blocks) {
      if (block.type === "list") {
        out += renderList(block, ctx, doc, level + 1);
      } else if (block.type === "paragraph") {
        out += paragraph(inlineRuns(block, ctx), styleFor("paragraph", ctx), { numId, level });
      } else {
        out += renderBlock(block, ctx, doc);
      }
    }
  }
  return out;
}

function renderTable(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument): string {
  const rows = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  const headerRows = headerRowCount(node);
  const tableStyle = styleFor("table", ctx);

  const columnCount = Math.max(
    1,
    ...rows.map((r) => (Array.isArray(r.children) ? (r.children as AnyNode[]).length : 0)),
  );

  const grid = `<w:tblGrid>${"<w:gridCol/>".repeat(columnCount)}</w:tblGrid>`;
  const tblPr =
    `<w:tblPr>${tableStyle ? `<w:tblStyle w:val="${encodeEntities(tableStyle)}"/>` : ""}` +
    `<w:tblW w:w="0" w:type="auto"/></w:tblPr>`;

  const body = rows
    .map((row, rowIndex) => {
      const cells = Array.isArray(row.children) ? (row.children as AnyNode[]) : [];
      const trPr = rowIndex < headerRows ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      const tcs = cells
        .map((cell) => {
          const { rowSpan, colSpan } = cellSpan(cell);
          const props: string[] = [];
          if (colSpan > 1) props.push(`<w:gridSpan w:val="${colSpan}"/>`);
          if (rowSpan > 1) props.push(`<w:vMerge w:val="restart"/>`);
          const tcPr = props.length > 0 ? `<w:tcPr>${props.join("")}</w:tcPr>` : "";
          // mdast puts phrasing content *directly* in a tableCell with no paragraph
          // wrapper, while a DOCX cell from our own reader holds block content. Both
          // shapes reach here, so the cell is inspected rather than assumed: if it
          // has no block-level children, the whole cell is one paragraph's worth of
          // inline content.
          const cellChildren = Array.isArray(cell.children) ? (cell.children as AnyNode[]) : [];
          const hasBlocks = cellChildren.some((c) => BLOCK_TYPES.has(c.type));
          let content = hasBlocks
            ? cellChildren
                .map((c) =>
                  c.type === "paragraph" || c.type === "heading"
                    ? paragraph(inlineRuns(c, ctx), styleFor("paragraph", ctx))
                    : renderBlock(c, ctx, doc),
                )
                .join("")
            : paragraph(inlineRuns(cell, ctx), styleFor("paragraph", ctx));

          // OOXML requires at least one paragraph per cell; a cell that renders to
          // nothing would make the file unopenable rather than merely empty.
          if (content.trim() === "") content = "<w:p/>";
          return `<w:tc>${tcPr}${content}</w:tc>`;
        })
        .join("");
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    })
    .join("");

  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
}

/** Block-level IR node types, used to tell a block cell from an inline one. */
const BLOCK_TYPES = new Set([
  "paragraph", "heading", "list", "blockquote", "code", "table", "thematicBreak",
  "figure", "caption", "admonition", "equationBlock", "descriptionList", "pageBreak",
  "footnoteDefinition", "section", "textBox",
]);

const DEFAULT_SECT_PR =
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
  `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
  `</w:sectPr>`;

function extractSectPr(pkg: OpcPackage): string {
  const documentXml = pkg.xml(Part.DOCUMENT);
  const body = documentXml ? childNamed(documentXml, "body") : undefined;
  const sectPr = body ? childNamed(body, "sectPr") : undefined;
  return sectPr ? serialize(sectPr) : DEFAULT_SECT_PR;
}

/** Serialises an element back to XML, for parts copied verbatim. */
function serialize(el: XmlElement): string {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
    .join("");
  const children = el.children
    .map((c) => ("name" in c ? serialize(c) : encodeEntities(c.text)))
    .join("");
  return children.length > 0 ? `<${el.name}${attrs}>${children}</${el.name}>` : `<${el.name}${attrs}/>`;
}

/** Writes the parts a DOCX needs in order to open at all. */
function ensureScaffold(pkg: OpcPackage, ctx: RenderContext): void {
  if (!pkg.has(Part.CONTENT_TYPES)) {
    pkg.set(
      Part.CONTENT_TYPES,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
        `</Types>`,
    );
  }
  if (!pkg.has(Part.ROOT_RELS)) {
    pkg.set(
      Part.ROOT_RELS,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    );
  }
  if (!pkg.has(Part.DOCUMENT_RELS)) {
    pkg.set(
      Part.DOCUMENT_RELS,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
        `</Relationships>`,
    );
  }
  pkg.set(Part.NUMBERING, numberingXml(ctx));
}

/**
 * A minimal styles.xml for when no reference document was supplied.
 *
 * Deliberately plain. This is a fallback, not a design: the whole argument of
 * ADR-0004 is that the user's reference document decides how the output looks.
 */
function minimalStyles(): string {
  const heading = (n: number, sizeHalfPoints: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="Heading ${n}"/>` +
    `<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sizeHalfPoints}"/></w:rPr></w:style>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/></w:style>` +
    heading(1, 36) + heading(2, 32) + heading(3, 28) + heading(4, 24) + heading(5, 22) + heading(6, 22) +
    heading(7, 22) + heading(8, 22) + heading(9, 22) +
    `<w:style w:type="paragraph" w:styleId="BlockText"><w:name w:val="Block Text"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:ind w:left="720"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/><w:basedOn w:val="Normal"/>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:styleId="Table"><w:name w:val="Table"/>` +
    `<w:tblPr><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/>` +
    `<w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/>` +
    `<w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/>` +
    `</w:tblBorders></w:tblPr></w:style>` +
    `</w:styles>`
  );
}

/** Numbering definitions for the lists actually emitted. */
function numberingXml(ctx: RenderContext): string {
  const entries = [...ctx.numberingIds.entries()];
  const abstracts = entries
    .map(([key, numId]) => {
      const ordered = key.startsWith("ol");
      const start = Number.parseInt(key.split(":")[1] ?? "1", 10);
      const levels = Array.from({ length: 9 }, (_, i) => {
        const indent = 720 * (i + 1);
        const fmt = ordered ? (i % 3 === 0 ? "decimal" : i % 3 === 1 ? "lowerLetter" : "lowerRoman") : "bullet";
        const text = ordered ? `%${i + 1}.` : "•";
        return (
          `<w:lvl w:ilvl="${i}"><w:start w:val="${i === 0 ? start : 1}"/>` +
          `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${encodeEntities(text)}"/>` +
          `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }).join("");
      return `<w:abstractNum w:abstractNumId="${numId}">${levels}</w:abstractNum>`;
    })
    .join("");

  const nums = entries.map(([, numId]) => `<w:num w:numId="${numId}"><w:abstractNumId w:val="${numId}"/></w:num>`).join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering ${W_NS}>${abstracts}${nums}</w:numbering>`
  );
}

/**
 * Adds synthesized styles to the reference document's styles.xml.
 *
 * `basedOn Normal` is what makes synthesis acceptable: the new style inherits the
 * reference document's own font and size rather than imposing ours, so a
 * synthesized `Heading 4` in a Times 10pt paper stays Times.
 */
function injectSynthesizedStyles(pkg: OpcPackage, ctx: RenderContext): void {
  const existing = pkg.text(Part.STYLES) ?? minimalStyles();
  const additions = [...ctx.synthesized.entries()]
    .map(([role, styleId]) => {
      const headingMatch = /^heading:(\d)$/.exec(role);
      const outline = headingMatch ? `<w:outlineLvl w:val="${Number(headingMatch[1]) - 1}"/>` : "";
      const bold = headingMatch ? "<w:b/>" : "";
      return (
        `<w:style w:type="paragraph" w:styleId="${encodeEntities(styleId)}">` +
        `<w:name w:val="${encodeEntities(styleId)}"/><w:basedOn w:val="Normal"/>` +
        `<w:pPr>${outline}</w:pPr><w:rPr>${bold}</w:rPr></w:style>`
      );
    })
    .join("");
  pkg.set(Part.STYLES, existing.replace("</w:styles>", `${additions}</w:styles>`));
}

function textOf(node: AnyNode): string {
  let out = "";
  const walk = (n: AnyNode): void => {
    if ((n.type === "text" || n.type === "inlineCode") && typeof n["value"] === "string") out += n["value"];
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(node);
  return out;
}

export { reportCoverage, resolveStyle, PANDOC_STYLES, ALL_PANDOC_STYLE_NAMES } from "./styles.js";
export type { AvailableStyle, CoverageReport, StyleResolution, StyleRole } from "./styles.js";
