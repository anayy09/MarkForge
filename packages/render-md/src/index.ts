/**
 * @markforge/render-md — IR to Markdown.
 *
 * ADR-0006: `mdast-util-to-markdown` with a **pinned** option set. Pinned is the
 * whole point — half of these options have defaults that are perfectly reasonable
 * and produce output that changes when the library changes its mind. A formatter
 * whose output depends on a transitive dependency's default is not idempotent
 * across upgrades, and `fmt --check` would start failing in CI for no local reason.
 *
 * The Phase 1 gate is that `fmt` is provably idempotent (brief §11), so every
 * option below is a decision, not an omission.
 */
import { toMarkdown, type Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { frontmatterToMarkdown } from "mdast-util-frontmatter";
import { mathToMarkdown } from "mdast-util-math";
import {
  DiagnosticBag,
  DiagnosticCode,
  cellSpan,
  type AnyNode,
  type MarkForgeDocument,
} from "@markforge/ir";
import { renderHtmlFragment } from "@markforge/render-html";

const RENDERER = { kind: "adapter" as const, name: "@markforge/render-md", version: "0.1.0" };

export interface MarkdownRenderOptions {
  /** ATX (`#`) or Setext (`===`) headings. ATX round-trips at every level. */
  headings?: "atx" | "setext";
  bullet?: "-" | "*" | "+";
  emphasis?: "_" | "*";
  strong?: "_" | "*";
  fence?: "`" | "~";
  /** `one` keeps list indentation at one space past the marker. */
  listIndent?: "one" | "tab" | "mixed";
  /**
   * Reflow width. 0 means never reflow.
   *
   * Default 0 and it matters: reflowing rewraps whole paragraphs, so changing one
   * word produces a diff spanning every following line. A formatter that makes
   * `git diff` useless will be turned off, and a formatter that is turned off
   * formats nothing.
   */
  lineWidth?: number;
  /**
   * How to write a table whose cells are merged.
   *
   * GFM pipe syntax has no `rowspan`/`colspan`, so a merged table cannot be
   * expressed: the merge is lost and covered grid positions become empty cells.
   * On `fixtures/docx/messy-combined.docx` that costs more than half the table
   * cell F1, and it is silent data loss of exactly the kind that makes a
   * conversion need manual cleanup.
   *
   * - `auto` (default) — pipe syntax when the table has no merged cells, a raw
   *   HTML `<table>` when it does. HTML blocks are CommonMark, so the output is
   *   still valid Markdown, and `@markforge/adapters-md` reads it back into the
   *   same IR. You pay the readability cost only where the alternative is losing
   *   the merge.
   * - `gfm` — always pipe syntax, flattening merges. Emits
   *   `MF-RENDER-0006` for each table it damages. Choose this when the consumer
   *   cannot handle embedded HTML and readability outranks fidelity.
   * - `html` — always a raw HTML table, merged or not. Choose this when a
   *   downstream tool needs one table syntax rather than two.
   */
  tables?: "auto" | "gfm" | "html";
}

export interface MarkdownRenderResult {
  markdown: string;
  diagnostics: DiagnosticBag;
}

export const DEFAULT_MD_OPTIONS: Required<MarkdownRenderOptions> = {
  headings: "atx",
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fence: "`",
  listIndent: "one",
  lineWidth: 0,
  tables: "auto",
};

function buildOptions(opts: Required<MarkdownRenderOptions>): ToMarkdownOptions {
  return {
    bullet: opts.bullet,
    // Alternating bullets between nesting levels is the library default and looks
    // tidy, but it makes a list's marker depend on its depth — so moving a list
    // changes characters that have nothing to do with the edit.
    bulletOther: opts.bullet === "-" ? "*" : "-",
    bulletOrdered: ".",
    emphasis: opts.emphasis,
    strong: opts.strong,
    fence: opts.fence,
    // Always fence code blocks. Indented code blocks are indistinguishable from
    // deeply nested list content on a re-parse, which breaks the round trip.
    fences: true,
    listItemIndent: opts.listIndent,
    // Setext headings only exist for levels 1 and 2, so a document with an h3
    // would mix styles. ATX everywhere is uniform and round-trips at every level.
    setext: opts.headings === "setext",
    // Escape only what must be escaped. Over-escaping is a common source of
    // non-idempotency: the escape character itself gets escaped on the next pass.
    resourceLink: false,
    // `*`, not `-`. A thematic break written as `---` at the start of a document is
    // ambiguous with a YAML front-matter opening fence, and with the front-matter
    // extension enabled the parser resolves it the other way: a document beginning
    // with a `---` rule followed by a list re-parses with the list flattened into a
    // paragraph, so `fmt` is not idempotent. `***` has no such ambiguity. Found by
    // the generated-document property test, not by any of the 35 hand-written cases.
    rule: "*",
    ruleSpaces: false,
    tightDefinitions: true,
    incrementListMarker: true,
    extensions: [gfmToMarkdown(), frontmatterToMarkdown(["yaml", "toml"]), mathToMarkdown()],
  };
}

export function renderMarkdown(
  doc: MarkForgeDocument,
  options: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  const opts = { ...DEFAULT_MD_OPTIONS, ...options };
  const diagnostics = new DiagnosticBag(RENDERER);

  const tree = toMdast(doc.body as unknown as AnyNode, { diagnostics, opts });
  let markdown = toMarkdown(tree as never, buildOptions(opts));

  // toMarkdown does not guarantee a trailing newline in every configuration, and a
  // file that sometimes ends with one is a diff that sometimes appears.
  if (!markdown.endsWith("\n")) markdown += "\n";

  return { markdown, diagnostics };
}

interface MdastContext {
  diagnostics: DiagnosticBag;
  opts: Required<MarkdownRenderOptions>;
}

/**
 * Maps IR back to mdast.
 *
 * MarkForge extension nodes have no Markdown syntax. Each one is handled
 * explicitly: some degrade to the nearest standard construct, some become HTML
 * comments that survive a round trip, and the rest emit a diagnostic. Silence is
 * never an option (brief §3.3).
 */
function toMdast(node: AnyNode, ctx: MdastContext): AnyNode {
  const { diagnostics } = ctx;
  const children = Array.isArray(node.children)
    ? node.children.map((c) => toMdast(c as AnyNode, ctx)).filter((c): c is AnyNode => c !== null)
    : undefined;

  switch (node.type) {
    // --- Standard mdast, passed straight through -------------------------
    case "root":
    case "paragraph":
    case "blockquote":
    case "list":
    case "listItem":
    case "code":
    case "thematicBreak":
    case "definition":
    case "tableRow":
    case "tableCell":
    case "footnoteDefinition":
    case "text":
    case "emphasis":
    case "strong":
    case "inlineCode":
    case "break":
    case "link":
    case "image":
    case "linkReference":
    case "imageReference":
    case "delete":
    case "footnoteReference":
    case "html":
    case "yaml":
    case "toml":
    case "math":
    case "inlineMath":
      return strip(node, children);

    case "table":
      return tableToMdast(node, children ?? [], ctx);

    case "heading": {
      // Markdown caps at 6. A DOCX heading at resolved level 7 or deeper has no
      // syntax, so it clamps — and says so, because silently flattening a document
      // outline is exactly the kind of loss brief §3.3 forbids.
      const resolved = typeof node["resolvedLevel"] === "number" ? node["resolvedLevel"] : 1;
      const depth = Math.min(6, Math.max(1, resolved));
      if (resolved > 6) {
        diagnostics.degraded(
          DiagnosticCode.RENDER_DEPTH_CLAMPED,
          "heading",
          `Heading at level ${resolved} clamped to 6: Markdown has no deeper heading ` +
            `syntax. The original level is preserved in the IR.`,
          ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
        );
      }
      return { type: "heading", depth, children: children ?? [] };
    }

    // --- MarkForge extensions with a reasonable Markdown analogue ---------
    case "section":
      // A section is a grouping node with no Markdown syntax; its children are the
      // content, so unwrapping loses nothing.
      return { type: "root", children: children ?? [] };

    case "figure":
    case "captionedFigure":
      return { type: "paragraph", children: children ?? [] };

    case "caption":
      return { type: "paragraph", children: children ?? [] };

    case "admonition": {
      // GFM alert syntax: a blockquote whose first line is [!NOTE]. It round-trips
      // through any Markdown parser as a plain blockquote, so nothing is lost even
      // where the alert syntax is not understood.
      const kind = typeof node["kind"] === "string" ? node["kind"].toUpperCase() : "NOTE";
      return {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [{ type: "text", value: `[!${kind}]` }] },
          ...(children ?? []),
        ],
      };
    }

    case "equationBlock":
      return { type: "math", value: typeof node["value"] === "string" ? node["value"] : "" };

    case "descriptionList":
      return { type: "root", children: children ?? [] };
    case "descriptionTerm":
      return { type: "paragraph", children: [{ type: "strong", children: children ?? [] }] };
    case "descriptionDetails":
      return { type: "blockquote", children: [{ type: "paragraph", children: children ?? [] }] };

    case "underline":
    case "smallCaps":
    case "highlight":
    case "subscript":
    case "superscript": {
      // No Markdown syntax. HTML is legal Markdown and round-trips, so the mark
      // survives rather than flattening to plain text.
      const tag = { underline: "u", smallCaps: "span", highlight: "mark", subscript: "sub", superscript: "sup" }[
        node.type
      ]!;
      const open = node.type === "smallCaps" ? `<span style="font-variant:small-caps">` : `<${tag}>`;
      return {
        type: "root",
        children: [
          { type: "html", value: open },
          ...(children ?? []),
          { type: "html", value: `</${tag}>` },
        ],
      };
    }

    case "insertion":
      return { type: "root", children: [{ type: "html", value: "<ins>" }, ...(children ?? []), { type: "html", value: "</ins>" }] };
    case "deletion":
      return { type: "delete", children: children ?? [] };

    case "comment":
      // A comment is not body text. It becomes an HTML comment so it survives the
      // round trip without appearing in rendered output.
      return { type: "html", value: `<!-- comment: ${textOf(node)} -->` };

    case "crossReference": {
      const target = typeof node["targetKey"] === "string" ? node["targetKey"] : "";
      return { type: "link", url: `#${target}`, children: children ?? [] };
    }

    case "citation":
      return { type: "text", value: `[@${(node["keys"] as string[] | undefined)?.join("; ") ?? ""}]` };

    case "pageBreak":
    case "columnBreak":
      // Markdown has no pagination. A thematic break is the closest visual analogue
      // and, unlike dropping it, keeps the document's shape.
      return { type: "thematicBreak" };

    case "textBox":
      return { type: "blockquote", children: children ?? [] };

    case "slide":
    case "sheet":
      return { type: "root", children: children ?? [] };

    case "unknown": {
      // Round-trip preservation (SPEC §3.2): the raw source goes back out verbatim.
      const raw = typeof node["raw"] === "string" ? node["raw"] : "";
      const original = typeof node["originalType"] === "string" ? node["originalType"] : "unknown";
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        original,
        `Construct "${original}" has no Markdown representation; emitted as an HTML ` +
          `comment so the round trip preserves it.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
      return { type: "html", value: raw.length > 0 ? raw : `<!-- markforge:unknown ${original} -->` };
    }

    default: {
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        node.type,
        `No Markdown mapping for IR node type "${node.type}"; its children are kept.`,
      );
      return { type: "root", children: children ?? [] };
    }
  }
}

/**
 * Writes a table as pipe syntax or as raw HTML.
 *
 * GFM pipe tables cannot express a merged cell. Writing one anyway does not merely
 * lose the merge: the covered grid positions come back as *empty cells*, so a 6-cell
 * table with two merges re-parses as 8 cells, only 3 of which land on their original
 * coordinates. Measured on `fixtures/docx/messy-combined.docx` that is a table cell
 * F1 of 42.9% — and until this function existed it happened without a diagnostic,
 * which is the failure mode brief §3.3 exists to forbid.
 *
 * So a merged table is written as a real HTML `<table>`, which is valid CommonMark
 * and which `@markforge/adapters-md` reads back into the same IR. Unmerged tables,
 * which is nearly all of them, still get readable pipe syntax.
 */
function tableToMdast(node: AnyNode, children: AnyNode[], ctx: MdastContext): AnyNode {
  const { diagnostics, opts } = ctx;
  const merged = mergedCellCount(node);
  const at = typeof node.id === "string" ? [{ nodeId: node.id }] : [];

  if (opts.tables === "gfm" || (opts.tables === "auto" && merged === 0)) {
    if (merged > 0) {
      diagnostics.degraded(
        DiagnosticCode.RENDER_TABLE_SPANS_FLATTENED,
        "table",
        `Table has ${merged} merged cell(s), which GFM pipe syntax cannot express: ` +
          `the merges are dropped and covered positions become empty cells. Render ` +
          `with tables: "auto" to emit an HTML table instead and keep them.`,
        ...at,
      );
    }
    return strip(node, children);
  }

  // renderHtmlFragment, not a local serializer: the HTML we embed must be the HTML
  // our own HTML adapter round-trips, and two serializers would drift.
  const { html, diagnostics: nested } = renderHtmlFragment([node], { headingIds: false });
  diagnostics.merge(nested);
  if (merged > 0) {
    diagnostics.info(
      DiagnosticCode.RENDER_TABLE_AS_HTML,
      `Table has ${merged} merged cell(s) and was written as an HTML table, which is ` +
        `valid Markdown and preserves the merges. Nothing was lost.`,
      ...at,
    );
  }
  return { type: "html", value: html.trimEnd() };
}

/** Counts cells whose span covers more than their own grid position. */
function mergedCellCount(table: AnyNode): number {
  let n = 0;
  const walk = (node: AnyNode): void => {
    if (node.type === "tableCell") {
      const { rowSpan, colSpan } = cellSpan(node as never);
      if (rowSpan > 1 || colSpan > 1) n += 1;
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c as AnyNode);
  };
  walk(table);
  return n;
}

/** Copies a node, dropping IR-only fields that mdast would not understand. */
function strip(node: AnyNode, children: AnyNode[] | undefined): AnyNode {
  const out: AnyNode = { type: node.type };
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "children" || key === "id" || key === "contentHash") continue;
    if (key === "resolvedLevel" || key === "numberLabel" || key === "restartsAt") continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  if (children) out.children = children;
  return out;
}

function textOf(node: AnyNode): string {
  let out = "";
  const walk = (n: AnyNode): void => {
    if (n.type === "text" && typeof n["value"] === "string") out += n["value"];
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(node);
  return out;
}
