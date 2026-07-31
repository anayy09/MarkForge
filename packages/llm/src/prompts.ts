/**
 * Prompts are files, not inline strings (SPEC §6.3, brief §7.3).
 *
 * `packages/llm/prompts/<task>/<version>.md`, with two sections — `## System` and
 * `## User` — and `{{placeholder}}` substitution. A file rather than a string literal
 * because a prompt is content: it wants review in a diff, it wants a version, and it
 * should not require a TypeScript rebuild to change.
 *
 * **Both the version and the file's digest go into the cache key.** The version is for
 * humans; the digest is because the version is a promise a human can forget to keep.
 * Editing `v1.md` without renaming it would otherwise serve cached answers that were
 * produced by a prompt no longer in the repository — a silent reproducibility hole in
 * exactly the mechanism that exists to close one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@markforge/ir";

/**
 * Resolved from this module's own URL so it works from `src/` under vitest and from
 * `dist/` in the built package — both are one level below the package root.
 */
const PROMPT_ROOT = fileURLToPath(new URL("../prompts/", import.meta.url));

export interface LoadedPrompt {
  task: string;
  version: string;
  /** sha256 of the file, so an unversioned edit cannot reuse a cached response. */
  digest: string;
  system: string;
  user: string;
}

const cache = new Map<string, LoadedPrompt>();

export function loadPrompt(task: string, version: string): LoadedPrompt {
  const memo = `${task}/${version}`;
  const hit = cache.get(memo);
  if (hit) return hit;

  const path = `${PROMPT_ROOT}${task}/${version}.md`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `llm: no prompt file for task "${task}" version "${version}". Expected ` +
        `packages/llm/prompts/${task}/${version}.md — prompts are files, not inline ` +
        `strings (docs/SPEC.md §6.3).`,
    );
  }

  // Normalised before hashing: a checkout with CRLF line endings must not produce a
  // different cache key from one with LF, or the committed cache would miss on Windows.
  const normalised = text.replace(/\r\n/g, "\n");
  const sections = splitSections(normalised);
  const system = sections.get("system");
  const user = sections.get("user");
  if (system === undefined || user === undefined) {
    throw new Error(
      `llm: prompt ${task}/${version}.md must contain a "## System" and a "## User" ` +
        `section; found ${[...sections.keys()].join(", ") || "neither"}.`,
    );
  }

  const prompt: LoadedPrompt = {
    task,
    version,
    digest: sha256Hex(normalised),
    system,
    user,
  };
  cache.set(memo, prompt);
  return prompt;
}

function splitSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Everything before the first `## ` heading is a comment for the reader, not part
  // of the prompt: it lets a prompt file explain itself without paying tokens for it.
  const parts = text.split(/^## +(.+?) *$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] ?? "").trim().toLowerCase();
    out.set(name, (parts[i + 1] ?? "").trim());
  }
  return out;
}

/**
 * Substitutes `{{name}}` placeholders.
 *
 * An unfilled placeholder throws rather than shipping `{{document}}` to a model,
 * because the model would answer the question it was actually asked and the mistake
 * would look like a model failure rather than a template bug.
 */
export function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`llm: prompt placeholder {{${name}}} has no value`);
    }
    return value;
  });
  return out;
}
