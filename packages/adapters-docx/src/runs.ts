/**
 * Run-level parsing: `w:r` and its inline siblings into PhrasingContent.
 *
 * Adapter rule A5 — "adapters record, they do not infer" — is the constraint that
 * shapes this file. A run with 16pt bold text becomes a `text` node plus style
 * evidence saying "16pt bold". It does **not** become a heading here. Deciding that
 * is @markforge/infer's job, and keeping the decision out of the adapter is what
 * makes the decision reviewable and overridable.
 */
import type { AnyNode, StyleEvidence, DiagnosticBag } from "@markforge/ir";
import { DiagnosticCode } from "@markforge/ir";
import {
  attr,
  boolVal,
  childNamed,
  childElements,
  isElement,
  isText,
  resolveStyle,
  textOf,
  val,
  type CascadeInput,
  type XmlElement,
} from "@markforge/ooxml";

export interface RunContext {
  cascade: CascadeInput;
  diagnostics: DiagnosticBag;
  /** Relationship id -> resource id, for images and hyperlinks. */
  relationships: Map<string, { type: string; target: string }>;
  resourceIds: Map<string, string>;
  /** Records style evidence for a node once the node has an id. */
  recordEvidence: (node: AnyNode, evidence: StyleEvidence) => void;
  /** Paragraph style in scope, so run resolution can inherit from it. */
  paragraphStyleId?: string | undefined;
}

/** Vertical alignment maps to sub/superscript rather than to a style property. */
function verticalAlign(rPr: XmlElement | undefined): "sub" | "super" | undefined {
  const v = val(rPr ? childNamed(rPr, "vertAlign") : undefined);
  if (v === "subscript") return "sub";
  if (v === "superscript") return "super";
  return undefined;
}

/**
 * Wraps a text node in the inline marks its run properties imply.
 *
 * Order is fixed rather than incidental: nesting `strong` inside `emphasis`
 * consistently means two runs with the same formatting produce identical trees, so
 * they compare equal and merge during normalisation. An order that varied with
 * property iteration would make the IR depend on object key order.
 */
function applyMarks(node: AnyNode, evidence: StyleEvidence, rPr: XmlElement | undefined): AnyNode {
  let out = node;

  const va = verticalAlign(rPr);
  if (va === "sub") out = { type: "subscript", children: [out] };
  if (va === "super") out = { type: "superscript", children: [out] };

  if (evidence.font?.smallCaps) out = { type: "smallCaps", children: [out] };

  const strike = boolVal(rPr ? childNamed(rPr, "strike") : undefined);
  if (strike) out = { type: "delete", children: [out] };

  const u = rPr ? childNamed(rPr, "u") : undefined;
  const uVal = val(u);
  if (u && uVal !== "none") out = { type: "underline", children: [out] };

  const highlight = val(rPr ? childNamed(rPr, "highlight") : undefined);
  if (highlight && highlight !== "none") {
    out = { type: "highlight", color: highlight, children: [out] };
  } else if (evidence.font?.highlight) {
    out = { type: "highlight", color: evidence.font.highlight, children: [out] };
  }

  if (evidence.font?.italic) out = { type: "emphasis", children: [out] };
  // Weight is numeric in the IR (the schema's CSS-style scale); OOXML only ever
  // gives us bold-or-not, so anything at or above semibold reads as strong.
  if ((evidence.font?.weight ?? 400) >= 600) out = { type: "strong", children: [out] };

  return out;
}

/**
 * `w:t` text, honouring `xml:space="preserve"`.
 *
 * Without the xml:space check, leading and trailing spaces inside a run vanish and
 * words run together across run boundaries — the most common OOXML text bug, and
 * invisible until someone reads the output closely.
 */
function runText(r: XmlElement): string {
  let out = "";
  for (const child of childElements(r)) {
    switch (child.local) {
      case "t":
        out += textOf(child);
        break;
      case "tab":
        out += "\t";
        break;
      case "noBreakHyphen":
        out += "‑";
        break;
      case "softHyphen":
        out += "­";
        break;
      default:
        break;
    }
  }
  return out;
}

/** True when the run is a code-styled run, so its content stays verbatim. */
function isVerbatimStyle(styleId: string | undefined, cascade: CascadeInput): boolean {
  if (!styleId) return false;
  const name = cascade.styles[styleId]?.name?.toLowerCase() ?? "";
  return name === "verbatim char" || name === "source code" || name === "code";
}

export function parseRun(r: XmlElement, ctx: RunContext): AnyNode[] {
  const rPr = childNamed(r, "rPr");
  const rStyle = val(rPr ? childNamed(rPr, "rStyle") : undefined);

  const inheritedStyle = rStyle ?? ctx.paragraphStyleId;
  const resolved = resolveStyle(ctx.cascade, {
    ...(inheritedStyle !== undefined ? { styleId: inheritedStyle } : {}),
    rPr,
  });

  if (resolved.unresolvedThemeFont) {
    ctx.diagnostics.degraded(
      DiagnosticCode.DOCX_MISSING_THEME,
      "theme1.xml",
      `Font token ${resolved.evidence.font?.family} could not be resolved: the document ` +
        `has no theme part, so the token is recorded verbatim as evidence. Supplying a ` +
        `reference document with a theme resolves it.`,
    );
  }

  const out: AnyNode[] = [];

  // A run can hold several inline objects. Iterating children rather than looking
  // only at w:t keeps breaks and images in their correct positions.
  for (const child of childElements(r)) {
    switch (child.local) {
      case "br": {
        const type = attr(child, "type");
        if (type === "page") out.push({ type: "pageBreak" });
        else if (type === "column") out.push({ type: "columnBreak" });
        else out.push({ type: "break" });
        break;
      }
      case "drawing":
      case "pict": {
        const image = parseDrawing(child, ctx);
        if (image) out.push(image);
        break;
      }
      case "footnoteReference": {
        const id = attr(child, "id");
        if (id) out.push({ type: "footnoteReference", identifier: `fn${id}`, label: id });
        break;
      }
      case "endnoteReference": {
        const id = attr(child, "id");
        if (id) out.push({ type: "footnoteReference", identifier: `en${id}`, label: id });
        break;
      }
      case "object":
      case "embeddedObject": {
        ctx.diagnostics.lost(
          DiagnosticCode.DOCX_EMBEDDED_OBJECT,
          "w:object",
          "Embedded OLE object cannot be represented and was dropped. Exporting the " +
            "object as an image before converting preserves its appearance.",
        );
        out.push({ type: "unknown", originalType: "w:object", raw: "" });
        break;
      }
      default:
        break;
    }
  }

  const text = runText(r);
  if (text.length > 0) {
    const verbatim = isVerbatimStyle(rStyle, ctx.cascade);
    const base: AnyNode = verbatim
      ? { type: "inlineCode", value: text }
      : { type: "text", value: text };
    // inlineCode carries no marks: monospace *is* the formatting, and wrapping it
    // in strong/emphasis would round-trip to Markdown as `**`code`**`, which is
    // both ugly and not what the source meant.
    const marked = verbatim ? base : applyMarks(base, resolved.evidence, rPr);
    ctx.recordEvidence(marked, resolved.evidence);
    out.unshift(marked);
  }

  return out;
}

function parseDrawing(el: XmlElement, ctx: RunContext): AnyNode | undefined {
  // The blip's r:embed points at the relationship holding the image part.
  const findBlip = (e: XmlElement): XmlElement | undefined => {
    if (e.local === "blip") return e;
    for (const c of e.children) {
      if (!isElement(c)) continue;
      const found = findBlip(c);
      if (found) return found;
    }
    return undefined;
  };
  const blip = findBlip(el);
  const embed = blip ? attr(blip, "embed") : undefined;
  if (!embed) {
    ctx.diagnostics.degraded(
      DiagnosticCode.DOCX_UNKNOWN_ELEMENT,
      el.name,
      "A drawing had no resolvable image reference; it may be a shape or SmartArt.",
    );
    return { type: "unknown", originalType: el.name, raw: "" };
  }
  const resourceId = ctx.resourceIds.get(embed);
  if (!resourceId) return { type: "unknown", originalType: el.name, raw: "" };

  // Alt text lives in docPr/@descr. Absent alt is recorded as absent rather than as
  // empty string: "" means "decorative, no alt needed" in HTML, which is a claim we
  // have no evidence for.
  const findDocPr = (e: XmlElement): XmlElement | undefined => {
    if (e.local === "docPr") return e;
    for (const c of e.children) {
      if (!isElement(c)) continue;
      const found = findDocPr(c);
      if (found) return found;
    }
    return undefined;
  };
  const docPr = findDocPr(el);
  const alt = docPr ? (attr(docPr, "descr") ?? attr(docPr, "title")) : undefined;

  const image: AnyNode = { type: "image", resourceId };
  if (alt !== undefined && alt.length > 0) image["alt"] = alt;
  return image;
}

/** Parses a hyperlink wrapper, which contains runs. */
export function parseHyperlink(el: XmlElement, ctx: RunContext, parseRuns: (e: XmlElement) => AnyNode[]): AnyNode {
  const relId = attr(el, "id");
  const anchor = attr(el, "anchor");
  const rel = relId ? ctx.relationships.get(relId) : undefined;
  const children = parseRuns(el);

  if (rel) {
    return { type: "link", url: rel.target, children };
  }
  if (anchor) {
    // An internal link. Represented as a crossReference rather than a link with a
    // fragment url, because the target is a bookmark in this document and a renderer
    // needs to resolve it, not emit it verbatim.
    return { type: "crossReference", targetKey: anchor, kind: "heading", children };
  }
  return { type: "link", url: "", children };
}

export { isText };
