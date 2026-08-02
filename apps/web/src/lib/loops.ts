"use client";

import { compare, type FidelityScore } from "@markforge/fidelity";
import type { MarkForgeDocument } from "@markforge/ir";
import { engine } from "@/lib/engine";
import type { Format } from "@/lib/formats";

/**
 * The round-trip loops, composed to match `scripts/run-fidelity.mjs` step for step.
 *
 * This is the part of the app where being approximately right would be worse than being
 * absent. A loop labelled `docx->md->docx` that applied inference to one side and not the
 * other reports a real number for a comparison nobody asked for, and it would sit next to
 * the committed baseline for the same name looking like a regression. `run-fidelity.mjs`
 * hit exactly that and its comment records the cost: the loop under-reported itself at
 * 96.8% when it was clean, because one side had been through inference and the other had
 * not.
 *
 * The browser bundle exports `parse` and `render` but not `inferAll`, so wherever the
 * harness calls `inferAll(doc)` this uses `convertInBrowser(bytes, { from, to: "md" })` and
 * takes `.document`: core's `convert` is parse, then infer, then render, and it returns the
 * document the renderer saw. The Markdown it also produces is the same string the harness
 * gets from `renderMarkdown(original)`, so several loops need one call rather than two.
 */

export interface LoopDefinition {
  id: string;
  /** The name in fixtures/expected/baselines.json, so a live number can sit beside a committed one. */
  label: string;
  from: Format;
  description: string;
}

export const LOOPS: Record<string, LoopDefinition[]> = {
  md: [
    { id: "md->md", label: "md->md", from: "md", description: "The formatter's own fixed point. Anything below 100% is a formatter that does not agree with itself." },
    { id: "md->docx->md", label: "md->docx->md", from: "md", description: "Out to Word and back. The headline loop for anyone whose documents live in both." },
    { id: "md->html->md", label: "md->html->md", from: "md", description: "Out to HTML and back, through a format with more structure than Markdown has." },
  ],
  docx: [
    { id: "docx->md->docx", label: "docx->md->docx", from: "docx", description: "First generation, on documents that fight back. Compared at the IR, not as bytes." },
    { id: "docx->html", label: "docx->html", from: "docx", description: "A lossy path that is not Markdown, so the Markdown result has something to be measured against." },
  ],
  html: [
    { id: "html->html", label: "html->html", from: "html", description: "The HTML fixed point." },
    { id: "html->docx->html", label: "html->docx->html", from: "html", description: "HTML is the table-span ground truth. The gap between this and html->html is what the DOCX path costs." },
    { id: "html->md->html", label: "html->md->html", from: "html", description: "The same ground truth through Markdown, where merged cells cannot be expressed." },
  ],
};

/** Loops that exist in the corpus but cannot run here, each with the reason. */
export const UNAVAILABLE = [
  {
    label: "md->pdf->md",
    reason:
      "Reading a PDF needs the pdf.js adapter, which is not browser-capable. This loop is measured in CI and is a joint score for the writer and the reader together, never a score for the writer alone.",
  },
  {
    label: "docx->md->docx->md",
    reason:
      "Second-generation stability. It compares the first generation against the second rather than against the source, which needs both DOCX generations kept side by side. It runs in CI.",
  },
  {
    label: "scan->md",
    reason:
      "Text recognition. No recogniser ships to the browser, and without one there is no document to compare, which is why the committed baseline for it is 0.0 across every metric.",
  },
] as const;

export async function runLoop(
  loopId: string,
  bytes: Uint8Array,
  path: string,
): Promise<{ score: FidelityScore; expected: MarkForgeDocument; actual: MarkForgeDocument }> {
  const mf = await engine();
  const parse = mf.parse;
  const render = mf.render;
  const convert = mf.convertInBrowser;

  switch (loopId) {
    /* ---------------------------------------------------------------- Markdown fixtures */

    case "md->md": {
      // parseMarkdown -> renderMarkdown -> parseMarkdown. No inference on either side:
      // Markdown states its structure, so there is nothing to infer.
      const original = (await parse(bytes, "md", path)).document;
      const formatted = await render(original, "md", {});
      const reparsed = (await parse(formatted.bytes, "md")).document;
      return { score: compare(original, reparsed), expected: original, actual: reparsed };
    }

    case "md->docx->md": {
      const original = (await parse(bytes, "md", path)).document;
      const docx = await render(original, "docx", {});
      // parseDocx then inferAll: a DOCX states formatting, and inference is what turns
      // that evidence into structure.
      const fromDocx = (await convert(docx.bytes, { from: "docx", to: "md" })).document;
      return { score: compare(original, fromDocx), expected: original, actual: fromDocx };
    }

    case "md->html->md": {
      const original = (await parse(bytes, "md", path)).document;
      const html = await render(original, "html", { html: { fullDocument: false } });
      const fromHtml = (await parse(html.bytes, "html")).document;
      return { score: compare(original, fromHtml), expected: original, actual: fromHtml };
    }

    /* -------------------------------------------------------------------- DOCX fixtures */

    case "docx->md->docx": {
      // One call gives both the inferred original and renderMarkdown(original).
      const first = await convert(bytes, { from: "docx", to: "md", path });
      const original = first.document;
      const reDocx = await render((await parse(first.bytes, "md")).document, "docx", {});
      const back = (await convert(reDocx.bytes, { from: "docx", to: "md" })).document;
      return { score: compare(original, back), expected: original, actual: back };
    }

    case "docx->html": {
      const first = await convert(bytes, { from: "docx", to: "html", path });
      const original = first.document;
      const html = await render(original, "html", { html: { fullDocument: false } });
      const parsed = (await parse(html.bytes, "html")).document;
      return { score: compare(original, parsed), expected: original, actual: parsed };
    }

    /* -------------------------------------------------------------------- HTML fixtures */

    case "html->html": {
      const original = (await parse(bytes, "html", path)).document;
      const html = await render(original, "html", { html: { fullDocument: false } });
      const parsed = (await parse(html.bytes, "html")).document;
      return { score: compare(original, parsed), expected: original, actual: parsed };
    }

    case "html->docx->html": {
      // Named for the intent; the harness compares the HTML source against the document
      // recovered from DOCX, without rendering HTML again. Reproduced as written.
      const original = (await parse(bytes, "html", path)).document;
      const docx = await render(original, "docx", {});
      const viaDocx = (await convert(docx.bytes, { from: "docx", to: "md" })).document;
      return { score: compare(original, viaDocx), expected: original, actual: viaDocx };
    }

    case "html->md->html": {
      const original = (await parse(bytes, "html", path)).document;
      const md = await render(original, "md", {});
      const parsed = (await parse(md.bytes, "md")).document;
      return { score: compare(original, parsed), expected: original, actual: parsed };
    }

    default:
      throw new Error(
        `No loop named ${loopId}. Available: ${Object.values(LOOPS)
          .flat()
          .map((l) => l.id)
          .join(", ")}`,
      );
  }
}

/** The six metrics, in the order docs/FIDELITY.md prints them. */
export const METRICS = [
  { key: "structural", label: "Structural", explain: "Ordered tree edit distance over node types and the attributes that change meaning. Text is not part of the label." },
  { key: "textSensitive", label: "Text, ws-sensitive", explain: "Grapheme-cluster edit distance after Unicode normalisation only." },
  { key: "textInsensitive", label: "Text, ws-insensitive", explain: "The same, collapsing whitespace runs. The gap between these two is the diagnostic: a large one means whitespace changed and content did not." },
  { key: "tableF1", label: "Table F1", explain: "Cells keyed by position, span and text. A merge that flattens fails the key." },
  { key: "tableContentF1", label: "Table content F1", explain: "The same keyed on position alone. High here beside low above means merged cells are being flattened." },
  { key: "spanF1", label: "Span F1", explain: "Inline marks as offset ranges, so nesting order does not count as a difference." },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

/** Flattens a FidelityScore into the six numbers baselines.json records. */
export function metricValues(score: FidelityScore): Record<MetricKey, number> {
  return {
    structural: score.structural.score,
    textSensitive: score.text.sensitive,
    textInsensitive: score.text.insensitive,
    tableF1: score.table.full.f1,
    tableContentF1: score.table.contentOnly.f1,
    spanF1: score.spans.f1,
  };
}
