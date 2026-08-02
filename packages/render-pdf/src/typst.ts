/**
 * IR to Typst markup.
 *
 * ADR-0003 chose Typst partly because *escaping arbitrary document text is a bounded
 * problem* in it, unlike LaTeX where every `\`, `$`, `%`, `&`, `#`, `_`, `{`, `}` is a
 * potential silent corruption. That argument only holds if the escaping is actually done, so
 * `esc` below is the load-bearing function in this file and every text path goes through it.
 */
import type { AnyNode, MarkForgeDocument } from "@markforge/ir";

/**
 * Typst's special characters, escaped with a backslash.
 *
 * `#` starts code, `$` starts math, `@` starts a reference, `*`/`_` are emphasis, `` ` ``
 * starts raw, `<`/`>` delimit labels, `\` is the escape itself, and `[`/`]` delimit content
 * blocks. Anything else is literal — which is the property that made Typst preferable to
 * LaTeX for arbitrary user text.
 */
export function esc(text: string): string {
  return text.replace(/([\\#$@*_`<>[\]])/g, "\\$1");
}

/** A label safe to use as a Typst `<label>` target. */
const label = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** Types `inline()` handles. Reaching `block()` with one of these is nesting, not a loss. */
const PHRASING = new Set([
  "text", "emphasis", "strong", "delete", "underline", "smallCaps", "highlight",
  "subscript", "superscript", "inlineCode", "break", "inlineMath", "link", "image",
  "crossReference", "footnoteReference", "insertion", "deletion", "linkReference",
  "imageReference", "citation",
]);

interface Ctx {
  /** Node ids that something references, so only those emit a label. */
  readonly referenced: Set<string>;
  /** Collected losses, reported by the caller as diagnostics. */
  readonly lost: Array<{ type: string; reason: string }>;
}

/** Inline content. */
function inline(node: AnyNode, ctx: Ctx): string {
  const kids = (): string => (node.children ?? []).map((c) => inline(c as AnyNode, ctx)).join("");

  switch (node.type) {
    case "text":
      return esc(String(node["value"] ?? ""));
    case "emphasis":
      return `_${kids()}_`;
    case "strong":
      return `*${kids()}*`;
    case "delete":
      return `#strike[${kids()}]`;
    case "underline":
      return `#underline[${kids()}]`;
    case "smallCaps":
      return `#smallcaps[${kids()}]`;
    case "highlight":
      return `#highlight[${kids()}]`;
    case "subscript":
      return `#sub[${kids()}]`;
    case "superscript":
      return `#super[${kids()}]`;
    case "inlineCode":
      return `#raw(${str(String(node["value"] ?? ""))})`;
    case "break":
      return " \\\n";
    case "inlineMath":
      return `$${String(node["value"] ?? "")}$`;
    case "link": {
      const url = String(node["url"] ?? "");
      return `#link(${str(url)})[${kids()}]`;
    }
    case "image": {
      // Images are resource-referenced (SPEC §2.3), and this renderer has no resource
      // resolver, so the alt text is emitted and the loss is reported rather than a
      // broken `image()` call being written.
      ctx.lost.push({ type: "image", reason: "no resource resolver in the PDF renderer" });
      const alt = String(node["alt"] ?? "");
      return alt ? `#emph[${esc(alt)}]` : "";
    }
    case "crossReference": {
      const target = node["targetId"];
      if (typeof target === "string" && target !== "") {
        ctx.referenced.add(target);
        return `#link(<${label(target)}>)[${kids() || esc(String(node["label"] ?? "see"))}]`;
      }
      return kids();
    }
    case "footnoteReference":
      // Rendered where the definition is emitted; the marker itself carries no text.
      return "";
    case "insertion":
      return kids();
    case "deletion":
      // `revisionMode: "clean"` is the config default (SPEC §7), and clean means the
      // deletion is not shown. This renderer implements that default rather than the
      // Markdown renderer's behaviour of emitting both sides adjacent.
      return "";
    case "comment":
      return "";
    default:
      return kids();
  }
}

/** A Typst string literal. */
const str = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Block content. */
function block(node: AnyNode, ctx: Ctx, depth = 0): string {
  const kids = (sep = "\n\n"): string =>
    (node.children ?? []).map((c) => block(c as AnyNode, ctx, depth)).filter((s) => s !== "").join(sep);
  const phrasing = (): string => (node.children ?? []).map((c) => inline(c as AnyNode, ctx)).join("");
  const anchor = typeof node.id === "string" && ctx.referenced.has(node.id) ? ` <${label(node.id)}>` : "";

  switch (node.type) {
    case "root":
      return kids();

    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node["resolvedLevel"] ?? node["depth"] ?? 1)));
      return `${"=".repeat(level)} ${phrasing()}${anchor}`;
    }

    case "paragraph":
      return `${phrasing()}${anchor}`;

    case "blockquote":
      return `#quote(block: true)[\n${kids()}\n]`;

    case "code": {
      const lang = typeof node["lang"] === "string" && node["lang"] ? node["lang"] : "txt";
      // A raw block, not a string: Typst's `raw` preserves the content verbatim, which is
      // the whole point of a code block and the one place escaping must NOT happen.
      return `#raw(block: true, lang: ${str(lang)}, ${str(String(node["value"] ?? ""))})`;
    }

    case "list": {
      const ordered = node["ordered"] === true;
      const marker = ordered ? "+" : "-";
      const items = (node.children ?? [])
        .map((c) => {
          const body = block(c as AnyNode, ctx, depth + 1);
          // Continuation lines indent to sit under the marker, which is how Typst decides
          // what belongs to the item.
          return `${marker} ${body.replace(/\n/g, "\n  ")}`;
        })
        .join("\n");
      const start = Number(node["restartsAt"] ?? node["start"] ?? 1);
      // `enum(start: n)` is the only way to honour a restarting list, which the IR carries
      // precisely so a list beginning at 7 survives (brief §5.1).
      if (ordered && start !== 1) {
        return `#enum(start: ${start}, ${(node.children ?? [])
          .map((c) => `[${block(c as AnyNode, ctx, depth + 1)}]`)
          .join(", ")})`;
      }
      return items;
    }

    case "listItem":
      return kids("\n\n");

    case "thematicBreak":
      return "#line(length: 100%)";

    case "table":
      return table(node, ctx);

    case "figure": {
      const [content, caption] = splitCaption(node);
      const body = content.map((c) => block(c, ctx, depth)).join("\n");
      const cap = caption ? `, caption: [${(caption.children ?? []).map((c) => inline(c as AnyNode, ctx)).join("")}]` : "";
      // Typst's own `figure` handles placement and numbering, which is SPEC §4.3's
      // "figure and caption placement" requirement met by the engine rather than by us.
      return `#figure(\n${body || '""'}${cap}\n)${anchor}`;
    }

    case "caption":
      return phrasing();

    case "admonition": {
      const kind = String(node["kind"] ?? "note");
      return `#block(stroke: (left: 2pt + gray), inset: (left: 8pt, y: 6pt))[\n*${esc(kind.toUpperCase())}.* ${kids()}\n]`;
    }

    case "equationBlock": {
      const notation = node["notation"];
      if (notation === "tex" && typeof node["source"] === "string") {
        // Typst math is not TeX, but the common subset round-trips well enough that
        // emitting it beats dropping it. Anything else is reported.
        return `$ ${String(node["source"])} $`;
      }
      ctx.lost.push({
        type: "equationBlock",
        reason: `${String(notation)} is not Typst math and no converter exists`,
      });
      return `#raw(block: true, ${str(String(node["source"] ?? ""))})`;
    }

    case "math":
      return `$ ${String(node["value"] ?? "")} $`;

    case "footnoteDefinition": {
      const body = kids();
      return `#footnote[${body}]`;
    }

    case "descriptionList":
      return kids("\n");
    case "descriptionTerm":
      return `/ ${phrasing()}:`;
    case "descriptionDetails":
      return `  ${phrasing()}`;

    case "pageBreak":
      return "#pagebreak()";
    case "columnBreak":
      return "#colbreak()";

    case "yaml":
    case "toml":
      // Front matter is metadata, not content. It reaches `document(title:)` via the
      // preamble rather than being printed into the body.
      return "";

    case "html":
      ctx.lost.push({ type: "html", reason: "raw HTML has no Typst equivalent" });
      return "";

    case "unknown":
      ctx.lost.push({
        type: "unknown",
        reason: `construct ${String(node["construct"] ?? "?")} was already unrepresentable in the IR`,
      });
      return "";

    case "comment":
      return "";

    default:
      /*
       * A phrasing node reached through a block container is phrasing, not a loss.
       *
       * The first version reported anything childless here, and a `listItem` holding a bare
       * `text` child walks straight into it — so `clean-report.md` produced **16 diagnostics
       * about text that was present in the output**. A plausible diagnostic on a document
       * that is fine is the hardest failure to notice, and it is the one this repository
       * keeps making; the rule that catches it is to prove the underlying operation actually
       * fails before reporting that it did.
       */
      if (PHRASING.has(node.type)) return inline(node, ctx);
      /*
       * An unmapped block type is **reported and then walked**, in that order.
       *
       * The first version walked first and reported only childless nodes, so a `textBox` with
       * an empty `children` array slipped through silently — caught by this gate's own
       * negative control on its first run. Reporting and walking is the renderer-side shape of
       * adapter rule A6: the text survives, and the construct's semantics are declared lost
       * rather than assumed to be carried by its children.
       */
      ctx.lost.push({ type: node.type, reason: "no Typst mapping; children rendered inline" });
      return Array.isArray(node.children) ? kids() : "";
  }
}

/** Splits a `figure`'s children into content and its caption. */
function splitCaption(node: AnyNode): [AnyNode[], AnyNode | undefined] {
  const children = (node.children ?? []) as AnyNode[];
  const caption = children.find((c) => c.type === "caption");
  return [children.filter((c) => c.type !== "caption"), caption];
}

/**
 * A table.
 *
 * Typst's `table` takes cells in row-major order with `colspan`/`rowspan` on the cell, so
 * merges survive — which is the construct GFM cannot express and the reason `SPEC.md` §9.3
 * reports full-cell and content-only F1 separately.
 *
 * `repeat-header` is set so a table breaking across pages repeats its header, which is
 * SPEC §4.3's "correct table breaking" requirement.
 */
function table(node: AnyNode, ctx: Ctx): string {
  const rows = (node.children ?? []) as AnyNode[];
  const columns = rows.reduce((max, r) => {
    const span = ((r.children ?? []) as AnyNode[]).reduce(
      (n, c) => n + Number(c["colSpan"] ?? 1),
      0,
    );
    return Math.max(max, span);
  }, 1);

  const cells: string[] = [];
  for (const row of rows) {
    for (const cell of (row.children ?? []) as AnyNode[]) {
      const body = (cell.children ?? []).map((c) => block(c as AnyNode, ctx)).join("\n\n");
      const colspan = Number(cell["colSpan"] ?? 1);
      const rowspan = Number(cell["rowSpan"] ?? 1);
      const attrs = [
        colspan > 1 ? `colspan: ${colspan}` : "",
        rowspan > 1 ? `rowspan: ${rowspan}` : "",
      ].filter((a) => a !== "");
      cells.push(attrs.length > 0 ? `table.cell(${attrs.join(", ")})[${body}]` : `[${body}]`);
    }
  }

  const headerRows = Number(node["headerRowCount"] ?? 1);
  const perRow = rows.slice(0, headerRows).reduce((n, r) => n + ((r.children ?? []).length), 0);
  const head = perRow > 0 && headerRows > 0 ? `table.header(${cells.slice(0, perRow).join(", ")}),\n  ` : "";
  const body = (perRow > 0 && headerRows > 0 ? cells.slice(perRow) : cells).join(",\n  ");

  return `#table(\n  columns: ${columns},\n  ${head}${body}\n)`;
}

export interface TypstDocument {
  source: string;
  lost: Array<{ type: string; reason: string }>;
}

/**
 * Renders a document to Typst markup.
 *
 * `#set document(date: none)` is not cosmetic and not optional. Typst writes `/CreationDate`
 * and `/ModDate` from the wall clock by default, and **measured** on 2026-08-01, two compiles
 * of one input in separate processes differed at byte 11533 for exactly that reason. The
 * `creationTimestamp` compile option does not override it. `date: none` omits the field
 * entirely, which is what SPEC §1.1 permits — "any timestamp in output comes from
 * `SOURCE_DATE_EPOCH`, or is omitted".
 */
export function toTypst(doc: MarkForgeDocument, opts: { title?: string } = {}): TypstDocument {
  const referenced = new Set<string>();
  // Two passes: the first learns which ids are referenced so only those emit a label.
  // Labelling every node would be correct and would also double the source size.
  const scan = (n: AnyNode): void => {
    if (n.type === "crossReference" && typeof n["targetId"] === "string") referenced.add(n["targetId"]);
    for (const key of Object.keys(n)) {
      const v = (n as Record<string, unknown>)[key];
      if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object") scan(c as AnyNode);
    }
  };
  scan(doc.body as unknown as AnyNode);

  const ctx: Ctx = { referenced, lost: [] };
  const body = block(doc.body as unknown as AnyNode, ctx);
  const title = opts.title ?? doc.metadata?.title;

  const preamble = [
    "// Generated by @markforge/render-pdf. Do not edit.",
    "#set document(date: none" + (title ? `, title: ${str(String(title))}` : "") + ")",
    "#set page(numbering: \"1\")",
    "#set text(font: \"Libertinus Serif\", size: 11pt)",
    "#set par(justify: true)",
    "#show heading: it => block(above: 1.2em, below: 0.6em)[#it]",
  ].join("\n");

  return { source: `${preamble}\n\n${body}\n`, lost: ctx.lost };
}
