/**
 * `markforge diff <a> <b>` — a semantic IR diff, not a text diff (SPEC §8).
 *
 * The distinction is the whole point of the command. `diff a.md b.docx` on the *text* is
 * meaningless, because one is Markdown and the other is a ZIP. On the IR it is answerable, and
 * the answer is in the vocabulary a user cares about: which node types appeared, which
 * vanished, and what that did to the fidelity metrics.
 *
 * `@markforge/fidelity` already had `compare` and `censusDelta` and existed as a package
 * rather than as test-suite code precisely so `check` and `diff` could reach them
 * (`OPEN_QUESTIONS.md` §7a). This command is the second of those two consumers finally
 * arriving; until now `fidelity`'s package-hood was justified by a command that did not exist.
 */
import { readFile } from "node:fs/promises";
import { parse, type Format } from "@markforge/core";
import { compare, censusDelta } from "@markforge/fidelity";
import type { AnyNode } from "@markforge/ir";

export interface DiffFlags {
  metric?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export interface DiffResult {
  ok: boolean;
  /** Node types whose counts differ, in the vocabulary the census reports. */
  census: Array<{ type: string; expected: number; actual: number; delta: number }>;
  metrics?: {
    structural: number;
    textSensitive: number;
    textInsensitive: number;
    tableF1: number;
    spanF1: number;
  };
}

/**
 * Compares two documents.
 *
 * Deliberately **not** symmetric in naming: `a` is treated as the expected side and `b` as the
 * actual, because that is what makes `+3 paragraph` readable as "b gained three" rather than
 * as an unsigned difference the reader has to orient themselves in.
 */
export async function runDiff(
  aPath: string,
  bPath: string,
  formatOf: (p: string) => Format | undefined,
  flags: DiffFlags,
): Promise<{ result: DiffResult; text: string }> {
  const load = async (path: string) => {
    const format = formatOf(path);
    if (format === undefined) {
      throw new Error(`diff: cannot infer a format from ${path}. Use a known extension.`);
    }
    return (await parse(new Uint8Array(await readFile(path)), format, path)).document;
  };

  const [a, b] = await Promise.all([load(aPath), load(bPath)]);

  const delta = censusDelta(a.body as unknown as AnyNode, b.body as unknown as AnyNode)
    .filter((d) => d.expected !== d.actual)
    .map((d) => ({
      type: d.nodeType,
      expected: d.expected,
      actual: d.actual,
      delta: d.actual - d.expected,
    }));

  const result: DiffResult = { ok: delta.length === 0, census: delta };

  if (flags.metric) {
    const s = compare(a, b);
    result.metrics = {
      structural: s.structural.score,
      textSensitive: s.text.sensitive,
      textInsensitive: s.text.insensitive,
      tableF1: s.table.full.f1,
      spanF1: s.spans.f1,
    };
  }

  const lines: string[] = [];
  if (delta.length === 0) {
    lines.push("No structural difference: both documents have the same node-type census.");
  } else {
    lines.push(`${delta.length} node type(s) differ (${aPath} → ${bPath}):`);
    for (const d of delta) {
      const sign = d.delta > 0 ? "+" : "";
      lines.push(`  ${sign}${d.delta}  ${d.type}  (${d.expected} → ${d.actual})`);
    }
  }
  if (result.metrics) {
    const pct = (n: number): string => (n < 0 ? "n/a" : `${(n * 100).toFixed(1)}%`);
    lines.push("");
    lines.push("Fidelity:");
    lines.push(`  structural       ${pct(result.metrics.structural)}`);
    lines.push(`  text (ws-sens)   ${pct(result.metrics.textSensitive)}`);
    lines.push(`  text (ws-insens) ${pct(result.metrics.textInsensitive)}`);
    lines.push(`  table F1         ${pct(result.metrics.tableF1)}`);
    lines.push(`  span F1          ${pct(result.metrics.spanF1)}`);
  }

  return { result, text: `${lines.join("\n")}\n` };
}
