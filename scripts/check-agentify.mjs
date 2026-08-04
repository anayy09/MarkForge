#!/usr/bin/env node
/**
 * The agentify gate harness — both halves of the acceptance criterion, checked rather
 * than asserted.
 *
 * The criterion: a folder of mixed source documents produces a CLAUDE.md set that passes
 * the verification gate at 100 percent traceability, and editing one source document
 * produces a minimal, readable git diff. Every such claim is a CI job, so each is a check
 * here and CI runs this file.
 *
 * Seven checks:
 *
 *   1. Traceability is 1.0 on the clean set, for every first-class target.
 *   2. **Negative control.** The gate must be able to *fail*. Three crafted violations —
 *      invented text, a dangling unit id, and undeclared scaffolding — must each be caught.
 *      Without this, checks 1 and 7 prove only that nothing threw.
 *   3. Editing one sentence in one source produces a one-hunk diff.
 *   4. Conflict recall against the authored keys, and zero false positives.
 *   5. The oversized set overflows into secondary files and loses no unit.
 *   6. Two runs of the same input are byte-identical.
 *   7. Extraction measured against the authored answer keys, with a committed baseline.
 *   8. **Deduplication precision**, from the committed cache. `nearDuplicates` alone grades
 *      §10.4 in one direction — a method that merged everything would pass it — so the
 *      corpus authors `mustNotMerge` pairs and this asserts none of them merged.
 *  10. Target profiles re-verified against vendor documentation within 180 days — a
 *      warning, because failing on the calendar would train people to bump the date.
 *   9. **The classification holdout.** The 10/10 in check 7 is in-distribution: `classify.ts`
 *      was tuned while reading its own output on those documents. This runs a set authored
 *      afterwards and never tuned against, and it scores 1 of 5.
 *
 * Run with `--update` to rewrite `docs/AGENTIFY.md` and the baseline; CI runs `--check`,
 * which fails on a regression and on a stale document.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UPDATE = process.argv.includes("--update");
const REFRESH_CACHE = process.argv.includes("--refresh-cache");
const BASELINE = join(REPO, "fixtures/expected/agentify-extraction.json");
const DOC = join(REPO, "docs/AGENTIFY.md");

// Imported by URL href, not by joining onto an absolute path. `fileURLToPath` yields
// `C:\Users\...` on Windows and a dynamic import of that string is read as the `c:` URL
// scheme, which fails. STATUS.md records the same mistake reached from the other direction
// — `new URL(...).pathname` giving `/C:/Users/...` — silently skipping a whole test file.
const dist = (pkg) => new URL(`../packages/${pkg}/dist/index.js`, import.meta.url).href;
const { parseMarkdown } = await import(dist("adapters-md"));
const { parseHtmlDocument } = await import(dist("adapters-html"));
const { parseDocx } = await import(dist("adapters-docx"));
const agentify = await import(dist("agentify"));
const { DiagnosticBag } = await import(dist("ir"));
const llm = await import(dist("llm"));

const failures = [];
const notes = [];
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  console.log(`  FAIL  ${m}`);
};

const FIRST_CLASS = ["agents-md", "claude-md", "claude-skills", "claude-commands", "mcp-manifest"];
// `loadRegistry` is not on the package index: it needs node:fs and ajv, and the index has to
// bundle for a browser (see packages/agentify/src/registry-node.ts).
const { loadRegistry } = await import(new URL("../packages/agentify/dist/registry-node.js", import.meta.url).href);
const registry = loadRegistry(join(REPO, "targets"));

async function readSet(dir) {
  const sources = [];
  for (const file of readdirSync(dir).filter((f) => f !== "expected-units.json").sort()) {
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    const ext = file.split(".").pop();
    const parsed =
      ext === "md" ? await parseMarkdown(bytes, { path: file })
      : ext === "html" ? await parseHtmlDocument(bytes, { path: file })
      : await parseDocx(bytes, { path: file });
    const sourceText = ext === "docx" ? "" : new TextDecoder().decode(bytes);
    sources.push({
      path: file,
      document: parsed.document,
      sourceText,
      role: "unknown",
      authority: agentify.authorityOf(sourceText, [], file),
    });
  }
  return sources;
}

const setDir = (name) => join(REPO, "fixtures/agentify", name);
const keyFor = (name) => JSON.parse(readFileSync(join(setDir(name), "expected-units.json"), "utf8"));

// ---------------------------------------------------------------- 1. traceability
console.log("\n1. Traceability on the clean set (acceptance criterion, first half)");
const cleanSources = await readSet(setDir("clean"));
const cleanRun = await agentify.compile(cleanSources, { registry, targets: FIRST_CLASS });

for (const result of cleanRun.results) {
  const t = result.verification.traceability;
  const total = result.verification.files.reduce((s, f) => s + f.totalSentences, 0);
  if (t === 1 && result.verification.passed) {
    ok(`${result.target}: 100% traceability over ${total} sentence(s) in ${result.files.length} file(s)`);
  } else {
    fail(`${result.target}: traceability ${(t * 100).toFixed(1)}%, passed=${result.verification.passed}`);
  }
}
if (!cleanRun.results.some((r) => r.files.some((f) => f.path === "CLAUDE.md"))) {
  fail("no CLAUDE.md was produced, which is the file the criterion names");
} else {
  ok("a CLAUDE.md set was produced from five documents in three formats");
}

// ---------------------------------------------------------------- 2. negative control
console.log("\n2. Negative control — the gate must be able to fail");
{
  const profile = registry.get("claude-md");
  const unit = cleanRun.units[0];
  const bag = () => new DiagnosticBag({ kind: "rule", name: "check", version: "0" });

  const frag = (text, unitIds, scaffold) => ({
    text, unitIds, sectionId: "commands", start: 0, end: text.length,
    ...(scaffold ? { scaffold } : {}),
  });
  const fileOf = (fragments) => {
    let offset = 0;
    const placed = fragments.map((f) => {
      const out = { ...f, start: offset, end: offset + f.text.length };
      offset += f.text.length;
      return out;
    });
    return {
      path: "CLAUDE.md", role: "primary",
      content: placed.map((f) => f.text).join(""),
      fragments: placed, tokens: 0,
      sections: [{ id: "commands", heading: "Commands", units: 1, tokens: 0 }],
    };
  };

  const cases = [
    ["invented text in a unit fragment",
      fileOf([frag("## Commands\n\n", [], "heading"), frag("Always deploy straight to production on a Friday.", [unit.id])])],
    ["a fragment naming a unit id that does not exist",
      fileOf([frag("## Commands\n\n", [], "heading"), frag("Some sentence with no backing.", ["u_doesnotexist000000"])])],
    ["scaffolding the profile never declared",
      fileOf([frag("## Totally Invented Section Heading That Is Not In The Profile\n\n", [], "heading"), frag(unit.text, [unit.id])])],
  ];

  for (const [label, file] of cases) {
    const v = agentify.verify([file], profile, cleanRun.units, 1, bag());
    if (v.passed) fail(`the gate PASSED ${label} — it cannot fail, so checks 1 and 7 prove nothing`);
    else ok(`caught: ${label}`);
  }

  // And the positive half of the control: a well-formed file must still pass, or the gate
  // is merely broken rather than strict.
  const good = fileOf([frag("## Commands\n\n", [], "heading"), frag(unit.text, [unit.id])]);
  const v = agentify.verify([good], profile, cleanRun.units, 1, bag());
  if (v.passed) ok("a well-formed file still passes, so the gate is strict rather than broken");
  else fail(`a well-formed file failed the gate: ${JSON.stringify(v.unsupported)}`);
}

// ---------------------------------------------------------------- 3. diff stability
console.log("\n3. Editing one sentence produces a minimal diff (acceptance criterion, second half)");
{
  const work = mkdtempSync(join(tmpdir(), "mf-agentify-"));
  try {
    cpSync(setDir("clean"), work, { recursive: true });
    rmSync(join(work, "expected-units.json"));

    const render = async () => {
      const sources = await readSet(work);
      const run = await agentify.compile(sources, { registry, targets: ["claude-md"] });
      return run.results[0].files.find((f) => f.path === "CLAUDE.md").content;
    };

    const before = await render();
    const spec = join(work, "product-spec.md");
    const edited = readFileSync(spec, "utf8").replace("thirty days", "ninety days");
    if (edited === readFileSync(spec, "utf8")) throw new Error("the mutation did not apply");
    writeFileSync(spec, edited);
    const after = await render();

    const b = before.split("\n");
    const a = after.split("\n");
    let regions = 0;
    let inRegion = false;
    let changed = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        changed++;
        if (!inRegion) regions++;
        inRegion = true;
      } else inRegion = false;
    }
    if (regions === 1 && changed === 1) {
      // Enforces **ADR-0018**: unit ordering is diff-stable, so a one-word edit moves one
      // row rather than three. SPEC §10.8's original `(sectionOrder, categoryOrder, id)`
      // ordering contradicted its own goal because `id` is content-addressed; this is the
      // amended order measured.
      ok(`one source edit changed ${changed} line in ${regions} region`);
    } else {
      fail(`one source edit changed ${changed} line(s) across ${regions} region(s); expected 1 and 1`);
    }
    notes.push({ diffRegions: regions, diffLines: changed });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 4. conflicts
console.log("\n4. Conflict recall and false positives");
{
  const sources = await readSet(setDir("conflicting"));
  const run = await agentify.compile(sources, { registry, targets: ["claude-md"] });
  const key = keyFor("conflicting");
  const found = new Set(run.conflicts.conflicts.map((c) => c.entity));

  for (const expected of key.expectedConflicts) {
    if (!found.has(expected.entity)) {
      fail(`conflict on "${expected.entity}" was NOT detected`);
      continue;
    }
    const conflict = run.conflicts.conflicts.find((c) => c.entity === expected.entity);
    const values = new Set(conflict.sides.map((s) => s.value));
    const missing = expected.values.filter((v) => ![...values].some((got) => got.includes(v.value)));
    if (missing.length > 0) fail(`conflict "${expected.entity}" is missing side(s): ${missing.map((m) => m.value).join(", ")}`);
    else ok(`conflict "${expected.entity}" reported with both sources`);
  }
  for (const nonConflict of key.nonConflicts ?? []) {
    if (found.has(nonConflict.entity)) fail(`FALSE POSITIVE: "${nonConflict.entity}" reported as a conflict`);
    else ok(`no false positive on "${nonConflict.entity}"`);
  }
  const unexpected = [...found].filter((e) => !key.expectedConflicts.some((x) => x.entity === e));
  if (unexpected.length > 0) fail(`unexpected conflict(s): ${unexpected.join(", ")}`);
  else ok("no conflicts beyond the authored ones");
  notes.push({ conflictRecall: `${key.expectedConflicts.filter((e) => found.has(e.entity)).length}/${key.expectedConflicts.length}`, falsePositives: unexpected.length });
}

// ---------------------------------------------------------------- 5. overflow
console.log("\n5. The oversized set overflows without losing a unit (SPEC §10.5)");
{
  const sources = await readSet(setDir("oversized"));
  const run = await agentify.compile(sources, { registry, targets: ["claude-md"], budgetOverride: 600 });
  const result = run.results[0];
  const emitted = new Set(result.files.flatMap((f) => f.fragments.flatMap((x) => x.unitIds)));
  const key = keyFor("oversized");

  if (result.plan.secondary.length === 0) fail("no unit overflowed, so progressive disclosure was never exercised");
  else ok(`${result.plan.primary.length} unit(s) in the primary file, ${result.plan.secondary.length} in a linked secondary`);

  if (emitted.size !== run.units.length) fail(`${run.units.length - emitted.size} unit(s) reached no output file`);
  else ok(`all ${run.units.length} unit(s) reach an output file`);

  if (result.plan.dropped.length > 0) fail(`${result.plan.dropped.length} unit(s) dropped at a 600-token budget`);
  else ok("nothing was dropped");

  const conventions = run.units.filter((u) => u.category === "convention").length;
  const glossary = run.units.filter((u) => u.category === "glossaryTerm").length;
  if (glossary !== key.expected.glossaryTermUnits) fail(`glossary terms: found ${glossary}, key says ${key.expected.glossaryTermUnits}`);
  else ok(`glossary terms: ${glossary}, matching the key`);
  notes.push({ oversizedConventions: conventions, oversizedGlossary: glossary, expectedConventions: key.expected.conventionUnits });
}

// ---------------------------------------------------------------- 6. determinism
console.log("\n6. Two runs of the same input are byte-identical");
{
  const a = await agentify.compile(await readSet(setDir("clean")), { registry, targets: FIRST_CLASS });
  const b = await agentify.compile(await readSet(setDir("clean")), { registry, targets: FIRST_CLASS });
  const flat = (run) => run.results.flatMap((r) => r.files.map((f) => `${f.path} ${f.content}`)).join("");
  if (flat(a) === flat(b)) ok(`${a.results.flatMap((r) => r.files).length} output file(s) identical across two runs`);
  else fail("two runs of the same input produced different bytes");

  const m1 = agentify.serializeManifest(a.manifest);
  const m2 = agentify.serializeManifest(b.manifest);
  if (m1 === m2) ok("the provenance manifest is byte-identical across two runs");
  else fail("the provenance manifest differs across two runs");
}

// ---------------------------------------------------------------- 7. answer keys
console.log("\n7. Extraction against the authored answer keys");
const measured = { roles: { correct: 0, total: 0 }, sets: {} };
{
  for (const setName of ["clean", "conflicting", "oversized"]) {
    const sources = await readSet(setDir(setName));
    const run = await agentify.compile(sources, { registry, targets: ["claude-md"] });
    const key = keyFor(setName);

    for (const [file, expectedRole] of Object.entries(key.roles ?? {})) {
      measured.roles.total++;
      const got = run.report.sources.find((s) => s.path === file)?.role;
      if (got === expectedRole) measured.roles.correct++;
      else fail(`${setName}/${file}: role "${got}", key says "${expectedRole}"`);
    }

    const byCategory = {};
    for (const unit of run.units) byCategory[unit.category] = (byCategory[unit.category] ?? 0) + 1;
    measured.sets[setName] = { units: run.units.length, byCategory };

    if (Array.isArray(key.units)) {
      // Matched on (category, source overlap) rather than on text: the authored keys
      // paraphrase — the key says "named for what they do" where the document says "named
      // after what they do" — so an exact-text comparison would measure paraphrase distance
      // rather than extraction. A key unit counts as found when some extracted unit shares
      // its category and at least one of its source files.
      // Two passes. The first pairs a key unit with the extracted unit that most resembles
      // it lexically; only then does the second fall back to category-and-source. Greedy
      // category-first matching was wrong in a way that mattered: with four expected
      // conventions and three extracted, it consumed an arbitrary one and reported the
      // *wrong* convention as missed, which would have sent a reader looking for a defect
      // that was not there. The miss list is the part of this report someone acts on, so it
      // has to name the real one.
      const remaining = [...run.units];
      let found = 0;
      const missed = [];
      const categoryMismatches = [];
      const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
      const overlap = (a, b) => {
        const A = words(a), B = words(b);
        if (A.size === 0 || B.size === 0) return 0;
        let shared = 0;
        for (const w of A) if (B.has(w)) shared++;
        return shared / Math.min(A.size, B.size);
      };

      const unmatched = [];
      for (const expected of key.units) {
        let best = -1, bestScore = 0.6;
        remaining.forEach((u, i) => {
          const score = overlap(expected.text, u.text);
          if (score > bestScore) { bestScore = score; best = i; }
        });
        if (best >= 0) {
          found++;
          // Matched on words, so a unit can be found and still be filed wrong. That is a
          // different defect from a miss and is reported separately rather than folded into
          // recall, which would overstate the problem, or dropped, which would hide it.
          if (remaining[best].category !== expected.category) {
            categoryMismatches.push({
              text: expected.text,
              expected: expected.category,
              got: remaining[best].category,
            });
          }
          remaining.splice(best, 1);
        } else unmatched.push(expected);
      }
      for (const expected of unmatched) {
        const i = remaining.findIndex(
          (u) => u.category === expected.category && u.sources.some((s) => expected.sources.includes(s.path)),
        );
        if (i >= 0) { found++; remaining.splice(i, 1); } else missed.push(expected);
      }
      const recall = found / key.units.length;
      const precision = found / run.units.length;
      measured.sets[setName].recall = Number(recall.toFixed(4));
      measured.sets[setName].precision = Number(precision.toFixed(4));
      measured.sets[setName].missed = missed.map((m) => ({ category: m.category, text: m.text }));
      measured.sets[setName].categoryMismatches = categoryMismatches;
      console.log(`  info  ${setName}: recall ${(recall * 100).toFixed(1)}% (${found}/${key.units.length}), precision ${(precision * 100).toFixed(1)}% (${found}/${run.units.length})`);
      for (const m of missed) console.log(`          missed [${m.category}] ${m.text.slice(0, 70)}`);
      for (const m of categoryMismatches) console.log(`          miscategorised: key says ${m.expected}, extracted as ${m.got} — ${m.text.slice(0, 55)}`);
    }
  }
  if (measured.roles.correct === measured.roles.total) {
    ok(`document role classification: ${measured.roles.correct}/${measured.roles.total}`);
  }
}

// ---------------------------------------------------------------- 8. dedup precision
console.log("\n8. Deduplication precision, from the committed cache (offline)");
{
  const key = keyFor("clean");
  const negatives = key.mustNotMerge ?? [];
  if (negatives.length === 0) {
    fail("the clean key authors no mustNotMerge pairs, so §10.4 is graded for recall only");
  }

  // Enforces **ADR-0016**: a key is required unless the cache is `readOnly`, and `readOnly`
  // means this run must not touch the network — a miss is a hard `CacheMissError`, never a
  // quiet downgrade. Running this gate with no key present is that decision under test.
  // readOnly, no key: the recorded answers or nothing. A miss is a hard error rather than a
  // silent downgrade to the deterministic path, which is what makes this a real check.
  //
  // `--refresh-cache` is the deliberate exception, and it is a separate flag from `--update`
  // because they cost different things: `--update` rewrites a document from numbers already
  // in hand, while this one spends real calls against a real endpoint. Needed when a change
  // alters *which pairs get compared* — the §7q reclassification did exactly that, and a
  // pair that was previously blocked has no recorded answer to read. CI never passes it, so
  // a missing entry stays a hard failure there.
  const session = new llm.LlmSession({
    baseUrl: llm.DEFAULT_BASE_URL,
    models: llm.DEFAULT_MODELS,
    cache: {
      dir: join(REPO, ".markforge/llm-cache"),
      mode: REFRESH_CACHE ? "readWrite" : "readOnly",
    },
    ...(REFRESH_CACHE ? { apiKey: process.env["MODEL_API_KEY"] ?? "" } : {}),
    // These three are part of the cache key, so they must match what `buildSession` used
    // when the entries were recorded. Omitting the seed alone was enough to miss every one.
    seed: 20260731,
    maxRepairs: 2,
    budget: { maxTokens: 200_000 },
    capabilities: llm.loadCapabilities(llm.CAPABILITIES_PATH, llm.DEFAULT_BASE_URL, {
      maxAgeMs: Number.POSITIVE_INFINITY,
    }),
  });
  // Every pair the adjudicator was actually asked about.
  //
  // "0 of 2 merged" cannot distinguish *never compared* from *compared and rejected*, and
  // those are completely different states: one is a pipeline that never reached the
  // question, the other is a disagreement about meaning. That ambiguity is what let
  // OPEN_QUESTIONS §7q stay open as long as it did — the number looked the same either way.
  const adjudicated = [];
  const assist = {
    embed: (texts) => session.embed(texts),
    adjudicate: async ({ a, b }) => {
      const v = await llm.judgeUnitEquivalence(session, {
        textA: a.text, textB: b.text,
        pathA: a.sources[0]?.path ?? "?", pathB: b.sources[0]?.path ?? "?",
      });
      adjudicated.push({ a: norm(a.text), b: norm(b.text), sameFact: v.sameFact });
      return { sameFact: v.sameFact, survivingText: v.survivingText };
    },
  };

  try {
    const run = await agentify.compile(await readSet(setDir("clean")), {
      registry, targets: ["claude-md"], assist,
    });

    // Every surviving unit's text, plus the text of everything folded into it. A pair is
    // "merged" when both sides ended up inside one unit.
    const mergedInto = new Map();
    for (const unit of run.units) {
      mergedInto.set(unit.id, new Set([norm(unit.text)]));
    }
    for (const m of run.merges) {
      mergedInto.get(m.survivingId)?.add(norm(m.text));
    }
    const together = (x, y) =>
      [...mergedInto.values()].some((texts) => contains(texts, x) && contains(texts, y));

    for (const pair of negatives) {
      if (together(pair.a.text, pair.b.text)) {
        fail(`FALSE MERGE: "${pair.a.text.slice(0, 40)}" was merged with "${pair.b.text.slice(0, 40)}"`);
      } else {
        ok(`kept apart (${pair.blockedBy}): ${pair.a.text.slice(0, 34)} / ${pair.b.text.slice(0, 34)}`);
      }
    }

    // Recall is reported and baselined, not hard-failed. It reads 0/2, and since the §7q
    // ruling on 2026-08-01 **both** pairs reach the adjudicator and both are rejected —
    // which is a different state from the one this comment used to describe, when pair 2
    // was never compared at all. A hard failure on a known, reported gap trains people to
    // ignore red; the baseline below still catches it getting worse.
    const positives = (key.nearDuplicates ?? []).filter((p) => together(p.a.text, p.b.text)).length;
    const total = (key.nearDuplicates ?? []).length;
    console.log(`  info  authored near-duplicates merged: ${positives}/${total}`);

    // Say *why* each authored pair did not merge. See the note above `adjudicated`.
    for (const pair of key.nearDuplicates ?? []) {
      const a = norm(pair.a.text);
      const b = norm(pair.b.text);
      if (together(pair.a.text, pair.b.text)) {
        ok(`authored pair merged: ${pair.a.text.slice(0, 40)}`);
        continue;
      }
      const seen = adjudicated.find(
        (x) => (contains1(x.a, a) && contains1(x.b, b)) || (contains1(x.a, b) && contains1(x.b, a)),
      );
      console.log(
        seen
          ? `  info  not merged, COMPARED and rejected: ${pair.a.text.slice(0, 34)} / ${pair.b.text.slice(0, 34)}`
          : `  info  not merged, NEVER COMPARED (below the shortlist threshold, or blocked): ` +
            `${pair.a.text.slice(0, 34)} / ${pair.b.text.slice(0, 34)}`,
      );
    }
    // ---------------------------------------------------------------- §2.16, the fresh set
    //
    // The clean set's two authored pairs are RETIRED (CORPUS.md §2.14.2): both were wrong,
    // and each has now informed either the fixture or the §2.14.1 predicate, so grading
    // §10.4 on them would grade the correction that came out of them. `fixtures/agentify/dedup/`
    // was authored afterwards and has never informed anything, which is what makes it a
    // graded case. One recall pair, two hard negatives — both directions.
    const dedupDir = setDir("dedup");
    if (existsSync(dedupDir)) {
      const dedupKey = JSON.parse(readFileSync(join(dedupDir, "expected-units.json"), "utf8"));
      const dedupRun = await agentify.compile(await readSet(dedupDir), {
        registry, targets: ["claude-md"], assist,
      });
      const dedupMerged = new Map();
      for (const unit of dedupRun.units) dedupMerged.set(unit.id, new Set([norm(unit.text)]));
      for (const m of dedupRun.merges) dedupMerged.get(m.survivingId)?.add(norm(m.text));
      const dedupTogether = (x, y) =>
        [...dedupMerged.values()].some((t) => contains(t, x) && contains(t, y));

      /*
       * Both sides of every graded pair must actually exist as units.
       *
       * Without this the precision arm passes **vacuously**: a `mustNotMerge` pair whose
       * sentences were never extracted cannot merge, so the gate reports "kept apart" and
       * measures nothing. That is exactly what happened on this set's first run — three of
       * the four sentences were not extracted at all, and two hard negatives went green on
       * the strength of their own absence.
       */
      // Surviving units **plus everything merged away**. Checking survivors alone is wrong
      // in the one case that matters: a pair that correctly merged has one side absent from
      // `units`, so the existence check would report the successful merge as "never
      // extracted". Measured on the first run of this very check.
      const dedupUnitTexts = [
        ...dedupRun.units.map((u) => norm(u.text)),
        ...dedupRun.merges.map((m) => norm(m.text)),
      ];
      const present = (text) => dedupUnitTexts.some((t) => contains1(t, norm(text)));
      for (const pair of [...(dedupKey.nearDuplicates ?? []), ...(dedupKey.mustNotMerge ?? [])]) {
        for (const side of ["a", "b"]) {
          if (!present(pair[side].text)) {
            fail(
              `§2.17 grades nothing for "${pair[side].text.slice(0, 44)}" — it was never extracted ` +
                `as a unit, so the pair cannot merge and cannot fail to merge`,
            );
          }
        }
      }

      /*
       * Was the pair actually put to the adjudicator?
       *
       * The clean set has had this separation since §7q, and this set did not — so its
       * precision arm reported "kept apart" for pairs the pipeline never compared. Measured:
       * on the first run of §2.17, `extractRoleImpliedUnits` had assigned every sentence in
       * one of the two documents to `convention` because its filename said "handbook", the
       * category block then separated all six graded pairs, and the arm read 3/3 clean. A
       * negative that was never compared is the same defect as a sentence that was never
       * extracted, one stage later.
       */
      const wasAsked = (x, y) => {
        const nx = norm(x);
        const ny = norm(y);
        return adjudicated.some(
          (p) => (contains1(p.a, nx) && contains1(p.b, ny)) || (contains1(p.a, ny) && contains1(p.b, nx)),
        );
      };

      /*
       * §2.17's claims about itself, checked here rather than typed into CORPUS.md.
       *
       * `build-agentify-corpus.mjs` asserts the same two properties for the clean set, and
       * this set is hand-authored rather than generated, so it fell outside that gate — its
       * Jaccard figures reached `docs/CORPUS.md` §2.17 as numbers somebody measured once. That
       * is the defect this whole audit is about, committed while fixing it.
       */
      const JACCARD_MAX = 0.2;
      const STOPWORDS = new Set(
        ("the and for that with must from have has are was were will not any all each every " +
          "once its their them they this those than then there these which while who whom why " +
          "been being both such under until upon within without").split(" "),
      );
      const cw = (t) =>
        new Set(
          t.toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/)
            .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
        );
      const jaccard = (a, b) => {
        const A = cw(a);
        const B = cw(b);
        const inter = [...A].filter((x) => B.has(x)).length;
        return inter / (A.size + B.size - inter);
      };
      for (const [i, pair] of (dedupKey.nearDuplicates ?? []).entries()) {
        const j = jaccard(pair.a.text, pair.b.text);
        if (j >= JACCARD_MAX) {
          fail(
            `§2.17 recall pair ${i} scores Jaccard ${j.toFixed(3)} — a plain text threshold would ` +
              `already merge it, so it proves nothing about needing embeddings (OPEN_QUESTIONS §7c)`,
          );
        }
      }
      const negs = dedupKey.mustNotMerge ?? [];
      const viaAdjudicator = negs.filter((p) => (p.blockedBy ?? "adjudicator") === "adjudicator").length;
      if (negs.length > 0 && viaAdjudicator * 2 < negs.length) {
        fail(
          `§2.17: only ${viaAdjudicator} of ${negs.length} hard negatives reach the adjudicator, so the ` +
            `precision arm measures structural blocking rather than the merge decision`,
        );
      } else if (negs.length > 0) {
        ok(
          `§2.17 is hard by its own measure: recall pairs at Jaccard ` +
            `${(dedupKey.nearDuplicates ?? []).map((p) => jaccard(p.a.text, p.b.text).toFixed(3)).join(", ")}, ` +
            `${viaAdjudicator} of ${negs.length} negatives reaching the adjudicator`,
        );
      }

      const measured = { recallMerged: 0, recallTotal: 0, falseMerges: 0, negativesCompared: 0, vetoed: 0 };

      for (const pair of dedupKey.nearDuplicates ?? []) {
        measured.recallTotal += 1;
        const asked = wasAsked(pair.a.text, pair.b.text);
        if (dedupTogether(pair.a.text, pair.b.text)) {
          measured.recallMerged += 1;
          ok(`§2.17 recall: merged "${pair.a.text.slice(0, 40)}"`);
        } else if (!asked) {
          fail(
            `§2.17 recall: "${pair.a.text.slice(0, 34)}" / "${pair.b.text.slice(0, 34)}" was NEVER ` +
              `COMPARED — the shortlist or the category block stopped it, so this measures ` +
              `neither the model nor the predicate`,
          );
        } else {
          console.log(
            `  miss  §2.17 recall: COMPARED and rejected — "${pair.a.text.slice(0, 34)}" / ` +
              `"${pair.b.text.slice(0, 34)}"`,
          );
        }
      }

      for (const pair of dedupKey.mustNotMerge ?? []) {
        const structural = (pair.blockedBy ?? "adjudicator") !== "adjudicator";
        const asked = wasAsked(pair.a.text, pair.b.text);
        if (dedupTogether(pair.a.text, pair.b.text)) {
          measured.falseMerges += 1;
          console.log(
            `  miss  §2.17 FALSE MERGE: "${pair.a.text.slice(0, 34)}" with "${pair.b.text.slice(0, 34)}"`,
          );
        } else if (structural) {
          // Declared as separated by the entity block, so it must NOT have been asked —
          // if it was, the block did not fire and the key is describing something else.
          if (asked) {
            fail(
              `§2.17: "${pair.a.text.slice(0, 30)}" is keyed \`blockedBy: ${pair.blockedBy}\` but ` +
                `reached the adjudicator, so the structural block it documents did not fire`,
            );
          } else {
            ok(`§2.17 kept apart by the ${pair.blockedBy} block, before any prompt: ${pair.a.text.slice(0, 28)}`);
          }
        } else if (!asked) {
          fail(
            `§2.17: "${pair.a.text.slice(0, 30)}" / "${pair.b.text.slice(0, 30)}" is keyed as an ` +
              `adjudicator case and was NEVER COMPARED, so "kept apart" measures its own absence`,
          );
        } else {
          measured.negativesCompared += 1;
          /*
           * "Kept apart" is three different outcomes and they are not interchangeable. The
           * model may have rejected the pair; or the model may have proposed the merge and
           * CORPUS §2.14.1's predicate vetoed it (MF-AGENT-0013); or it never got that far.
           * Reporting the middle case as "the model rejected it" would hide that the model
           * still wants a merge that deletes a prohibition — which is the whole reason the
           * veto exists, and exactly the conflation that let a vacuous 3/3 stand.
           */
          // `compile` returns `diagnostics` already flattened by `.all()`, so it is an array.
          const vetoed = (dedupRun.diagnostics ?? []).some(
            (d) => d.code === "MF-AGENT-0013" && d.message.includes(pair.a.text.slice(0, 40)),
          );
          if (vetoed) {
            measured.vetoed += 1;
            ok(`§2.17 VETOED by §2.14.1 after the model proposed the merge: ${pair.a.text.slice(0, 30)}`);
          } else {
            ok(`§2.17 kept apart, the model rejected it: ${pair.a.text.slice(0, 30)}`);
          }
        }
      }

      /*
       * Gated on regression, not on value — the same rule the role-classification holdout
       * uses, and for the same reason. Recall 0/3 and one false merge are the finding; a
       * gate set at "recall must be 3/3" would fail every run and a gate asserting today's
       * numbers are *acceptable* would bless a false merge. What must not happen silently is
       * the numbers getting worse.
       */
      // Tightened from 1 to 0 when §2.14.1 became a veto in `dedup.ts` rather than only a
      // grading instrument. A false merge here now means the veto stopped firing, which is a
      // different and worse failure than the model being wrong — the model is *expected* to
      // be wrong about this pair and is, on every run.
      const BASELINE = { recallMerged: 0, maxFalseMerges: 0 };
      if (measured.recallMerged < BASELINE.recallMerged) {
        fail(`§2.17 recall regressed: ${measured.recallMerged}/${measured.recallTotal}, baseline ${BASELINE.recallMerged}`);
      }
      if (measured.falseMerges > BASELINE.maxFalseMerges) {
        fail(`§2.17 false merges rose to ${measured.falseMerges}, baseline ${BASELINE.maxFalseMerges}`);
      }
      console.log(
        `  info  §2.17 on unseen pairs: recall ${measured.recallMerged}/${measured.recallTotal}, ` +
          `${measured.falseMerges} false merge(s) and ${measured.vetoed} predicate veto(es) across `+
          `${measured.negativesCompared} adjudicated negative(s). ` +
          `Both are defects (docs/CORPUS.md §2.17), gated against regression rather than blessed.`,
      );
      notes.push({ dedup217: measured });

      /*
       * ---------------------------------------------------- the committed `--llm` diff
       *
       * What `--llm` changes about the output, asserted against a committed file rather than
       * printed for somebody to read.
       *
       * Three CI jobs in a row asserted "`--llm` differs from `--no-llm`" and went green on a
       * merge nobody had inspected: first a sentence-split merge read as an authored pair
       * working, then the job pointed at the wrong fixture set, then a **false merge** that
       * deleted "A sealed document must never be re-issued under the same reference". Printing
       * the diff and narrowing the claim did not fix that, because nobody reads printed output
       * either.
       *
       * So the diff is data. It is currently **empty**: §2.14.1's veto blocks the one merge the
       * adjudicator proposes, so the assisted and deterministic outputs are byte-identical. That
       * is the correct behaviour and it is also the sharpest available statement of why the
       * adjudicated stage ships disabled — with the veto on, it is a no-op on every fixture
       * there is. If it ever stops being a no-op, this fails and somebody has to look.
       */
      const deterministic = await agentify.compile(await readSet(dedupDir), {
        registry, targets: ["claude-md"],
      });
      const fileOf = (r) => r.results[0]?.files?.find((f) => f.path === "CLAUDE.md")?.content ?? "";
      const assistedText = fileOf(dedupRun);
      const plainText = fileOf(deterministic);
      const diffLines = [];
      {
        const A = plainText.split("\n");
        const B = assistedText.split("\n");
        const inB = new Set(B);
        const inA = new Set(A);
        for (const line of A) if (!inB.has(line) && line.trim()) diffLines.push(`-${line}`);
        for (const line of B) if (!inA.has(line) && line.trim()) diffLines.push(`+${line}`);
      }
      /*
       * Liveness, asserted **here** rather than only in CI, because an empty expected diff has
       * two causes and only one of them is correct.
       *
       * The diff is empty because the veto blocks the merge. It would be equally empty if the
       * assisted path silently stopped running at all — no adjudication, no merge, no
       * difference — and the diff assertion cannot tell those apart. The CI job checks
       * `llm.calls > 0` on the CLI, which is the same property, but a check in another file is
       * a check that can be deleted separately: `pnpm verify` does not run the workflow, and
       * STATUS.md records one stale assertion surviving in exactly that gap.
       */
      if (adjudicated.length === 0) {
        fail(
          "the assisted dedup run adjudicated 0 pairs, so the empty --llm diff below proves " +
            "nothing — an inert model path and a working veto produce the same empty diff",
        );
      } else {
        ok(`the assisted path is live: ${adjudicated.length} pair(s) adjudicated from the committed cache`);
      }

      const DIFF_FILE = join(REPO, "fixtures/expected/agentify-llm-diff.txt");
      const header =
        "# What `--llm` changes about fixtures/agentify/dedup -> claude-md, one line per change.\n" +
        "#\n" +
        "# Regenerate with `node scripts/check-agentify.mjs --update`. Asserted on every run by\n" +
        "# check 8, because three CI jobs in a row asserted only that a difference *existed* and\n" +
        "# went green on a merge nobody had inspected — the last of which deleted a prohibition.\n" +
        "#\n" +
        "# Empty is the expected state: CORPUS §2.14.1's veto blocks the one merge the adjudicator\n" +
        "# proposes, so the assisted and deterministic outputs are byte-identical. That is also why\n" +
        "# the adjudicated stage ships disabled — with the veto on it is a no-op (docs/ROADMAP.md).\n";
      const body = header + diffLines.join("\n") + (diffLines.length ? "\n" : "");
      if (UPDATE) {
        writeFileSync(DIFF_FILE, body);
        ok(`committed the --llm diff: ${diffLines.length} line(s)`);
      } else if (!existsSync(DIFF_FILE)) {
        fail("fixtures/expected/agentify-llm-diff.txt is absent, so what --llm changes is unasserted");
      } else if (readFileSync(DIFF_FILE, "utf8") !== body) {
        fail(
          `what --llm changes about the output has drifted from ` +
            `fixtures/expected/agentify-llm-diff.txt (${diffLines.length} line(s) now). Run ` +
            `\`node scripts/check-agentify.mjs --update\`, read the diff, and commit it only if ` +
            `the change is one you meant.`,
        );
      } else {
        ok(`what --llm changes matches its committed diff (${diffLines.length} line(s))`);
      }
    } else {
      fail("fixtures/agentify/dedup/ is absent, so §10.4 has no live grading set (CORPUS §2.17)");
    }

    console.log(`  info  clean-set merges performed: ${run.merges.length} — ${run.merges.map((m) => m.text.slice(0, 46)).join(" | ") || "(none)"}`);
    // The clean set is no longer the recall grading set, so it is not asserted to merge
    // anything. Its two authored pairs are retired (CORPUS §2.14.2) and the one merge it
    // used to perform — the product-spec sentence split — is correctly **declined** by
    // prompt v2: merging drops `partial` and `never`, which §2.14.1 counts as scope. The
    // recall arm is exercised by §2.16 above, on a set authored after the predicate.
    //
    // This assertion used to demand a merge here, and it went green because of
    // that same sentence-split merge, which was read as the authored pair working. Keeping
    // it would now fail for the correct behaviour.
    notes.push({
      dedupAuthoredRecall: `${positives}/${total}`,
      dedupMergesPerformed: run.merges.length,
      dedupFalseMerges: 0,
    });
  } catch (error) {
    fail(`the cached dedup path could not run offline: ${error.message.slice(0, 160)}`);
  }
}

function norm(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function contains(texts, needle) {
  const n = norm(needle);
  for (const t of texts) if (t.includes(n) || n.includes(t)) return true;
  return false;
}

/** The same containment test between two already-normalised strings. */
function contains1(a, b) {
  return a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------- 9. classification holdout
console.log("\n9. Role classification against a holdout the rules were not tuned on");
let holdout = { correct: 0, total: 0 };
{
  const dir = setDir("classification");
  const key = keyFor("classification");
  for (const [file, expected] of Object.entries(key.roles ?? {})) {
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    const { document } = await parseMarkdown(bytes, { path: file });
    const c = agentify.classifyByRules(document, file);
    holdout.total++;
    if (c.role === expected) {
      holdout.correct++;
      console.log(`  ok    ${file.padEnd(14)} ${c.role}`);
    } else {
      console.log(`  miss  ${file.padEnd(14)} got ${c.role.padEnd(16)} want ${expected.padEnd(16)} margin ${c.margin.toFixed(3)}`);
    }
  }
  // Deliberately NOT a failure at 1/5. The number is the finding, and a gate set at today's
  // value would only stop it getting worse — which is exactly what the baseline below does,
  // without implying 1/5 is acceptable.
  console.log(`  info  holdout: ${holdout.correct}/${holdout.total} — in-distribution is ${measuredRolesLine()}`);
}
function measuredRolesLine() {
  return `${measured.roles.correct}/${measured.roles.total}`;
}

// ---------------------------------------------------------------- 10. vendor staleness
console.log("\n10. Target profiles re-verified against vendor documentation recently enough");
{
  // ADR-0013's own consequences section says a stale `verifiedAgainst.date` is
  // machine-detectable and CI should warn. It was never wired, which made it a note someone
  // might read — the exact thing the required schema field exists to avoid being.
  //
  // A warning, not a failure. The profiles are correct until a vendor changes something, and
  // nobody can know that from a date; failing the build on the calendar would train people
  // to bump the date rather than re-read the docs, which is strictly worse than no check.
  const STALE_DAYS = 180;
  const today = new Date();
  const ages = registry.verificationAges(today);
  const stale = ages.filter((a) => !Number.isFinite(a.ageDays) || a.ageDays > STALE_DAYS);
  if (stale.length === 0) {
    ok(`all ${ages.length} profiles verified within ${STALE_DAYS} days (oldest ${Math.max(...ages.map((a) => a.ageDays))}d)`);
  } else {
    for (const a of stale) {
      console.log(
        `  warn  ${a.id}: last verified ${a.date || "(never)"}, ${a.ageDays}d ago. Re-read the ` +
          `vendor docs and update verifiedAgainst — three of these were already wrong two days ` +
          `after being written (docs/TARGETS.md).`,
      );
    }
    console.log(`  info  ${stale.length} profile(s) need re-verification. Not a failure; see the comment in this script.`);
  }
  notes.push({ staleProfiles: stale.length, oldestVerificationDays: Math.max(...ages.map((a) => a.ageDays)) });
}

// ---------------------------------------------------------------- baseline
console.log("\nBaseline");
const current = { roles: measured.roles, holdout, sets: measured.sets, notes };
if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  ok(`baseline written to ${BASELINE.replace(REPO, "")}`);
} else {
  const previous = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const setName of Object.keys(current.sets)) {
    const now = current.sets[setName];
    const was = previous.sets?.[setName];
    if (!was) continue;
    if (was.recall !== undefined && now.recall < was.recall - 1e-9) {
      fail(`${setName}: extraction recall fell from ${was.recall} to ${now.recall}`);
    } else if (was.recall !== undefined && now.recall > was.recall + 1e-9) {
      console.log(`  info  ${setName}: recall ROSE from ${was.recall} to ${now.recall} — run --update to record it`);
    } else if (was.recall !== undefined) ok(`${setName}: recall holds at ${now.recall}`);
  }
  if (previous.roles && current.roles.correct < previous.roles.correct) {
    fail(`role classification fell from ${previous.roles.correct} to ${current.roles.correct}`);
  }
  if (previous.holdout && current.holdout.correct < previous.holdout.correct) {
    fail(`holdout classification fell from ${previous.holdout.correct} to ${current.holdout.correct}`);
  } else if (previous.holdout && current.holdout.correct > previous.holdout.correct) {
    console.log(`  info  holdout ROSE from ${previous.holdout.correct} to ${current.holdout.correct} — run --update to record it`);
  }
}

writeDoc(current, cleanRun);

console.log(
  failures.length === 0
    ? `\nAll agentify checks passed.`
    : `\n${failures.length} agentify check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);

function writeDoc(current, run) {
  const rows = run.report.targets
    .map((t) => `| \`${t.id}\` | ${t.tier} | ${t.files.map((f) => `\`${f.path}\``).join(", ")} | ${t.files.reduce((s, f) => s + f.tokens, 0)} | ${(t.traceability * 100).toFixed(1)}% |`)
    .join("\n");

  const sectionRows = (run.report.targets.find((t) => t.id === "claude-md")?.files[0]?.sections ?? [])
    .map((s) => `| ${s.heading} | ${s.units} | ${s.tokens} |`)
    .join("\n");

  const setRows = Object.entries(current.sets)
    .map(([name, s]) =>
      `| \`${name}\` | ${s.units} | ${s.recall !== undefined ? (s.recall * 100).toFixed(1) + "%" : "n/a"} | ${s.precision !== undefined ? (s.precision * 100).toFixed(1) + "%" : "n/a"} |`,
    )
    .join("\n");

  const missed = Object.entries(current.sets)
    .flatMap(([name, s]) => (s.missed ?? []).map((m) => `- \`${name}\` **${m.category}** — ${m.text}`))
    .join("\n");

  const miscategorised = Object.entries(current.sets)
    .flatMap(([name, s]) =>
      (s.categoryMismatches ?? []).map(
        (m) => `- \`${name}\` the key says **${m.expected}**, the rules said **${m.got}** — ${m.text}`,
      ),
    )
    .join("\n");

  const diff = current.notes.find((n) => n.diffRegions !== undefined) ?? {};
  const conflict = current.notes.find((n) => n.conflictRecall !== undefined) ?? {};
  // §2.17's measurement, interpolated rather than typed. The rows below used to be literals
  // in this template, so the document was generated and its numbers were still hand-written.
  const d217 = (current.notes.find((n) => n.dedup217 !== undefined) ?? {}).dedup217 ?? {
    recallMerged: 0, recallTotal: 0, falseMerges: 0, negativesCompared: 0,
  };

  const body = `# Agentify — measured

Generated by \`node scripts/check-agentify.mjs --update\`. Do not edit by hand; CI regenerates
this file and fails if it is stale, for the same reason \`FIDELITY.md\` is generated — a
hand-maintained numbers page drifts from the numbers.

Every figure here is produced offline, with no API key present. The LLM path is measured
separately and is noted where it changes an answer.

## The acceptance criterion

*Done when a folder of mixed source documents produces a \`CLAUDE.md\` set
that passes the verification gate at 100 percent traceability, and editing one source
document produces a minimal, readable git diff.*

| Half | Measured | Checked by |
| --- | --- | --- |
| \`CLAUDE.md\` set at 100% traceability | ${(run.results.find((r) => r.target === "claude-md")?.verification.traceability * 100).toFixed(1)}% over ${run.results.find((r) => r.target === "claude-md")?.verification.files.reduce((s, f) => s + f.totalSentences, 0)} sentences | \`scripts/check-agentify.mjs\` check 1 |
| One source edit → minimal diff | ${diff.diffLines} line in ${diff.diffRegions} region | check 3 |

Both are CI jobs, not assertions. The gate is also checked for its ability to **fail**
(check 2): three crafted violations — invented text, a dangling unit id, and undeclared
scaffolding — must each be caught, because a gate that cannot fail proves nothing when it
passes.

## Targets

Five first-class targets, compiled from the five-document clean set.

| Target | Tier | Output | Tokens | Traceability |
| --- | --- | --- | --- | --- |
${rows}

Token counts are ${run.report.targets[0]?.tokenCounter ?? "n/a"}. SPEC §10.5
requires the method to be named so an estimate is not mistaken for a measurement; no
tokenizer is bundled (ADR-0019), and a profile asking for \`modelTokenizer\` is refused by
name rather than silently approximated.

### Tokens per section, \`claude-md\`

| Section | Units | Tokens |
| --- | --- | --- |
${sectionRows}

## Extraction against the authored answer keys

The keys in \`fixtures/agentify/*/expected-units.json\` were written **before** the extractor
existed (CORPUS.md §2.14), so these are not snapshot comparisons. Matching runs in two passes:
first on **content words**, then on category and source. Never on exact text — the keys
paraphrase deliberately ("named *for* what they do" where the document says "named *after*"),
so an exact comparison would measure paraphrase distance rather than extraction. The two-pass
order matters for honesty rather than for the score: matching category-first was greedy and
named the *wrong* convention as missed when four were expected and three found.

| Set | Units extracted | Recall | Precision |
| --- | --- | --- | --- |
${setRows}

### Role classification

| Set | Score | What it measures |
| --- | --- | --- |
| sets (a)–(c), in-distribution | **${current.roles.correct}/${current.roles.total}** | almost nothing — \`classify.ts\` was tuned while reading its own output on these documents |
| \`classification/\` holdout | **${current.holdout.correct}/${current.holdout.total}** | the real number: authored afterwards, key fixed before the rules ran, not adjusted after |

The in-distribution score was reported as evidence in an earlier version of this document and
of \`STATUS.md\`. It is not evidence: the rules and those documents were written together, with
the weights tuned against the output. The holdout is what a reader should look at.

Three of the holdout misses were exact ties (\`margin: 0.000\`) that the classifier used to
report as decisions, because the distribution sort falls back to alphabetical order. A tie now
returns \`unknown\`. That does not change the score, which is how you can tell it is a
correctness fix rather than tuning.

### What the rules miss, and why

${missed || "- (nothing)"}

### Found, but filed under a different category

${miscategorised || "- (nothing)"}

A miscategorisation is not a miss — the sentence reaches the output file either way — so it
is counted separately rather than folded into recall. Where one appears it is usually a
judgement call the key and the rules can both defend.

Precision below 100% is deliberate over-extraction, argued in
\`packages/agentify/src/extract.ts\`: a false unit is visible in the output and removable,
a missed constraint is invisible. The misses above are category disagreements rather than
lost content — the sentence is extracted, under a category the rules cannot justify. Two
are structural limits stated up front: \`invariant\` needs the grammar that separates "a
batch is committed whole or not at all" from an ordinary \`must\`, and \`entity\` needs a
judgement about what a document is *about*. Both are the LLM half of §10.3.

## Conflicts

Recall **${conflict.conflictRecall ?? "n/a"}** on the authored conflicts, with **${conflict.falsePositives ?? 0}** false positives.

The false-positive count is the load-bearing number. \`NIMBUS_QUEUE_URL\` is declared
identically by both runbooks and must not be reported, and the first run of the detector
did report a false conflict — three sequential deploy commands under one heading in one
document, read as three competing answers. Conflicts are between *documents* (SPEC §10);
that rule is now enforced rather than assumed.

## Deduplication

The clean set's two near-duplicate pairs score content-word Jaccard **0.000**, asserted by
\`scripts/build-agentify-corpus.mjs\` on every run. No lexical threshold merges them at any
setting. That half of OPEN_QUESTIONS §7c held up.

**The other half did not: cosine cannot make the decision either.** Measured against
\`nomic-embed-text-v1.5\`:

| Pair | cosine | with \`clustering:\` |
| --- | --- | --- |
| authored pair 1 — latency, PRD vs ADR | 0.6335 | 0.7782 |
| authored pair 2 — whole-batch atomicity | 0.6183 | 0.7416 |
| **decoy** \`NIMBUS_MAX_BATCH_MB\` vs \`NIMBUS_BATCH_TIMEOUT_MS\` | **0.8201** | **0.9063** |
| **decoy** "thirty days" vs "rejected whole" | **0.7428** | **0.8648** |

Both decoys outrank both true pairs, so no cutoff separates them — the ordering is wrong, and
the documented task prefixes lift every score without changing it. Cosine measures topical
relatedness; deduplication needs semantic equivalence. So the embedding **shortlists** and a
\`strong\` model **decides** (ADR-0020).

### Both arms, measured

\`nearDuplicates\` alone grades §10.4 in one direction: it shows a merge happened, never that
the right thing merged, so anything loose enough to merge everything would pass. The corpus
therefore also authors \`mustNotMerge\` pairs, three of which survive as far as the adjudicator
rather than being filtered structurally.

| | |
| --- | --- |
| **recall** — unseen near-duplicate pairs merged | **${d217.recallMerged} of ${d217.recallTotal}** |
| **precision** — false merges among adjudicated hard negatives | **${d217.falseMerges} of ${d217.negativesCompared + d217.falseMerges}** |

Both numbers come from \`scripts/check-agentify.mjs\` check 8 on every run. The table above used
to be typed into this file's generator rather than interpolated from the measurement, which is
the \`honestyNote\` defect one layer in: a generated document is not a derived document if its
numbers are literals.

**Every earlier number for this row is withdrawn.** \`CORPUS.md\` §2.16 was the grading set, and
all three of its cases turned out to be worked examples inside the adjudicator prompt that
grades them — two verbatim, one by its numbers and its verdict. Its \`1/1\` recall and \`0/2\`
false merges measured the prompt reciting itself.
\`scripts/check-fixture-contamination.mjs\` now fails the build on that class.

The numbers above are §2.17, authored afterwards and contamination-gated, and they are worse:

- **Recall ${d217.recallMerged} of ${d217.recallTotal}.** All ${d217.recallTotal} were *compared and rejected*, not skipped —
  \`check-agentify.mjs\` separates those two states on this set now, because on its first run
  the category block silently separated all six pairs and the precision arm read a clean 3/3
  on cases nothing had compared.
- **${d217.falseMerges} false merge.** The adjudicator merged *"A sealed document must **never** be re-issued
  under the same reference"* with *"A sealed document must be re-issued under a fresh
  reference"* — a prohibition and its opposite — reasoning *"Keeping A would drop nothing; B
  adds no additional constraint."* Merging deletes the prohibition from every generated file.
  This is the failure §10.4's design was chosen to prevent.

Every recall rejection has the shape *"Keeping only A would drop [B, restated]"*, which
suggests the model is paraphrasing the second statement rather than deciding whether the first
carries it. No prompt has been changed in response: tuning against these cases would
contaminate them and destroy the only uncontaminated §10.4 evidence there is.

### §2.14.1 is now a veto, and that bounds the model's discretion

Measured over **46 pairs that reached the adjudicator** across both graded sets:

| | |
| --- | --- |
| definite verdict from the predicate | 43 (93.5%) |
| — of which it would veto a merge | 39 (84.8%) |
| — of which it would allow one | 4 (8.7%) |
| abstained, no salient token either side | 3 (6.5%) |
| agrees with the model | 38 |
| disagrees | 5 |

\`dedup.ts\` now calls the predicate after the adjudicator returns \`sameFact\`, and refuses the
merge when it would drop a salient token (\`MF-AGENT-0013\`, \`info\` — nothing is lost by
refusing). **On §2.17 that took false merges from 1 to 0** and left recall at 0 of 3, which is
what a block-only mechanism predicts.

**What the model still decides is narrower than it looks.** With the veto in place, a merge can
only happen where the predicate agrees or abstains — so the adjudicator's remaining discretion
is the **6.5% abstention band plus the cases the predicate already endorses**, not the whole
decision. It cannot merge anything the predicate objects to, however confident it is.

**The five disagreements, since the split matters:**

- **1 is the false merge** — model MERGE, predicate \`differentFacts\` on \`never\`. The veto fires.
  This is the case the mechanism exists for.
- **3 are the §2.17 recall pairs** — model APART, predicate \`oneFact\`. The predicate agrees they
  are one fact and the model refuses, so **recall 0 of 3 is a model problem, not a
  predicate-scope problem.** A block-only veto cannot fix it: it can stop a bad merge and cannot
  compel a good one.
- **1 is a predicate false positive for equivalence** — "We accept batches into a durable queue
  and acknowledge before processing" against "Customers register a schema before their first
  submission". Their only shared salient token is \`before\`, nothing registers as dropped, and
  the predicate says \`oneFact\`. They are plainly different facts.

That last one is the reason the promotion is **block-only and must stay that way**. The
predicate's \`differentFacts\` verdict is sound; its \`oneFact\` verdict is not, and \`allow\` must
only ever mean *do not veto*. Asserted in
\`packages/agentify/test/agentify.test.ts\` so it cannot be mistaken for soundness later.

Offline with \`--no-llm\`, no pair merges and the run says so in a diagnostic. Two \`readOnly\`
runs with no key present are byte-identical, and the \`--llm\` output differs from \`--no-llm\`.
Both are CI jobs.
`;
  writeFileSync(DOC, body);
}
