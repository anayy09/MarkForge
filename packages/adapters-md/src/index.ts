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
      originalType: node.type,
      raw: typeof node["value"] === "string" ? node["value"] : "",
    };
    recordPosition(node, preserved, positions);
    return preserved;
  }

  const out: AnyNode = { type: node.type };
  recordPosition(node, out, positions);

  // mdast carries `position` on every node. It is excluded from node ids by
  // construction (ADR-0014) but keeping it would bloat the IR and make diffs noisy,
  // so it is dropped here rather than carried and ignored.
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "children" || key === "position") continue;
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
    out.children = node.children.map((c) => convert(c as AnyNode, diagnostics, positions));
  }

  return out;
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
