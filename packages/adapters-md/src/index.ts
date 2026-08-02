/**
 * @markforge/adapters-md — Markdown to IR.
 *
 * Built on `mdast-util-from-markdown` with the GFM, frontmatter, and math
 * extensions, because ADR-0001 chose extended mdast as the IR foundation: the
 * mapping is close to identity for standard constructs, and identity mappings do
 * not lose things.
 *
 * The interesting work is the constructs mdast has no node for. Those become
 * `unknown` nodes with a lossy diagnostic rather than being dropped, so
 * `md → ir → md` can put them back (SPEC §3.2) instead of quietly eating them.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import { parseHtmlDocument } from "@markforge/adapters-html";
import {
  DiagnosticBag,
  DiagnosticCode,
  assignIds,
  contentHashOfBytes,
  emptyDocument,
  normalize,
  visit,
  type AnyNode,
  type MarkForgeDocument,
  type Provenance,
} from "@markforge/ir";

const ADAPTER = { kind: "adapter" as const, name: "@markforge/adapters-md", version: "0.1.0" };

export interface MarkdownParseOptions {
  path?: string;
  normalize?: boolean;
}

export interface MarkdownParseResult {
  document: MarkForgeDocument;
  diagnostics: DiagnosticBag;
}

/**
 * mdast node types that map straight onto IR node types. Listed explicitly rather
 * than passed through, so a new mdast node type shows up as `unknown` with a
 * diagnostic instead of silently entering the IR unvalidated.
 */
const PASSTHROUGH = new Set([
  "root", "paragraph", "heading", "blockquote", "list", "listItem", "code",
  "thematicBreak", "definition", "table", "tableRow", "tableCell",
  "footnoteDefinition", "text", "emphasis", "strong", "inlineCode", "break",
  "link", "image", "linkReference", "imageReference", "delete",
  "footnoteReference", "html", "yaml", "toml", "math", "inlineMath",
]);

export function parseMarkdown(
  source: string | Uint8Array,
  options: MarkdownParseOptions = {},
): MarkdownParseResult {
  const diagnostics = new DiagnosticBag(ADAPTER);
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);

  const tree = fromMarkdown(text, {
    extensions: [gfm(), frontmatter(["yaml", "toml"]), math()],
    mdastExtensions: [
      gfmFromMarkdown(),
      frontmatterFromMarkdown(["yaml", "toml"]),
      mathFromMarkdown(),
    ],
  });

  const doc = emptyDocument();
  const sourceId = "s0";
  doc.sources[sourceId] = {
    sourceId,
    displayPath: options.path ?? "document.md",
    mediaType: "text/markdown",
    contentHash: contentHashOfBytes(bytes),
    byteLength: bytes.byteLength,
    adapter: { name: ADAPTER.name, version: ADAPTER.version },
  };

  // Source positions are captured against node identity during conversion, then
  // keyed by id once ids exist. Keeping them means a diagnostic can point at a line
  // in the user's file rather than at the file as a whole.
  const positions = new Map<AnyNode, MarkdownPosition>();
  const body = convert(tree as unknown as AnyNode, diagnostics, positions);
  doc.body = body as unknown as MarkForgeDocument["body"];

  assignIds(doc.body as unknown as AnyNode);
  if (typeof doc.body.id === "string") doc.id = doc.body.id;
  if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;

  attachProvenance(doc, sourceId, positions);

  if (options.normalize !== false) {
    const result = normalize(doc.body as unknown as AnyNode, doc.sidecar);
    diagnostics.merge(result.diagnostics);
    assignIds(doc.body as unknown as AnyNode);
    if (typeof doc.body.id === "string") doc.id = doc.body.id;
    if (typeof doc.body.contentHash === "string") doc.contentHash = doc.body.contentHash;
    attachProvenance(doc, sourceId, positions);
  }

  doc.diagnostics = diagnostics.all();
  return { document: doc, diagnostics };
}

interface MarkdownPosition {
  line: number;
  column: number;
  offset: number;
}

/** Recursively maps an mdast tree onto IR nodes, stripping mdast-only fields. */
function convert(
  node: AnyNode,
  diagnostics: DiagnosticBag,
  positions: Map<AnyNode, MarkdownPosition>,
): AnyNode {
  /*
   * GFM alerts: a blockquote whose first line is `[!NOTE]` is an admonition.
   *
   * `render-md` has emitted this shape for `admonition` nodes since Phase 2, and nothing read
   * it back — so an admonition round-tripped to a blockquote and the type was destroyed on
   * every loop. Found by the flavour-distinctness gate, which could not separate Docusaurus,
   * GFM, and Obsidian because the probe's admonition never became an `admonition` node in the
   * first place: the three presets differ only in how they *spell* a type nothing produced.
   *
   * The marker is consumed rather than kept as text, which is what makes the round trip
   * lossless: re-rendering writes it back in whichever spelling the target flavour uses.
   */
  if (node.type === "blockquote" && Array.isArray(node.children)) {
    const first = node.children[0] as AnyNode | undefined;
    const firstText = first?.type === "paragraph" ? (first.children?.[0] as AnyNode | undefined) : undefined;
    const value = typeof firstText?.["value"] === "string" ? firstText["value"] : "";
    const marker = /^\[!([A-Za-z]+)\]\s*\n?/.exec(value);
    if (marker) {
      const rest = value.slice(marker[0].length);
      const trimmed: AnyNode[] = [...(node.children as AnyNode[])];
      if (rest.trim() === "") {
        trimmed.shift();
      } else {
        trimmed[0] = {
          ...(first as AnyNode),
          children: [{ type: "text", value: rest }, ...((first?.children ?? []).slice(1) as AnyNode[])],
        };
      }
      const admonition: AnyNode = {
        type: "admonition",
        kind: (marker[1] as string).toLowerCase(),
        children: trimmed.map((c) => convert(c, diagnostics, positions)),
      };
      recordPosition(node, admonition, positions);
      return admonition;
    }
  }

  if (!PASSTHROUGH.has(node.type)) {
    // A6: never drop. An unknown construct survives with its source text so a
    // renderer can put it back verbatim (SPEC §3.2).
    diagnostics.degraded(
      DiagnosticCode.MD_UNKNOWN_CONSTRUCT,
      node.type,
      `Markdown construct "${node.type}" has no IR node type; preserved as an unknown ` +
        `node so it survives the round trip rather than being dropped.`,
    );
    const preserved: AnyNode = {
      type: "unknown",
      construct: node.type,
      raw: typeof node["value"] === "string" ? node["value"] : "",
    };
    recordPosition(node, preserved, positions);
    return preserved;
  }

  const out: AnyNode = { type: node.type };
  recordPosition(node, out, positions);

  /*
   * SPEC §2.7.1 makes `rowSpan`, `colSpan`, and `isHeader` **required** on every cell, and
   * records that four adapters once omitted them so every table they produced failed
   * validation — fixed by routing cell construction through `tableCell()` in `@markforge/ir`.
   *
   * This adapter never took that route. It copies mdast nodes field by field, and mdast has
   * no such fields, so **every Markdown document containing a table produced an invalid IR**.
   * `markforge check fixtures/md/clean-report.md` says INVALID and `pnpm verify` is green,
   * because no gate validates a Markdown-parsed table — the fixture-backed validation tests
   * all start from DOCX or HTML.
   *
   * Supplied here rather than by calling `tableCell()` because the surrounding loop copies
   * mdast fields onto `out` afterwards, and a constructed node would be overwritten by it.
   */
  if (node.type === "tableCell") {
    out["rowSpan"] = 1;
    out["colSpan"] = 1;
    out["isHeader"] = false;
  }

  // mdast carries `position` on every node. It is excluded from node ids by
  // construction (ADR-0014) but keeping it would bloat the IR and make diffs noisy,
  // so it is dropped here rather than carried and ignored.
  //
  // `data` goes with it, for a sharper reason: remark plugins hang hast rendering hints
  // there (remark-math writes `hName`, `hProperties`, and a *copy of the value* as
  // `hChildren`), the IR schema declares no such field, and `unevaluatedProperties: false`
  // rejects it. Every `$…$` in every Markdown fixture produced an invalid IR.
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "children" || key === "position" || key === "data") continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }

  // Headings need both depth and resolvedLevel. In Markdown they always agree —
  // the syntax caps at 6 and carries no deeper level — but the IR requires both so
  // that a DOCX heading at outline level 7 has somewhere to put the truth.
  if (node.type === "heading") {
    const depth = typeof node["depth"] === "number" ? node["depth"] : 1;
    out["depth"] = depth;
    out["resolvedLevel"] = depth;
  }

  // GFM tables carry alignment on the table; mdast puts `align` on the table node
  // as an array, and the IR keeps it there, so no translation is needed.
  //
  // The header row does need translating. In GFM the first row *is* the header —
  // that is what the delimiter line means — but mdast records no count, so the IR
  // has to say so explicitly or every renderer emits a table with no <thead> and no
  // repeated header when it breaks across pages.
  if (node.type === "table" && Array.isArray(node.children) && node.children.length > 0) {
    out["headerRowCount"] = 1;
  }

  if (Array.isArray(node.children)) {
    // flatMap, not map: recovering an embedded HTML block can yield several block
    // nodes where mdast had one `html` node.
    out.children = node.children.flatMap((c) =>
      convertNodes(c as AnyNode, diagnostics, positions),
    );
  }

  return out;
}

/**
 * Block-level HTML elements worth reading as structure rather than as text.
 *
 * Each one is here because `@markforge/adapters-html` recovers it into real IR —
 * verified, not assumed. `table` is the one that matters most: GFM pipe syntax cannot
 * express a merged cell, so `@markforge/render-md` writes merged tables as HTML, and
 * without this the round trip would return that table as an opaque string.
 *
 * Deliberately excludes `div`, `span`, and comments. A `div` carries no semantics
 * worth recovering, and comments are how an `unknown` node preserves its source
 * across a round trip (SPEC §3.2) — parsing those back would break that.
 */
const RECOVERABLE_HTML_BLOCKS = new Set([
  "table", "ul", "ol", "dl", "blockquote", "figure",
]);

/**
 * Converts one mdast node, expanding a recoverable HTML block into IR.
 *
 * Real-world Markdown carries HTML for everything Markdown cannot say, and treating
 * it as an opaque string is a silent content loss: the text is not searchable, the
 * table has no cells, and a DOCX renderer emits the markup as literal prose. Where
 * the HTML adapter can read the block, reading it is strictly better.
 */
function convertNodes(
  node: AnyNode,
  diagnostics: DiagnosticBag,
  positions: Map<AnyNode, MarkdownPosition>,
): AnyNode[] {
  if (node.type !== "html") return [convert(node, diagnostics, positions)];

  const raw = typeof node["value"] === "string" ? node["value"] : "";
  const tag = balancedBlockTag(raw);
  if (tag === undefined) return [convert(node, diagnostics, positions)];

  const { document: parsed, diagnostics: nested } = parseHtmlDocument(raw, {
    path: "embedded.html",
  });
  const recovered = (parsed.body as unknown as AnyNode).children as AnyNode[] | undefined;
  if (!recovered || recovered.length === 0) return [convert(node, diagnostics, positions)];

  diagnostics.merge(nested);
  diagnostics.info(
    DiagnosticCode.MD_EMBEDDED_HTML_RECOVERED,
    `Embedded <${tag}> block parsed as structure rather than kept as raw HTML, so its ` +
      `content is in the IR. Nothing was lost; a Markdown renderer writes it back out.`,
  );
  for (const r of recovered) recordPosition(node, r, positions);
  return recovered;
}

/**
 * Returns the tag name if the string is exactly one balanced recoverable block.
 *
 * The balance check is what keeps this safe. A CommonMark HTML block ends at a blank
 * line, so `<div>\n\ntext\n\n</div>` reaches mdast as *three* nodes — an opening tag,
 * a paragraph, a closing tag. Parsing a fragment that only opens a tag would swallow
 * the rest of the document into it, so anything that does not open and close within
 * the one node is left exactly as it is today.
 */
function balancedBlockTag(raw: string): string | undefined {
  const html = raw.trim();
  const open = /^<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/.exec(html);
  if (!open) return undefined;
  const tag = open[1]!.toLowerCase();
  if (!RECOVERABLE_HTML_BLOCKS.has(tag)) return undefined;
  if (!new RegExp(`</${tag}\\s*>$`, "i").test(html)) return undefined;

  // One block, not several siblings: `<ul>…</ul><ul>…</ul>` would pass the ends-with
  // test while the first tag closes early, so require the opening tag to be the only
  // unclosed one until the very end.
  let depth = 0;
  const tagPattern = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, "gi");
  for (let m = tagPattern.exec(html); m !== null; m = tagPattern.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0 && tagPattern.lastIndex !== html.length) return undefined;
  }
  return depth === 0 ? tag : undefined;
}

/**
 * Copies mdast's source position onto the IR node's entry in the position map.
 *
 * The position is *not* copied onto the node itself: `position` is excluded from
 * node ids by construction (ADR-0014), but carrying it would still bloat the IR and
 * make every `.mfir.json` diff noisy with coordinates nobody reads. The side table
 * keeps the information available without putting it in the tree.
 */
function recordPosition(
  source: AnyNode,
  target: AnyNode,
  positions: Map<AnyNode, MarkdownPosition>,
): void {
  const pos = source["position"] as
    | { start?: { line?: number; column?: number; offset?: number } }
    | undefined;
  const start = pos?.start;
  if (!start || typeof start.line !== "number") return;
  positions.set(target, {
    line: start.line,
    column: start.column ?? 1,
    offset: start.offset ?? 0,
  });
}

/** A4: every node gets provenance, with a real line and column where mdast gave one. */
function attachProvenance(
  doc: MarkForgeDocument,
  sourceId: string,
  positions: Map<AnyNode, MarkdownPosition>,
): void {
  const provenance: Record<string, Provenance> = {};
  visit(doc.body as unknown as AnyNode, (n) => {
    if (typeof n.id !== "string") return;
    // Nodes created by normalisation (a merged text run, say) have no source
    // position of their own. They fall back to the start of the file rather than
    // being left without provenance: rule A4 requires an entry to exist, and a
    // weak-but-true locator beats making provenance optional in practice.
    const pos = positions.get(n) ?? { line: 1, column: 1, offset: 0 };
    provenance[n.id] = {
      sourceId,
      producedBy: ADAPTER,
      locator: { kind: "markdown", ...pos },
    };
  });
  doc.provenance = provenance;
}
