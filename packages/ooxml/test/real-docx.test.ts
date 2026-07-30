import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { OpcPackage, Part } from "../src/package.js";
import { parseStyles, parseDocDefaults, parseTheme, resolveStyle } from "../src/cascade.js";
import { parseNumbering, resolveListItem } from "../src/numbering.js";

// These run against real files in fixtures/local/, which are gitignored because
// they cannot be redistributed (fixtures/LICENSES.md). So they skip rather than
// fail when absent: CI must be reproducible from a clone, and a test that requires
// an unobtainable file would make it not be.
const IEEE = "fixtures/local/ieee-conference-template.docx";
const SAMPLE1 = "fixtures/local/sample001.docx";

describe.skipIf(!existsSync(IEEE))("IEEE conference template (local only)", () => {
  const pkg = OpcPackage.open(new Uint8Array(readFileSync(IEEE)));
  const styles = parseStyles(pkg.xml(Part.STYLES));
  const docDefaults = parseDocDefaults(pkg.xml(Part.STYLES));
  const theme = parseTheme(pkg.xml(Part.THEME));
  const numbering = parseNumbering(pkg.xml(Part.NUMBERING));
  const base = { styles, docDefaults, theme, numbering: numbering.definitions };

  it("reads all 43 styles", () => {
    expect(Object.keys(styles)).toHaveLength(43);
  });

  // The quirk found by inspection (docs/TEMPLATES.md §3.1): heading 2 is basedOn
  // Heading1 but heading 3 is basedOn Normal. A resolver that assumes a uniform
  // heading chain gets Heading3 wrong.
  it("handles the inconsistent basedOn chain", () => {
    expect(resolveStyle(base, { styleId: "Heading2" }).chain).toEqual(["Normal", "Heading1", "Heading2"]);
    expect(resolveStyle(base, { styleId: "Heading3" }).chain).toEqual(["Normal", "Heading3"]);
  });

  it("resolves every defined style without a broken chain", () => {
    const broken = Object.keys(styles).filter((id) => resolveStyle(base, { styleId: id }).brokenChain);
    expect(broken).toEqual([]);
  });

  it("resolves theme fonts, since this file has theme1.xml", () => {
    const r = resolveStyle(base, { styleId: "Normal" });
    expect(r.unresolvedThemeFont).toBe(false);
  });
});

describe.skipIf(!existsSync(SAMPLE1))("machine-generated DOCX (local only)", () => {
  const pkg = OpcPackage.open(new Uint8Array(readFileSync(SAMPLE1)));

  // CORPUS.md §2.15: this class of file has no theme part at all.
  it("has no theme1.xml, the defining trait of the generated class", () => {
    expect(pkg.has(Part.THEME)).toBe(false);
  });

  it("resolves styles anyway, falling back to docDefaults", () => {
    const styles = parseStyles(pkg.xml(Part.STYLES));
    const base = {
      styles,
      docDefaults: parseDocDefaults(pkg.xml(Part.STYLES)),
      theme: parseTheme(pkg.xml(Part.THEME)),
      numbering: parseNumbering(pkg.xml(Part.NUMBERING)).definitions,
    };
    for (const id of Object.keys(styles)) {
      expect(() => resolveStyle(base, { styleId: id })).not.toThrow();
    }
  });

  // The measured finding that reprioritised CORPUS §2.4: every list item here is
  // ListParagraph + numPr, so numbering.xml is the only source of list semantics.
  it("carries list semantics in numPr, not in the style name", () => {
    const numbering = parseNumbering(pkg.xml(Part.NUMBERING));
    expect(Object.keys(numbering.definitions).length).toBeGreaterThan(0);
    const resolved = Object.keys(numbering.definitions).map((id) => resolveListItem(numbering, id, 0));
    expect(resolved.some((r) => r !== undefined)).toBe(true);
  });
});
