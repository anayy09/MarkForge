#!/usr/bin/env node
/**
 * The `markforge` command line interface.
 *
 * Phase 1 ships `convert` and `fmt` (brief §11). The other five subcommands in
 * SPEC §8 are declared but refuse rather than pretend: a command that silently does
 * nothing is worse than one that says it does not exist yet.
 *
 * `--json` emits exactly one object on stdout and sends human output to stderr, so
 * piping is safe.
 */
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  ExitCode,
  OUTPUT_FORMATS,
  convert,
  formatMarkdown,
  formatFromPath,
  isOutputFormat,
  type Format,
} from "@markforge/core";
import type { Diagnostic } from "@markforge/ir";

const program = new Command();

program
  .name("markforge")
  .description("Fidelity-preserving document conversion and Markdown formatting")
  .version("0.1.0");

interface GlobalFlags {
  json?: boolean;
  strict?: boolean;
  quiet?: boolean;
}

/** stderr, so `--json` output on stdout stays machine-readable. */
function log(message: string, flags: GlobalFlags): void {
  if (!flags.quiet) process.stderr.write(message + "\n");
}

function reportDiagnostics(diagnostics: Diagnostic[], flags: GlobalFlags): void {
  if (flags.json || flags.quiet) return;
  const lossy = diagnostics.filter((d) => d.lossy);
  if (lossy.length === 0) return;
  process.stderr.write(`\n${lossy.length} lossy diagnostic(s):\n`);
  for (const d of lossy.slice(0, 20)) {
    process.stderr.write(`  ${d.severity.padEnd(7)} ${d.code}  ${d.message}\n`);
  }
  if (lossy.length > 20) process.stderr.write(`  ...and ${lossy.length - 20} more\n`);
}

program
  .command("convert")
  .description("Convert a document between formats")
  .argument("<input>", "input file")
  .requiredOption("-o, --output <path>", "output file")
  .option("--to <format>", "output format (md, docx, html); inferred from --output otherwise")
  .option("--from <format>", "input format (md, docx, html, pptx, xlsx); inferred from the input path otherwise")
  .option("--reference-doc <path>", "DOCX reference document supplying named styles")
  .option("--no-infer", "skip structure inference; evidence stays evidence")
  .option("--explain", "print the inference decision log")
  .option("--on-missing-style <mode>", "warn | error | synthesize", "synthesize")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--strict", "exit 2 if anything was lost")
  .option("--quiet", "suppress human output")
  .action(async (input: string, opts: Record<string, unknown>) => {
    const flags = opts as GlobalFlags;
    try {
      const inputPath = resolve(input);
      if (!existsSync(inputPath)) {
        process.stderr.write(`markforge: no such file: ${input}\n`);
        process.exit(ExitCode.ERROR);
      }

      const output = String(opts["output"]);
      const from = (opts["from"] as Format | undefined) ?? formatFromPath(input);
      const to = (opts["to"] as Format | undefined) ?? formatFromPath(output);

      if (!from) {
        process.stderr.write(
          `markforge: cannot tell the input format from "${input}". ` +
            `Pass --from md|docx|html|pptx|xlsx.\n`,
        );
        process.exit(ExitCode.ERROR);
      }
      if (!to) {
        process.stderr.write(
          `markforge: cannot tell the output format from "${output}". ` +
            `Pass --to ${OUTPUT_FORMATS.join("|")}.\n`,
        );
        process.exit(ExitCode.ERROR);
      }
      // Caught here rather than in the renderer so the message names the flag the
      // user typed, not an internal function.
      if (!isOutputFormat(to)) {
        process.stderr.write(
          `markforge: ${to} is an input format only — MarkForge reads it but does not ` +
            `generate it. Pass --to ${OUTPUT_FORMATS.join("|")}.\n`,
        );
        process.exit(ExitCode.ERROR);
      }

      const bytes = new Uint8Array(await readFile(inputPath));
      const referenceDocPath = opts["referenceDoc"] as string | undefined;
      const referenceDoc = referenceDocPath
        ? new Uint8Array(await readFile(resolve(referenceDocPath)))
        : undefined;

      const result = convert(bytes, {
        from,
        to,
        // Relative, so the recorded provenance does not embed this machine's
        // directory layout (SPEC §1 forbids absolute paths in output).
        path: relative(process.cwd(), inputPath).replace(/\\/g, "/"),
        infer: opts["infer"] === false ? false : {},
        explain: opts["explain"] === true,
        docx: {
          onMissingStyle: opts["onMissingStyle"] as "warn" | "error" | "synthesize",
          ...(referenceDoc ? { referenceDoc } : {}),
        },
      });

      await writeFile(resolve(output), result.bytes);

      const lossy = result.diagnostics.filter((d) => d.lossy);

      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              input, output, from, to,
              bytesWritten: result.bytes.byteLength,
              documentId: result.document.id,
              diagnostics: result.diagnostics,
              lossyCount: lossy.length,
              decisions: result.decisions,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        log(`${input} -> ${output}  (${result.bytes.byteLength} bytes)`, flags);
        if (result.explanation) process.stderr.write("\n" + result.explanation);
        reportDiagnostics(result.diagnostics, flags);
      }

      // Exit 2 only under --strict: losing something is worth knowing about always,
      // but only worth *failing* on when the user asked.
      process.exit(flags.strict && lossy.length > 0 ? ExitCode.STRICT_LOSSY : ExitCode.SUCCESS);
    } catch (error) {
      process.stderr.write(`markforge: ${(error as Error).message}\n`);
      process.exit(ExitCode.ERROR);
    }
  });

program
  .command("fmt")
  .description("Normalise Markdown files in place")
  .argument("<files...>", "files to format")
  .option("--check", "do not write; exit 3 if any file would change")
  .option("--write", "write changes (default when --check is absent)")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--quiet", "suppress human output")
  .action(async (files: string[], opts: Record<string, unknown>) => {
    const flags = opts as GlobalFlags;
    const check = opts["check"] === true;
    const results: { file: string; changed: boolean }[] = [];

    try {
      for (const file of files) {
        const path = resolve(file);
        if (!existsSync(path)) {
          process.stderr.write(`markforge: no such file: ${file}\n`);
          process.exit(ExitCode.ERROR);
        }
        const source = await readFile(path, "utf8");
        const result = formatMarkdown(source);
        results.push({ file, changed: result.changed });

        if (result.changed && !check) {
          await writeFile(path, result.markdown, "utf8");
        }
      }

      const changed = results.filter((r) => r.changed);

      if (flags.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, mode: check ? "check" : "write", results, changedCount: changed.length }, null, 2) + "\n",
        );
      } else if (check) {
        for (const r of changed) log(`would reformat ${r.file}`, flags);
        log(
          changed.length === 0
            ? `${results.length} file(s) already formatted`
            : `${changed.length} of ${results.length} file(s) need formatting`,
          flags,
        );
      } else {
        for (const r of changed) log(`formatted ${r.file}`, flags);
        log(`${changed.length} of ${results.length} file(s) changed`, flags);
      }

      process.exit(check && changed.length > 0 ? ExitCode.NEEDS_FORMATTING : ExitCode.SUCCESS);
    } catch (error) {
      process.stderr.write(`markforge: ${(error as Error).message}\n`);
      process.exit(ExitCode.ERROR);
    }
  });

// The remaining SPEC §8 subcommands. Declared so `--help` tells the truth about the
// intended surface, and each one refuses rather than silently doing nothing.
for (const [name, description, phase] of [
  ["agentify", "Compile documents into agent context files", "Phase 4"],
  ["check", "Validate IR, config, and fidelity baselines", "Phase 1 (partial)"],
  ["diff", "Semantic IR diff between two documents", "Phase 2"],
  ["serve", "Local HTTP API", "Phase 5"],
  ["init", "Scaffold config and reference documents", "Phase 2"],
] as const) {
  program
    .command(name)
    .description(`${description} (not yet implemented — ${phase})`)
    .allowUnknownOption()
    .action(() => {
      process.stderr.write(
        `markforge ${name}: not implemented yet (${phase}).\n` +
          `Phase 1 ships \`convert\` and \`fmt\`. See docs/SPEC.md §8 for the full surface.\n`,
      );
      process.exit(ExitCode.ERROR);
    });
}

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`markforge: ${error.message}\n`);
  process.exit(ExitCode.ERROR);
});
