#!/usr/bin/env node
/**
 * The PDF renderer produces byte-identical output across processes, and reports what it loses.
 *
 * **Enforces ADR-0003**, which chose Typst on 2026-07-29 and had nothing behind it until
 * 2026-08-01. `scripts/check-browser-bundle.mjs` reported `render-pdf` as absent on every run
 * for four phases, and ADR-0015's lazy tier was ratified for two of its three members.
 *
 * ## Why determinism is the property this gate holds
 *
 * SPEC §4.3's other requirements — embedded fonts, working TOC and links, table breaking,
 * figure placement — are Typst's job, and Typst is a typesetting engine with its own test
 * suite. Determinism is *ours*, because it depends on how we call it, and SPEC §1.1 makes it
 * a product guarantee rather than a nicety.
 *
 * Measured while building this, and the reason `#set document(date: none)` sits in the
 * preamble rather than being a stylistic choice:
 *
 *   - two compiles in **one process** are byte-identical;
 *   - two compiles in **separate processes** differed at byte 11533 — `/CreationDate` and
 *     `/ModDate`, filled from the wall clock;
 *   - the compiler's `creationTimestamp` option does **not** override them;
 *   - `date: none` omits both, and separate processes then agree byte for byte.
 *
 * A same-process check would have passed throughout and proved nothing, which is why section 1
 * spawns a second process rather than compiling twice in this one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const WORKER = process.argv.includes("--worker");

const load = (p) => import(pathToFileURL(join(REPO, `packages/${p}/dist/index.js`)).href);

/** Compiles one fixture to PDF. Shared by the gate and by the worker it spawns. */
async function renderFixture(fixture) {
  const { parseMarkdown } = await load("adapters-md");
  const { renderPdf } = await load("render-pdf");
  const { NodeCompiler } = await import("@myriaddreamin/typst-ts-node-compiler");
  const compiler = NodeCompiler.create({});
  const doc = parseMarkdown(readFileSync(join(REPO, fixture), "utf8"), { path: fixture }).document;
  return renderPdf(doc, { compile: (s) => new Uint8Array(compiler.pdf({ mainFileContent: s })) });
}

// Worker mode exists so section 1 can compare across a process boundary. Without it the
// comparison is same-process and structurally cannot see a wall-clock timestamp.
if (WORKER) {
  const fixture = process.argv[process.argv.indexOf("--worker") + 1];
  const out = process.argv[process.argv.indexOf("--worker") + 2];
  const r = await renderFixture(fixture);
  writeFileSync(out, r.bytes);
  process.exit(0);
}

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const FIXTURES = [
  "fixtures/md/clean-report.md",
  "fixtures/md/tables.md",
  "fixtures/md/nested-restarting-lists.md",
  "fixtures/md/unicode-edge-cases.md",
];

const work = mkdtempSync(join(tmpdir(), "markforge-pdf-"));
try {
  // ---------------------------------------------------------------- 1. cross-process bytes
  !JSON_OUT && console.log("\n1. Two renders in separate processes are byte-identical");
  for (const fixture of FIXTURES) {
    const name = fixture.split("/").pop();
    const outs = [join(work, `${name}.1.pdf`), join(work, `${name}.2.pdf`)];
    for (const out of outs) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", fixture, out], {
        cwd: REPO,
        stdio: "ignore",
      });
    }
    const [a, b] = outs.map((o) => readFileSync(o));
    if (a.equals(b)) {
      ok(`${name} — ${a.length} bytes, identical across two processes`);
    } else {
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      fail(
        `${name} differs at byte ${i}: ` +
          `${JSON.stringify(a.subarray(Math.max(0, i - 30), i + 30).toString("latin1"))} vs ` +
          `${JSON.stringify(b.subarray(Math.max(0, i - 30), i + 30).toString("latin1"))}`,
      );
    }
  }

  // ---------------------------------------------------------------- 2. no wall clock
  !JSON_OUT && console.log("\n2. No wall-clock timestamp reaches the output (SPEC §1.1)");
  {
    const r = await renderFixture(FIXTURES[0]);
    const text = Buffer.from(r.bytes).toString("latin1");
    if (!text.includes("/CreationDate") && !text.includes("/ModDate")) {
      ok("neither /CreationDate nor /ModDate is present");
    } else {
      fail("a PDF date field is present, so output depends on when it was produced");
    }
    if (r.source.includes("#set document(date: none)")) ok("the preamble sets date: none");
    else fail("the preamble no longer sets date: none — the field will return");
  }

  // ---------------------------------------------------------------- 3. losses are reported
  !JSON_OUT && console.log("\n3. Nothing is dropped silently (SPEC §1.3)");
  {
    const r = await renderFixture(FIXTURES[0]);
    const dropped = r.diagnostics.all().filter((d) => d.lossy === true);
    if (dropped.length === 0) ok("clean-report.md renders with no lossy diagnostic");
    else fail(`clean-report.md reports ${dropped.length} loss(es): ${dropped.map((d) => d.construct).join(", ")}`);
  }

  // ---------------------------------------------------------------- 4. negative control
  !JSON_OUT && console.log("\n4. Negative control — the comparison must be able to fail");
  {
    const { toTypst } = await load("render-pdf");
    const { parseMarkdown } = await load("adapters-md");
    const doc = parseMarkdown("# H\n\nBody.\n", { path: "x.md" }).document;

    if (!Buffer.from("one").equals(Buffer.from("onf"))) {
      ok("the byte comparison distinguishes a one-byte difference");
    } else {
      fail("negative control: the byte comparison does not discriminate");
    }

    // A construct with no Typst mapping must be reported. `textBox` is struck from SPEC §2.3
    // (OPEN_QUESTIONS §7ab) and no adapter produces one, which makes it the honest probe for
    // a type this renderer genuinely cannot express.
    const withUnknown = structuredClone(doc);
    withUnknown.body.children.push({ type: "textBox", anchor: "inline", children: [] });
    if (toTypst(withUnknown).lost.some((l) => l.type === "textBox")) {
      ok("a construct with no Typst mapping is reported");
    } else {
      fail("negative control: an unmappable construct was not reported");
    }

    // The other direction, and it is not hypothetical: the first version of the renderer
    // reported 16 `text` nodes on clean-report.md, every one of them present in the output.
    // A plausible diagnostic on a document that is fine is the hardest failure to notice.
    const clean = toTypst(doc).lost;
    if (clean.length === 0) ok("an ordinary document reports nothing");
    else fail(`negative control: an ordinary document reported ${clean.length} loss(es): ${clean.map((l) => l.type).join(", ")}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nPDF output is byte-identical across processes on ${FIXTURES.length} fixture(s).`
      : `\n${failures.length} PDF failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
