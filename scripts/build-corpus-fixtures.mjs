#!/usr/bin/env node
/**
 * The DOCX half of the Phase 6 corpus completion: CORPUS.md §2.2, §2.5, and §2.12.
 *
 *   node scripts/build-corpus-fixtures.mjs           write the fixtures
 *   node scripts/build-corpus-fixtures.mjs --check   fail if a committed one drifted
 *
 * Three categories share one generator because they share one packager: all three need
 * parts beyond `document.xml` — footnotes, endnotes, comments — and building three
 * packagers that must agree about content types and relationships is how one of them ends
 * up subtly wrong. `build-messy-fixtures.mjs` deliberately has a *minimal* packager because
 * §2.3 is about defects inside `document.xml`; this one is about the parts around it.
 *
 * ## Why these are authored rather than found
 *
 * CORPUS.md §1 rule 3 prefers authored fixtures because we control exactly which construct
 * is under test, and the alternative for these three categories is worse than usual:
 * a real manuscript with real footnotes is somebody's paper, and a real tracked-changes
 * document is somebody's editorial history. Neither is committable.
 *
 * ## What building these was expected to find, and did
 *
 * §2.2 exists because the DOCX adapter had never seen an equation. It turned out the
 * shipped `academic-manuscript.docx` already had five, and the adapter dropped all five
 * silently — the phrasing walk ended in `default: break` while the block walk beside it
 * obeyed adapter rule A6. Fixed before these fixtures were authored, which is the only
 * reason they measure anything: a fixture whose construct the reader discards scores the
 * same as one whose construct it handles.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatorControl } from "./lib/control.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");
const OUT = join(REPO, "fixtures/docx");

const { OpcPackage } = await import(
  pathToFileURL(join(REPO, "packages/ooxml/dist/index.js")).href
);

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const NS =
  `${W} ${M} ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const run = (text, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const para = (inner, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

const styled = (id) => `<w:pStyle w:val="${id}"/>`;

/** A text paragraph, optionally in a named style. */
const p = (text, style) => para(run(text), style ? styled(style) : "");

/**
 * An OMML display equation.
 *
 * Deliberately real OMML rather than a placeholder: CORPUS §2.2 asks for equations that
 * exercise `SPEC.md` §2.3's `equationBlock` with `notation: "omml"`, and the IEEE template
 * the corpus was modelled on has none — its equation example is the literal text
 * `a + b = c.` in a body paragraph, which is the defect rather than the construct.
 */
const omath = (body) => `<m:oMath>${body}</m:oMath>`;
const mrun = (t) => `<m:r><m:t>${esc(t)}</m:t></m:r>`;
const msub = (base, sub) => `<m:sSub><m:e>${mrun(base)}</m:e><m:sub>${mrun(sub)}</m:sub></m:sSub>`;
const mfrac = (num, den) =>
  `<m:f><m:num>${mrun(num)}</m:num><m:den>${mrun(den)}</m:den></m:f>`;

/** A footnote reference run, pointing at an id in footnotes.xml. */
const footnoteRef = (id) =>
  `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const endnoteRef = (id) =>
  `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${id}"/></w:r>`;

/** A tracked insertion or deletion wrapping runs. */
const ins = (id, author, date, inner) =>
  `<w:ins w:id="${id}" w:author="${esc(author)}" w:date="${date}">${inner}</w:ins>`;
const del = (id, author, date, text) =>
  `<w:del w:id="${id}" w:author="${esc(author)}" w:date="${date}">` +
  `<w:r><w:delText xml:space="preserve">${esc(text)}</w:delText></w:r></w:del>`;

/**
 * Marks a string as block XML rather than cell text.
 *
 * Without it `tc()` cannot tell "the words to put in this cell" from "the markup that is
 * this cell", and it guessed by `typeof`, which is the same for both. Measured: the nested
 * table in `tables-block-content.docx` was escaped into a text run and the fixture shipped
 * one table where it claimed two — caught by censusing the parsed IR rather than by
 * reading the generator, which had looked right.
 */
const blocks = (xml) => ({ xml });

/** A table cell. `span` emits w:gridSpan; `vMerge` emits "restart" or "continue". */
const tc = (content, { span, vMerge, header, width = 2400 } = {}) => {
  const props =
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (span ? `<w:gridSpan w:val="${span}"/>` : "") +
    (vMerge ? `<w:vMerge w:val="${vMerge}"/>` : "") +
    `</w:tcPr>`;
  let body =
    typeof content === "string" ? p(content, header ? "TableHeader" : undefined) : content.xml;
  // OOXML requires the last child of a `w:tc` to be a `w:p`. A cell ending in a nested
  // table is invalid without one, and Word repairs it silently on open — so a fixture
  // missing it would be a document no real producer emits, which is the opposite of what
  // a corpus is for.
  if (/<\/w:tbl>\s*$/.test(body)) body += `<w:p/>`;
  return `<w:tc>${props}${body}</w:tc>`;
};
const tr = (cells) => `<w:tr>${cells.join("")}</w:tr>`;
const tbl = (rows, cols = 4) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="Table"/></w:tblPr>` +
  `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="2400"/>`).join("")}</w:tblGrid>` +
  rows.join("") +
  `</w:tbl>`;

const SECT_PR =
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
  `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

const STYLES = `<w:styles ${W}>
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="+mn-lt"/><w:sz w:val="22"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
    <w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/>
    <w:basedOn w:val="Normal"/><w:rPr><w:i/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/>
    <w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/>
    <w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Head"/>
    <w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>
    <w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/>
    <w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="Table"><w:name w:val="Table"/></w:style>
</w:styles>`;

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Cambria"/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
  </a:fontScheme></a:themeElements></a:theme>`;

const NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

/**
 * The packager.
 *
 * Content types and relationships are derived from which optional parts are present,
 * rather than being a fixed blob with unused entries. An `Override` for a part that is not
 * in the package is the kind of thing Word tolerates and a strict reader does not, and a
 * fixture that only opens in one of them is not a fixture.
 */
function docx({ body, footnotes, endnotes, comments }) {
  const pkg = OpcPackage.create();
  const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="${CT}.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="${CT}.styles+xml"/>`,
    `<Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/>`,
    `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  const rels = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
  ];
  let next = 4;
  const optional = [
    ["footnotes", footnotes, "footnotes"],
    ["endnotes", endnotes, "endnotes"],
    ["comments", comments, "comments"],
  ];
  for (const [name, content, relName] of optional) {
    if (!content) continue;
    overrides.push(`<Override PartName="/word/${name}.xml" ContentType="${CT}.${relName}+xml"/>`);
    rels.push(
      `<Relationship Id="rId${next++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${relName}" Target="${name}.xml"/>`,
    );
    pkg.set(`word/${name}.xml`, content);
  }

  pkg.set(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      overrides.join("") +
      `</Types>`,
  );
  pkg.set(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  pkg.set(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      rels.join("") +
      `</Relationships>`,
  );
  pkg.set(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${SECT_PR}</w:body></w:document>`,
  );
  pkg.set("word/styles.xml", STYLES);
  pkg.set("word/numbering.xml", NUMBERING);
  pkg.set("word/theme/theme1.xml", THEME);
  return pkg.toBytes();
}

const fixtures = {};

// ---------------------------------------------------------------------------
// §2.2 — academic manuscripts with footnotes and equations
//
// CORPUS §2.2 catches: footnote and endnote identity, OMML equation extraction, caption
// binding, cross-references, and `Footnote Text` / `Caption` style round-tripping.
// ---------------------------------------------------------------------------

// Separator footnotes with id 0 and -1 are what Word writes and what a reader must skip;
// a fixture without them would let a reader that mistakes them for content pass.
const FOOTNOTE_SEPARATORS =
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
  `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
const ENDNOTE_SEPARATORS =
  `<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>` +
  `<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>`;

fixtures["manuscript-footnotes-equations.docx"] = docx({
  body: [
    p("Queue Depth Under Sustained Load", "Title"),
    p("1. Introduction", "Heading1"),
    para(
      run("Acknowledgement latency is bounded by the queue drain rate") +
        footnoteRef(1) +
        run(", which the scheduler samples once per interval."),
    ),
    p("2. Model", "Heading1"),
    // A display equation in its own paragraph, which is the shape a numbered equation takes.
    para(omath(msub("t", "ack") + mrun(" = ") + mfrac("d", "r"))),
    p("Equation 1. Acknowledgement time as a function of depth and drain rate.", "Caption"),
    para(
      run("Where ") +
        `<w:r><w:rPr><w:i/></w:rPr><w:t>d</w:t></w:r>` +
        run(" is queue depth and ") +
        `<w:r><w:rPr><w:i/></w:rPr><w:t>r</w:t></w:r>` +
        run(" is the drain rate.") +
        footnoteRef(2),
    ),
    p("3. Results", "Heading1"),
    para(
      run("The bound holds for all sampled intervals") +
        footnoteRef(3) +
        run(" except the first, which is warm-up."),
    ),
    // An inline equation inside a sentence, which takes a different code path from a
    // display one and is the case that the phrasing-walk A6 defect destroyed.
    para(run("Substituting gives ") + omath(mrun("r > 0")) + run(" as the only precondition.")),
  ].join(""),
  footnotes:
    `<w:footnotes ${W}>${FOOTNOTE_SEPARATORS}` +
    `<w:footnote w:id="1">${p("Measured at the sampling boundary, not at enqueue.", "FootnoteText")}</w:footnote>` +
    `<w:footnote w:id="2">${p("Drain rate is per-shard; the aggregate is the sum.", "FootnoteText")}</w:footnote>` +
    `<w:footnote w:id="3">${p("Intervals two through forty, inclusive.", "FootnoteText")}</w:footnote>` +
    `</w:footnotes>`,
});

fixtures["manuscript-endnotes-crossrefs.docx"] = docx({
  body: [
    p("Retention Policy for Sealed Records", "Title"),
    p("1. Scope", "Heading1"),
    para(run("Sealed records are retained for the statutory period") + endnoteRef(1) + run(".")),
    // A REF field, which is what a Word cross-reference actually is. Its cached result is
    // the visible text and its instruction is the thing worth recovering.
    para(
      run("See Section ") +
        `<w:fldSimple w:instr=" REF _Ref100 \\r \\h ">${run("2")}</w:fldSimple>` +
        run(" for the exception."),
    ),
    p("2. Exception", "Heading1"),
    para(run("A record under active appeal is retained until the appeal closes") + endnoteRef(2) + run(".")),
    para(omath(mrun("T") + mrun(" = max(") + mrun("T") + mrun("statutory, ") + mrun("T") + mrun("appeal)"))),
    p("Equation 2. Effective retention period.", "Caption"),
  ].join(""),
  endnotes:
    `<w:endnotes ${W}>${ENDNOTE_SEPARATORS}` +
    `<w:endnote w:id="1">${p("Seven years from the sealing date.", "EndnoteText")}</w:endnote>` +
    `<w:endnote w:id="2">${p("Appeals are tracked separately from the retention clock.", "EndnoteText")}</w:endnote>` +
    `</w:endnotes>`,
});

// ---------------------------------------------------------------------------
// §2.5 — complex tables with merged cells, the DOCX half
//
// The two HTML fixtures have existed since Phase 2 and give unambiguous span semantics as
// ground truth. These are the DOCX side of the same constructs, which is what §2.5's plan
// asked for and what makes the category more than "HTML only".
// ---------------------------------------------------------------------------

fixtures["tables-merged-horizontal.docx"] = docx({
  body: [
    p("Horizontal merges and a two-row header", "Heading1"),
    tbl([
      // Row 1: one label spanning two columns, then two ordinary header cells.
      tr([tc("Latency (ms)", { span: 2, header: true }), tc("Region", { header: true }), tc("Notes", { header: true })]),
      // Row 2: the sub-header, which is why headerRowCount must exceed GFM's single row.
      tr([tc("p50", { header: true }), tc("p95", { header: true }), tc("", { header: true }), tc("", { header: true })]),
      tr([tc("12"), tc("48"), tc("us-east"), tc("baseline")]),
      tr([tc("14"), tc("61"), tc("eu-west"), tc("cold start")]),
      // A full-width merged row, the shape a section divider inside a table takes.
      tr([tc("All regions meet the p95 budget.", { span: 4 })]),
    ]),
  ].join(""),
});

fixtures["tables-merged-vertical.docx"] = docx({
  body: [
    p("Vertical merges and a header column", "Heading1"),
    tbl(
      [
        tr([tc("Shard", { header: true }), tc("Interval", { header: true }), tc("Depth", { header: true })]),
        // vMerge restart followed by two continues: one logical cell spanning three rows.
        tr([tc("shard-a", { vMerge: "restart" }), tc("1"), tc("120")]),
        tr([tc("", { vMerge: "continue" }), tc("2"), tc("118")]),
        tr([tc("", { vMerge: "continue" }), tc("3"), tc("121")]),
        tr([tc("shard-b", { vMerge: "restart" }), tc("1"), tc("94")]),
        tr([tc("", { vMerge: "continue" }), tc("2"), tc("97")]),
      ],
      3,
    ),
  ].join(""),
});

fixtures["tables-block-content.docx"] = docx({
  body: [
    p("Cells containing block content", "Heading1"),
    // SPEC §2.7.1 widened TableCell.children to accept block content specifically because a
    // DOCX cell genuinely holds paragraphs and lists. This is the fixture that asserts it.
    tbl(
      [
        tr([tc("Step", { header: true }), tc("Detail", { header: true })]),
        tr([
          tc("Drain"),
          tc(
            blocks(
              p("Stop the intake.") +
                para(
                  run("Wait for depth to reach zero."),
                  `${styled("Normal")}<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`,
                ) +
                p("Confirm with the dashboard."),
            ),
          ),
        ]),
        tr([
          tc("Seal"),
          // A nested table inside a cell — the construct GFM cannot express at all.
          tc(
            blocks(
              tbl(
                [
                  tr([
                    tc("key", { header: true, width: 1200 }),
                    tc("value", { header: true, width: 1200 }),
                  ]),
                  tr([tc("mode", { width: 1200 }), tc("strict", { width: 1200 })]),
                ],
                2,
              ),
            ),
          ),
        ]),
      ],
      2,
    ),
  ].join(""),
});

fixtures["tables-merged-combined.docx"] = docx({
  body: [
    p("Every merge construct in one table", "Heading1"),
    tbl([
      tr([tc("Environment", { span: 2, header: true }), tc("Owner", { header: true }), tc("Status", { header: true })]),
      tr([tc("name", { header: true }), tc("tier", { header: true }), tc("", { header: true }), tc("", { header: true })]),
      tr([tc("prod", { vMerge: "restart" }), tc("gold"), tc("platform"), tc("green")]),
      tr([tc("", { vMerge: "continue" }), tc("silver"), tc("platform"), tc("green")]),
      tr([tc("staging"), tc("bronze"), tc("qa"), tc("amber")]),
      tr([tc("Reviewed quarterly.", { span: 4 })]),
    ]),
  ].join(""),
});

// ---------------------------------------------------------------------------
// §2.12 — tracked changes and comments
//
// CORPUS §2.12 catches w:ins/w:del/w:moveFrom/w:moveTo, comment anchor ranges, resolved
// versus unresolved comments, and the `revisionMode` behaviour of all three renderers.
//
// Dates are fixed strings, not `new Date()`. SPEC §1.1 forbids reading the wall clock, and
// a generator that stamped today's date would make the committed bytes drift daily and the
// staleness gate fail every morning for the wrong reason.
// ---------------------------------------------------------------------------

const D1 = "2026-01-15T09:00:00Z";
const D2 = "2026-01-16T14:30:00Z";

fixtures["tracked-changes-single-author.docx"] = docx({
  body: [
    p("Deployment Runbook", "Heading1"),
    para(
      run("Deploy with ") +
        ins(101, "R. Okonkwo", D1, run("the blue-green script")) +
        del(102, "R. Okonkwo", D1, "the legacy script") +
        run(" after the drain completes."),
    ),
    // An insertion and a deletion in separate paragraphs, so a reader that only handles
    // the interleaved case still has a simple one to get right.
    para(ins(103, "R. Okonkwo", D1, run("Roll back with the same script and the previous tag."))),
    para(del(104, "R. Okonkwo", D1, "Roll back by hand.")),
    p("Verification", "Heading2"),
    para(run("Confirm the health endpoint returns 200 before announcing.")),
  ].join(""),
});

fixtures["tracked-changes-two-authors.docx"] = docx({
  body: [
    p("Incident Review", "Heading1"),
    // Overlapping revisions from two authors in one sentence. CORPUS §2.12 names this as
    // the case where a range-based revision model corrupts and SPEC §2.3's decision to
    // make insertion/deletion *wrapping nodes* earns its keep.
    para(
      run("The outage lasted ") +
        del(201, "A. Fenwick", D1, "forty") +
        ins(202, "A. Fenwick", D1, run("fifty")) +
        run(" minutes and affected ") +
        del(203, "M. Duarte", D2, "some") +
        ins(204, "M. Duarte", D2, run("all")) +
        run(" regions."),
    ),
    // A deletion by one author inside a passage inserted by another: the nesting that a
    // flat range list cannot represent without losing one of the two authors.
    para(
      ins(
        205,
        "A. Fenwick",
        D1,
        run("Root cause was a stale credential") ,
      ) +
        ins(206, "A. Fenwick", D1, run(" in the deploy runner.")),
    ),
    para(
      run("Follow-up: ") +
        ins(207, "M. Duarte", D2, run("rotate credentials weekly")) +
        run("."),
    ),
    p("Sign-off", "Heading2"),
    para(run("Reviewed by both authors.")),
  ].join(""),
});

/*
 * §2.12's other half: comments with anchor ranges.
 *
 * `commentRangeStart`/`End` bracket the anchored text and `commentReference` marks the
 * insertion point; the bodies live in comments.xml. All three sat in the DOCX adapter's
 * property-element list until 2026-08-01, so comments were discarded as "not content" while
 * SPEC §2.3 declared a `comment` node type and §3.1 listed them under "Also extracted".
 *
 * One comment spans a multi-word range and one anchors a single word, because a reader that
 * handles only the second is easy to write and looks correct.
 */
const commentAnchor = (id, inner) =>
  `<w:commentRangeStart w:id="${id}"/>${inner}<w:commentRangeEnd w:id="${id}"/>` +
  `<w:r><w:commentReference w:id="${id}"/></w:r>`;

fixtures["comments-anchored.docx"] = docx({
  body: [
    p("Change Request", "Heading1"),
    para(
      run("The retention window is ") +
        commentAnchor(1, run("thirty days")) +
        run(" for sealed records."),
    ),
    para(
      commentAnchor(2, run("Operators may extend the window once, by written request.")),
    ),
    p("Decision", "Heading2"),
    para(run("Deferred to the next review.")),
  ].join(""),
  comments:
    `<w:comments ${W}>` +
    `<w:comment w:id="1" w:author="R. Okonkwo" w:date="${D1}" w:initials="RO">` +
    `${p("Is this the statutory minimum or our own policy?")}</w:comment>` +
    `<w:comment w:id="2" w:author="M. Duarte" w:date="${D2}" w:initials="MD">` +
    `${p("Once, or once per record? The sentence reads both ways.")}</w:comment>` +
    `</w:comments>`,
});

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
let failures = 0;

for (const [name, bytes] of Object.entries(fixtures)) {
  const path = join(OUT, name);
  if (CHECK) {
    if (!existsSync(path)) {
      console.log(`MISSING ${name}`);
      failures++;
      continue;
    }
    const committed = new Uint8Array(readFileSync(path));
    const same = committed.byteLength === bytes.byteLength && committed.every((b, i) => b === bytes[i]);
    if (!same) {
      console.log(`STALE   ${name} (${committed.byteLength} committed, ${bytes.byteLength} generated)`);
      failures++;
    } else {
      console.log(`ok      ${name}  ${bytes.byteLength} bytes`);
    }
  } else {
    writeFileSync(path, bytes);
    console.log(`wrote   fixtures/docx/${name}  (${bytes.byteLength} bytes)`);
  }
}

if (CHECK) {
  console.log("\nNegative control");
  generatorControl({
    artifacts: fixtures,
    floor: 8,
    ok: (m) => console.log(`ok      ${m}`),
    fail: (m) => {
      console.log(`FAIL    ${m}`);
      failures++;
    },
  });

  console.log(
    failures === 0
      ? `\nAll ${Object.keys(fixtures).length} corpus fixtures match their generator.`
      : `\n${failures} fixture(s) stale. Run: node scripts/build-corpus-fixtures.mjs`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
