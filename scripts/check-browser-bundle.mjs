#!/usr/bin/env node
/**
 * ADR-0015's claim, checked by building it.
 *
 * The ADR names ten packages that "run fully in-browser" and three that are lazy-loaded
 * WASM. It was written on 2026-07-29 and carried `Status: Proposed` through four phases
 * because nothing ever tested either tier. The first run of this gate found **0 of the 10
 * bundled**, which is why the gate exists before the browser package does: a claim nobody
 * can fail is not a boundary, it is a paragraph.
 *
 * Two tiers, checked as two tiers:
 *
 *   Tier 1 (eager)  — bundles at `platform=browser` with **no** `node:` builtin reachable
 *                     and no polyfill standing in for one. Measured from esbuild's
 *                     metafile rather than by grepping source, because a builtin arrives
 *                     through a transitive dependency as easily as through an import.
 *   Tier 2 (lazy)   — `render-pdf`, `adapters-pdf`, `adapters-ocr` may use builtins, but
 *                     must land in a **separate chunk**, so a user converting DOCX to
 *                     Markdown does not download a PDF engine. Checked by splitting the
 *                     bundle and asserting the entry chunk does not contain them.
 *
 * A polyfill is a failure, not a fix. esbuild will happily shim `node:path` for the
 * browser if asked; ADR-0015's point is that the deterministic core does not need one, so
 * the gate runs with no `inject`, no `alias`, and `platform: "browser"` — where an
 * unresolved builtin is an error rather than a substitution.
 *
 * Run with `--json` for the machine-readable envelope the CI step reads.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

/**
 * ADR-0015's eager set, verbatim. `core` is included even though the ADR lists it in the
 * decision paragraph rather than the SPEC §11 sentence — it is the package the other nine
 * are reached through, so exempting it would make the gate meaningless.
 */
const EAGER = [
  "ir",
  "adapters-md",
  "adapters-html",
  "adapters-docx",
  "render-md",
  "render-html",
  "render-docx",
  "infer",
  "core",
  "fidelity",
];

/**
 * ADR-0015's lazy set. `render-pdf` is listed and **does not exist** (ADR-0003 needs the
 * Typst WASM bundle, STATUS.md Phase 2). It is named here rather than quietly dropped, so
 * the gate reports one third of the lazy tier as untestable instead of narrowing the ADR
 * to whatever happens to be checkable. See the ADR's Consequences.
 */
const LAZY = ["adapters-pdf", "adapters-ocr", "render-pdf"];

const failures = [];
const notes = [];
const results = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};
const note = (m) => {
  notes.push(m);
  !JSON_OUT && console.log(`  note  ${m}`);
};

const entry = (pkg) => join(REPO, "packages", pkg, "dist", "index.js");

/**
 * Bundles one entry point for the browser and reports what it needed from Node.
 *
 * Returns `{ ok, builtins, files, bytes }`. `builtins` is derived from esbuild's errors,
 * which name the specifier and the importing file — the importing file is the useful half,
 * because nine of the ten first-run failures were the *same* three files in `ir` reached
 * through nine different packages.
 */
async function bundle(entryPoint, { splitting = false, outdir } = {}) {
  try {
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "browser",
      format: "esm",
      metafile: true,
      logLevel: "silent",
      ...(splitting ? { splitting: true, outdir, write: true } : { write: false }),
    });
    return { ok: true, builtins: [], files: [], metafile: result.metafile, result };
  } catch (e) {
    const builtins = new Set();
    const files = new Set();
    for (const err of e.errors ?? []) {
      const m = /Could not resolve "([^"]+)"/.exec(err.text);
      if (m) builtins.add(m[1]);
      if (err.location?.file) {
        files.add(err.location.file.replaceAll("\\", "/").replace(/^.*?packages\//, "packages/"));
      }
    }
    return { ok: false, builtins: [...builtins].sort(), files: [...files].sort() };
  }
}

// ---------------------------------------------------------------- 1. the eager tier
!JSON_OUT && console.log("\n1. ADR-0015 tier 1 — the eager set bundles for the browser");

for (const pkg of EAGER) {
  // `core` is measured in check 3 instead. It is the one package with a legitimate lazy
  // boundary — `await import("@markforge/adapters-pdf")` — and a single-file bundle
  // follows a dynamic import like any other, so building it here would report the
  // deferred chunk's builtins as core's own. Check 3 splits it and asks the sharper
  // question: which chunk are they in. Skipping it here is not an exemption; check 3 is
  // strictly stronger, and it fails if the entry chunk has so much as one builtin.
  if (pkg === "core") {
    note("core is measured in check 3, which splits chunks — a lazy import is not a leak");
    continue;
  }
  const r = await bundle(entry(pkg));
  results.push({ pkg, tier: "eager", ok: r.ok, builtins: r.builtins, via: r.files });
  if (r.ok) {
    const kb = (r.result.outputFiles[0].contents.length / 1024).toFixed(0);
    ok(`${pkg} bundles for the browser (${kb} KB)`);
  } else {
    fail(`${pkg} needs ${r.builtins.join(", ")} — via ${r.files.join(", ")}`);
  }
}

// ---------------------------------------------------------------- 2. no polyfills
// Bundling succeeded above with `platform: "browser"` and no `inject`/`alias`, so an
// unresolved builtin was an error rather than a substitution. This asserts the second
// half explicitly: nothing in the output references a Node global either. A bundler
// can be configured into a shim, and the difference between "does not need node:path"
// and "was given a node:path" is invisible in a passing build otherwise.
!JSON_OUT && console.log("\n2. No Node globals stand in for the builtins that are absent");

/**
 * What a Node global actually looks like in a bundle.
 *
 * `"Dynamic require of "` is esbuild's own marker: it plants that string in a thrown
 * error exactly where it had to leave a `require()` it could not resolve, so its
 * presence means the bundle throws in a browser on that path. The rest are direct
 * references to the Node process object.
 *
 * The first version of this list contained the substring `"require("`, which flagged all
 * nine clean packages. The hits were ajv's *standalone code generation* templates —
 * string literals like `` `require("ajv/dist/runtime/uri").default` `` that are emitted
 * into generated validator source and never executed here — plus esbuild's `__commonJS`
 * wrapper, which every bundle containing a CJS dependency has. A predicate that cannot
 * distinguish a string literal from a call is not measuring what its name claims, and
 * narrowing it is only legitimate because the replacement is strictly more precise:
 * `Dynamic require of` matches the failure and nothing else. The negative control in
 * section 4 exists so that narrowing cannot quietly become deletion.
 */
const NODE_GLOBALS = [
  "Dynamic require of ",
  "process.env",
  "__dirname",
  "__filename",
  "globalThis.process",
];
const nodeGlobalsIn = (src) => NODE_GLOBALS.filter((g) => src.includes(g));

let examined = 0;
for (const pkg of EAGER) {
  const r = await bundle(entry(pkg));
  if (!r.ok) continue; // already reported in check 1
  examined++;
  const src = Buffer.from(r.result.outputFiles[0].contents).toString("utf8");
  const found = nodeGlobalsIn(src);
  if (found.length === 0) ok(`${pkg} references no Node global`);
  else fail(`${pkg} references ${found.join(", ")} in the browser bundle`);
}
// This check can only look at bundles that built, so while check 1 is failing it has
// nothing to examine and prints nothing. Silence and success are not the same state, and
// STATUS.md records a CI step that passed while grepping an empty string. Say which one
// this is rather than leaving a blank section that reads as a pass.
if (examined === 0) note("nothing to examine — every eager package failed check 1");
else if (examined < EAGER.length) note(`${examined} of ${EAGER.length} eager packages examined`);

// ---------------------------------------------------------------- 3. the lazy tier
!JSON_OUT && console.log("\n3. ADR-0015 tier 2 — the heavy paths are separate chunks, not in the entry");

const tmp = mkdtempSync(join(tmpdir(), "markforge-bundle-"));
try {
  for (const pkg of LAZY) {
    // Existence is tested with `existsSync`, not inferred from the shape of an esbuild
    // error. The first version of this check inferred it, and esbuild reports a missing
    // entry point as `Could not resolve "<path>"` — the same wording it uses for a
    // builtin — so the absent `render-pdf` was matched as a resolved builtin and
    // reported **ok exists**. A check that reports a package we have not written as
    // present is worse than no check, and it is the exact failure mode section 4 exists
    // to provoke. Caught by reading the first run's output against what is on disk.
    if (!existsSync(entry(pkg))) {
      // `render-pdf` is the case. A note rather than a failure: ADR-0003 blocks it on the
      // Typst WASM bundle, so ADR-0015's lazy tier is ratified for two of its three
      // members and the third is said out loud rather than narrowed away.
      note(`${pkg} does not exist — ADR-0015's lazy tier is untestable for it (ADR-0003)`);
      results.push({ pkg, tier: "lazy", ok: null, builtins: [], via: [] });
      continue;
    }
    const r = await bundle(entry(pkg));
    results.push({ pkg, tier: "lazy", ok: true, builtins: r.builtins, via: r.files });
    ok(`${pkg} exists and is a lazy-tier package (builtins permitted here)`);
  }

  // `core` is the package that must not drag a lazy dependency into its entry chunk. It
  // reaches `adapters-pdf` through `await import(...)` in core/src/index.ts, which is the
  // mechanism ADR-0015 relies on — but a static import looks identical in a single-file
  // bundle, so this splits and asks which *chunk* each builtin landed in.
  //
  // Node builtins are marked external here and nowhere else. Not to make the build pass:
  // marking them external is what lets the build get far enough to answer the question
  // this check is actually asking, which is *where* they are, not *whether*. A builtin in
  // the entry chunk is a failure below. A builtin in a lazy chunk is reported as the
  // limitation it is — and there are some, which is a finding rather than a pass.
  const outdir = join(tmp, "core");
  const split = await esbuild
    .build({
      entryPoints: [entry("core")],
      bundle: true,
      platform: "browser",
      format: "esm",
      splitting: true,
      outdir,
      metafile: true,
      write: true,
      logLevel: "silent",
      external: ["node:*"],
    })
    .catch((e) => ({ errors: e.errors ?? [] }));

  if (!split.metafile) {
    fail(`core does not bundle even with builtins external: ${(split.errors ?? []).length} error(s)`);
  } else {
    const outputs = Object.entries(split.metafile.outputs);
    const [entryPath, entryOut] = outputs.find(([, o]) => o.entryPoint) ?? [];
    const entryBuiltins = (entryOut?.imports ?? [])
      .filter((i) => i.path.startsWith("node:"))
      .map((i) => i.path);
    // The size half of the check is on the **artifact**, not on the package name.
    //
    // ADR-0015 defers three packages, and its stated reason is their weight: "Typst,
    // pdf.js, and Tesseract plus language data together are tens of megabytes". Measured,
    // the package is the wrong unit for that rule. `@markforge/adapters-ocr` bundles for
    // the browser at 397 KB and pulls in **no Tesseract at all** — `documentFromPages`
    // builds IR from already-recognised pages and the `Recognizer` is injected (ADR-0017),
    // so the heavy artifact sits behind the injection point rather than behind the import.
    // Gating on the package name would fail `core` for eagerly importing a pure function.
    //
    // So this asserts on what ADR-0015 actually cares about: the entry chunk must contain
    // none of the three large artifacts. The ADR is amended to match rather than the
    // measurement being bent to match the ADR.
    const HEAVY = ["tesseract.js", "pdfjs-dist", "typst"];
    const entryHeavy = Object.keys(entryOut?.inputs ?? {}).filter((i) =>
      HEAVY.some((h) => i.replaceAll("\\", "/").includes(`/${h}`))
    );

    if (entryBuiltins.length === 0 && entryHeavy.length === 0) {
      ok(
        `core's entry chunk has no Node builtin and none of ${HEAVY.join("/")} ` +
          `(${outputs.length} chunks, entry ${(entryOut.bytes / 1024).toFixed(0)} KB)`
      );
    } else {
      if (entryBuiltins.length) fail(`core's entry chunk imports ${entryBuiltins.join(", ")}`);
      if (entryHeavy.length) fail(`core's entry chunk statically contains ${entryHeavy.join(", ")}`);
    }

    // The lazy chunks, reported rather than asserted. ADR-0015 claims the three heavy
    // packages are browser-capable behind a lazy load; that half of the decision has
    // never been built either, and the honest answer today is that the deferred chunk
    // still needs Node. Recorded as a note so the ADR can say so rather than implying
    // that "lazy" and "browser-capable" are the same property.
    for (const [path, out] of outputs) {
      if (path === entryPath) continue;
      const builtins = (out.imports ?? []).filter((i) => i.path.startsWith("node:"));
      if (builtins.length) {
        const owner = Object.keys(out.inputs)
          .map((i) => /packages\/([^/]+)\//.exec(i.replaceAll("\\", "/"))?.[1])
          .filter((p) => p && LAZY.includes(p))[0];
        note(
          `lazy chunk (${owner ?? "unknown"}) needs ${builtins.map((b) => b.path).join(", ")} — ` +
            `deferred, but not yet browser-capable`
        );
      }
    }
  }

  // ---------------------------------------------------------------- 4. negative control
  // Checks 1–3 prove nothing unless the gate can fail. A package that is browser-clean
  // today can acquire a `node:fs` import tomorrow through a dependency nobody looked at,
  // and that is the failure this file exists to catch — so it is provoked here rather
  // than trusted. STATUS.md records a CI step that passed while grepping an empty string
  // and a negative control whose invented heading happened to be too long to trip the
  // rule it was testing; both are the same mistake as not writing this section.
  !JSON_OUT && console.log("\n4. Negative control — the gate must be able to fail");

  const controls = [
    {
      name: "a direct node:fs import",
      source: `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
      expect: "node:fs",
    },
    {
      // The control that matters. A direct import is the case nobody would miss; the
      // realistic regression is a builtin arriving two hops away through a dependency
      // nobody read. This entry point is browser-clean on its own line and reaches
      // `node:zlib` only through a module it imports, so it fails only if the gate
      // follows the graph rather than inspecting the entry file.
      name: "a builtin two hops away, through an otherwise clean entry point",
      source: `export { compress } from "./deep/inner.mjs";\nexport const clean = 1;\n`,
      deep: `import { deflateSync } from "node:zlib";\nexport const compress = deflateSync;\n`,
      expect: "node:zlib",
    },
  ];

  for (const c of controls) {
    const file = join(tmp, `control-${c.expect.replace(/\W/g, "")}.mjs`);
    if (c.deep) {
      mkdirSync(join(tmp, "deep"), { recursive: true });
      writeFileSync(join(tmp, "deep", "inner.mjs"), c.deep, "utf8");
    }
    writeFileSync(file, c.source, "utf8");
    const r = await bundle(file);
    if (r.ok) fail(`negative control passed the gate: ${c.name} was not caught`);
    else if (!r.builtins.includes(c.expect)) {
      fail(`negative control caught the wrong thing: expected ${c.expect}, got ${r.builtins.join(", ")}`);
    } else ok(`negative control caught ${c.name}`);
  }

  // Check 2's predicate was narrowed after it produced nine false positives, and a
  // narrowed predicate is exactly the kind that stops catching anything. This provokes
  // it directly: a module that reads `process.env` bundles cleanly for the browser —
  // esbuild resolves it to a global rather than an import, so check 1 passes it — and
  // must still be caught by check 2.
  //
  // The variable name matters. The first version read `process.env.NODE_ENV`, which
  // esbuild constant-folds to the literal `"development"` — the control bundled to
  // `var mode = "development"` with no `process` in it, so it proved the predicate was
  // silent rather than that it was working. `NODE_ENV` is the one key esbuild defines by
  // default; any other survives as a real `process.env` reference.
  const envFile = join(tmp, "control-process-env.mjs");
  writeFileSync(envFile, `export const mode = process.env.MARKFORGE_UNSET ?? "none";\n`, "utf8");
  const envBundle = await bundle(envFile);
  if (!envBundle.ok) {
    fail("negative control for check 2 failed to bundle at all, so it tested nothing");
  } else {
    const found = nodeGlobalsIn(Buffer.from(envBundle.result.outputFiles[0].contents).toString("utf8"));
    if (found.includes("process.env")) ok("negative control caught a process.env reference (check 2)");
    else fail("negative control passed check 2: a process.env reference was not caught");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- report
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, notes, results }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nAll browser-bundle checks passed.${notes.length ? ` ${notes.length} note(s).` : ""}`
      : `\n${failures.length} browser-bundle check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`
  );
}
process.exit(failures.length === 0 ? 0 : 1);
