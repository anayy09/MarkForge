/**
 * @markforge/infer — deterministic structure inference.
 *
 * Adapters record evidence (rule A5); this package turns evidence into structure.
 * The separation matters because inference is the part that can be *wrong*, and
 * keeping it in one package means every guess is made in one place, scored the same
 * way, and explainable by the same log.
 *
 * Two hard constraints from docs/SPEC.md §5:
 *
 *   - **Deterministic.** No model, no randomness, no wall clock. The same evidence
 *     always produces the same decision, so `--no-llm` output and LLM-assisted
 *     output differ only where a model was explicitly consulted.
 *   - **Explainable.** Every decision records its candidates, their scores, and the
 *     rule that decided. `convert --explain` prints this. A confident wrong answer
 *     with no explanation is worse than an ambiguity report.
 */
import {
  DiagnosticBag,
  DiagnosticCode,
  textContent,
  visit,
  type AnyNode,
  type MarkForgeDocument,
  type StyleEvidence,
} from "@markforge/ir";

const INFERRER = { kind: "rule" as const, name: "@markforge/infer", version: "0.1.0" };

export interface InferOptions {
  headings?: boolean;
  lists?: boolean;
  tables?: boolean;
  /**
   * Score gap below which a decision is declared ambiguous rather than taken
   * silently. Ambiguity is reported, not resolved by coin-flip.
   */
  ambiguityMargin?: number;
}

export const DEFAULT_INFER_OPTIONS: Required<InferOptions> = {
  headings: true,
  lists: true,
  tables: true,
  ambiguityMargin: 0.15,
};

/** One candidate interpretation and why it scored what it did. */
export interface Candidate {
  interpretation: string;
  score: number;
  reasons: string[];
}

/** The full record of one decision, for `--explain`. */
export interface Decision {
  nodeId: string;
  question: string;
  candidates: Candidate[];
  chosen: string;
  /** The rule that broke the tie, named so a wrong answer is traceable. */
  decidedBy: string;
  ambiguous: boolean;
}

export interface InferResult {
  decisions: Decision[];
  diagnostics: DiagnosticBag;
  /** Number of nodes whose type changed. */
  changed: number;
  /**
   * The decisions that were too close to call, in document order.
   *
   * Empty on almost every document, and the only place the LLM is permitted to touch a
   * conversion (brief §5.3, §7.1). Carries the node itself so a tie-break can be applied
   * without a second traversal, which is why this is not part of the serialisable
   * `Decision` record.
   */
  ambiguous: AmbiguousDecision[];
}

/**
 * One decision the deterministic scorer declined to make confidently.
 *
 * Everything a tie-breaker is allowed to see is here, and it is deliberately the same
 * evidence the rules used plus local context — not the whole document. A tie-breaker that
 * received the document could be tempted to reorganise it, and this one is only ever
 * asked to pick from `candidates`.
 */
export interface AmbiguousDecision {
  nodeId: string;
  question: string;
  candidates: Candidate[];
  /** What the deterministic path chose, and what stands if no tie-breaker answers. */
  chosenByRule: string;
  /** Score gap between the top two candidates. Below `ambiguityMargin` by definition. */
  margin: number;
  text: string;
  /** Resolved levels of the headings above this node, nearest last. */
  precedingHeadings: number[];
  followingText: string;
  /** The live node. Not serialised. */
  node: AnyNode;
  /**
   * The node's children before promotion stripped a whole-node mark, so demoting back to
   * a paragraph restores the bold that was the evidence rather than silently dropping it.
   */
  originalChildren: AnyNode[];
}

/**
 * Chooses between the candidates of one ambiguous decision.
 *
 * Returning `undefined` means "no answer" — the deterministic choice stands. That is the
 * contract that keeps `--no-llm` and a failed LLM call producing the same document.
 *
 * Injected rather than imported: `@markforge/infer` must stay deterministic and
 * dependency-free, and ADR-0009's rule that the LLM cannot reach the conversion path is
 * only real if the packages on that path cannot import it.
 */
export type HeadingTiebreaker = (
  decision: AmbiguousDecision,
) => Promise<TiebreakAnswer | undefined>;

export interface TiebreakAnswer {
  /** Must be one of the decision's candidate interpretations. */
  chosen: string;
  /** Named for the decision log: which model, which prompt version. */
  decidedBy: string;
  /** Recorded into the node's provenance, so a model's touch is machine-checkable. */
  producedBy: { kind: "model"; model: string; promptVersion: string };
}

/**
 * Promotes paragraphs to headings using style evidence.
 *
 * The evidence, in priority order:
 *
 *   1. `outlineLevel` — Word's own answer. A paragraph with outlineLvl 0 *is* a
 *      level-1 heading, whatever it looks like. This is not inference, it is
 *      reading, and it dominates everything below.
 *   2. A style named `heading N` or `Heading N`. Also close to reading.
 *   3. Direct formatting: larger than body text, bold, short, no terminal period.
 *      This is the actual guess, and it only runs when `origin` is
 *      `directFormatting` — the schema's documented signal that the author
 *      formatted by hand rather than using styles.
 *
 * The third case is the reason this package exists. It is also the case most likely
 * to be wrong, which is why it is scored rather than decided by a chain of ifs, and
 * why a close call is reported as ambiguous instead of silently resolved.
 */
export function inferHeadings(
  doc: MarkForgeDocument,
  options: InferOptions = {},
): InferResult {
  const opts = { ...DEFAULT_INFER_OPTIONS, ...options };
  const diagnostics = new DiagnosticBag(INFERRER);
  const decisions: Decision[] = [];
  const ambiguous: AmbiguousDecision[] = [];
  let changed = 0;

  if (!opts.headings) return { decisions, diagnostics, changed, ambiguous };

  // Body text size is the baseline everything else is measured against. The median
  // is used rather than the mean because a single 48pt title would drag a mean
  // upward and make every real heading look like body text by comparison.
  const sizes: number[] = [];
  visit(doc.body as unknown as AnyNode, (n) => {
    if (n.type !== "paragraph" || typeof n.id !== "string") return;
    const size = doc.sidecar[n.id]?.font?.sizePt;
    if (typeof size === "number") sizes.push(size);
  });
  const bodySize = median(sizes) ?? 11;

  // Heading levels resolved so far, which is the context a tie-break needs: whether a
  // paragraph is a level 3 depends on what came above it.
  const seenLevels: number[] = [];

  visit(doc.body as unknown as AnyNode, (n) => {
    if (n.type === "heading") {
      const existing = typeof n["resolvedLevel"] === "number" ? n["resolvedLevel"] : undefined;
      if (existing !== undefined) seenLevels.push(existing);
      return;
    }
    if (n.type !== "paragraph" || typeof n.id !== "string") return;
    const evidence = doc.sidecar[n.id];
    if (!evidence) return;

    const candidates = scoreHeading(n, evidence, bodySize);
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    const runnerUp = candidates[1];
    const margin = runnerUp ? best.score - runnerUp.score : 1;
    const isAmbiguous = margin < opts.ambiguityMargin;

    if (best.interpretation === "paragraph") return;

    const level = Number.parseInt(best.interpretation.replace("heading", ""), 10);
    if (!Number.isFinite(level)) return;

    decisions.push({
      nodeId: n.id,
      question: "Is this paragraph a heading, and at what level?",
      candidates,
      chosen: best.interpretation,
      decidedBy: best.reasons[0] ?? "score",
      ambiguous: isAmbiguous,
    });

    if (isAmbiguous) {
      // Reported, not resolved. The margin is the honest statement of how close it
      // was, and a user reading the report can override the mapping.
      diagnostics.degraded(
        DiagnosticCode.INFER_AMBIGUOUS_HEADING,
        "paragraph",
        `Paragraph promoted to heading ${level}, but the decision was close ` +
          `(margin ${margin.toFixed(3)} < ${opts.ambiguityMargin}). Runner-up: ` +
          `${runnerUp?.interpretation ?? "none"}. Evidence: ${best.reasons.join("; ")}.`,
        { nodeId: n.id },
      );
      // Recorded for a possible tie-break *before* the promotion below mutates the node,
      // so `originalChildren` is what the author actually wrote. Restoring it is what
      // makes a demotion back to a paragraph lossless.
      ambiguous.push({
        nodeId: n.id,
        question: "Is this paragraph a heading, and at what level?",
        candidates,
        chosenByRule: best.interpretation,
        margin,
        text: textOf(n),
        precedingHeadings: [...seenLevels],
        followingText: "",
        node: n,
        originalChildren: Array.isArray(n.children) ? [...(n.children as AnyNode[])] : [],
      });
    }

    n.type = "heading";
    n["depth"] = Math.min(6, level);
    n["resolvedLevel"] = level;
    seenLevels.push(level);
    unwrapEvidenceMarks(n);
    changed++;
  });

  fillFollowingText(doc, ambiguous);

  // A document whose headings skip a level is not an error — it is common, and
  // sample002.docx does exactly this (docs/CORPUS.md §2.3). Reported so a renderer
  // that assumes contiguous levels has been warned.
  reportLevelSkips(doc, diagnostics);

  return { decisions, diagnostics, changed, ambiguous };
}

/**
 * Removes an inline mark that spans a promoted heading entirely.
 *
 * When a paragraph is promoted because it is bold and large, that bold *was the
 * evidence*. Leaving it as an inline mark too renders `## **PROJECT STATUS REPORT**` —
 * the formatting counted twice, and on the way back to DOCX it becomes direct run
 * formatting inside a heading style, which is the defect brief §5.1 exists to remove.
 *
 * Only a mark covering the whole heading is removed. Bold on three words inside a
 * heading is genuine emphasis the author added on top, and unwrapping that would be
 * losing information rather than de-duplicating it.
 */
function unwrapEvidenceMarks(heading: AnyNode): void {
  const EVIDENCE_MARKS = new Set(["strong", "emphasis", "smallCaps"]);
  for (;;) {
    const kids = heading.children;
    if (!Array.isArray(kids) || kids.length !== 1) return;
    const only = kids[0]!;
    if (!EVIDENCE_MARKS.has(only.type)) return;
    if (!Array.isArray(only.children)) return;
    heading.children = only.children;
  }
}

function scoreHeading(node: AnyNode, evidence: StyleEvidence, bodySize: number): Candidate[] {
  const out: Candidate[] = [];
  const text = textOf(node);

  // --- 1. outlineLevel: Word's own answer, so this is reading, not inference.
  if (typeof evidence.outlineLevel === "number" && evidence.outlineLevel <= 8) {
    out.push({
      interpretation: `heading${evidence.outlineLevel + 1}`,
      score: 1,
      reasons: [`outlineLevel ${evidence.outlineLevel} declares this a heading`],
    });
    return out;
  }

  // --- 2. A style whose name is "heading N".
  const styleName = evidence.sourceStyleName ?? "";
  const named = /^heading\s*([1-9])$/i.exec(styleName.trim());
  if (named) {
    out.push({
      interpretation: `heading${named[1]}`,
      score: 0.95,
      reasons: [`style name "${styleName}" declares a heading level`],
    });
    return out;
  }

  // --- 2b. A style *id* of "HeadingN" whose definition is missing from styles.xml.
  //
  // Found by the Mammoth differential test (ADR-0005, docs/MAMMOTH-DIFF.md): on
  // `messy-inconsistent-cascade.docx` Mammoth recovers an `<h4>` where we produced a
  // paragraph. The document references `w:pStyle w:val="Heading4"` and never defines it,
  // so there is no style *name* to match on and no inherited `outlineLevel` — but the id
  // itself states the author's intent, and dropping it loses a heading that Word would
  // also render unstyled yet every human reader would call a heading.
  //
  // Scored below the resolved-name case rather than equal to it. An id is a weaker
  // witness than a definition: it could be a coincidental name, and nothing corroborates
  // the level. That gap is what makes this a candidate the tie-breaker can revisit rather
  // than a fact, which is the right status for a recovery from missing data.
  const styleId = evidence.sourceStyleId ?? "";
  const byId = /^heading\s*([1-9])$/i.exec(styleId.trim());
  if (byId) {
    out.push({
      interpretation: `heading${byId[1]}`,
      score: 0.8,
      reasons: [
        `style id "${styleId}" names a heading level, though styles.xml does not define it`,
      ],
    });
    return out;
  }

  // --- 3. Direct formatting. Only when the schema says the author formatted by
  // hand: `origin === "directFormatting"` is the documented signal that inference
  // is needed, and running this branch on styled text would second-guess the author.
  if (evidence.origin !== "directFormatting") return out;

  const size = evidence.font?.sizePt;
  const weight = evidence.font?.weight ?? 400;
  const reasons: string[] = [];
  let score = 0;

  if (typeof size === "number" && size > bodySize) {
    // Ratio, not absolute difference: 2pt above body text means something different
    // in a 9pt document than in a 20pt one.
    const ratio = size / bodySize;
    const contribution = Math.min(0.5, (ratio - 1) * 1.5);
    score += contribution;
    reasons.push(`font ${size}pt is ${ratio.toFixed(2)}x body text (${bodySize}pt)`);
  }
  if (weight >= 600) {
    score += 0.2;
    reasons.push("bold");
  }
  if (evidence.font?.allCaps || evidence.font?.smallCaps) {
    score += 0.1;
    reasons.push("all caps or small caps");
  }
  if (text.length > 0 && text.length <= 80) {
    score += 0.1;
    reasons.push(`short (${text.length} chars)`);
  }
  if (!/[.!?;:,]\s*$/.test(text)) {
    score += 0.1;
    reasons.push("no terminal punctuation");
  }
  if (evidence.paragraph?.keepWithNext) {
    // "Keep with next" is what headings are for. Weak evidence alone, but it rarely
    // appears on body paragraphs.
    score += 0.15;
    reasons.push("keepWithNext set");
  }
  if (text.length > 200) {
    score -= 0.4;
    reasons.push(`long (${text.length} chars), unlikely to be a heading`);
  }

  const paragraphScore = 1 - score;
  out.push({ interpretation: "paragraph", score: paragraphScore, reasons: ["default interpretation"] });

  if (score > 0.5) {
    // Level from size: the bigger relative to body text, the higher the level.
    // Coarse on purpose — finer buckets would imply a precision the evidence does
    // not support.
    const ratio = typeof size === "number" ? size / bodySize : 1;
    const level = ratio >= 1.6 ? 1 : ratio >= 1.35 ? 2 : ratio >= 1.15 ? 3 : 4;
    out.push({ interpretation: `heading${level}`, score, reasons });
  }

  return out;
}

/**
 * Fills in the text of the block after each ambiguous node.
 *
 * A heading introduces what follows it, so the following block is the single most useful
 * piece of context for "is this a label or a sentence?". Done in a second pass because
 * during the first one the following node has not been visited yet.
 */
function fillFollowingText(doc: MarkForgeDocument, ambiguous: AmbiguousDecision[]): void {
  if (ambiguous.length === 0) return;
  const byNode = new Map<AnyNode, AmbiguousDecision>();
  for (const decision of ambiguous) byNode.set(decision.node, decision);

  const walk = (parent: AnyNode): void => {
    const kids = parent.children;
    if (!Array.isArray(kids)) return;
    for (const [index, child] of (kids as AnyNode[]).entries()) {
      const decision = byNode.get(child);
      if (decision) {
        const next = kids[index + 1] as AnyNode | undefined;
        // Capped: a tie-break needs the shape of what follows, not all of it, and a
        // whole chapter in the prompt is tokens spent to make the answer worse.
        decision.followingText = next ? textOf(next).slice(0, 300) : "";
      }
      walk(child);
    }
  };
  walk(doc.body as unknown as AnyNode);
}

/**
 * Applies a tie-breaker to the decisions the rules declined to make.
 *
 * The only path by which anything outside this package can change a conversion, and it
 * is narrow on purpose:
 *
 *   - Only nodes already marked ambiguous are offered.
 *   - The answer must be one of that node's own candidates; anything else is refused
 *     here as well as being rejected by the schema at the call site.
 *   - A tie-breaker that returns `undefined`, throws, or answers off-menu leaves the
 *     deterministic outcome exactly as it was. `--no-llm` and a failed call produce the
 *     same document, which is what makes the LLM layer optional rather than load-bearing.
 *   - Every applied answer is recorded twice: as a `Decision` for `--explain`, and in the
 *     node's provenance as `producedBy: {kind: "model", …}`.
 */
export async function resolveAmbiguities(
  doc: MarkForgeDocument,
  ambiguous: AmbiguousDecision[],
  tiebreak: HeadingTiebreaker,
): Promise<{ decisions: Decision[]; diagnostics: DiagnosticBag; applied: number; changed: number }> {
  const diagnostics = new DiagnosticBag(INFERRER);
  const decisions: Decision[] = [];
  let applied = 0;
  let changed = 0;

  for (const decision of ambiguous) {
    let answer: TiebreakAnswer | undefined;
    try {
      answer = await tiebreak(decision);
    } catch (error) {
      // The caller diagnoses the failure with its own vocabulary (it knows whether this
      // was a budget, transport, or schema problem). Here it is simply "no answer".
      void error;
      answer = undefined;
    }
    if (!answer) continue;

    const legal = decision.candidates.some((c) => c.interpretation === answer.chosen);
    if (!legal) {
      diagnostics.degraded(
        DiagnosticCode.LLM_CALL_FAILED,
        "heading",
        `A tie-breaker answered "${answer.chosen}", which is not among this node's ` +
          `candidates (${decision.candidates.map((c) => c.interpretation).join(", ")}). ` +
          `Refused: the deterministic choice "${decision.chosenByRule}" stands. Brief §5.3 ` +
          `allows a model to choose among candidates and never to invent one.`,
        { nodeId: decision.nodeId },
      );
      continue;
    }

    applied++;
    decisions.push({
      nodeId: decision.nodeId,
      question: decision.question,
      candidates: decision.candidates,
      chosen: answer.chosen,
      decidedBy: answer.decidedBy,
      ambiguous: true,
    });

    if (answer.chosen !== decision.chosenByRule) {
      changed++;
      applyChoice(decision, answer.chosen);
      diagnostics.info(
        DiagnosticCode.LLM_TIEBREAK_APPLIED,
        `Ambiguous heading resolved to "${answer.chosen}" by ${answer.decidedBy}, ` +
          `overriding the deterministic choice "${decision.chosenByRule}" (margin ` +
          `${decision.margin.toFixed(3)}). With --no-llm this node stays ` +
          `"${decision.chosenByRule}".`,
        { nodeId: decision.nodeId },
      );
    } else {
      diagnostics.info(
        DiagnosticCode.LLM_TIEBREAK_APPLIED,
        `Ambiguous heading confirmed as "${answer.chosen}" by ${answer.decidedBy}, which ` +
          `agrees with the deterministic choice. The document is unchanged.`,
        { nodeId: decision.nodeId },
      );
    }

    // Provenance records the model even when it agreed, because "did a model influence
    // this node?" and "did the output change?" are different questions and only the first
    // one is answerable from the document (SPEC §2.5).
    const existing = doc.provenance[decision.nodeId];
    if (existing) doc.provenance[decision.nodeId] = { ...existing, producedBy: answer.producedBy };
  }

  return { decisions, diagnostics, applied, changed };
}

/** Rewrites the node to match the chosen interpretation. */
function applyChoice(decision: AmbiguousDecision, chosen: string): void {
  const node = decision.node;
  if (chosen === "paragraph") {
    node.type = "paragraph";
    delete node["depth"];
    delete node["resolvedLevel"];
    // The bold that was the promotion's evidence was unwrapped on the way in. Demoting
    // without restoring it would silently drop formatting the author wrote, which is a
    // worse outcome than the wrong heading level.
    node.children = decision.originalChildren;
    return;
  }
  const level = Number.parseInt(chosen.replace("heading", ""), 10);
  if (!Number.isFinite(level)) return;
  node.type = "heading";
  node["depth"] = Math.min(6, level);
  node["resolvedLevel"] = level;
}

function reportLevelSkips(doc: MarkForgeDocument, diagnostics: DiagnosticBag): void {
  let previous = 0;
  visit(doc.body as unknown as AnyNode, (n) => {
    if (n.type !== "heading") return;
    const level = typeof n["resolvedLevel"] === "number" ? n["resolvedLevel"] : 1;
    if (previous > 0 && level > previous + 1) {
      diagnostics.info(
        DiagnosticCode.INFER_HEADING_LEVEL_SKIP,
        `Heading level jumps from ${previous} to ${level}, skipping ${level - previous - 1} ` +
          `level(s). This is common in real documents and is preserved rather than ` +
          `corrected, but a renderer assuming contiguous levels will produce a wrong outline.`,
        ...(typeof n.id === "string" ? [{ nodeId: n.id }] : []),
      );
    }
    previous = level;
  });
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function textOf(node: AnyNode): string {
  let out = "";
  const walk = (n: AnyNode): void => {
    if (n.type === "text" && typeof n["value"] === "string") out += n["value"];
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as AnyNode);
  };
  walk(node);
  return out.trim();
}

/**
 * Rebuilds blockquotes from the style names a DOCX carries.
 *
 * DOCX has no blockquote element. A quotation is a paragraph in a named style —
 * `Block Text` in Pandoc's vocabulary, `Quote` or `BlockQuote` in others — and our
 * writer emits exactly that. Without this, `> quoted` round-tripped to a plain
 * paragraph and the blockquote was gone: the reader saw a styled paragraph and had no
 * grounds to call it anything else.
 *
 * This is reading, not guessing. The style name states the author's intent, so the
 * decision is recorded but never marked ambiguous. Consecutive quoted paragraphs
 * merge into one blockquote, which is what the source had.
 */
export function inferBlockquotes(doc: MarkForgeDocument): InferResult {
  const diagnostics = new DiagnosticBag(INFERRER);
  const decisions: Decision[] = [];
  let changed = 0;

  const isQuoteStyle = (name: string | undefined): boolean => {
    if (!name) return false;
    const normalised = name.toLowerCase().replace(/\s+/g, "");
    return normalised === "blocktext" || normalised === "quote" || normalised === "blockquote";
  };

  const rebuild = (node: AnyNode): void => {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (const child of kids) rebuild(child as AnyNode);

    const out: AnyNode[] = [];
    let run: AnyNode[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      out.push({ type: "blockquote", children: run });
      changed += run.length;
      run = [];
    };

    for (const child of kids as AnyNode[]) {
      const id = typeof child.id === "string" ? child.id : undefined;
      const evidence = id !== undefined ? doc.sidecar[id] : undefined;
      if (child.type === "paragraph" && isQuoteStyle(evidence?.sourceStyleName)) {
        run.push(child);
        if (id !== undefined) {
          decisions.push({
            nodeId: id,
            question: "Is this paragraph part of a blockquote?",
            candidates: [
              {
                interpretation: "blockquote",
                score: 1,
                reasons: [`style name "${evidence?.sourceStyleName}" declares a quotation`],
              },
            ],
            chosen: "blockquote",
            decidedBy: "named quotation style",
            ambiguous: false,
          });
        }
        continue;
      }
      flush();
      out.push(child);
    }
    flush();
    node.children = out;
  };

  rebuild(doc.body as unknown as AnyNode);
  return { decisions, diagnostics, changed, ambiguous: [] };
}

/**
 * Rebuilds code blocks and thematic breaks from what a DOCX actually carries.
 *
 * Both are written correctly by `@markforge/render-docx` and, until now, neither was read
 * back: a code block returned as a run of ordinary paragraphs and a horizontal rule as an
 * empty one. `docs/STATUS.md` listed them together as the tractable gap, because the
 * evidence needed is already in the document — a style name and a border — exactly as it is
 * for blockquotes.
 *
 * **Code**: consecutive paragraphs in a code style become one `code` node, joined by
 * newlines. Consecutive, because the writer splits a block into one paragraph per line
 * (OOXML has no multi-line paragraph), so rejoining them is undoing a known transformation
 * rather than guessing. A single isolated code-styled paragraph is still a code block of
 * one line, which is what it was.
 *
 * **Thematic break**: an empty paragraph carrying a bottom border. Both halves are
 * required. A bordered paragraph *with* text is a styled paragraph and stays one; an empty
 * paragraph without a border is whitespace and normalisation has already dealt with it.
 */
const NEWLINE = String.fromCharCode(10);

export function inferCodeAndBreaks(doc: MarkForgeDocument): InferResult {
  const diagnostics = new DiagnosticBag(INFERRER);
  const decisions: Decision[] = [];
  let changed = 0;

  const isCodeStyle = (name: string | undefined): boolean => {
    if (!name) return false;
    const n = name.toLowerCase().replace(/\s+/g, "");
    return n === "sourcecode" || n === "code" || n === "codeblock" || n === "preformatted" || n === "html-pre";
  };

  const rebuild = (node: AnyNode): void => {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (const child of kids) rebuild(child as AnyNode);

    const out: AnyNode[] = [];
    let run: AnyNode[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const value = run.map((n) => textContent(n)).join(NEWLINE);
      out.push({ type: "code", value });
      changed += run.length;
      run = [];
    };

    for (const child of kids as AnyNode[]) {
      const id = typeof child.id === "string" ? child.id : undefined;
      const evidence = id !== undefined ? doc.sidecar[id] : undefined;

      if (child.type === "paragraph" && isCodeStyle(evidence?.sourceStyleName)) {
        run.push(child);
        if (id !== undefined) {
          decisions.push({
            nodeId: id,
            question: "Is this paragraph part of a code block?",
            candidates: [
              {
                interpretation: "code",
                score: 1,
                reasons: [`style name "${evidence?.sourceStyleName}" declares preformatted text`],
              },
            ],
            chosen: "code",
            decidedBy: "named code style",
            ambiguous: false,
          });
        }
        continue;
      }
      flush();

      if (
        child.type === "paragraph" &&
        evidence?.paragraph?.borderBottom === true &&
        textContent(child).trim() === ""
      ) {
        out.push({ type: "thematicBreak" });
        changed++;
        if (id !== undefined) {
          decisions.push({
            nodeId: id,
            question: "Is this empty bordered paragraph a horizontal rule?",
            candidates: [
              {
                interpretation: "thematicBreak",
                score: 1,
                reasons: ["empty paragraph carrying a bottom border, which is how Word draws a rule"],
              },
            ],
            chosen: "thematicBreak",
            decidedBy: "empty paragraph with a bottom border",
            ambiguous: false,
          });
        }
        continue;
      }

      out.push(child);
    }
    flush();
    node.children = out;
  };

  rebuild(doc.body as unknown as AnyNode);
  return { decisions, diagnostics, changed, ambiguous: [] };
}

/**
 * Every inference pass, in the order they must run.
 *
 * Headings first: blockquote reconstruction wraps paragraphs, and a heading inside a
 * wrapper would no longer be a direct child of the root where heading inference looks
 * for it.
 */
export function inferAll(doc: MarkForgeDocument, options: InferOptions = {}): InferResult {
  const headings = inferHeadings(doc, options);
  const quotes = inferBlockquotes(doc);
  // After blockquotes: a code-styled paragraph is never inside a quotation, and running
  // this first would leave a `code` node where blockquote recovery expects a paragraph.
  const code = inferCodeAndBreaks(doc);
  const diagnostics = new DiagnosticBag(INFERRER);
  diagnostics.merge(headings.diagnostics);
  diagnostics.merge(quotes.diagnostics);
  diagnostics.merge(code.diagnostics);
  return {
    decisions: [...headings.decisions, ...quotes.decisions, ...code.decisions],
    diagnostics,
    changed: headings.changed + quotes.changed + code.changed,
    // Only heading inference produces ambiguity: blockquote recovery reads a style name,
    // which is a fact rather than a judgement (see inferBlockquotes).
    ambiguous: headings.ambiguous,
  };
}

/** Formats decisions for `convert --explain` (SPEC §8). */
export function explainDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) return "No inference decisions were made.\n";
  const lines: string[] = [];
  for (const d of decisions) {
    lines.push(`${d.nodeId}  ${d.question}`);
    for (const c of d.candidates) {
      const marker = c.interpretation === d.chosen ? "->" : "  ";
      lines.push(`  ${marker} ${c.interpretation.padEnd(12)} ${c.score.toFixed(3)}  ${c.reasons.join("; ")}`);
    }
    lines.push(`     decided by: ${d.decidedBy}${d.ambiguous ? "  [AMBIGUOUS]" : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
