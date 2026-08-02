#!/usr/bin/env node
/**
 * `CORPUS.md` §2.15's third producer profile: a **real Pandoc export**, generated here rather
 * than committed.
 *
 * §2.15 asks for four OOXML encodings of one identical source, so that a difference between
 * them isolates the producer. Two were synthesized by our own generator; the other two need
 * the binary present to produce, which is why CORPUS.md called them "a `--check`-gated
 * generation step rather than something we can synthesize honestly".
 *
 * **Generated, not committed, and the reason is licensing.** Pandoc's default reference
 * document is part of its GPL-licensed data files, and a DOCX it produces carries that
 * `styles.xml` and theme. `fixtures/LICENSES.md` exists to keep exactly this out of the
 * repository under an unexamined licence, so the export lives for the length of this check
 * and is deleted. CI pins pandoc 3.10 (`docs/SCOREBOARD.md` records the same version), so
 * this runs on every push rather than only where someone happens to have it installed.
 *
 * **What its first run found**, which is the argument for a real producer over a synthesized
 * one: Pandoc's `TOCHeading` style declares `w:outlineLvl` 9, our schema capped
 * `outlineLevel` at 8, and so **every Pandoc-produced DOCX parsed to an invalid IR** — with
 * zero diagnostics, because the adapter read the value correctly and the schema was wrong.
 * ISO/IEC 29500-1 §17.3.1.20 is explicit: "can be from 0 to 9, where 9 specifically indicates
 * that there is no outline level specifically applied to this paragraph." Four phases of
 * hand-written fixtures never produced a 9, because we only ever wrote headings.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(REPO, "fixtures/md/generated-profile-source.md");
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const probe = spawnSync("pandoc", ["--version"], { encoding: "utf8" });
if (probe.error) {
  // In CI the binary is pinned and present, so its absence is a broken workflow rather than a
  // contributor's laptop. Locally, say so loudly instead of printing a green tick.
  const message =
    "check-producer-exports: pandoc is not on PATH. CI pins 3.10, so this is a gate that " +
    "did not run rather than a gate that passed.";
  if (process.env["CI"]) {
    console.error(message);
    process.exit(1);
  }
  console.log(`  SKIP  ${message}`);
  process.exit(0);
}
const version = (probe.stdout ?? "").split("\n")[0]?.trim() ?? "unknown";

const dir = mkdtempSync(join(tmpdir(), "markforge-producer-"));
try {
  const out = join(dir, "pandoc-export.docx");
  execFileSync("pandoc", ["-f", "markdown", "-t", "docx", SOURCE, "-o", out], { stdio: "pipe" });

  const { parseDocx } = await import(pathToFileURL(join(REPO, "packages/adapters-docx/dist/index.js")).href);
  const { validateDocument } = await import(pathToFileURL(join(REPO, "packages/ir/dist/index.js")).href);

  const result = parseDocx(new Uint8Array(readFileSync(out)), { path: "pandoc-export.docx" });
  const validation = validateDocument(result.document);

  /*
   * Inference, because the *shipped* pipeline runs it and the adapter deliberately does not.
   * Adapter rule A5 is "adapters record, they do not infer": a `Heading1`-styled paragraph
   * stays a paragraph until `inferAll` promotes it. Asserting `heading` against the raw
   * adapter output measures a pipeline nobody runs — the mistake `run-scoreboard.mjs` made
   * with `inferHeadings`, which cost four metric-fixture pairs to Pandoc before it was found.
   */
  const { inferAll } = await import(pathToFileURL(join(REPO, "packages/infer/dist/index.js")).href);
  inferAll(result.document, result.diagnostics);

  if (validation.valid) ok(`${version} export parses into a schema-valid IR`);
  else {
    const first = validation.errors[0];
    fail(`${version} export produces an INVALID IR — ${first?.path}: ${first?.message}`);
  }

  // Content, not merely validity. The source has two lists, a table, and a heading; a parse
  // that validated but returned an empty body would satisfy the check above.
  const types = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.type === "string") types.add(n.type);
    for (const c of n.children ?? []) walk(c);
  };
  walk(result.document.body);
  for (const required of ["heading", "paragraph", "list", "table"]) {
    if (types.has(required)) ok(`the export yields ${required} nodes`);
    else fail(`no ${required} node survived the Pandoc export — the parse is empty or flattened`);
  }

  const lossy = result.diagnostics.all().filter((d) => d.lossy);
  if (lossy.length === 0) ok("no lossy diagnostic on a document Pandoc wrote from our own source");
  else {
    // Not a failure: a real producer is allowed to write things we degrade. It has to be
    // *reported*, which is the property, and printed here so a new one is noticed.
    ok(`${lossy.length} lossy diagnostic(s), each reported: ${[...new Set(lossy.map((d) => d.code))].join(", ")}`);
  }

  /*
   * Negative control. The check above is only worth having if an invalid document would fail
   * it, and the specific thing this gate exists for is a *style-level* value out of range —
   * which is what `outlineLevel: 9` was. Reproduce it in the other direction.
   */
  const tampered = JSON.parse(JSON.stringify(result.document));
  const styleId = Object.keys(tampered.styles ?? {})[0];
  if (!styleId) {
    fail("negative control: the export defines no styles, so the control cannot run");
  } else {
    tampered.styles[styleId].evidence = { ...tampered.styles[styleId].evidence, outlineLevel: 10 };
    const after = validateDocument(tampered);
    if (!after.valid) ok("an outlineLevel of 10 is still rejected, so the cap moved rather than vanished");
    else fail("negative control: outlineLevel 10 validates — the schema now caps nothing");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
else console.log(failures.length === 0 ? `\nPandoc export verified (${version}).` : `\n${failures.length} failure(s).`);
process.exit(failures.length === 0 ? 0 : 1);
