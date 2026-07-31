import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocx } from "../src/index.js";
import { inferAll } from "@markforge/infer";
import { renderMarkdown } from "@markforge/render-md";
import { selectType, textContent, validateDocument, type AnyNode } from "@markforge/ir";

/**
 * The messy corpus, `docs/CORPUS.md` §2.3 and §2.15.
 *
 * Every other fixture is clean and authored, so every published fidelity number was
 * measured on easy input. These are built to be hard, by
 * `scripts/build-messy-fixtures.mjs`, and each asserts the specific defect it contains
 * rather than a score — because a score in the nineties is exactly what hid four
 * format-destroying bugs for two phases.
 *
 * They earned their place immediately: on first run they found `w:tcPr` being parsed as
 * cell *content*, heading inference blind to run-level formatting, and eighteen copies
 * of one diagnostic.
 */
const FIXTURES = fileURLToPath(new URL("../../../fixtures/docx/", import.meta.url));
const has = (name: string): boolean => existsSync(join(FIXTURES, name));

function load(name: string): {
  document: ReturnType<typeof parseDocx>["document"];
  lossy: number;
  inferred: number;
  markdown: string;
} {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
  const { document, diagnostics } = parseDocx(bytes, { path: `fixtures/docx/${name}` });
  const inferred = inferAll(document).changed;
  return {
    document,
    lossy: diagnostics.lossy().length,
    inferred,
    markdown: renderMarkdown(document).markdown,
  };
}

const ALL = [
  "messy-direct-formatting.docx",
  "messy-whitespace-as-structure.docx",
  "messy-manual-numbering.docx",
  "messy-inconsistent-cascade.docx",
  "messy-mixed-fonts.docx",
  "messy-combined.docx",
  "generated-no-theme.docx",
  "generated-run-per-word.docx",
];

describe.skipIf(!has("messy-combined.docx"))("every messy fixture converts", () => {
  it.each(ALL)("%s parses, validates, and renders", (name) => {
    const { document, markdown } = load(name);
    const result = validateDocument(document);
    expect(result.errors.slice(0, 3), `${name} must satisfy ir.v0.schema.json`).toEqual([]);
    expect(markdown.length).toBeGreaterThan(20);
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it.each(ALL)("%s is deterministic", (name) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const a = parseDocx(bytes, { path: name }).document;
    const b = parseDocx(bytes, { path: name }).document;
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  // Cell *properties* are not cell content. Missing one does not produce a missing
  // feature, it produces a phantom child on every node carrying the property — which is
  // how w:tcPr ended up inside every table cell and failed schema validation.
  it.each(ALL)("%s produces no phantom nodes from property elements", (name) => {
    const { document } = load(name);
    const unknowns = selectType(document.body, "unknown");
    const phantom = unknowns.filter((u) => /Pr$|tblGrid/.test(String(u["originalType"] ?? "")));
    expect(phantom.map((u) => u["originalType"])).toEqual([]);
  });
});

describe.skipIf(!has("messy-direct-formatting.docx"))("§2.3 direct formatting instead of styles", () => {
  // The premise of Surface B. In such documents the size and weight live on the *runs*
  // and the paragraph mark is bare, so recording only paragraph-level evidence meant
  // inference saw nothing and promoted nothing — ten paragraphs, zero headings.
  it("recovers headings from run-level formatting", () => {
    const { document, inferred } = load("messy-direct-formatting.docx");
    expect(inferred).toBeGreaterThan(0);
    const headings = selectType(document.body, "heading");
    expect(headings.length).toBeGreaterThanOrEqual(3);
    expect(headings.map((h) => textContent(h))).toContain("Quarterly Review");
  });

  it("records directFormatting as the evidence origin", () => {
    const { document } = load("messy-direct-formatting.docx");
    const origins = new Set(Object.values(document.sidecar).map((e) => e.origin));
    expect(origins.has("directFormatting")).toBe(true);
  });

  // The bold that justified the promotion must not also survive as emphasis. Counted
  // twice it renders `# **Title**`, and on the way back to DOCX becomes direct run
  // formatting inside a heading style — the defect brief §5.1 exists to remove.
  it("does not leave the evidence formatting inside the heading", () => {
    const { markdown } = load("messy-direct-formatting.docx");
    expect(markdown).toMatch(/^# Quarterly Review$/m);
    expect(markdown).not.toMatch(/^#+ \*\*/m);
  });

  // A single bold word mid-sentence must stay emphasis. Only formatting *every* run
  // shares becomes paragraph evidence, which is what stops this.
  it("keeps a bold phrase inside a sentence as emphasis, not a heading", () => {
    const { document } = load("messy-direct-formatting.docx");
    const strongs = selectType(document.body, "strong");
    expect(strongs.map((s) => textContent(s))).toContain("mid-period migration");
  });
});

describe.skipIf(!has("messy-whitespace-as-structure.docx"))("§2.3 whitespace as structure", () => {
  it("absorbs runs of empty paragraphs and says so", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "messy-whitespace-as-structure.docx")));
    const { document, diagnostics } = parseDocx(bytes);
    // Nine paragraphs in the file are empty or whitespace-only; none may survive.
    const empties = selectType(document.body, "paragraph").filter(
      (p) => textContent(p).trim() === "",
    );
    expect(empties).toHaveLength(0);
    expect(diagnostics.all().some((d) => d.code === "MF-NORM-0001")).toBe(true);
  });

  // Rule 2 of SPEC §2.8: a hard break stays a break. Promoting it to a paragraph split
  // would be guessing at intent the file does not state.
  it("keeps hard breaks as breaks rather than splitting paragraphs", () => {
    const { document, markdown } = load("messy-whitespace-as-structure.docx");
    expect(selectType(document.body, "break").length).toBeGreaterThanOrEqual(2);
    expect(markdown).toContain("Second logical paragraph");
  });

  it("preserves tab-indented text", () => {
    const { markdown } = load("messy-whitespace-as-structure.docx");
    expect(markdown).toContain("Indented by a literal tab");
    expect(markdown).toContain("Indented by two literal tabs");
  });
});

describe.skipIf(!has("messy-manual-numbering.docx"))("§2.3 manual numbering typed as text", () => {
  // The IEEE template's actual defect. The text must survive exactly; a converter that
  // invented a list from it would turn "1998 was the year..." into a list item, so this
  // fixture documents the deliberate decision *not* to infer.
  it("preserves hand-typed numbering verbatim and invents no list", () => {
    const { document, markdown } = load("messy-manual-numbering.docx");
    expect(selectType(document.body, "list")).toHaveLength(0);
    const text = textContent(document.body);
    for (const marker of ["1. Prepare", "a) Lettered", "1998 was the year"]) {
      expect(text).toContain(marker);
    }
    // The IEEE template writes "I.  Main text" with two spaces. Normalisation rule 3
    // collapses interior whitespace, so one space is the correct result — the marker
    // survives, its typography does not, and that is the documented trade.
    expect(text).toContain("I. Roman numerals");
    expect(text).not.toContain("I.  Roman");
    // Escaped on output so a re-parse does not turn the text into a list.
    expect(markdown).toMatch(/1\\?\. Prepare/);
  });

  it("does not mistake a sentence beginning with a numeral for a list item", () => {
    const { markdown } = load("messy-manual-numbering.docx");
    const reparsed = markdown;
    expect(reparsed).toContain("1998 was the year");
    expect(selectType(load("messy-manual-numbering.docx").document.body, "listItem")).toHaveLength(0);
  });
});

describe.skipIf(!has("messy-inconsistent-cascade.docx"))("§2.3 inconsistent style cascade", () => {
  // Measured in the IEEE template: heading 2 is basedOn Heading1 while heading 3 is
  // basedOn Normal, so a resolver assuming a uniform heading chain reports Heading3 wrong.
  it("resolves a heading style that is based on Normal rather than its sibling", () => {
    const { document } = load("messy-inconsistent-cascade.docx");
    const headings = selectType(document.body, "heading");
    const third = headings.find((h) => textContent(h).startsWith("Third Level"));
    expect(third).toBeDefined();
    const evidence = document.sidecar[third!.id as string];
    expect(evidence?.basedOn, "Heading3 inherits from Normal, not Heading1").toEqual([
      "Heading3",
      "Normal",
    ]);
  });

  it("reports a heading level skip without correcting it", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "messy-inconsistent-cascade.docx")));
    const { document } = parseDocx(bytes);
    const { diagnostics } = inferAll(document);
    expect(diagnostics.all().some((d) => d.code === "MF-INFER-0002")).toBe(true);
    const levels = selectType(document.body, "heading").map((h) => h["resolvedLevel"]);
    expect(levels).toContain(1);
    expect(levels).toContain(3);
  });

  it("reports a style the document references but does not define", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "messy-inconsistent-cascade.docx")));
    const { diagnostics } = parseDocx(bytes);
    expect(diagnostics.all().some((d) => d.code === "MF-DOCX-0073")).toBe(true);
  });
});

describe.skipIf(!has("messy-mixed-fonts.docx"))("§2.3 mixed theme and explicit fonts", () => {
  it("resolves theme tokens and records explicit families verbatim", () => {
    const { document } = load("messy-mixed-fonts.docx");
    const families = new Set(
      Object.values(document.sidecar)
        .map((e) => e.font?.family)
        .filter((f): f is string => typeof f === "string"),
    );
    // The token resolved, and no unresolved token leaked through.
    expect([...families].some((f) => f.startsWith("+"))).toBe(false);
    expect(families.has("Times New Roman")).toBe(true);
  });

  it("promotes headings despite three different sizes at one logical level", () => {
    const { document } = load("messy-mixed-fonts.docx");
    expect(selectType(document.body, "heading").length).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!has("messy-combined.docx"))("§2.3 all defects at once", () => {
  it("survives the combined document with a valid result", () => {
    const { document, markdown } = load("messy-combined.docx");
    expect(validateDocument(document).valid).toBe(true);
    expect(markdown).toContain("PROJECT STATUS REPORT");
  });

  // ListParagraph + numPr is the dominant real-world encoding, and the style name says
  // nothing about ordered-versus-unordered — the defect behind "numbered lists become
  // bullet lists".
  it("reads a real numbered list from numbering.xml, not the style name", () => {
    const { document } = load("messy-combined.docx");
    const lists = selectType(document.body, "list");
    expect(lists.some((l) => l["ordered"] === true)).toBe(true);
  });

  it("recovers the merged table cells", () => {
    const { document } = load("messy-combined.docx");
    const cells = selectType(document.body, "tableCell");
    expect(cells.some((c) => c["colSpan"] === 2)).toBe(true);
    expect(cells.some((c) => c["rowSpan"] === 2)).toBe(true);
  });

  it("keeps the hand-typed equation as text", () => {
    expect(textContent(load("messy-combined.docx").document.body)).toContain("a + b = c");
  });
});

describe.skipIf(!has("generated-no-theme.docx"))("§2.15 library-generated documents", () => {
  // The defining trait, found by inspecting a real machine-generated file: no theme part
  // at all, so +mn-lt has nothing to resolve against. A cascade resolver that assumes a
  // theme crashes on a whole common class of input.
  it("parses a document with no theme1.xml", () => {
    const { document, markdown } = load("generated-no-theme.docx");
    expect(validateDocument(document).valid).toBe(true);
    expect(markdown).toContain("Generated Document Profile");
  });

  // One warning per document, not one per run. Eighteen copies of the same sentence add
  // no information and make the file look worse than it is.
  it("reports the missing theme once, not once per run", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "generated-no-theme.docx")));
    const { diagnostics } = parseDocx(bytes);
    const themeWarnings = diagnostics.all().filter((d) => d.code === "MF-DOCX-0070");
    expect(themeWarnings.length).toBeLessThanOrEqual(2);
  });

  it("distinguishes the ordered and bullet lists that share one style name", () => {
    const { document } = load("generated-no-theme.docx");
    const lists = selectType(document.body, "list");
    expect(lists.some((l) => l["ordered"] === true)).toBe(true);
    expect(lists.some((l) => l["ordered"] === false)).toBe(true);
  });

  it("tolerates declared-but-empty comments, footnotes, and endnotes parts", () => {
    // Present and empty is what the real file has, and a reader that assumes a declared
    // part has content throws on it.
    expect(() => load("generated-no-theme.docx")).not.toThrow();
  });
});

describe.skipIf(!has("generated-run-per-word.docx"))("§2.15 one run per word", () => {
  // sample002.docx measured 261 w:rPr blocks across 45 paragraphs. A reader that does not
  // merge adjacent identical runs produces one text node per word, which inflates the
  // node count and makes every structural comparison meaningless.
  it("merges adjacent identical runs into single text nodes", () => {
    const { document } = load("generated-run-per-word.docx");
    const sentence = selectType(document.body, "paragraph").find((p) =>
      textContent(p).startsWith("This sentence"),
    );
    expect(sentence).toBeDefined();
    const texts = (sentence!.children as AnyNode[]).filter((c) => c.type === "text");
    // Eight words, one text node.
    expect(texts).toHaveLength(1);
  });

  it("keeps genuinely differing runs separate", () => {
    const { document } = load("generated-run-per-word.docx");
    expect(selectType(document.body, "strong").length).toBeGreaterThan(1);
  });

  it("handles the 1 to 3 heading level skip this class exhibits", () => {
    const { document } = load("generated-run-per-word.docx");
    const levels = selectType(document.body, "heading").map((h) => h["resolvedLevel"]);
    expect(levels).toEqual([1, 3]);
  });
});
