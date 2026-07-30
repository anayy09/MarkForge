import { describe, it, expect } from "vitest";
import { parseXml } from "../src/xml.js";
import {
  parseStyles,
  parseDocDefaults,
  parseTheme,
  resolveStyle,
  resolveThemeFont,
} from "../src/cascade.js";
import { parseNumbering, resolveListItem, isOrderedFormat } from "../src/numbering.js";

const STYLES = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="+mn-lt"/><w:sz w:val="20"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="+mj-lt"/><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:sz w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Cyclic">
    <w:name w:val="Cyclic"/><w:basedOn w:val="Cyclic2"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Cyclic2">
    <w:name w:val="Cyclic2"/><w:basedOn w:val="Cyclic"/>
  </w:style>
</w:styles>`;

const THEME = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:minorFont>
  </a:fontScheme></a:themeElements>
</a:theme>`;

const styles = parseStyles(parseXml(STYLES));
const docDefaults = parseDocDefaults(parseXml(STYLES));
const theme = parseTheme(parseXml(THEME));
const base = { styles, docDefaults, theme, numbering: {} };

describe("style cascade", () => {
  it("applies docDefaults as the base layer", () => {
    const r = resolveStyle(base, {});
    expect(r.evidence.fontSizePt).toBe(10);
    expect(r.evidence.spacingAfterPt).toBe(6);
  });

  // The classic OOXML bug: walking the basedOn chain in the wrong direction makes
  // Normal's 10pt override Heading 1's 16pt, because the last write wins.
  it("walks basedOn root-first so the nearest style wins", () => {
    const r = resolveStyle(base, { styleId: "Heading1" });
    expect(r.chain).toEqual(["Normal", "Heading1"]);
    expect(r.evidence.fontSizePt).toBe(16);
    expect(r.evidence.bold).toBe(true);
  });

  it("inherits through a two-step chain", () => {
    const r = resolveStyle(base, { styleId: "Heading2" });
    expect(r.chain).toEqual(["Normal", "Heading1", "Heading2"]);
    expect(r.evidence.fontSizePt).toBe(14);
    // bold is inherited from Heading1, which Heading2 does not override
    expect(r.evidence.bold).toBe(true);
    expect(r.evidence.outlineLevel).toBe(1);
  });

  it("resolves theme font tokens against theme1.xml", () => {
    expect(resolveStyle(base, { styleId: "Heading1" }).evidence.fontFamily).toBe("Calibri Light");
    expect(resolveStyle(base, { styleId: "Normal" }).evidence.fontFamily).toBe("Calibri");
  });

  // Found by inspecting a real machine-generated file (docs/CORPUS.md §2.15): no
  // theme1.xml at all. A resolver that assumes one crashes on a common input class.
  it("survives a missing theme and reports the unresolved token", () => {
    const noTheme = { ...base, theme: {} };
    const r = resolveStyle(noTheme, { styleId: "Heading1" });
    expect(r.unresolvedThemeFont).toBe(true);
    expect(r.evidence.fontFamily).toBe("+mj-lt");
    expect(r.evidence.fontSizePt).toBe(16);
  });

  it("direct run properties beat the style chain", () => {
    const rPr = parseXml(`<w:rPr xmlns:w="x"><w:sz w:val="48"/><w:b w:val="0"/></w:rPr>`);
    const r = resolveStyle(base, { styleId: "Heading1", rPr });
    expect(r.evidence.fontSizePt).toBe(24);
    expect(r.evidence.bold).toBe(false);
  });

  it("an absent property does not erase an inherited one", () => {
    const rPr = parseXml(`<w:rPr xmlns:w="x"><w:i/></w:rPr>`);
    const r = resolveStyle(base, { styleId: "Heading1", rPr });
    expect(r.evidence.italic).toBe(true);
    expect(r.evidence.bold).toBe(true);
    expect(r.evidence.fontSizePt).toBe(16);
  });

  it("reports a missing style rather than throwing", () => {
    const r = resolveStyle(base, { styleId: "NoSuchStyle" });
    expect(r.brokenChain).toBe(true);
    expect(r.evidence.fontSizePt).toBe(10);
  });

  it("terminates on a cyclic basedOn chain", () => {
    const r = resolveStyle(base, { styleId: "Cyclic" });
    expect(r.brokenChain).toBe(true);
  });

  it("treats OOXML booleans correctly: present means true", () => {
    // <w:b/> with no w:val is true; w:val="0" is false. Reading absent-val as
    // false makes every bold run come out plain.
    const on = parseXml(`<w:rPr xmlns:w="x"><w:b/></w:rPr>`);
    const off = parseXml(`<w:rPr xmlns:w="x"><w:b w:val="0"/></w:rPr>`);
    expect(resolveStyle(base, { rPr: on }).evidence.bold).toBe(true);
    expect(resolveStyle(base, { rPr: off }).evidence.bold).toBe(false);
  });

  it("resolves a hanging indent as a negative first-line indent", () => {
    const pPr = parseXml(`<w:pPr xmlns:w="x"><w:ind w:left="720" w:hanging="360"/></w:pPr>`);
    const r = resolveStyle(base, { pPr });
    expect(r.evidence.indentLeftTwips).toBe(720);
    expect(r.evidence.indentFirstLineTwips).toBe(-360);
  });
});

describe("theme font tokens", () => {
  it("passes through a real font name unchanged", () => {
    expect(resolveThemeFont("Times New Roman", theme)).toBe("Times New Roman");
  });
  it("maps both token spellings", () => {
    expect(resolveThemeFont("+mn-lt", theme)).toBe("Calibri");
    expect(resolveThemeFont("minorHAnsi", theme)).toBe("Calibri");
  });
});

const NUMBERING = `<?xml version="1.0"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3">
    <w:abstractNumId w:val="0"/>
    <w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride>
  </w:num>
</w:numbering>`;

describe("numbering", () => {
  const numbering = parseNumbering(parseXml(NUMBERING));

  // The defect this module exists to prevent: ListParagraph + numPr is how Word
  // encodes *both* ordered and unordered lists, so the style name cannot decide.
  it("decides ordered-vs-unordered from numFmt, not from the style name", () => {
    expect(resolveListItem(numbering, "1", 0)?.isOrdered).toBe(true);
    expect(resolveListItem(numbering, "2", 0)?.isOrdered).toBe(false);
  });

  it("defaults unknown formats to ordered", () => {
    // The unordered set is closed and small; the ordered set grows. Guessing
    // "bullet" for an unrecognised format reintroduces the bug.
    expect(isOrderedFormat("chicago")).toBe(true);
    expect(isOrderedFormat("aiueoFullWidth")).toBe(true);
    expect(isOrderedFormat("bullet")).toBe(false);
    expect(isOrderedFormat("none")).toBe(false);
  });

  it("applies w:startOverride as a restart", () => {
    expect(resolveListItem(numbering, "3", 0)?.restartsAt).toBe(5);
    expect(resolveListItem(numbering, "1", 0)?.restartsAt).toBeUndefined();
  });

  it("does not leak an override between two nums sharing one abstractNum", () => {
    // numId 1 and 3 share abstractNum 0. Mutating the shared level array would
    // give list 1 the restart that only list 3 declared.
    expect(resolveListItem(numbering, "1", 0)?.restartsAt).toBeUndefined();
    expect(resolveListItem(numbering, "3", 0)?.restartsAt).toBe(5);
  });

  it("treats numId 0 as explicitly not-a-list", () => {
    expect(resolveListItem(numbering, "0", 0)).toBeUndefined();
  });

  it("carries the level indent from the numbering definition", () => {
    expect(resolveListItem(numbering, "1", 0)?.indentLeftTwips).toBe(720);
  });

  it("resolves nested levels", () => {
    expect(resolveListItem(numbering, "1", 1)?.format).toBe("lowerLetter");
  });
});
