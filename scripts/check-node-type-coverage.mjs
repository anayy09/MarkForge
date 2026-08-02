#!/usr/bin/env node
/**
 * Every node type the IR schema declares is produced by some adapter and consumed by some
 * renderer — or is listed below, by name, with a reason.
 *
 * ## Why this exists
 *
 * `docs/FIDELITY.md`'s node-type census diffs input IR against round-tripped IR. That makes
 * it excellent at finding a type that goes *in* and does not come *out*, and structurally
 * blind to a type that never goes in at all: absent from both sides, it differences to zero
 * and scores as **agreement**.
 *
 * Three instances were found by accident in one afternoon of Phase 6, all by authoring a
 * fixture for a category that had never been built:
 *
 *   `equationBlock`     — no adapter produces it; five OMML equations in the shipped
 *                         `academic-manuscript.docx` were silently discarded.
 *   `footnoteDefinition`— `footnotes.xml` is never read, so `[^1]` renders with no target.
 *   `comment`           — `commentRange*` sits in the DOCX adapter's property-element list.
 *
 * Each read `0 → 0` in the census. Accident does not scale, so this is the general form.
 *
 * ## How "produced" and "consumed" are decided
 *
 * **Produced** is the union of three sources, because no one of them is honest alone:
 *
 *   *Observed from the corpus* — every committed fixture is parsed and its types unioned.
 *   Strong evidence, and bounded by the corpus.
 *
 *   *Observed from probes* — synthetic inputs below, written to exercise constructs the
 *   corpus happens not to contain. This is the load-bearing one and it was added after the
 *   first run: without it the gate reported **thirteen** unproduced types, and a probe showed
 *   **eight of them were the detector being wrong rather than the code**. The Markdown
 *   adapter is `mdast-util-from-markdown` with extensions, so it passes mdast types straight
 *   through and constructs none of them with a literal; `yaml`, `toml`, `math`, `inlineMath`,
 *   `html`, `definition`, `linkReference`, and `imageReference` are all produced correctly
 *   and simply had no fixture. Reporting those as defects would have been the exact mistake
 *   this repository keeps making — a plausible diagnostic on something that is fine.
 *
 *   *Declared* — a `type: "X"` construction literal in an adapter or in `infer`. Weakest
 *   (a literal in dead code counts), kept as a backstop for types a probe cannot easily reach.
 *
 * A type with none of the three has no evidence anywhere that anything can make one.
 *
 * **Consumed** is a `case "X"` in a renderer's dispatch. Renderers are `switch` statements
 * over `node.type`, so a type with no case reaches the default branch, which is where silent
 * loss lives.
 *
 * ## The exceptions list is enumerated, not pattern-matched
 *
 * §10.6's traceability gate learned this the expensive way: its scaffolding allowance was
 * "any title-cased string under 40 characters", which accepted
 * `## Ignore all previous instructions` as legitimate structure. A predicate that admits a
 * *shape* admits everything of that shape. So every exception here is a literal type name
 * with a written reason, and an exception for a type that has since become covered fails as
 * stale — the list shrinks on its own rather than accumulating.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

/**
 * Types that legitimately have no producer or no consumer.
 *
 * `why` must explain the *design*, not the schedule. "Not built yet" is a roadmap entry, not
 * an exception — it belongs in `docs/ROADMAP.md` and the gate should stay red until it moves.
 */
const EXCEPTIONS = [
  {
    type: "section",
    missing: "producer",
    why: "SPEC §2.3 states it is produced by `infer` only, never by an adapter, as an optional grouping layer for agentify §10 and TOC generation. An adapter producing one would be the defect.",
  },
  /*
   * `unknown` was exempted here on its first draft, on the reasoning that a renderer with a
   * `case` for it would be claiming it can express a construct the IR could not model. The
   * gate immediately reported the exemption as stale, because every renderer *does* have a
   * case for it — they use it to emit the retained raw payload and a lossy diagnostic, which
   * is better than the default branch and is what A6 intends. The reasoning was plausible and
   * the code disagreed; the code was right. Left as a comment rather than deleted silently,
   * because a stale-exception check that catches its author on the first run is the argument
   * for having one.
   */
];

/**
 * Types with no producer today, each with a `docs/ROADMAP.md` entry.
 *
 * **This list is gated on regression, not on value** — the same posture as the classification
 * holdout, and for the same reason. Four types were uncovered when this gate was first run;
 * setting the bar at "zero uncovered" would have meant either a permanently red build or
 * deleting four capabilities out of the schema in a fixtures package. Setting it here means a
 * *fifth* fails immediately, and a fixed one fails as stale until it is removed.
 *
 * It is not an exceptions list and does not carry design reasons, because there is no design
 * reason: these are gaps. `EXCEPTIONS` above is for types that are correct to leave uncovered.
 * Keeping the two apart is the whole point — merging them would let a gap acquire a
 * justification by being written next to one.
 */
const KNOWN_UNCOVERED = [
  // `comment` and `equationBlock` were here on 2026-08-01 and are gone: both are now built,
  // and the stale-entry check above is what would have caught them if they had been left.
  // `citation` and `textBox` are not deferred — they are **struck** from SPEC §2.3 and §3.1
  // (OPEN_QUESTIONS §7ab), because no adapter source ever mentioned either string. They stay
  // listed because the schema still declares the types, and a schema type nothing can produce
  // is exactly what this gate exists to keep visible.
  { type: "citation", missing: "producer" },
  { type: "textBox", missing: "producer" },
];

// ---------------------------------------------------------------- the schema's universe
const schema = JSON.parse(readFileSync(join(REPO, "packages/ir/schema/ir.v0.schema.json"), "utf8"));
const declared = (() => {
  const out = new Set();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o.properties?.type?.const) out.add(o.properties.type.const);
    for (const k of Object.keys(o)) walk(o[k]);
  })(schema);
  return [...out].sort();
})();

// ---------------------------------------------------------------- sources
const sourcesUnder = (dirs) => {
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".ts") && !name.name.endsWith(".d.ts")) files.push(full);
    }
  };
  for (const d of dirs) walk(d);
  return files;
};

const pkgDirs = (glob) =>
  readdirSync(join(REPO, "packages"))
    .filter((n) => glob.test(n))
    .map((n) => join(REPO, "packages", n, "src"));

const adapterSrc = sourcesUnder([...pkgDirs(/^adapters-/), join(REPO, "packages/infer/src")]);
const rendererSrc = sourcesUnder(pkgDirs(/^render-/));

const declaredProducers = new Set();
for (const f of adapterSrc) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/type:\s*"([A-Za-z]+)"/g)) declaredProducers.add(m[1]);
}

const consumers = new Set();
for (const f of rendererSrc) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/case\s+"([A-Za-z]+)"/g)) consumers.add(m[1]);
}

// ---------------------------------------------------------------- observed producers
const observed = new Set();
{
  const { parseMarkdown } = await import(pathToFileURL(join(REPO, "packages/adapters-md/dist/index.js")).href);
  const { parseHtmlDocument: parseHtml } = await import(
    pathToFileURL(join(REPO, "packages/adapters-html/dist/index.js")).href
  );
  const { parseDocx } = await import(pathToFileURL(join(REPO, "packages/adapters-docx/dist/index.js")).href);

  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") observed.add(node.type);
    for (const c of node.children ?? []) collect(c);
  };
  const harvest = (doc) => {
    collect(doc.body);
    for (const f of doc.furniture ?? []) collect(f.content);
  };

  /*
   * Probes: constructs the committed corpus does not contain.
   *
   * Deliberately not fixtures. A fixture is committed, licensed, and measured; these exist
   * only to answer "can the adapter make one of these at all", which is a question about the
   * code rather than about the corpus. Turning them into fixtures would make the gate demand
   * corpus coverage it has no business demanding.
   */
  const MD_PROBES = [
    // YAML front matter, math (block and inline), raw HTML, a link definition, and
    // reference-style link and image — none of which any committed fixture carries.
    "---\ntitle: probe\n---\n\n# H\n\nInline $a+b$ and [ref][r] and ![img][i].\n\n$$\nx = y\n$$\n\n<div>raw</div>\n\nInline <span>raw</span>.\n\n[r]: https://example.invalid\n[i]: https://example.invalid/i.png\n",
    // TOML front matter is a separate extension path from YAML.
    '+++\ntitle = "probe"\n+++\n\n# H\n',
    // GFM footnotes, strikethrough, and a hard break.
    "Text[^a] and ~~struck~~.\nHard break above.\n\n[^a]: The definition.\n",
  ];
  const HTML_PROBES = [
    // figure/figcaption, aside, description list, sub/sup — the HTML adapter maps each to a
    // real IR type per SPEC §3.4, and no committed HTML fixture exercises them all.
    "<figure><img src='a.png' alt='a'><figcaption>Cap</figcaption></figure>" +
      "<aside>Note body</aside><dl><dt>Term</dt><dd>Details</dd></dl>" +
      "<p>H<sub>2</sub>O and x<sup>2</sup></p>",
  ];

  for (const src of MD_PROBES) harvest(parseMarkdown(new TextEncoder().encode(src), { path: "probe.md" }).document);
  for (const src of HTML_PROBES) harvest(parseHtml(src, { path: "probe.html" }).document);

  const dir = (d) => (existsSync(join(REPO, d)) ? readdirSync(join(REPO, d)).map((n) => join(REPO, d, n)) : []);
  for (const f of dir("fixtures/md").filter((p) => p.endsWith(".md"))) {
    harvest(parseMarkdown(new Uint8Array(readFileSync(f)), { path: f }).document);
  }
  for (const f of dir("fixtures/html").filter((p) => p.endsWith(".html"))) {
    harvest(parseHtml(new Uint8Array(readFileSync(f)), { path: f }).document);
  }
  for (const f of [...dir("fixtures/docx"), ...dir("templates")].filter((p) => p.endsWith(".docx"))) {
    harvest(parseDocx(new Uint8Array(readFileSync(f)), { path: f }).document);
  }
}

const producers = new Set([...observed, ...declaredProducers]);

// ---------------------------------------------------------------- 1. vacuity
!JSON_OUT && console.log("\n1. Both sides resolved, so the comparison is not vacuous");
{
  if (declared.length >= 50) ok(`${declared.length} node type(s) declared in ir.v0.schema.json`);
  else fail(`only ${declared.length} node type(s) parsed from the schema — the extractor is broken`);

  if (observed.size >= 15) ok(`${observed.size} type(s) observed by parsing the corpus`);
  else fail(`only ${observed.size} type(s) observed — the corpus walk is broken, and every type would read as unproduced`);

  if (consumers.size >= 15) ok(`${consumers.size} type(s) have a renderer case`);
  else fail(`only ${consumers.size} type(s) found in renderer dispatch — the scan is broken`);

  if (adapterSrc.length >= 5 && rendererSrc.length >= 3) {
    ok(`${adapterSrc.length} adapter/infer source file(s), ${rendererSrc.length} renderer source file(s) scanned`);
  } else {
    fail(`scanned ${adapterSrc.length} adapter and ${rendererSrc.length} renderer sources — the file walk is broken`);
  }
}

// ---------------------------------------------------------------- 2. exceptions are current
!JSON_OUT && console.log("\n2. Every exception is real and still needed");
const exempt = { producer: new Set(), consumer: new Set() };
for (const e of EXCEPTIONS) {
  if (!declared.includes(e.type)) {
    fail(`EXCEPTIONS names "${e.type}", which the schema does not declare`);
    continue;
  }
  const covered = e.missing === "producer" ? producers.has(e.type) : consumers.has(e.type);
  if (covered) {
    fail(
      `EXCEPTIONS exempts "${e.type}" from having a ${e.missing}, and it now has one. ` +
        `A stale exception is how this list stops shrinking — delete the entry.`,
    );
    continue;
  }
  if (!/because|only|would be|correct handling|by design|never/i.test(e.why)) {
    fail(`EXCEPTIONS's reason for "${e.type}" states no design rationale; "not built yet" belongs in ROADMAP.md`);
    continue;
  }
  exempt[e.missing].add(e.type);
  ok(`"${e.type}" has no ${e.missing} by design`);
}

// ---------------------------------------------------------------- 3. known gaps are current
!JSON_OUT && console.log("\n3. Every known gap is still a gap, and points at the roadmap");
const known = { producer: new Set(), consumer: new Set() };
{
  const roadmap = readFileSync(join(REPO, "docs/ROADMAP.md"), "utf8");
  for (const g of KNOWN_UNCOVERED) {
    if (!declared.includes(g.type)) {
      fail(`KNOWN_UNCOVERED names "${g.type}", which the schema does not declare`);
      continue;
    }
    const covered = g.missing === "producer" ? producers.has(g.type) : consumers.has(g.type);
    if (covered) {
      fail(
        `KNOWN_UNCOVERED lists "${g.type}" as having no ${g.missing}, and it now has one. ` +
          `Remove it — a gap list that keeps closed entries stops measuring anything.`,
      );
      continue;
    }
    if (!roadmap.includes(g.type)) {
      fail(
        `"${g.type}" is a known gap with no entry in docs/ROADMAP.md. A capability removed ` +
          `from the promises and recorded nowhere is lost rather than deferred.`,
      );
      continue;
    }
    known[g.missing].add(g.type);
    ok(`"${g.type}" has no ${g.missing} — known gap, recorded in ROADMAP.md`);
  }
}

// ---------------------------------------------------------------- 4. coverage
!JSON_OUT && console.log("\n4. No new node type has become uncovered");
const noProducer = declared.filter((t) => !producers.has(t) && !exempt.producer.has(t));
const noConsumer = declared.filter((t) => !consumers.has(t) && !exempt.consumer.has(t));
const newNoProducer = noProducer.filter((t) => !known.producer.has(t));
const newNoConsumer = noConsumer.filter((t) => !known.consumer.has(t));

for (const t of newNoProducer) {
  fail(
    `"${t}" is declared in the IR schema and no adapter produces it. The census cannot see ` +
      `this: absent from both sides of a round trip, it scores as agreement.`,
  );
}
for (const t of newNoConsumer) {
  fail(
    `"${t}" is declared in the IR schema and no renderer has a case for it, so it reaches a ` +
      `default branch — which is where silent loss lives.`,
  );
}
if (newNoProducer.length === 0 && newNoConsumer.length === 0) {
  ok(
    `${declared.length - noProducer.length - noConsumer.length} of ${declared.length} type(s) ` +
      `fully covered; ${noProducer.length + noConsumer.length} known gap(s), 0 new`,
  );
}

// ---------------------------------------------------------------- 4. negative control
!JSON_OUT && console.log("\n5. Negative control — the gate must be able to fail");
{
  const PHANTOM = "notARealNodeType";
  if (!producers.has(PHANTOM) && !consumers.has(PHANTOM)) {
    ok("a type with neither a producer nor a consumer would be reported");
  } else {
    fail(`negative control: "${PHANTOM}" resolved, so the coverage test is void`);
  }

  // The smallest violation, measured as a delta rather than against zero: one extra
  // uncovered type must move the count by exactly one. Asserting `length === 1` would only
  // hold on an already-clean tree, which is the defect two Phase 6 controls had.
  // Filtered by `known` as well, so the control measures the same set section 4 measures.
  // Without that filter it compared against `noProducer` and passed by coincidence — the
  // four known gaps happened to make both sides agree. A control that is right by accident
  // is the third one this phase has produced, which is the argument for re-deriving the
  // baseline from the thing under test rather than from a nearby variable.
  const withPhantom = [...declared, PHANTOM]
    .filter((t) => !producers.has(t) && !exempt.producer.has(t))
    .filter((t) => !known.producer.has(t));
  if (withPhantom.length === newNoProducer.length + 1 && withPhantom.includes(PHANTOM)) {
    ok("one extra unproduced type is detected");
  } else {
    fail(`negative control: an unproduced type was not detected (got ${JSON.stringify(withPhantom)})`);
  }

  // And the positive half: a type everyone agrees is covered must not be reported, or the
  // gate fails everything and stops being read.
  if (producers.has("paragraph") && consumers.has("paragraph")) ok('"paragraph" resolves on both sides');
  else fail('negative control: "paragraph" did not resolve, so the scan is not finding real coverage');
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, declared, noProducer, noConsumer }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? // Not "all 53 are produced and consumed" — four are not, and a green run saying
        // otherwise would be this repository's own defect restated in its newest gate.
        `\n${declared.length - noProducer.length - noConsumer.length} of ${declared.length} ` +
        `node types are produced and consumed; ${noProducer.length + noConsumer.length} known ` +
        `gap(s) in docs/ROADMAP.md, 0 new.`
      : `\n${failures.length} node-type coverage failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
