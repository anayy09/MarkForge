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

/**
 * Evidence without the required `origin` discriminator.
 *
 * Intermediate layers genuinely have no single origin — a value that came half from
 * docDefaults and half from a direct run property is not one or the other. So the
 * layers are assembled as partials and `origin` is set once, at the end, by
 * `resolveStyle`, which is the only place that knows whether direct formatting
 * actually contributed.
 */
export type PartialEvidence = Omit<StyleEvidence, "origin">;
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

/**
 * Reads `w:pPr` and `w:rPr` into schema-shaped evidence. Absent properties stay
 * absent — an unset value must not overwrite an inherited one.
 *
 * The shape is the schema's nested one (`font`, `paragraph`, `numbering`) rather
 * than a flat bag. A flat shape is easier to write and was the first thing this
 * file did; it drifted from the schema immediately and produced documents that
 * failed validation, which is the drift docs/SPEC.md §2.2 exists to prevent.
 */
export function readProperties(
  pPr: XmlElement | undefined,
  rPr: XmlElement | undefined,
): PartialEvidence {
  const font: NonNullable<StyleEvidence["font"]> = {};
  const paragraph: NonNullable<StyleEvidence["paragraph"]> = {};
  const numbering: NonNullable<StyleEvidence["numbering"]> = {};
  let outlineLevel: number | undefined;

  if (pPr) {
    const jc = val(childNamed(pPr, "jc"));
    if (jc) {
      const map: Record<string, NonNullable<StyleEvidence["paragraph"]>["alignment"]> = {
        left: "left", start: "left", center: "center",
        right: "right", end: "right", both: "justify", justify: "justify",
      };
      const mapped = map[jc];
      if (mapped) paragraph.alignment = mapped;
    }

    const ind = childNamed(pPr, "ind");
    if (ind) {
      const left = attr(ind, "left") ?? attr(ind, "start");
      const right = attr(ind, "right") ?? attr(ind, "end");
      const firstLine = attr(ind, "firstLine");
      const hanging = attr(ind, "hanging");
      if (left !== undefined) paragraph.indentLeftPt = twipsToPt(Number.parseInt(left, 10));
      if (right !== undefined) paragraph.indentRightPt = twipsToPt(Number.parseInt(right, 10));
      if (firstLine !== undefined) paragraph.firstLineIndentPt = twipsToPt(Number.parseInt(firstLine, 10));
      // A hanging indent is a negative first-line indent. Two representations of
      // one concept would mean every consumer has to handle both.
      if (hanging !== undefined) paragraph.firstLineIndentPt = -twipsToPt(Number.parseInt(hanging, 10));
    }

    const spacing = childNamed(pPr, "spacing");
    if (spacing) {
      const before = attr(spacing, "before");
      const after = attr(spacing, "after");
      const line = attr(spacing, "line");
      const lineRule = attr(spacing, "lineRule");
      if (before !== undefined) paragraph.spaceBeforePt = twipsToPt(Number.parseInt(before, 10));
      if (after !== undefined) paragraph.spaceAfterPt = twipsToPt(Number.parseInt(after, 10));
      if (line !== undefined) {
        const rule = lineRule === "exact" ? "exact" : lineRule === "atLeast" ? "atLeast" : "auto";
        paragraph.lineSpacing = {
          value: rule === "auto" ? Number.parseInt(line, 10) / 240 : twipsToPt(Number.parseInt(line, 10)),
          rule,
        };
      }
    }

    if (boolVal(childNamed(pPr, "keepNext")) !== undefined) paragraph.keepWithNext = true;
    if (boolVal(childNamed(pPr, "keepLines")) !== undefined) paragraph.keepLines = true;
    if (boolVal(childNamed(pPr, "pageBreakBefore")) !== undefined) paragraph.pageBreakBefore = true;

    // A bottom border. Recorded because it is the only thing distinguishing a horizontal
    // rule from an empty paragraph in OOXML — Word has no thematic-break element, so the
    // writer draws one this way and, until this line, the reader had nothing to read it
    // back from. Evidence only: `@markforge/infer` decides whether it is a rule (A5).
    const pBdr = childNamed(pPr, "pBdr");
    if (pBdr) {
      const bottom = childNamed(pBdr, "bottom");
      const style = bottom ? val(bottom) : undefined;
      if (bottom && style !== "none" && style !== "nil") paragraph.borderBottom = true;
    }

    const outline = intVal(childNamed(pPr, "outlineLvl"));
    if (outline !== undefined) outlineLevel = outline;

    const numPr = childNamed(pPr, "numPr");
    if (numPr) {
      const numId = val(childNamed(numPr, "numId"));
      const ilvl = intVal(childNamed(numPr, "ilvl"));
      if (numId !== undefined) numbering.numId = numId;
      if (ilvl !== undefined) numbering.ilvl = ilvl;
    }
  }

  if (rPr) {
    const rFonts = childNamed(rPr, "rFonts");
    if (rFonts) {
      const ascii = attr(rFonts, "ascii") ?? attr(rFonts, "hAnsi") ?? attr(rFonts, "cs");
      if (ascii !== undefined) font.family = ascii;
    }
    const sz = intVal(childNamed(rPr, "sz"));
    if (sz !== undefined) font.sizePt = halfPointsToPt(sz);

    // OOXML has no numeric weight: w:b is a boolean. Mapping it to the CSS scale
    // keeps the IR renderer-agnostic, and 700/400 are the values every consumer
    // already understands.
    const b = boolVal(childNamed(rPr, "b"));
    if (b !== undefined) font.weight = b ? 700 : 400;
    const i = boolVal(childNamed(rPr, "i"));
    if (i !== undefined) font.italic = i;
    const strike = boolVal(childNamed(rPr, "strike"));
    if (strike !== undefined) font.strike = strike;
    const caps = boolVal(childNamed(rPr, "caps"));
    if (caps !== undefined) font.allCaps = caps;
    const smallCaps = boolVal(childNamed(rPr, "smallCaps"));
    if (smallCaps !== undefined) font.smallCaps = smallCaps;
    const u = childNamed(rPr, "u");
    if (u) {
      const uv = val(u);
      if (uv !== "none") font.underline = uv ?? "single";
    }
    const color = val(childNamed(rPr, "color"));
    if (color !== undefined && color !== "auto") font.color = color;
    const highlight = val(childNamed(rPr, "highlight"));
    if (highlight !== undefined && highlight !== "none") font.highlight = highlight;
    else {
      const shd = childNamed(rPr, "shd");
      const fill = shd ? attr(shd, "fill") : undefined;
      if (fill !== undefined && fill !== "auto") font.highlight = fill;
    }
  }

  const out: PartialEvidence = {};
  if (Object.keys(font).length) out.font = font;
  if (Object.keys(paragraph).length) out.paragraph = paragraph;
  if (Object.keys(numbering).length) out.numbering = numbering;
  if (outlineLevel !== undefined) out.outlineLevel = outlineLevel;
  return out;
}

/**
 * Layers evidence. Later arguments win, but only where they actually specify a
 * value — an absent property must not erase an inherited one, which is the
 * difference between a cascade and a replacement.
 *
 * The merge is one level deep, matching the schema's shape: `font`, `paragraph`,
 * and `numbering` are merged field by field rather than replaced wholesale. A
 * shallow merge would let a style that sets only `font.family` wipe out an
 * inherited `font.sizePt`, which is the same bug as walking the chain backwards.
 */
export function layer(...layers: (PartialEvidence | undefined)[]): PartialEvidence {
  const out: PartialEvidence = {};
  const groups = ["font", "paragraph", "numbering", "layout", "cell"] as const;
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      if ((groups as readonly string[]).includes(k) && typeof v === "object" && v !== null) {
        const prev = (out as Record<string, unknown>)[k];
        (out as Record<string, unknown>)[k] =
          prev && typeof prev === "object" ? { ...(prev as object), ...(v as object) } : { ...(v as object) };
      } else {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

export interface CascadeInput {
  styles: Record<string, StyleDefinition>;
  docDefaults: PartialEvidence;
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
  tableConditional?: PartialEvidence | undefined;
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
  let numberingLayer: PartialEvidence | undefined;
  const direct = readProperties(req.pPr, req.rPr);
  const numId =
    direct.numbering?.numId ??
    styleLayers.reduce<string | undefined>((acc, l) => l?.numbering?.numId ?? acc, undefined);
  const ilvl =
    direct.numbering?.ilvl ??
    styleLayers.reduce<number | undefined>((acc, l) => l?.numbering?.ilvl ?? acc, undefined);
  if (numId !== undefined) {
    const def = input.numbering[numId];
    const lvl = def?.levels.find((l) => l.ilvl === (ilvl ?? 0));
    if (lvl) {
      numberingLayer = {
        numbering: {
          numId,
          ilvl: ilvl ?? 0,
          format: lvl.format,
          ...(lvl.levelText !== undefined ? { levelText: lvl.levelText } : {}),
          ...(lvl.startAt !== undefined ? { startAt: lvl.startAt } : {}),
        },
        ...(lvl.indentLeftPt !== undefined
          ? { paragraph: { indentLeftPt: lvl.indentLeftPt } }
          : {}),
      };
    }
  }

  const merged = layer(
    input.docDefaults, // 1
    ...styleLayers, // 2
    req.tableConditional, // 3
    numberingLayer, // 4
    direct, // 5 and 6
  );

  // Theme font resolution happens last, on the winning value: resolving per layer
  // would resolve tokens that a later layer overrides anyway.
  let unresolvedThemeFont = false;
  if (merged.font?.family) {
    const resolved = resolveThemeFont(merged.font.family, input.theme);
    if (resolved !== undefined) {
      if (resolved.startsWith("+")) unresolvedThemeFont = true;
      merged.font = { ...merged.font, family: resolved };
    }
  }

  // `origin` records the innermost cascade level that actually supplied a value.
  // `directFormatting` is the documented signal that heading inference is needed
  // (schema: StyleEvidence.origin), so it is set only when direct w:pPr/w:rPr
  // genuinely contributed — claiming it whenever a run has properties would make
  // every document look hand-formatted and defeat the signal.
  const origin: StyleEvidence["origin"] = Object.keys(direct).length > 0
    ? "directFormatting"
    : "styleCascade";

  // `origin` last, not first: style definitions carry their own `origin` and it
  // rides along through `layer`, so spreading `merged` afterwards would let a style
  // definition's "styleCascade" overwrite the computed value and permanently hide
  // direct formatting from inference.
  const evidence: StyleEvidence = { ...merged, origin };
  if (req.styleId !== undefined) {
    const def = input.styles[req.styleId];
    evidence.sourceStyleId = req.styleId;
    if (def?.name) evidence.sourceStyleName = def.name;
    if (chain.length > 0) evidence.basedOn = [...chain].reverse();
  }

  return { evidence, chain, brokenChain, unresolvedThemeFont };
}

/** Parses `w:docDefaults` into a base evidence layer. */
export function parseDocDefaults(stylesRoot: XmlElement | undefined): PartialEvidence {
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
      // A style definition's own evidence originates from the style cascade by
      // construction — it *is* a cascade level.
      evidence: { origin: "styleCascade", ...readProperties(childNamed(style, "pPr"), childNamed(style, "rPr")) },
    };
    const basedOn = val(childNamed(style, "basedOn"));
    if (basedOn !== undefined) def.basedOn = basedOn;
    const next = val(childNamed(style, "next"));
    if (next !== undefined) def.next = next;
    out[styleId] = def;
  }
  return out;
}
