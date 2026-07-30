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
  const diagnostics = new DiagnosticBag();
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
        { nodeId: typeof n.id === "string" ? n.id : undefined },
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

  // Rule 4: merge adjacent text siblings, then adjacent identical marks. Repeated
  // to a fixed point because merging two marks can make their children adjacent and
  // mergeable in turn — a single pass would leave `<em>a</em><em>b</em><em>c</em>`
  // partly merged, which would break idempotency rather than just being untidy.
  let passes = 0;
  for (;;) {
    const before = changed;
    changed += mergeAdjacent(root, diagnostics);
    if (changed === before) break;
    if (++passes > 32) {
      // A merge that never converges is a bug in the merge predicate, not a document
      // property. Bail loudly rather than hanging.
      throw new Error("@markforge/ir: normalize did not converge after 32 merge passes");
    }
  }

  // Rule 1: empty paragraphs become spacing evidence on the following block.
  if (opts.emptyParagraphsToSpacing) {
    changed += absorbEmptyParagraphs(root, sidecar, diagnostics);
  }

  // Rule 3, second half: trim at block boundaries. Last, so it sees merged text.
  if (opts.trimTrailing) {
    changed += trimBlockEdges(root);
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
        const existing = sidecar[child.id] ?? {};
        sidecar[child.id] = {
          ...existing,
          spacingBeforePt: (existing.spacingBeforePt ?? 0) + pendingSpacing,
        };
        diagnostics.info(
          DiagnosticCode.NORM_EMPTY_PARAGRAPH_REMOVED,
          `Removed ${pendingFrom.length} empty paragraph(s) used as spacing; recorded ` +
            `${pendingSpacing}pt of spacingBefore on the following block. Whitespace used ` +
            `as structure became structure.`,
          { nodeId: child.id, data: { absorbed: pendingFrom, estimated: true } },
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
        { data: { absorbed: pendingFrom } },
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
          { nodeId: typeof prev.id === "string" ? prev.id : undefined },
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
    // Text nodes emptied by trimming are dropped, so they do not survive as
    // zero-length siblings that a second normalise pass would have to handle.
    n.children = kids.filter(
      (c) => !(c.type === "text" && typeof c["value"] === "string" && c["value"] === ""),
    );
  });
  return trimmed;
}

export { transformChildren };
