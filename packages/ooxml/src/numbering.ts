/**
 * `numbering.xml` — where list semantics actually live.
 *
 * This module exists because of a specific, measured defect. Inspecting real
 * documents (docs/CORPUS.md §2.3) found that **all 50 list items across two files
 * used `ListParagraph` + `numPr`**. The style name says nothing about whether a list
 * is ordered; that information is only in the numbering definition this file
 * resolves. An adapter that reads `w:pStyle` and ignores `w:numPr` therefore turns
 * every numbered list into a bullet list — which is precisely the defect
 * `word-to-markdown-js` documents in its own README.
 *
 * Resolution order for a list item at (numId, ilvl):
 *   w:num[numId] -> w:lvlOverride[ilvl]?     (per-instance override, incl. startOverride)
 *                -> w:abstractNumId
 *   w:abstractNum[abstractNumId] -> w:lvl[ilvl]
 */
import type { NumberingDefinition } from "@markforge/ir";

/** One level of a numbering definition, as the schema declares it. */
export type NumberingLevel = NumberingDefinition["levels"][number];

/** Twentieths of a point to points. */
const twipsToPt = (n: number): number => n / 20;
import { attr, childNamed, childrenNamed, intVal, val, type XmlElement } from "./xml.js";

/**
 * `w:numFmt` values that render as an unordered marker. Everything else — decimal,
 * lowerRoman, upperLetter, ordinal, chicago, the CJK and Hebrew formats — is ordered.
 *
 * Defaulting to *ordered* for unrecognised formats is deliberate: OOXML defines
 * dozens of numbering formats and new ones appear, but the unordered set is closed
 * and small. Guessing "bullet" for an unknown format would reintroduce exactly the
 * bug this module exists to prevent.
 */
const UNORDERED_FORMATS = new Set(["bullet", "none"]);

export function isOrderedFormat(numFmt: string | undefined): boolean {
  if (!numFmt) return false;
  return !UNORDERED_FORMATS.has(numFmt);
}

function parseLevel(lvl: XmlElement): NumberingLevel {
  const ilvl = Number.parseInt(attr(lvl, "ilvl") ?? "0", 10);
  const numFmt = val(childNamed(lvl, "numFmt"));
  const lvlText = val(childNamed(lvl, "lvlText"));
  const start = intVal(childNamed(lvl, "start"));
  const isLgl = childNamed(lvl, "isLgl");

  const pPr = childNamed(lvl, "pPr");
  const ind = pPr ? childNamed(pPr, "ind") : undefined;
  const leftRaw = ind ? (attr(ind, "left") ?? attr(ind, "start")) : undefined;
  const hangingRaw = ind ? attr(ind, "hanging") : undefined;

  const out: NumberingLevel = { ilvl, format: numFmt ?? "bullet" };
  if (lvlText !== undefined) out.levelText = lvlText;
  if (start !== undefined) out.startAt = start;
  if (isLgl) out.isLegal = true;
  if (leftRaw !== undefined) {
    const n = Number.parseInt(leftRaw, 10);
    if (Number.isFinite(n)) out.indentLeftPt = twipsToPt(n);
  }
  if (hangingRaw !== undefined) {
    const n = Number.parseInt(hangingRaw, 10);
    if (Number.isFinite(n)) out.hangingIndentPt = twipsToPt(n);
  }
  return out;
}

export interface ParsedNumbering {
  /** Keyed by `w:numId`, which is what a paragraph's `w:numPr` references. */
  definitions: Record<string, NumberingDefinition>;
  /** Abstract definitions, kept for renderers that write numbering back out. */
  abstract: Record<string, NumberingLevel[]>;
}

export function parseNumbering(numberingRoot: XmlElement | undefined): ParsedNumbering {
  const abstract: Record<string, NumberingLevel[]> = {};
  const definitions: Record<string, NumberingDefinition> = {};
  if (!numberingRoot) return { definitions, abstract };

  for (const an of childrenNamed(numberingRoot, "abstractNum")) {
    const id = attr(an, "abstractNumId");
    if (!id) continue;
    abstract[id] = childrenNamed(an, "lvl").map(parseLevel);
  }

  for (const num of childrenNamed(numberingRoot, "num")) {
    const numId = attr(num, "numId");
    if (!numId) continue;
    const abstractId = val(childNamed(num, "abstractNumId"));
    const base = (abstractId !== undefined ? abstract[abstractId] : undefined) ?? [];
    // Copy before applying overrides: two w:num entries can share one abstractNum,
    // and mutating the shared array would leak one list's override into the other.
    const levels: NumberingLevel[] = base.map((l) => ({ ...l }));

    for (const ov of childrenNamed(num, "lvlOverride")) {
      const ilvl = Number.parseInt(attr(ov, "ilvl") ?? "0", 10);
      const idx = levels.findIndex((l) => l.ilvl === ilvl);
      const replacement = childNamed(ov, "lvl");
      const startOverride = intVal(childNamed(ov, "startOverride"));

      if (replacement) {
        const parsed = parseLevel(replacement);
        parsed.ilvl = ilvl;
        if (idx === -1) levels.push(parsed);
        else levels[idx] = parsed;
      }
      if (startOverride !== undefined) {
        const target = levels.findIndex((l) => l.ilvl === ilvl);
        if (target === -1) {
          levels.push({ ilvl, format: "decimal", startAt: startOverride });
        } else {
          levels[target] = { ...levels[target]!, startAt: startOverride };
        }
      }
    }

    levels.sort((a, b) => a.ilvl - b.ilvl);
    const def: NumberingDefinition = { numberingId: numId, levels };
    if (abstractId !== undefined) def.abstractId = abstractId;
    definitions[numId] = def;
  }

  return { definitions, abstract };
}

export interface ListItemInfo {
  numberingId: string;
  level: number;
  isOrdered: boolean;
  format: string;
  /** Present when this item restarts numbering (w:startOverride). */
  restartsAt?: number;
  indentLeftPt?: number;
}

/**
 * Resolves a paragraph's list membership. Returns undefined when the paragraph is
 * not a list item.
 *
 * A `numId` of "0" means "explicitly not numbered" in OOXML — it is how Word
 * removes list membership inherited from a style. Treating it as a real list is a
 * subtle bug that produces stray single-item lists.
 */
export function resolveListItem(
  numbering: ParsedNumbering,
  numberingId: string | undefined,
  level: number | undefined,
): ListItemInfo | undefined {
  if (numberingId === undefined || numberingId === "0") return undefined;
  const def = numbering.definitions[numberingId];
  if (!def) return undefined;
  const ilvl = level ?? 0;
  const lvl = def.levels.find((l) => l.ilvl === ilvl) ?? def.levels[0];
  if (!lvl) return undefined;

  const info: ListItemInfo = {
    numberingId,
    level: ilvl,
    // The decision this whole module exists for: ordered-vs-unordered comes from
    // numFmt, never from the paragraph's style name.
    isOrdered: isOrderedFormat(lvl.format),
    format: lvl.format,
  };
  if (lvl.startAt !== undefined && lvl.startAt !== 1) info.restartsAt = lvl.startAt;
  if (lvl.indentLeftPt !== undefined) info.indentLeftPt = lvl.indentLeftPt;
  return info;
}
