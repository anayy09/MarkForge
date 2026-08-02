#!/usr/bin/env node
/**
 * The `markforge` command line interface.
 *
 * All eight subcommands are built as of 2026-08-01: `convert`, `fmt`, `check`, `agentify`,
 * `diff`, `init`, `serve`, and `mcp`. `diff` and `init` were declared-but-refusing for five
 * phases, which was the right behaviour and was not delivery.
 *
 * `--json` emits exactly one object on stdout and sends human output to stderr, so
 * piping is safe.
 */
import { Command, Option } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  ExitCode,
  FLAVORS,
  OUTPUT_FORMATS,
  convert,
  formatMarkdownSync,
  formatFromPath,
  isOutputFormat,
  parse,
  type Assist,
  type Format,
} from "@markforge/core";
import {
  canonicalJsonPretty,
  countNodes,
  validateDocument,
  DiagnosticCode,
  type Diagnostic,
} from "@markforge/ir";
import { readAvailableStyles, reportCoverage } from "@markforge/render-docx";
import { createNodePdfRenderer } from "@markforge/typst-node";
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
  agentifyAssistFrom,
  assistFrom,
  buildSession,
  resolveLlmRequest,
  withLlmOptions,
  type LlmFlags,
} from "./llm-config.js";
import { runAgentify, type AgentifyFlags } from "./agentify-command.js";
import { runDiff } from "./diff-command.js";
import { runInit } from "./init-command.js";
import { runFidelityCheck } from "./fidelity-command.js";
import type { AgentifyAssist } from "@markforge/agentify";

/**
 * ADR-0021's presets, reachable from a shipped surface.
 *
 * The presets were built and gated — `scripts/check-flavor-distinctness.mjs` proves seven of
 * them render one probe seven different ways — and then reached **no command**. A capability
 * only the test suite can call is the shape of defect this phase exists to close, so it is
 * the same list here rather than a second one that can drift from it.
 */
const FLAVOR_NAMES = Object.keys(FLAVORS).sort();

/** Rejects an unknown flavour rather than silently falling back to GFM. */
function mdFlavor(name: string): string {
  if (Object.prototype.hasOwnProperty.call(FLAVORS, name)) return name;
  process.stderr.write(
    `markforge: unknown --md-flavor "${name}". Known flavours: ${FLAVOR_NAMES.join(", ")}
`,
  );
  process.exit(ExitCode.ERROR);
}

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
 * `--no-llm` the default rather than a mode (ADR-0009). The two are independent: `--ocr`
 * is local tesseract and needs no network, `--llm` is the gateway and covers both the
 * vision transcription and heading tie-breaks. Given both, tesseract wins for
 * transcription, because a local recogniser that is already installed should not be
 * silently replaced by a network call.
 */
/**
 * The PDF reader, injected because `@markforge/core` no longer imports it.
 *
 * **Not part of `buildAssist`**, despite travelling in the same object. `Assist` otherwise
 * holds things the user opts into with a flag, and `buildAssist` returns nothing at all
 * unless `--llm` or `--ocr` was given — which is what makes `--no-llm` the default. A PDF
 * reader is not an opt-in: `markforge convert paper.pdf -o paper.md` must work with no
 * flags, so wiring it inside `buildAssist` would have silently broken every plain PDF
 * conversion. It is a *platform capability*, present in the Node build by definition and
 * absent in the browser one.
 *
 * Why it is injected at all: core used to reach `@markforge/adapters-pdf` through
 * `await import(...)`, on the reasoning that a dynamic import is the lazy boundary
 * ADR-0015 asks for. Measured, it is not — a bundler follows a dynamic import like any
 * other, and `splitting: true` decides which *chunk* a module lands in, not whether
 * `node:zlib` resolves. `core` and `@markforge/browser` failed to bundle for a browser
 * under every standard esbuild configuration; the gate only passed because it supplied a
 * stub plugin, so a build-tool flag was standing in for a property of the code. ADR-0017
 * already made the OCR recogniser injected for this exact reason, and `adapters-ocr`
 * bundles cleanly as a result.
 */
const nodePdfReader: NonNullable<Assist["readPdf"]> = async (bytes, options) =>
  (await import("@markforge/adapters-pdf")).readPdf(bytes, options);

/**
 * The PDF writer, the mirror of `nodePdfReader` and injected for the same reason.
 *
 * Also a platform capability rather than an opt-in: `markforge convert report.md -o report.pdf`
 * takes no flag. The compiler and the shipped font set both live in `@markforge/typst-node`,
 * so this surface, the HTTP server, the MCP server, and `scripts/check-pdf-determinism.mjs`
 * all compile through one configuration. Three copies would drift, and when they drift the
 * gate stops measuring the path that ships.
 */
const nodePdfRenderer = createNodePdfRenderer();

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
  // Interpolated rather than spelled out: this string said "(md, docx, html)" while the two
  // error messages below already derived theirs from OUTPUT_FORMATS, so adding a format made
  // the help text wrong and the errors right.
  .option("--to <format>", `output format (${OUTPUT_FORMATS.join(", ")}); inferred from --output otherwise`)
  .option("--from <format>", "input format (md, docx, html, pptx, xlsx, pdf); inferred from the input path otherwise")
  .option("--reference-doc <path>", "DOCX reference document supplying named styles")
  .option("--no-infer", "skip structure inference; evidence stays evidence")
  .option("--explain", "print the inference decision log")
  .option("--emit-ir <path>", "also write the IR as canonical JSON")
  .option("--report <path>", "also write the conversion report as JSON")
  .option("--on-missing-style <mode>", "warn | error | synthesize", "synthesize")
  .option(
    "--md-flavor <name>",
    `Markdown flavour: ${FLAVOR_NAMES.join(", ")} (ADR-0021). Decides which constructs the ` +
      `output can express, so a flavour that cannot hold a footnote reports it.`,
  )
  .option("--json", "emit a machine-readable result on stdout")
  .option("--strict", "exit 2 if anything was lost")
  .option("--quiet", "suppress human output")
  .option(
    "--llm",
    "allow the optional LLM layer: ambiguous heading tie-breaks, and vision transcription " +
      "of a scan. Off unless given",
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

      const result = await convert(bytes, {
        from,
        to,
        // Relative, so the recorded provenance does not embed this machine's
        // directory layout (SPEC §1 forbids absolute paths in output).
        path: relative(process.cwd(), inputPath).replace(/\\/g, "/"),
        infer: opts["infer"] === false ? false : {},
        explain: opts["explain"] === true,
        ...(typeof opts["mdFlavor"] === "string"
          ? { markdown: { flavor: mdFlavor(opts["mdFlavor"]) } }
          : {}),
        docx: {
          onMissingStyle: opts["onMissingStyle"] as "warn" | "error" | "synthesize",
          ...(referenceDoc ? { referenceDoc } : {}),
        },
        // The reader is always present in the Node build; anything the user opted into
        // is layered over it. Merged here rather than inside `buildAssist` so that
        // `--no-llm` staying the default and PDFs being readable stay independent.
        pdf: { render: nodePdfRenderer },
        assist: { readPdf: nodePdfReader, ...assist.assist },
      });

      for (const failure of assistFailures) log(`  ${failure}`, flags);

      /*
       * A failed assist call becomes a real diagnostic, not just a line of prose.
       *
       * `resolveAmbiguities` in `@markforge/infer` swallows the exception with the comment
       * "the caller diagnoses the failure with its own vocabulary (it knows whether this was
       * a budget, transport, or schema problem)". That division of labour is right and the
       * caller only did half of it: these failures went into `llmFailures` and onto stderr,
       * but never into `result.diagnostics` — so `--strict` could not see them,
       * `reportDiagnostics` did not print them, and `MF-LLM-0001` was a code with an
       * emission site for one case and none for this one.
       *
       * Found by `scripts/check-surface-parity.mjs`: pointed at an unreachable endpoint with
       * the ambiguous fixture, `--llm` made four calls, all four failed, and the run exited 0
       * with `ok: true`. SPEC §1.3 requires every degradation to carry a diagnostic, and
       * ADR-0009 says in as many words that a failed call falls back "with a diagnostic".
       *
       * Not `lossy`: nothing was lost. The deterministic answer is the correct answer and it
       * is what `--no-llm` would have produced. What changed is that a capability the user
       * explicitly asked for did not happen, which is a warning.
       */
      for (const failure of assistFailures) {
        result.diagnostics.push({
          code: DiagnosticCode.LLM_CALL_FAILED,
          severity: "warning",
          lossy: false,
          // Nothing was lost — the deterministic answer is correct — but a capability the
          // user explicitly asked for did not happen, and `--strict` keyed on `lossy`
          // alone could never fail on that. See `DiagnosticBag.capabilityUnavailable`.
          degraded: true,
          message:
            `${failure} The deterministic result stands, which is what --no-llm would have ` +
            `produced. Nothing was lost; a requested model opinion was not obtained.`,
          producedBy: { kind: "rule", name: "markforge-cli", version: "0.1.0" },
        });
      }

      await writeFile(resolve(output), result.bytes);

      const lossy = result.diagnostics.filter((d) => d.lossy);
      const strictFailing = result.diagnostics.filter((d) => d.lossy || d.degraded === true);

      /*
       * Asked for the model, got none of it.
       *
       * A single failed call is a degradation the deterministic path absorbs — that is
       * ADR-0009's position and it is unchanged. But when `--llm` was explicitly requested
       * and *every* call failed, the run did not do the thing it was asked to do, and
       * reporting `ok: true` with exit 0 makes that indistinguishable from success in a
       * pipeline. `liveCalls === 0` alongside `failures === calls` is the endpoint being
       * unreachable rather than a model being unhelpful.
       */
      const llmReport = assist.report?.();
      const llmTotallyFailed =
        llmReport !== undefined && llmReport.calls > 0 && llmReport.failures === llmReport.calls;

      /*
       * `--emit-ir` and `--report`, both listed in SPEC section 8's `convert` row since Phase 0
       * and neither implemented until 2026-08-01. Found by trying to use `--emit-ir` while
       * debugging a fixture, which is the same way `check --reference-doc` was found to be
       * described in two specification documents before it existed.
       *
       * The IR is written with `canonicalJsonPretty`: SPEC section 2.7 fixes the canonical form
       * (NFC, sorted keys, absent-vs-null by omission), so two runs produce identical bytes and
       * the file can be diffed. `JSON.stringify` would not guarantee key order.
       */
      if (typeof opts["emitIr"] === "string") {
        await writeFile(resolve(opts["emitIr"] as string), canonicalJsonPretty(result.document), "utf8");
        log(`  IR written to ${opts["emitIr"] as string}`, flags);
      }
      if (typeof opts["report"] === "string") {
        await writeFile(
          resolve(opts["report"] as string),
          JSON.stringify(
            {
              input, output, from, to,
              bytesWritten: result.bytes.byteLength,
              documentId: result.document.id,
              diagnostics: result.diagnostics,
              lossyCount: lossy.length,
              decisions: result.decisions,
              llm: llmReport ?? null,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        log(`  report written to ${opts["report"] as string}`, flags);
      }

      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: !llmTotallyFailed,
              input, output, from, to,
              bytesWritten: result.bytes.byteLength,
              documentId: result.document.id,
              diagnostics: result.diagnostics,
              lossyCount: lossy.length,
              decisions: result.decisions,
              // Present and null when the LLM was off, so a consumer can tell "no model
              // was consulted" from "this build does not report it".
              llm: llmReport ?? null,
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

      if (llmTotallyFailed) {
        fail(
          `--llm was requested and every one of the ${llmReport.calls} model call(s) failed ` +
            `(${llmReport.mode} mode, endpoint unreachable or refusing). The deterministic ` +
            `output was written and is the same result --no-llm would produce, so nothing is ` +
            `wrong with ${output} — but the model was not consulted, and exiting 0 here would ` +
            `make that indistinguishable from success.`,
        );
        process.exit(ExitCode.ERROR);
      }

      // Exit 2 only under --strict: losing something is worth knowing about always,
      // but only worth *failing* on when the user asked.
      process.exit(flags.strict && strictFailing.length > 0 ? ExitCode.STRICT_LOSSY : ExitCode.SUCCESS);
    // degradation: rethrows
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
        const result = formatMarkdownSync(source);
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
    // degradation: rethrows
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
  .option(
    "--fidelity <baselines>",
    "measure the named documents against committed baselines; exit 4 on a regression (SPEC §8)",
  )
  .option("--tolerance <n>", "override the baselines' tolerance for this run")
  .option(
    "--md-flavor <name>",
    `render through this flavour while measuring: ${FLAVOR_NAMES.join(", ")} (ADR-0021)`,
  )
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
      // --- Fidelity against baselines (SPEC §8). The clause that made exit 4 reachable.
      if (typeof opts["fidelity"] === "string") {
        if (paths.length === 0) {
          fail("check --fidelity needs at least one document to measure.");
          process.exit(ExitCode.ERROR);
        }
        const { result, text } = await runFidelityCheck(
          paths.map((p) => resolve(p)),
          (path) => formatFromPath(path),
          opts as never,
        );
        report["fidelity"] = result;
        if (!flags.json && flags.quiet !== true) process.stderr.write(text);
        if (!result.ok) {
          report["ok"] = false;
          exit = ExitCode.FIDELITY_REGRESSION;
        }
      }

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
        // `check` reads PDFs too, so it needs the reader for the same reason `convert`
        // does. Missing it here would have made `markforge check paper.pdf` fail with a
        // "this build has no PDF reader" message on a build that plainly has one.
        const parsed = await parse(bytes, format, file, { readPdf: nodePdfReader });
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
          // `validation.errors` holds objects, not strings, so a bare template literal
          // printed ten lines of `[object Object]` — a message that tells a user their
          // document is invalid and then refuses to say where. Formatted rather than
          // JSON-dumped, because a path and a sentence is what someone acts on.
          for (const error of validation.errors.slice(0, 10)) {
            const where = typeof error === "object" && error !== null && "path" in error
              ? String((error as { path: unknown }).path)
              : "";
            const what = typeof error === "object" && error !== null && "message" in error
              ? String((error as { message: unknown }).message)
              : String(error);
            log(`    ${where}${where ? ": " : ""}${what}`, flags);
          }
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
    // degradation: rethrows
    } catch (error) {
      fail((error as Error).message);
      process.exit(ExitCode.ERROR);
    }
  });

const agentifyCommand = program
  .command("agentify")
  .description("Compile source documents into agent context files (SPEC §10)")
  .argument("<sources...>", "documents or directories to compile")
  .option("--targets <ids>", "comma-separated target profile ids", "claude-md")
  .option("--registry <dir>", "directory of target profile JSON files", "targets")
  .option("--out-dir <dir>", "where output files are written", ".")
  .option("--budget <tokens>", "override every target's primary token budget")
  .option("--manifest <path>", "provenance manifest path", ".markforge/provenance.json")
  .option("--conflicts <mode>", "report | failOnConflict", "report")
  .option("--dry-run", "verify and report, but write nothing")
  .option("--explain-drops", "list every unit and sentence that did not reach an output file")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--strict", "exit 2 if any unit or sentence did not reach an output file")
  .option("--quiet", "suppress human output")
  .option(
    "--llm",
    "allow the optional LLM layer: role classification, prose unit extraction, and " +
      "embedding-based deduplication (SPEC §10.2–10.4). Off unless given",
  )
  .option("--no-llm", "the default: compile deterministically, with no network access")
  /*
   * Hidden on purpose, and not part of the CLI contract.
   *
   * The adjudicated half of §10.4 is a **measured no-op**: with CORPUS §2.14.1's veto active,
   * `--llm` and `--no-llm` produce byte-identical output on every fixture there is, because the
   * veto blocks the one merge the adjudicator proposes. Recall is 0 of 3 on unseen pairs
   * (docs/ROADMAP.md).
   *
   * So this flag exists for re-enablement work and manual experiment, not for users. Listing it
   * in `--help` would advertise a capability that currently does nothing and read as something
   * a user is missing out on. `docs/CLI-CONTRACT.md` records it as explicitly unstable and
   * outside the semver surface, which is the honest place for it — hidden and undocumented
   * would be a different problem.
   */
  .addOption(
    new Option(
      "--dedup-adjudicate",
      "EXPERIMENTAL, unstable, outside the semver surface: run the model adjudication half of " +
        "§10.4. Currently a no-op behind the §2.14.1 veto — see docs/ROADMAP.md",
    ).hideHelp(),
  );
withLlmOptions(agentifyCommand);
agentifyCommand.action(async (sources: string[], opts: Record<string, unknown>) => {
  const flags = opts as GlobalFlags;
  try {
    const request = resolveLlmRequest(process.argv);
    let assist: AgentifyAssist | undefined;
    let llmReport: (() => LlmRunReport) | undefined;
    if (request.enabled) {
      const built = buildSession(opts as LlmFlags);
      // The embedding half always runs under `--llm`; the adjudication half is opt-in.
      // Without `--dedup-adjudicate`, `deduplicate` gets an embedder and no adjudicator, which
      // it already handles by merging nothing and saying so in a diagnostic.
      const adjudicating = opts["dedupAdjudicate"] === true;
      const full = agentifyAssistFrom(built.session);
      assist = adjudicating ? full : { embed: full.embed };
      if (!flags.json) {
        log(built.describe(), flags);
        log(
          adjudicating
            ? "  --dedup-adjudicate: model adjudication is ON. Experimental, unstable, and " +
                "measured as a no-op behind the CORPUS §2.14.1 veto (docs/ROADMAP.md)."
            : "  model adjudication of near-duplicates is off by default (docs/ROADMAP.md); " +
                "pass --dedup-adjudicate to enable it.",
          flags,
        );
      }
      llmReport = () => built.session.report();
    }

    const { result, exit, written } = await runAgentify({
      inputs: sources,
      flags: opts as AgentifyFlags,
      cwd: process.cwd(),
      ...(assist ? { assist } : {}),
      log: (message) => log(message, flags),
    });

    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: result.passed,
            targets: result.report.targets,
            sources: result.report.sources,
            units: result.units.length,
            merges: result.report.merges,
            conflicts: result.conflicts,
            written,
            drops: result.drops,
            diagnostics: result.diagnostics,
            llm: llmReport ? llmReport() : null,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      reportDiagnostics(result.diagnostics, flags);
      if (!result.passed) {
        process.stderr.write(
          `\nmarkforge: the traceability gate failed. SPEC §10.6 makes it mandatory and gives ` +
            `it no bypass flag — there is deliberately no --force. Run with --explain-drops ` +
            `to see every sentence that traced to no context unit.\n`,
        );
      }
    }
    process.exit(exit);
  // degradation: rethrows
  } catch (error) {
    fail((error as Error).message);
    process.exit(ExitCode.ERROR);
  }
});

/**
 * `serve` — the stateless HTTP API of SPEC §8.
 *
 * Binds to loopback unless told otherwise. A converter that accepts a document over the
 * network is exactly the shape ADR-0009 is cautious about, so reaching it from another
 * machine is a thing the operator asks for by typing `--host`, not a default they would
 * have to discover and turn off.
 */
program
  .command("serve")
  .description("Local HTTP API (stateless, no document retention)")
  .option("--port <n>", "port to listen on; 0 picks a free one", "3000")
  .option("--host <addr>", "address to bind; defaults to loopback only", "127.0.0.1")
  .option("--max-body <bytes>", "reject request bodies larger than this", String(32 * 1024 * 1024))
  .option("--allow-origin <origin...>", "CORS origins to permit; none by default")
  .option("--json", "emit the listening address as JSON on stdout")
  .action(async (opts: { port: string; host: string; maxBody: string; allowOrigin?: string[]; json?: boolean }) => {
    const { createServer, ROUTES } = await import("@markforge/http");
    const server = createServer({
      maxBodyBytes: Number(opts.maxBody),
      ...(opts.allowOrigin ? { allowedOrigins: opts.allowOrigin } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(opts.port), opts.host, resolve);
    });

    const address = server.address();
    const bound = typeof address === "object" && address ? `${opts.host}:${address.port}` : opts.host;

    if (opts.json) {
      // stdout stays machine-readable (SPEC §8): exactly one JSON object, human text
      // to stderr. A supervisor reading `.url` to know where we landed on port 0 is
      // the reason this exists.
      process.stdout.write(JSON.stringify({ url: `http://${bound}`, routes: ROUTES }) + "\n");
    } else {
      process.stderr.write(
        `markforge serve: listening on http://${bound}\n` +
          ROUTES.map((r) => `  ${r.method} ${r.path}  — ${r.description}\n`).join("") +
          `Stateless: nothing is written to disk and no document is retained.\n` +
          `No LLM on this surface: @markforge/http does not depend on @markforge/llm.\n`,
      );
    }
  });

/**
 * `mcp` — the MCP server of SPEC §8, over stdio.
 *
 * A separate subcommand from `serve` because they are different protocols on different
 * transports: `serve` is HTTP for a client with a socket, `mcp` is JSON-RPC on stdin and
 * stdout for a coding agent that spawned us. `targets/mcp-manifest.json` used to scaffold
 * `npx -y @markforge/mcp`, which named a package nothing publishes (OPEN_QUESTIONS §5);
 * it now names this command, which exists.
 *
 * Nothing may reach stdout except protocol messages, so this command sets no `--json`
 * flag and prints no banner.
 */
program
  .command("mcp")
  .description("MCP server over stdio, for a coding agent to call at runtime")
  .option("--root <dir>", "the only directory the server may read or write", process.cwd())
  .option("--targets <dir>", "target profile directory; defaults to <root>/targets")
  .action(async (opts: { root: string; targets?: string }) => {
    const { serve } = await import("@markforge/mcp");
    await serve({
      root: resolve(opts.root),
      ...(opts.targets ? { targetsDir: resolve(opts.targets) } : {}),
    });
  });

/*
 * `diff` and `init` — the last two of SPEC section 8's seven, built 2026-08-01.
 *
 * They stood as stubs that refused by name for five phases, which was the right behaviour and
 * was not delivery. `diff` in particular is why `@markforge/fidelity` is a package rather than
 * test-suite code (OPEN_QUESTIONS 7a): that argument named `check` and `diff` as its two
 * consumers, and until now only one of them existed.
 */
program
  .command("diff")
  .description("Semantic IR diff between two documents, not a text diff")
  .argument("<a>", "first document")
  .argument("<b>", "second document")
  .option("--metric", "also print fidelity scores for the pair")
  .option("--json", "emit a machine-readable result on stdout")
  .option("--quiet", "suppress human output")
  .action(async (a, b, opts) => {
    try {
      const { result, text } = await runDiff(a, b, (path) => formatFromPath(path), opts);
      if (opts.json === true) process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      else if (opts.quiet !== true) process.stdout.write(text);
      // Exit 0 whether or not they differ. A diff that exited non-zero on a difference would
      // be unusable in any pipeline that expects to *find* one, which is all of them.
      process.exit(ExitCode.SUCCESS);
    // degradation: rethrows
    } catch (error) {
      fail((error as Error).message);
      process.exit(ExitCode.ERROR);
    }
  });

program
  .command("init")
  .description("Scaffold config and lint config in the current directory")
  .option("--print-config", "print the resolved configuration instead of writing anything")
  .option("--force", "overwrite existing files")
  .option("--json", "emit a machine-readable result on stdout")
  .action(async (opts) => {
    try {
      const { result, text } = await runInit(process.cwd(), opts);
      if (opts.json === true && opts.printConfig !== true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      } else {
        process.stdout.write(text);
      }
      process.exit(ExitCode.SUCCESS);
    // degradation: rethrows
    } catch (error) {
      fail((error as Error).message);
      process.exit(ExitCode.ERROR);
    }
  });

// commander's own async entry point, unrelated to @markforge/core's `parse`.
program.parseAsync(process.argv).catch((error: Error) => {
  fail(error.message);
  process.exit(ExitCode.ERROR);
});
