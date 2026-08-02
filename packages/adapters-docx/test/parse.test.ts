import { describe, it, expect } from "vitest";
import { parseDocx } from "../src/index.js";
import { buildDocx, p, DEFAULT_STYLES } from "./helpers.js";
import {
  checkProvenanceComplete,
  checkUnknownNodesDiagnosed,
  selectType,
  textContent,
  validateDocument,
  type AnyNode,
} from "@markforge/ir";

const parse = (body: string, extra: Parameters<typeof buildDocx>[0] = { body }) =>
  parseDocx(buildDocx({ ...extra, body }), { path: "test.docx" });

describe("DOCX adapter — contract", () => {
  // A4 is the invariant that makes "where did this come from?" answerable. It is
  // checked on every parse rather than spot-checked, because it only holds if the
  // weakest code path holds.
  it("A4: every node carries provenance", () => {
    const { document } = parse(
      p("Title", { style: "Heading1" }) +
        p("Body text") +
        p("Item", { numId: "1" }) +
        `<w:tbl><w:tr><w:tc>${p("cell")}</w:tc></w:tr></w:tbl>`,
    );
    const result = checkProvenanceComplete(document);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("A6: unknown constructs produce a node and a lossy diagnostic", () => {
    const { document, diagnostics } = parse(`<w:customXmlThing><w:t>x</w:t></w:customXmlThing>`);
    const unknowns = selectType(document.body, "unknown");
    expect(unknowns.length).toBeGreaterThan(0);
    expect(diagnostics.lossy().some((d) => d.code === "MF-DOCX-0052")).toBe(true);
  });

  it("produces a document that validates against ir.v0.schema.json", () => {
    const { document } = parse(p("Hello", { style: "Heading1" }) + p("World"));
    const result = validateDocument(document);
    expect(result.errors.slice(0, 5)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is deterministic: the same bytes parse to the same ids", () => {
    const bytes = buildDocx({ body: p("a") + p("b") });
    const one = parseDocx(bytes, { path: "x.docx" });
    const two = parseDocx(bytes, { path: "x.docx" });
    expect(JSON.stringify(one.document.body)).toBe(JSON.stringify(two.document.body));
  });
});

describe("DOCX adapter — text and marks", () => {
  it("preserves whitespace when xml:space=preserve", () => {
    const { document } = parse(
      `<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>`,
    );
    expect(textContent(document.body)).toBe("Hello world");
  });

  it("applies bold and italic as marks, not as style evidence only", () => {
    const { document } = parse(
      `<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>both</w:t></w:r></w:p>`,
    );
    expect(selectType(document.body, "strong")).toHaveLength(1);
    expect(selectType(document.body, "emphasis")).toHaveLength(1);
  });

  it("treats <w:b w:val=\"0\"/> as not bold", () => {
    const { document } = parse(`<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>plain</w:t></w:r></w:p>`);
    expect(selectType(document.body, "strong")).toHaveLength(0);
  });

  it("maps vertAlign to subscript and superscript", () => {
    const { document } = parse(
      `<w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r></w:p>`,
    );
    expect(selectType(document.body, "superscript")).toHaveLength(1);
  });

  it("keeps hard breaks as break nodes", () => {
    const { document } = parse(`<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>`);
    expect(selectType(document.body, "break")).toHaveLength(1);
  });

  it("records style evidence in the sidecar, not on the node", () => {
    const { document } = parse(p("Heading", { style: "Heading1" }));
    const para = (document.body.children as AnyNode[])[0]!;
    const evidence = document.sidecar[para.id as string];
    expect(evidence?.sourceStyleName).toBe("heading 1");
    expect(evidence?.font?.sizePt).toBe(16);
    expect(evidence?.font?.weight).toBe(700);
    expect(evidence?.outlineLevel).toBe(0);
    // A5: the adapter records evidence; it does not decide this is a heading.
    expect(para.type).toBe("paragraph");
  });
});

describe("DOCX adapter — lists", () => {
  // The measured defect: ListParagraph + numPr is how Word encodes both ordered and
  // unordered lists, so a reader that trusts the style name gets every numbered
  // list wrong. This is the reference project's documented bug.
  it("takes ordered-vs-unordered from numbering.xml, not from the style name", () => {
    const { document } = parse(
      p("one", { style: "ListParagraph", numId: "1" }) +
        p("two", { style: "ListParagraph", numId: "1" }),
    );
    const lists = selectType(document.body, "list");
    expect(lists).toHaveLength(1);
    expect(lists[0]!["ordered"]).toBe(true);
  });

  it("recognises a bullet list with the identical style name", () => {
    const { document } = parse(
      p("one", { style: "ListParagraph", numId: "2" }) +
        p("two", { style: "ListParagraph", numId: "2" }),
    );
    expect(selectType(document.body, "list")[0]!["ordered"]).toBe(false);
  });

  it("nests deeper levels inside the preceding item", () => {
    const { document } = parse(
      p("top", { numId: "1", ilvl: 0 }) +
        p("nested", { numId: "1", ilvl: 1 }) +
        p("back", { numId: "1", ilvl: 0 }),
    );
    const top = selectType(document.body, "list")[0]!;
    const items = top.children as AnyNode[];
    expect(items).toHaveLength(2);
    expect(selectType(items[0]!, "list")).toHaveLength(1);
  });

  it("preserves w:startOverride as a restart", () => {
    const { document } = parse(p("seven", { numId: "3" }));
    const list = selectType(document.body, "list")[0]!;
    // `start`, and only `start`: `restartsAt` is a `ListItem` field in the schema, and this
    // test asserted it on the `list`, which made the whole document fail validation.
    expect(list["start"]).toBe(7);
    expect(list["restartsAt"]).toBeUndefined();
  });

  it("does not merge two adjacent lists with different numIds", () => {
    const { document } = parse(p("a", { numId: "1" }) + p("b", { numId: "2" }));
    expect(selectType(document.body, "list")).toHaveLength(2);
  });

  it("ends a list when a normal paragraph interrupts", () => {
    const { document } = parse(p("a", { numId: "1" }) + p("interrupt") + p("b", { numId: "1" }));
    expect(selectType(document.body, "list")).toHaveLength(2);
  });
});

describe("DOCX adapter — tables", () => {
  const cell = (text: string, attrs = "") =>
    `<w:tc>${attrs ? `<w:tcPr>${attrs}</w:tcPr>` : ""}${p(text)}</w:tc>`;

  it("reads rows and cells", () => {
    const { document } = parse(
      `<w:tbl><w:tr>${cell("a")}${cell("b")}</w:tr><w:tr>${cell("c")}${cell("d")}</w:tr></w:tbl>`,
    );
    expect(selectType(document.body, "tableRow")).toHaveLength(2);
    expect(selectType(document.body, "tableCell")).toHaveLength(4);
  });

  it("maps gridSpan to colSpan", () => {
    const { document } = parse(
      `<w:tbl><w:tr>${cell("wide", '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`,
    );
    expect(selectType(document.body, "tableCell")[0]!["colSpan"]).toBe(2);
  });

  it("collapses vMerge continuation cells into a rowSpan", () => {
    const { document } = parse(
      `<w:tbl>` +
        `<w:tr>${cell("merged", '<w:vMerge w:val="restart"/>')}${cell("x")}</w:tr>` +
        `<w:tr>${cell("", "<w:vMerge/>")}${cell("y")}</w:tr>` +
        `</w:tbl>`,
    );
    const cells = selectType(document.body, "tableCell");
    // Three cells, not four: the continuation cell became a rowSpan on the anchor.
    expect(cells).toHaveLength(3);
    expect(cells[0]!["rowSpan"]).toBe(2);
  });

  it("marks header rows only when w:tblHeader says so", () => {
    const withHeader = parse(
      `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("h")}</w:tr><w:tr>${cell("b")}</w:tr></w:tbl>`,
    );
    expect(selectType(withHeader.document.body, "table")[0]!["headerRowCount"]).toBe(1);

    // A5 again: without the marker, the adapter does not guess that row 0 is a header.
    const without = parse(`<w:tbl><w:tr>${cell("h")}</w:tr><w:tr>${cell("b")}</w:tr></w:tbl>`);
    expect(selectType(without.document.body, "table")[0]!["headerRowCount"]).toBeUndefined();
  });
});

describe("DOCX adapter — tracked changes and furniture", () => {
  it("wraps insertions and deletions rather than marking ranges", () => {
    const { document } = parse(
      `<w:p>` +
        `<w:ins w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>` +
        `<w:del w:author="Bob" w:date="2026-01-02T00:00:00Z"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
        `</w:p>`,
    );
    const ins = selectType(document.body, "insertion");
    const del = selectType(document.body, "deletion");
    expect(ins).toHaveLength(1);
    expect(ins[0]!["author"]).toBe("Ada");
    expect(del).toHaveLength(1);
    expect(textContent(del[0]!)).toBe("removed");
  });

  // A7 / ADR-0002: stripping headers and footers loses content, which SPEC §1.3
  // forbids. Routing satisfies both.
  it("routes headers and footers to furniture instead of dropping them", () => {
    const bytes = buildDocx({
      body: p("Body"),
      rels: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
        <Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
      </Relationships>`,
      extra: {
        "word/header1.xml": `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p("Running head")}</w:hdr>`,
        "word/footer1.xml": `<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p("Page footer")}</w:ftr>`,
      },
    });
    const { document } = parseDocx(bytes);
    expect(document.furniture).toHaveLength(2);
    expect(document.furniture.map((f) => f.kind)).toEqual(["footer", "header"]);
    // `content` is a `root` node, not a bare array. It was an array until the reference
    // templates of TEMPLATES.md §2.1 became the first committed fixtures with a header, at
    // which point every furniture-bearing document turned out to fail schema validation at
    // `/furniture/0/content`. This test asserted the wrong shape too, which is why it did
    // not catch it — so it now also validates the document, below.
    const headerText = document.furniture
      .filter((f) => f.kind === "header")
      .map((f) => textContent(f.content as unknown as AnyNode))
      .join("");
    expect(headerText).toBe("Running head");

    // The assertion that would have caught the shape bug on the day it was written.
    // Checking the *kind* and the *text* of furniture says nothing about whether the
    // document it belongs to is well-formed, and the schema is where the shape is declared.
    const validation = validateDocument(document);
    expect(validation.errors.slice(0, 3)).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

/*
 * Adapter rule A6, at the inline level.
 *
 * The block walk has obeyed A6 since Phase 1 — an unhandled element becomes an `unknown`
 * node plus a lossy diagnostic. The phrasing walk ended in `default: break` and dropped
 * every construct it did not recognise, silently, for five phases.
 *
 * What that cost was only visible on a document nobody had converted: the shipped
 * `academic-manuscript.docx` carries five `<m:oMath>` display equations, and converting it
 * produced no equations and no diagnostic about them. The fidelity census could not see it
 * either — it diffs input IR against round-tripped IR, so a node type no adapter ever
 * produces is absent from both sides and scores as agreement.
 *
 * These tests use OMML because that is the construct that exposed it, and a synthetic
 * unknown because the rule is about the branch rather than about equations.
 */
describe("DOCX adapter — A6 at the inline level", () => {
  const OMML =
    `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">` +
    `<m:r><m:t>E = mc^2</m:t></m:r></m:oMath>`;

  /*
   * A genuinely unhandled inline element.
   *
   * These tests originally probed with OMML, because OMML is what exposed the silent
   * `default: break`. OMML is now mapped to `equationBlock`, so it stopped being unhandled and
   * these three tests failed — correctly. A test whose probe has since been implemented is
   * measuring the implementation, not the rule. `w:ruby` is real WordprocessingML (phonetic
   * annotation), it is inline, and nothing maps it.
   */
  const UNHANDLED = `<w:ruby><w:rubyBase><w:r><w:t>base text</w:t></w:r></w:rubyBase></w:ruby>`;

  it("reports an unhandled inline element instead of dropping it", () => {
    const { document, diagnostics } = parse(`<w:p>${UNHANDLED}</w:p>`);
    const unknowns = selectType(document.body as unknown as AnyNode, "unknown");
    expect(unknowns).toHaveLength(1);
    expect(diagnostics.all().some((d) => d.code === "MF-DOCX-0052")).toBe(true);
  });

  it("marks the loss lossy, so --strict can see it", () => {
    const { diagnostics } = parse(`<w:p>${UNHANDLED}</w:p>`);
    const d = diagnostics.all().find((x) => x.code === "MF-DOCX-0052");
    expect(d?.lossy).toBe(true);
  });

  /*
   * The negative control, and the reason it is not "assert a diagnostic exists".
   *
   * A branch that diagnosed *every* inline child would also pass the two tests above while
   * making the adapter useless — `w:r` and `w:hyperlink` would each raise one. So the
   * control asserts the ordinary case stays quiet, which is the property that would break
   * if the default branch were reached by something it should not be.
   */
  it("maps OMML to equationBlock rather than to unknown", () => {
    // The construct that exposed the silent branch is now handled. Asserted here so the
    // change is visible in the same place the defect is recorded, and so a regression to
    // `unknown` shows up as a behaviour change rather than as one more diagnostic.
    const { document } = parse(`<w:p>${OMML}</w:p>`);
    const equations = selectType(document.body as unknown as AnyNode, "equationBlock");
    expect(equations).toHaveLength(1);
    expect((equations[0] as { notation?: string }).notation).toBe("omml");
    // The markup is retained, not the flattened characters: `t_ack = d/r` reduced to
    // "tack = dr" is the wreckage of an equation rather than the equation.
    expect(String((equations[0] as { source?: string }).source)).toContain("<m:oMath");
  });

  it("does not report elements it handles", () => {
    const { diagnostics } = parse(p("ordinary text"));
    expect(diagnostics.all().filter((d) => d.code === "MF-DOCX-0052")).toHaveLength(0);
  });

  it("keeps the dropped construct's text as the unknown node's raw payload", () => {
    const { document } = parse(`<w:p>${UNHANDLED}</w:p>`);
    const [unknown] = selectType(document.body as unknown as AnyNode, "unknown");
    // Retention is what makes this A6 rather than "a diagnostic instead of the content".
    expect(String((unknown as { raw?: string }).raw)).toContain("base text");
  });
});

describe("DOCX adapter — degenerate inputs", () => {
  it("parses a document with no theme part", () => {
    const { document, diagnostics } = parseDocx(
      buildDocx({ body: p("text"), theme: null }),
    );
    expect(diagnostics.all().some((d) => d.code === "MF-DOCX-0070")).toBe(true);
    expect(textContent(document.body)).toBe("text");
  });

  it("reports a paragraph style that does not exist", () => {
    const { diagnostics } = parse(p("x", { style: "NoSuchStyle" }));
    expect(diagnostics.all().some((d) => d.code === "MF-DOCX-0073")).toBe(true);
  });

  it("rejects a ZIP that is not a WordprocessingML document", () => {
    expect(() => parseDocx(new Uint8Array([1, 2, 3]))).toThrow(/not a readable ZIP/);
  });

  it("handles an empty body", () => {
    const { document } = parse("");
    expect(document.body.children).toEqual([]);
    expect(checkProvenanceComplete(document).ok).toBe(true);
  });

  it("reads core properties into metadata", () => {
    const bytes = buildDocx({
      body: p("x"),
      coreProps: `<?xml version="1.0"?><cp:coreProperties
        xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>A Title</dc:title><dc:creator>An Author</dc:creator></cp:coreProperties>`,
    });
    const { document } = parseDocx(bytes);
    expect(document.metadata["title"]).toBe("A Title");
    expect(document.metadata["authors"]).toEqual(["An Author"]);
  });
});
