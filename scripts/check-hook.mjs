#!/usr/bin/env node
/**
 * Runs the pre-commit hook, in a real repository, against real commits.
 *
 * A hook that ships and is never executed is the same thing as a hook that does not work:
 * nobody finds out until a contributor installs it, and what they find out is that our
 * tooling is broken. So this gate builds a throwaway git repository, installs the hook,
 * and drives it through four commits:
 *
 *   1. a badly formatted Markdown file      → must be **rejected**
 *   2. the same file, formatted             → must be **accepted**
 *   3. a file that is not Markdown          → must be **ignored**
 *   4. staged-formatted, working-tree-messy → must be **accepted**
 *
 * Case 4 is the one worth having: it is the difference between a hook that reads the index
 * and one that reads the working tree, and it is invisible to any test that stages and
 * commits in one motion.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const HOOK = join(REPO, "scripts/hooks/pre-commit");
const CLI = join(REPO, "packages/cli/dist/index.js");
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

// `sh` is required to run the hook. Git for Windows ships it, and CI is Linux; if it is
// genuinely absent the gate says so rather than passing quietly.
const sh = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
if (sh.error) {
  console.error("check-hook: no POSIX sh available to run the hook. This gate cannot pass vacuously.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "markforge-hook-"));
const git = (...args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Commits, returning the hook's exit status rather than throwing. */
function commit(message) {
  const r = spawnSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

try {
  git("init", "--quiet");
  git("config", "user.email", "gate@markforge.test");
  git("config", "user.name", "Gate");
  git("config", "commit.gpgsign", "false");

  mkdirSync(join(dir, ".git/hooks"), { recursive: true });
  copyFileSync(HOOK, join(dir, ".git/hooks/pre-commit"));
  chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
  // The hook resolves the CLI from its own repository root, which in this throwaway is not
  // MarkForge. `MARKFORGE_BIN` is the seam the hook declares for exactly this.
  git("config", "core.hooksPath", ".git/hooks");
  process.env["MARKFORGE_BIN"] = `node ${CLI.replace(/\\/g, "/")}`;

  // 1. Unformatted Markdown is rejected.
  writeFileSync(join(dir, "a.md"), "#    Title\n\n*  item\n");
  git("add", "a.md");
  const bad = commit("unformatted");
  if (bad.status !== 0 && /not formatted/.test(bad.out)) ok("an unformatted staged file is rejected");
  else fail(`an unformatted staged file was committed (status ${bad.status}): ${bad.out.trim().slice(0, 200)}`);

  // 2. The same file, formatted, is accepted.
  writeFileSync(join(dir, "a.md"), "# Title\n\n- item\n");
  git("add", "a.md");
  const good = commit("formatted");
  if (good.status === 0) ok("a formatted staged file is accepted");
  else fail(`a formatted file was rejected (status ${good.status}): ${good.out.trim().slice(0, 300)}`);

  // 3. A non-Markdown file is not the hook's business.
  writeFileSync(join(dir, "notes.txt"), "#    not markdown\n*  and not checked\n");
  git("add", "notes.txt");
  const other = commit("txt");
  if (other.status === 0) ok("a non-Markdown file is ignored");
  else fail(`a .txt file was rejected (status ${other.status}): ${other.out.trim().slice(0, 200)}`);

  // 4. The index, not the working tree.
  writeFileSync(join(dir, "b.md"), "# Staged\n\n- clean\n");
  git("add", "b.md");
  writeFileSync(join(dir, "b.md"), "#     working tree is a mess\n\n*   and unstaged\n");
  const staged = commit("staged content only");
  if (staged.status === 0) ok("the hook reads the index, not the working tree");
  else
    fail(
      `a clean *staged* file was rejected because the working tree was dirty (status ${staged.status}) ` +
        `— the hook is reading the wrong side: ${staged.out.trim().slice(0, 200)}`,
    );

  // 5. Negative control on the control: if the hook were not installed at all, case 1 would
  //    have "passed" for the wrong reason. Prove the rejection came from the hook.
  rmSync(join(dir, ".git/hooks/pre-commit"));
  writeFileSync(join(dir, "c.md"), "#    Title\n\n*  item\n");
  git("add", "c.md");
  const uninstalled = commit("no hook");
  if (uninstalled.status === 0) ok("with the hook removed, the same content commits — case 1 was the hook");
  else fail("removing the hook did not change the outcome, so case 1 proved nothing");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
else console.log(failures.length === 0 ? "\nPre-commit hook verified on a real repository." : `\n${failures.length} failure(s).`);
process.exit(failures.length === 0 ? 0 : 1);
