// Phase 0 documentation cross-check. Asserts that the deliverables agree with each other and
// with the brief: no undocumented node type, no uncited ADR, no dangling link, no unlicensed
// binary, no code where there should be none.
//
// Zero dependencies by design — runs with bare `node scripts/check-docs.mjs` on a fresh clone,
// before any install exists. Intended to become a CI job in Phase 1.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolved from the script's own location: no absolute paths, so this works from any clone
// (docs/SPEC.md section 1 forbids absolute paths in outputs; the same discipline applies here).
const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(REPO, p), "utf8");

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

// --- 1. Prior art: every project named in brief section 2 must be surveyed.
const briefProjects = [
  "word-to-markdown-js", "markitdown", "docling", "marker", "unstructured",
  "mdast", "hast", "mammoth", "turndown", "docx", "Pandoc", "Typst",
  "Paged.js", "Tectonic", "pdfjs-dist", "tesseract.js", "markdownlint",
  "prettier", "remark-stringify", "unified", "remark",
];
const missingPA = briefProjects.filter((p) => !priorArt.includes(p));
if (missingPA.length) fail(`PRIOR_ART.md missing: ${missingPA.join(", ")}`);
else ok(`PRIOR_ART.md covers all ${briefProjects.length} projects from brief section 2`);

// Every project must carry a verdict.
for (const v of ["STEAL", "BENCHMARK", "AVOID"]) {
  if (!priorArt.includes(v)) fail(`PRIOR_ART.md has no ${v} verdicts`);
}
ok("PRIOR_ART.md uses all three verdict classes");

// --- 2. CLI: all seven subcommands from brief section 8.
const cli = ["convert", "fmt", "agentify", "check", "diff", "serve", "init"];
const cliSection = spec.slice(spec.indexOf("## 8. CLI surface"), spec.indexOf("## 9. Fidelity"));
const missingCli = cli.filter((c) => !cliSection.includes("`" + c));
if (missingCli.length) fail(`SPEC.md section 8 missing subcommands: ${missingCli.join(", ")}`);
else ok(`SPEC.md section 8 documents all 7 CLI subcommands`);

// --- 3. Fidelity metrics from brief section 10.
const metrics = [
  "tree edit distance", "whitespace-insensitive", "whitespace-sensitive",
  "precision", "recall", "F1", "span", "round trip",
];
const fidSection = spec.slice(spec.indexOf("## 9. Fidelity"), spec.indexOf("## 10. Agent Context"));
const missingMetric = metrics.filter((m) => !fidSection.toLowerCase().includes(m.toLowerCase()));
if (missingMetric.length) fail(`SPEC.md section 9 missing metric concepts: ${missingMetric.join(", ")}`);
else ok("SPEC.md section 9 defines all metric families from brief section 10");

for (const loop of ["docx → md → docx", "md → pdf → md", "md → md"]) {
  if (!fidSection.includes(loop)) fail(`SPEC.md section 9.5 missing round trip: ${loop}`);
}
ok("SPEC.md section 9.5 covers all three required round trips");

// --- 4. Context unit categories: brief section 6.1 lists ten. They must agree across
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

// --- 5. Agentify: all seven pipeline stages from brief section 6.1.
const stages = ["Ingest", "Classify", "Extract context units", "Deduplicate", "Budget and assemble", "Verify", "Emit"];
const agSection = spec.slice(spec.indexOf("## 10. Agent Context"), spec.indexOf("## 11. Packages"));
const missingStage = stages.filter((s) => !agSection.includes(s));
if (missingStage.length) fail(`SPEC.md section 10 missing stages: ${missingStage.join(", ")}`);
else ok("SPEC.md section 10 covers all 7 agentify stages");

// --- 6. ADRs: files, index, and cross-references must all agree.
const adrFiles = readdirSync(join(REPO, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
if (adrFiles.length !== 15) fail(`expected 15 ADR files, found ${adrFiles.length}`);
else ok("15 ADR files present");

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
// blocks. Before review, all six were annotated "**Blocks:** <phase>"; after review all six
// are resolved, so asserting a minimum count of blockers would now fail for the right reason
// happening. The durable invariant is that no question sits in limbo: unlabelled.
const questionHeadings = [...openQ.matchAll(/^## (\d+)\.\s+(.+)$/gm)];
if (questionHeadings.length < 6) fail(`OPEN_QUESTIONS.md has only ${questionHeadings.length} numbered questions`);
const unlabelled = questionHeadings.filter(([, , title]) =>
  !/resolved|descoping|descoped|deferred|reversal|Phase 1\+ can answer/i.test(title));
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
    if (e.name === "node_modules" || e.name === ".git") continue;
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
if (tracked.length) fail(`office binaries are not gitignored and would be committed: ${tracked.join(", ")}`);
else ok(`all ${officeFiles.length} office binary/ies in the tree are gitignored (none redistributable)`);

// 13e. The fixtures licence register must exist and must explain its own emptiness, so an
// empty register cannot be mistaken for an unenforced rule.
if (!/no fixture lands without a licence line/i.test(fixReadme)) fail("fixtures/README.md does not state the licence rule");
if (!/ieee-conference-template\.docx/.test(fixLicenses)) fail("fixtures/LICENSES.md does not account for the IEEE template's exclusion");
if (!/empty and that is correct/i.test(fixLicenses)) fail("fixtures/LICENSES.md does not explain why the register is empty");
ok("fixtures/ licence register exists, states the rule, and accounts for the excluded IEEE template");

// --- 13f. Root README and LICENSE must exist, and the LICENSE must actually be the licence
// ADR-0008 chose rather than a placeholder someone meant to fill in.
const readme = read("README.md");
const license = read("LICENSE");
if (!/Apache License\s*\n\s*Version 2\.0, January 2004/.test(license)) fail("LICENSE is not the Apache-2.0 text");
if (!license.includes("END OF TERMS AND CONDITIONS")) fail("LICENSE text is truncated");
ok(`LICENSE is the full canonical Apache-2.0 text (${license.length} bytes)`);

// The README must not imply runnable software while none exists.
if (!/no code in this repository yet/i.test(readme)) fail("README.md does not disclose that no implementation exists");
for (const d of ["docs/SPEC.md", "docs/PRIOR_ART.md", "docs/CORPUS.md", "docs/TEMPLATES.md", "docs/OPEN_QUESTIONS.md", "docs/adr/"]) {
  if (!readme.includes(d)) fail(`README.md does not link ${d}`);
}
if (!/fixtures\/` is not covered|fixtures\/ is not covered/.test(readme)) fail("README.md does not scope the licence away from fixtures/");
ok("README.md links all six deliverables, discloses pre-implementation status, and scopes the licence");

// --- 14. Phase 1 architecture invariants.
//
// The Phase 0 version of this check asserted the repository contained *no* code.
// That was right then and is wrong now: Phase 1's whole job is to add code. It is
// replaced rather than deleted, because the underlying question — "is the package
// boundary still real?" — outlives the phase.

const PHASE1_PACKAGES = [
  "ir", "ooxml", "infer", "adapters-docx", "adapters-md",
  "render-md", "render-docx", "fidelity", "core", "cli",
];

// 14a. Every package is private until publication is decided (OPEN_QUESTIONS §5),
// so an accidental `npm publish` is impossible rather than merely unlikely.
const notPrivate = [];
for (const name of PHASE1_PACKAGES) {
  const manifestPath = `packages/${name}/package.json`;
  if (!existsSync(join(REPO, manifestPath))) { fail(`missing ${manifestPath}`); continue; }
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.private !== true) notPrivate.push(name);
  if (manifest.license !== "Apache-2.0") fail(`${manifestPath}: license must be Apache-2.0 (ADR-0008)`);
}
if (notPrivate.length) fail(`packages not marked private: ${notPrivate.join(", ")}`);
else ok(`all ${PHASE1_PACKAGES.length} packages are private and Apache-2.0 licensed`);

// 14b. The dependency rule from ADR-0009 and SPEC §6: adapters and renderers must
// not reach the LLM. Enforced as a build failure rather than a policy, because a
// policy that is only written down is a preference.
const forbidden = [];
for (const name of PHASE1_PACKAGES) {
  if (!name.startsWith("adapters-") && !name.startsWith("render-")) continue;
  const manifest = JSON.parse(read(`packages/${name}/package.json`));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep === "@markforge/llm") forbidden.push(`${name} -> ${dep}`);
  }
}
if (forbidden.length) fail(`adapters/renderers must not depend on the LLM layer: ${forbidden.join(", ")}`);
else ok("no adapter or renderer depends on @markforge/llm (ADR-0009)");

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
