/**
 * @markforge/render-html — IR to semantic HTML.
 *
 * Semantic, not styled. The IR knows a node is a heading; it does not know it
 * should be 24px. Emitting `<h2>` and letting a stylesheet decide is the same
 * argument as SPEC §4.2's named-styles rule, applied to a different format —
 * inline styles here would be the exact analogue of direct run formatting in DOCX.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  cellSpan,
  headerRowCount,
  type AnyNode,
  type MarkForgeDocument,
} from "@markforge/ir";

const RENDERER = { kind: "adapter" as const, name: "@markforge/render-html", version: "0.1.0" };

export interface HtmlRenderOptions {
  /** Emit a full document with `<html>`, `<head>`, and `<body>`. */
  fullDocument?: boolean;
  /** Inlined into a `<style>` element when `fullDocument` is set. */
  stylesheet?: string;
  /** Link to an external stylesheet instead of inlining. */
  stylesheetHref?: string;
  /** `id` attributes on headings, so cross-references resolve. */
  headingIds?: boolean;
  title?: string;
  lang?: string;
}

export interface HtmlRenderResult {
  html: string;
  diagnostics: DiagnosticBag;
}

const DEFAULTS: Required<Omit<HtmlRenderOptions, "stylesheet" | "stylesheetHref" | "title" | "lang">> = {
  fullDocument: true,
  headingIds: true,
};

export function renderHtml(doc: MarkForgeDocument, options: HtmlRenderOptions = {}): HtmlRenderResult {
  const opts = { ...DEFAULTS, ...options };
  const diagnostics = new DiagnosticBag(RENDERER);
  const usedIds = new Set<string>();

  const body = renderNodes(
    (doc.body as unknown as AnyNode).children as AnyNode[] | undefined,
    { diagnostics, headingIds: opts.headingIds, usedIds },
    0,
  );

  if (!opts.fullDocument) return { html: body + "\n", diagnostics };

  const title = options.title ?? (typeof doc.metadata["title"] === "string" ? doc.metadata["title"] : "Document");
  const lang = options.lang ?? (typeof doc.metadata["language"] === "string" ? doc.metadata["language"] : "en");
  const style = options.stylesheetHref
    ? `    <link rel="stylesheet" href="${escapeAttr(options.stylesheetHref)}">\n`
    : options.stylesheet
      ? `    <style>\n${indent(options.stylesheet, 6)}\n    </style>\n`
      : "";

  const html =
    `<!doctype html>\n` +
    `<html lang="${escapeAttr(lang)}">\n` +
    `  <head>\n` +
    `    <meta charset="utf-8">\n` +
    `    <meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `    <title>${escapeText(title)}</title>\n` +
    style +
    `  </head>\n` +
    `  <body>\n` +
    indent(body, 4) +
    `\n  </body>\n` +
    `</html>\n`;

  return { html, diagnostics };
}

/**
 * Renders a subtree as an HTML fragment.
 *
 * Exists so another renderer can embed real HTML for a construct its own format
 * cannot express: `@markforge/render-md` uses it for merged table cells, which GFM
 * pipe syntax has no syntax for at all. Sharing this serializer rather than writing
 * a second one means the embedded HTML and the HTML we emit standalone cannot drift
 * apart — and `@markforge/adapters-html` already reads this exact output back, which
 * is what makes the round trip lossless rather than merely lossless-looking.
 *
 * `headingIds` defaults to false here: a fragment is spliced into a larger document
 * whose id space it does not know, so minting ids would risk colliding with it.
 */
export function renderHtmlFragment(
  nodes: AnyNode[],
  options: HtmlRenderOptions = {},
): HtmlRenderResult {
  const diagnostics = new DiagnosticBag(RENDERER);
  const html = renderNodes(
    nodes,
    { diagnostics, headingIds: options.headingIds ?? false, usedIds: new Set() },
    0,
  );
  return { html, diagnostics };
}

interface Ctx {
  diagnostics: DiagnosticBag;
  headingIds: boolean;
  usedIds: Set<string>;
}

/**
 * Node types `renderInline` handles. Anything here reaching `renderNode` instead
 * produces nothing, because the block switch has no case for it.
 *
 * That is not hypothetical: a `figure` holds an `image` and a `caption` as direct
 * children, so the image went through the block path and vanished — `html -> html`,
 * a loop through one format, silently lost it. `renderRow` already carries a comment
 * about the same mistake costing table F1 0.0%, which is twice now, so the routing is
 * explicit rather than left to whichever switch happens to be called.
 */
const INLINE_TYPES = new Set([
  "text", "strong", "emphasis", "delete", "underline", "insertion", "deletion",
  "highlight", "subscript", "superscript", "smallCaps", "inlineCode", "inlineMath",
  "break", "link", "crossReference", "image", "footnoteReference", "comment", "html",
]);

function renderNodes(nodes: AnyNode[] | undefined, ctx: Ctx, depth: number): string {
  if (!nodes) return "";
  return nodes
    .map((n) =>
      INLINE_TYPES.has(n.type)
        ? `${"  ".repeat(depth)}${renderInline([n], ctx)}`
        : renderNode(n, ctx, depth),
    )
    .filter((s) => s.trim() !== "")
    .join("\n");
}

function renderNode(node: AnyNode, ctx: Ctx, depth: number): string {
  const kids = (d = depth + 1): string => renderNodes(node.children as AnyNode[] | undefined, ctx, d);
  const inline = (): string => renderInline(node.children as AnyNode[] | undefined, ctx);

  switch (node.type) {
    case "root":
      return kids(depth);

    case "paragraph":
      return `<p>${inline()}</p>`;

    case "heading": {
      // The IR's resolvedLevel can exceed 6; HTML stops there. The clamp is
      // reported, and `data-level` keeps the real level in the output so the
      // information is degraded rather than destroyed.
      const resolved = typeof node["resolvedLevel"] === "number" ? node["resolvedLevel"] : 1;
      const level = Math.min(6, Math.max(1, resolved));
      if (resolved > 6) {
        ctx.diagnostics.degraded(
          DiagnosticCode.RENDER_DEPTH_CLAMPED,
          "heading",
          `Heading level ${resolved} clamped to h6; the original level is kept in ` +
            `data-level so it is recoverable.`,
        );
      }
      const text = plainText(node);
      const id = ctx.headingIds ? ` id="${escapeAttr(uniqueSlug(text, ctx.usedIds))}"` : "";
      const dataLevel = resolved > 6 ? ` data-level="${resolved}"` : "";
      return `<h${level}${id}${dataLevel}>${inline()}</h${level}>`;
    }

    case "blockquote":
      return block("blockquote", kids(), depth);

    case "list": {
      const tag = node["ordered"] === true ? "ol" : "ul";
      const start = typeof node["start"] === "number" && node["start"] !== 1
        ? ` start="${node["start"]}"`
        : "";
      return block(tag, kids(), depth, start);
    }

    case "listItem": {
      // A single-paragraph item unwraps to inline content, which is what a reader
      // of the HTML expects and what every Markdown renderer produces.
      const children = (node.children as AnyNode[] | undefined) ?? [];
      if (children.length === 1 && children[0]!.type === "paragraph") {
        return `<li>${renderInline(children[0]!.children as AnyNode[] | undefined, ctx)}</li>`;
      }
      return block("li", kids(), depth);
    }

    case "code": {
      const lang = typeof node["lang"] === "string" ? node["lang"] : undefined;
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      const value = typeof node["value"] === "string" ? node["value"] : "";
      // No newline before </code>: whitespace inside <pre> is content, and adding
      // any would change what the page shows.
      return `<pre><code${cls}>${escapeText(value)}</code></pre>`;
    }

    case "thematicBreak":
      return "<hr>";

    case "table": {
      const rows = (node.children as AnyNode[] | undefined) ?? [];
      const headerRows = headerRowCount(node);
      const head = rows.slice(0, headerRows);
      const bodyRows = rows.slice(headerRows);
      const parts: string[] = [];
      if (head.length > 0) {
        parts.push(block("thead", head.map((r) => renderRow(r, ctx, true, depth + 2)).join("\n"), depth + 1));
      }
      if (bodyRows.length > 0) {
        parts.push(block("tbody", bodyRows.map((r) => renderRow(r, ctx, false, depth + 2)).join("\n"), depth + 1));
      }
      return block("table", parts.join("\n"), depth);
    }

    case "figure": {
      return block("figure", kids(), depth);
    }
    case "caption": {
      return `<figcaption>${inline()}</figcaption>`;
    }

    case "admonition": {
      const kind = typeof node["kind"] === "string" ? node["kind"] : "note";
      return block("aside", kids(), depth, ` class="admonition admonition-${escapeAttr(kind)}"`);
    }

    case "descriptionList":
      return block("dl", kids(), depth);
    case "descriptionTerm":
      return `<dt>${inline()}</dt>`;
    case "descriptionDetails":
      return block("dd", kids(), depth);

    case "equationBlock":
    case "math":
    {
      /*
       * `source` as well as `value`. An OMML equation carries its markup in `source` and has
       * no `value` at all, so this rendered `<div class="math math-display"></div>` — an
       * element asserting there is an equation here, containing nothing, with no diagnostic.
       *
       * TeX goes in as text, which is what MathJax and KaTeX read. OMML goes in a `<pre>`,
       * matching what the Markdown renderer does with the same node: both surfaces show the
       * source they cannot convert rather than one hiding it. That costs text fidelity —
       * markup that was never text in the source document becomes text in the output — and
       * the cost is recorded in `fixtures/expected/baselines.json` rather than avoided by
       * dropping the equation.
       */
      const notation = typeof node["notation"] === "string" ? node["notation"] : "tex";
      const value = typeof node["value"] === "string" ? node["value"] : undefined;
      const source = typeof node["source"] === "string" ? node["source"] : undefined;
      const attrs = ` class="math math-display" data-notation="${escapeAttr(notation)}"`;
      if (notation === "tex" || value !== undefined) {
        return `<div${attrs}>${escapeText(value ?? source ?? "")}</div>`;
      }
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "equationBlock",
        `HTML math is TeX or MathML, and this equation is ${notation.toUpperCase()}. There is ` +
          `no converter here, so the source is shown verbatim and its structure is lost.`,
      );
      return `<div${attrs}><pre>${escapeText(source ?? "")}</pre></div>`;
    }

    case "footnoteDefinition": {
      const id = escapeAttr(String(node["identifier"] ?? ""));
      return block("section", kids(), depth, ` class="footnote" id="fn-${id}"`);
    }

    case "html":
      // Raw HTML passes through: it was HTML to begin with, and escaping it would
      // turn markup the author wrote into visible angle brackets.
      return typeof node["value"] === "string" ? node["value"] : "";

    case "pageBreak":
      return `<div class="page-break" style="break-after: page"></div>`;

    case "yaml":
    case "toml":
      return "";

    case "unknown": {
      const original = typeof node["construct"] === "string" ? node["construct"] : "unknown";
      const raw = typeof node["raw"] === "string" ? node["raw"] : "";
      ctx.diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        original,
        `Construct "${original}" has no HTML mapping; emitted inside a data-attributed ` +
          `<div> so it is visible in the output and recoverable from it.`,
      );
      return `<div data-markforge-unknown="${escapeAttr(original)}">${escapeText(raw)}</div>`;
    }

    case "section":
    case "slide":
    case "sheet":
      return block("section", kids(), depth);

    default: {
      if (Array.isArray(node.children)) return kids(depth);
      return "";
    }
  }
}

/** Block-level types, for telling a block cell from an inline one. */
const CELL_BLOCK_TYPES = new Set([
  "paragraph", "heading", "list", "blockquote", "code", "table", "thematicBreak",
  "figure", "caption", "admonition", "descriptionList", "equationBlock",
]);

function renderRow(row: AnyNode, ctx: Ctx, isHeader: boolean, depth: number): string {
  const cells = ((row.children as AnyNode[] | undefined) ?? []).map((cell) => {
    const tag = isHeader ? "th" : "td";
    const attrs: string[] = [];
    const { rowSpan, colSpan } = cellSpan(cell);
    if (rowSpan > 1) attrs.push(` rowspan="${rowSpan}"`);
    if (colSpan > 1) attrs.push(` colspan="${colSpan}"`);

    // A cell holds either phrasing content directly (the mdast shape, which is what
    // Markdown produces) or block content (which is what DOCX and PPTX produce). An
    // earlier version checked only for a single wrapping paragraph, so every
    // Markdown-sourced cell rendered as <td></td> — the content was phrasing, the
    // block renderer had no case for a bare text node, and it silently produced
    // nothing. The fidelity harness reported table F1 0.0% before anyone noticed.
    const children = (cell.children as AnyNode[] | undefined) ?? [];
    const hasBlocks = children.some((c) => CELL_BLOCK_TYPES.has(c.type));
    const content = !hasBlocks
      ? renderInline(children, ctx)
      : children.length === 1 && children[0]!.type === "paragraph"
        ? renderInline(children[0]!.children as AnyNode[] | undefined, ctx)
        : renderNodes(children, ctx, depth + 1);
    return `${"  ".repeat(depth + 1)}<${tag}${attrs.join("")}>${content}</${tag}>`;
  });
  return `${"  ".repeat(depth)}<tr>\n${cells.join("\n")}\n${"  ".repeat(depth)}</tr>`;
}

function renderInline(nodes: AnyNode[] | undefined, ctx: Ctx): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      const kids = (): string => renderInline(n.children as AnyNode[] | undefined, ctx);
      switch (n.type) {
        case "text":
          return escapeText(typeof n["value"] === "string" ? n["value"] : "");
        case "strong": return `<strong>${kids()}</strong>`;
        case "emphasis": return `<em>${kids()}</em>`;
        case "delete": return `<del>${kids()}</del>`;
        case "underline": return `<u>${kids()}</u>`;
        case "insertion": return `<ins>${kids()}</ins>`;
        case "deletion": return `<del>${kids()}</del>`;
        case "highlight": return `<mark>${kids()}</mark>`;
        case "subscript": return `<sub>${kids()}</sub>`;
        case "superscript": return `<sup>${kids()}</sup>`;
        case "smallCaps": return `<span style="font-variant: small-caps">${kids()}</span>`;
        case "inlineCode": return `<code>${escapeText(String(n["value"] ?? ""))}</code>`;
        case "inlineMath": return `<span class="math math-inline">${escapeText(String(n["value"] ?? ""))}</span>`;
        case "break": return "<br>";
        case "link": {
          const url = escapeAttr(String(n["url"] ?? ""));
          const title = n["title"] ? ` title="${escapeAttr(String(n["title"]))}"` : "";
          return `<a href="${url}"${title}>${kids()}</a>`;
        }
        case "crossReference": {
          const target = escapeAttr(String(n["targetKey"] ?? ""));
          return `<a href="#${target}">${kids()}</a>`;
        }
        case "image": {
          const src = escapeAttr(String(n["url"] ?? ""));
          // Absent alt and empty alt differ: empty declares the image decorative,
          // absent means nobody said. Only emit the attribute when we know.
          const alt = n["alt"] !== undefined ? ` alt="${escapeAttr(String(n["alt"]))}"` : "";
          const title = n["title"] ? ` title="${escapeAttr(String(n["title"]))}"` : "";
          return `<img src="${src}"${alt}${title}>`;
        }
        case "footnoteReference": {
          const id = escapeAttr(String(n["identifier"] ?? ""));
          return `<sup class="footnote-ref"><a href="#fn-${id}">${escapeText(String(n["label"] ?? id))}</a></sup>`;
        }
        case "comment": {
          // The commented range is body text and stays body text; the reviewer's note
          // becomes the HTML comment. Rendering the *children* inside `<!-- -->` — which
          // is what this did — hid the document inside the annotation and dropped the note.
          const body = n["body"] as AnyNode | undefined;
          const note = body ? plainText(body).replace(/\s+/g, " ").trim() : "";
          const author = typeof n["author"] === "string" ? `[${n["author"]}] ` : "";
          return `${kids()}<!-- comment ${escapeText(author + note).replace(/--/g, "- -")} -->`;
        }
        case "html":
          return typeof n["value"] === "string" ? n["value"] : "";
        default:
          return Array.isArray(n.children) ? kids() : "";
      }
    })
    .join("");
}

function block(tag: string, content: string, depth: number, attrs = ""): string {
  if (content.trim() === "") return `<${tag}${attrs}></${tag}>`;
  const pad = "  ".repeat(depth + 1);
  const indented = content
    .split("\n")
    .map((line) => (line.trim() === "" ? line : pad + line.replace(/^\s+/, "")))
    .join("\n");
  return `<${tag}${attrs}>\n${indented}\n${"  ".repeat(depth)}</${tag}>`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((l) => (l.trim() === "" ? l : pad + l)).join("\n");
}

/** Escapes text content. `<`, `>`, and `&` only — quotes are safe outside attributes. */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function plainText(node: AnyNode): string {
  let out = "";
  const walk = (n: AnyNode): void => {
    if ((n.type === "text" || n.type === "inlineCode") && typeof n["value"] === "string") out += n["value"];
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(node);
  return out;
}

/**
 * A stable, unique slug for a heading id.
 *
 * Deterministic: the same document always produces the same ids, including the
 * `-2` suffix on a repeated heading. Ids that shifted between runs would break
 * every bookmark into the document.
 */
function uniqueSlug(text: string, used: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

export const DEFAULT_STYLESHEET = `
:root { --fg: #1a1a1a; --bg: #fff; --muted: #666; --border: #ddd; --code-bg: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e6e6; --bg: #111; --muted: #999; --border: #333; --code-bg: #1c1c1c; }
}
body { max-width: 42rem; margin: 2rem auto; padding: 0 1rem;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); background: var(--bg); }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2em 0 0.5em; }
h1 { font-size: 1.8em } h2 { font-size: 1.45em } h3 { font-size: 1.2em }
code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
pre { background: var(--code-bg); padding: 1rem; overflow-x: auto; border-radius: 4px; }
code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 3px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1.5em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
thead th { background: var(--code-bg); }
blockquote { margin: 1.5em 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--muted); }
figure { margin: 1.5em 0; } figcaption { color: var(--muted); font-size: 0.9em; }
aside.admonition { border-left: 3px solid var(--border); padding: 0.5rem 1rem; margin: 1.5em 0; }
img { max-width: 100%; height: auto; }
`.trim();
