/**
 * `markforge agentify` — the Agent Context Compiler's command line (SPEC §8, §10).
 *
 * This file is the composition root for Surface A, in the same sense `buildAssist` is for
 * Surface B: `@markforge/agentify` depends on neither the adapters nor `@markforge/llm`, so
 * ingest (§10.1, "no separate ingestion path") and the optional model help are both wired
 * together here and nowhere else.
 *
 * **Exit 5 has no escape.** SPEC §10.6 gives the traceability gate no bypass flag, so there
 * is no `--force`, no `--no-verify`, and `--traceability` can only be read from config where
 * it is a documented policy rather than a per-run argument. `--dry-run` skips *writing*, not
 * verifying: a dry run that reported success on output the gate would have rejected would
 * be worse than no dry run at all.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  compile,
  loadRegistry,
  renderConflictReport,
  serializeManifest,
  authorityOf,
  type AgentifyAssist,
  type CompileResult,
  type ProvenanceManifest,
  type SourceDocument,
} from "@markforge/agentify";
import { ExitCode, formatFromPath, parse, type Format } from "@markforge/core";

/** Formats agentify will ingest. Everything else in a source directory is skipped. */
const INGESTIBLE = new Set<Format>(["md", "docx", "html", "pptx", "xlsx", "pdf"]);

export interface AgentifyFlags {
  targets?: string;
  registry?: string;
  outDir?: string;
  budget?: string;
  dryRun?: boolean;
  explainDrops?: boolean;
  conflicts?: string;
  json?: boolean;
  quiet?: boolean;
  strict?: boolean;
  manifest?: string;
}

/** Expands directories to their ingestible files; leaves explicit file paths alone. */
export function collectSources(inputs: string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`markforge: no such file or directory: ${input}`);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        const child = join(path, entry);
        if (statSync(child).isDirectory()) continue;
        const format = formatFromPath(entry);
        if (format && INGESTIBLE.has(format)) out.push(child);
      }
    } else {
      out.push(path);
    }
  }
  if (out.length === 0) {
    throw new Error(
      `markforge: no ingestible documents found in ${inputs.join(", ")}. agentify reads ` +
        `${[...INGESTIBLE].join(", ")} (SPEC §10.1 — the same adapters convert uses).`,
    );
  }
  return out;
}

export async function readSources(paths: string[], cwd: string): Promise<SourceDocument[]> {
  const sources: SourceDocument[] = [];
  for (const path of paths) {
    const format = formatFromPath(path);
    if (!format) continue;
    const bytes = new Uint8Array(await readFile(path));
    const relPath = relative(cwd, path).replace(/\\/g, "/");
    const parsed = await parse(bytes, format, relPath);
    // Only text-shaped formats get a source string; it is used to locate nodes and to read
    // a "Last reviewed" line, and decoding a DOCX as UTF-8 would produce neither.
    const sourceText =
      format === "md" || format === "html" ? new TextDecoder().decode(bytes) : "";
    sources.push({
      path: relPath,
      document: parsed.document,
      sourceText,
      role: "unknown",
      authority: authorityOf(sourceText, [], relPath),
    });
  }
  return sources;
}

export interface AgentifyRunOptions {
  inputs: string[];
  flags: AgentifyFlags;
  cwd: string;
  assist?: AgentifyAssist;
  log: (message: string) => void;
}

export async function runAgentify(options: AgentifyRunOptions): Promise<{
  result: CompileResult;
  exit: number;
  written: string[];
}> {
  const { flags, cwd, log } = options;
  const registryDir = resolve(cwd, flags.registry ?? "targets");
  const registry = loadRegistry(registryDir);
  const targets = (flags.targets ?? "claude-md")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const outDir = resolve(cwd, flags.outDir ?? ".");
  const manifestPath = resolve(cwd, flags.manifest ?? ".markforge/provenance.json");

  const paths = collectSources(options.inputs);
  const sources = await readSources(paths, cwd);
  if (!flags.json) log(`${sources.length} source document(s) -> ${targets.join(", ")}`);

  // §10.8: a previous manifest turns a full run into an incremental one. Absent or
  // unreadable is not an error — it is the first run.
  let previous: ProvenanceManifest | undefined;
  if (existsSync(manifestPath)) {
    try {
      previous = JSON.parse(await readFile(manifestPath, "utf8")) as ProvenanceManifest;
    // degradation: rethrows
    } catch {
      previous = undefined;
    }
  }

  const result = await compile(sources, {
    registry,
    targets,
    ...(flags.budget !== undefined ? { budgetOverride: Number(flags.budget) } : {}),
    ...(flags.conflicts === "failOnConflict" ? { conflicts: "failOnConflict" as const } : {}),
    ...(options.assist ? { assist: options.assist } : {}),
    ...(previous ? { previous } : {}),
  });

  const written: string[] = [];
  if (!flags.dryRun) {
    for (const target of result.results) {
      for (const file of target.files) {
        const full = resolve(outDir, file.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, file.content, "utf8");
        written.push(file.path);
      }
    }
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, serializeManifest(result.manifest), "utf8");
    written.push(relative(cwd, manifestPath).replace(/\\/g, "/"));

    // §10.4: "Output: `.markforge/conflicts.json` plus a human-readable section in the run
    // report." Written even when empty, so "no conflicts" is distinguishable from "the
    // conflict stage did not run".
    const conflictsPath = resolve(dirname(manifestPath), "conflicts.json");
    await writeFile(conflictsPath, JSON.stringify(result.conflicts, null, 2) + "\n", "utf8");
    written.push(relative(cwd, conflictsPath).replace(/\\/g, "/"));
  }

  if (!flags.json && !flags.quiet) {
    for (const target of result.report.targets) {
      log(`\n${target.id}  (${target.tier})  tokens counted: ${target.tokenCounter}`);
      for (const file of target.files) {
        log(`  ${file.path}  ${file.tokens} tokens`);
        for (const section of file.sections) {
          log(`      ${section.heading.padEnd(28)} ${String(section.units).padStart(3)} units  ${section.tokens} tokens`);
        }
      }
      log(
        `  traceability ${(target.traceability * 100).toFixed(1)}%` +
          (target.overflowed > 0 ? `, ${target.overflowed} unit(s) in secondary files` : "") +
          (target.dropped > 0 ? `, ${target.dropped} DROPPED` : ""),
      );
    }
    log("\n" + renderConflictReport(result.conflicts));
  }

  if (flags.explainDrops) {
    if (result.drops.length === 0 && result.results.every((r) => r.plan.dropped.length === 0)) {
      log("--explain-drops: nothing was dropped.");
    }
    for (const drop of result.drops) {
      log(`dropped [${drop.reason}] ${drop.file}: ${JSON.stringify(drop.sentence)}`);
    }
    for (const target of result.results) {
      for (const item of target.plan.dropped) {
        log(
          `dropped [budget] ${target.target}: ${JSON.stringify(item.unit.text.slice(0, 90))} ` +
            `(value ${item.value.toFixed(3)}, ${item.tokens} tokens, from ` +
            `${item.unit.sources.map((s) => s.path).join(", ")})`,
        );
      }
    }
  }

  // Exit 5 outranks exit 2. A run that failed the traceability gate also, usually, lost
  // something — reporting only the loss would hide the gate failure behind the smaller
  // problem, and exit 5 is the one a script needs to treat as a build break.
  const lossy = result.diagnostics.filter((d) => d.lossy);
  const exit = !result.passed
    ? ExitCode.TRACEABILITY
    : flags.strict && lossy.length > 0
      ? ExitCode.STRICT_LOSSY
      : ExitCode.SUCCESS;
  return { result, exit, written };
}
