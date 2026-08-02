// Documentation cross-check. Asserts that the deliverables agree with each other and with
// the specification: no undocumented node type, no uncited ADR, no dangling link, no
// unlicensed binary.
//
// Zero dependencies by design — runs with bare `node scripts/check-docs.mjs` on a fresh clone,
// before any install exists, which is why it is the first job in CI.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolved from the script's own location: no absolute paths, so this works from any clone
// (docs/SPEC.md section 1 forbids absolute paths in outputs; the same discipline applies here).
const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(REPO, p), "utf8");

/**
 * Every file a reference could hide in: package sources, built output, and scripts.
 *
 * `dist/` is included deliberately. A source tree that never sets a flag and a shipped bundle
 * that does are different facts, and the bundle is the one users run.
 */
function sourceTree() {
  const out = [];
  const walk = (rel) => {
    const abs = join(REPO, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "test") continue;
        walk(next);
      } else if (/\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(next);
      }
    }
  };
  for (const p of readdirSync(join(REPO, "packages"))) {
    walk(`packages/${p}/src`);
    walk(`packages/${p}/dist`);
  }
  walk("scripts");
  // `apps/web` is source that ships. Several checks below phrase themselves as "nowhere in
  // the tree does X", and a tree that stopped at `packages/` would let a new directory make
  // those claims quietly narrower than they read — which is the vacuous-check failure this
  // file exists to prevent, arriving through the back door of a new top-level directory.
  walk("apps/web/src");
  walk("apps/web/scripts");
  return out;
}


let failures = 0;
const fail = (m) => { failures++; console.log("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

const spec = read("docs/SPEC.md");
const priorArt = read("docs/PRIOR_ART.md");
const corpus = read("docs/CORPUS.md");
const openQ = read("docs/OPEN_QUESTIONS.md");
const templates = read("docs/TEMPLATES.md");
const fixReadme = read("fixtures/README.md");
const fixLicenses = read("fixtures/LICENSES.md");
const gitignore = read(".gitignore");
const adrIndex = read("docs/adr/README.md");
const allDocs = { "SPEC.md": spec, "PRIOR_ART.md": priorArt, "CORPUS.md": corpus, "OPEN_QUESTIONS.md": openQ, "TEMPLATES.md": templates, "adr/README.md": adrIndex };

// --- 1. Prior art: every project on this list must be surveyed in docs/PRIOR_ART.md.
// The list is maintained here rather than derived from the document, so that dropping a
// survey fails the check instead of quietly shrinking what "covered" means.
const requiredProjects = [
  "word-to-markdown-js", "markitdown", "docling", "marker", "unstructured",
  "mdast", "hast", "mammoth", "turndown", "docx", "Pandoc", "Typst",
  "Paged.js", "Tectonic", "pdfjs-dist", "tesseract.js", "markdownlint",
  "prettier", "remark-stringify", "unified", "remark",
];
const missingPA = requiredProjects.filter((p) => !priorArt.includes(p));
if (missingPA.length) fail(`PRIOR_ART.md missing: ${missingPA.join(", ")}`);
else ok(`PRIOR_ART.md surveys all ${requiredProjects.length} required projects`);

// Every project must carry a verdict.
for (const v of ["STEAL", "BENCHMARK", "AVOID"]) {
  if (!priorArt.includes(v)) fail(`PRIOR_ART.md has no ${v} verdicts`);
}
ok("PRIOR_ART.md uses all three verdict classes");

// --- 2. CLI: all seven subcommands from docs/SPEC.md section 8.
const cli = ["convert", "fmt", "agentify", "check", "diff", "serve", "init"];
const cliSection = spec.slice(spec.indexOf("## 8. CLI surface"), spec.indexOf("## 9. Fidelity"));
const missingCli = cli.filter((c) => !cliSection.includes("`" + c));
if (missingCli.length) fail(`SPEC.md section 8 missing subcommands: ${missingCli.join(", ")}`);
else ok(`SPEC.md section 8 documents all 7 CLI subcommands`);

// --- 3. Fidelity metrics: docs/SPEC.md section 9 must define every metric family below.
const metrics = [
  "tree edit distance", "whitespace-insensitive", "whitespace-sensitive",
  "precision", "recall", "F1", "span", "round trip",
];
const fidSection = spec.slice(spec.indexOf("## 9. Fidelity"), spec.indexOf("## 10. Agent Context"));
const missingMetric = metrics.filter((m) => !fidSection.toLowerCase().includes(m.toLowerCase()));
if (missingMetric.length) fail(`SPEC.md section 9 missing metric concepts: ${missingMetric.join(", ")}`);
else ok("SPEC.md section 9 defines every required metric family");

for (const loop of ["docx → md → docx", "md → pdf → md", "md → md"]) {
  if (!fidSection.includes(loop)) fail(`SPEC.md section 9.5 missing round trip: ${loop}`);
}
ok("SPEC.md section 9.5 covers all three required round trips");

// --- 4. Context unit categories: docs/SPEC.md section 10 lists ten. They must agree across
// SPEC.md and the target registry schema.
const categories = [
  "constraint", "invariant", "convention", "command", "entity",
  "glossaryTerm", "decision", "antiPattern", "dependency", "environmentVariable",
];
const missingCatSpec = categories.filter((c) => !spec.includes(c));
if (missingCatSpec.length) fail(`SPEC.md missing unit categories: ${missingCatSpec.join(", ")}`);
else ok(`SPEC.md documents all ${categories.length} context-unit categories`);

const targetSchema = JSON.parse(read("packages/agentify/schema/target.v0.schema.json"));
const schemaCats = targetSchema.properties.sections.items.properties.categories.items.enum;
const catMismatch = categories.filter((c) => !schemaCats.includes(c)).concat(schemaCats.filter((c) => !categories.includes(c)));
if (catMismatch.length) fail(`target schema category enum disagrees with SPEC: ${catMismatch.join(", ")}`);
else ok("target schema category enum matches SPEC exactly");

// --- 5. Agentify: all seven pipeline stages from docs/SPEC.md section 10.
const stages = ["Ingest", "Classify", "Extract context units", "Deduplicate", "Budget and assemble", "Verify", "Emit"];
const agSection = spec.slice(spec.indexOf("## 10. Agent Context"), spec.indexOf("## 11. Packages"));
const missingStage = stages.filter((s) => !agSection.includes(s));
if (missingStage.length) fail(`SPEC.md section 10 missing stages: ${missingStage.join(", ")}`);
else ok("SPEC.md section 10 covers all 7 agentify stages");

// --- 6. ADRs: files, index, and cross-references must all agree.
const adrFiles = readdirSync(join(REPO, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
// The count is asserted so that adding a decision record without indexing it fails here
// rather than going unnoticed.
if (adrFiles.length !== 22) fail(`expected 22 ADR files, found ${adrFiles.length}`);
else ok("22 ADR files present");

for (const f of adrFiles) {
  if (!adrIndex.includes(f)) fail(`ADR ${f} is not linked from docs/adr/README.md`);
}
ok("every ADR file is linked from the index");

const adrNums = new Set(adrFiles.map((f) => f.slice(0, 4)));
const referenced = new Set();
for (const [name, text] of Object.entries(allDocs)) {
  for (const m of text.matchAll(/ADR-(\d{4})/g)) {
    referenced.add(m[1]);
    if (!adrNums.has(m[1])) fail(`${name} references ADR-${m[1]} which does not exist`);
  }
}
for (const f of adrFiles) {
  const text = read("docs/adr/" + f);
  for (const m of text.matchAll(/ADR-(\d{4})/g)) {
    if (!adrNums.has(m[1])) fail(`${f} references ADR-${m[1]} which does not exist`);
  }
}
ok(`all ADR cross-references resolve (${referenced.size} distinct ADRs cited from docs)`);

// Every ADR must have the four required sections.
for (const f of adrFiles) {
  const t = read("docs/adr/" + f);
  for (const h of ["## Context", "## Decision", "## Rejected alternatives", "## Consequences"]) {
    if (!t.includes(h)) fail(`${f} is missing section "${h}"`);
  }
  if (!/^- Status:/m.test(t)) fail(`${f} has no Status line`);
}
ok("every ADR has Context / Decision / Rejected alternatives / Consequences + Status");

// Each ADR should be cited by at least one deliverable doc (dead ADRs are a smell).
const uncited = [...adrNums].filter((n) => !referenced.has(n));
if (uncited.length) fail(`ADRs never cited from a deliverable doc: ${uncited.map((n) => "ADR-" + n).join(", ")}`);
else ok("every ADR is cited from at least one deliverable document");

// --- 7. Relative markdown links must resolve.
for (const [name, text] of Object.entries(allDocs)) {
  const base = join(REPO, "docs", name.includes("/") ? dirname(name) : ".");
  for (const m of text.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = resolve(base, m[1]);
    if (!existsSync(target)) fail(`${name}: broken link -> ${m[1]}`);
  }
}
ok("all relative links in deliverable docs resolve");

// --- 8. Schema files referenced by SPEC.md must exist.
for (const p of [
  "packages/ir/schema/ir.v0.schema.json",
  "packages/agentify/schema/target.v0.schema.json",
  "schema/markforge.config.v0.schema.json",
]) {
  if (!existsSync(join(REPO, p))) fail(`missing schema file ${p}`);
  if (!spec.includes(p)) fail(`SPEC.md does not reference ${p}`);
}
ok("all three schema files exist and are referenced from SPEC.md");

// --- 9. IR node taxonomy: every type named in SPEC section 2.3 must exist in the schema, and vice versa.
const irSchema = JSON.parse(read("packages/ir/schema/ir.v0.schema.json"));
const schemaTypes = new Set();
for (const def of Object.values(irSchema.$defs)) {
  const c = def?.properties?.type?.const;
  if (c) schemaTypes.add(c);
}
const specTaxonomy = spec.slice(spec.indexOf("### 2.3 Node taxonomy"), spec.indexOf("### 2.4 Style provenance"));
const notInSpec = [...schemaTypes].filter((t) => !specTaxonomy.includes("`" + t + "`"));
if (notInSpec.length) fail(`node types in schema but not named in SPEC section 2.3: ${notInSpec.join(", ")}`);
else ok(`all ${schemaTypes.size} schema node types are documented in SPEC section 2.3`);

// Reverse: types promised by SPEC's extension tables must be in the schema.
const promised = [
  "section", "figure", "caption", "admonition", "equationBlock", "descriptionList",
  "descriptionTerm", "descriptionDetails", "textBox", "pageBreak", "columnBreak",
  "slide", "sheet", "unknown", "subscript", "superscript", "underline", "smallCaps",
  "highlight", "crossReference", "citation", "comment", "insertion", "deletion",
];
const notInSchema = promised.filter((t) => !schemaTypes.has(t));
if (notInSchema.length) fail(`SPEC promises node types absent from schema: ${notInSchema.join(", ")}`);
else ok(`all ${promised.length} MarkForge extension node types exist in the schema`);

// Every node type must be reachable from Root by following every $ref in the schema graph.
// Child-only types (listItem, tableRow, tableCell, descriptionTerm/Details) are reached via
// their parent's children schema, not via a content union.
const defNameByType = new Map();
for (const [name, def] of Object.entries(irSchema.$defs)) {
  const c = def?.properties?.type?.const;
  if (c) defNameByType.set(c, name);
}
const refsOf = (node, out = new Set()) => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => refsOf(n, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") out.add(v.split("/").pop());
    else refsOf(v, out);
  }
  return out;
};
const visited = new Set();
const visit = (defName) => {
  if (!defName || visited.has(defName) || !irSchema.$defs[defName]) return;
  visited.add(defName);
  for (const r of refsOf(irSchema.$defs[defName])) visit(r);
};
visit("Root");
const reachable = new Set([...visited].map((n) => irSchema.$defs[n]?.properties?.type?.const).filter(Boolean));
const orphanTypes = [...schemaTypes].filter((t) => !reachable.has(t));
if (orphanTypes.length) fail(`node types unreachable from Root: ${orphanTypes.join(", ")}`);
else ok(`every one of the ${schemaTypes.size} node types is reachable from Root`);

// --- 10. Config schema fields referenced in SPEC must exist.
const cfg = JSON.parse(read("schema/markforge.config.v0.schema.json"));
for (const path of [
  ["markdown", "lineWidth"], ["inference", "ambiguityMargin"], ["llm", "enabled"],
  ["llm", "apiKeyEnv"], ["agentify", "traceability"], ["fidelity", "tolerance"],
  ["docx", "referenceDoc"], ["pdf", "ignoreSystemFonts"], ["whitespace", "preserveHardBreaks"],
]) {
  const [a, b] = path;
  if (!cfg.properties[a]?.properties?.[b]) fail(`config schema missing ${a}.${b}`);
  if (!spec.includes(`${a}.${b}`)) fail(`SPEC.md never mentions config field ${a}.${b}`);
}
ok("config fields cited in SPEC.md all exist in the config schema");

// --- 11. Corpus: all 15 categories, licensing rules, competitor plan.
for (let i = 1; i <= 15; i++) {
  if (!corpus.includes(`### 2.${i} `)) fail(`CORPUS.md missing category 2.${i}`);
}
ok("CORPUS.md documents all 15 fixture categories");
for (const t of ["LICENSES.md", "word-to-markdown-js", "Pandoc", "markitdown", "construct inventory"]) {
  if (!corpus.includes(t)) fail(`CORPUS.md missing "${t}"`);
}
ok("CORPUS.md covers licensing enforcement, competitor scoreboard, and construct inventories");

// --- 12. Every numbered open question must be either resolved or annotated with what it
// blocks. Before review all six carried a `**Blocks:**` annotation; after review all six are
// resolved, so asserting a minimum count of blockers would now fail for the wrong reason.
// The durable invariant is that no question sits in limbo: unlabelled.
const questionHeadings = [...openQ.matchAll(/^## (\d+)\.\s+(.+)$/gm)];
if (questionHeadings.length < 6) fail(`OPEN_QUESTIONS.md has only ${questionHeadings.length} numbered questions`);
const unlabelled = questionHeadings.filter(([, , title]) =>
  // The invariant is that no question sits in limbo, not which word its heading uses —
  // hence the alternation rather than one required label.
  !/resolved|answered|descoping|descoped|deferred|reversal/i.test(title));
if (unlabelled.length) {
  // A question with no disposition in its heading must state what it blocks in its body.
  const bodies = openQ.split(/^## /m);
  for (const [, num, title] of unlabelled) {
    const body = bodies.find((b) => b.startsWith(`${num}. `)) ?? "";
    if (!/\*\*Blocks:?\*\*/.test(body)) fail(`OPEN_QUESTIONS.md §${num} "${title}" is neither resolved nor annotated with what it blocks`);
  }
}
ok(`OPEN_QUESTIONS.md: all ${questionHeadings.length} questions carry a disposition (resolved / deferred / blocks-X)`);

// The settled table must cover every decision the reviewer actually made.
for (const t of ["MODEL_API_KEY", "Descoped", "academic-manuscript", "non-commercial"]) {
  if (!openQ.includes(t)) fail(`OPEN_QUESTIONS.md settled table missing "${t}"`);
}
ok("OPEN_QUESTIONS.md settled table records all six post-review answers");

// ADR-0009 must not leave the descoped artifacts specified anywhere as deliverables.
for (const [file, text] of [["SPEC.md", spec], ["OPEN_QUESTIONS.md", openQ]]) {
  for (const dead of ["routing.policy.json", "models.overrides.json"]) {
    const hits = [...text.matchAll(new RegExp(`.{90}${dead.replace(".", "\\.")}`, "g"))];
    for (const [ctx] of hits) {
      if (!/no |No |descop|Descop|not a deliverable|instead|rejected|asked for/.test(ctx))
        fail(`${file} still references ${dead} as a live artifact: ...${ctx.slice(-60)}`);
    }
  }
}
ok("descoped LLM artifacts appear only as explicitly-rejected alternatives");
for (const t of ["Apache-2.0", "Typst", "Mammoth", "AGENTS.md", "available-models", "A1:H22"]) {
  if (!openQ.includes(t)) fail(`OPEN_QUESTIONS.md missing "${t}"`);
}
ok("OPEN_QUESTIONS.md records settled decisions and the spreadsheet schema as read");

// --- 13. Reference-document licensing. These are the checks that would catch the mistake
// this project is most likely to make: shipping a file we are not licensed to redistribute.
// The rule only means something if it is mechanical, so it is.

// 13a. TEMPLATES.md must be reachable from the spec and from the ADR that governs it.
if (!spec.includes("TEMPLATES.md")) fail("SPEC.md never references docs/TEMPLATES.md");
if (!read("docs/adr/0004-docx-renderer.md").includes("TEMPLATES.md")) fail("ADR-0004 never references docs/TEMPLATES.md");
ok("TEMPLATES.md is referenced from SPEC.md and ADR-0004");

// 13b. Every template TEMPLATES.md lists as non-redistributable must be absent from git,
// and the shipped three must be claimed as authored.
for (const shipped of ["academic-manuscript.docx", "technical-documentation.docx", "clean-report.docx"]) {
  if (!templates.includes(shipped)) fail(`TEMPLATES.md does not specify shipped template ${shipped}`);
}
if (!/authored by us and Apache-2\.0/.test(templates)) fail("TEMPLATES.md does not state the shipped templates' licence");
ok("TEMPLATES.md specifies all three shipped templates as authored + Apache-2.0");

// 13c. The IEEE template must be gitignored, and nothing under fixtures/local/ may be tracked.
if (!/^fixtures\/local\/$/m.test(gitignore)) fail(".gitignore does not ignore fixtures/local/");
ok(".gitignore excludes fixtures/local/ (third-party reference documents)");

// 13d. No office binary anywhere in the tree may be git-trackable. This is the real invariant:
// not "we intended to ignore it" but "git would not accept it".
const officeFiles = [];
const walkAll = (dir) => {
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    // `.next` is Next's build output: thousands of entries, none of them an office binary,
    // and walking it costs this gate its "runs on a fresh clone in under a second" property.
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
    const p = dir === "." ? e.name : dir + "/" + e.name;
    if (e.isDirectory()) walkAll(p);
    else if (/\.(docx|dotx|dot|xlsx|pptx|pdf)$/i.test(e.name)) officeFiles.push(p);
  }
};
walkAll(".");
const tracked = officeFiles.filter((p) => {
  const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: REPO });
  return r.status !== 0; // non-zero => NOT ignored => would be committed
});

// A committable office binary is allowed only if it is ours and registered. The
// original rule here was "no office binary may be committed at all", which was right
// while every one in the tree was third-party — but `docs/CORPUS.md` §2.3 and §2.15
// need deliberately defective DOCX fixtures, and those are generated by
// `build-messy-fixtures.mjs` from source in this repo. The invariant that actually
// matters is unchanged: nothing lands whose licence we have not written down, so a
// third-party template still cannot slip in.
const licenseRegister = existsSync(join(REPO, "fixtures/LICENSES.md"))
  ? read("fixtures/LICENSES.md")
  : "";
const unregistered = tracked.filter((p) => {
  const rel = p.replace(/^fixtures\//, "");
  return !licenseRegister.includes(`| ${rel} |`);
});
if (unregistered.length) {
  fail(
    `office binaries would be committed with no licence row in fixtures/LICENSES.md: ` +
      `${unregistered.join(", ")}`,
  );
} else if (tracked.length) {
  ok(
    `${tracked.length} office binary/ies are committable, and every one has a licence ` +
      `row in fixtures/LICENSES.md`,
  );
}
else ok(`all ${officeFiles.length} office binary/ies in the tree are gitignored (none redistributable)`);

// 13e. The fixtures licence register must exist and must explain its own emptiness, so an
// empty register cannot be mistaken for an unenforced rule.
if (!/no fixture lands without a licence line/i.test(fixReadme)) fail("fixtures/README.md does not state the licence rule");
if (!/ieee-conference-template\.docx/.test(fixLicenses)) fail("fixtures/LICENSES.md does not account for the IEEE template's exclusion");
// Every entry must name the failure mode it catches. check-fixtures.mjs enforces the
// per-row rule; here we only assert the register is not silently empty.
const registerRows = (fixLicenses.match(/^\| (md|docx|expected)\//gm) ?? []).length;
if (registerRows === 0) fail("fixtures/LICENSES.md register has no entries and no explanation");
ok("fixtures/ licence register exists, states the rule, and accounts for the excluded IEEE template");

// --- 13f. Root README and LICENSE must exist, and the LICENSE must actually be the licence
// ADR-0008 chose rather than a placeholder someone meant to fill in.
const readme = read("README.md");
const license = read("LICENSE");
if (!/Apache License\s*\n\s*Version 2\.0, January 2004/.test(license)) fail("LICENSE is not the Apache-2.0 text");
if (!license.includes("END OF TERMS AND CONDITIONS")) fail("LICENSE text is truncated");
ok(`LICENSE is the full canonical Apache-2.0 text (${license.length} bytes)`);

/*
 * The README must not oversell. It used to discharge that by carrying a `## Status` section
 * and the literal phrase "not yet built", which this check required.
 *
 * That requirement is retired, and the reason is drift rather than tone. A status summary in
 * the README is a *second copy* of something `docs/LIMITS.md` and `docs/STATUS.md` already
 * maintain, and the copy went stale twice in a single day: the README asserted "PDF output
 * … is not built yet" and marked PDF write as unavailable while both were false, and no check
 * noticed, because the phrase the gate searched for was present either way. A gate that
 * greps for a *phrase* verifies vocabulary, not accuracy.
 *
 * So the obligation moves to where it is maintained: the README must **link** the limitations
 * document, and that document must be substantive. `docs/LIMITS.md` is itself gated — every
 * struck capability there carries a numbered ruling, and `check-status-claims.mjs` holds
 * STATUS.md's rows to committed measurements.
 */
if (!readme.includes("docs/LIMITS.md")) {
  fail("README.md does not link docs/LIMITS.md, so a reader has no route to the known limits");
}
if (!readme.includes("docs/STATUS.md")) {
  fail("README.md does not link docs/STATUS.md, so a reader has no route to the delivery record");
}
{
  // A link to an empty file would satisfy the two checks above and disclose nothing.
  const limits = read("docs/LIMITS.md");
  const rows = (limits.match(/^[-|] /gm) ?? []).length;
  if (rows < 30) fail(`docs/LIMITS.md has only ${rows} entries — too thin to be the disclosure`);
}
for (const d of ["docs/SPEC.md", "docs/PRIOR_ART.md", "docs/CORPUS.md", "docs/TEMPLATES.md", "docs/OPEN_QUESTIONS.md", "docs/FIDELITY.md", "docs/adr/"]) {
  if (!readme.includes(d)) fail(`README.md does not link ${d}`);
}
if (!/fixtures\/` is not covered|fixtures\/ is not covered/.test(readme)) fail("README.md does not scope the licence away from fixtures/");
ok("README.md links every deliverable, routes to the limits and delivery records, and scopes the licence");

// FIDELITY.md is generated from measurements. A repo that ships fidelity claims
// without the generator having run is claiming something it has not measured.
if (existsSync(join(REPO, "docs/FIDELITY.md"))) {
  const fidelity = read("docs/FIDELITY.md");
  if (!/Measured, not claimed/.test(fidelity)) fail("docs/FIDELITY.md is missing its provenance line");
  if (!/\*\*mean\*\*/.test(fidelity)) fail("docs/FIDELITY.md has no mean row");
  // Any fixture name and any loop. The earlier pattern required `[a-z-]+` and a loop
  // starting `md` or `docx`, which silently skipped every `html->...` row and every
  // fixture with a digit in its name — a blind spot in the one check whose job is to
  // assert nothing was suppressed.
  const rows = (fidelity.match(/^\| [\w.-]+ \| \w+->[\w>-]+ \|/gm) ?? []).length;
  if (rows === 0) fail("docs/FIDELITY.md contains no measurements");
  else ok(`docs/FIDELITY.md reports ${rows} measured loop(s) with a mean row and no suppression`);
} else {
  fail("docs/FIDELITY.md is missing — run `pnpm fidelity --update`");
}

// A competitor comparison that hides its methodology is an advertisement, so the
// disclosure is asserted rather than trusted.
//
// The requirement is a section bounding the claim, not a specific verdict string. An
// earlier draft of this check asserted the literal phrase "is not met on that metric",
// which held while MarkForge was losing to Pandoc and would have had to be deleted the
// moment that changed — a check that only passes when the news is bad is not a check.
if (existsSync(join(REPO, "docs/SCOREBOARD.md"))) {
  const board = read("docs/SCOREBOARD.md");
  if (!/## Disclosed bias/.test(board)) fail("docs/SCOREBOARD.md does not disclose its bias");
  if (!/favours us/.test(board) || !/favours\s+Pandoc/.test(board)) {
    fail("docs/SCOREBOARD.md must name the bias in both directions, not only the flattering one");
  }
  if (!/## What this still does not show|## What would make this fair/.test(board)) {
    fail("docs/SCOREBOARD.md must state what the comparison does not show");
  }
  if (!/self-consistency/.test(board)) {
    fail("docs/SCOREBOARD.md is missing the shared-parser control CORPUS.md §3 requires");
  }
  ok("docs/SCOREBOARD.md discloses bias in both directions and bounds its own claim");

  // The scoreboard's numbers depend on the competitor's version, so CI pins pandoc and
  // byte-compares the committed file. That only holds while the pin and the version the
  // file records agree — and if they drift, the failure is a confusing diff in our own
  // numbers rather than an obvious "wrong pandoc", so it is worth a named check.
  const recorded = /Competitor: pandoc ([0-9][^.\s]*(?:\.[0-9]+)*)/.exec(board);
  const workflow = existsSync(join(REPO, ".github/workflows/ci.yml"))
    ? read(".github/workflows/ci.yml")
    : "";
  const pinned = /PANDOC_VERSION:\s*"([^"]+)"/.exec(workflow);
  if (!recorded) fail("docs/SCOREBOARD.md does not record which pandoc version produced it");
  else if (!pinned) fail(".github/workflows/ci.yml does not pin PANDOC_VERSION");
  else if (recorded[1] !== pinned[1]) {
    fail(
      `pandoc version drift: docs/SCOREBOARD.md records ${recorded[1]} but CI pins ` +
        `${pinned[1]}. Regenerate the scoreboard with the pinned version, or move the pin.`,
    );
  } else ok(`CI pins pandoc ${pinned[1]}, matching the version docs/SCOREBOARD.md records`);

  // The same discipline for the reference project, and for the same reason: the scoreboard's
  // numbers depend on the competitor's version, so a caret range would make our own scores
  // appear to move when someone else shipped a release. `word-to-markdown` is the npm name of
  // `benbalter/word-to-markdown-js`, the reference project this one is measured against
  // (docs/PRIOR_ART.md).
  const rootManifest = JSON.parse(read("package.json"));
  const w2mPin = rootManifest.devDependencies?.["word-to-markdown"];
  const w2mRecorded = /Reference project: word-to-markdown ([0-9][^\s(]*)/.exec(board);
  if (!w2mPin) {
    fail("package.json does not depend on word-to-markdown, so the reference baseline is absent");
  } else if (!/^\d+\.\d+\.\d+$/.test(w2mPin)) {
    fail(
      `word-to-markdown must be pinned to an exact version, not "${w2mPin}": the scoreboard ` +
        `records the version that produced it, and a range would let our own numbers appear ` +
        `to change when the competitor released.`,
    );
  } else if (!w2mRecorded) {
    fail("docs/SCOREBOARD.md does not record which word-to-markdown version produced it");
  } else if (w2mRecorded[1] !== w2mPin) {
    fail(
      `word-to-markdown version drift: docs/SCOREBOARD.md records ${w2mRecorded[1]} but ` +
        `package.json pins ${w2mPin}. Regenerate the scoreboard.`,
    );
  } else {
    ok(`word-to-markdown is pinned to ${w2mPin}, matching what docs/SCOREBOARD.md records`);
  }
} else {
  fail("docs/SCOREBOARD.md is missing — run `node scripts/run-scoreboard.mjs`");
}

// --- 14. Architecture invariants: is the package boundary still real?

// The dependency rule below is the one ADR-0009 relies on, and a rule that only inspects the
// packages that existed when it was written stops being a rule the moment a package is added.
// This list is maintained by hand: 14a fails when a name here has no directory, but nothing
// yet fails when a directory is missing from here — `http`, `mcp`, and `browser` are absent.
const PACKAGES = [
  "ir", "ooxml", "infer", "adapters-docx", "adapters-md",
  "render-md", "render-docx", "fidelity", "core", "cli",
  "adapters-html", "render-html", "adapters-office", "adapters-pdf",
  "llm", "adapters-ocr", "agentify",
];

// Enforces the naming half of **ADR-0011**: every package is under the `@markforge/*` scope
// and carries the project licence. The *public API shape* half of ADR-0011 — the three
// stability tiers and which packages are semver-stable — is NOT enforced here and is owed by
// `scripts/check-publish-tier.mjs` (docs/decisions/PUBLISHING.md). ADR-0011 says so in its
// own text rather than leaving this gate to imply full coverage.
//
// Enforces **ADR-0008**: Apache-2.0 for every package in the monorepo, asserted per manifest
// below and for the root LICENSE in 13f. ADR-0008 used to name `check-fixtures.mjs`, which
// governs *fixture* licensing — the one thing ADR-0008 explicitly excludes from its scope.
// 14a. Every package is private until publication is decided (OPEN_QUESTIONS §5),
// so an accidental `npm publish` is impossible rather than merely unlikely.
const notPrivate = [];
for (const name of PACKAGES) {
  const manifestPath = `packages/${name}/package.json`;
  if (!existsSync(join(REPO, manifestPath))) { fail(`missing ${manifestPath}`); continue; }
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.private !== true) notPrivate.push(name);
  if (manifest.license !== "Apache-2.0") fail(`${manifestPath}: license must be Apache-2.0 (ADR-0008)`);
}
if (notPrivate.length) fail(`packages not marked private: ${notPrivate.join(", ")}`);
else ok(`all ${PACKAGES.length} packages are private and Apache-2.0 licensed`);

/*
 * 14a-ii. `npx markforge` must appear nowhere, because it runs somebody else's package.
 *
 * The unscoped name `markforge` is taken on npm by an unrelated HTML-to-Markdown library
 * (`maqen/markforge`, v1.0.1, MIT) which ships `bin: null`. So the command a user is most
 * likely to guess — it is the binary name, and it is the shape every README in this
 * ecosystem uses — fetches the wrong package and fails with an error about a missing
 * executable that says nothing about why.
 *
 * `docs/decisions/PUBLISHING.md` resolves this by publishing `@markforge/cli` with
 * `bin: markforge`: the installed command is unchanged and only the `npx` form moves. That
 * resolution survives exactly as long as no document reintroduces the string, which is what
 * this checks. `npx -y @markforge/cli` and the bare installed `markforge` are both fine.
 */
const NPX_WRONG = /npx\s+(?:-y\s+|--yes\s+)?markforge\b/;
const npxOffenders = [];
/** Every place a user could read a command from: docs, the root README, the Action, the manifest. */
const commandBearing = [
  "README.md",
  "action.yml",
  "targets/mcp-manifest.json",
  ...Object.keys(allDocs).map((n) => `docs/${n}`),
];
for (const file of commandBearing) {
  if (!existsSync(join(REPO, file))) continue;
  read(file)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (NPX_WRONG.test(line)) npxOffenders.push(`${file}:${i + 1}`);
    });
}
if (npxOffenders.length) {
  fail(
    `"npx markforge" resolves to an unrelated npm package and would fail for every user: ` +
      `${npxOffenders.join(", ")}. Use "npx -y @markforge/cli" or the installed "markforge" binary.`,
  );
} else if (!NPX_WRONG.test("npx -y @markforge/cli mcp") && NPX_WRONG.test("npx markforge convert x.md")) {
  // Negative control inline: the pattern must reject the correct form and catch the wrong one.
  ok("no document tells a user to run `npx markforge`, which is somebody else's package");
} else {
  fail("the npx-collision predicate is broken: it does not separate the two forms");
}

// Enforces **ADR-0007** rule 1, the one architectural clause of that record that is real:
// `adapters-*` and `render-*` may depend on `ir`, `ooxml`, and `core`, and must not depend on
// `llm`, on each other, or on `cli`. ADR-0007's tooling table is amended in its own text —
// four of its twelve rows name tools nobody installed, and its rule 2 does not exist.
//
/*
 * 14a-iii. The merge-predicate escape hatch is reachable from exactly one place.
 *
 * `enforceMergePredicate: false` turns off the veto that makes `--llm` dedup safe — the one
 * that stops the adjudicator merging "must never be re-issued under the same reference" with
 * "must be re-issued under a fresh reference". It exists because
 * `scripts/check-merge-predicate.mjs` asks a counterfactual: *if* these two merged, what would
 * the output lose? Answering that requires forcing a merge, which requires standing the veto
 * down.
 *
 * The previous version of this claim was a sentence in three comments saying "nothing in
 * @markforge/cli sets it". That is the annotation defect again — a promise about code, kept by
 * whoever reads the comment. This resolves it against the tree, `dist/` included, because a
 * stale bundle shipping a caller that disables the veto is the failure that matters.
 */
/** Setting it, in either the object-literal or the assignment form. Comparisons do not count. */
const PREDICATE_DISABLED = /enforce(?:Merge)?Predicate\s*(?::|=(?!=))\s*false/;

/*
 * One rule: **nothing outside the allowlist may set this flag.**
 *
 * The allowlist is the two agentify modules that declare and forward it — matched by basename
 * so their compiled output is covered without exempting `dist/` wholesale, which would have
 * exempted the CLI bundle too — plus the grading script that is the reason it exists, plus
 * this file, which necessarily contains the pattern.
 *
 * `===` is excluded from the pattern on purpose: `compile.ts` reads the option with a
 * comparison and forwards it with an assignment, and only the second is the hazard.
 */
const FLAG_DECLARING = /^packages\/agentify\/(src|dist)\/(dedup|compile)\.(ts|js)$/;
const FLAG_ALLOWED = (f) =>
  FLAG_DECLARING.test(f) || f === "scripts/check-merge-predicate.mjs" || f === "scripts/check-docs.mjs";

const disableOffenders = sourceTree().filter((f) => !FLAG_ALLOWED(f) && PREDICATE_DISABLED.test(read(f)));
if (disableOffenders.length) {
  fail(
    `the merge-predicate veto is disabled in ${disableOffenders.join(", ")}. Only ` +
      `scripts/check-merge-predicate.mjs may do that, and only because its question is a ` +
      `counterfactual (CORPUS §2.14.1, docs/ROADMAP.md).`,
  );
} else {
  ok(`the merge-predicate veto is disabled nowhere outside its one script (${sourceTree().length} files scanned, dist/ included)`);
}

/*
 * The control. Without it, a pattern that stopped matching would make the check above pass by
 * matching nothing — which is the vacuous-check defect this repository has now found five
 * times, so every predicate of this shape gets one.
 */
if (PREDICATE_DISABLED.test(read("scripts/check-merge-predicate.mjs"))) {
  ok("the disable pattern matches the one legitimate call site, so it can detect another");
} else {
  fail(
    "the disable pattern does not match scripts/check-merge-predicate.mjs, which does disable " +
      "the veto — so the check above is matching nothing",
  );
}
if (PREDICATE_DISABLED.test("compile({ enforceMergePredicate: false })") &&
    !PREDICATE_DISABLED.test("if (options.enforceMergePredicate === false) {")) {
  ok("the disable pattern separates setting the flag from reading it");
} else {
  fail("the disable pattern cannot tell `: false` from `=== false`");
}

/*
 * 14a-iv. `action.yml`'s description must stay publishable. Belongs with 14a-ii — both guard a
 * string in `action.yml` that only the Marketplace or npm ever reads, which is exactly the kind
 * nothing else exercises.
 *
 * The limit is 125 characters and it is **not** in the metadata syntax reference. The
 * draft-release form rejected a 198-character description with "Description must be less than
 * 125 characters"; the release was blocked until it was cut. Nothing in `pnpm verify` could
 * have said so, because a description is not parsed by anything this repository runs — the
 * first thing to read it was the publish form, after the work was called done.
 *
 * The folded scalar is joined the way YAML joins it rather than read line by line, since the
 * line lengths in the file are a formatting choice and the limit applies to the value.
 */
const ACTION_DESCRIPTION_LIMIT = 125;
/** Join a `>-` folded block the way YAML does: lines to spaces, no trailing newline. */
const foldedDescription = (yaml) => {
  const m = yaml.match(/^description: >-\n((?:[ \t]+.*\n)+)/m);
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ") : null;
};
const actionDescription = foldedDescription(read("action.yml"));
if (actionDescription === null) {
  fail("action.yml has no folded `description: >-` block, so 14a-iv is measuring nothing");
} else if (actionDescription.length >= ACTION_DESCRIPTION_LIMIT) {
  fail(
    `action.yml description is ${actionDescription.length} characters; the GitHub Marketplace ` +
      `draft-release form rejects anything not under ${ACTION_DESCRIPTION_LIMIT}. Shorten it — ` +
      `which subcommands exist is the \`command\` input's job.`,
  );
} else if (
  // Negative control: the measurement must reject an over-long block and fold multiple lines.
  foldedDescription("description: >-\n  " + "x".repeat(130) + "\n").length >= ACTION_DESCRIPTION_LIMIT &&
  foldedDescription("description: >-\n  one\n  two\n") === "one two"
) {
  ok(`action.yml description is ${actionDescription.length} characters, under the Marketplace limit of ${ACTION_DESCRIPTION_LIMIT}`);
} else {
  fail("the description measurement is broken: it does not fold lines or does not detect an over-long value");
}

// 14b. The dependency rule from ADR-0009 and SPEC §6: adapters and renderers must
// not reach the LLM. Enforced as a build failure rather than a policy, because a
// policy that is only written down is a preference.
const forbidden = [];
for (const name of PACKAGES) {
  if (!name.startsWith("adapters-") && !name.startsWith("render-")) continue;
  const manifest = JSON.parse(read(`packages/${name}/package.json`));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep === "@markforge/llm") forbidden.push(`${name} -> ${dep}`);
  }
}
if (forbidden.length) fail(`adapters/renderers must not depend on the LLM layer: ${forbidden.join(", ")}`);
else ok("no adapter or renderer depends on @markforge/llm (ADR-0009)");

// 14b-ii. The manifest check above is necessary and not sufficient: a stray
// `import "@markforge/llm"` in an adapter would typecheck through the workspace's hoisted
// node_modules while the manifest stayed clean, and the rule would pass while being false.
// ADR-0017 leans on this boundary hard enough — an LLM-backed OCR engine reached only through
// an injected function type — that it is worth checking the source and not the promise.
const sourceViolations = [];
for (const name of PACKAGES) {
  if (!name.startsWith("adapters-") && !name.startsWith("render-") && name !== "infer") continue;
  const dir = join(REPO, `packages/${name}/src`);
  if (!existsSync(dir)) continue;
  const walkSrc = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkSrc(p);
      // An import, not a mention: ADR-0017's argument is written in a comment inside
      // adapters-ocr, and a check that fires on the prose explaining the rule is a check
      // someone deletes. `from "…"`, `import("…")`, and `require("…")` are the three ways
      // a module can actually arrive.
      else if (
        e.name.endsWith(".ts") &&
        /(?:from|import|require)\s*\(?\s*["']@markforge\/llm["']/.test(readFileSync(p, "utf8"))
      ) {
        sourceViolations.push(`${name}/${e.name}`);
      }
    }
  };
  walkSrc(dir);
}
if (sourceViolations.length) {
  fail(
    `adapters, renderers, and infer must not import @markforge/llm even transitively: ` +
      `${sourceViolations.join(", ")}. The recogniser and the heading tie-breaker are ` +
      `injected function types (ADR-0017); nothing on the conversion path imports the model.`,
  );
} else ok("no adapter, renderer, or inference source file mentions @markforge/llm (ADR-0009, ADR-0017)");

// 14c. The IR package must not depend on any adapter or renderer. The IR is the
// contract between them; a dependency in this direction would make it one of them.
const irManifest = JSON.parse(read("packages/ir/package.json"));
const irDeps = Object.keys(irManifest.dependencies ?? {});
const irViolations = irDeps.filter((d) => /^@markforge\/(adapters|render)-/.test(d));
if (irViolations.length) fail(`@markforge/ir must not depend on adapters or renderers: ${irViolations.join(", ")}`);
else ok("@markforge/ir depends on no adapter or renderer, so the contract stays neutral");

// 14d. Generated files must not be hand-edited: they carry a banner saying so, and
// a missing banner means someone removed it to make an edit look legitimate.
for (const generated of ["packages/ir/src/generated/ir.ts", "packages/core/src/generated/config.ts"]) {
  if (!existsSync(join(REPO, generated))) { fail(`missing generated file ${generated}`); continue; }
  const text = read(generated);
  if (!/GENERATED FILE — DO NOT EDIT/.test(text)) fail(`${generated} has lost its do-not-edit banner`);
  if (!/Regenerate: pnpm codegen/.test(text)) fail(`${generated} does not say how to regenerate it`);
}
ok("generated type modules carry their do-not-edit banner and regeneration command");

// 14e. Build output must never be committed.
const distTracked = spawnSync("git", ["ls-files", "packages/*/dist"], { cwd: REPO, encoding: "utf8" });
if ((distTracked.stdout ?? "").trim().length > 0) fail("build output under packages/*/dist is tracked by git");
else ok("no build output is tracked by git");

// 14f. Everything in scripts/ is a check or a documented tool.
const scriptFiles = readdirSync(join(REPO, "scripts")).filter((f) => f !== "README.md");
const scriptsReadme = read("scripts/README.md");
const undocumented = scriptFiles.filter((f) => !scriptsReadme.includes(f));
if (undocumented.length) fail(`scripts/ files not documented in scripts/README.md: ${undocumented.join(", ")}`);
else ok(`all ${scriptFiles.length} files in scripts/ are documented in scripts/README.md`);

console.log(failures === 0 ? "\nALL COVERAGE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
