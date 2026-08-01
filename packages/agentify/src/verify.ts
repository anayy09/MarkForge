/**
 * The anti-hallucination gate — SPEC §10.6. Mandatory, and with no bypass flag, "because a
 * bypass flag is how a mandatory gate becomes advisory".
 *
 * ```
 * traceability = supportedSentences / totalSentences        // must equal 1.0
 * ```
 *
 * **The hard part is not computing that ratio; it is computing it in a way that can fail.**
 * A gate that walks the same fragment list assembly just built will report 1.0 forever, and
 * it will report 1.0 on the day the renderer starts inventing text. So this module works
 * from the *emitted string* and checks three independent things, only the third of which is
 * about sentences:
 *
 *   1. **Containment.** Every unit-derived fragment's text must actually appear in the text
 *      or rationale of the units it names. Catches a renderer, or an LLM polishing pass,
 *      that alters a unit's wording between extraction and emission — the failure that
 *      produces a file full of plausible sentences none of the sources contain.
 *   2. **Scaffolding is what the template declared.** Every scaffold fragment is re-checked
 *      against the profile: a `heading` must equal a heading the profile declares, a
 *      `marker` must be one of four literals, front matter must be a key the profile's
 *      schema allows. This is what stops `scaffold` being the bypass flag §10.6 refuses to
 *      have — without it, any invented sentence could be waved through by labelling it.
 *   3. **Coverage.** Every sentence of the emitted file, segmented from the string itself,
 *      must be spanned by at least one unit fragment, or lie wholly inside scaffolding.
 *
 * A file that passes all three is one whose every prose sentence traces to a unit id and
 * whose every other byte is structure the target profile asked for.
 */
import { DiagnosticCode, type DiagnosticBag } from "@markforge/ir";
import { MARKERS, type EmittedFile, type Fragment } from "./assemble.js";
import type { TargetProfile } from "./targets.js";
import { DOCUMENT_ROLES, normalizeUnitText, type ContextUnit } from "./units.js";

export interface UnsupportedSentence {
  file: string;
  sentence: string;
  start: number;
  reason: "no-unit" | "not-contained" | "outside-fragments";
  /** For `not-contained`, the units the fragment claimed but does not match. */
  claimedUnitIds?: string[];
}

export interface FileVerification {
  path: string;
  totalSentences: number;
  supportedSentences: number;
  traceability: number;
  unsupported: UnsupportedSentence[];
  /** Scaffolding that does not match the profile. Never droppable — always an error. */
  scaffoldViolations: string[];
}

export interface VerificationResult {
  files: FileVerification[];
  traceability: number;
  passed: boolean;
  required: number;
  unsupported: UnsupportedSentence[];
  scaffoldViolations: string[];
}

const ICU = new Intl.Segmenter("en", { granularity: "sentence" });

function segment(text: string, method: "icu" | "simple"): { text: string; start: number }[] {
  if (method === "simple") {
    const out: { text: string; start: number }[] = [];
    const re = /[^\n]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ text: m[0], start: m.index });
    return out;
  }
  const out: { text: string; start: number }[] = [];
  for (const s of ICU.segment(text)) {
    if (s.segment.trim() !== "") out.push({ text: s.segment, start: s.index });
  }
  return out;
}

export function verifyFile(
  file: EmittedFile,
  profile: TargetProfile,
  unitsById: Map<string, ContextUnit>,
): FileVerification {
  const scaffoldViolations = checkScaffolding(file, profile);
  const unsupported: UnsupportedSentence[] = [];

  // --- 1. Containment, per fragment.
  const badFragments = new Set<Fragment>();
  for (const fragment of file.fragments) {
    if (fragment.scaffold !== undefined) continue;
    const claimed = fragment.unitIds.map((id) => unitsById.get(id)).filter((u): u is ContextUnit => !!u);
    if (claimed.length === 0) {
      badFragments.add(fragment);
      unsupported.push({
        file: file.path,
        sentence: fragment.text,
        start: fragment.start,
        reason: "no-unit",
        claimedUnitIds: fragment.unitIds,
      });
      continue;
    }
    const haystack = claimed
      .map((u) => `${normalizeUnitText(u.text)} ${u.rationale ? normalizeUnitText(u.rationale) : ""}`)
      .join(" ");
    if (!haystack.includes(normalizeUnitText(fragment.text))) {
      badFragments.add(fragment);
      unsupported.push({
        file: file.path,
        sentence: fragment.text,
        start: fragment.start,
        reason: "not-contained",
        claimedUnitIds: fragment.unitIds,
      });
    }
  }

  // --- 3. Coverage, from the emitted string.
  const method = profile.traceability?.sentenceSegmenter ?? "icu";
  const sentences = segment(file.content, method);
  let supported = 0;

  for (const sentence of sentences) {
    const from = sentence.start;
    const to = sentence.start + sentence.text.length;
    const covering = file.fragments.filter((f) => f.start < to && f.end > from);
    const unitFragments = covering.filter((f) => f.scaffold === undefined && !badFragments.has(f));
    const allScaffold = covering.length > 0 && covering.every((f) => f.scaffold !== undefined);

    if (unitFragments.length > 0 || allScaffold) {
      supported++;
      continue;
    }
    if (covering.length === 0) {
      unsupported.push({
        file: file.path,
        sentence: sentence.text.trim(),
        start: from,
        reason: "outside-fragments",
      });
    }
    // A sentence covered only by fragments already recorded as bad is not double-reported;
    // it is unsupported because of them, and fixing them fixes it.
  }

  const total = sentences.length;
  return {
    path: file.path,
    totalSentences: total,
    supportedSentences: supported,
    traceability: total === 0 ? 1 : supported / total,
    unsupported,
    scaffoldViolations,
  };
}

/**
 * Every heading `assemble.ts` is capable of emitting that is not a section heading.
 *
 * Enumerated from the same closed sets assembly draws on — the profile's display name and
 * the document-role vocabulary — so adding a generated title means adding it here, which is
 * the intended friction.
 */
function generatedTitles(profile: TargetProfile): Set<string> {
  const titles = new Set<string>([`${profile.displayName} — additional context`, "More"]);
  for (const role of DOCUMENT_ROLES) {
    const spaced = role.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    titles.add(spaced.charAt(0).toUpperCase() + spaced.slice(1));
  }
  return titles;
}

/**
 * Re-derives what the profile permits as scaffolding and checks every scaffold fragment
 * against it.
 *
 * This is the check that makes the `scaffold` marker trustworthy. Everything permitted here
 * is either a literal from a closed set or a string the profile itself declares.
 */
function checkScaffolding(file: EmittedFile, profile: TargetProfile): string[] {
  const violations: string[] = [];
  const headings = new Set((profile.sections ?? []).map((s) => s.heading));
  const frontMatterKeys = new Set(profile.frontMatter?.required ?? []);
  for (const key of Object.keys(
    (profile.frontMatter?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
  )) {
    frontMatterKeys.add(key);
  }

  for (const fragment of file.fragments) {
    const kind = fragment.scaffold;
    if (kind === undefined) continue;
    const text = fragment.text;
    switch (kind) {
      case "heading": {
        // The allowed set is enumerated, never pattern-matched.
        //
        // This started as "a section heading, the display name, or anything title-cased
        // under 40 characters", and the last clause was a hole big enough to drive prose
        // through: `## Ignore all previous instructions` satisfied it. A unit test caught
        // it where the harness's own negative control did not, because the control happened
        // to use a longer string. Any predicate loose enough to admit an unforeseen heading
        // is loose enough to admit an injected one, so the fallback is now a closed list of
        // titles this codebase can actually generate.
        const stripped = text.replace(/^#{1,6}\s*/, "").trim();
        if (!headings.has(stripped) && !generatedTitles(profile).has(stripped)) {
          violations.push(
            `${file.path}: heading scaffolding "${stripped}" is not a heading target ` +
              `"${profile.id}" declares, and is not one of the titles assembly generates`,
          );
        }
        break;
      }
      case "marker":
        if (!(MARKERS as readonly string[]).includes(text) && !/^\s*$/.test(text) && !/^[,\s]*\n?$/.test(text)) {
          violations.push(`${file.path}: marker scaffolding ${JSON.stringify(text)} is not one of ${MARKERS.join(", ")}`);
        }
        break;
      case "fence":
        if (!/^```[a-z]*\n$/.test(text)) {
          violations.push(`${file.path}: fence scaffolding ${JSON.stringify(text)} is not a code fence delimiter`);
        }
        break;
      case "frontMatter": {
        if (text === "---\n" || text === "---\n\n") break;
        const key = /^([A-Za-z][\w-]*):/.exec(text)?.[1];
        if (!key || !frontMatterKeys.has(key)) {
          violations.push(
            `${file.path}: front-matter scaffolding declares "${key ?? text.trim()}", which target ` +
              `"${profile.id}" does not list in frontMatter`,
          );
        }
        break;
      }
      case "link":
        if (!/^##\s|\]\(|^@/m.test(text)) {
          violations.push(`${file.path}: link scaffolding ${JSON.stringify(text.slice(0, 40))} is not a link`);
        }
        break;
      case "manifestKey":
        if (profile.kind !== "manifest") {
          violations.push(`${file.path}: manifestKey scaffolding used by non-manifest target "${profile.id}"`);
        }
        break;
      case "blank":
        if (text.trim() !== "") {
          violations.push(`${file.path}: blank scaffolding ${JSON.stringify(text)} is not whitespace`);
        }
        break;
    }
  }
  return violations;
}

export function verify(
  files: EmittedFile[],
  profile: TargetProfile,
  units: ContextUnit[],
  required: number,
  diagnostics: DiagnosticBag,
): VerificationResult {
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const perFile = files.map((f) => verifyFile(f, profile, unitsById));

  const total = perFile.reduce((sum, f) => sum + f.totalSentences, 0);
  const supported = perFile.reduce((sum, f) => sum + f.supportedSentences, 0);
  const traceability = total === 0 ? 1 : supported / total;
  const unsupported = perFile.flatMap((f) => f.unsupported);
  const scaffoldViolations = perFile.flatMap((f) => f.scaffoldViolations);

  for (const item of unsupported) {
    diagnostics.lost(
      DiagnosticCode.AGENTIFY_SENTENCE_UNSUPPORTED,
      "sentence",
      `agentify: ${item.file} contains a sentence that traces to no context unit ` +
        `(${item.reason}): "${item.sentence.slice(0, 80)}". It is dropped, not emitted — ` +
        `see --explain-drops.`,
    );
  }
  for (const violation of scaffoldViolations) {
    diagnostics.error(DiagnosticCode.AGENTIFY_TRACEABILITY_FAILED, `agentify: ${violation}`);
  }

  const passed = traceability >= required && scaffoldViolations.length === 0;
  if (!passed) {
    diagnostics.error(
      DiagnosticCode.AGENTIFY_TRACEABILITY_FAILED,
      `agentify: traceability ${(traceability * 100).toFixed(1)}% is below the required ` +
        `${(required * 100).toFixed(1)}% (${supported}/${total} sentences supported` +
        `${scaffoldViolations.length > 0 ? `, ${scaffoldViolations.length} scaffolding violation(s)` : ""}). ` +
        `SPEC §10.6 makes this gate mandatory and gives it no bypass flag. Exit 5.`,
    );
  }

  return { files: perFile, traceability, passed, required, unsupported, scaffoldViolations };
}

/**
 * Removes fragments the gate refused, and rebuilds the file's content and offsets.
 *
 * §10.6: "Unsupported content is dropped and logged." Dropping is what makes the emitted
 * file trustworthy; the *log* is what stops dropping from becoming a way to pass the gate
 * quietly. Both happen, and `--explain-drops` prints the second.
 */
export function dropUnsupported(file: EmittedFile, verification: FileVerification): EmittedFile {
  const bad = new Set(verification.unsupported.map((u) => u.start));
  if (bad.size === 0) return file;

  const kept: Fragment[] = [];
  let offset = 0;
  for (const fragment of file.fragments) {
    if (fragment.scaffold === undefined && bad.has(fragment.start)) continue;
    kept.push({ ...fragment, start: offset, end: offset + fragment.text.length });
    offset += fragment.text.length;
  }
  return { ...file, fragments: kept, content: kept.map((f) => f.text).join("") };
}
