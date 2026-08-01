/**
 * Normalisation, per docs/SPEC.md §2.8.
 *
 * This is the *only* place whitespace rules are applied (brief §5.1: "normalize
 * whitespace once, at the IR level"). Every adapter runs it, so a whitespace bug is
 * fixed once rather than once per input format.
 *
 * The guarantee that matters: `normalize(normalize(x)) === normalize(x)`. It is
 * property-tested rather than argued, because idempotency claims are easy to make
 * and easy to get subtly wrong — rule 4 (merging adjacent marks) can expose a new
 * merge opportunity that rule 4 itself created.
 */
import type { AnyNode } from "./traverse.js";
import { visit, transformChildren } from "./traverse.js";
import type { StyleEvidence } from "./document.js";
import { DiagnosticBag } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";

export interface NormalizeOptions {
  /** Rule 1: empty paragraphs become spacing evidence on the following block. */
  emptyParagraphsToSpacing: boolean;
  /** Rule 3: interior whitespace runs collapse to a single space. */
  collapseInteriorWhitespace: boolean;
  /** Rule 2: `break` nodes survive as breaks, never promoted to paragraph splits. */
  preserveHardBreaks: boolean;
  /** Rule 3: trailing whitespace trimmed at block boundaries. */
  trimTrailing: boolean;
  /**
   * Rule 7: a table cell containing exactly one paragraph unwraps to that
   * paragraph's children.
   *
   * This exists so every adapter agrees on one shape for a simple cell. Markdown and
   * HTML produce phrasing content directly; DOCX and PPTX wrap it in a paragraph,
   * because that is what those formats contain. Both are schema-legal, and leaving
   * both in circulation meant `md -> docx -> md` came back structurally different from
   * its source: `clean-report.md` gained 16 paragraphs, one per table cell, and the
   * structural fidelity score dropped accordingly.
   *
   * Unwrapping the single-paragraph case picks the flatter shape as canonical. A cell
   * with two paragraphs, a list, or a nested table keeps its blocks, because there the
   * structure is real.
   */
  unwrapSingleParagraphCells: boolean;
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  emptyParagraphsToSpacing: true,
  collapseInteriorWhitespace: true,
  preserveHardBreaks: true,
  trimTrailing: true,
  unwrapSingleParagraphCells: true,
};

/** Types whose text is literal and must never be whitespace-normalised. */
const VERBATIM = new Set(["code", "inlineCode", "math", "inlineMath", "equationBlock", "yaml", "toml", "html"]);

/** Inline marks that merge when adjacent and identical (rule 4). */
const MERGEABLE_MARKS = new Set([
  "emphasis",
  "strong",
  "delete",
  "underline",
  "smallCaps",
  "subscript",
  "superscript",
]);

const SOFT_HYPHEN = "\u00ad";
/**
 * Rule 5: non-breaking spaces are *semantic*, not whitespace, so they are excluded
 * here. The class is written as escapes rather than literal characters for two
 * reasons: the source stays ASCII, and an invisible separator inside a character
 * class is unreviewable. The first version of this line literally contained U+2028
 * and U+2029, which are JavaScript line terminators and are illegal in a regex
 * literal — it did not parse, and the reason was invisible in the diff.
 *
 * Collapsed: space, tab, CR, LF, form feed, vertical tab, and the Unicode line and
 * paragraph separators (escaped).
 * Preserved: U+00A0 no-break, U+202F narrow no-break, U+2007 figure space.
 */
const COLLAPSIBLE_WS = /[ \t\r\n\f\v\u2028\u2029]+/g;

/** Normalisation is a deterministic rule, so its diagnostics say so (SPEC §2.5). */
const NORMALIZER = { kind: "rule" as const, name: "ir.normalize", version: "0.1.0" };

export interface NormalizeResult {
  diagnostics: DiagnosticBag;
  changed: number;
}

export function normalize(
  root: AnyNode,
  sidecar: Record<string, StyleEvidence> = {},
  options: Partial<NormalizeOptions> = {},
): NormalizeResult {
  const opts = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
  const diagnostics = new DiagnosticBag(NORMALIZER);
  let changed = 0;

  // Rule 5 first: NFC and soft hyphens. Doing this before any comparison means
  // later rules compare normalised strings, so "é" as e+U+0301 and as U+00E9 merge
  // rather than staying distinct siblings.
  visit(root, (n) => {
    if (typeof n["value"] !== "string") return;
    const before = n["value"];
    let after = before.normalize("NFC");
    if (!VERBATIM.has(n.type) && after.includes(SOFT_HYPHEN)) {
      after = after.split(SOFT_HYPHEN).join("");
      diagnostics.info(
        DiagnosticCode.NORM_SOFT_HYPHEN_REMOVED,
        "Removed discretionary (soft) hyphen; it is a rendering hint, not content.",
        typeof n.id === "string" ? { nodeId: n.id } : {},
      );
    }
    if (after !== before) {
      n["value"] = after;
      changed++;
    }
  });

  // Rules 3 and 4 run together to a fixed point.
  //
  // They interact, and the interaction is not obvious: trimming a block's edges can
  // empty a text node, dropping that node can make two marks adjacent, and adjacent
  // identical marks then merge. An earlier version ran merge-to-fixed-point *then*
  // trimmed once, which meant `<em/>""<em/>` normalised to `<em/><em/>` on the first
  // call and `<em/>` on the second — non-idempotent, and only caught because the
  // property test generates empty nodes that no hand-written fixture would.
  //
  // Whitespace collapsing belongs in the same loop, and leaving it outside was a
  // second non-idempotency of exactly the same shape. Collapsing ran once per text
  // node *before* the merge, so `["! ", " ", "!"]` collapsed to itself — each node
  // held a single space — then merged into `"!  !"`, a two-space run spanning the old
  // node boundary that nothing revisited. A second call collapsed it. Found by the
  // property test at seed 1458972494, and only on CI: the seed is random per run, so
  // this had been latent since the rule was written and every local run had missed it.
  let passes = 0;
  for (;;) {
    let delta = 0;
    if (opts.collapseInteriorWhitespace) delta += collapseWhitespace(root);
    delta += mergeAdjacent(root, diagnostics);
    delta += dropEmptyText(root);
    if (opts.trimTrailing) delta += trimBlockEdges(root);
    changed += delta;
    if (delta === 0) break;
    if (++passes > 32) {
      // Non-convergence is a bug in a rule, not a property of the document. Bail
      // loudly rather than hanging or silently returning a half-normalised tree.
      throw new Error(
        "@markforge/ir: normalize did not converge after 32 passes. This is a bug in a " +
          "normalisation rule — one of them is undoing another's work.",
      );
    }
  }

  // Rule 1 last: it only removes whole paragraphs, so it cannot expose new inline
  // merges, and running it after trimming means a paragraph of pure whitespace has
  // already become genuinely empty.
  if (opts.emptyParagraphsToSpacing) {
    changed += absorbEmptyParagraphs(root, sidecar, diagnostics);
  }

  // Rule 7: a table cell holding exactly one paragraph and nothing else unwraps to
  // that paragraph's children.
  if (opts.unwrapSingleParagraphCells) {
    changed += unwrapCells(root);
  }

  return { diagnostics, changed };
}

function isEmptyParagraph(n: AnyNode): boolean {
  if (n.type !== "paragraph") return false;
  const kids = Array.isArray(n.children) ? n.children : [];
  return kids.every(
    (c) => c.type === "text" && typeof c["value"] === "string" && c["value"].trim() === "",
  );
}

function absorbEmptyParagraphs(
  root: AnyNode,
  sidecar: Record<string, StyleEvidence>,
  diagnostics: DiagnosticBag,
): number {
  let removed = 0;
  const walk = (node: AnyNode): void => {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (const k of kids) walk(k);

    const next: AnyNode[] = [];
    let pendingSpacing = 0;
    let pendingFrom: string[] = [];
    for (const child of kids) {
      // An empty paragraph carrying a bottom border is not whitespace — it is how Word
      // draws a horizontal rule, and it is the *only* trace a thematic break leaves.
      // Collapsing it into spacing destroyed the construct before `@markforge/infer` could
      // read it back, so `---` round-tripped to nothing at all. Whitespace used as spacing
      // becomes spacing; whitespace that is actually a rule stays a rule.
      const bordered =
        typeof child.id === "string" && sidecar[child.id]?.paragraph?.borderBottom === true;
      if (isEmptyParagraph(child) && !bordered) {
        // Approximation, and a deliberate one: an empty paragraph's height depends
        // on its font size and line spacing, which we do not always know. 12pt is
        // recorded as evidence, not as truth, and the diagnostic says so.
        pendingSpacing += 12;
        if (typeof child.id === "string") pendingFrom.push(child.id);
        removed++;
        continue;
      }
      if (pendingSpacing > 0 && typeof child.id === "string") {
        const existing = sidecar[child.id];
        const previous = existing?.paragraph?.spaceBeforePt ?? 0;
        sidecar[child.id] = {
          origin: existing?.origin ?? "directFormatting",
          ...existing,
          paragraph: { ...existing?.paragraph, spaceBeforePt: previous + pendingSpacing },
        };
        diagnostics.info(
          DiagnosticCode.NORM_EMPTY_PARAGRAPH_REMOVED,
          `Removed ${pendingFrom.length} empty paragraph(s) used as spacing; recorded an ` +
            `estimated ${pendingSpacing}pt of spaceBefore on the following block. The value ` +
            `is an estimate: an empty paragraph's height depends on its font size and line ` +
            `spacing, which are not always known. Whitespace used as structure became structure.`,
          { nodeId: child.id },
        );
      }
      pendingSpacing = 0;
      pendingFrom = [];
      next.push(child);
    }
    // Trailing empty paragraphs have nothing to attach to, so they are simply gone.
    if (pendingSpacing > 0) {
      diagnostics.info(
        DiagnosticCode.NORM_EMPTY_PARAGRAPH_REMOVED,
        `Removed ${pendingFrom.length} trailing empty paragraph(s) with no following ` +
          `block to carry the spacing.`,
      );
    }
    node.children = next;
  };
  walk(root);
  return removed;
}

/** Whether two inline mark nodes are the same mark with the same attributes. */
function sameMark(a: AnyNode, b: AnyNode): boolean {
  if (a.type !== b.type || !MERGEABLE_MARKS.has(a.type)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === "children" || k === "id" || k === "position" || k === "contentHash") continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/**
 * Rule 3: interior whitespace runs collapse to a single space.
 *
 * Returns the number of nodes changed so the caller's convergence loop can see it.
 * Verbatim containers are left alone — collapsing whitespace inside a code block
 * would change what the code means.
 */
function collapseWhitespace(root: AnyNode): number {
  let changed = 0;
  visit(root, (n, ctx) => {
    if (n.type !== "text" || typeof n["value"] !== "string") return;
    const parent = ctx.parent;
    if (parent && VERBATIM.has(parent.type)) return;
    const before = n["value"];
    const after = before.replace(COLLAPSIBLE_WS, " ");
    if (after !== before) {
      n["value"] = after;
      changed += 1;
    }
  });
  return changed;
}

function mergeAdjacent(root: AnyNode, diagnostics: DiagnosticBag): number {
  let merges = 0;
  const walk = (node: AnyNode): void => {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (const k of kids) walk(k);
    if (VERBATIM.has(node.type)) return;

    const out: AnyNode[] = [];
    for (const child of kids) {
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.type === "text" &&
        child.type === "text" &&
        typeof prev["value"] === "string" &&
        typeof child["value"] === "string"
      ) {
        prev["value"] = prev["value"] + child["value"];
        merges++;
        continue;
      }
      if (prev && sameMark(prev, child)) {
        prev.children = [
          ...(Array.isArray(prev.children) ? prev.children : []),
          ...(Array.isArray(child.children) ? child.children : []),
        ];
        diagnostics.info(
          DiagnosticCode.NORM_MARKS_MERGED,
          `Merged adjacent identical ${child.type} marks.`,
          typeof prev.id === "string" ? { nodeId: prev.id } : {},
        );
        merges++;
        continue;
      }
      out.push(child);
    }
    node.children = out;
  };
  walk(root);
  return merges;
}

/**
 * Removes zero-length text nodes.
 *
 * They carry no content but do separate their siblings, so leaving them in means
 * two identical marks either side never merge. Part of the convergence loop rather
 * than a one-off pass, because removing one can enable a merge that enables another.
 */
function dropEmptyText(root: AnyNode): number {
  let removed = 0;
  visit(root, (n) => {
    const kids = n.children;
    if (!Array.isArray(kids) || VERBATIM.has(n.type)) return;
    const next = kids.filter(
      (c) => !(c.type === "text" && typeof c["value"] === "string" && c["value"] === ""),
    );
    if (next.length !== kids.length) {
      removed += kids.length - next.length;
      n.children = next;
    }
  });
  return removed;
}

/**
 * Unwraps a table cell that holds exactly one paragraph.
 *
 * Only the unambiguous case: one child, of type `paragraph`. Anything else — two
 * paragraphs, a list, a nested table — is left alone, because there the block
 * structure carries meaning that flattening would destroy.
 */
function unwrapCells(root: AnyNode): number {
  let unwrapped = 0;
  visit(root, (n) => {
    if (n.type !== "tableCell") return;
    const kids = n.children;
    if (!Array.isArray(kids) || kids.length !== 1) return;
    const only = kids[0]!;
    if (only.type !== "paragraph") return;
    const inner = Array.isArray(only.children) ? only.children : [];
    // An empty cell keeps its paragraph: OOXML requires at least one, and stripping it
    // would make a written DOCX unopenable rather than merely empty.
    if (inner.length === 0) return;
    n.children = inner;
    unwrapped++;
  });
  return unwrapped;
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "caption",
  "descriptionTerm",
  "descriptionDetails",
]);

function trimBlockEdges(root: AnyNode): number {
  let trimmed = 0;
  visit(root, (n) => {
    if (!BLOCK_TYPES.has(n.type)) return;
    const kids = n.children;
    if (!Array.isArray(kids) || kids.length === 0) return;

    const first = kids[0]!;
    if (first.type === "text" && typeof first["value"] === "string") {
      const v = first["value"].replace(/^[ \t]+/, "");
      if (v !== first["value"]) {
        first["value"] = v;
        trimmed++;
      }
    }
    const last = kids[kids.length - 1]!;
    if (last.type === "text" && typeof last["value"] === "string") {
      const v = last["value"].replace(/[ \t]+$/, "");
      if (v !== last["value"]) {
        last["value"] = v;
        trimmed++;
      }
    }
    // Emptied text nodes are left for dropEmptyText, which runs in the same
    // convergence loop. Deleting them here too would duplicate the rule in two
    // places and make the loop's change count wrong.
  });
  return trimmed;
}

export { transformChildren };
