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
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  emptyParagraphsToSpacing: true,
  collapseInteriorWhitespace: true,
  preserveHardBreaks: true,
  trimTrailing: true,
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

  // Rule 3: whitespace inside text nodes.
  if (opts.collapseInteriorWhitespace) {
    visit(root, (n, ctx) => {
      if (n.type !== "text" || typeof n["value"] !== "string") return;
      const parent = ctx.parent;
      if (parent && VERBATIM.has(parent.type)) return;
      const before = n["value"];
      const after = before.replace(COLLAPSIBLE_WS, " ");
      if (after !== before) {
        n["value"] = after;
        changed++;
      }
    });
  }

  // Rules 3 and 4 run together to a fixed point.
  //
  // They interact, and the interaction is not obvious: trimming a block's edges can
  // empty a text node, dropping that node can make two marks adjacent, and adjacent
  // identical marks then merge. An earlier version ran merge-to-fixed-point *then*
  // trimmed once, which meant `<em/>""<em/>` normalised to `<em/><em/>` on the first
  // call and `<em/>` on the second — non-idempotent, and only caught because the
  // property test generates empty nodes that no hand-written fixture would.
  //
  // Running all three in one convergence loop removes the ordering question.
  let passes = 0;
  for (;;) {
    let delta = mergeAdjacent(root, diagnostics);
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
      if (isEmptyParagraph(child)) {
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
