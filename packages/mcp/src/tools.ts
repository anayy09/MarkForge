/**
 * The tools this server exposes, and the reason each one is here.
 *
 * SPEC §8: "MCP server so coding agents can call the converter at runtime. This closes the
 * loop: the agent that consumes `CLAUDE.md` can also generate it." So `agentify` is not one
 * tool among several — it is the one the sentence is about, and `convert` and `fmt` are
 * here because an agent that can generate context files should also be able to read the
 * documents they came from.
 *
 * `check`, `diff`, `init`, and `serve` are not exposed. `diff` and `init` do not exist
 * (STATUS.md), and a server that offered to start another server would be a shape nobody
 * asked for.
 *
 * ## No LLM, by construction
 *
 * `--no-llm` is the default on every surface, and here it is not a default that can be
 * overridden: nothing in this package constructs an `Assist` or an `AgentifyAssist`, so
 * there is no argument a client could pass to reach a model. An agent calling this server
 * gets the deterministic pipeline, offline, or it gets a diagnostic.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { convert, parse, formatMarkdownSync, formatFromPath, isOutputFormat, OUTPUT_FORMATS, type Format } from "@markforge/core";
import { createNodePdfRenderer } from "@markforge/typst-node";

/** See `@markforge/http`'s note: module-local, a build property rather than a caller's option. */
const nodePdfRenderer = createNodePdfRenderer();
import type { Diagnostic } from "@markforge/ir";
import { compile, authorityOf, type SourceDocument } from "@markforge/agentify";
import { loadRegistry } from "@markforge/agentify/registry-node";
import { toolError, toolText, type ToolDefinition, type ToolResult } from "./protocol.js";

export interface ToolContext {
  /**
   * The one directory this server may read from or write to.
   *
   * Every path a client supplies is resolved against it and rejected if it escapes.
   * An MCP server runs with its operator's privileges and takes paths from a model, so
   * "the model would not do that" is not a boundary. This is.
   */
  root: string;
  /** Where target profiles live. Defaults to `<root>/targets`. */
  targetsDir?: string;
}

/**
 * Resolves a client-supplied path inside the root, or throws.
 *
 * `resolve` then `relative` rather than string-prefix matching: a prefix test says
 * `/srv/rootless` is inside `/srv/root`, and a `..` segment that normalises back inside is
 * legitimate. The relative path escaping is the actual question.
 */
export function resolveInRoot(root: string, candidate: string): string {
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || resolve(rel) === rel) {
    throw new Error(
      `path "${candidate}" resolves outside the server root. This server reads and writes ` +
        `only within ${root}.`,
    );
  }
  return full;
}

const FORMATS = ["md", "docx", "html", "pptx", "xlsx", "pdf"] as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: "convert",
    title: "Convert a document",
    description:
      "Convert a document between Markdown, DOCX, HTML, and PDF (also reads PPTX and XLSX). " +
      "Deterministic and offline: no model is consulted. Returns the diagnostics too, so a " +
      "degradation is visible rather than silent.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Path to the input document, relative to the server root." },
        output: { type: "string", description: "Path to write, relative to the server root. Omit to return text inline." },
        from: { type: "string", enum: FORMATS, description: "Input format. Inferred from the input extension if omitted." },
        // Derived, not restated. This was a literal `["md","docx","html"]` and would have gone
        // on refusing `pdf` after core gained it — a three-of-four asymmetry no gate reports,
        // because `check-surface-parity.mjs` enumerates its own output list too.
        to: { type: "string", enum: OUTPUT_FORMATS, description: "Output format. Inferred from the output extension if omitted." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  {
    name: "fmt",
    title: "Normalise Markdown",
    description:
      "Normalise Markdown deterministically and idempotently. With check=true it reports " +
      "whether the file would change without writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Path to a Markdown file, relative to the server root." },
        check: { type: "boolean", description: "Report whether formatting is needed instead of writing." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  {
    name: "agentify",
    title: "Compile documents into agent context files",
    description:
      "Compile a set of source documents into agent context files (AGENTS.md, CLAUDE.md, " +
      "Claude skills, and so on). Every sentence emitted traces to a source document; " +
      "unsupported content is dropped and reported. This is the loop-closing tool: the agent " +
      "that reads CLAUDE.md can regenerate it.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Paths to source documents, relative to the server root.",
        },
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Target profile ids, e.g. claude-md, agents-md. Defaults to claude-md.",
        },
        budget: { type: "number", description: "Token budget for the primary file, overriding the profile." },
        dryRun: { type: "boolean", description: "Report what would be written without writing it." },
      },
      required: ["sources"],
      additionalProperties: false,
    },
  },
];

/** Formats diagnostics the way the CLI does, so the two surfaces read alike. */
function describeDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  const lossy = diagnostics.filter((d) => d.lossy);
  const lines = diagnostics.map((d) => `  [${d.severity}] ${d.code}: ${d.message}`);
  return (
    `${diagnostics.length} diagnostic(s), ${lossy.length} lossy:\n${lines.join("\n")}` +
    (lossy.length > 0 ? `\n\nLossy diagnostics mean content did not survive the conversion.` : "")
  );
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "convert":
      return await runConvert(args, ctx);
    case "fmt":
      return await runFmt(args, ctx);
    case "agentify":
      return await runAgentify(args, ctx);
    default:
      return toolError(
        `unknown tool "${name}". This server exposes: ${TOOLS.map((t) => t.name).join(", ")}.`,
      );
  }
}

async function runConvert(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const input = String(args["input"] ?? "");
  if (!input) return toolError("`input` is required");
  const inputPath = resolveInRoot(ctx.root, input);

  const from = (args["from"] as Format | undefined) ?? formatFromPath(input);
  if (!from) return toolError(`cannot infer the input format of "${input}" — pass \`from\``);

  const outputArg = args["output"] ? String(args["output"]) : undefined;
  const to = (args["to"] as Format | undefined) ?? (outputArg ? formatFromPath(outputArg) : "md");
  if (!to) return toolError(`cannot infer the output format of "${outputArg}" — pass \`to\``);
  if (!isOutputFormat(to)) {
    return toolError(`${to} is an input format only — it has no renderer (OPEN_QUESTIONS §7f)`);
  }

  const bytes = new Uint8Array(await readFile(inputPath));
  // No `assist`: this surface has no model path at all. See the module comment. `pdf` is a
  // renderer rather than assistance — no network, no model.
  const result = await convert(bytes, {
    from,
    to,
    pdf: { render: nodePdfRenderer },
    path: input,
  });

  if (outputArg) {
    const outputPath = resolveInRoot(ctx.root, outputArg);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.bytes);
    return toolText(
      `Converted ${input} (${from}) to ${outputArg} (${to}), ${result.bytes.length} bytes.\n\n` +
        describeDiagnostics(result.diagnostics),
    );
  }

  // `pdf` joins `docx` here, and it had to: without it the Buffer below would
  // `toString("utf8")` a PDF and hand the client mojibake that looks like a successful
  // conversion.
  if (to === "docx" || to === "pdf") {
    return toolError(
      `${to} output is binary and cannot be returned inline — pass \`output\` to write it to a file`,
    );
  }
  return toolText(
    Buffer.from(result.bytes).toString("utf8") + `\n\n---\n${describeDiagnostics(result.diagnostics)}`,
  );
}

async function runFmt(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const input = String(args["input"] ?? "");
  if (!input) return toolError("`input` is required");
  const path = resolveInRoot(ctx.root, input);
  const source = await readFile(path, "utf8");
  const formatted = formatMarkdownSync(source);

  if (args["check"] === true) {
    return toolText(
      formatted.changed
        ? `${input} needs formatting.`
        : `${input} is already formatted.`,
    );
  }
  if (!formatted.changed) return toolText(`${input} was already formatted; nothing written.`);
  await writeFile(path, formatted.markdown, "utf8");
  return toolText(`Formatted ${input}.`);
}

async function runAgentify(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const sourcePaths = Array.isArray(args["sources"]) ? (args["sources"] as unknown[]).map(String) : [];
  if (sourcePaths.length === 0) return toolError("`sources` must list at least one document");

  const targetList = args["targets"];
  const targets =
    Array.isArray(targetList) && targetList.length > 0 ? targetList.map(String) : ["claude-md"];
  const dryRun = args["dryRun"] === true;
  const budget = args["budget"];

  const registry = loadRegistry(ctx.targetsDir ?? join(ctx.root, "targets"));

  // Reads every format the ingest path reads, via `parse` from `@markforge/core` — the
  // same entry point the CLI's `agentify` uses. Restricting this tool to Markdown would
  // have been simpler and would have quietly made the MCP surface less capable than the
  // CLI for no reason a caller could see.
  const sources: SourceDocument[] = [];
  for (const p of sourcePaths) {
    const full = resolveInRoot(ctx.root, p);
    const format = formatFromPath(p);
    if (!format) {
      return toolError(`${p}: cannot infer a format from the extension (SPEC §10.1)`);
    }
    const bytes = new Uint8Array(await readFile(full));
    const parsed = await parse(bytes, format, p);
    // Only text-shaped formats carry a source string; decoding a DOCX as UTF-8 would
    // produce noise rather than text, and it is used only to locate nodes.
    const sourceText = format === "md" || format === "html" ? new TextDecoder().decode(bytes) : "";
    sources.push({
      path: p,
      document: parsed.document,
      sourceText,
      role: "unknown",
      authority: authorityOf(sourceText, [], p),
    });
  }

  const result = await compile(sources, {
    registry,
    targets,
    ...(typeof budget === "number" ? { budgetOverride: budget } : {}),
    // No `assist`. Deterministic extraction and rule-based classification only.
  });

  const lines: string[] = [];
  for (const target of result.results) {
    for (const file of target.files) {
      if (!dryRun) {
        const out = resolveInRoot(ctx.root, file.path);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, file.content, "utf8");
      }
      lines.push(`  ${file.path} — ${file.tokens} tokens`);
    }
    lines.push(
      `  ${target.target}: traceability ${(target.verification.traceability * 100).toFixed(1)}%` +
        (target.verification.passed ? "" : "  ** GATE FAILED **"),
    );
  }

  const verdict = result.passed
    ? "All targets passed the traceability gate."
    : "At least one target FAILED the traceability gate (SPEC §10.6, no bypass).";

  return {
    content: [
      {
        type: "text",
        text:
          `${dryRun ? "Would write" : "Wrote"} ${result.results.reduce((n, r) => n + r.files.length, 0)} file(s) ` +
          `from ${sources.length} source(s), ${result.units.length} context unit(s).\n` +
          lines.join("\n") +
          `\n\n${verdict}` +
          (result.drops.length > 0 ? `\n${result.drops.length} sentence(s) dropped as untraceable.` : "") +
          (result.conflicts.conflicts.length > 0
            ? `\n${result.conflicts.conflicts.length} conflict(s) between sources — see the report.`
            : ""),
      },
    ],
    ...(result.passed ? {} : { isError: true }),
  };
}
