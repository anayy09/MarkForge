#!/usr/bin/env node
/**
 * Installs `scripts/hooks/pre-commit` into this clone.
 *
 * Copied rather than symlinked, because Windows without Developer Mode cannot create a
 * symlink and this repository is developed on it. `core.hooksPath` would avoid the copy
 * entirely, but it is repository-global config that overrides every other hook a
 * contributor has installed — a heavier thing to do to someone's clone than writing one
 * file they can delete.
 *
 * Refuses to overwrite a hook it did not write, for the same reason.
 */
import { copyFileSync, existsSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const source = join(REPO, "scripts/hooks/pre-commit");

const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: REPO, encoding: "utf8" }).trim();
const hooksDir = join(REPO, gitDir, "hooks");
const target = join(hooksDir, "pre-commit");

const MARKER = "MarkForge pre-commit hook";

if (existsSync(target) && !readFileSync(target, "utf8").includes(MARKER)) {
  process.stderr.write(
    `install-hooks: ${target} exists and was not written by MarkForge. Left alone.\n` +
      `Merge it by hand, or delete it and re-run.\n`,
  );
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);
process.stdout.write(`Installed ${target}\nBypass a single commit with \`git commit --no-verify\`.\n`);
