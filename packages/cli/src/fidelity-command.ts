/**
 * `markforge check --fidelity` — the clause of SPEC §8 that made exit code 4 unreachable.
 *
 * §8 says `check` should "run the fidelity harness against baselines", and the exit-code table
 * defines 4 as "fidelity regression against baseline (`check`)". Neither existed: the harness
 * lived only in `scripts/run-fidelity.mjs`, which is a repository script rather than a shipped
 * command, so **exit 4 was defined by the specification and produced by nothing**. `check
 * --help` said so rather than implying otherwise, which was honest and was not the feature.
 *
 * What it measures is deliberately the same thing the repository harness measures — a round
 * trip compared against a committed baseline — because two definitions of "fidelity" that can
 * disagree is the `pnpm verify` / `ci.yml` divergence in a new place.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { convert, parse, type Format } from "@markforge/core";
import { compare, compareToBaselines, type BaselineEntry, type Baselines } from "@markforge/fidelity";

export interface FidelityFlags {
  fidelity?: string;
  tolerance?: string;
  /** Measure the round trip through this flavour rather than the default (ADR-0021). */
  mdFlavor?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface FidelityCheckResult {
  ok: boolean;
  measured: BaselineEntry[];
  regressions: Array<{ fixture: string; loop: string; metric: string; baseline: number; measured: number; delta: number }>;
  /** Present in the baselines and absent from this run — a shrinking corpus, not a passing one. */
  missing: string[];
}

/**
 * Runs `md → md` for each input and compares against the committed baselines.
 *
 * One loop rather than all four of SPEC §9.5, and the reason is scope rather than laziness:
 * `check` takes the documents a *user* names, and `docx → md → docx` on an arbitrary Markdown
 * file measures our own writer against itself rather than measuring their document. The
 * repository harness covers the other three loops over the corpus, where the inputs are ours
 * and the comparison means something.
 */
export async function runFidelityCheck(
  paths: string[],
  formatOf: (p: string) => Format | undefined,
  flags: FidelityFlags,
): Promise<{ result: FidelityCheckResult; text: string }> {
  const baselinePath = flags.fidelity as string;
  if (!existsSync(baselinePath)) {
    throw new Error(
      `check --fidelity: no baselines at ${baselinePath}. ` +
        `Generate them with \`node scripts/run-fidelity.mjs --update\`, or point --fidelity at ` +
        `the file your project committed.`,
    );
  }

  const baselines = JSON.parse(await readFile(baselinePath, "utf8")) as Baselines;
  if (typeof flags.tolerance === "string") {
    const parsed = Number(flags.tolerance);
    // A non-numeric tolerance silently becoming NaN would make every comparison pass, because
    // `delta < -NaN` is false. Rejected rather than coerced.
    if (!Number.isFinite(parsed)) throw new Error(`check --fidelity: --tolerance must be a number, got "${flags.tolerance}"`);
    baselines.tolerance = parsed;
  }

  const measured: BaselineEntry[] = [];
  for (const path of paths) {
    const format = formatOf(path);
    if (format === undefined) throw new Error(`check --fidelity: cannot infer a format from ${path}`);
    const bytes = new Uint8Array(await readFile(path));
    const original = (await parse(bytes, format, path)).document;
    const round = await convert(bytes, {
      from: format,
      to: "md",
      path,
      ...(typeof flags.mdFlavor === "string" ? { markdown: { flavor: flags.mdFlavor } } : {}),
    });
    const back = (await parse(round.bytes, "md", path)).document;

    const score = compare(original, back);
    const fixture = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
    measured.push({
      fixture,
      loop: format === "md" ? "md->md" : `${format}->md`,
      structural: score.structural.score,
      textSensitive: score.text.sensitive,
      textInsensitive: score.text.insensitive,
      tableF1: score.table.full.f1,
      tableContentF1: score.table.contentOnly.f1,
      spanF1: score.spans.f1,
    } as BaselineEntry);
  }

  const comparison = compareToBaselines(baselines, measured);
  const result: FidelityCheckResult = {
    ok: comparison.regressions.length === 0,
    measured,
    regressions: comparison.regressions,
    missing: comparison.missing,
  };

  const lines: string[] = [];
  for (const r of comparison.regressions) {
    lines.push(
      `REGRESSION ${r.fixture} ${r.loop} ${r.metric}: ` +
        `${r.baseline.toFixed(4)} -> ${r.measured.toFixed(4)} (${r.delta.toFixed(4)})`,
    );
  }
  // A measurement with no baseline is reported and does not fail: a user checking a document
  // the baselines have never seen is the ordinary case, and exiting 4 for it would make the
  // flag unusable outside this repository.
  const unbaselined = measured.filter(
    (m) => !(baselines.entries ?? []).some((e) => e.fixture === m.fixture && e.loop === m.loop),
  );
  for (const m of unbaselined) lines.push(`no baseline  ${m.fixture} ${m.loop} — measured, not compared`);
  lines.push(
    `${measured.length} measurement(s) against ${baselines.entries?.length ?? 0} baseline(s): ` +
      `${comparison.regressions.length} regression(s), ${unbaselined.length} uncompared.`,
  );

  return { result, text: `${lines.join("\n")}\n` };
}
