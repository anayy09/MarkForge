#!/usr/bin/env node
/**
 * Seven flavour presets, one construct-dense document, seven byte-distinct renders.
 *
 * **Enforces ADR-0021.** Named here because `check-adr-enforcement.mjs` requires the check and
 * the decision to reference each other: an ADR naming a file that merely exists is a claim
 * about a filename resolving, not about enforcement, which is the shape ADR-0012 was caught in.
 *
 * ## Why the gate is distinctness rather than coverage
 *
 * `markdown.flavor` was in the config schema from Phase 0, enumerating seven values, and read
 * by nothing: `flavor: "commonmark"` produced GFM. The obvious way to "close" §2.13 would have
 * been seven fixtures — one per flavour — which would have passed while every one of them
 * round-tripped identically, because the setting did nothing. Seven files agreeing is
 * indistinguishable from seven files being ignored.
 *
 * So the gate is the *difference*: render one document through all seven presets and require
 * seven distinct byte strings. **A preset that ties with another is not shipped** — it is a
 * duplicate name implying a distinction that does not exist, and it is struck rather than
 * quietly kept.
 *
 * The probe carries a footnote, display and inline math, an admonition, a table, and front
 * matter, because that set is what separates the seven: CommonMark has no table or footnote
 * syntax, MDX cannot take raw HTML, and admonitions differ across Docusaurus (`:::note`),
 * MkDocs (`!!! note`), Obsidian (`> [!note]`), and Pandoc (a fenced div).
 *
 * ## The second reason this fixture exists
 *
 * CommonMark genuinely **cannot** express a footnote. Every other no-silent-loss check in this
 * repository runs against a target that can hold the construct and merely renders it
 * differently; this is the first that runs against one that cannot. Section 2 asserts the
 * diagnostic, not only the bytes — a render that quietly dropped `[^1]` would still produce
 * distinct output and pass section 1 on its own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const { parseMarkdown } = await import(pathToFileURL(join(REPO, "packages/adapters-md/dist/index.js")).href);
const { renderMarkdown, FLAVORS } = await import(
  pathToFileURL(join(REPO, "packages/render-md/dist/index.js")).href
);

const PROBE = "fixtures/md/flavor-probe.md";
const source = readFileSync(join(REPO, PROBE), "utf8");
const doc = parseMarkdown(source, { path: PROBE }).document;

const ids = Object.keys(FLAVORS).sort();
const renders = new Map();

// ------------------------------------------------------------------ 1. seven distinct renders
!JSON_OUT && console.log("\n1. Every preset renders the probe differently");
{
  if (ids.length === 7) ok(`${ids.length} presets declared (SPEC §4.1 names seven)`);
  else fail(`${ids.length} presets declared; SPEC §4.1 names seven`);

  for (const id of ids) {
    const { markdown } = renderMarkdown(doc, { flavor: id });
    renders.set(id, markdown);
  }

  const byOutput = new Map();
  for (const [id, md] of renders) {
    const existing = byOutput.get(md);
    if (existing) byOutput.set(md, [...existing, id]);
    else byOutput.set(md, [id]);
  }

  for (const [, group] of byOutput) {
    if (group.length === 1) continue;
    fail(
      `presets ${group.join(", ")} render the probe identically. A preset that ties with ` +
        `another is a duplicate name, not a flavour — strike it, or give it a spelling that ` +
        `differs.`,
    );
  }
  if (byOutput.size === ids.length) ok(`${byOutput.size} distinct render(s) from ${ids.length} preset(s)`);

  // Vacuity: a probe that exercised nothing would render identically everywhere and the loop
  // above would report one group of seven — caught, but for the wrong reason. A probe that
  // rendered to almost nothing would also be useless.
  const shortest = Math.min(...[...renders.values()].map((m) => m.length));
  if (shortest > 200) ok(`the shortest render is ${shortest} bytes, so the probe carries real content`);
  else fail(`the shortest render is ${shortest} bytes — the probe is not construct-dense enough to separate presets`);
}

// ------------------------------------------------------------------ 2. loss is reported
!JSON_OUT && console.log("\n2. A construct the flavour cannot express is reported, not dropped");
{
  /*
   * CommonMark has no footnote syntax. SPEC §1.3 requires a diagnostic and retention, so the
   * reference must degrade to visible text and the definition must survive as a paragraph —
   * not vanish, and not emit `[^1]` that a CommonMark reader shows literally with nothing to
   * resolve it against.
   */
  const { markdown, diagnostics } = renderMarkdown(doc, { flavor: "commonmark" });
  const all = diagnostics.all();

  const reported = all.filter((d) => d.construct === "footnoteReference");
  if (reported.length > 0) ok(`CommonMark reports the footnote it cannot express (${reported.length} diagnostic)`);
  else fail("CommonMark rendered a footnote with no diagnostic — SPEC §1.3 forbids the silent case");

  if (reported.every((d) => d.lossy === true)) ok("the diagnostic is lossy, so --strict can see it");
  else fail("the footnote diagnostic is not lossy, so --strict cannot see it");

  // Retention: the note's text must still be in the output somewhere.
  if (markdown.includes("Partial ingestion is never acceptable")) {
    ok("the footnote's text is retained in the CommonMark output");
  } else {
    fail("the footnote's text is absent from the CommonMark output — that is a drop, not a degradation");
  }

  // And the shape that would be *invalid* rather than degraded.
  if (!markdown.includes("[^1]")) ok("no dangling [^1] marker is emitted into a flavour that cannot resolve it");
  else fail("CommonMark output contains [^1], which a CommonMark reader shows literally with no definition");

  // The positive control: GFM *can* express it, so it must not be reported there. Without
  // this the gate would pass if every flavour reported everything.
  const gfm = renderMarkdown(doc, { flavor: "gfm" });
  const gfmReported = gfm.diagnostics.all().filter((d) => d.construct === "footnoteReference");
  if (gfmReported.length === 0) ok("GFM expresses the footnote and reports nothing");
  else fail(`GFM reported ${gfmReported.length} footnote diagnostic(s) for a construct it can express`);
}

// ------------------------------------------------------------------ 3. negative control
!JSON_OUT && console.log("\n3. Negative control — the comparison must be able to fail");
{
  const a = renders.get("docusaurus");
  const b = renders.get("mkdocs-material");
  if (a !== b) ok("two presets with different admonition syntax produce different bytes");
  else fail("negative control: docusaurus and mkdocs-material rendered identically");

  // Two renders of the *same* preset must agree, or "distinct" would be measuring
  // nondeterminism rather than flavour.
  const twice = renderMarkdown(doc, { flavor: "obsidian" }).markdown;
  if (twice === renders.get("obsidian")) ok("the same preset renders identically twice (determinism, SPEC §1.1)");
  else fail("negative control: one preset produced different bytes on two runs");

  // An unknown flavour must throw rather than silently falling back to GFM, which is exactly
  // how the setting spent five phases doing nothing.
  let threw = false;
  try {
    renderMarkdown(doc, { flavor: "not-a-flavour" });
  } catch {
    threw = true;
  }
  if (threw) ok("an unknown flavour throws rather than silently rendering GFM");
  else fail("negative control: an unknown flavour was silently accepted");
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, presets: ids }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\n${ids.length} flavour presets produce ${ids.length} distinct renders of ${PROBE}.`
      : `\n${failures.length} flavour failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
