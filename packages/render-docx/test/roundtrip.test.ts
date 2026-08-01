import { describe, it, expect } from "vitest";
import { renderDocx, reportCoverage, resolveStyle, ALL_PANDOC_STYLE_NAMES } from "../src/index.js";
import { parseDocx } from "@markforge/adapters-docx";
import { parseMarkdown } from "@markforge/adapters-md";
import { renderMarkdown } from "@markforge/render-md";
import { inferHeadings } from "@markforge/infer";
import { selectType, textContent, validateDocument, type AnyNode } from "@markforge/ir";
import { OpcPackage, Part, childrenNamed, descendantsNamed, attr } from "@markforge/ooxml";

/** md → ir → docx, the write half of the gate. */
const toDocx = (md: string) => renderDocx(parseMarkdown(md).document, { onMissingStyle: "synthesize" });

/** docx → ir → md, the read half. */
const toMd = (bytes: Uint8Array): string => {
  const { document } = parseDocx(bytes);
  inferHeadings(document);
  return renderMarkdown(document).markdown;
};

describe("DOCX renderer", () => {
  it("produces a package that our own reader can open", () => {
    const { bytes } = toDocx("# Title\n\nBody.\n");
    const { document } = parseDocx(bytes);
    expect(textContent(document.body)).toContain("Title");
    expect(validateDocument(document).valid).toBe(true);
  });

  it("writes the parts a DOCX needs to open at all", () => {
    const pkg = OpcPackage.open(toDocx("text\n").bytes);
    for (const part of [Part.CONTENT_TYPES, Part.ROOT_RELS, Part.DOCUMENT, Part.DOCUMENT_RELS, Part.STYLES, Part.NUMBERING]) {
      expect(pkg.has(part), `missing ${part}`).toBe(true);
    }
  });

  // Rule 1 of SPEC §4.2, asserted rather than trusted. This is the bug the whole
  // project exists to fix: run-level font properties instead of named styles.
  it("never emits direct font properties on a heading", () => {
    const pkg = OpcPackage.open(toDocx("# A Heading\n\n## Another\n").bytes);
    const document = pkg.xml(Part.DOCUMENT)!;
    for (const rPr of descendantsNamed(document, "rPr")) {
      for (const prop of rPr.children) {
        if (!("name" in prop)) continue;
        expect(
          ["rFonts", "sz", "szCs", "color"],
          `run property <${prop.name}> leaked into the body; formatting belongs to the style`,
        ).not.toContain(prop.local);
      }
    }
  });

  it("maps headings to named styles", () => {
    const pkg = OpcPackage.open(toDocx("# One\n\n## Two\n\n### Three\n").bytes);
    const document = pkg.xml(Part.DOCUMENT)!;
    const styles = descendantsNamed(document, "pStyle").map((s) => attr(s, "val"));
    expect(styles).toContain("Heading1");
    expect(styles).toContain("Heading2");
    expect(styles).toContain("Heading3");
  });

  it("emits inline semantics but nothing else", () => {
    const pkg = OpcPackage.open(toDocx("Some **bold** and _italic_ text.\n").bytes);
    const document = pkg.xml(Part.DOCUMENT)!;
    const props = descendantsNamed(document, "rPr").flatMap((r) =>
      r.children.filter((c) => "name" in c).map((c) => (c as { local: string }).local),
    );
    expect(props).toContain("b");
    expect(props).toContain("i");
  });

  it("writes numbering definitions for lists", () => {
    const pkg = OpcPackage.open(toDocx("1. one\n2. two\n").bytes);
    const numbering = pkg.xml(Part.NUMBERING)!;
    expect(childrenNamed(numbering, "num").length).toBeGreaterThan(0);
    const document = pkg.xml(Part.DOCUMENT)!;
    expect(descendantsNamed(document, "numPr").length).toBe(2);
  });

  it("gives every table cell at least one paragraph, as OOXML requires", () => {
    const pkg = OpcPackage.open(toDocx("| a | b |\n| - | - |\n|  | 2 |\n").bytes);
    const document = pkg.xml(Part.DOCUMENT)!;
    for (const tc of descendantsNamed(document, "tc")) {
      expect(childrenNamed(tc, "p").length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: the same IR renders to the same bytes", () => {
    const doc = parseMarkdown("# T\n\n- a\n- b\n").document;
    const a = renderDocx(doc, { onMissingStyle: "synthesize" }).bytes;
    const b = renderDocx(doc, { onMissingStyle: "synthesize" }).bytes;
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it("reports a missing style rather than silently inventing one", () => {
    // Against a reference document that defines only Normal. The built-in fallback
    // styles.xml deliberately defines the full Pandoc set, so it cannot demonstrate
    // this path — an earlier version of this test used it and passed only because
    // the fallback was being installed too late to be found.
    const bare = OpcPackage.create({
      "word/styles.xml":
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    }).toBytes();
    const { diagnostics } = renderDocx(parseMarkdown("> quoted\n").document, {
      onMissingStyle: "warn",
      referenceDoc: bare,
    });
    expect(diagnostics.lossy().some((d) => d.code === "MF-RENDER-0002")).toBe(true);
  });

  // The fallback exists so that a conversion with no reference document is quiet and
  // correct. If it were installed after rendering, every role would resolve to
  // nothing and each one would emit a synthesis warning — which is what happened.
  it("emits no style warnings when falling back, since the fallback defines the set", () => {
    const { diagnostics } = renderDocx(parseMarkdown("# T\n\n> q\n\n- a\n").document, {
      onMissingStyle: "warn",
    });
    expect(diagnostics.lossy().filter((d) => d.code.startsWith("MF-RENDER-000"))).toEqual([]);
  });

  it("throws on a missing style when asked to, naming the role and the fix", () => {
    // A reference document defining Normal and nothing else. `error` mode exists for
    // users who would rather fail than ship a document with the wrong styles, so the
    // message has to name the role and the config key that fixes it.
    const bare = OpcPackage.create({
      "word/styles.xml":
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    }).toBytes();
    expect(() =>
      renderDocx(parseMarkdown("# T\n").document, { onMissingStyle: "error", referenceDoc: bare }),
    ).toThrow(/heading:1/);
  });
});

describe("docx → md → docx round trip", () => {
  const SOURCES = [
    ["heading and body", "# Title\n\nBody text.\n"],
    ["multiple heading levels", "# One\n\n## Two\n\n### Three\n\nBody.\n"],
    ["ordered list", "1. first\n2. second\n3. third\n"],
    ["unordered list", "- alpha\n- beta\n"],
    ["nested list", "- top\n  - nested\n- back\n"],
    ["table", "| h1 | h2 |\n| - | - |\n| a | b |\n"],
    ["inline marks", "Text with **bold**, _italic_, and `code`.\n"],
    ["blockquote", "> quoted text\n"],
    ["code block", "```js\nconst x = 1;\n```\n"],
    ["mixed", "# T\n\nPara.\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n"],
  ] as const;

  it.each(SOURCES)("%s survives md → docx → md", (_name, source) => {
    const docx = toDocx(source).bytes;
    const back = toMd(docx);
    // Text content is the invariant that must hold exactly. Formatting is measured
    // by the fidelity harness; here we assert nothing was *lost*.
    const before = textContent(parseMarkdown(source).document.body).replace(/\s+/g, " ").trim();
    const after = textContent(parseMarkdown(back).document.body).replace(/\s+/g, " ").trim();
    for (const word of before.split(" ").filter((w) => w.length > 2)) {
      expect(after, `"${word}" was lost in the round trip`).toContain(word);
    }
  });

  it("preserves heading levels through the round trip", () => {
    const back = toMd(toDocx("# One\n\n## Two\n\n### Three\n").bytes);
    expect(back).toMatch(/^# One$/m);
    expect(back).toMatch(/^## Two$/m);
    expect(back).toMatch(/^### Three$/m);
  });

  // The defect the reference project documents in its own README, and the reason
  // @markforge/ooxml reads numbering.xml rather than trusting style names.
  it("keeps numbered lists numbered", () => {
    const back = toMd(toDocx("1. one\n2. two\n").bytes);
    expect(back).toMatch(/^1\. one$/m);
    expect(back).toMatch(/^2\. two$/m);
    expect(back).not.toMatch(/^- one$/m);
  });

  it("keeps bullet lists bulleted", () => {
    const back = toMd(toDocx("- one\n- two\n").bytes);
    expect(back).toMatch(/^- one$/m);
    expect(back).not.toMatch(/^1\. one$/m);
  });

  it("preserves table structure", () => {
    const back = toMd(toDocx("| h1 | h2 |\n| - | - |\n| a | b |\n").bytes);
    const doc = parseMarkdown(back).document;
    expect(selectType(doc.body, "tableCell").length).toBeGreaterThanOrEqual(4);
  });

  it("is stable across two full round trips", () => {
    // The second trip must not drift further than the first. Drift that compounds
    // means the conversion is not a fixed point, and a document edited repeatedly
    // would degrade a little each time.
    const once = toMd(toDocx("# T\n\nBody.\n\n- a\n- b\n").bytes);
    const twice = toMd(toDocx(once).bytes);
    expect(twice).toBe(once);
  });
});

describe("style coverage reporting (SPEC §4.2.1)", () => {
  it("knows all 38 Pandoc style names", () => {
    expect(ALL_PANDOC_STYLE_NAMES).toHaveLength(38);
  });

  it("reports what a template defines and what it lacks", () => {
    const available = [
      { styleId: "Normal", name: "Normal" },
      { styleId: "Heading1", name: "Heading 1" },
    ];
    const report = reportCoverage(available);
    expect(report.defined).toContain("Normal");
    expect(report.defined).toContain("Heading 1");
    expect(report.missing).toContain("Body Text");
    expect(report.defined.length + report.missing.length).toBe(38);
  });

  // The skeleton is what makes adapting a template an edit rather than an
  // investigation — measured reality is that most templates define a small minority
  // of these names (SPEC §4.2.2).
  it("emits a styleMap skeleton, blank where nothing matched", () => {
    const report = reportCoverage([{ styleId: "Normal", name: "Normal" }]);
    expect(report.skeleton["normal"]).toBe("Normal");
    expect(report.skeleton["heading:1"]).toBe("");
  });

  it("resolves a styleMap entry by style name or by style id", () => {
    const available = [{ styleId: "BodyTextIndent", name: "Body Text Indent" }];
    // Word's UI shows the name; the file stores the id. Both must work.
    expect(resolveStyle("paragraph", { paragraph: "Body Text Indent" }, available).styleId).toBe("BodyTextIndent");
    expect(resolveStyle("paragraph", { paragraph: "BodyTextIndent" }, available).styleId).toBe("BodyTextIndent");
  });

  it("reports an unmatched styleMap override rather than falling back", () => {
    // The user asked for something specific; quietly using a default would hide
    // their typo.
    const r = resolveStyle("paragraph", { paragraph: "No Such Style" }, [{ styleId: "Normal", name: "Normal" }]);
    expect(r.styleId).toBeUndefined();
    expect(r.wanted).toBe("No Such Style");
  });

  it("falls back to the Pandoc name when no override is given", () => {
    const available = [{ styleId: "BodyText", name: "Body Text" }];
    const r = resolveStyle("paragraph", {}, available);
    expect(r.styleId).toBe("BodyText");
    expect(r.via).toBe("pandocName");
  });
});
