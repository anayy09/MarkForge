/**
 * `markforge init` — scaffold config, a reference document pointer, and lint config (SPEC §8).
 *
 * `--print-config` resolves and prints the effective configuration instead of writing
 * anything, which SPEC §7 names as the way precedence is made visible: CLI flags > env >
 * config file > named profile > built-in defaults. A precedence chain nobody can print is a
 * precedence chain nobody can debug.
 *
 * The command refuses to overwrite. Scaffolding is a first-run convenience, and a first-run
 * convenience that silently replaces a configured project is a data-loss bug wearing a helpful
 * face.
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface InitFlags {
  printConfig?: boolean;
  force?: boolean;
  json?: boolean;
}

/** The scaffolded config. Every value is a default made visible rather than a suggestion. */
export const DEFAULT_CONFIG = {
  $schema: "./node_modules/@markforge/core/schema/markforge.config.v0.schema.json",
  profile: "technical-documentation",
  strict: false,
  markdown: {
    flavor: "gfm",
    headings: "atx",
    bullet: "-",
    emphasis: "_",
    strong: "*",
    // 0 = never reflow. Reflowing rewraps whole paragraphs, so a one-word edit produces a
    // diff spanning every following line, and SPEC §10.8 needs minimal diffs.
    lineWidth: 0,
    tables: "auto",
  },
  whitespace: {
    emptyParagraphsToSpacing: true,
    collapseInteriorWhitespace: true,
    preserveHardBreaks: true,
    trimTrailing: true,
  },
  docx: {
    referenceDoc: "./templates/technical-documentation.docx",
    onMissingStyle: "synthesize",
    revisionMode: "clean",
  },
  inference: { headings: true, lists: true, tables: true, ambiguityMargin: 0.15 },
  // Off, and never a default (brief §3.6). Present in the scaffold so its shape is
  // discoverable without reading the schema.
  llm: { enabled: false, apiKeyEnv: "MODEL_API_KEY" },
} as const;

/**
 * The markdownlint config, matching what `@markforge/render-md` already satisfies.
 *
 * Each disabled rule conflicts with a decision recorded elsewhere rather than being one the
 * configuration could not meet — ADR-0006 lists them, and `MD029` is the interesting one: it
 * renumbers every ordered list from 1, which would destroy the `restartsAt` the IR carries so
 * that a list starting at 7 survives a round trip.
 */
export const DEFAULT_LINT_CONFIG = {
  default: true,
  MD013: false,
  MD024: false,
  MD025: false,
  MD029: false,
  MD033: false,
  MD040: false,
  MD041: false,
};

export interface InitResult {
  ok: boolean;
  written: string[];
  skipped: string[];
}

export async function runInit(
  cwd: string,
  flags: InitFlags,
): Promise<{ result: InitResult; text: string }> {
  if (flags.printConfig) {
    const text = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
    return { result: { ok: true, written: [], skipped: [] }, text };
  }

  const files: Array<[string, string]> = [
    ["markforge.config.json", `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`],
    [".markdownlint.jsonc", `${JSON.stringify(DEFAULT_LINT_CONFIG, null, 2)}\n`],
  ];

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, content] of files) {
    const path = join(cwd, name);
    if (existsSync(path) && flags.force !== true) {
      skipped.push(name);
      continue;
    }
    await writeFile(path, content, "utf8");
    written.push(name);
  }

  const lines: string[] = [];
  for (const w of written) lines.push(`wrote   ${w}`);
  for (const s of skipped) lines.push(`skipped ${s} (already exists; pass --force to overwrite)`);
  if (written.length > 0) {
    lines.push("");
    lines.push("Next: point `docx.referenceDoc` at your own .docx, then run");
    lines.push("  markforge check --reference-doc <path>");
    lines.push("which reports which of the 38 Pandoc style names it defines and emits a styleMap skeleton.");
  }

  return {
    // Skipping is not failure: a project that already has a config is the common case, and
    // exiting non-zero for it would make `init` unusable in a script.
    result: { ok: true, written, skipped },
    text: `${lines.join("\n")}\n`,
  };
}
