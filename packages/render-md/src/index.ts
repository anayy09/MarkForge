/**
 * @markforge/render-md — IR to Markdown.
 *
 * ADR-0006: `mdast-util-to-markdown` with a **pinned** option set. Pinned is the
 * whole point — half of these options have defaults that are perfectly reasonable
 * and produce output that changes when the library changes its mind. A formatter
 * whose output depends on a transitive dependency's default is not idempotent
 * across upgrades, and `fmt --check` would start failing in CI for no local reason.
 *
 * `fmt` is provably idempotent, and that is property-tested rather than asserted, so
 * every option below is a decision rather than an omission.
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

import { resolveFlavor, type FlavorPreset } from "./flavors.js";

export interface MarkdownRenderOptions {
  /**
   * Flavour preset (SPEC §4.1). Decides which constructs can be expressed and how they are
   * spelled; `flavors.ts` holds the data.
   *
   * This option existed in the config schema from Phase 0 and was read by nothing until
   * 2026-08-01 — `flavor: "commonmark"` produced GFM. ADR-0021.
   */
  flavor?: string;
  /** ATX (`#`) or Setext (`===`) headings. ATX round-trips at every level. */
  headings?: "atx" | "setext";
  bullet?: "-" | "*" | "+";
  emphasis?: "_" | "*";
  strong?: "_" | "*";
  fence?: "`" | "~";
  /** `one` keeps list indentation at one space past the marker. */
  listIndent?: "one" | "tab" | "mixed";
  /**
   * What to do with tracked changes (SPEC §7). Same three modes, same meanings, as the DOCX
   * writer and the PDF renderer — this renderer ignored the option until 2026-08-02.
   */
  revisionMode?: "clean" | "showInsertions" | "showAll";
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
  flavor: "gfm",
  headings: "atx",
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fence: "`",
  listIndent: "one",
  revisionMode: "clean",
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
  const preset = resolveFlavor(options.flavor ?? DEFAULT_MD_OPTIONS.flavor);
  // Preset first, explicit options second: a caller who sets `bullet` means it, and a
  // flavour is a default rather than a lock.
  const opts = { ...DEFAULT_MD_OPTIONS, ...preset.stringify, ...options } as Required<MarkdownRenderOptions>;
  const diagnostics = new DiagnosticBag(RENDERER);

  const tree = toMdast(doc.body as unknown as AnyNode, { diagnostics, opts, preset });
  let markdown = toMarkdown(tree as never, buildOptions(opts));

  // toMarkdown does not guarantee a trailing newline in every configuration, and a
  // file that sometimes ends with one is a diff that sometimes appears.
  if (!markdown.endsWith("\n")) markdown += "\n";

  return { markdown, diagnostics };
}

interface MdastContext {
  diagnostics: DiagnosticBag;
  opts: Required<MarkdownRenderOptions>;
  /** The resolved flavour. Decides what can be expressed at all, not merely how. */
  preset: FlavorPreset;
}

/**
 * Maps IR back to mdast.
 *
 * MarkForge extension nodes have no Markdown syntax. Each one is handled
 * explicitly: some degrade to the nearest standard construct, some become HTML
 * comments that survive a round trip, and the rest emit a diagnostic. Silence is
 * never an option (SPEC §1.3).
 */
/**
 * Flattens already-converted mdast children to plain text for the fenced admonition forms.
 *
 * Docusaurus, MkDocs, and Pandoc admonitions are emitted as raw blocks, so their bodies have
 * to be text by the time they get here. Only paragraph text is recovered — a list inside a
 * `:::note` would lose its markers, which is stated in docs/LIMITS.md rather than pretended
 * away.
 */
function mdChildrenToText(nodes: AnyNode[]): string {
  const line = (n: AnyNode): string => {
    if (typeof n["value"] === "string") return n["value"];
    if (Array.isArray(n.children)) return (n.children as AnyNode[]).map(line).join("");
    return "";
  };
  return nodes.map(line).filter((t) => t !== "").join("\n\n");
}

/**
 * `flatMap`, because one IR node can be several mdast nodes.
 *
 * `comment` is the case that needs it: the commented range is body text and the annotation
 * is an HTML comment beside it, so one node in becomes two out. Everything else returns a
 * single node and is unaffected.
 */
function toMdastMany(node: AnyNode, ctx: MdastContext): AnyNode[] {
  const out = toMdast(node, ctx);
  if (out === null) return [];
  return Array.isArray(out) ? out : [out];
}

function toMdast(node: AnyNode, ctx: MdastContext): AnyNode {
  const { diagnostics, opts } = ctx;
  const children = Array.isArray(node.children)
    ? node.children.flatMap((c) => toMdastMany(c as AnyNode, ctx))
    : undefined;

  switch (node.type) {
    /*
     * Capability gates: constructs this flavour cannot express at all.
     *
     * Placed before the pass-through cases on purpose. CommonMark has no footnote syntax and
     * no table syntax; MDX has neither footnotes nor safe raw HTML. Emitting `[^1]` into
     * CommonMark produces literal text a reader sees as `[^1]`, with the definition dangling
     * — which is the same invalid-output shape the DOCX footnote gap produced, arrived at
     * from the renderer side.
     *
     * This is the path SPEC §1.3's no-silent-loss rule has never been exercised against a
     * target that genuinely cannot hold a construct. `commonmark` is that target.
     */
    case "footnoteReference":
      if (ctx.preset.syntax.footnotes === false) {
        diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          "footnoteReference",
          `${ctx.preset.displayName} has no footnote syntax: the reference becomes a ` +
            `parenthetical marker and its definition is emitted as an ordinary paragraph.`,
        );
        const label = typeof node["label"] === "string" ? node["label"] : "1";
        return { type: "text", value: ` (note ${label})` };
      }
      return strip(node, children);

    case "footnoteDefinition":
      if (ctx.preset.syntax.footnotes === false) {
        const label = typeof node["label"] === "string" ? node["label"] : "1";
        return {
          type: "paragraph",
          children: [{ type: "text", value: `Note ${label}: ` }, ...(children ?? [])],
        };
      }
      return strip(node, children);

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
    // `footnoteDefinition` and `footnoteReference` are handled below when the flavour
    // cannot express them; here they pass through for the flavours that can.
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
    case "html":
      return strip(node, children);

    /*
     * Front matter is a convention, not syntax, and CommonMark has none.
     *
     * This check briefly lived at the end of the shared pass-through group above, which meant
     * `root` — the first label in that group — fell through into it and the entire document
     * was replaced by a comment containing nothing. CommonMark rendered 31 bytes. A `switch`
     * whose labels share a body shares it with *every* label, and adding a condition to the
     * body of a group is not the same as adding a case.
     */
    case "yaml":
    case "toml": {
      if (ctx.preset.syntax.frontMatter === false) {
        diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          node.type,
          `${ctx.preset.displayName} has no front-matter convention, so the block is retained ` +
            `as an HTML comment rather than emitted where a reader would show it as text.`,
        );
        // Retained rather than dropped. SPEC §1.3 asks for a diagnostic *and* retention where
        // retention is possible, and an HTML comment is CommonMark, so the metadata survives.
        const raw = typeof node["value"] === "string" ? node["value"] : "";
        return { type: "html", value: `<!-- front matter (${node.type}):\n${raw}\n-->` };
      }
      return strip(node, children);
    }

    case "math":
    case "inlineMath":
      if (ctx.preset.syntax.math === false) {
        const value = typeof node["value"] === "string" ? node["value"] : "";
        diagnostics.degraded(
          DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
          node.type,
          `${ctx.preset.displayName} has no math syntax: the expression is retained ` +
            `verbatim, so the characters survive and the typesetting does not.`,
        );
        /*
         * A block `math` degrades to a *block* — a fenced code block — and only `inlineMath`
         * degrades to `inlineCode`.
         *
         * The first version returned `inlineCode` for both, which put an inline node where the
         * root expected flow content. `mdast-util-to-markdown` then serialised the entire
         * document as phrasing: `# A` + `$$…$$` + `After.` came out as `` # A`y = 1`After. ``
         * with every blank line gone. A whole document collapsed into one line because one
         * node was the wrong *kind*, not the wrong content — and it passed the distinctness
         * gate, because collapsed output is still distinct output. Section 1 of that gate now
         * has a length floor for exactly this.
         */
        if (node.type === "math") return { type: "code", lang: "math", value };
        return { type: "inlineCode", value };
      }
      return strip(node, children);

    case "table":
      // A flavour with no table syntax gets an HTML table. CommonMark has none: pipe syntax
      // is a GFM extension, and emitting it into CommonMark produces a paragraph full of
      // vertical bars rather than a table.
      if (ctx.preset.syntax.tables === false) {
        return tableToMdast(node, children ?? [], { ...ctx, opts: { ...ctx.opts, tables: "html" } });
      }
      return tableToMdast(node, children ?? [], ctx);

    case "heading": {
      // Markdown caps at 6. A DOCX heading at resolved level 7 or deeper has no
      // syntax, so it clamps — and says so, because silently flattening a document
      // outline is exactly the kind of loss SPEC §1.3 forbids.
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
      // Markdown has no <figure>. The children survive as a paragraph, so no text is
      // lost, but the binding between an image and its caption is — and a caption that
      // is only a nearby paragraph cannot be re-bound on the way back.
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        node.type,
        `Markdown has no figure syntax: the image and caption survive as a paragraph, ` +
          `but their binding does not. Render to HTML to keep it.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
      return { type: "paragraph", children: children ?? [] };

    case "caption":
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "caption",
        `Markdown has no caption syntax: the text survives as a paragraph, so it reads ` +
          `correctly but is no longer marked as a caption.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
      return { type: "paragraph", children: children ?? [] };

    case "admonition": {
      /*
       * Every documentation ecosystem invented its own admonition syntax and none is
       * portable, so this is the construct where flavour presets earn their keep: the same
       * IR node is `:::note` in Docusaurus, `!!! note` in MkDocs, `> [!note]` in Obsidian,
       * and a fenced div in Pandoc. Before presets existed, all seven produced the GFM
       * blockquote form.
       */
      const raw = typeof node["kind"] === "string" ? node["kind"] : "note";
      const lower = raw.toLowerCase();
      const kind = raw.toUpperCase();
      const inner = children ?? [];

      const body = mdChildrenToText(inner);
      switch (ctx.preset.syntax.admonitions) {
        case "docusaurus":
          return { type: "html", value: `:::${lower}\n${body}\n:::` };
        case "mkdocs":
          // MkDocs indents the body by four spaces; the marker line is not indented.
          return { type: "html", value: `!!! ${lower}\n    ${body.replace(/\n/g, "\n    ")}` };
        case "pandoc":
          return { type: "html", value: `::: {.${lower}}\n${body}\n:::` };
        case "obsidian":
        case false:
        default:
          // Obsidian's callout and the fall-back are the same shape: a blockquote whose
          // first line marks the kind. It re-parses as a plain blockquote everywhere, so
          // nothing is lost even where the marker is not understood — which is why it is
          // the right fall-back for a flavour with no admonition syntax at all.
          return {
            type: "blockquote",
            children: [
              {
                type: "paragraph",
                children: [
                  // GitHub alerts upper-case the kind; Obsidian callouts lower-case it, and
                  // each renderer ignores the other's casing. The fall-back for a flavour
                  // with no admonition syntax uses the GFM form, because a plain blockquote
                  // is what every parser sees either way.
                  { type: "text", value: `[!${ctx.preset.syntax.admonitions === "obsidian" ? lower : kind}]` },
                ],
              },
              ...inner,
            ],
          };
      }
    }

    case "equationBlock": {
      /*
       * An equation is only expressible here if it is already TeX.
       *
       * This case used to read `value` and fall back to `""`, which was harmless while
       * nothing produced an `equationBlock` at all. The moment the DOCX adapter started
       * emitting OMML (2026-08-01), it began writing `$$\n$$` — an *empty* display-math
       * block, mid-sentence for an inline equation. That is worse than the `unknown` node it
       * replaced: an empty `$$` is syntactically valid Markdown asserting there is an
       * equation here with nothing in it, so the loss is invisible again, one layer down.
       *
       * OMML is not TeX and this renderer has no converter. SPEC §1.3 says a stage that
       * discards information emits a diagnostic and retains what it can, so the source is
       * kept as an inline code span and the loss is reported.
       */
      const notation = typeof node["notation"] === "string" ? node["notation"] : undefined;
      const value = typeof node["value"] === "string" ? node["value"] : undefined;
      const source = typeof node["source"] === "string" ? node["source"] : undefined;

      if (notation === "tex" && value) return { type: "math", value };
      if (!notation || notation === "tex") return { type: "math", value: value ?? source ?? "" };

      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "equationBlock",
        `Markdown math is TeX, and this equation is ${notation.toUpperCase()}. There is no ` +
          `${notation}-to-TeX converter here, so the equation's structure does not survive; ` +
          `its source is retained inline rather than emitted as an empty $$ block.`,
      );
      /*
       * A fenced *block*, not an inline code span.
       *
       * `inlineCode` was the right shape while every `equationBlock` sat inside a paragraph
       * — which is where the adapter wrongly put them. Once the adapter started emitting
       * them at block level, where the schema says block content belongs, a phrasing node
       * appeared among the root's children and `mdast-util-to-markdown` collapsed **the
       * entire document onto one line**: `Queue Depth Under Sustained Load# 1.
       * IntroductionAcknowledgement latency is…`. Structural fidelity on that fixture fell
       * from 0.965 to 0.359, which is what caught it.
       *
       * The same failure mode is on record twice now — see the flavour gate's note about a
       * block `math` node degraded to an inline one — so the rule it teaches is worth
       * stating plainly: a block node must map to a block node, whatever else is lost.
       */
      return {
        type: "code",
        lang: notation,
        value: source ? source.replace(/\s+/g, " ").trim() : `${notation} equation`,
      };
    }

    case "descriptionList":
      // No CommonMark or GFM definition-list syntax exists. Terms become bold
      // paragraphs and details plain ones: readable, but the association is gone and
      // a re-parse cannot tell a term from any other bold line.
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "descriptionList",
        `Markdown has no description-list syntax: terms become bold paragraphs and ` +
          `details plain ones, so the text survives but the term-to-detail association ` +
          `does not. Render to HTML or DOCX to keep it.`,
        ...(typeof node.id === "string" ? [{ nodeId: node.id }] : []),
      );
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

    /*
     * `revisionMode`, honoured here as of 2026-08-02.
     *
     * The DOCX writer and the PDF renderer both read this option; this renderer did not, so
     * `docs/LIMITS.md` recorded it as "applied nowhere on the render path" and the default —
     * `clean`, meaning *accept every revision* — produced Markdown showing both sides of
     * every edit. The three modes name exactly three behaviours and they now mean the same
     * thing on all three surfaces:
     *
     *   clean           the accepted text. Insertions in, deletions out.
     *   showInsertions  insertions marked with `<ins>`, deletions still out.
     *   showAll         both, deletions as `~~strikethrough~~`.
     */
    case "insertion":
      if (opts.revisionMode === "clean") return { type: "root", children: children ?? [] };
      return { type: "root", children: [{ type: "html", value: "<ins>" }, ...(children ?? []), { type: "html", value: "</ins>" }] };
    case "deletion": {
      if (opts.revisionMode === "showAll") return { type: "delete", children: children ?? [] };
      // Dropped, and said so: the text was in the source document and is not in the output.
      // "Accept all revisions" is a choice the user made, not a reason to say nothing.
      diagnostics.degraded(
        DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
        "deletion",
        `Tracked deletion dropped under revisionMode "${opts.revisionMode}"; use "showAll" to ` +
          `keep it as ~~strikethrough~~.`,
      );
      return null as unknown as AnyNode;
    }

    case "comment": {
      /*
       * The comment's *body* becomes an HTML comment; the text it was anchored to stays
       * body text, because it is body text.
       *
       * This used to render `textOf(node)` — the node's children — which was right while
       * the DOCX adapter emitted comments at document level with an empty `children`. When
       * the adapter started wrapping the commented range, as the schema's `Comment` always
       * required, the same line began hiding the document inside the annotation:
       * `The retention window is <!-- comment: thirty days --> for sealed records.` The
       * reviewer's question was dropped and the reader lost the words under discussion.
       */
      const body = node["body"] as AnyNode | undefined;
      const author = typeof node["author"] === "string" ? ` ${node["author"]}` : "";
      const note = body ? textOf(body).replace(/\s+/g, " ").trim() : "";
      const annotation: AnyNode = {
        type: "html",
        value: `<!--comment${author ? `[${author.trim()}]` : ""}: ${note} -->`,
      };
      // The annotation trails the range, so the anchor is still readable in source order.
      return (
        children && children.length > 0 ? [...children, annotation] : annotation
      ) as unknown as AnyNode;
    }

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
      const original = typeof node["construct"] === "string" ? node["construct"] : "unknown";
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
 * which is the failure mode SPEC §1.3 exists to forbid.
 *
 * So a merged table is written as a real HTML `<table>`, which is valid CommonMark
 * and which `@markforge/adapters-md` reads back into the same IR. Unmerged tables,
 * which is nearly all of them, still get readable pipe syntax.
 */
function tableToMdast(node: AnyNode, children: AnyNode[], ctx: MdastContext): AnyNode {
  const { diagnostics, opts } = ctx;
  const merged = mergedCellCount(node);
  const blockCells = blockContentCellCount(node);
  const inexpressible = merged + blockCells;
  const at = typeof node.id === "string" ? [{ nodeId: node.id }] : [];

  if (opts.tables === "gfm" || (opts.tables === "auto" && inexpressible === 0)) {
    if (inexpressible > 0) {
      const reasons = [
        ...(merged > 0 ? [`${merged} merged cell(s)`] : []),
        ...(blockCells > 0 ? [`${blockCells} cell(s) holding block content`] : []),
      ];
      diagnostics.degraded(
        DiagnosticCode.RENDER_TABLE_SPANS_FLATTENED,
        "table",
        `Table has ${reasons.join(" and ")}, which GFM pipe syntax cannot express: a ` +
          `pipe cell holds one line of inline content, and merges become empty cells. ` +
          `Render with tables: "auto" to emit an HTML table instead and keep them.`,
        ...at,
      );
    }
    return strip(node, children);
  }

  // renderHtmlFragment, not a local serializer: the HTML we embed must be the HTML
  // our own HTML adapter round-trips, and two serializers would drift.
  const { html, diagnostics: nested } = renderHtmlFragment([node], { headingIds: false });
  diagnostics.merge(nested);
  if (inexpressible > 0) {
    const reasons = [
      ...(merged > 0 ? [`${merged} merged cell(s)`] : []),
      ...(blockCells > 0 ? [`${blockCells} cell(s) holding block content`] : []),
    ];
    diagnostics.info(
      DiagnosticCode.RENDER_TABLE_AS_HTML,
      `Table has ${reasons.join(" and ")} and was written as an HTML table, which is ` +
        `valid Markdown and preserves both. Nothing was lost.`,
      ...at,
    );
  }
  return { type: "html", value: html.trimEnd() };
}

/**
 * Counts cells whose content a GFM pipe cell cannot hold.
 *
 * A pipe cell is one line of inline content: it cannot contain a nested table, a list,
 * a fenced code block, a blockquote, or a second paragraph. Writing such a table as
 * pipes flattens the cell to its text, or loses it — `fixtures/html/spans-ground-truth.html`
 * lost an entire nested table this way, at 88.3% structural and 77.8% text while table
 * F1 still read 88.9%, because the metric never saw the table that vanished.
 *
 * A *single* paragraph does not count. Normalisation unwraps single-paragraph cells
 * (rule 7) except empty ones, which must keep a paragraph because OOXML requires one —
 * so counting a lone paragraph would push every table with an empty cell to HTML.
 */
function blockContentCellCount(table: AnyNode): number {
  const PIPE_HOSTILE = new Set(["table", "list", "code", "blockquote", "heading", "thematicBreak"]);
  let n = 0;
  const walk = (node: AnyNode): void => {
    if (node.type === "tableCell") {
      const kids = Array.isArray(node.children) ? (node.children as AnyNode[]) : [];
      const paragraphs = kids.filter((c) => c.type === "paragraph").length;
      if (kids.some((c) => PIPE_HOSTILE.has(c.type)) || paragraphs > 1) n += 1;
      // Do not descend: a nested table's own cells are the nested table's problem, and
      // counting them would report the same loss several times.
      return;
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c as AnyNode);
  };
  walk(table);
  return n;
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

export { FLAVORS, resolveFlavor, type FlavorPreset, type FlavorSyntax } from "./flavors.js";
