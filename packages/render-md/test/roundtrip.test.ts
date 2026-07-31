import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseMarkdown } from "@markforge/adapters-md";
import { renderMarkdown } from "../src/index.js";
import { selectType, textContent, validateDocument, type AnyNode } from "@markforge/ir";

/** One `fmt` pass: parse to IR, render back to Markdown. */
const fmt = (src: string): string => renderMarkdown(parseMarkdown(src).document).markdown;

describe("md → ir → md", () => {
  it("produces a document that validates against the schema", () => {
    const { document } = parseMarkdown("# Title\n\nBody with **bold** and `code`.\n");
    const result = validateDocument(document);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("preserves headings, emphasis, and code", () => {
    const out = fmt("# Title\n\nSome **bold** and _italic_ and `code`.\n");
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("_italic_");
    expect(out).toContain("`code`");
  });

  it("preserves ordered lists as ordered", () => {
    const out = fmt("1. one\n2. two\n");
    expect(out).toMatch(/^1\. one$/m);
    expect(out).toMatch(/^2\. two$/m);
  });

  it("preserves a list's start number", () => {
    const out = fmt("5. five\n6. six\n");
    expect(out).toMatch(/^5\. five$/m);
  });

  it("preserves nested lists", () => {
    const out = fmt("- top\n  - nested\n- back\n");
    const doc = parseMarkdown(out).document;
    expect(selectType(doc.body, "list").length).toBeGreaterThanOrEqual(2);
  });

  it("preserves GFM tables including alignment", () => {
    const src = "| a | b |\n| :- | --: |\n| 1 | 2 |\n";
    const out = fmt(src);
    expect(out).toContain("| :-");
    expect(out).toContain("-: |");
    const doc = parseMarkdown(out).document;
    expect(selectType(doc.body, "tableCell")).toHaveLength(4);
  });

  it("preserves front matter", () => {
    const out = fmt("---\ntitle: Test\n---\n\n# Body\n");
    expect(out.startsWith("---\ntitle: Test\n---")).toBe(true);
  });

  it("preserves footnotes", () => {
    const out = fmt("Text[^1]\n\n[^1]: The note.\n");
    expect(out).toContain("[^1]");
    expect(out).toContain("The note.");
  });

  it("preserves strikethrough", () => {
    expect(fmt("~~gone~~\n")).toContain("~~gone~~");
  });

  it("preserves math", () => {
    const out = fmt("$$\nx = 1\n$$\n");
    expect(out).toContain("x = 1");
  });

  it("preserves fenced code with its language", () => {
    const out = fmt("```python\nprint(1)\n```\n");
    expect(out).toContain("```python");
    expect(out).toContain("print(1)");
  });

  it("keeps interior whitespace inside code fences", () => {
    const out = fmt("```\na    b\n```\n");
    expect(out).toContain("a    b");
  });

  // A thematic break emitted as `---` at the start of a document is ambiguous with a
  // YAML front-matter opening fence, and the parser resolves it as front matter,
  // flattening the following block. The renderer must never emit that ambiguity.
  //
  // Note what this does *not* claim: an input of "---\n\n- item" is genuinely
  // ambiguous Markdown, and how a parser reads it is not the renderer's to fix. The
  // guarantee is one-directional — anything MarkForge *writes* re-parses to what it
  // meant.
  it("never emits a thematic break that could be read as front matter", () => {
    const doc = parseMarkdown("***\n\n- item\n").document;
    const out = renderMarkdown(doc).markdown;
    expect(out).not.toMatch(/^---/);
    expect(selectType(parseMarkdown(out).document.body, "list")).toHaveLength(1);
  });

  it("always ends with exactly one trailing newline", () => {
    for (const src of ["# a", "# a\n", "# a\n\n\n"]) {
      const out = fmt(src);
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n\n")).toBe(false);
    }
  });
});

describe("fmt idempotency — the Phase 1 gate (brief §11)", () => {
  const CASES: [name: string, source: string][] = [
    ["heading", "# Title\n"],
    ["paragraph", "Just some text.\n"],
    ["emphasis", "A **bold** and _italic_ sentence.\n"],
    ["nested emphasis", "**_both_**\n"],
    ["unordered list", "- a\n- b\n"],
    ["ordered list", "1. a\n2. b\n"],
    ["nested list", "- a\n  - b\n    - c\n"],
    ["ordered list with start", "7. seven\n8. eight\n"],
    ["table", "| a | b |\n| - | - |\n| 1 | 2 |\n"],
    ["aligned table", "| a | b |\n| :- | --: |\n| 1 | 2 |\n"],
    ["code fence", "```js\nconst x = 1;\n```\n"],
    ["indented code becomes fenced", "    indented\n"],
    ["blockquote", "> quoted\n"],
    ["nested blockquote", "> > deep\n"],
    ["thematic break", "---\n"],
    ["link", "[text](https://example.com)\n"],
    ["reference link", "[text][ref]\n\n[ref]: https://example.com\n"],
    ["image", "![alt](img.png)\n"],
    ["footnote", "Text[^1]\n\n[^1]: Note.\n"],
    ["strikethrough", "~~gone~~\n"],
    ["inline code", "Use `x` here.\n"],
    ["front matter", "---\ntitle: T\n---\n\n# B\n"],
    ["math block", "$$\nx = 1\n$$\n"],
    ["inline math", "Value $x$ here.\n"],
    ["html block", "<div>raw</div>\n"],
    ["mixed document", "# T\n\nPara.\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n"],
    ["hard break", "line one  \nline two\n"],
    ["escaped characters", "\\*not emphasis\\*\n"],
    ["emoji", "Hello 👋🏽 world\n"],
    ["combining marks", "café résumé\n"],
    ["non-breaking space", "10 km\n"],
    ["CJK", "日本語のテキスト\n"],
    ["RTL", "مرحبا بالعالم\n"],
    ["autolink", "<https://example.com>\n"],
    ["task list", "- [ ] todo\n- [x] done\n"],
  ];

  // The property that makes `fmt --check` trustworthy: one pass reaches a fixed
  // point. If it took two, `--check` would report a file as needing changes
  // immediately after formatting it, and nobody would trust the tool again.
  it.each(CASES)("fmt(fmt(%s)) === fmt(%s)", (_name, source) => {
    const once = fmt(source);
    const twice = fmt(once);
    expect(twice).toBe(once);
  });

  it("reaches a fixed point on all cases in a single pass", () => {
    for (const [name, source] of CASES) {
      const once = fmt(source);
      expect(fmt(once), `${name} needed more than one pass`).toBe(once);
    }
  });

  // Generated documents find the cases nobody thought to write down. The empty-node
  // bug that broke normalize idempotency was found this way, not by a fixture.
  it("is idempotent on generated documents", () => {
    const inlineText = fc.stringMatching(/^[a-zA-Z0-9 .,!?()-]{0,20}$/);

    const inline = fc.oneof(
      inlineText.map((value) => `${value}`),
      inlineText.map((value) => `**${value}**`),
      inlineText.map((value) => `_${value}_`),
      inlineText.map((value) => `\`${value}\``),
      inlineText.map((value) => `~~${value}~~`),
    );

    const block = fc.oneof(
      fc.tuple(fc.integer({ min: 1, max: 6 }), inlineText).map(([d, t]) => `${"#".repeat(d)} ${t || "h"}`),
      fc.array(inline, { minLength: 1, maxLength: 3 }).map((xs) => xs.join(" ")),
      fc.array(inlineText, { minLength: 1, maxLength: 3 }).map((xs) => xs.map((x) => `- ${x || "item"}`).join("\n")),
      fc.array(inlineText, { minLength: 1, maxLength: 3 }).map((xs) => xs.map((x, i) => `${i + 1}. ${x || "item"}`).join("\n")),
      inlineText.map((t) => "> " + (t || "quote")),
      inlineText.map((t) => "```\n" + t + "\n```"),
      fc.constant("---"),
    );

    fc.assert(
      fc.property(fc.array(block, { minLength: 1, maxLength: 5 }), (blocks) => {
        const source = blocks.join("\n\n") + "\n";
        const once = fmt(source);
        const twice = fmt(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 400 },
    );
  });

  it("is idempotent across three passes, not just two", () => {
    // Two passes can agree by accident if a rule alternates with period 2. Three
    // is cheap insurance against that specific failure mode.
    for (const [, source] of CASES) {
      const a = fmt(source);
      const b = fmt(a);
      const c = fmt(b);
      expect(b).toBe(a);
      expect(c).toBe(a);
    }
  });
});

describe("lossy constructs are reported, never silent", () => {
  it("reports when a heading level is clamped", () => {
    const doc = parseMarkdown("# T\n").document;
    // Force a level Markdown cannot express, as a DOCX outline level 7 would.
    (doc.body.children as unknown as AnyNode[])[0]!["resolvedLevel"] = 8;
    const { markdown, diagnostics } = renderMarkdown(doc);
    expect(markdown).toContain("# T");
    expect(diagnostics.lossy().some((d) => d.code === "MF-RENDER-0003")).toBe(true);
  });

  it("round-trips an unknown construct rather than dropping it", () => {
    const doc = parseMarkdown("text\n").document;
    (doc.body.children as unknown as AnyNode[]).push({
      type: "unknown",
      originalType: "w:smartTag",
      raw: "<!-- preserved -->",
    } as never);
    const { markdown, diagnostics } = renderMarkdown(doc);
    expect(markdown).toContain("<!-- preserved -->");
    expect(diagnostics.lossy().length).toBeGreaterThan(0);
  });

  it("preserves text content through the round trip", () => {
    const src = "# Title\n\nBody text here.\n\n- item one\n- item two\n";
    const before = textContent(parseMarkdown(src).document.body);
    const after = textContent(parseMarkdown(fmt(src)).document.body);
    expect(after).toBe(before);
  });
});
