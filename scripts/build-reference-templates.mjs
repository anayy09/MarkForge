// Builds the three reference DOCX templates `TEMPLATES.md` §2 promises.
//
//   node scripts/build-reference-templates.mjs           write them
//   node scripts/build-reference-templates.mjs --check   fail if a committed one drifted
//
// The oldest unbuilt named deliverable in the repository: `TEMPLATES.md` specified these row
// row by row from the start and there was no `templates/` directory at all until now.
// `STATUS.md` carried "not done" for a long time.
//
// **They are written as raw OOXML rather than through `@markforge/render-docx`, and that is
// the point rather than a shortcut.** The renderer cannot produce most of what §2.1 requires:
// it does not embed images, does not write `footnotes.xml`, does not emit OMML, and does not
// resolve cross-references — all four are open gaps in `STATUS.md`. A template built by the
// renderer would therefore be a template of exactly the constructs we already handle, which
// is the opposite of a gate. Authoring the OOXML by hand means the template can demand more
// than the writer currently gives, and the round trip measures the difference.
//
// Enforces **ADR-0004**: the DOCX renderer maps to named styles and never writes direct
// font properties (`docx.namedStylesOnly`). The zero-direct-formatting assertion below is
// that decision made falsifiable on a real document.
// **Zero direct formatting is the load-bearing property** (§2.1's last row). Everything is a
// named style; the only `w:rPr` in the body is genuine inline semantics — `w:i` on a Latin
// abbreviation, `w:vertAlign` on a footnote reference, and the `Verbatim Char` character
// style. That is asserted below rather than left to care, because a shipped template with
// direct formatting would undercut the argument SPEC §4.2 exists to make.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");
const OUT = join(REPO, "templates");
mkdirSync(OUT, { recursive: true });

const { OpcPackage } = await import(pathToFileURL(join(REPO, "packages/ooxml/dist/index.js")).href);
const { ALL_PANDOC_STYLE_NAMES } = await import(
  pathToFileURL(join(REPO, "packages/render-docx/dist/index.js")).href
);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS =
  `${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A 64x40 checkerboard PNG, embedded as a literal.
//
// Not generated at build time on purpose: `zlib.deflateSync` output depends on the zlib
// version, so a generated image would make `--check` fail on a machine with a different
// Node build — a fixture that drifts for a reason unrelated to the fixture.
const FIGURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAATElEQVR42u3RsQkAMAgAQUfNECkcwipjOKVb" +
    "BIRrvn64yOpz397G6vusDgIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBD42gGTvWTi/b8rfgAAAABJ" +
    "RU5ErkJggg==",
  "base64",
);

// ---------------------------------------------------------------------------
// Fragment helpers. Every one of these emits a *named style*; none takes direct
// formatting, which is how §2.1's last row is enforced at the source rather than checked
// after the fact.
// ---------------------------------------------------------------------------

/** styleId from a display name: Word's own convention — strip spaces. */
const idOf = (name) => name.replace(/[^A-Za-z0-9]/g, "");

const t = (s) => `<w:t xml:space="preserve">${esc(s)}</w:t>`;
const run = (s) => `<w:r>${t(s)}</w:r>`;
/** The three character styles that are genuine inline semantics, not decoration. */
const charRun = (s, style) => `<w:r><w:rPr><w:rStyle w:val="${idOf(style)}"/></w:rPr>${t(s)}</w:r>`;
const italicRun = (s) => `<w:r><w:rPr><w:i/></w:rPr>${t(s)}</w:r>`;

// Call sites name styles the way `TEMPLATES.md` does — "Source Code", "Block Text" — and
// `idOf` converts to the styleId Word actually resolves. Doing it here rather than at every
// call site is not only tidier: passing a display name straight into `w:pStyle` produces a
// reference to a style that does not exist, Word silently falls back to Normal, and the
// document still opens. Four constructs were quietly unstyled before this line existed.
const p = (inner, style, extraPPr = "") =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${idOf(style)}"/>` : ""}${extraPPr}</w:pPr>${inner}</w:p>`;
const sp = (text, styleId) => p(run(text), styleId);

const listItem = (text, numId, ilvl) =>
  p(run(text), "Compact", `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

let bookmarkId = 0;
const bookmark = (name, inner) => {
  const id = bookmarkId++;
  return `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${inner}<w:bookmarkEnd w:id="${id}"/>`;
};
/** A REF field: a real cross-reference, not a link with the text baked in. */
const ref = (name) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> REF ${name} \\h </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
  `<w:r>${t("[ref]")}</w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const footnoteRef = (id) =>
  `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;

/** Display equation: real OMML in an `m:oMathPara`, right-numbered via a tab. */
const displayEquation = (omml, number, name) =>
  p(
    bookmark(name, `<m:oMath>${omml}</m:oMath>`) + `<w:r><w:tab/></w:r>` + run(`(${number})`),
    "Body Text",
    `<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>`,
  );
const inlineEquation = (omml) => `<m:oMath>${omml}</m:oMath>`;

const mr = (s) => `<m:r><m:t>${esc(s)}</m:t></m:r>`;
const frac = (num, den) =>
  `<m:f><m:num>${num}</m:num><m:den>${den}</m:den></m:f>`;
const sub = (base, s) => `<m:sSub><m:e>${base}</m:e><m:sub>${s}</m:sub></m:sSub>`;
const sup = (base, s) => `<m:sSup><m:e>${base}</m:e><m:sup>${s}</m:sup></m:sSup>`;

const drawing = (relId, name, cx, cy) =>
  `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
  `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${relId.slice(3)}" name="${esc(name)}" descr="${esc(name)}"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
  `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const cell = (inner, { span, width = 2340, header = false } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ""}` +
  `</w:tcPr>${inner}</w:tc>`;
const row = (cells, header = false) =>
  `<w:tr>${header ? `<w:trPr><w:tblHeader/></w:trPr>` : ""}${cells}</w:tr>`;
const table = (rows, cols) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="Table"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
  `<w:tblGrid>${'<w:gridCol w:w="2340"/>'.repeat(cols)}</w:tblGrid>${rows}</w:tbl>`;

// ---------------------------------------------------------------------------
// styles.xml — all 38 Pandoc names, in every template.
//
// Built from `ALL_PANDOC_STYLE_NAMES` rather than from a hand-kept list, so a name added to
// the renderer's vocabulary makes these templates incomplete at build time instead of at
// `check --reference-doc` time in someone else's repository.
// ---------------------------------------------------------------------------

/** Per-style formatting. Anything absent inherits, which is the point of a style chain. */
const STYLE_SHAPE = {
  Normal: { pPr: `<w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:jc w:val="both"/>` },
  "Body Text": { basedOn: "Normal" },
  "First Paragraph": { basedOn: "BodyText", pPr: `<w:ind w:firstLine="0"/>` },
  Compact: { basedOn: "Normal", pPr: `<w:spacing w:after="0"/>` },
  Title: { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:after="60"/>`, rPr: `<w:sz w:val="48"/><w:b/>` },
  Subtitle: { basedOn: "Normal", pPr: `<w:jc w:val="center"/>`, rPr: `<w:sz w:val="28"/><w:i/>` },
  Author: { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:after="0"/>`, rPr: `<w:sz w:val="24"/>` },
  Date: { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:after="240"/>`, rPr: `<w:sz w:val="20"/>` },
  AbstractTitle: { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:before="120"/>`, rPr: `<w:b/>` },
  Abstract: { basedOn: "Normal", pPr: `<w:ind w:left="720" w:right="720"/>`, rPr: `<w:sz w:val="18"/>` },
  "Block Text": { basedOn: "Normal", pPr: `<w:ind w:left="720" w:right="720"/><w:spacing w:before="120" w:after="120"/>`, rPr: `<w:i/>` },
  Bibliography: { basedOn: "Normal", pPr: `<w:ind w:left="360" w:hanging="360"/><w:spacing w:after="60"/><w:jc w:val="left"/>` },
  Caption: { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:before="60" w:after="120"/>`, rPr: `<w:sz w:val="18"/>` },
  "Image Caption": { basedOn: "Caption" },
  "Table Caption": { basedOn: "Caption", pPr: `<w:spacing w:before="120" w:after="60"/>` },
  "Captioned Figure": { basedOn: "Normal", pPr: `<w:jc w:val="center"/><w:spacing w:before="120" w:after="0"/>` },
  Figure: { basedOn: "CaptionedFigure" },
  "Source Code": {
    basedOn: "Normal",
    pPr: `<w:spacing w:after="0"/><w:jc w:val="left"/><w:shd w:val="clear" w:fill="F5F5F5"/>`,
    rPr: `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>`,
  },
  "Definition Term": { basedOn: "Normal", pPr: `<w:spacing w:after="0"/><w:keepNext/>`, rPr: `<w:b/>` },
  Definition: { basedOn: "Normal", pPr: `<w:ind w:left="720"/>` },
  "Footnote Text": { basedOn: "Normal", pPr: `<w:spacing w:after="0"/><w:jc w:val="left"/>`, rPr: `<w:sz w:val="16"/>` },
  "Footnote Block Text": { basedOn: "FootnoteText", pPr: `<w:ind w:left="360"/>` },
  "TOC Heading": { basedOn: "Heading1", pPr: `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>` },
  "Section Number": { type: "character", rPr: `<w:b/>` },
  "Footnote Reference": { type: "character", rPr: `<w:vertAlign w:val="superscript"/>` },
  "Verbatim Char": { type: "character", rPr: `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>` },
  Hyperlink: { type: "character", rPr: `<w:color w:val="0563C1"/><w:u w:val="single"/>` },
  "Default Paragraph Font": { type: "character", isDefault: true },
  Table: { type: "table" },
};

for (let level = 1; level <= 9; level++) {
  STYLE_SHAPE[`Heading ${level}`] = {
    basedOn: "Normal",
    pPr:
      `<w:keepNext/><w:spacing w:before="${Math.max(120, 300 - level * 20)}" w:after="80"/>` +
      `<w:jc w:val="left"/>` +
      // Headings 1-6 are auto-numbered from one multilevel definition, which is what §2.1
      // means by "multi-level auto-numbered" — the numbers are not typed into the text.
      (level <= 6 ? `<w:numPr><w:ilvl w:val="${level - 1}"/><w:numId w:val="1"/></w:numPr>` : ""),
    rPr: `<w:b/><w:sz w:val="${Math.max(20, 34 - level * 2)}"/>`,
    outline: level - 1,
  };
}

function stylesXml() {
  const parts = ALL_PANDOC_STYLE_NAMES.map((name) => {
    const shape = STYLE_SHAPE[name] ?? { basedOn: "Normal" };
    const type = shape.type ?? "paragraph";
    const id = idOf(name);
    const attrs =
      `w:type="${type}" w:styleId="${id}"` +
      (name === "Normal" || shape.isDefault ? ` w:default="1"` : "");
    const pPr = shape.pPr || shape.outline !== undefined
      ? `<w:pPr>${shape.outline !== undefined ? `<w:outlineLvl w:val="${shape.outline}"/>` : ""}${shape.pPr ?? ""}</w:pPr>`
      : "";
    const tblPr =
      type === "table"
        ? `<w:tblPr><w:tblBorders>` +
          ["top", "left", "bottom", "right", "insideH", "insideV"]
            .map((e) => `<w:${e} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
            .join("") +
          `</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>` +
          `<w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`
        : "";
    return (
      `<w:style ${attrs}><w:name w:val="${esc(name)}"/>` +
      (shape.basedOn && name !== "Normal" ? `<w:basedOn w:val="${shape.basedOn}"/>` : "") +
      (type === "paragraph" && name !== "Normal" ? `<w:qFormat/>` : "") +
      pPr +
      (shape.rPr ? `<w:rPr>${shape.rPr}</w:rPr>` : "") +
      tblPr +
      `</w:style>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>` +
    `<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/>` +
    `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    parts.join("") +
    `</w:styles>`
  );
}

// Multilevel heading numbering (numId 1), plus an ordered list that restarts via
// `w:startOverride` (numId 3 restarts numId 2's abstract definition) and a bullet list.
const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>` +
  `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>` +
  [...Array(6)].map((_, i) => {
    const fmt = i === 0 ? "upperRoman" : i === 1 ? "upperLetter" : "decimal";
    const text = i === 0 ? "%1." : i === 1 ? "%2." : `${[...Array(i + 1)].map((_, k) => `%${k + 1}`).join(".")}.`;
    return (
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
      `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${360 * (i + 1)}" w:hanging="360"/></w:pPr>` +
      `<w:rPr><w:rStyle w:val="SectionNumber"/></w:rPr></w:lvl>`
    );
  }).join("") +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [...Array(3)].map((_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/>` +
    `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
  ).join("") +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [...Array(3)].map((_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${["•", "◦", "▪"][i]}"/>` +
    `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (i + 1)}" w:hanging="360"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl>`,
  ).join("") +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `<w:num w:numId="3"><w:abstractNumId w:val="1"/>` +
  // The restart §2.1 requires: same abstract definition, numbering forced back to 1.
  `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>` +
  `<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>` +
  `</w:numbering>`;

const THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MarkForge">` +
  `<a:themeElements><a:clrScheme name="MarkForge">` +
  ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
    .map((s, i) => `<a:${s}><a:srgbClr val="${i === 0 ? "000000" : i === 1 ? "FFFFFF" : "44546A"}"/></a:${s}>`)
    .join("") +
  `</a:clrScheme>` +
  `<a:fontScheme name="MarkForge"><a:majorFont><a:latin typeface="Times New Roman"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Times New Roman"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="MarkForge"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
  `<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
  `</a:fmtScheme></a:themeElements></a:theme>`;

// ---------------------------------------------------------------------------
// Bodies.
// ---------------------------------------------------------------------------

/** Footnote parts: two mandatory separators plus the real notes, ids from 2. */
function footnotesXml(notes) {
  const sep =
    `<w:footnote w:type="separator" w:id="0"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
    `<w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
    `<w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
  const body = notes
    .map(
      (text, i) =>
        `<w:footnote w:id="${i + 2}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
        `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>` +
        `${t(" " + text)}</w:p></w:footnote>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${NS}>${sep}${body}</w:footnotes>`;
}

const headerXml = (text) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>` +
  p(run(text), "Compact", `<w:jc w:val="center"/>`) +
  `</w:hdr>`;
const footerXml = () =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>` +
  p(
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${t("1")}</w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
    "Compact",
    `<w:jc w:val="center"/>`,
  ) +
  `</w:ftr>`;

const SECT_PR =
  `<w:sectPr>` +
  `<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>` +
  `<w:pgSz w:w="12240" w:h="15840"/>` +
  `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
  `</w:sectPr>`;

/** §2.1's inventory, as a document. Every row of that table appears here. */
function academicBody() {
  return [
    sp("A Reference Manuscript for Style-Driven Conversion", "Title"),
    sp("Demonstrating that named styles are sufficient", "Subtitle"),
    sp("A. Author and B. Coauthor", "Author"),
    sp("2026-07-31", "Date"),

    sp("Abstract", "AbstractTitle"),
    p(
      run("This template exists to be converted, not read. It carries every construct ") +
        run("MarkForge's DOCX round trip is measured against, expressed entirely through named ") +
        run("styles so that a conversion needs no style map. Direct character formatting is ") +
        run("absent by construction and asserted by test."),
      "Abstract",
    ),
    p(italicRun("Index terms") + run("—document conversion, OOXML, named styles, fidelity."), "Abstract"),

    bookmark("sec_intro", sp("Introduction", "Heading 1")),
    p(
      run("A template is a claim about what a converter can preserve. This one is authored ") +
        run("rather than borrowed, so it can be redistributed under Apache-2.0 without the ") +
        run("licensing question a publisher template raises.") +
        footnoteRef(2),
      "First Paragraph",
    ),
    p(
      run("Section ") + ref("sec_results") + run(" reports what survives a round trip. The ") +
        run("inline code span ") + charRun("renderDocx", "VerbatimChar") +
        run(" is a character style, not a font change."),
      "Body Text",
    ),

    sp("Background", "Heading 2"),
    p(run("Prior tools flatten structure into direct formatting. That is the failure this ") + run("project exists to avoid."), "Body Text"),
    p(
      run("Named styles carry intent; direct formatting carries appearance. Only the first ") +
        run("survives a conversion, because only the first says what the author meant."),
      "Block Text",
    ),

    sp("Method", "Heading 3"),
    p(run("The acknowledgement latency ") + inlineEquation(sub(mr("t"), mr("ack"))) + run(" is bounded by the queue depth ") + inlineEquation(mr("q")) + run(", giving the relation below."), "Body Text"),
    displayEquation(frac(mr("q"), sub(mr("r"), mr("in"))) + mr(" ≤ ") + sub(mr("t"), mr("max")), 1, "eq_bound"),
    p(run("Equation ") + ref("eq_bound") + run(" holds while the ingest rate is positive."), "Body Text"),
    displayEquation(sup(mr("σ"), mr("2")) + mr(" = ") + frac(mr("1"), mr("n")) + mr("∑") + sup(mr("(xᵢ − μ)"), mr("2")), 2, "eq_var"),
    displayEquation(mr("E[T] = ") + frac(mr("1"), mr("μ − λ")), 3, "eq_wait"),

    sp("Procedure", "Heading 4"),
    listItem("Register a schema before the first submission.", 2, 0),
    listItem("Submit a batch and record the acknowledgement time.", 2, 1),
    listItem("Confirm the warehouse commit before releasing the batch.", 2, 2),
    p(run("The measurement restarts for each cohort:"), "Body Text"),
    listItem("Warm the queue for sixty seconds.", 3, 0),
    listItem("Sample one hundred submissions.", 3, 1),
    listItem("Discard the first decile.", 4, 0),
    listItem("Report the p95.", 4, 1),

    sp("Instrumentation", "Heading 5"),
    p(run("Counters are read through the health endpoint.") + footnoteRef(3), "Body Text"),
    sp("const depth = await queue.depth();", "Source Code"),
    sp("if (depth > MAX_DEPTH) throw new Error(\"queue saturated\");", "Source Code"),

    sp("Terminology", "Heading 6"),
    sp("Batch", "Definition Term"),
    sp("One customer submission, validated and committed as a unit.", "Definition"),

    bookmark("sec_results", sp("Results", "Heading 1")),
    sp("Table 1. Acknowledgement latency by cohort.", "Table Caption"),
    bookmark(
      "tbl_latency",
      table(
        row(cell(p(run("Latency (ms)"), "Compact"), { span: 3, width: 7020 }), true) +
          row(cell(p(run("Cohort"), "Compact")) + cell(p(run("p50"), "Compact")) + cell(p(run("p95"), "Compact")), true) +
          row(cell(p(run("A"), "Compact")) + cell(p(run("310"), "Compact")) + cell(p(run("1840"), "Compact"))) +
          row(cell(p(run("B"), "Compact")) + cell(p(run("290"), "Compact")) + cell(p(run("1960"), "Compact"))),
        3,
      ),
    ),
    p(run("Table ") + ref("tbl_latency") + run(" shows both cohorts inside the two-second budget."), "Body Text"),

    sp("Table 2. Constructs exercised by this template.", "Table Caption"),
    table(
      row(cell(p(run("Construct"), "Compact")) + cell(p(run("Count"), "Compact")), true) +
        row(cell(p(run("Display equations"), "Compact")) + cell(p(run("3"), "Compact"))) +
        row(cell(p(run("Footnotes"), "Compact")) + cell(p(run("3"), "Compact"))),
      2,
    ),

    p(drawing("rId10", "Ingest pipeline", 2286000, 1428750), "Captioned Figure"),
    bookmark("fig_pipeline", sp("Figure 1. The ingest pipeline, end to end.", "Image Caption")),
    p(run("Figure ") + ref("fig_pipeline") + run(" is referenced from the body, so the cross-reference has a target."), "Body Text"),

    p(drawing("rId11", "Latency distribution", 5486400, 3429000), "Captioned Figure"),
    sp("Figure 2. Latency distribution across both cohorts, full width.", "Image Caption"),

    sp("Discussion", "Heading 2"),
    p(
      run("The result matches ") + ref("bib_kirk") + run(" and extends ") + ref("bib_nguyen") +
        run(". A remaining threat to validity is cohort selection.") + footnoteRef(4),
      "Body Text",
    ),

    sp("References", "TOC Heading"),
    bookmark("bib_kirk", sp("[1] Kirk, A. Queueing Behaviour of Ingest Pipelines. Journal of Systems, 2024.", "Bibliography")),
    bookmark("bib_nguyen", sp("[2] Nguyen, T. Atomic Batch Commit. Proceedings of DataOps, 2025.", "Bibliography")),
    sp("[3] Okafor, C. Style-Driven Document Conversion. TechRep 118, 2025.", "Bibliography"),
    sp("[4] Petrova, L. Provenance in Generated Documents. Systems Review, 2026.", "Bibliography"),
    sp("[5] Silva, M. On Reference Templates. Document Engineering, 2026.", "Bibliography"),
  ].join("");
}

function technicalBody() {
  return [
    sp("Nimbus Platform — Technical Documentation", "Title"),
    sp("API reference and operating notes", "Subtitle"),
    sp("Platform Team", "Author"),
    sp("2026-07-31", "Date"),

    bookmark("sec_overview", sp("Overview", "Heading 1")),
    p(run("Nimbus accepts telemetry batches and normalises them for the warehouse. This ") + run("document is the reference for the public surface."), "First Paragraph"),
    sp("Endpoints", "Heading 2"),
    sp("Table 1. Public endpoints.", "Table Caption"),
    table(
      row(cell(p(run("Method"), "Compact")) + cell(p(run("Path"), "Compact")) + cell(p(run("Purpose"), "Compact")), true) +
        row(cell(p(run("POST"), "Compact")) + cell(p(charRun("/v1/batches", "VerbatimChar"), "Compact")) + cell(p(run("Submit a batch"), "Compact"))) +
        row(cell(p(run("GET"), "Compact")) + cell(p(charRun("/v1/batches/{id}", "VerbatimChar"), "Compact")) + cell(p(run("Retrieve status"), "Compact"))),
      3,
    ),
    sp("Authentication", "Heading 3"),
    p(run("Every request carries a bearer token.") + footnoteRef(2), "Body Text"),
    sp("curl -H \"Authorization: Bearer $TOKEN\" https://ingest.internal/v1/batches", "Source Code"),
    sp("Error codes", "Heading 4"),
    listItem("422 — the batch failed validation and was rejected whole.", 2, 0),
    listItem("409 — the batch id was already accepted.", 2, 1),
    sp("Glossary", "Heading 5"),
    sp("Rejection", "Definition Term"),
    sp("A batch that failed validation and was not committed.", "Definition"),
    sp("Notes", "Heading 6"),
    p(run("Retention is thirty days; see ") + ref("sec_overview") + run("."), "Body Text"),
    p(run("Treat every limit here as a contract, not a default."), "Block Text"),
    p(drawing("rId10", "Request lifecycle", 2286000, 1428750), "Captioned Figure"),
    sp("Figure 1. Request lifecycle.", "Image Caption"),
    sp("References", "TOC Heading"),
    sp("[1] Nimbus API Contract, internal, 2026.", "Bibliography"),
  ].join("");
}

function reportBody() {
  return [
    sp("Quarterly Ingest Review", "Title"),
    sp("Q2 2026", "Subtitle"),
    sp("Platform Team", "Author"),
    sp("2026-07-31", "Date"),
    bookmark("sec_summary", sp("Summary", "Heading 1")),
    p(run("Ingest volume rose 24 percent while p95 acknowledgement latency fell."), "First Paragraph"),
    sp("Findings", "Heading 2"),
    listItem("Latency stayed inside the two-second budget in both cohorts.", 2, 0),
    listItem("One incident in March traced to a long-running batch.", 2, 1),
    sp("Detail", "Heading 3"),
    sp("Table 1. Quarterly figures.", "Table Caption"),
    table(
      row(cell(p(run("Metric"), "Compact")) + cell(p(run("Q1"), "Compact")) + cell(p(run("Q2"), "Compact")), true) +
        row(cell(p(run("Batches"), "Compact")) + cell(p(run("1.2M"), "Compact")) + cell(p(run("1.5M"), "Compact"))) +
        row(cell(p(run("p95 (ms)"), "Compact")) + cell(p(run("1980"), "Compact")) + cell(p(run("1840"), "Compact"))),
      3,
    ),
    sp("Recommendation", "Heading 4"),
    p(run("Hold the current timeout.") + footnoteRef(2), "Body Text"),
    p(run("The March incident is the only argument for changing it, and it had another cause."), "Block Text"),
    sp("Risks", "Heading 5"),
    sp("Cohort drift", "Definition Term"),
    sp("Customer mix changes faster than the sampling window.", "Definition"),
    sp("Appendix", "Heading 6"),
    sp("nimbusctl report --quarter 2026Q2", "Source Code"),
    p(run("See ") + ref("sec_summary") + run(" for the headline figures."), "Body Text"),
    sp("References", "TOC Heading"),
    sp("[1] Nimbus Operations Review, internal, 2026.", "Bibliography"),
  ].join("");
}

// ---------------------------------------------------------------------------
// Packaging.
// ---------------------------------------------------------------------------

function buildDocx({ body, footnotes, headerText, figures }) {
  const pkg = OpcPackage.create();
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
    `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`,
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`,
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`,
    `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
  ];
  pkg.set(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      overrides.join("") +
      `</Types>`,
  );
  pkg.set(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `</Relationships>`,
  );
  const rel = (id, type, target) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  pkg.set(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      rel("rId1", "styles", "styles.xml") +
      rel("rId2", "numbering", "numbering.xml") +
      rel("rId3", "footnotes", "footnotes.xml") +
      rel("rId4", "theme", "theme/theme1.xml") +
      rel("rIdHdr", "header", "header1.xml") +
      rel("rIdFtr", "footer", "footer1.xml") +
      figures.map((f, i) => rel(`rId1${i}`, "image", `media/${f}`)).join("") +
      `</Relationships>`,
  );
  pkg.set(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${SECT_PR}</w:body></w:document>`,
  );
  pkg.set("word/styles.xml", stylesXml());
  pkg.set("word/numbering.xml", NUMBERING);
  pkg.set("word/footnotes.xml", footnotesXml(footnotes));
  pkg.set("word/header1.xml", headerXml(headerText));
  pkg.set("word/footer1.xml", footerXml());
  pkg.set("word/theme/theme1.xml", THEME);
  pkg.set(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>MarkForge reference template</dc:title><dc:creator>MarkForge</dc:creator>` +
      // No wall clock: these are committed, and a timestamp would rewrite them on every run.
      `<dcterms:created xsi:type="dcterms:W3CDTF">2026-07-31T00:00:00Z</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-31T00:00:00Z</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
  for (const f of figures) pkg.set(`word/media/${f}`, FIGURE_PNG);
  return pkg.toBytes();
}

const TEMPLATES = {
  "academic-manuscript.docx": {
    body: academicBody(),
    headerText: "A Reference Manuscript for Style-Driven Conversion",
    footnotes: [
      "Authored templates avoid the redistribution question entirely; see docs/TEMPLATES.md §1.",
      "The endpoint reports queue depth, worker count, and the warehouse commit lag.",
      "Cohorts were assigned by submission time rather than at random.",
    ],
    figures: ["figure1.png", "figure2.png"],
  },
  "technical-documentation.docx": {
    body: technicalBody(),
    headerText: "Nimbus Platform — Technical Documentation",
    footnotes: ["Tokens are issued per customer and are never shared between environments."],
    figures: ["figure1.png"],
  },
  "clean-report.docx": {
    body: reportBody(),
    headerText: "Quarterly Ingest Review — Q2 2026",
    footnotes: ["The March incident is documented in the operations log."],
    figures: [],
  },
};

let failures = 0;
const built = {};
for (const [name, spec] of Object.entries(TEMPLATES)) {
  const bytes = Buffer.from(buildDocx(spec));
  built[name] = bytes;
  const path = join(OUT, name);
  if (CHECK) {
    if (!existsSync(path)) {
      console.log(`FAIL  ${name} is missing`);
      failures++;
    } else if (!readFileSync(path).equals(bytes)) {
      console.log(`FAIL  ${name} does not match its generator — rerun and commit`);
      failures++;
    } else console.log(`ok    ${name}  ${bytes.length} bytes`);
  } else {
    writeFileSync(path, bytes);
    console.log(`wrote ${name}  ${bytes.length} bytes`);
  }
}

// ---------------------------------------------------------------------------
// The template has to earn its own claims. TEMPLATES.md §2.1 is a list of promises;
// these are the ones checkable without a conversion.
// ---------------------------------------------------------------------------

console.log("\nTEMPLATES.md §2.1 inventory:");
const { readAvailableStyles, reportCoverage } = await import(
  pathToFileURL(join(REPO, "packages/render-docx/dist/index.js")).href
);

for (const [name, bytes] of Object.entries(built)) {
  const styles = readAvailableStyles(new Uint8Array(bytes));
  const coverage = reportCoverage(styles);
  if (coverage.missing.length > 0) {
    console.log(`FAIL  ${name}: missing ${coverage.missing.length} Pandoc name(s): ${coverage.missing.join(", ")}`);
    failures++;
  } else {
    console.log(`ok    ${name}: all ${coverage.total} Pandoc style names defined`);
  }
}

// Zero direct formatting — §2.1's last row, and the one that matters most.
//
// The allowlist is three character styles' worth of genuine inline semantics. Anything else
// inside a body `w:rPr` is decoration, and a shipped template containing decoration would
// undercut the argument in SPEC §4.2 that named styles suffice.
const ALLOWED_IN_BODY = new Set(["w:rStyle", "w:i"]);
for (const [name, bytes] of Object.entries(built)) {
  const xml = OpcPackage.open(new Uint8Array(bytes)).text("word/document.xml");
  const offenders = new Set();
  for (const match of xml.matchAll(/<w:rPr>(.*?)<\/w:rPr>/gs)) {
    for (const el of match[1].matchAll(/<(w:[a-zA-Z]+)[ />]/g)) {
      if (!ALLOWED_IN_BODY.has(el[1])) offenders.add(el[1]);
    }
  }
  if (offenders.size > 0) {
    console.log(`FAIL  ${name}: direct formatting in the body: ${[...offenders].sort().join(", ")}`);
    failures++;
  } else {
    console.log(`ok    ${name}: no direct formatting in the body`);
  }
}

// The constructs §2.1 lists, counted in the primary template.
const primary = OpcPackage.open(new Uint8Array(built["academic-manuscript.docx"])).text("word/document.xml");
const REQUIRED = [
  ["display equations (>=3)", (x) => (x.match(/<m:oMath>/g) ?? []).length >= 5],
  ["Heading 1-6 all used", (x) => [1, 2, 3, 4, 5, 6].every((n) => x.includes(`w:val="Heading${n}"`))],
  ["title block", (x) => ["Title", "Subtitle", "Author", "Date"].every((s) => x.includes(`w:val="${s}"`))],
  ["abstract", (x) => x.includes("AbstractTitle") && x.includes(`w:val="Abstract"`)],
  ["2 figures with real images", (x) => (x.match(/<w:drawing>/g) ?? []).length === 2],
  ["2 tables", (x) => (x.match(/<w:tbl>/g) ?? []).length === 2],
  ["merged header cell", (x) => x.includes("<w:gridSpan")],
  ["3 footnote references", (x) => (x.match(/<w:footnoteReference/g) ?? []).length === 3],
  ["source code + verbatim char", (x) => x.includes("SourceCode") && x.includes("VerbatimChar")],
  ["block quote", (x) => x.includes(`w:val="BlockText"`)],
  ["definition list", (x) => x.includes("DefinitionTerm") && x.includes(`w:val="Definition"`)],
  ["5+ bibliography entries", (x) => (x.match(/w:val="Bibliography"/g) ?? []).length >= 5],
  ["cross-references (>=4)", (x) => (x.match(/ REF /g) ?? []).length >= 4],
  ["3-level lists", (x) => [0, 1, 2].every((i) => x.includes(`w:ilvl w:val="${i}"`))],
  ["header and footer", (x) => x.includes("headerReference") && x.includes("footerReference")],
];
for (const [label, test] of REQUIRED) {
  if (test(primary)) console.log(`ok    academic-manuscript: ${label}`);
  else {
    console.log(`FAIL  academic-manuscript: ${label}`);
    failures++;
  }
}
if (!NUMBERING.includes("startOverride")) {
  console.log("FAIL  numbering has no w:startOverride, so the restarting list is not exercised");
  failures++;
} else console.log("ok    academic-manuscript: restarting list via w:startOverride");

console.log(
  failures === 0
    ? `\nAll three reference templates match their generator and satisfy TEMPLATES.md §2.1.`
    : `\n${failures} problem(s).`,
);
process.exit(failures === 0 ? 0 : 1);
