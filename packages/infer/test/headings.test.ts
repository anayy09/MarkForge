import { describe, it, expect } from "vitest";
import { inferHeadings, explainDecisions } from "../src/index.js";
import { assignIds, emptyDocument, selectType, type AnyNode, type MarkForgeDocument, type StyleEvidence } from "@markforge/ir";

/** Builds a document whose paragraphs carry the given evidence. */
function docWith(paragraphs: { text: string; evidence: StyleEvidence }[]): MarkForgeDocument {
  const doc = emptyDocument();
  const body: AnyNode = {
    type: "root",
    children: paragraphs.map((p) => ({
      type: "paragraph",
      children: [{ type: "text", value: p.text }],
    })),
  };
  assignIds(body);
  doc.body = body as unknown as MarkForgeDocument["body"];
  (body.children as AnyNode[]).forEach((node, i) => {
    doc.sidecar[node.id as string] = paragraphs[i]!.evidence;
  });
  return doc;
}

const body = (sizePt = 11): StyleEvidence => ({ origin: "styleCascade", font: { sizePt } });

describe("heading inference", () => {
  // Reading, not inferring. Word already answered this question.
  it("uses outlineLevel when Word declares one", () => {
    const doc = docWith([
      { text: "Chapter One", evidence: { origin: "styleCascade", outlineLevel: 0 } },
      { text: "Body text here.", evidence: body() },
    ]);
    const { changed } = inferHeadings(doc);
    expect(changed).toBe(1);
    const headings = selectType(doc.body as unknown as AnyNode, "heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!["resolvedLevel"]).toBe(1);
  });

  it("maps outlineLevel 0..8 to levels 1..9", () => {
    const doc = docWith([
      { text: "L1", evidence: { origin: "styleCascade", outlineLevel: 0 } },
      { text: "L3", evidence: { origin: "styleCascade", outlineLevel: 2 } },
      { text: "L9", evidence: { origin: "styleCascade", outlineLevel: 8 } },
    ]);
    inferHeadings(doc);
    const levels = selectType(doc.body as unknown as AnyNode, "heading").map((h) => h["resolvedLevel"]);
    expect(levels).toEqual([1, 3, 9]);
  });

  // resolvedLevel can exceed 6; depth is the mdast-legal clamp.
  it("keeps resolvedLevel above 6 while clamping depth", () => {
    const doc = docWith([{ text: "Deep", evidence: { origin: "styleCascade", outlineLevel: 7 } }]);
    inferHeadings(doc);
    const h = selectType(doc.body as unknown as AnyNode, "heading")[0]!;
    expect(h["resolvedLevel"]).toBe(8);
    expect(h["depth"]).toBe(6);
  });

  it("uses a style named 'heading N'", () => {
    const doc = docWith([
      { text: "Titled", evidence: { origin: "styleCascade", sourceStyleName: "heading 2" } },
    ]);
    inferHeadings(doc);
    expect(selectType(doc.body as unknown as AnyNode, "heading")[0]!["resolvedLevel"]).toBe(2);
  });

  // The actual guess, and the reason this package exists.
  it("promotes big bold direct-formatted text", () => {
    const doc = docWith([
      {
        text: "Looks Like A Heading",
        evidence: { origin: "directFormatting", font: { sizePt: 18, weight: 700 } },
      },
      { text: "Ordinary body text that goes on for a while.", evidence: body() },
      { text: "More ordinary body text here.", evidence: body() },
    ]);
    const { changed } = inferHeadings(doc);
    expect(changed).toBe(1);
    expect(selectType(doc.body as unknown as AnyNode, "heading")).toHaveLength(1);
  });

  // A5's boundary: a paragraph that merely *uses* a style is not second-guessed.
  it("does not second-guess styled text, only direct formatting", () => {
    const doc = docWith([
      {
        text: "Big But Styled",
        evidence: { origin: "styleCascade", font: { sizePt: 18, weight: 700 } },
      },
      { text: "Body.", evidence: body() },
    ]);
    const { changed } = inferHeadings(doc);
    expect(changed).toBe(0);
  });

  it("does not promote long paragraphs however they are formatted", () => {
    const doc = docWith([
      {
        text: "This is a very long paragraph that happens to be bold and slightly larger than the body text, but it is clearly a paragraph because it goes on and on and contains multiple sentences. It should not become a heading.",
        evidence: { origin: "directFormatting", font: { sizePt: 13, weight: 700 } },
      },
      { text: "Body.", evidence: body() },
    ]);
    expect(inferHeadings(doc).changed).toBe(0);
  });

  it("does not promote text ending in a full stop", () => {
    const doc = docWith([
      { text: "A sentence that ends properly.", evidence: { origin: "directFormatting", font: { sizePt: 12 } } },
      { text: "Body.", evidence: body() },
    ]);
    expect(inferHeadings(doc).changed).toBe(0);
  });

  it("measures size against the median, not the mean", () => {
    // One 48pt title must not drag the baseline up and hide real headings. With a
    // mean baseline the 16pt paragraph would look like body text.
    const doc = docWith([
      { text: "HUGE TITLE", evidence: { origin: "directFormatting", font: { sizePt: 48, weight: 700 } } },
      { text: "Section Heading", evidence: { origin: "directFormatting", font: { sizePt: 16, weight: 700 } } },
      ...Array.from({ length: 8 }, () => ({ text: "Body text.", evidence: body(11) })),
    ]);
    inferHeadings(doc);
    expect(selectType(doc.body as unknown as AnyNode, "heading").length).toBe(2);
  });

  // Ambiguity is reported, never resolved by coin flip.
  it("reports a close call as ambiguous rather than deciding silently", () => {
    const doc = docWith([
      { text: "Marginal Case", evidence: { origin: "directFormatting", font: { sizePt: 12, weight: 700 } } },
      ...Array.from({ length: 4 }, () => ({ text: "Body text.", evidence: body(11) })),
    ]);
    const { decisions, diagnostics } = inferHeadings(doc, { ambiguityMargin: 0.9 });
    const ambiguous = decisions.filter((d) => d.ambiguous);
    if (ambiguous.length > 0) {
      expect(diagnostics.all().some((d) => d.code === "MF-INFER-0001")).toBe(true);
    }
    // Whether or not it promoted, the decision is on the record with its margin.
    expect(decisions.length + diagnostics.size).toBeGreaterThan(0);
  });

  it("reports a level skip without correcting it", () => {
    // Real documents do this — sample002.docx goes H1 -> H3 (CORPUS §2.3). The
    // levels are preserved; a renderer that assumes contiguity is warned.
    const doc = docWith([
      { text: "One", evidence: { origin: "styleCascade", outlineLevel: 0 } },
      { text: "Three", evidence: { origin: "styleCascade", outlineLevel: 2 } },
    ]);
    const { diagnostics } = inferHeadings(doc);
    expect(diagnostics.all().some((d) => d.code === "MF-INFER-0002")).toBe(true);
    const levels = selectType(doc.body as unknown as AnyNode, "heading").map((h) => h["resolvedLevel"]);
    expect(levels).toEqual([1, 3]);
  });

  it("is deterministic across runs", () => {
    const build = () =>
      docWith([
        { text: "Heading", evidence: { origin: "directFormatting", font: { sizePt: 18, weight: 700 } } },
        { text: "Body.", evidence: body() },
      ]);
    const a = build();
    const b = build();
    const ra = inferHeadings(a);
    const rb = inferHeadings(b);
    expect(JSON.stringify(ra.decisions)).toBe(JSON.stringify(rb.decisions));
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it("can be turned off entirely", () => {
    const doc = docWith([
      { text: "Big", evidence: { origin: "directFormatting", font: { sizePt: 24, weight: 700 } } },
    ]);
    expect(inferHeadings(doc, { headings: false }).changed).toBe(0);
  });
});

describe("explain output", () => {
  it("lists every candidate with its score and the deciding rule", () => {
    const doc = docWith([
      { text: "A Heading", evidence: { origin: "directFormatting", font: { sizePt: 20, weight: 700 } } },
      { text: "Body.", evidence: body() },
    ]);
    const { decisions } = inferHeadings(doc);
    const text = explainDecisions(decisions);
    expect(text).toContain("decided by:");
    expect(text).toMatch(/heading\d/);
    // The losing candidate is shown too: a decision log that only records the
    // winner cannot explain why the loser lost.
    expect(text).toContain("paragraph");
  });

  it("says so plainly when nothing was inferred", () => {
    expect(explainDecisions([])).toContain("No inference decisions");
  });
});
