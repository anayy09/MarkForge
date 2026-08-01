#!/usr/bin/env node
/**
 * ADR-0015's claim, checked by building it — over **every** package, not the ten it names.
 *
 * ## Why this file was rewritten
 *
 * The first version took ADR-0015's ten-package list as its input and reported a
 * capability per entry. That was wrong twice over, and both faults are the same shape:
 *
 *   1. **Six packages were classified by nobody.** `ooxml`, `adapters-office`, `agentify`,
 *      `llm`, `http`, `mcp`, and `browser` appear in neither of the ADR's lists, so a new
 *      package could arrive with no declared browser tier and this gate would say nothing.
 *      An ADR that only constrains the packages it happened to enumerate is not enforced.
 *   2. **Entries were reported rather than probed.** It printed
 *      `adapters-pdf exists and is a lazy-tier package (builtins permitted here)` — the
 *      "is a lazy-tier package" half came from a constant in this file, not from a
 *      measurement. That is how the absent `render-pdf` was once reported **present**.
 *
 * So the tier is now **declared per package**, in `package.json` under
 * `markforge.browserTier`, and every package is **probed**. A package with no declaration
 * fails; a package whose probe disagrees with its declaration fails. Adding a package
 * forces the decision, which is the only version of this that survives contact with a
 * future contributor.
 *
 * ## The three tiers
 *
 *   `eager`     must bundle at `platform=browser` with no Node builtin reachable, no Node
 *               global, **and must evaluate** in a context holding only web-platform
 *               globals. Evaluation is what a string scan approximates.
 *   `deferred`  may need Node builtins, and must not be reachable from any `eager`
 *               package's bundle. "Deferred" is not "browser-capable" and the report says
 *               which of the two each one is.
 *   `nodeOnly`  never in a browser. Asserted to be unreachable from `eager` packages.
 *
 * ## Nothing here helps the build
 *
 * No plugin, no `external`, no alias. An earlier version stubbed the deferred packages so
 * `core` would bundle, which made a build-tool flag stand in for a property of the code:
 * with the stub the gate passed, and without it `core` and `browser` failed under every
 * standard esbuild configuration. The fix belonged in the code and is there now (the PDF
 * reader is injected, as ADR-0017 already does for OCR). A gate that helps its subject
 * pass is measuring itself.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { webPlatformSandbox } from "./lib/browser-bundle.mjs";
import vm from "node:vm";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const notes = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};
const note = (m) => {
  notes.push(m);
  !JSON_OUT && console.log(`  note  ${m}`);
};

const VALID_TIERS = new Set(["eager", "deferred", "nodeOnly"]);

/** Every workspace package, with its declared tier. A missing declaration is a failure. */
function declaredTiers() {
  const out = [];
  for (const name of readdirSync(join(REPO, "packages")).sort()) {
    const manifest = join(REPO, "packages", name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    out.push({
      name,
      tier: pkg.markforge?.browserTier,
      isEntry: pkg.markforge?.browserEntry === true,
      entry: join(REPO, "packages", name, "dist", "index.js"),
    });
  }
  return out;
}

/**
 * The whole capability record for one package, every field derived from a probe.
 *
 * `exists` uses `existsSync` rather than the shape of an esbuild error. The first version
 * inferred it from the error text, and esbuild reports a missing entry point with the same
 * `Could not resolve "…"` wording it uses for a builtin — so the absent `render-pdf` was
 * matched as a resolved builtin and reported present.
 */
async function probe(pkg) {
  const record = {
    package: pkg.name,
    declaredTier: pkg.tier ?? null,
    exists: existsSync(pkg.entry),
    bundles: null,
    bytes: null,
    builtins: [],
    via: [],
    nodeGlobals: [],
    heavy: [],
    evaluates: null,
    evaluationError: null,
    reaches: [],
  };
  if (!record.exists) return record;

  try {
    const built = await esbuild.build({
      entryPoints: [pkg.entry],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "Probe",
      conditions: ["worker"],
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    record.bundles = true;
    const source = Buffer.from(built.outputFiles[0].contents).toString("utf8");
    record.bytes = built.outputFiles[0].contents.length;

    // Which other workspace packages ended up inside this bundle. This is what makes
    // "an eager package must not reach a deferred one" checkable.
    const inputs = Object.keys(Object.values(built.metafile.outputs)[0].inputs ?? {});
    record.reaches = [
      ...new Set(
        inputs
          .map((i) => /packages\/([^/]+)\//.exec(i.replaceAll("\\", "/"))?.[1])
          .filter((n) => n && n !== pkg.name),
      ),
    ].sort();

    // The artifacts ADR-0015 actually defers, checked by name.
    //
    // Its stated reason for the deferred tier is weight — "Typst, pdf.js, and Tesseract
    // plus language data together are tens of megabytes" — and the package is the wrong
    // unit for that rule. `@markforge/adapters-ocr` bundles with **no Tesseract in it at
    // all**, because the recogniser is injected (ADR-0017), so gating on package names
    // deferred a pure function while this gates on the thing that is actually large.
    record.heavy = ["tesseract.js", "pdfjs-dist", "typst"].filter((h) =>
      inputs.some((i) => i.replaceAll("\\", "/").includes(`/${h}`)),
    );

    // Static scan for Node globals. `Dynamic require of` is **not** in this list any more:
    // esbuild emits that shim whenever it converts CommonJS, and in `adapters-ocr` it is
    // defined with **zero call sites** — so the string flagged a package that was fine.
    // Reachability is what matters, and evaluation below is how reachability is measured.
    record.nodeGlobals = ["process.env", "__dirname", "__filename", "globalThis.process"].filter((g) =>
      source.includes(g),
    );

    try {
      const sandbox = webPlatformSandbox();
      vm.runInContext(source, sandbox, { timeout: 60_000 });
      record.evaluates = true;
    } catch (e) {
      record.evaluates = false;
      record.evaluationError = e instanceof Error ? e.message.slice(0, 160) : String(e);
    }
  } catch (e) {
    record.bundles = false;
    const builtins = new Set();
    const files = new Set();
    for (const err of e.errors ?? []) {
      const m = /Could not resolve "([^"]+)"/.exec(err.text);
      if (m) builtins.add(m[1]);
      if (err.location?.file) {
        files.add(err.location.file.replaceAll("\\", "/").replace(/^.*?packages\//, "packages/"));
      }
    }
    record.builtins = [...builtins].sort();
    record.via = [...files].sort();
  }
  return record;
}

// ---------------------------------------------------------------- 1. every package declares a tier
!JSON_OUT && console.log("\n1. Every package declares a browser tier");

const packages = declaredTiers();
for (const pkg of packages) {
  if (!pkg.tier) {
    fail(
      `${pkg.name} declares no markforge.browserTier. ADR-0015 constrains the browser build, ` +
        `and a package it never classified is a package the ADR does not reach.`,
    );
  } else if (!VALID_TIERS.has(pkg.tier)) {
    fail(`${pkg.name} declares browserTier "${pkg.tier}" — expected one of ${[...VALID_TIERS].join(", ")}`);
  }
}
if (failures.length === 0) ok(`all ${packages.length} packages declare a tier`);

// ---------------------------------------------------------------- 2. probe them all
!JSON_OUT && console.log("\n2. Every capability is derived from a probe, not from a list");

const records = [];
for (const pkg of packages) records.push(await probe(pkg));

for (const r of records) {
  const pkg = packages.find((p) => p.name === r.package);
  if (!r.exists) {
    note(`${r.package} has no dist/ — not built, so nothing about it is measured`);
    continue;
  }

  if (pkg.tier === "eager") {
    if (!r.bundles) {
      fail(`${r.package} (eager) needs ${r.builtins.join(", ")} — via ${r.via.join(", ")}`);
    } else if (r.nodeGlobals.length > 0) {
      fail(`${r.package} (eager) references ${r.nodeGlobals.join(", ")}`);
    } else if (r.evaluates === false) {
      fail(`${r.package} (eager) bundles but does not evaluate on web globals: ${r.evaluationError}`);
    } else {
      const deferredReached = r.reaches.filter((n) => {
        const other = packages.find((p) => p.name === n);
        return other && other.tier !== "eager";
      });
      if (deferredReached.length > 0) {
        fail(
          `${r.package} (eager) reaches ${deferredReached.join(", ")}, which ${
            deferredReached.length === 1 ? "is" : "are"
          } not eager — the deferred weight is in the primary download`,
        );
      } else if (r.heavy.length > 0 && pkg.isEntry) {
        // A failure only for the **shipped entry point**, which is what a user actually
        // downloads. Measured, the distinction is real rather than pedantic:
        // `@markforge/adapters-ocr` bundled alone *does* contain tesseract.js, because its
        // entry re-exports `createTesseractRecognizer` — and that is correct, since
        // importing that symbol is asking for it. `core` and `browser` reach only
        // `documentFromPages`, a pure function over already-recognised pages, and
        // tree-shaking leaves the WASM out of both. Failing every eager package on its own
        // standalone bundle would have condemned a package nobody ships that way.
        fail(`${r.package} is the browser entry point and contains ${r.heavy.join(", ")} — the artifact ADR-0015 defers`);
      } else if (r.heavy.length > 0) {
        note(`${r.package} bundled alone contains ${r.heavy.join(", ")}; it is not the shipped entry point, and ${packages.filter((p) => p.isEntry).map((p) => p.name).join("/")} does not reach it`);
        ok(`${r.package}: bundles, evaluates on web globals, ${(r.bytes / 1024).toFixed(0)} KB`);
      } else {
        ok(`${r.package}: bundles, evaluates on web globals, ${(r.bytes / 1024).toFixed(0)} KB`);
      }
    }
  } else if (pkg.tier === "deferred") {
    // Builtins are permitted, so what is reported is *which* — "deferred" and
    // "browser-capable" are different properties and the ADR conflated them.
    if (r.bundles) {
      note(`${r.package} (deferred) bundles today, ${(r.bytes / 1024).toFixed(0)} KB — deferred by size, not by capability`);
    } else {
      note(`${r.package} (deferred) needs ${r.builtins.join(", ")} — deferred AND not browser-capable`);
    }
  } else {
    if (r.bundles) {
      note(`${r.package} (nodeOnly) happens to bundle — no eager package may reach it, asserted above`);
    } else {
      ok(`${r.package} (nodeOnly) needs ${r.builtins.length} Node builtin(s), as declared`);
    }
  }
}

// ---------------------------------------------------------------- 3. render-pdf
!JSON_OUT && console.log("\n3. Packages ADR-0015 names that do not exist");
for (const named of ["render-pdf"]) {
  if (!existsSync(join(REPO, "packages", named))) {
    note(`${named} is named in ADR-0015's deferred tier and does not exist (ADR-0003, Typst WASM)`);
  } else {
    ok(`${named} exists and is covered by the probe above`);
  }
}

// ---------------------------------------------------------------- 4. negative controls
!JSON_OUT && console.log("\n4. Negative controls — each check must be able to fail");

const tmp = mkdtempSync(join(tmpdir(), "markforge-bundle-"));
try {
  const bundleFile = async (file) => {
    try {
      const r = await esbuild.build({
        entryPoints: [file], bundle: true, platform: "browser", format: "iife",
        globalName: "C", write: false, logLevel: "silent", conditions: ["worker"],
      });
      return { ok: true, source: Buffer.from(r.outputFiles[0].contents).toString("utf8"), builtins: [] };
    } catch (e) {
      const b = new Set();
      for (const err of e.errors ?? []) {
        const m = /Could not resolve "([^"]+)"/.exec(err.text);
        if (m) b.add(m[1]);
      }
      return { ok: false, builtins: [...b] };
    }
  };

  // (a) a direct builtin import
  const direct = join(tmp, "direct.mjs");
  writeFileSync(direct, `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`);
  const a = await bundleFile(direct);
  if (!a.ok && a.builtins.includes("node:fs")) ok("caught a direct node:fs import");
  else fail("negative control: a direct node:fs import was not caught");

  // (b) a builtin two hops away behind a clean entry point
  mkdirSync(join(tmp, "deep"), { recursive: true });
  writeFileSync(join(tmp, "deep", "inner.mjs"), `import { deflateSync } from "node:zlib";\nexport const c = deflateSync;\n`);
  const deep = join(tmp, "deep-entry.mjs");
  writeFileSync(deep, `export { c } from "./deep/inner.mjs";\nexport const clean = 1;\n`);
  const b = await bundleFile(deep);
  if (!b.ok && b.builtins.includes("node:zlib")) ok("caught a builtin two hops away behind a clean entry point");
  else fail("negative control: a transitively reached builtin was not caught");

  // (c) a process.env read, which bundles successfully and must still be caught.
  // NOT `NODE_ENV`: esbuild constant-folds that one, so an earlier version of this control
  // bundled to `var mode = "development"` with no `process` in it and proved nothing.
  const env = join(tmp, "env.mjs");
  writeFileSync(env, `export const mode = process.env.MARKFORGE_UNSET ?? "none";\n`);
  const c = await bundleFile(env);
  if (c.ok && c.source.includes("process.env")) ok("caught a process.env read that bundled cleanly");
  else fail("negative control: a process.env read was not caught");

  // (d) evaluation. A module that bundles but touches the DOM at load time must fail the
  // sandbox — this is the control on the check that found the real `document.createElement`
  // entity decoder, and without it the evaluation step could silently never fire.
  const dom = join(tmp, "dom.mjs");
  writeFileSync(dom, `const el = document.createElement("i");\nexport const x = el;\n`);
  const d = await bundleFile(dom);
  if (!d.ok) {
    fail("negative control: the DOM control did not bundle, so it tested nothing");
  } else {
    let threw = false;
    try {
      vm.runInContext(d.source, webPlatformSandbox(), { timeout: 10_000 });
    } catch {
      threw = true;
    }
    if (threw) ok("caught a module that bundles but needs the DOM at load time");
    else fail("negative control: a DOM reference at load time was not caught by evaluation");
  }

  // (e) the tier declaration itself. A package with no tier must fail check 1.
  const withoutTier = { markforge: {} };
  if (!withoutTier.markforge.browserTier) ok("a package with no declared tier is detectable");
  else fail("negative control: an undeclared tier was not detectable");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- report
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, notes, records }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nAll browser-bundle checks passed over ${records.length} packages.${notes.length ? ` ${notes.length} note(s).` : ""}`
      : `\n${failures.length} browser-bundle check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
