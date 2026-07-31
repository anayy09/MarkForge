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
  convertAsync,
  formatMarkdown,
  formatFromPath,
  isOutputFormat,
  parseAsync,
  type Assist,
  type Format,
} from "@markforge/core";
import { countNodes, validateDocument, type Diagnostic } from "@markforge/ir";
import { readAvailableStyles, reportCoverage } from "@markforge/render-docx";
import { createTesseractRecognizer } from "@markforge/adapters-ocr";
import {
  CAPABILITIES_PATH,
  ChatClient,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODELS,
  probeCapabilities,
  resolveApiKey,
  saveCapabilities,
  type LlmRunReport,
} from "@markforge/llm";
import {
  assistFrom,
  buildSession,
  resolveLlmRequest,
  withLlmOptions,
  type LlmFlags,
} from "./llm-config.js";

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

/**
 * Reports an error once, with exactly one `markforge:` prefix.
 *
 * Some library messages name the tool because they are also read by API users, and this
 * function used to be a bare template string — so those arrived as
 * "markforge: markforge: the LLM is enabled but…". Fixed here rather than by editing every
 * message, because the next message to name the tool would reintroduce it.
 */
function fail(message: string): void {
  process.stderr.write(
    (message.startsWith("markforge:") ? message : `markforge: ${message}`) + "\n",
  );
}

/**
 * Assembles the optional assistance from the flags as typed.
 *
 * Returns nothing at all unless `--llm` or `--ocr` was given, which is what makes
 * `--no-llm` the default rather than a mode (brief §3.6). The two are independent: `--ocr`
 * is local tesseract and needs no network, `--llm` is the gateway and covers both the
 * vision transcription and heading tie-breaks. Given both, tesseract wins for
 * transcription, because a local recogniser that is already installed should not be
 * silently replaced by a network call.
 */
function buildAssist(
  opts: Record<string, unknown>,
  argv: string[],
  failures: string[],
): { assist?: Assist; describe?: string; report?: () => LlmRunReport } {
  const request = resolveLlmRequest(argv);
  const wantsOcr = opts["ocr"] === true;
  if (!request.enabled && !wantsOcr) return {};

  const onFailure = (context: { task: string; nodeOrPage: string; reason: string; message: string }): void => {
    failures.push(
      `llm ${context.task} did not answer for ${context.nodeOrPage} (${context.reason}): ` +
        `${context.message}`,
    );
  };

  const assist: Assist = {};
  let describe: string | undefined;
  let report: (() => LlmRunReport) | undefined;

  if (request.enabled) {
    const built = buildSession(opts as LlmFlags);
    const wired = assistFrom(built, onFailure);
    assist.headingTiebreak = wired.headingTiebreak;
    if (!wantsOcr) assist.recognize = wired.recognize;
    describe = built.describe();
    report = () => built.session.report();
  }

  if (wantsOcr) {
    assist.recognize = createTesseractRecognizer({
      ...(typeof opts["tessdata"] === "string" ? { langPath: opts["tessdata"] } : {}),
    });
  }

  return {
    assist,
    ...(describe !== undefined ? { describe } : {}),
    ...(report !== undefined ? { report } : {}),
  };
}

/**
 * Two throwaway calls that ask the endpoint what it supports, then remember the answer.
 *
 * The result goes to `.markforge/llm-capabilities.json`, which is gitignored: it describes
 * one deployment at one moment, and committing it would make a colleague inherit a claim
 * about a gateway they may not be pointed at.
 */
async function probeEndpoint(
  flags: LlmFlags,
  global: GlobalFlags,
): Promise<{ guidedDecoding: boolean; seed: boolean; evidence: string[]; savedTo: string }> {
  const baseUrl = flags.llmBaseUrl ?? DEFAULT_BASE_URL;
  const apiKeyEnv = flags.llmApiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const model = flags.llmModelFast ?? DEFAULT_MODELS.fast;
  // Required here with no readOnly escape: a probe is a network call by definition, so
  // there is nothing it could do without a key.
  const apiKey = resolveApiKey(apiKeyEnv, { required: true })!;

  log(`probing ${baseUrl} with ${model} (two throwaway calls)...`, global);
  const capabilities = await probeCapabilities(new ChatClient({ baseUrl, apiKey }), baseUrl, model);
  saveCapabilities(CAPABILITIES_PATH, capabilities);

  if (!global.json) {
    for (const line of capabilities.evidence) log(`  ${line}`, global);
    log(`  recorded in ${CAPABILITIES_PATH}`, global);
  }
  return {
    guidedDecoding: capabilities.guidedDecoding,
    seed: capabilities.seed,
    evidence: capabilities.evidence,
    savedTo: CAPABILITIES_PATH,
  };
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

const convertCommand = program
  .command("convert")
  .description("Convert a document between formats")
  .argument("<input>", "input file")
  .requiredOption("-o, --output <path>", "output file")
  .option("--to <format>", "output format (md, docx, html); inferred from --output otherwise")
  .option("--from <format>", "input format (md, docx, html, pptx, xlsx, pdf); inferred from the input path otherwise")
  .option("--reference-doc <path>", "DOCX reference document supplying named styles")
  .option("--no-infer", "skip structure inference; evidence stays evidence")
  .option("--explain", "print the inference decision log")
  .option("--on-missing-style <mode>", "warn | error | synthesize", "synthesize")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--strict", "exit 2 if anything was lost")
  .option("--quiet", "suppress human output")
  .option(
    "--llm",
    "allow the optional LLM layer: ambiguous heading tie-breaks, and vision transcription " +
      "of a scan. Off unless given (brief §3.6)",
  )
  .option("--ocr", "transcribe a scanned PDF locally with tesseract (needs --tessdata)")
  .option("--tessdata <dir>", "directory holding <lang>.traineddata for --ocr")
  .option("--no-llm", "the default: convert deterministically, with no network access");
withLlmOptions(convertCommand);
convertCommand
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

      // Assistance is assembled here, in the composition root, and is empty unless the
      // user asked for it. `assistFailures` collects what went wrong so a failed call
      // becomes a reported diagnostic rather than a silently deterministic result.
      const assistFailures: string[] = [];
      const assist = buildAssist(opts, process.argv, assistFailures);
      if (assist.describe && !flags.json) log(assist.describe, flags);

      const result = await convertAsync(bytes, {
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
        ...(assist.assist ? { assist: assist.assist } : {}),
      });

      for (const failure of assistFailures) log(`  ${failure}`, flags);

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
              // Present and null when the LLM was off, so a consumer can tell "no model
              // was consulted" from "this build does not report it".
              llm: assist.report ? assist.report() : null,
              llmFailures: assistFailures,
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
      fail((error as Error).message);
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
      fail((error as Error).message);
      process.exit(ExitCode.ERROR);
    }
  });

const checkCommand = program
  .command("check")
  .description("Validate documents, a DOCX reference document, and the LLM endpoint")
  .argument("[paths...]", "documents to parse and validate against the IR schema")
  .option("--reference-doc <path>", "report which named styles a DOCX template defines")
  .option("--llm", "probe the endpoint for guided decoding and seed support, and record it")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--strict", "exit 2 if a document reports a lossy diagnostic")
  .option("--quiet", "suppress human output");
withLlmOptions(checkCommand);
checkCommand
  .action(async (paths: string[], opts: Record<string, unknown>) => {
    const flags = opts as GlobalFlags;
    const report: Record<string, unknown> = { ok: true };
    let exit: number = ExitCode.SUCCESS;

    try {
      // --- Reference document coverage (SPEC §4.2.1, TEMPLATES.md §2.2).
      if (typeof opts["referenceDoc"] === "string") {
        const path = resolve(opts["referenceDoc"]);
        if (!existsSync(path)) {
          process.stderr.write(`markforge: no such file: ${opts["referenceDoc"]}\n`);
          process.exit(ExitCode.ERROR);
        }
        const styles = readAvailableStyles(new Uint8Array(await readFile(path)));
        const coverage = reportCoverage(styles);
        report["referenceDoc"] = {
          path: opts["referenceDoc"],
          stylesDefined: styles.length,
          pandocNamesDefined: coverage.defined,
          pandocNamesMissing: coverage.missing,
          total: coverage.total,
          styleMap: coverage.skeleton,
        };
        if (!flags.json) {
          log(
            `${opts["referenceDoc"]}: ${styles.length} named style(s); ` +
              `${coverage.defined.length} of ${coverage.total} Pandoc names defined.`,
            flags,
          );
          // The skeleton, not just a count: measured against real templates, most define a
          // small minority of these names (OPEN_QUESTIONS §4), so adapting one has to be an
          // edit rather than an investigation.
          log(`\n  Paste into markforge.config docx.styleMap, filling the blanks:`, flags);
          for (const [role, name] of Object.entries(coverage.skeleton)) {
            log(`    ${JSON.stringify(role)}: ${JSON.stringify(name)},`, flags);
          }
          if (coverage.missing.length > 0) {
            log(
              `\n  Not defined by this template: ${coverage.missing.join(", ")}.\n` +
                `  Roles mapped to these fall back to onMissingStyle (default: synthesize, ` +
                `deriving from the template's own docDefaults).`,
              flags,
            );
          }
        }
      }

      // --- Endpoint capability probe (SPEC §6.3, OPEN_QUESTIONS §3).
      if (opts["llm"] === true) {
        const probe = await probeEndpoint(opts as LlmFlags, flags);
        report["llm"] = probe;
        if (!probe.guidedDecoding) {
          // Not a failure: the repair loop covers it. But it is a quality difference the
          // run report must state rather than absorb (ADR-0009 consequences).
          log(
            `\n  Guided decoding is unavailable on this endpoint, so structured output ` +
              `relies on the prompt plus the repair loop.`,
            flags,
          );
        }
      }

      // --- Document validation.
      const documents: Record<string, unknown>[] = [];
      for (const file of paths) {
        const path = resolve(file);
        if (!existsSync(path)) {
          process.stderr.write(`markforge: no such file: ${file}\n`);
          process.exit(ExitCode.ERROR);
        }
        const format = formatFromPath(file);
        if (!format) {
          process.stderr.write(
            `markforge: cannot tell the format of "${file}" from its extension.\n`,
          );
          process.exit(ExitCode.ERROR);
        }
        const bytes = new Uint8Array(await readFile(path));
        const parsed = await parseAsync(bytes, format, file);
        const validation = validateDocument(parsed.document);
        const lossy = parsed.diagnostics.lossy();
        documents.push({
          file,
          format,
          valid: validation.valid,
          errors: validation.errors,
          nodes: countNodes(parsed.document.body as never),
          lossyCount: lossy.length,
          diagnostics: parsed.diagnostics.all(),
        });
        if (!flags.json) {
          log(
            `${file}: ${validation.valid ? "valid IR" : "INVALID IR"}, ` +
              `${countNodes(parsed.document.body as never)} node(s), ` +
              `${lossy.length} lossy diagnostic(s)`,
            flags,
          );
          for (const error of validation.errors.slice(0, 10)) log(`    ${error}`, flags);
        }
        if (!validation.valid) exit = ExitCode.ERROR;
        else if (flags.strict && lossy.length > 0 && exit === ExitCode.SUCCESS) {
          exit = ExitCode.STRICT_LOSSY;
        }
      }
      if (documents.length > 0) report["documents"] = documents;

      if (
        paths.length === 0 &&
        opts["referenceDoc"] === undefined &&
        opts["llm"] !== true
      ) {
        // Nothing asked for. Saying so beats exiting 0 on a command that did nothing,
        // and naming the corpus harness is the honest boundary of what `check` covers.
        process.stderr.write(
          `markforge check: nothing to check. Pass document paths, --reference-doc <path>, ` +
            `or --llm.\n` +
            `Corpus fidelity baselines are a separate, committed harness: run ` +
            `\`node scripts/run-fidelity.mjs --check\` (exit 4 on regression).\n`,
        );
        process.exit(ExitCode.ERROR);
      }

      report["ok"] = exit === ExitCode.SUCCESS;
      if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(exit);
    } catch (error) {
      fail((error as Error).message);
      process.exit(ExitCode.ERROR);
    }
  });

// The remaining SPEC §8 subcommands. Declared so `--help` tells the truth about the
// intended surface, and each one refuses rather than silently doing nothing.
for (const [name, description, phase] of [
  ["agentify", "Compile documents into agent context files", "Phase 4"],
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
  fail(error.message);
  process.exit(ExitCode.ERROR);
});
