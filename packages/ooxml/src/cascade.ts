/**
 * The style cascade resolver — the reason ADR-0005 rejected routing through
 * Mammoth's HTML output.
 *
 * Word computes a paragraph's effective formatting by layering, in this order:
 *
 *   1. docDefaults                (w:docDefaults in styles.xml)
 *   2. the w:basedOn style chain  (walked root-first, so nearer styles win)
 *   3. table style conditional    (w:tblStylePr for the cell's row/column band)
 *   4. numbering level properties (w:lvl/w:pPr and w:lvl/w:rPr)
 *   5. paragraph mark properties  (w:pPr/w:rPr — formatting of the mark itself)
 *   6. direct run properties      (w:rPr on the run)
 *
 * Getting the order wrong produces output that looks almost right, which is worse
 * than obviously wrong: a heading picks up the body font, or bold from a style is
 * silently overridden by a docDefault. This module exists so the order is written
 * once, in one place, with the layers named.
 *
 * The output is *evidence*, not a decision. Adapter rule A5 — "adapters record, they
 * do not infer" — means the resolver reports "this paragraph computes to 16pt bold
 * Calibri Light with outline level 0" and something else decides whether that makes
 * it a heading.
 */
import type { StyleEvidence, StyleDefinition, NumberingDefinition } from "@markforge/ir";
import {
  attr,
  boolVal,
  childNamed,
  childrenNamed,
  intVal,
  val,
  type XmlElement,
} from "./xml.js";

/** Half-points to points. OOXML stores font size as `w:sz` in half-points. */
const halfPointsToPt = (n: number): number => n / 2;
/** Twentieths of a point to points, used by spacing. */
const twipsToPt = (n: number): number => n / 20;

export interface ThemeFonts {
  /** `+mj-lt` — major latin, used by headings. */
  majorLatin?: string;
  /** `+mn-lt` — minor latin, used by body text. */
  minorLatin?: string;
  majorEastAsian?: string;
  minorEastAsian?: string;
}

/**
 * Resolves theme font tokens.
 *
 * Real documents reference fonts as `+mn-lt` rather than by name, and the mapping
 * lives in theme1.xml. A missing theme is not an error: library-generated DOCX files
 * routinely omit it (docs/CORPUS.md §2.15, found by inspecting a real file), and a
 * resolver that assumes a theme crashes on a whole common class of input. The token
 * is returned unresolved instead, and the caller records a diagnostic.
 */
export function resolveThemeFont(name: string | undefined, theme: ThemeFonts): string | undefined {
  if (!name) return undefined;
  switch (name) {
    case "+mj-lt":
    case "majorHAnsi":
      return theme.majorLatin ?? name;
    case "+mn-lt":
    case "minorHAnsi":
      return theme.minorLatin ?? name;
    case "+mj-ea":
    case "majorEastAsia":
      return theme.majorEastAsian ?? name;
    case "+mn-ea":
    case "minorEastAsia":
      return theme.minorEastAsian ?? name;
    default:
      return name;
  }
}

export function parseTheme(themeRoot: XmlElement | undefined): ThemeFonts {
  if (!themeRoot) return {};
  const scheme = findDescendant(themeRoot, "fontScheme");
  if (!scheme) return {};
  const read = (which: "majorFont" | "minorFont", tag: "latin" | "ea"): string | undefined => {
    const font = childNamed(scheme, which);
    if (!font) return undefined;
    const el = childNamed(font, tag);
    const typeface = el ? attr(el, "typeface") : undefined;
    return typeface && typeface.length > 0 ? typeface : undefined;
  };
  const out: ThemeFonts = {};
  const majorLatin = read("majorFont", "latin");
  const minorLatin = read("minorFont", "latin");
  const majorEa = read("majorFont", "ea");
  const minorEa = read("minorFont", "ea");
  if (majorLatin) out.majorLatin = majorLatin;
  if (minorLatin) out.minorLatin = minorLatin;
  if (majorEa) out.majorEastAsian = majorEa;
  if (minorEa) out.minorEastAsian = minorEa;
  return out;
}

function findDescendant(el: XmlElement, local: string): XmlElement | undefined {
  for (const child of el.children) {
    if (!("name" in child)) continue;
    if (child.local === local) return child;
    const deeper = findDescendant(child, local);
    if (deeper) return deeper;
  }
  return undefined;
}

/** Reads `w:pPr` and `w:rPr` into evidence. Absent properties stay absent. */
export function readProperties(pPr: XmlElement | undefined, rPr: XmlElement | undefined): StyleEvidence {
  const e: StyleEvidence = {};

  if (pPr) {
    const jc = val(childNamed(pPr, "jc"));
    if (jc) {
      const map: Record<string, StyleEvidence["alignment"]> = {
        left: "left",
        start: "left",
        center: "center",
        right: "right",
        end: "right",
        both: "justify",
        justify: "justify",
      };
      const mapped = map[jc];
      if (mapped) e.alignment = mapped;
    }

    const ind = childNamed(pPr, "ind");
    if (ind) {
      const left = attr(ind, "left") ?? attr(ind, "start");
      const firstLine = attr(ind, "firstLine");
      const hanging = attr(ind, "hanging");
      if (left !== undefined) e.indentLeftTwips = Number.parseInt(left, 10);
      if (firstLine !== undefined) e.indentFirstLineTwips = Number.parseInt(firstLine, 10);
      // A hanging indent is a negative first-line indent. Storing it as a separate
      // field would make every consumer handle two representations of one concept.
      if (hanging !== undefined) e.indentFirstLineTwips = -Number.parseInt(hanging, 10);
    }

    const spacing = childNamed(pPr, "spacing");
    if (spacing) {
      const before = attr(spacing, "before");
      const after = attr(spacing, "after");
      if (before !== undefined) e.spacingBeforePt = twipsToPt(Number.parseInt(before, 10));
      if (after !== undefined) e.spacingAfterPt = twipsToPt(Number.parseInt(after, 10));
    }

    const outline = intVal(childNamed(pPr, "outlineLvl"));
    if (outline !== undefined) e.outlineLevel = outline;

    const numPr = childNamed(pPr, "numPr");
    if (numPr) {
      const numId = val(childNamed(numPr, "numId"));
      const ilvl = intVal(childNamed(numPr, "ilvl"));
      if (numId !== undefined) e.numberingId = numId;
      if (ilvl !== undefined) e.numberingLevel = ilvl;
    }
  }

  if (rPr) {
    const rFonts = childNamed(rPr, "rFonts");
    if (rFonts) {
      const ascii = attr(rFonts, "ascii") ?? attr(rFonts, "hAnsi") ?? attr(rFonts, "cs");
      if (ascii !== undefined) e.fontFamily = ascii;
    }
    const sz = intVal(childNamed(rPr, "sz"));
    if (sz !== undefined) e.fontSizePt = halfPointsToPt(sz);

    const b = boolVal(childNamed(rPr, "b"));
    if (b !== undefined) e.bold = b;
    const i = boolVal(childNamed(rPr, "i"));
    if (i !== undefined) e.italic = i;
    const caps = boolVal(childNamed(rPr, "caps"));
    if (caps !== undefined) e.allCaps = caps;
    const smallCaps = boolVal(childNamed(rPr, "smallCaps"));
    if (smallCaps !== undefined) e.smallCaps = smallCaps;

    const color = val(childNamed(rPr, "color"));
    if (color !== undefined && color !== "auto") e.color = color;
    const shd = childNamed(rPr, "shd");
    const fill = shd ? attr(shd, "fill") : undefined;
    if (fill !== undefined && fill !== "auto") e.backgroundColor = fill;
  }

  return e;
}

/**
 * Layers evidence. Later arguments win, but only where they actually specify a
 * value — an absent property must not erase an inherited one, which is the
 * difference between a cascade and a replacement.
 */
export function layer(...layers: (StyleEvidence | undefined)[]): StyleEvidence {
  const out: StyleEvidence = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

export interface CascadeInput {
  styles: Record<string, StyleDefinition>;
  docDefaults: StyleEvidence;
  theme: ThemeFonts;
  numbering: Record<string, NumberingDefinition>;
}

export interface ResolveRequest {
  /** `w:pStyle` value — a styleId, not a style name. */
  styleId?: string;
  /** Direct `w:pPr` on the paragraph. */
  pPr?: XmlElement | undefined;
  /** Direct `w:rPr` on the run, or the paragraph mark's rPr. */
  rPr?: XmlElement | undefined;
  /** Table style conditional formatting, already selected for the band. */
  tableConditional?: StyleEvidence | undefined;
}

export interface ResolvedStyle {
  evidence: StyleEvidence;
  /** The style chain walked, nearest last. Empty if no style was named. */
  chain: string[];
  /** True when a named style could not be found; the caller emits a diagnostic. */
  brokenChain: boolean;
  /** True when a theme token could not be resolved because theme1.xml is absent. */
  unresolvedThemeFont: boolean;
}

const MAX_CHAIN = 32;

/**
 * Walks the `w:basedOn` chain from the named style up to its root, then applies the
 * layers in the documented order.
 *
 * The chain is walked to the root and then applied root-first, so the nearest style
 * wins. Walking it the other way is the classic OOXML bug: `Heading 1` based on
 * `Normal` would get `Normal`'s font, because the last write wins.
 */
export function resolveStyle(input: CascadeInput, req: ResolveRequest): ResolvedStyle {
  const chain: string[] = [];
  let brokenChain = false;

  let cursor = req.styleId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) {
      // A cycle in basedOn. Real files contain these after enough round trips
      // through different editors; stopping is correct, crashing is not.
      brokenChain = true;
      break;
    }
    seen.add(cursor);
    const def = input.styles[cursor];
    if (!def) {
      brokenChain = true;
      break;
    }
    chain.unshift(cursor);
    if (chain.length > MAX_CHAIN) {
      brokenChain = true;
      break;
    }
    cursor = def.basedOn;
  }

  const styleLayers = chain.map((id) => input.styles[id]?.evidence);

  // Layer 4: numbering level properties. Read after styles because a numbering
  // definition's indent overrides the paragraph style's, which is why lists in Word
  // ignore the style's left indent.
  let numberingLayer: StyleEvidence | undefined;
  const direct = readProperties(req.pPr, req.rPr);
  const numId = direct.numberingId ?? styleLayers.reduce<string | undefined>(
    (acc, l) => l?.numberingId ?? acc,
    undefined,
  );
  const ilvl =
    direct.numberingLevel ??
    styleLayers.reduce<number | undefined>((acc, l) => l?.numberingLevel ?? acc, undefined);
  if (numId !== undefined) {
    const def = input.numbering[numId];
    const lvl = def?.levels.find((l) => l.level === (ilvl ?? 0));
    if (lvl?.indentLeftTwips !== undefined) {
      numberingLayer = { indentLeftTwips: lvl.indentLeftTwips };
    }
  }

  const evidence = layer(
    input.docDefaults, // 1
    ...styleLayers, // 2
    req.tableConditional, // 3
    numberingLayer, // 4
    direct, // 5 and 6
  );

  // Theme font resolution happens last, on the winning value: resolving per layer
  // would resolve tokens that a later layer overrides anyway.
  let unresolvedThemeFont = false;
  if (evidence.fontFamily) {
    const resolved = resolveThemeFont(evidence.fontFamily, input.theme);
    if (resolved !== undefined) {
      if (resolved.startsWith("+")) unresolvedThemeFont = true;
      evidence.fontFamily = resolved;
    }
  }

  if (req.styleId !== undefined) {
    const def = input.styles[req.styleId];
    evidence.styleId = req.styleId;
    if (def?.name) evidence.styleName = def.name;
  }

  return { evidence, chain, brokenChain, unresolvedThemeFont };
}

/** Parses `w:docDefaults` into a base evidence layer. */
export function parseDocDefaults(stylesRoot: XmlElement | undefined): StyleEvidence {
  if (!stylesRoot) return {};
  const docDefaults = childNamed(stylesRoot, "docDefaults");
  if (!docDefaults) return {};
  const pPrDefault = childNamed(docDefaults, "pPrDefault");
  const rPrDefault = childNamed(docDefaults, "rPrDefault");
  return readProperties(
    pPrDefault ? childNamed(pPrDefault, "pPr") : undefined,
    rPrDefault ? childNamed(rPrDefault, "rPr") : undefined,
  );
}

/** Parses `styles.xml` into style definitions keyed by styleId. */
export function parseStyles(stylesRoot: XmlElement | undefined): Record<string, StyleDefinition> {
  const out: Record<string, StyleDefinition> = {};
  if (!stylesRoot) return out;
  for (const style of childrenNamed(stylesRoot, "style")) {
    const styleId = attr(style, "styleId");
    if (!styleId) continue;
    const type = (attr(style, "type") ?? "paragraph") as StyleDefinition["type"];
    const name = val(childNamed(style, "name")) ?? styleId;
    const def: StyleDefinition = {
      styleId,
      name,
      type,
      evidence: readProperties(childNamed(style, "pPr"), childNamed(style, "rPr")),
    };
    const basedOn = val(childNamed(style, "basedOn"));
    if (basedOn !== undefined) def.basedOn = basedOn;
    const next = val(childNamed(style, "next"));
    if (next !== undefined) def.next = next;
    out[styleId] = def;
  }
  return out;
}
