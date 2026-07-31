import { describe, it, expect } from "vitest";
import { renderHtml, DEFAULT_STYLESHEET } from "../src/index.js";
import { parseHtmlDocument, parseHtml, textOf } from "@markforge/adapters-html";
import { parseMarkdown } from "@markforge/adapters-md";
import { selectType, textContent, validateDocument, type AnyNode } from "@markforge/ir";

const fromHtml = (html: string) => parseHtmlDocument(html).document;
const roundTrip = (html: string): string =>
  renderHtml(fromHtml(html), { fullDocument: false }).html;

describe("HTML parser", () => {
  it("handles implied end tags on list items", () => {
    // `<li>a<li>b` is two siblings, not a nested list. A parser that requires the
    // end tag produces a tree that is wrong rather than one that fails loudly.
    const doc = fromHtml("<ul><li>a<li>b</ul>");
    const items = selectType(doc.body, "listItem");
    expect(items).toHaveLength(2);
  });

  it("closes an open paragraph when a block element starts", () => {
    const doc = fromHtml("<p>one<p>two");
    expect(selectType(doc.body, "paragraph")).toHaveLength(2);
  });

  it("handles table cells with implied end tags", () => {
    const doc = fromHtml("<table><tr><td>a<td>b</table>");
    expect(selectType(doc.body, "tableCell")).toHaveLength(2);
  });

  it("treats script and style contents as raw text, not markup", () => {
    const doc = fromHtml("<p>before</p><script>if (a < b) { x(); }</script><p>after</p>");
    expect(selectType(doc.body, "paragraph")).toHaveLength(2);
    expect(textContent(doc.body)).not.toContain("x()");
  });

  it("survives unclosed tags at end of input", () => {
    expect(() => fromHtml("<div><p>unterminated")).not.toThrow();
    expect(textContent(fromHtml("<div><p>unterminated").body)).toBe("unterminated");
  });

  it("ignores a stray closing tag rather than unwinding the document", () => {
    const doc = fromHtml("<p>one</p></div><p>two</p>");
    expect(selectType(doc.body, "paragraph")).toHaveLength(2);
  });

  it("decodes named, decimal, and hex entities", () => {
    const doc = fromHtml("<p>&amp; &#65; &#x42; &nbsp; &hellip;</p>");
    const text = textContent(doc.body);
    expect(text).toContain("&");
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("…");
  });

  it("treats a lone < as literal text", () => {
    expect(textContent(fromHtml("<p>a < b</p>").body)).toContain("<");
  });

  it("reads attributes in single quotes, double quotes, and bare", () => {
    const el = parseHtml(`<a href='x' title="y" download>z</a>`);
    const a = el.children[0] as { attrs: Record<string, string> };
    expect(a.attrs["href"]).toBe("x");
    expect(a.attrs["title"]).toBe("y");
    expect(a.attrs["download"]).toBe("");
  });
});

describe("HTML to IR", () => {
  it("produces a document that validates against the schema", () => {
    const doc = fromHtml("<h1>T</h1><p>Body with <strong>bold</strong>.</p>");
    const result = validateDocument(doc);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("maps h1..h6 to headings with matching levels", () => {
    const doc = fromHtml("<h1>a</h1><h3>b</h3><h6>c</h6>");
    expect(selectType(doc.body, "heading").map((h) => h["resolvedLevel"])).toEqual([1, 3, 6]);
  });

  it("maps inline tags to marks", () => {
    const doc = fromHtml("<p><b>b</b><i>i</i><del>d</del><mark>m</mark><sub>s</sub></p>");
    for (const type of ["strong", "emphasis", "delete", "highlight", "subscript"]) {
      expect(selectType(doc.body, type), type).toHaveLength(1);
    }
  });

  it("unwraps transparent containers", () => {
    // A div carries no semantics; keeping it would put a meaningless node between
    // every block and make structural comparison against other formats fail.
    const doc = fromHtml("<div><section><p>text</p></section></div>");
    expect((doc.body.children as unknown as AnyNode[])[0]!.type).toBe("paragraph");
  });

  // HTML is the format where span semantics are stated rather than implied, which
  // is why CORPUS §2.5 makes it the ground truth for the DOCX and PDF table paths.
  it("reads rowspan and colspan verbatim", () => {
    const doc = fromHtml(
      `<table><tr><td rowspan="2">tall</td><td colspan="3">wide</td></tr><tr><td>x</td></tr></table>`,
    );
    const cells = selectType(doc.body, "tableCell");
    expect(cells[0]!["rowSpan"]).toBe(2);
    expect(cells[1]!["colSpan"]).toBe(3);
  });

  it("recognises a header row from thead and from all-th rows", () => {
    const withThead = fromHtml("<table><thead><tr><td>h</td></tr></thead><tr><td>b</td></tr></table>");
    expect(selectType(withThead.body, "table")[0]!["headerRowCount"]).toBe(1);

    const withTh = fromHtml("<table><tr><th>h</th></tr><tr><td>b</td></tr></table>");
    expect(selectType(withTh.body, "table")[0]!["headerRowCount"]).toBe(1);
  });

  it("keeps a list's start attribute", () => {
    const list = selectType(fromHtml(`<ol start="5"><li>a</li></ol>`).body, "list")[0]!;
    expect(list["start"]).toBe(5);
    expect(list["restartsAt"]).toBe(5);
  });

  it("reads a code language from the class", () => {
    const code = selectType(fromHtml(`<pre><code class="language-python">x = 1</code></pre>`).body, "code")[0]!;
    expect(code["lang"]).toBe("python");
    expect(code["value"]).toBe("x = 1");
  });

  it("distinguishes absent alt from empty alt", () => {
    // Empty alt declares an image decorative; absent means nobody said. Collapsing
    // them would invent an accessibility claim.
    expect(selectType(fromHtml(`<img src="a.png" alt="">`).body, "image")[0]!["alt"]).toBe("");
    expect(selectType(fromHtml(`<img src="a.png">`).body, "image")[0]!["alt"]).toBeUndefined();
  });

  it("turns a fragment link into a crossReference, not a link", () => {
    const doc = fromHtml(`<a href="#intro">see</a>`);
    expect(selectType(doc.body, "crossReference")).toHaveLength(1);
    expect(selectType(doc.body, "link")).toHaveLength(0);
  });

  it("preserves an unknown element with a diagnostic", () => {
    const { document, diagnostics } = parseHtmlDocument("<p>a</p><custom-widget>data</custom-widget>");
    expect(selectType(document.body, "unknown")).toHaveLength(1);
    expect(diagnostics.lossy().length).toBeGreaterThan(0);
  });

  it("reads document metadata", () => {
    const doc = fromHtml(
      `<html lang="fr"><head><title>Titre</title><meta name="author" content="Ada"></head><body><p>x</p></body></html>`,
    );
    expect(doc.metadata["title"]).toBe("Titre");
    expect(doc.metadata["authors"]).toEqual(["Ada"]);
    expect(doc.metadata["language"]).toBe("fr");
  });

  it("binds a table caption into a figure", () => {
    const doc = fromHtml("<table><caption>Cap</caption><tr><td>a</td></tr></table>");
    expect(selectType(doc.body, "figure")).toHaveLength(1);
    expect(selectType(doc.body, "caption")).toHaveLength(1);
  });
});

describe("IR to HTML", () => {
  it("emits semantic tags, never inline style for structure", () => {
    const html = roundTrip("<h2>Title</h2><p>Body</p>");
    expect(html).toContain("<h2");
    expect(html).toContain("<p>Body</p>");
    expect(html).not.toMatch(/style="font-size/);
  });

  it("escapes text but passes raw html through", () => {
    const doc = parseMarkdown("Text with <b>raw</b> and & ampersand.\n").document;
    const { html } = renderHtml(doc, { fullDocument: false });
    expect(html).toContain("&amp;");
    expect(html).toContain("<b>");
  });

  it("emits stable, unique heading ids", () => {
    const html = roundTrip("<h1>Same</h1><h1>Same</h1>");
    expect(html).toContain('id="same"');
    expect(html).toContain('id="same-2"');
  });

  it("produces identical ids across runs", () => {
    const a = roundTrip("<h1>Introduction</h1><h2>Détails</h2>");
    const b = roundTrip("<h1>Introduction</h1><h2>Détails</h2>");
    expect(a).toBe(b);
  });

  it("keeps rowspan and colspan on output", () => {
    const html = roundTrip(`<table><tr><td rowspan="2">a</td><td colspan="2">b</td></tr></table>`);
    expect(html).toContain('rowspan="2"');
    expect(html).toContain('colspan="2"');
  });

  it("splits header rows into thead", () => {
    const html = roundTrip("<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>h</th>");
    expect(html).toContain("<tbody>");
  });

  it("does not add whitespace inside pre", () => {
    // Whitespace in <pre> is content; adding any would change what the page shows.
    const html = roundTrip("<pre><code>line one\n  indented</code></pre>");
    expect(html).toContain("<pre><code>line one\n  indented</code></pre>");
  });

  it("emits a full document with charset, viewport, and title", () => {
    const doc = fromHtml("<html><head><title>T</title></head><body><p>x</p></body></html>");
    const { html } = renderHtml(doc, { stylesheet: DEFAULT_STYLESHEET });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>T</title>");
    expect(html).toContain("prefers-color-scheme");
  });

  it("links an external stylesheet instead of inlining when asked", () => {
    const { html } = renderHtml(fromHtml("<p>x</p>"), { stylesheetHref: "style.css" });
    expect(html).toContain('<link rel="stylesheet" href="style.css">');
    expect(html).not.toContain("<style>");
  });

  it("keeps a heading past level 6 recoverable in data-level", () => {
    const doc = parseMarkdown("# T\n").document;
    (doc.body.children as unknown as AnyNode[])[0]!["resolvedLevel"] = 8;
    const { html, diagnostics } = renderHtml(doc, { fullDocument: false });
    expect(html).toContain('data-level="8"');
    expect(html).toContain("<h6");
    expect(diagnostics.lossy().some((d) => d.code === "MF-RENDER-0003")).toBe(true);
  });
});

describe("html → ir → html round trip", () => {
  const CASES: [string, string][] = [
    ["heading and paragraph", "<h1>T</h1><p>Body.</p>"],
    ["inline marks", "<p><strong>b</strong> and <em>i</em> and <code>c</code></p>"],
    ["unordered list", "<ul><li>a</li><li>b</li></ul>"],
    ["ordered list", "<ol><li>a</li><li>b</li></ol>"],
    ["nested list", "<ul><li>a<ul><li>b</li></ul></li></ul>"],
    ["table with spans", `<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>`],
    ["blockquote", "<blockquote><p>q</p></blockquote>"],
    ["code block", `<pre><code class="language-js">const x = 1;</code></pre>`],
    ["link and image", `<p><a href="https://example.com">t</a><img src="i.png" alt="a"></p>`],
    ["description list", "<dl><dt>term</dt><dd>definition</dd></dl>"],
  ];

  it.each(CASES)("%s reaches a fixed point", (_name, html) => {
    const once = roundTrip(html);
    const twice = roundTrip(once);
    expect(twice).toBe(once);
  });

  it("preserves all text content", () => {
    for (const [, html] of CASES) {
      const before = textContent(fromHtml(html).body).replace(/\s+/g, " ").trim();
      const after = textContent(fromHtml(roundTrip(html)).body).replace(/\s+/g, " ").trim();
      expect(after).toBe(before);
    }
  });

  it("preserves table spans across the round trip", () => {
    const html = `<table><tr><td rowspan="3" colspan="2">big</td></tr></table>`;
    const cells = selectType(fromHtml(roundTrip(html)).body, "tableCell");
    expect(cells[0]!["rowSpan"]).toBe(3);
    expect(cells[0]!["colSpan"]).toBe(2);
  });
});

describe("markdown ↔ html", () => {
  it("converts markdown to html", () => {
    const doc = parseMarkdown("# T\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n").document;
    const { html } = renderHtml(doc, { fullDocument: false });
    expect(html).toContain("<h1");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
  });

  it("converts html to markdown-shaped IR with the same text", () => {
    const source = "<h1>T</h1><ul><li>a</li><li>b</li></ul>";
    expect(textOf(parseHtml(source))).toContain("T");
    expect(textContent(fromHtml(source).body)).toContain("a");
  });
});
