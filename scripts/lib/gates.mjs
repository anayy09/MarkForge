/**
 * One resolver for "which gates run where".
 *
 * Shared so there is one answer, not two that could drift — `check-gate-parity.mjs` asserts
 * the two sides are equal and `check-gates.mjs` documents them, and both must be reading the
 * same sets. Two resolvers for one question is the exact defect the parity gate exists to
 * catch, so building it twice would be an odd way to start.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Every `scripts/<name>.mjs` a string mentions. */
export const scriptPaths = (s) => new Set([...s.matchAll(/scripts\/[\w.-]+\.mjs/g)].map((m) => m[0]));

/**
 * Resolve `pnpm verify` transitively.
 *
 * `verify` is a chain of `pnpm run check:x`, and each of those is a `node scripts/….mjs`.
 * Resolving one level would find nothing, since `verify` itself names no script.
 */
export function verifyGates() {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const out = new Set();
  const seen = new Set();
  const walk = (cmd) => {
    for (const p of scriptPaths(cmd)) out.add(p);
    for (const m of cmd.matchAll(/pnpm run ([\w:-]+)/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (pkg.scripts[name]) walk(pkg.scripts[name]);
    }
  };
  walk(pkg.scripts.verify ?? "");
  return out;
}

/**
 * Resolve `ci.yml`'s **blocking** jobs.
 *
 * `llm-drift` is excluded: it is `continue-on-error: true` by design (SPEC §9 — a live job
 * that fails when someone else's server is busy must not gate), and a non-blocking job is
 * not a gate. Requiring `verify` to match it would be wrong rather than strict.
 */
export function ciGates() {
  const workflow = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
  const driftAt = workflow.indexOf("\n  llm-drift:");
  return scriptPaths(driftAt === -1 ? workflow : workflow.slice(0, driftAt));
}
