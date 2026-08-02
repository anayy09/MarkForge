// Builds the DOCX fixtures for docs/CORPUS.md §2.3 and §2.15.
//
// These are the categories the zero-cleanup claim depends on — "a real-world messy
// PDF and a real-world messy DOCX both convert with zero manual cleanup" — and every
// other fixture in the corpus is clean and authored, so every published number was
// measured on easy input.
//
// **Authored, not sourced**, per CORPUS.md §1 rule 5. The messiest real documents are
// always someone's internal report or a publisher's template, and `fixtures/local/`
// holds three that cannot be committed. Authoring is also *better* here: a file
// containing exactly the defects below tells you which one regressed, where a found
// file tells you only that something did.
//
// **Output is committed, and CI checks it is current.** CORPUS.md §2.15 originally said
// to generate into gitignored `generated/`, which is right for 600 DPI scans and OCR
// language data. These are 3–6 KB each, and committing them means a test needs no build
// step and a fixture cannot silently change under a test. Since ZIP writing here is
// deterministic (ooxml's ZIP_EPOCH), regenerating is byte-identical, so the pair stays
// honest — the same arrangement as docs/FIDELITY.md.
//
//   node scripts/build-messy-fixtures.mjs           write the fixtures
//   node scripts/build-messy-fixtures.mjs --check   fail if committed output is stale
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatorControl } from "./lib/control.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");
const OUT = join(REPO, "fixtures/docx");
mkdirSync(OUT, { recursive: true });

const { OpcPackage } = await import(
  pathToFileURL(join(REPO, "packages/ooxml/dist/index.js")).href
);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const WR =
  `${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

// ---------------------------------------------------------------------------
// OOXML fragment helpers. Deliberately low-level: these fixtures exist to contain
// specific malformations, so a helper that produced *correct* output would defeat them.
// ---------------------------------------------------------------------------

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A run with arbitrary direct properties. `rPr` is raw XML, on purpose. */
const run = (text, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

/** A paragraph with arbitrary direct properties. */
const para = (runs, pPr = "") =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;

/** A genuinely empty paragraph — the "whitespace as structure" defect. */
const emptyPara = () => `<w:p/>`;

const styled = (styleId) => `<w:pStyle w:val="${styleId}"/>`;
const numbered = (numId, ilvl = 0) =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

const sectPr =
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
  `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

/** A styles.xml with an arbitrary style list, so a fixture can define a bad cascade. */
function stylesXml(styles, { docDefaults = true } = {}) {
  const defaults = docDefaults
    ? `<w:docDefaults><w:rPrDefault><w:rPr>` +
      `<w:rFonts w:ascii="+mn-lt" w:hAnsi="+mn-lt"/><w:sz w:val="22"/>` +
      `</w:rPr></w:rPrDefault></w:docDefaults>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${defaults}${styles}</w:styles>`;
}

const style = (id, name, { type = "paragraph", basedOn, pPr = "", rPr = "" } = {}) =>
  `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${esc(name)}"/>` +
  (basedOn ? `<w:basedOn w:val="${basedOn}"/>` : "") +
  (pPr ? `<w:pPr>${pPr}</w:pPr>` : "") +
  (rPr ? `<w:rPr>${rPr}</w:rPr>` : "") +
  `</w:style>`;

const NORMAL = style("Normal", "Normal");

const THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">` +
  `<a:themeElements><a:fontScheme name="Office">` +
  `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
  `</a:fontScheme></a:themeElements></a:theme>`;

/** Numbering with one decimal and one bullet definition, both via ListParagraph. */
const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/>` +
  `<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>` +
  `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>` +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0">` +
  `<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

/**
 * Assembles a DOCX.
 *
 * `theme: null` omits theme1.xml entirely, which is the defining trait of the §2.15
 * generated-document class and is not expressible any other way.
 */
function docx({ body, styles, theme = THEME, numbering = NUMBERING, coreProps, extra = {} }) {
  const pkg = OpcPackage.create();
  pkg.set(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
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
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
      `</Relationships>`,
  );
  pkg.set(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WR}><w:body>${body}${sectPr}</w:body></w:document>`,
  );
  pkg.set("word/styles.xml", styles);
  if (numbering !== null) pkg.set("word/numbering.xml", numbering);
  if (theme !== null) pkg.set("word/theme/theme1.xml", theme);
  if (coreProps) pkg.set("docProps/core.xml", coreProps);
  for (const [path, content] of Object.entries(extra)) pkg.set(path, content);
  return pkg.toBytes();
}

// ---------------------------------------------------------------------------
// §2.3 — badly formatted real-world documents
//
// Seven defects are named in CORPUS.md §2.3, and ten more were measured from the IEEE
// conference template and two of the owner's own files (§2.3's tables). Five documents
// each concentrate on a subset, and one combines them, so a score change names the
// defect that moved.
// ---------------------------------------------------------------------------

const fixtures = {};

// --- 1. Direct formatting instead of named styles --------------------------
// The premise of Surface B. Nothing here carries a heading style: the "headings" are
// Normal paragraphs made large and bold by hand, which is what heading inference
// (SPEC §5.1) exists to recover and what StyleEvidence.origin "directFormatting"
// signals.
fixtures["messy-direct-formatting.docx"] = docx({
  styles: stylesXml(NORMAL),
  body:
    para(run("Quarterly Review", `<w:b/><w:sz w:val="36"/>`)) +
    para(run("This paragraph is ordinary body text at the document default size. ")) +
    para(run("Executive Summary", `<w:b/><w:sz w:val="28"/>`)) +
    para(run("Performance met expectations in three of four measured areas. ")) +
    para(run("The exception is described below and is not considered a blocker. ")) +
    para(run("Detailed Findings", `<w:b/><w:sz w:val="28"/>`)) +
    para(run("Throughput rose while latency at the ninety-fifth percentile regressed. ")) +
    // A bold run mid-sentence, which must stay inline emphasis rather than being read
    // as a heading — the case that makes size-and-boldness alone insufficient.
    para(
      run("The regression correlates with the ") +
        run("mid-period migration", `<w:b/>`) +
        run(" and is tracked separately. "),
    ) +
    // All-caps as a heading substitute, at body size.
    para(run("RECOMMENDATIONS", `<w:caps/><w:b/>`)) +
    para(run("Investigate before the next migration window. ")),
});

// --- 2. Whitespace used as structure ---------------------------------------
// Empty paragraphs standing in for spacing, hard breaks standing in for paragraph
// breaks, and tabs standing in for indentation. Exercises normalisation rules 1, 2,
// and 3 (SPEC §2.8) together, which is where they interact.
fixtures["messy-whitespace-as-structure.docx"] = docx({
  styles: stylesXml(NORMAL),
  body:
    para(run("Section One")) +
    emptyPara() +
    emptyPara() +
    emptyPara() +
    para(run("Three empty paragraphs above stand in for spacing before this block. ")) +
    emptyPara() +
    // A single paragraph containing what the author meant as three paragraphs.
    para(
      run("First logical paragraph.") +
        `<w:r><w:br/></w:r>` +
        run("Second logical paragraph, separated by a hard break.") +
        `<w:r><w:br/></w:r>` +
        run("Third logical paragraph."),
    ) +
    emptyPara() +
    // Leading tabs as indentation, with no w:ind anywhere.
    para(`<w:r><w:tab/><w:t xml:space="preserve">Indented by a literal tab.</w:t></w:r>`) +
    para(
      `<w:r><w:tab/><w:tab/><w:t xml:space="preserve">Indented by two literal tabs.</w:t></w:r>`,
    ) +
    emptyPara() +
    // A paragraph of nothing but spaces, which is empty in every sense that matters.
    para(run("     ")) +
    para(run("Final block. ")),
});

// --- 3. Manual numbering typed as literal text -----------------------------
// The IEEE template's actual defect: second-order headings read "I.  Main text" as
// literal characters, with no numbering definition anywhere. A converter must preserve
// the text exactly; inventing a list from it is a decision this project has not made,
// because "1998 was a difficult year" would become a list item.
fixtures["messy-manual-numbering.docx"] = docx({
  styles: stylesXml(NORMAL),
  numbering: null,
  body:
    para(run("Procedure")) +
    para(run("1. Prepare the workspace before beginning. ")) +
    para(run("2. Verify the configuration matches the checklist. ")) +
    para(run("3. Record the result in the shared log. ")) +
    para(run("Sub-procedure")) +
    para(run("I.  Roman numerals, typed by hand. ")) +
    para(run("II.  With two spaces after the period, as the template does. ")) +
    para(run("a) Lettered items using a closing parenthesis. ")) +
    para(run("b) Which no numbering definition describes. ")) +
    // The trap: a sentence that begins with a numeral and is not a list item.
    para(run("1998 was the year the original specification was published. ")) +
    para(run("2. of the four sections were revised in the second edition. ")),
});

// --- 4. Inconsistent style cascade and heading level skips -----------------
// Measured in the IEEE template: `heading 2` is basedOn Heading1 while `heading 3` is
// basedOn Normal, so a resolver assuming a uniform heading chain gets Heading3 wrong.
// Only three heading levels are defined, and the document skips from 1 to 3 — which
// sample002.docx also does, so it is common rather than pathological.
fixtures["messy-inconsistent-cascade.docx"] = docx({
  styles: stylesXml(
    NORMAL +
      style("Heading1", "heading 1", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="0"/><w:keepNext/>`,
        rPr: `<w:b/><w:sz w:val="32"/><w:rFonts w:ascii="+mj-lt"/>`,
      }) +
      // basedOn Heading1: inherits bold and the major font.
      style("Heading2", "heading 2", {
        basedOn: "Heading1",
        pPr: `<w:outlineLvl w:val="1"/>`,
        rPr: `<w:sz w:val="28"/>`,
      }) +
      // basedOn Normal, *not* Heading1 — the quirk. It inherits neither bold nor the
      // major font, so a resolver that assumes the heading chain reports it wrong.
      style("Heading3", "heading 3", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="2"/>`,
        rPr: `<w:i/><w:sz w:val="24"/>`,
      }),
  ),
  body:
    para(run("Top Level Heading"), styled("Heading1")) +
    para(run("Body text under the first heading. ")) +
    // Skips level 2 entirely.
    para(run("Third Level, Reached Directly"), styled("Heading3")) +
    para(run("Body text under a heading two levels below its parent. ")) +
    para(run("Second Level, Out Of Order"), styled("Heading2")) +
    para(run("Body text under a heading that appears after a deeper one. ")) +
    // A heading style the document references but styles.xml does not define.
    para(run("Undefined Style Heading"), styled("Heading4")) +
    para(run("Body text under a paragraph whose style does not exist. ")),
});

// --- 5. Mixed theme and explicit fonts, inconsistent sizes ----------------
// "Uneven fonts", the complaint SPEC §4.2 names. Theme tokens, explicit families, and
// three sizes for what is logically one heading level.
fixtures["messy-mixed-fonts.docx"] = docx({
  styles: stylesXml(
    NORMAL +
      style("Heading1", "heading 1", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="0"/>`,
        rPr: `<w:b/><w:sz w:val="32"/><w:rFonts w:ascii="+mj-lt"/>`,
      }),
  ),
  body:
    // Theme token: resolves to Calibri Light via theme1.xml.
    para(run("Heading Using The Theme Font"), styled("Heading1")) +
    para(run("Body text inheriting the minor theme font. ")) +
    // Same style, direct font override.
    para(
      run("Heading Overridden To Times", `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>`),
      styled("Heading1"),
    ) +
    para(run("Body text at the default size. ")) +
    // Same logical level, three different sizes, none of them the style's.
    para(run("Heading At 20 Point", `<w:sz w:val="40"/>`), styled("Heading1")) +
    para(run("Heading At 14 Point", `<w:sz w:val="28"/>`), styled("Heading1")) +
    para(run("Heading At 11 Point", `<w:sz w:val="22"/>`), styled("Heading1")) +
    // Three fonts inside one sentence.
    para(
      run("A sentence mixing ") +
        run("Arial", `<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>`) +
        run(", ") +
        run("Courier New", `<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>`) +
        run(", and the theme default. "),
    ),
});

// --- 5b. Genuinely ambiguous headings --------------------------------------
// Built because the corpus turned out not to contain the thing the LLM path's criterion
// is measured on: running every existing fixture through
// `convert --json` produced **zero** `MF-INFER-0001` diagnostics, so "the LLM path
// improves fidelity on the ambiguous subset" had no subset to improve. The existing
// §2.3 fixtures are *badly* formatted, which turns out to be a different thing from
// *ambiguously* formatted — a 14pt bold line among 11pt body text is unambiguous, and
// the scorer says so with a margin of 0.4.
//
// Ambiguity is arithmetic, so this fixture is built to hit it rather than hoped into
// existence. `scoreHeading` gives a heading candidate bold (+0.2), short (+0.1), no
// terminal punctuation (+0.1), and `min(0.5, (ratio - 1) * 1.5)` for size; the paragraph
// candidate scores `1 - that`. A margin under `ambiguityMargin` (0.15) needs a heading
// score in (0.5, 0.575], which means a size ratio just over 1.0: **12pt bold in an 11pt
// document**, scoring 0.536 against 0.464 for a margin of 0.073.
//
// The document deliberately mixes the two answers at the same formatting, which is what
// makes it a test of judgement rather than of thresholds: "Scope" and "Method" are
// section labels, while "Note that the following applies to all three sites" is a bold
// lead-in sentence that is body text. No font-size rule can separate them, and the
// deterministic path is wrong about one of them by construction. That is precisely the
// case SPEC §5.1 reserves for the LLM.
const AMBIGUOUS_SIZE = `<w:b/><w:sz w:val="24"/>`; // 12pt bold against an 11pt default
fixtures["messy-ambiguous-headings.docx"] = docx({
  styles: stylesXml(NORMAL),
  body:
    para(run("Site Assessment", `<w:b/><w:sz w:val="36"/>`)) +
    para(run("This paragraph is ordinary body text at the document default size. ")) +
    // A real section label at the ambiguous size.
    para(run("Scope", AMBIGUOUS_SIZE)) +
    para(run("Three sites were assessed against the current standard. ")) +
    // A bold lead-in sentence at the same size, which is *not* a heading. Same evidence,
    // opposite answer.
    para(run("Note that the following applies to all three sites", AMBIGUOUS_SIZE)) +
    para(run("Access arrangements were unchanged from the previous assessment. ")) +
    para(run("Method", AMBIGUOUS_SIZE)) +
    para(run("Each site was walked with the standard checklist. ")) +
    // Two further body paragraphs, and they are load-bearing rather than filler: body size
    // is the *median* over paragraphs (`inferHeadings`), so with four 12pt lines against
    // five 11pt ones the median came out 11.5, the ratio fell to 1.043, and the heading
    // score to 0.465 — below the 0.5 that even offers a heading candidate. The first draft
    // of this fixture produced no ambiguity at all for exactly that reason. Enough 11pt
    // paragraphs to make 11 the unambiguous median is what puts the ratio at 1.091 and the
    // margin at 0.073.
    para(run("Readings were taken at the start and end of each visit. ")) +
    para(run("No site required a follow-up visit within the assessment window. ")) +
    // A question, bold and short: reads as a heading in a FAQ and as body text in prose.
    // Included because it is the case a human would also hesitate over.
    para(run("What was measured", AMBIGUOUS_SIZE)) +
    para(run("Temperature, humidity, and airflow at three fixed points per site. ")),
});

// --- 6. Everything at once -------------------------------------------------
// The combined document CORPUS.md §2.3 asks for. Its score is expected to be the
// lowest in the corpus; the point is that it is *measured* rather than avoided.
fixtures["messy-combined.docx"] = docx({
  styles: stylesXml(
    NORMAL +
      style("Heading1", "heading 1", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="0"/>`,
        rPr: `<w:b/><w:sz w:val="32"/>`,
      }) +
      style("Heading3", "heading 3", { basedOn: "Normal", pPr: `<w:outlineLvl w:val="2"/>` }) +
      style("ListParagraph", "List Paragraph", { basedOn: "Normal" }) +
      style("TableText", "Table text", { basedOn: "Normal" }),
  ),
  body:
    // Direct-formatted title, no style.
    para(run("PROJECT STATUS REPORT", `<w:b/><w:caps/><w:sz w:val="34"/>`)) +
    emptyPara() +
    emptyPara() +
    para(run("Prepared by hand, formatted by eye. ")) +
    emptyPara() +
    // Real style, then a level skip.
    para(run("Background"), styled("Heading1")) +
    para(run("The project began in the previous quarter. ")) +
    para(run("Third-level heading reached from the first"), styled("Heading3")) +
    // Manual numbering as literal text.
    para(run("1. First manually numbered item. ")) +
    para(run("2. Second manually numbered item. ")) +
    emptyPara() +
    // A real numbered list, via ListParagraph + numPr, which is how Word encodes it —
    // and the encoding behind "numbered lists become bullet lists".
    para(run("A genuinely numbered item. "), styled("ListParagraph") + numbered("1")) +
    para(run("A second genuinely numbered item. "), styled("ListParagraph") + numbered("1")) +
    para(run("A nested item. "), styled("ListParagraph") + numbered("1", 1)) +
    emptyPara() +
    // Hard breaks standing in for paragraphs.
    para(
      run("One logical paragraph.") +
        `<w:r><w:br/></w:r>` +
        run("A second, after a hard break."),
    ) +
    // A table whose cells use a custom style name, with a merged cell.
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>` +
    `<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(run("Merged header across both columns"), styled("TableText"))}</w:tc>` +
    `</w:tr>` +
    `<w:tr>` +
    `<w:tc>${para(run("Metric"), styled("TableText"))}</w:tc>` +
    `<w:tc>${para(run("Value"), styled("TableText"))}</w:tc>` +
    `</w:tr>` +
    `<w:tr>` +
    `<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${para(run("Spans two rows"), styled("TableText"))}</w:tc>` +
    `<w:tc>${para(run("first"), styled("TableText"))}</w:tc>` +
    `</w:tr>` +
    `<w:tr>` +
    `<w:tc><w:tcPr><w:vMerge/></w:tcPr>${para(run(""))}</w:tc>` +
    `<w:tc>${para(run("second"), styled("TableText"))}</w:tc>` +
    `</w:tr>` +
    `</w:tbl>` +
    emptyPara() +
    // An equation typed as text, exactly as the IEEE template does it.
    para(run("The relationship is a + b = c, numbered (1) by hand. ")) +
    // Tabs as indentation.
    para(`<w:r><w:tab/><w:t xml:space="preserve">A tab-indented closing note.</w:t></w:r>`),
});

// ---------------------------------------------------------------------------
// §2.15 — library- and LLM-generated documents
//
// The defects here are *absences* rather than misuse, which is why the category is
// separate from §2.3: a resolver tuned on overspecified files passes everything there
// and still crashes on a missing theme1.xml. Identified by inspecting a real
// machine-generated file (fixtures/local/sample001.docx).
//
// One shared source, several producers, so a difference isolates the producer rather
// than the content.
// ---------------------------------------------------------------------------

const SHARED_SOURCE = `# Generated Document Profile

This document exists in several producer variants built from this one source, so a fidelity difference between them isolates the generator rather than the content.

## Findings

1. First numbered finding.
2. Second numbered finding.

- First bulleted item.
- Second bulleted item.

| Metric     | Value |
| ---------- | ----- |
| Throughput | 1,450 |
| Latency    | 240ms |

A closing paragraph with **bold** and _italic_ text.
`;

// --- The library-generated profile ----------------------------------------
// Measured traits of sample001.docx, all present here:
//   - no theme1.xml at all, so +mn-lt has nothing to resolve against
//   - dc:creator and cp:lastModifiedBy empty
//   - dcterms:created with millisecond precision, which Word never writes
//   - a near-empty style table: Normal, two headings, ListParagraph
//   - every list item ListParagraph + numPr
//   - comments.xml, footnotes.xml, endnotes.xml declared and empty
const EMPTY_PART = (root) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${W}/>`;

fixtures["generated-no-theme.docx"] = docx({
  theme: null,
  styles: stylesXml(
    NORMAL +
      style("Heading1", "Heading 1", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="0"/>`,
        rPr: `<w:b/><w:sz w:val="32"/>`,
      }) +
      style("Heading2", "Heading 2", {
        basedOn: "Normal",
        pPr: `<w:outlineLvl w:val="1"/>`,
        rPr: `<w:b/><w:sz w:val="26"/>`,
      }) +
      style("ListParagraph", "List Paragraph", { basedOn: "Normal" }),
  ),
  coreProps:
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title></dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy>` +
    // Millisecond precision: the tell that no version of Word wrote this.
    `<dcterms:created xsi:type="dcterms:W3CDTF">2026-06-19T10:33:10.036Z</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">2026-06-19T10:33:10.063Z</dcterms:modified>` +
    `</cp:coreProperties>`,
  extra: {
    // Declared and empty, exactly as the real file has them.
    "word/comments.xml": EMPTY_PART("comments"),
    "word/footnotes.xml": EMPTY_PART("footnotes"),
    "word/endnotes.xml": EMPTY_PART("endnotes"),
  },
  body:
    para(run("Generated Document Profile"), styled("Heading1")) +
    para(
      run(
        "This document exists in several producer variants built from one source, so a " +
          "fidelity difference between them isolates the generator rather than the content. ",
      ),
    ) +
    para(run("Findings"), styled("Heading2")) +
    // Every list item is ListParagraph + numPr, the dominant real-world encoding: the
    // style name says nothing about ordered-versus-unordered.
    para(run("First numbered finding. "), styled("ListParagraph") + numbered("1")) +
    para(run("Second numbered finding. "), styled("ListParagraph") + numbered("1")) +
    para(run("First bulleted item. "), styled("ListParagraph") + numbered("2")) +
    para(run("Second bulleted item. "), styled("ListParagraph") + numbered("2")) +
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>` +
    `<w:tc>${para(run("Metric"))}</w:tc><w:tc>${para(run("Value"))}</w:tc></w:tr>` +
    `<w:tr><w:tc>${para(run("Throughput"))}</w:tc><w:tc>${para(run("1,450"))}</w:tc></w:tr>` +
    `<w:tr><w:tc>${para(run("Latency"))}</w:tc><w:tc>${para(run("240ms"))}</w:tc></w:tr>` +
    `</w:tbl>` +
    para(
      run("A closing paragraph with ") +
        run("bold", `<w:b/>`) +
        run(" and ") +
        run("italic", `<w:i/>`) +
        run(" text. "),
    ),
});

// --- The heavy-direct-formatting generated profile ------------------------
// sample002.docx measured 261 w:rPr blocks across 45 paragraphs — 5.8 per paragraph —
// with only three styles used and a 1 -> 3 heading skip. Generators that emit a run per
// formatting change produce this, and it is the opposite failure from the file above:
// not too little information, too much of the wrong kind.
fixtures["generated-run-per-word.docx"] = docx({
  theme: null,
  styles: stylesXml(
    NORMAL +
      style("Heading1", "Heading 1", { basedOn: "Normal", pPr: `<w:outlineLvl w:val="0"/>`, rPr: `<w:b/><w:sz w:val="32"/>` }) +
      style("Heading3", "Heading 3", { basedOn: "Normal", pPr: `<w:outlineLvl w:val="2"/>`, rPr: `<w:b/><w:sz w:val="24"/>` }) +
      style("ListParagraph", "List Paragraph", { basedOn: "Normal" }),
  ),
  body:
    para(run("Peer Review Notes"), styled("Heading1")) +
    // One run per word, each carrying identical properties. A reader that does not merge
    // adjacent identical runs produces one text node per word.
    para(
      "This sentence is emitted as one run per word."
        .split(" ")
        .map((w, i) => run(i === 0 ? w : ` ${w}`, `<w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/>`))
        .join(""),
    ) +
    // Level skip 1 -> 3, as measured.
    para(run("Detailed Comments"), styled("Heading3")) +
    para(
      "Formatting changes mid word like this one are common in generated files."
        .split(" ")
        .map((w, i) =>
          run(i === 0 ? w : ` ${w}`, i % 3 === 0 ? `<w:b/><w:sz w:val="22"/>` : `<w:sz w:val="22"/>`),
        )
        .join(""),
    ) +
    para(run("Point one. "), styled("ListParagraph") + numbered("1")) +
    para(run("Point two. "), styled("ListParagraph") + numbered("1")),
});

// ---------------------------------------------------------------------------
// Write, or check that what is committed matches.
// ---------------------------------------------------------------------------

let stale = 0;
let written = 0;

for (const [name, bytes] of Object.entries(fixtures)) {
  const path = join(OUT, name);
  if (CHECK) {
    if (!existsSync(path)) {
      console.log(`MISSING ${name}`);
      stale++;
      continue;
    }
    const committed = new Uint8Array(readFileSync(path));
    const same =
      committed.byteLength === bytes.byteLength && committed.every((b, i) => b === bytes[i]);
    if (!same) {
      console.log(`STALE   ${name} (${committed.byteLength} bytes committed, ${bytes.byteLength} generated)`);
      stale++;
    }
  } else {
    writeFileSync(path, bytes);
    written++;
    console.log(`wrote   fixtures/docx/${name}  (${bytes.byteLength} bytes)`);
  }
}

// --- The Pandoc-produced variant, for §2.15's producer comparison ----------
// Written only when pandoc is present, and *not* committed: it is Pandoc's output, not
// ours, and pinning a competitor's bytes into our corpus would make a Pandoc upgrade
// look like our regression. The shared Markdown source is committed instead, so the
// variant is reproducible by anyone with pandoc.
const sourcePath = join(REPO, "fixtures/md/generated-profile-source.md");
if (CHECK) {
  // Checked like the DOCX fixtures. Leaving it out meant the one committed file the
  // generator writes in a *text* format could drift silently, and it did: it was
  // committed unformatted and broke the `fmt` fixed-point gate in CI.
  const current = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
  if (current !== SHARED_SOURCE) {
    console.log("STALE fixtures/md/generated-profile-source.md");
    stale += 1;
  } else {
    console.log("ok    fixtures/md/generated-profile-source.md");
  }
} else {
  writeFileSync(sourcePath, SHARED_SOURCE, "utf8");
}

if (CHECK) {
  // Negative control, added in the Phase 6 gate audit which found this gate could not
  // demonstrate a failure. `stale === 0` is also what an empty generator reports.
  console.log("\nNegative control");
  generatorControl({
    artifacts: { ...fixtures, "generated-profile-source.md": SHARED_SOURCE },
    floor: 8,
    ok: (m) => console.log(`ok    ${m}`),
    fail: (m) => {
      console.log(`FAIL  ${m}`);
      stale++;
    },
  });

  console.log(
    stale === 0
      ? `\nAll ${Object.keys(fixtures).length} messy fixtures match their generator.`
      : `\n${stale} fixture(s) stale. Run: node scripts/build-messy-fixtures.mjs`,
  );
  process.exit(stale === 0 ? 0 : 1);
}

// Same candidate list as `run-scoreboard.mjs`. The previous probe checked only a
// hard-coded Windows install path, so it could succeed on one machine and reported
// "pandoc absent" everywhere else, including CI.
const PANDOC_CANDIDATES = [
  "pandoc",
  join(process.env["LOCALAPPDATA"] ?? "", "Pandoc", "pandoc.exe"),
  "C:/Program Files/Pandoc/pandoc.exe",
  "/usr/bin/pandoc",
  "/usr/local/bin/pandoc",
];
const pandocProbe = PANDOC_CANDIDATES.map((c) =>
  spawnSync(c, ["--version"], { encoding: "utf8" }),
).find((r) => r.status === 0) ?? { status: 1 };
console.log(
  pandocProbe.status === 0
    ? "\nnote  a Pandoc variant can be produced from fixtures/md/generated-profile-source.md;\n" +
        "      it is deliberately not committed, so a Pandoc upgrade cannot look like our regression."
    : "\nnote  pandoc absent; the Pandoc producer variant was skipped.",
);
console.log(`\nWrote ${written} fixture(s) to fixtures/docx/ plus the shared Markdown source.`);
