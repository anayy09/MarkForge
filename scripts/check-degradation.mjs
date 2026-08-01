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
 *
 * ## The `emits` cross-check was vacuous, and that is worth its own paragraph
 *
 * It asked `wholeFile.includes(code)` — over a file that contains the annotation making the
 * claim. Every `emits` annotation therefore satisfied its own cross-check by existing, and
 * one was wrong from the day it was written: `adapters-pdf/src/pages.ts` claimed
 * `emits MF-PDF-0004`, a code no `DiagnosticCode` entry defines. The real one is
 * `MF-PDF-0002`. A check that cannot fail did not catch it, and the negative control below
 * did not either, because it only asserted the regex *exposed* the code and never ran the
 * presence test on it.
 *
 * So the search now excludes annotation lines, and the code is resolved against the
 * `DiagnosticCode` table parsed out of `packages/ir/src/diagnostics.ts` rather than a
 * two-entry map maintained here — a hand-written table describing generated data is the
 * same defect one layer up.
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

/**
 * Every diagnostic code the IR actually defines, `MF-XXX-0000` → `CONSTANT_NAME`.
 *
 * Read out of the source rather than restated here. The previous version carried a
 * two-entry map of the codes it happened to need, which is a hand-written description of
 * data that the data cannot contradict — and it silently classified every other code as
 * "has no constant", weakening the check to a substring search.
 */
function diagnosticCodes() {
  const src = readFileSync(join(REPO, "packages/ir/src/diagnostics.ts"), "utf8");
  const out = new Map();
  for (const [, name, code] of src.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*"(MF-[A-Z]+-\d{4})",/gm)) {
    out.set(code, name);
  }
  return out;
}

const CODES = diagnosticCodes();

/**
 * Does `file` emit `code`, ignoring the annotations that claim it does?
 *
 * Stripping the annotation lines is the whole point. With them in scope the question
 * answers itself, which is how `emits MF-PDF-0004` survived: the only occurrence of that
 * string in the repository was the annotation asserting it.
 */
function emitsCode(fileText, code) {
  const body = fileText
    .split("\n")
    .filter((l) => !ANNOTATION.test(l))
    .join("\n");
  const constant = CODES.get(code);
  return body.includes(code) || (constant !== undefined && body.includes(constant));
}

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

    // `emits` is the only annotation with a checkable consequence, and there are two of
    // them: the code has to be one the IR defines, and the file has to raise it somewhere
    // other than in this annotation. An annotation claiming an emission the file cannot
    // make is worse than no annotation, because it reads as verified.
    if (kind === "emits" && code) {
      if (!CODES.has(code)) {
        fail(
          `${rel}:${i + 1} — annotated \`emits ${code}\`, which no DiagnosticCode entry defines. ` +
            `Nothing can raise it, so the annotation is a claim about a code that does not exist.`,
        );
      } else if (!emitsCode(wholeFile, code)) {
        fail(
          `${rel}:${i + 1} — annotated \`emits ${code}\` but the file raises it nowhere outside ` +
            `the annotation itself (neither ${code} nor ${CODES.get(code)} appears in the code)`,
        );
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

  /*
   * The emits cross-check, run against the two ways it can be wrong.
   *
   * The previous control here only asserted that the regex *exposed* the code. It never ran
   * the presence test, so it passed while that test was vacuous — `wholeFile.includes(code)`
   * over a file containing the annotation is always true. `emits MF-PDF-0004` lived in the
   * tree that way, naming a code the IR has never defined.
   */
  const codesParsed = CODES.size > 20 && CODES.get("MF-PDF-0002") === "PDF_PAGE_IMAGE_UNAVAILABLE";
  if (codesParsed) ok(`the DiagnosticCode table is read from source (${CODES.size} codes)`);
  else fail(`negative control: only ${CODES.size} DiagnosticCode entries parsed — the registry read is broken`);

  // 1. A code the IR does not define. This is the defect that was in the tree.
  if (!CODES.has("MF-PDF-0004")) ok("an `emits` code that no DiagnosticCode entry defines is detected");
  else fail("negative control: MF-PDF-0004 resolved as a real code");

  // 2. A real code claimed by a file that only mentions it in the annotation. Without the
  // annotation-stripping this returns true and the check catches nothing.
  const selfSatisfying = `function f() {\n  // degradation: emits MF-PDF-0002\n  try { g(); } catch { return undefined; }\n}\n`;
  if (!emitsCode(selfSatisfying, "MF-PDF-0002")) ok("a file whose only mention of the code is its own annotation is detected");
  else fail("negative control: the emits check is still satisfied by the annotation making the claim");

  // 3. And it must still accept a file that genuinely raises the code, by either spelling.
  const genuine = `  // degradation: emits MF-PDF-0002\n  } catch {}\n  bag.lost(DiagnosticCode.PDF_PAGE_IMAGE_UNAVAILABLE, "page", "…");\n`;
  if (emitsCode(genuine, "MF-PDF-0002")) ok("a file that raises the code by its constant name is accepted");
  else fail("negative control: a genuine emission was rejected");
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
