// Phase 0 schema check. Compiles the three JSON Schemas under ajv strict mode and validates the
// worked examples in docs/examples/ against the IR schema, including the adapter-contract
// invariants that a schema alone cannot express (rule A4: every node has provenance; every
// `unknown` node has a lossy diagnostic).
//
// Requires ajv + ajv-formats, which Phase 0 deliberately does not install (there is no
// package.json yet — see docs/OPEN_QUESTIONS.md). Until the Phase 1 workspace exists, run:
//   npm i --no-save ajv ajv-formats && node scripts/check-schemas.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let Ajv2020, addFormats;
try {
  Ajv2020 = (await import("ajv/dist/2020.js")).default;
  addFormats = (await import("ajv-formats")).default;
} catch {
  console.log(
    "SKIP schema checks: ajv is not installed.\n" +
    "      Phase 0 ships no package.json, so install transiently:\n" +
    "        npm i --no-save ajv ajv-formats && node scripts/check-schemas.mjs\n" +
    "      Exiting 0 — a missing dev dependency is not a spec failure."
  );
  process.exit(0);
}

// Resolved from the script's own location, so this works from any clone.
const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const schemas = {
  ir: "packages/ir/schema/ir.v0.schema.json",
  target: "packages/agentify/schema/target.v0.schema.json",
  config: "schema/markforge.config.v0.schema.json",
};

let failures = 0;
const fail = (m) => { failures++; console.log("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

// 1. Each schema compiles against the 2020-12 meta-schema.
const compiled = {};
for (const [name, path] of Object.entries(schemas)) {
  const doc = read(path);
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  // MarkForge's own annotations. Declared rather than tolerated: strict mode should
  // still reject a typo'd keyword, so the vocabulary is an explicit list of two.
  // x-salient   — per-node-type allowlist feeding the NodeId digest (ADR-0014)
  // x-salientDoc — prose explaining the above, inside the schema for self-containment
  ajv.addVocabulary(["x-salient", "x-salientDoc"]);
  try {
    compiled[name] = ajv.compile(doc);
    ok(`${name}: compiles under draft 2020-12 strict mode (${path})`);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}

// 2. Every example IR document validates against the IR schema.
if (compiled.ir) {
  const dir = "docs/examples";
  for (const f of readdirSync(join(REPO, dir)).filter((f) => f.endsWith(".json")).sort()) {
    const doc = read(join(dir, f));
    if (compiled.ir(doc)) ok(`ir: ${f} validates`);
    else {
      fail(`ir: ${f}`);
      for (const e of compiled.ir.errors.slice(0, 12)) {
        console.log(`       ${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`);
      }
    }
  }
}

// 3. Structural invariants the schema cannot express (docs/SPEC.md A4, section 2.6).
if (compiled.ir) {
  const dir = "docs/examples";
  for (const f of readdirSync(join(REPO, dir)).filter((f) => f.endsWith(".json")).sort()) {
    const doc = read(join(dir, f));
    const ids = [];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (typeof n.type === "string" && typeof n.id === "string") ids.push(n.id);
      for (const k of ["children", "body", "notes", "content"]) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };
    walk(doc.body);
    for (const fu of doc.furniture ?? []) walk(fu.content);

    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) fail(`${f}: duplicate node ids ${[...new Set(dupes)].join(", ")}`);

    const missing = ids.filter((id) => !(id in doc.provenance));
    if (missing.length) fail(`${f}: A4 violation, ${missing.length} node(s) lack provenance: ${missing.slice(0, 5).join(", ")}`);
    else ok(`${f}: A4 satisfied, all ${ids.length} nodes have provenance`);

    const orphanSidecar = Object.keys(doc.sidecar ?? {}).filter((id) => !ids.includes(id));
    if (orphanSidecar.length) fail(`${f}: sidecar keys with no node: ${orphanSidecar.join(", ")}`);

    const orphanProv = Object.keys(doc.provenance ?? {}).filter((id) => !ids.includes(id));
    if (orphanProv.length) fail(`${f}: provenance keys with no node: ${orphanProv.join(", ")}`);

    // section 2.6: every unknown node must have an accompanying lossy diagnostic.
    const unknownIds = [];
    const walkUnknown = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "unknown") unknownIds.push(n.id);
      for (const k of ["children", "body", "notes", "content"]) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walkUnknown);
        else if (v && typeof v === "object") walkUnknown(v);
      }
    };
    walkUnknown(doc.body);
    for (const u of unknownIds) {
      const d = (doc.diagnostics ?? []).find((d) => d.nodeId === u && d.lossy === true);
      if (d) ok(`${f}: unknown node ${u} has lossy diagnostic ${d.code}`);
      else fail(`${f}: unknown node ${u} has no lossy diagnostic (violates SPEC section 2.6)`);
    }

    // Heading depth must be min(resolvedLevel, 6).
    const hs = [];
    const walkH = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "heading") hs.push(n);
      for (const k of ["children", "body", "notes", "content"]) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walkH);
        else if (v && typeof v === "object") walkH(v);
      }
    };
    walkH(doc.body);
    for (const h of hs) {
      if (h.depth !== Math.min(h.resolvedLevel, 6))
        fail(`${f}: heading ${h.id} depth ${h.depth} != min(resolvedLevel ${h.resolvedLevel}, 6)`);
    }
    if (hs.length) ok(`${f}: ${hs.length} heading(s) have consistent depth/resolvedLevel`);
  }
}

// 4. The config example embedded in SPEC.md section 7 must validate.
if (compiled.config) {
  const example = {
    profile: "technical-documentation",
    strict: false,
    markdown: { flavor: "gfm", headings: "atx", bullet: "-", emphasis: "_", strong: "*", fence: "`", fences: true, listIndent: "one", lineWidth: 0, lint: { config: ".markdownlint.jsonc", autofix: true, maxIterations: 8 } },
    whitespace: { emptyParagraphsToSpacing: true, collapseInteriorWhitespace: true, preserveHardBreaks: true, trimTrailing: true },
    docx: { referenceDoc: "./templates/technical.docx", styleMap: { "heading:1": "Heading 1", "admonition:warning": "Block Text" }, onMissingStyle: "warn", revisionMode: "clean" },
    pdf: { engine: "typst", theme: "./themes/technical.typ", fonts: [{ family: "Inter", files: ["./fonts/Inter.ttf"] }], standard: "pdf/a-3b", ignoreSystemFonts: true },
    html: { stylesheet: "./themes/technical.css", singleFile: false },
    inference: { headings: true, lists: true, tables: true, ambiguityMargin: 0.15 },
    llm: { enabled: false, baseUrl: "https://api.ai.it.ufl.edu/v1", apiKeyEnv: "MODEL_API_KEY", models: { fast: "gpt-oss-120b", strong: "nemotron-3-super-120b-a12b", vision: "gemma-4-31b-it" }, cache: { dir: ".markforge/llm-cache", mode: "readWrite" }, budget: { maxTokens: 200000 }, maxRepairs: 2 },
    agentify: { targets: ["agents-md", "claude-md", "claude-skills", "mcp-manifest"], registry: "./targets", outDir: ".", conflicts: "report", traceability: { required: 1.0 } },
    fidelity: { baseline: "./fidelity/baselines.json", tolerance: 0.005 },
  };
  if (compiled.config(example)) ok("config: SPEC.md section 7 example validates");
  else { fail("config: SPEC.md section 7 example"); console.log(JSON.stringify(compiled.config.errors, null, 2)); }

  // llm.enabled=true must require baseUrl/apiKeyEnv/models (ADR-0009).
  if (compiled.config({ llm: { enabled: true } })) fail("config: llm.enabled=true accepted without baseUrl/apiKeyEnv/models");
  else ok("config: llm.enabled=true correctly requires endpoint fields");

  // All four roles are required when enabled: a partial models block must not pass.
  if (compiled.config({ llm: { enabled: true, baseUrl: "https://api.ai.it.ufl.edu/v1", apiKeyEnv: "MODEL_API_KEY", models: { fast: "gpt-oss-120b" } } }))
    fail("config: llm.enabled=true accepted a partial models block");
  else ok("config: all four model roles are mandatory when llm is enabled");

  // The role names are closed and the bindings are open (OPEN_QUESTIONS §7c): rebinding a
  // task must be accepted, an unknown role or an unknown task name must not.
  const bound = (taskRoles) => compiled.config({ llm: { taskRoles } });
  if (!bound({ "heading-tiebreak": "strong" })) fail("config: rebinding a task to another role was rejected");
  else ok("config: a task may be rebound to any of the four roles");
  if (bound({ "heading-tiebreak": "gigantic" })) fail("config: unknown llm role accepted");
  else if (bound({ "heading-tiebrake": "fast" })) fail("config: misspelled task name accepted");
  else ok("config: unknown roles and misspelled task names are both rejected");

  // The descoped fields must be gone, not merely undocumented (ADR-0009).
  for (const dead of [{ registry: "./models.registry.json" }, { routing: "./routing.policy.json" }]) {
    if (compiled.config({ llm: { ...dead } })) fail(`config: descoped llm field still accepted: ${Object.keys(dead)[0]}`);
  }
  if (compiled.config({ llm: { budget: { maxUsd: 0 } } })) fail("config: descoped llm.budget.maxUsd still accepted");
  else ok("config: descoped registry/routing/maxUsd fields are rejected");

  if (compiled.config({ markdown: { flavor: "not-a-flavor" } })) fail("config: bad enum accepted");
  else ok("config: unknown markdown.flavor rejected");
}

// 5. Target profiles must validate.
if (compiled.target) {
  const base = {
    id: "agents-md",
    targetVersion: "0.1.0",
    displayName: "AGENTS.md",
    kind: "flatMarkdown",
    tier: "firstClass",
    docsUrl: "https://agents.md/",
    verifiedAgainst: { url: "https://agents.md/", date: "2026-07-29", note: "Linux Foundation AAIF standard" },
    outputs: [{ path: "AGENTS.md", role: "primary" }, { path: "docs/agents/{slug}.md", role: "secondary" }],
    budget: { primaryTokens: 6000, secondaryTokens: 24000, counter: { method: "approximate", charsPerToken: 3.8 }, overflow: "linkToSecondary" },
    frontMatter: { supported: false },
    imports: { supported: true, syntax: "[{title}]({path})", maxDepth: 1 },
    sections: [
      { id: "overview", heading: "Project overview", headingLevel: 2, categories: ["entity"], render: "prose" },
      { id: "commands", heading: "Commands", headingLevel: 2, categories: ["command"], render: "codeBlock" },
      { id: "conventions", heading: "Conventions", headingLevel: 2, categories: ["convention", "antiPattern"], render: "bulletList" },
      { id: "constraints", heading: "Constraints", headingLevel: 2, categories: ["constraint", "invariant"], render: "bulletList" },
    ],
    tone: { voice: "imperative", person: "second" },
    traceability: { required: 1.0, sentenceSegmenter: "icu" },
  };
  if (compiled.target(base)) ok("target: agents-md base profile validates");
  else { fail("target: agents-md"); console.log(JSON.stringify(compiled.target.errors, null, 2)); }

  const cursor = {
    id: "cursor-rules",
    targetVersion: "0.1.0",
    displayName: "Cursor project rules",
    extends: "agents-md",
    kind: "scopedRuleSet",
    tier: "stub",
    verifiedAgainst: { url: "https://docs.cursor.com/context/rules", date: "2026-07-29" },
    outputs: [{ path: ".cursor/rules/{slug}.mdc", role: "primary" }],
    budget: { primaryTokens: 2000, counter: { method: "approximate" } },
    frontMatter: {
      supported: true,
      language: "yaml",
      required: ["description", "globs", "alwaysApply"],
      schema: {
        type: "object",
        properties: { description: { type: "string" }, globs: { type: "array", items: { type: "string" } }, alwaysApply: { type: "boolean" } },
        required: ["description", "globs", "alwaysApply"],
      },
    },
    imports: { supported: false },
    scoping: { byGlob: true, globField: "globs", alwaysApplyField: "alwaysApply" },
    sections: [{ id: "rules", heading: "Rules", categories: ["convention", "constraint"], render: "bulletList" }],
  };
  if (compiled.target(cursor)) ok("target: cursor scopedRuleSet with glob front matter validates");
  else { fail("target: cursor-rules"); console.log(JSON.stringify(compiled.target.errors, null, 2)); }

  if (compiled.target({ id: "no-verify", targetVersion: "0.1.0", displayName: "x", kind: "flatMarkdown", outputs: [{ path: "X.md", role: "primary" }], budget: { primaryTokens: 100, counter: { method: "approximate" } } }))
    fail("target: profile without verifiedAgainst accepted");
  else ok("target: verifiedAgainst is correctly mandatory");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
