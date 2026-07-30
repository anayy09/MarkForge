/**
 * Role → style-name mapping, and the `styleMap` resolution rules.
 *
 * ADR-0004 adopts **Pandoc's style vocabulary verbatim**, which buys a large
 * interoperability win for one table: any existing Pandoc reference document works
 * with MarkForge unchanged.
 *
 * The measurement in docs/SPEC.md §4.2.2 sharpened this. The IEEE conference
 * template defines **8 of these 38 names** — every other construct exists under
 * IEEE's own names. So Pandoc reference documents are a narrow population, and
 * `docx.styleMap` is the *primary* mechanism for third-party templates rather than
 * an edge case.
 */

/** The 38 Pandoc style names, by IR role. */
export const PANDOC_STYLES = {
  paragraph: "Body Text",
  firstParagraph: "First Paragraph",
  compact: "Compact",
  normal: "Normal",
  title: "Title",
  subtitle: "Subtitle",
  author: "Author",
  date: "Date",
  "heading:1": "Heading 1",
  "heading:2": "Heading 2",
  "heading:3": "Heading 3",
  "heading:4": "Heading 4",
  "heading:5": "Heading 5",
  "heading:6": "Heading 6",
  "heading:7": "Heading 7",
  "heading:8": "Heading 8",
  "heading:9": "Heading 9",
  abstract: "Abstract",
  abstractTitle: "AbstractTitle",
  bibliography: "Bibliography",
  blockquote: "Block Text",
  footnoteBlockText: "Footnote Block Text",
  code: "Source Code",
  footnoteText: "Footnote Text",
  descriptionTerm: "Definition Term",
  descriptionDetails: "Definition",
  caption: "Caption",
  "caption:table": "Table Caption",
  "caption:figure": "Image Caption",
  figure: "Figure",
  captionedFigure: "Captioned Figure",
  tocHeading: "TOC Heading",
  // Character styles
  defaultParagraphFont: "Default Paragraph Font",
  inlineCode: "Verbatim Char",
  footnoteReference: "Footnote Reference",
  link: "Hyperlink",
  sectionNumber: "Section Number",
  // Table style
  table: "Table",
} as const;

export type StyleRole = keyof typeof PANDOC_STYLES;

/** Every Pandoc style name, for coverage reporting. */
export const ALL_PANDOC_STYLE_NAMES: readonly string[] = Object.freeze(
  [...new Set(Object.values(PANDOC_STYLES))].sort(),
);

export interface AvailableStyle {
  styleId: string;
  name: string;
}

export interface StyleResolution {
  /** The `w:styleId` to write into `w:pStyle`, or undefined if none matched. */
  styleId: string | undefined;
  /** How it was found, for diagnostics. */
  via: "styleMap" | "pandocName" | "styleId" | "synthesized" | "none";
  /** The name that was looked for, for the diagnostic when nothing matched. */
  wanted: string;
}

/**
 * Resolves an IR role to a style id in the reference document.
 *
 * Lookup order, and the reason for each step:
 *
 *   1. `styleMap[role]` — the user's explicit override wins over everything.
 *   2. That value matched against `w:name`, **then** against `w:styleId`. Both,
 *      because Word's UI shows users the *name* ("Body Text Indent") while the file
 *      stores a compressed *id* ("BodyTextIndent"). Requiring the user to know
 *      which is which would be a trap, and the two namespaces do not collide in
 *      practice.
 *   3. The Pandoc name for the role, matched the same way.
 *   4. Nothing — the caller decides whether to synthesize or fail.
 */
export function resolveStyle(
  role: string,
  styleMap: Record<string, string>,
  available: AvailableStyle[],
): StyleResolution {
  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const s of available) {
    byName.set(s.name.toLowerCase(), s.styleId);
    byId.set(s.styleId.toLowerCase(), s.styleId);
  }

  const override = styleMap[role];
  if (override !== undefined) {
    const hit = byName.get(override.toLowerCase()) ?? byId.get(override.toLowerCase());
    if (hit) return { styleId: hit, via: "styleMap", wanted: override };
    // An override that matches nothing is a user error worth reporting, not a
    // silent fallback to the default — the user asked for something specific.
    return { styleId: undefined, via: "none", wanted: override };
  }

  const pandocName = (PANDOC_STYLES as Record<string, string>)[role];
  if (pandocName !== undefined) {
    const hit = byName.get(pandocName.toLowerCase()) ?? byId.get(pandocName.replace(/\s+/g, "").toLowerCase());
    if (hit) return { styleId: hit, via: "pandocName", wanted: pandocName };
    return { styleId: undefined, via: "none", wanted: pandocName };
  }

  return { styleId: undefined, via: "none", wanted: role };
}

export interface CoverageReport {
  defined: string[];
  missing: string[];
  total: number;
  /** A styleMap skeleton, pre-filled where a name matched and blank where not. */
  skeleton: Record<string, string>;
}

/**
 * Reports which Pandoc names a reference document defines.
 *
 * This is what `markforge check --reference-doc` prints (SPEC §4.2.1). It emits a
 * **pre-filled `styleMap` skeleton** rather than just a list, because the measured
 * reality is that most third-party templates define a small minority of these names
 * — so adapting one has to be an edit, not an investigation.
 */
export function reportCoverage(available: AvailableStyle[]): CoverageReport {
  const names = new Set(available.map((s) => s.name.toLowerCase()));
  const defined: string[] = [];
  const missing: string[] = [];
  for (const name of ALL_PANDOC_STYLE_NAMES) {
    if (names.has(name.toLowerCase())) defined.push(name);
    else missing.push(name);
  }

  const skeleton: Record<string, string> = {};
  for (const [role, name] of Object.entries(PANDOC_STYLES)) {
    skeleton[role] = names.has(name.toLowerCase()) ? name : "";
  }

  return { defined, missing, total: ALL_PANDOC_STYLE_NAMES.length, skeleton };
}
