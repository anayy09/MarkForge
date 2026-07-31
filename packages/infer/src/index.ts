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
  let changed = 0;

  if (!opts.headings) return { decisions, diagnostics, changed };

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

  visit(doc.body as unknown as AnyNode, (n) => {
    if (n.type !== "paragraph" || typeof n.id !== "string") return;
    const evidence = doc.sidecar[n.id];
    if (!evidence) return;

    const candidates = scoreHeading(n, evidence, bodySize);
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    const runnerUp = candidates[1];
    const margin = runnerUp ? best.score - runnerUp.score : 1;
    const ambiguous = margin < opts.ambiguityMargin;

    if (best.interpretation === "paragraph") return;

    const level = Number.parseInt(best.interpretation.replace("heading", ""), 10);
    if (!Number.isFinite(level)) return;

    decisions.push({
      nodeId: n.id,
      question: "Is this paragraph a heading, and at what level?",
      candidates,
      chosen: best.interpretation,
      decidedBy: best.reasons[0] ?? "score",
      ambiguous,
    });

    if (ambiguous) {
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
    }

    n.type = "heading";
    n["depth"] = Math.min(6, level);
    n["resolvedLevel"] = level;
    changed++;
  });

  // A document whose headings skip a level is not an error — it is common, and
  // sample002.docx does exactly this (docs/CORPUS.md §2.3). Reported so a renderer
  // that assumes contiguous levels has been warned.
  reportLevelSkips(doc, diagnostics);

  return { decisions, diagnostics, changed };
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
