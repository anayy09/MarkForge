/**
 * @markforge/render-docx — IR to DOCX.
 *
 * Two hard rules from SPEC §4.2, which diagnoses the user-visible complaint
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
  fromBase64,
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
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  // `wp` is required by the `w:drawing` an embedded image emits. Declared on the document
  // element rather than on each drawing: an undeclared prefix makes the whole part
  // unparseable, and Word reports that as a corrupt file rather than as a missing image.
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

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
    numbering: [],
    nextNumId: 1,
    hyperlinks: [],
    footnotes: [],
    media: new Map(),
    resources: doc.resources ?? {},
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
  /** One entry per allocated numbering id. Nested levels share their parent's. */
  numbering: { numId: number; ordered: boolean; start: number }[];
  nextNumId: number;
  /** Hyperlink targets in allocation order, so each gets a stable relationship id. */
  hyperlinks: string[];
  /**
   * Footnote bodies, collected while rendering and written to `footnotes.xml` afterwards.
   *
   * They cannot be written before the body, because the body is what discovers them — the
   * same ordering constraint the hyperlink relationships have.
   */
  footnotes: { id: number; xml: string }[];
  /** Embedded media, keyed by resource id so one image used twice is stored once. */
  media: Map<string, { rel: string; part: string; bytes: Uint8Array; extension: string }>;
  /**
   * The document's resource table.
   *
   * On the context rather than threaded through `inlineRuns`, because it is cross-cutting
   * state read at one leaf and needed nowhere in between — the same reason `hyperlinks`
   * and `footnotes` live here.
   */
  resources: MarkForgeDocument["resources"];
}

/**
 * Word reserves footnote ids -1 and 0 for the separator and continuation-separator
 * entries, so real footnotes start at 1. A reader that mistakes those two for content adds
 * two empty notes to every document — which is why `fixtures/docx/manuscript-footnotes-
 * equations.docx` carries them.
 */
const FIRST_FOOTNOTE_ID = 1;

/**
 * The named styles a reference document defines.
 *
 * Exported for `markforge check --reference-doc` (SPEC §4.2.1): the command needs the same
 * list the renderer resolves against, and reading `styles.xml` a second way in the CLI
 * would let the two disagree about what a template offers.
 */
export function readAvailableStyles(referenceDoc: Uint8Array): AvailableStyle[] {
  return collectStyles(OpcPackage.open(referenceDoc));
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
/**
 * Maps a mdast footnote `identifier` to the numeric id OOXML wants.
 *
 * Allocation is by first sight and is shared by the reference and the definition, which is
 * what makes the two point at each other. Order is the document's, so two runs of the same
 * input allocate the same ids — a `Map` keyed on identifier would not be enough on its own,
 * because iteration order has to be insertion order for the numbering to be stable.
 */
const footnoteIds = new WeakMap<RenderContext, Map<string, number>>();
function footnoteIdFor(identifier: string, ctx: RenderContext): number {
  let seen = footnoteIds.get(ctx);
  if (!seen) {
    seen = new Map();
    footnoteIds.set(ctx, seen);
  }
  const existing = seen.get(identifier);
  if (existing !== undefined) return existing;
  const id = seen.size + FIRST_FOOTNOTE_ID;
  seen.set(identifier, id);
  return id;
}

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

/**
 * Allocates a relationship id for a hyperlink target, reusing it for a repeated URL.
 *
 * Ids start at rId3: rId1 and rId2 belong to styles.xml and numbering.xml in the
 * scaffold below. Colliding with those produces a file Word refuses to open, which is
 * slow to diagnose from a generic error dialog.
 */
function registerHyperlink(ctx: RenderContext, url: string): string {
  const existing = ctx.hyperlinks.indexOf(url);
  const index = existing === -1 ? ctx.hyperlinks.push(url) - 1 : existing;
  return `rId${index + HYPERLINK_REL_BASE}`;
}

const HYPERLINK_REL_BASE = 3;
const HYPERLINK_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const synthesizeId = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "") || "MarkForgeStyle";

/**
 * Renders a node's children as blocks, gathering inline siblings into paragraphs.
 *
 * The gathering is not tidiness. OOXML has no place to put a bare run outside a
 * `w:p`, and several IR nodes hold inline children directly: a `figure` holds an
 * `image`, a `descriptionTerm` holds text. Sending those to `renderBlock` finds no
 * case for them, so before this existed a description list's terms were **not
 * written at all** and an image inside a figure vanished — while the block switch
 * reported them as constructs with "no children to fall back on", which was true
 * and beside the point.
 *
 * Consecutive inline siblings share one paragraph, because that is what they were:
 * splitting `text, strong, text` into three paragraphs would break one sentence into
 * three.
 */
function renderBlocks(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument): string {
  const children = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  let out = "";
  let pending: AnyNode[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    out += paragraph(
      inlineRuns({ type: "root", children: pending } as AnyNode, ctx),
      styleFor("paragraph", ctx),
    );
    pending = [];
  };

  for (const c of children) {
    if (BLOCK_TYPES.has(c.type)) {
      flush();
      out += renderBlock(c, ctx, doc);
    } else {
      pending.push(c);
    }
  }
  flush();
  return out;
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

    case "footnoteDefinition": {
      /*
       * Written to `footnotes.xml` as of 2026-08-01. Until then the body was emitted as
       * ordinary paragraphs with a diagnostic saying so — the text preserved, its placement
       * not — which was `STATUS.md`'s second-largest measured loss.
       *
       * The definition renders to XML here and is *stashed*, not emitted: it belongs in a
       * different part, and the reference run that points at it was already emitted at the
       * call site. Returning "" is correct rather than lossy, which is why no diagnostic
       * fires.
       */
      const identifier = typeof node["identifier"] === "string" ? node["identifier"] : "";
      const id = footnoteIdFor(identifier, ctx);
      const inner = renderBlocks(node, ctx, doc);
      ctx.footnotes.push({
        id,
        // `FootnoteText` is Pandoc's name for the style, so a Pandoc reference document
        // styles these correctly with no mapping (SPEC §4.2).
        xml: `<w:footnote w:id="${id}">${inner || paragraph("", styleFor("footnoteText", ctx))}</w:footnote>`,
      });
      return "";
    }

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

    /*
     * DOCX has no figure, caption, or description-list element, so these are carried by the
     * **named-style convention** SPEC §4.2 already uses for blockquotes — which is why
     * `styles.ts` has had `figure`, `caption`, `descriptionTerm`, and `descriptionDetails`
     * roles all along, mapping onto Pandoc's own names.
     *
     * That makes them recoverable: `@markforge/infer` reads the style name back, the same
     * shape as `inferBlockquotes` and `inferCodeAndBreaks`. Before this, all four fell to
     * `default`, were unwrapped into loose paragraphs, and the construct was destroyed with
     * a diagnostic saying so — which is honest and is not a round trip.
     */
    case "equationBlock": {
      /*
       * OMML is written straight back, because the adapter kept the markup rather than the
       * flattened characters (`equationBlock.source`, ADR-0022's sibling change). This is the
       * whole payoff of retaining the source: `t_ack = d/r` reduced to "tack = dr" could not
       * have been rebuilt into an equation by anything downstream.
       *
       * Any other notation is reported. Converting TeX to OMML is a real converter and not
       * one this project has.
       */
      const notation = node["notation"];
      const source = typeof node["source"] === "string" ? node["source"] : "";
      if (notation === "omml" && source !== "") return paragraph(source, undefined);
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "equationBlock",
        `DOCX equations are OMML and this one is ${String(notation)}; there is no converter ` +
          `here, so the source is emitted as literal text.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
      return paragraph(`<w:r><w:t xml:space="preserve">${encodeEntities(source)}</w:t></w:r>`, undefined);
    }

    case "figure":
      // The figure's own children carry the styles; the wrapper contributes the caption
      // binding, which the caption's style records.
      return renderBlocks(node, ctx, doc);

    case "caption": {
      // `for` distinguishes a table caption from a figure caption, and Pandoc names them
      // differently, so the role is looked up with the qualifier when there is one.
      const forKind = typeof node["for"] === "string" ? node["for"] : undefined;
      const role =
        forKind !== undefined && styleFor(`caption:${forKind}`, ctx) !== undefined
          ? `caption:${forKind}`
          : "caption";
      return paragraph(inlineRuns(node, ctx), styleFor(role, ctx));
    }

    case "descriptionList":
      return renderBlocks(node, ctx, doc);

    case "descriptionTerm":
      return paragraph(inlineRuns(node, ctx), styleFor("descriptionTerm", ctx));

    case "descriptionDetails":
      return paragraph(inlineRuns(node, ctx), styleFor("descriptionDetails", ctx));

    default: {
      // Unwrapping keeps the text, but the node type itself is gone — a description
      // list becomes loose paragraphs, a figure loses the binding between image and
      // caption. That is a real loss and it must be reported: this branch was silent,
      // so `html -> docx -> html` dropped nine node types while emitting exactly one
      // diagnostic, and it was the node-type census rather than any test that noticed.
      //
      // Reported here in the `default` branch rather than case by case, so a node type
      // added to the IR later cannot slip through unreported by being forgotten.
      if (Array.isArray(node.children)) {
        ctx.diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          node.type,
          `"${node.type}" has no DOCX representation: its children are written, so no ` +
            `text is lost, but the construct itself is. Render to HTML to keep it.`,
          ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
        );
        return renderBlocks(node, ctx, doc);
      }
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        node.type,
        `"${node.type}" has no DOCX representation and no children to fall back on, so ` +
          `it is not written at all.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
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
 * belong to the named style, which is the entire argument of SPEC §4.2.
 */
/**
 * Embeds an image as a media part and returns the `w:drawing` that references it.
 *
 * Returns `undefined` when there are no bytes, so the caller can degrade and report rather
 * than emit a drawing pointing at a relationship that does not exist — a package Word opens
 * and silently shows an empty frame in, which is worse than visible alt text.
 *
 * Sizing: EMUs, 914400 per inch. The IR records pixels when it knows them; at 96 DPI that is
 * 9525 EMU per pixel. Absent dimensions fall back to a 4-inch box rather than zero, because a
 * zero-sized drawing is invisible and looks exactly like the loss this replaced.
 */
/**
 * Revision ids, unique per document.
 *
 * Word tolerates duplicates and then merges two unrelated edits into one revision when a
 * user accepts either, which is a data defect that looks like a UI quirk.
 */
const revisionIds = new WeakMap<RenderContext, { next: number }>();
function nextRevisionId(ctx: RenderContext): number {
  let counter = revisionIds.get(ctx);
  if (!counter) {
    counter = { next: 1 };
    revisionIds.set(ctx, counter);
  }
  return counter.next++;
}

/**
 * `w:author` and `w:date` for a revision.
 *
 * The date is the one the source recorded, never `new Date()`: SPEC §1.1 forbids reading the
 * wall clock, and a writer that stamped today would make two conversions of one input differ.
 * Absent, the attribute is omitted rather than filled with the epoch, because an omitted date
 * is unknown and 1970 is a claim.
 */
function revisionAttrs(node: AnyNode): string {
  const author = typeof node["author"] === "string" ? node["author"] : "";
  const date = typeof node["date"] === "string" ? node["date"] : undefined;
  return `w:author="${encodeEntities(author)}"${date ? ` w:date="${encodeEntities(date)}"` : ""}`;
}

function embedImage(node: AnyNode, ctx: RenderContext): string | undefined {
  const resourceId = typeof node["resourceId"] === "string" ? node["resourceId"] : undefined;
  if (resourceId === undefined) return undefined;
  const resource = ctx.resources[resourceId];
  if (!resource || typeof resource.data !== "string" || resource.data === "") return undefined;

  let entry = ctx.media.get(resourceId);
  if (!entry) {
    const extension = (resource.mediaType.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const index = ctx.media.size;
    entry = {
      // Media ids sit above hyperlinks and footnotes; see `relBaseAfterHyperlinks`.
      rel: `rId${relBaseAfterHyperlinks(ctx) + (ctx.footnotes.length > 0 ? 1 : 0) + index}`,
      part: `word/media/image${index + 1}.${extension}`,
      bytes: fromBase64(resource.data),
      extension,
    };
    ctx.media.set(resourceId, entry);
  }

  const EMU_PER_PX = 9525;
  const cx = Math.round((resource.widthPx ?? 384) * EMU_PER_PX);
  const cy = Math.round((resource.heightPx ?? 288) * EMU_PER_PX);
  const alt = encodeEntities(typeof node["alt"] === "string" ? node["alt"] : "");
  const docPrId = ctx.media.size;

  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${alt}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="Picture ${docPrId}" descr="${alt}"/>` +
    `<pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${entry.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function inlineRuns(
  node: AnyNode,
  ctx: RenderContext,
  marks: Set<string> = new Set(),
  characterStyle?: string | undefined,
): string {
  const children = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  let out = "";

  for (const child of children) {
    switch (child.type) {
      case "text": {
        const value = typeof child["value"] === "string" ? child["value"] : "";
        if (value === "") break;
        out += run(value, marks, ctx, characterStyle);
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
        // A real w:hyperlink with a relationship, not the URL flattened into prose.
        //
        // An earlier version emitted the label underlined followed by "(url)" in body
        // text, reasoning that visible beats dropped. It was worse than dropped: the
        // link *type* was destroyed, the URL became prose a reader has to untangle, and
        // the round trip reported an invented `underline` where a `link` had been.
        // Pandoc preserves the link, so there was no excuse.
        const url = typeof child["url"] === "string" ? child["url"] : "";
        if (url === "") {
          out += inlineRuns(child, ctx, marks);
          break;
        }
        const relationshipId = registerHyperlink(ctx, url);
        const linkStyle = styleFor("link", ctx);
        const inner = inlineRuns(child, ctx, marks, linkStyle);
        out += `<w:hyperlink r:id="${relationshipId}">${inner}</w:hyperlink>`;
        break;
      }
      case "equationBlock": {
        /*
         * An equation reaches `inlineRuns` whenever it sits inside a paragraph, which is
         * where the DOCX adapter puts it — OMML is a sibling of `w:r`, not a block. The
         * block switch had a case for it and this one did not, so five equations in the
         * shipped template were written as nothing at all, with no diagnostic.
         *
         * That is the third instance this phase of one traversal handling a type its sibling
         * drops. The pattern is worth more than the fix: a node type that can appear in both
         * positions needs a case in both walks, and a census across the pair is what shows it.
         */
        const notation = child["notation"];
        const source = typeof child["source"] === "string" ? child["source"] : "";
        if (notation === "omml" && source !== "") {
          out += source;
          break;
        }
        ctx.diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          "equationBlock",
          `DOCX equations are OMML and this one is ${String(notation)}; the source is ` +
            `emitted as literal text.`,
        );
        out += run(source, marks, ctx);
        break;
      }
      case "footnoteReference": {
        // Emitted nothing before 2026-08-01: this type had no case, and the `default`
        // branch walks children — of which a reference has none. So the marker vanished
        // even in the version that emitted the body as paragraphs, and a reader saw
        // neither a note nor a hole where one had been.
        const identifier = typeof child["identifier"] === "string" ? child["identifier"] : "";
        const id = footnoteIdFor(identifier, ctx);
        const refStyle = styleFor("footnoteReference", ctx);
        out +=
          `<w:r>${refStyle ? `<w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr>` : ""}` +
          `<w:footnoteReference w:id="${id}"/></w:r>`;
        break;
      }
      case "deletion": {
        // `clean` drops it entirely, which is what "clean" means. `showInsertions` shows
        // insertions only, so a deletion is still dropped there — the mode names exactly
        // three behaviours and this is the one that distinguishes the middle from the last.
        if (ctx.revisionMode !== "showAll") break;
        const inner = inlineRuns(child, ctx, marks);
        // Deleted text lives in `w:delText`, not `w:t`. A reader that sees `w:t` inside
        // `w:del` treats it as present text, so the deletion would round-trip as content.
        out +=
          `<w:del w:id="${nextRevisionId(ctx)}" ${revisionAttrs(child)}>` +
          inner.replace(/<w:t( xml:space="preserve")?>/g, "<w:delText$1>").replace(/<\/w:t>/g, "</w:delText>") +
          `</w:del>`;
        break;
      }
      case "insertion": {
        /*
         * Written as `w:ins` as of 2026-08-01, so `revisionMode` stops being read-only.
         * Before this the inserted text was emitted as ordinary runs: correct under
         * `clean`, and under `showAll` it produced a document that *looked* accepted while
         * claiming to show revisions.
         *
         * A missing author is `w:author=""` rather than an invented name — Word shows an
         * empty author, which is true, where a placeholder would attribute someone's edit
         * to a string we made up.
         */
        const inner = inlineRuns(child, ctx, marks);
        if (ctx.revisionMode === "clean") {
          out += inner;
          break;
        }
        out += `<w:ins w:id="${nextRevisionId(ctx)}" ${revisionAttrs(child)}>${inner}</w:ins>`;
        break;
      }
      case "image": {
        const alt = typeof child["alt"] === "string" ? child["alt"] : "image";
        const embedded = embedImage(child, ctx);
        if (embedded) {
          out += embedded;
          break;
        }
        /*
         * No bytes to embed. Until 2026-08-01 this was *every* image, and the reason was
         * not in this file: `Resource` recorded an image's media type, hash, and length and
         * never its data, so every adapter read the bytes, hashed them, and dropped them.
         * The writer had nothing to write. ADR-0022 added `Resource.data`.
         *
         * This branch is now the genuine residue — an image whose resource is missing or
         * externalized to a `path` that no longer resolves.
         */
        ctx.diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          "image",
          `Image "${alt}" has no bytes in the IR (no resourceId, or a resource carrying ` +
            `only a path), so an alt-text placeholder is emitted instead.`,
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

function run(
  text: string,
  marks: Set<string>,
  _ctx: RenderContext,
  characterStyle?: string | undefined,
): string {
  if (text === "") return "";
  const props: string[] = [];
  // A character style comes first, as OOXML requires: w:rStyle precedes the toggles
  // that override it.
  if (characterStyle) props.push(`<w:rStyle w:val="${encodeEntities(characterStyle)}"/>`);
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

/**
 * A list and everything nested inside it.
 *
 * **One `numId` for the whole list tree; nesting is expressed by `w:ilvl` alone.**
 * That is how Word encodes it, and getting it wrong destroys nesting completely: an
 * earlier version keyed the numbering id on `(ordered, start, level)`, so every depth
 * got its own `numId`. A reader grouping consecutive paragraphs by `numId` — which is
 * the only thing it can group by — then saw a *different* list at each level, and
 * `md → docx → md` turned three nested `ul`s into five flat one-item lists.
 *
 * Measured before the fix: `nested-restarting-lists.md` round-tripped from 9 lists to
 * 12, with all nesting gone. That is a worse defect than the "numbered lists become
 * bullets" bug this project exists to fix, and it was invisible because the fidelity
 * metric counted node types without looking at depth.
 */
function renderList(
  node: AnyNode,
  ctx: RenderContext,
  doc: MarkForgeDocument,
  level = 0,
  inherited?: { numId: number; ordered: boolean },
): string {
  const ordered = node["ordered"] === true;
  const start = typeof node["start"] === "number" ? node["start"] : 1;

  // A nested list inherits its parent's numbering id — unless its *kind* differs.
  //
  // One numbering definition describes one sequence of level formats, so a bullet list
  // nested inside a numbered list cannot share it: the nested level would render with
  // the parent's ordered format. A fresh definition is what Word emits for genuinely
  // mixed nesting, and without it `1. parent / - child` came back as `1. parent /
  // a. child`. Pandoc gets this wrong the same way, which is why matching Pandoc was
  // not a good enough target.
  const numbering =
    inherited !== undefined && inherited.ordered === ordered
      ? inherited
      : (() => {
          const numId = ctx.nextNumId++;
          ctx.numbering.push({ numId, ordered, start });
          return { numId, ordered };
        })();
  const numId = numbering.numId;

  const items = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  let out = "";
  for (const item of items) {
    const blocks = Array.isArray(item.children) ? (item.children as AnyNode[]) : [];
    for (const block of blocks) {
      if (block.type === "list") {
        out += renderList(block, ctx, doc, level + 1, numbering);
      } else if (block.type === "paragraph") {
        out += paragraph(inlineRuns(block, ctx), styleFor("paragraph", ctx), { numId, level });
      } else {
        out += renderBlock(block, ctx, doc);
      }
    }
  }
  return out;
}

/**
 * Writes a table, laying its cells onto an explicit occupancy grid first.
 *
 * The grid is not bookkeeping for its own sake — OOXML requires it. A vertically
 * merged cell in OOXML is not one tall `w:tc`: it is a `w:vMerge w:val="restart"`
 * anchor plus a `w:tc` with a bare `w:vMerge` in *every* row it covers. The IR
 * stores the merge as a `rowSpan` on the anchor and simply has no cell at the
 * covered positions, so those continuation cells have to be synthesized. Without
 * them Word sees a short row and no merge at all, which is how `rowSpan` was
 * silently dropped on every `docx → md → docx` round trip.
 *
 * The grid also fixes the column count. Counting cells per row undercounts any row
 * that spans: a single `colSpan="3"` cell counted as one column, so the `w:tblGrid`
 * declared fewer columns than the table actually uses.
 */
function renderTable(node: AnyNode, ctx: RenderContext, doc: MarkForgeDocument): string {
  const rows = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
  const headerRows = headerRowCount(node);
  const tableStyle = styleFor("table", ctx);

  // Lay every cell onto (row, column), skipping positions an earlier row's rowSpan
  // already covers — the same placement rule the fidelity metric keys cells on.
  interface Placed {
    cell: AnyNode;
    colStart: number;
    colSpan: number;
    rowSpan: number;
  }
  const placed: Placed[][] = rows.map(() => []);
  /** Every grid position a cell covers, so the next row knows what to skip. */
  const occupied = new Set<string>();
  /** `row:col` of a position covered from above -> the anchor's column width. */
  const continuations = new Map<string, number>();
  let columnCount = 1;

  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row.children) ? (row.children as AnyNode[]) : [];
    let col = 0;
    for (const cell of cells) {
      while (occupied.has(`${rowIndex}:${col}`)) col += 1;
      const { rowSpan, colSpan } = cellSpan(cell);
      placed[rowIndex]!.push({ cell, colStart: col, colSpan, rowSpan });
      for (let dr = 0; dr < rowSpan; dr += 1) {
        for (let dc = 0; dc < colSpan; dc += 1) {
          occupied.add(`${rowIndex + dr}:${col + dc}`);
        }
        if (dr > 0) continuations.set(`${rowIndex + dr}:${col}`, colSpan);
      }
      col += colSpan;
      if (col > columnCount) columnCount = col;
    }
  });

  const grid = `<w:tblGrid>${"<w:gridCol/>".repeat(columnCount)}</w:tblGrid>`;
  const tblPr =
    `<w:tblPr>${tableStyle ? `<w:tblStyle w:val="${encodeEntities(tableStyle)}"/>` : ""}` +
    `<w:tblW w:w="0" w:type="auto"/></w:tblPr>`;

  // Second pass: emit each row left to right, filling covered positions with the
  // continuation cells OOXML needs.
  const body = rows
    .map((row, rowIndex) => {
      const trPr = rowIndex < headerRows ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      const starts = new Map(placed[rowIndex]!.map((p) => [p.colStart, p]));

      let tcs = "";
      let col = 0;
      while (col < columnCount) {
        const contSpan = continuations.get(`${rowIndex}:${col}`);
        if (contSpan !== undefined) {
          // A continuation cell repeats gridSpan, or the columns below a merged-and-
          // wide cell shift left and the table skews.
          const span = contSpan > 1 ? `<w:gridSpan w:val="${contSpan}"/>` : "";
          tcs += `<w:tc><w:tcPr>${span}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
          col += contSpan;
          continue;
        }

        const here = starts.get(col);
        if (!here) {
          // A ragged row: the IR allows one, OOXML does not, so the hole is filled
          // with an empty cell rather than left to shorten the row.
          tcs += "<w:tc><w:p/></w:tc>";
          col += 1;
          continue;
        }

        const props: string[] = [];
        if (here.colSpan > 1) props.push(`<w:gridSpan w:val="${here.colSpan}"/>`);
        if (here.rowSpan > 1) props.push(`<w:vMerge w:val="restart"/>`);
        const tcPr = props.length > 0 ? `<w:tcPr>${props.join("")}</w:tcPr>` : "";

        // mdast puts phrasing content *directly* in a tableCell with no paragraph
        // wrapper, while a DOCX cell from our own reader holds block content. Both
        // shapes reach here, so the cell is inspected rather than assumed: if it
        // has no block-level children, the whole cell is one paragraph's worth of
        // inline content.
        const cellChildren = Array.isArray(here.cell.children)
          ? (here.cell.children as AnyNode[])
          : [];
        const hasBlocks = cellChildren.some((c) => BLOCK_TYPES.has(c.type));
        let content = hasBlocks
          ? cellChildren
              .map((c) =>
                c.type === "paragraph" || c.type === "heading"
                  ? paragraph(inlineRuns(c, ctx), styleFor("paragraph", ctx))
                  : renderBlock(c, ctx, doc),
              )
              .join("")
          : paragraph(inlineRuns(here.cell, ctx), styleFor("paragraph", ctx));

        // OOXML requires at least one paragraph per cell; a cell that renders to
        // nothing would make the file unopenable rather than merely empty.
        if (content.trim() === "") content = "<w:p/>";
        tcs += `<w:tc>${tcPr}${content}</w:tc>`;
        col += here.colSpan;
      }

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
  // `descriptionTerm` and `descriptionDetails` were absent until 2026-08-01, so they never
  // reached `renderBlock` at all — `renderBlocks` swept them into the inline `pending`
  // buffer and they came out as run-on text inside one paragraph. Adding the `case` for
  // them was necessary and not sufficient: a case in a switch nothing dispatches to is a
  // case that never runs, and the census said so.
  "descriptionTerm", "descriptionDetails",
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
/**
 * Relationship-id allocation, stated once because three writers share the space.
 *
 * rId1 is styles, rId2 is numbering, hyperlinks start at HYPERLINK_REL_BASE (3), and
 * footnotes and media take everything above them. Two writers picking overlapping ids
 * produce a package Word opens and silently mis-resolves, which is worse than one that
 * fails to open.
 */
const relBaseAfterHyperlinks = (ctx: RenderContext): number =>
  HYPERLINK_REL_BASE + ctx.hyperlinks.length;

const footnoteRelId = (ctx: RenderContext): number => relBaseAfterHyperlinks(ctx);

const footnoteOverride = (ctx: RenderContext): string =>
  ctx.footnotes.length === 0
    ? ""
    : `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`;

const footnoteRel = (ctx: RenderContext): string =>
  ctx.footnotes.length === 0
    ? ""
    : `<Relationship Id="rId${footnoteRelId(ctx)}" Type="${FOOTNOTES_REL_TYPE}" Target="footnotes.xml"/>`;

/**
 * `Default` entries for every image extension present.
 *
 * A `Default` rather than an `Override` per part: OPC resolves an unmatched extension by
 * failing, and one entry per extension is both smaller and what every real producer writes.
 */
const mediaDefaults = (ctx: RenderContext): string => {
  const extensions = new Set([...ctx.media.values()].map((m) => m.extension));
  return [...extensions]
    .sort()
    .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpg" ? "jpeg" : ext}"/>`)
    .join("");
};

const mediaRels = (ctx: RenderContext): string =>
  [...ctx.media.values()]
    .map(
      (m) =>
        `<Relationship Id="${m.rel}" Type="${IMAGE_REL_TYPE}" ` +
        `Target="${m.part.replace(/^word\//, "")}"/>`,
    )
    .join("");

const FOOTNOTES_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes";
const IMAGE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

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
        footnoteOverride(ctx) +
        mediaDefaults(ctx) +
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
  // Always rewritten, never merely defaulted: hyperlink relationships are discovered
  // while rendering the body, so this part cannot be written before it, and it cannot
  // be left alone just because the reference document happened to have one.
  const hyperlinkRels = ctx.hyperlinks
    .map(
      (url, i) =>
        `<Relationship Id="rId${i + HYPERLINK_REL_BASE}" Type="${HYPERLINK_REL_TYPE}" ` +
        `Target="${encodeEntities(url)}" TargetMode="External"/>`,
    )
    .join("");
  pkg.set(
    Part.DOCUMENT_RELS,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
      hyperlinkRels +
      footnoteRel(ctx) +
      mediaRels(ctx) +
      `</Relationships>`,
  );
  pkg.set(Part.NUMBERING, numberingXml(ctx));

  /*
   * footnotes.xml, written only when there are footnotes.
   *
   * Word writes two housekeeping entries at ids -1 and 0 — the separator rule drawn above
   * the notes and its continuation. They are presentation rather than content, and a reader
   * that mistakes them for notes adds two empty footnotes to every document, so they are
   * emitted with an explicit `w:type` rather than left for a reader to infer from the id.
   * `@markforge/adapters-docx` skips on the attribute for the same reason.
   */
  if (ctx.footnotes.length > 0) {
    const separators =
      `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
      `<w:footnote w:type="continuationSeparator" w:id="0">` +
      `<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
    const body = [...ctx.footnotes].sort((a, b) => a.id - b.id).map((f) => f.xml).join("");
    pkg.set(
      Part.FOOTNOTES,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:footnotes ${W_NS}>${separators}${body}</w:footnotes>`,
    );
  }

  // Media parts. One entry per distinct resource, so an image used twice is stored once —
  // which is also why the IR keys resources by content hash (SPEC §2.2, rule A7).
  for (const m of ctx.media.values()) pkg.set(m.part, m.bytes);
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
    // DOCX has no element for a description list, a caption's binding, or a footnote's
    // style, so the writer carries all four as named styles and `inferCaptionsAndDefinitions`
    // reads them back. The fallback stylesheet has to define them or the convention is
    // write-only without a reference document — which is the common case.
    `<w:style w:type="paragraph" w:styleId="DefinitionTerm"><w:name w:val="Definition Term"/>` +
    `<w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Definition"><w:name w:val="Definition"/>` +
    `<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ImageCaption"><w:name w:val="Image Caption"/>` +
    `<w:basedOn w:val="Caption"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TableCaption"><w:name w:val="Table Caption"/>` +
    `<w:basedOn w:val="Caption"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="Footnote Text"/>` +
    `<w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="Footnote Reference"/>` +
    `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>` +
    `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
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
  const abstracts = ctx.numbering
    .map(({ numId, ordered, start }) => {
      // Nine levels per definition, because one definition serves an entire list
      // tree and w:ilvl selects the depth. Alternating formats per level is what
      // Word does and what a reader expects.
      const levels = Array.from({ length: 9 }, (_, i) => {
        const indent = 720 * (i + 1);
        const fmt = ordered
          ? i % 3 === 0
            ? "decimal"
            : i % 3 === 1
              ? "lowerLetter"
              : "lowerRoman"
          : "bullet";
        const text = ordered ? `%${i + 1}.` : "\u2022";
        return (
          `<w:lvl w:ilvl="${i}"><w:start w:val="${i === 0 ? start : 1}"/>` +
          `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${encodeEntities(text)}"/>` +
          `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }).join("");
      return `<w:abstractNum w:abstractNumId="${numId}">${levels}</w:abstractNum>`;
    })
    .join("");

  const nums = ctx.numbering
    .map(({ numId }) => `<w:num w:numId="${numId}"><w:abstractNumId w:val="${numId}"/></w:num>`)
    .join("");

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
