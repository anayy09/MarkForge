#!/usr/bin/env node
/**
 * Every path that can swallow a failure is classified, at the site, in the source.
 *
 * SPEC §1.3: no silent loss — every degradation carries a diagnostic. That was an
 * invariant nobody could check, and one instance means it was never held: `--llm` against
 * an unreachable endpoint produced four failed model calls, no `Diagnostic`, and exit 0.
 * `MF-LLM-0001` existed with an emission site for one case and none for that one.
 *
 * Fixing that one instance is not the fix. This gate enumerates **every `catch` block in
 * every package** and requires each to declare what it does with the failure, in a comment
 * on or immediately above the `catch`:
 *
 *   `// degradation: rethrows`        — the caller sees it. Not silent, nothing to emit.
 *   `// degradation: emits MF-XXX-0000` — swallowed, and a diagnostic is raised. The code
 *                                        must actually appear in the same file.
 *   `// degradation: caller-diagnoses` — swallowed here on purpose because the caller has
 *                                        vocabulary this layer lacks. Must name the caller.
 *   `// degradation: benign — <reason>` — nothing degraded. The reason is the argument, and
 *                                        it is reviewed like any other line of code.
 *
 * An unannotated `catch` fails. That is the point: the next one written has to make the
 * decision, rather than inheriting silence by default.
 *
 * **`caller-diagnoses` is the dangerous one** and it is why this file exists.
 * `resolveAmbiguities` used it — "the caller diagnoses the failure with its own
 * vocabulary" — and the caller did half the job, reporting prose and never a diagnostic.
 * The annotation makes the promise visible; it cannot make the caller keep it, so the
 * ones that matter also have a test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const LIST = process.argv.includes("--list");

const failures = [];
const rows = [];
const ok = (m) => !JSON_OUT && !LIST && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && !LIST && console.log(`  FAIL  ${m}`);
};

const ANNOTATION = /\/\/\s*degradation:\s*(rethrows|emits\s+(MF-[A-Z]+-\d{4})|caller-diagnoses|benign)\b(.*)$/;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const packagesDir = join(REPO, "packages");
const files = readdirSync(packagesDir)
  .map((p) => join(packagesDir, p, "src"))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(sourceFiles);

!JSON_OUT && !LIST && console.log("\n1. Every catch block declares what it does with the failure");

for (const file of files) {
  const rel = file.replaceAll("\\", "/").replace(REPO.replaceAll("\\", "/"), "");
  // `\r` is stripped, not tolerated by the pattern.
  //
  // In JavaScript `.` does not match `\r` — it is a line terminator — so `(.*)$` could
  // neither consume nor match past the carriage return a CRLF checkout leaves on every
  // line. The gate reported all thirty annotations missing on Windows and would have
  // reported all thirty present on Linux, from the same source. A check whose answer
  // depends on the checkout's line endings is not a check, and this is the second time a
  // platform difference has hidden inside one here (STATUS.md records `new URL().pathname`
  // silently skipping a whole test file).
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const wholeFile = lines.join("\n");

  lines.forEach((line, i) => {
    if (!/\}\s*catch\b|^\s*catch\s*[({]/.test(line)) return;

    // The annotation may be on the `catch` line, or on any of the three lines above it —
    // three because a `catch` is often preceded by a closing brace and a blank line.
    const window = [lines[i - 3], lines[i - 2], lines[i - 1], line].filter((l) => l !== undefined);
    const match = window.map((l) => ANNOTATION.exec(l)).find(Boolean);

    if (!match) {
      fail(`${rel}:${i + 1} — catch block with no \`// degradation:\` annotation`);
      rows.push({ file: rel, line: i + 1, kind: null });
      return;
    }

    const kind = match[1].startsWith("emits") ? "emits" : match[1];
    const code = match[2];
    rows.push({ file: rel, line: i + 1, kind, ...(code ? { code } : {}) });

    // `emits` is the only annotation with a checkable consequence: the code it names has
    // to appear in the same file. An annotation that claims an emission the file cannot
    // make is worse than no annotation, because it reads as verified.
    if (kind === "emits" && code) {
      const constant = Object.entries({
        "MF-LLM-0001": "LLM_CALL_FAILED",
        "MF-OCR-0002": "OCR_PAGE_IMAGE_MISSING",
      }).find(([c]) => c === code)?.[1];
      const present = wholeFile.includes(code) || (constant && wholeFile.includes(constant));
      if (!present) {
        fail(`${rel}:${i + 1} — annotated \`emits ${code}\` but neither the code nor its constant appears in the file`);
      }
    }
  });
}

const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind ?? "unannotated"]: (acc[r.kind ?? "unannotated"] ?? 0) + 1 }), {});
if (failures.length === 0) {
  ok(
    `${rows.length} catch block(s) across ${files.length} files, all classified: ` +
      Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", "),
  );
}

// ---------------------------------------------------------------- 2. negative control
!JSON_OUT && !LIST && console.log("\n2. Negative control — an unannotated catch must fail");
{
  const sample = `try { risky(); } catch { return undefined; }`;
  const detected = /\}\s*catch\b|^\s*catch\s*[({]/.test(sample) && !ANNOTATION.test(sample);
  if (detected) ok("an unannotated catch is detected");
  else fail("negative control: an unannotated catch was not detected");

  const annotated = `  // degradation: benign — the value is optional\n  } catch {`;
  const passes = annotated.split("\n").some((l) => ANNOTATION.test(l));
  if (passes) ok("an annotated catch is accepted");
  else fail("negative control: a correctly annotated catch was rejected");

  // And the emits cross-check: an annotation naming a code the file cannot raise.
  const lying = `// degradation: emits MF-ZZZ-9999`;
  const m = ANNOTATION.exec(lying);
  if (m && m[2] === "MF-ZZZ-9999") ok("an `emits` annotation exposes the code it claims, so it can be checked");
  else fail("negative control: the emits annotation did not expose its code");
}

if (LIST) {
  const width = Math.max(...rows.map((r) => r.file.length));
  for (const r of rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`${r.file.padEnd(width)}:${String(r.line).padEnd(5)} ${r.kind ?? "UNANNOTATED"}${r.code ? " " + r.code : ""}`);
  }
} else if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, rows, byKind }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nEvery degrading path is classified at its site.`
      : `\n${failures.length} degradation check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
