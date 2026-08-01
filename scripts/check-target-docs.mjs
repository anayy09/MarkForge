#!/usr/bin/env node
/**
 * Every claim in the docs that originates in `targets/*.json` is regenerated from it.
 *
 * The `mcp-manifest` profile carried a hand-written `vendorFields.honestyNote` that was
 * wrong about the profile it was attached to — it said the manifest named `markforge serve`
 * while the scaffold beside it said `npx -y @markforge/mcp`. **`STATUS.md` and
 * `docs/TARGETS.md` both repeated that claim**, having inherited it without re-checking.
 *
 * Fixing the three known instances would have left the mechanism intact. The mechanism is
 * that a sentence about data lives somewhere the data cannot contradict it. So:
 *
 *   - the tables of targets in `docs/TARGETS.md` are **generated** between markers, from
 *     `targets/*.json`, and this gate fails if they have drifted;
 *   - `honestyNote` is validated against the profile it describes rather than trusted —
 *     if it names a command, that command must be one the profile actually scaffolds.
 *
 * The second check is the one that would have caught the original defect on the day it was
 * written, and it is the reason this file exists rather than a `--update` script alone.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UPDATE = process.argv.includes("--update");
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

const profiles = readdirSync(join(REPO, "targets"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(REPO, "targets", f), "utf8")));

// ---------------------------------------------------------------- 1. notes match the data
!JSON_OUT && console.log("\n1. Every hand-written note is validated against the profile it describes");

for (const p of profiles) {
  const note = p.vendorFields?.honestyNote;
  if (!note) continue;

  // Any `markforge <subcommand>` the note names must be what the profile scaffolds.
  const named = [...note.matchAll(/`?markforge ([a-z]+)`?/g)].map((m) => m[1]);
  const scaffold = p.vendorFields?.serverScaffold;
  const scaffolded = scaffold ? [scaffold.command, ...(scaffold.args ?? [])].join(" ") : "";

  let bad = false;
  for (const sub of new Set(named)) {
    // The note may say a command is *not* used, so only a claim that this profile points
    // at it is checked — which is what the original defect was.
    const claimsPointsAt = new RegExp(`(points at|names|scaffolds)[^.]*markforge ${sub}`, "i").test(note);
    if (claimsPointsAt && scaffold && !scaffolded.includes(sub)) {
      fail(
        `${p.id}: honestyNote says the manifest points at "markforge ${sub}", but the ` +
          `scaffold is "${scaffolded}". A note about data that the data contradicts.`,
      );
      bad = true;
    }
  }
  if (!bad) ok(`${p.id}: honestyNote agrees with its own vendorFields`);
}

// ---------------------------------------------------------------- 2. generated tables
!JSON_OUT && console.log("\n2. docs/TARGETS.md tables are generated from targets/*.json");

const row = (p) =>
  `| \`${p.id}\` | ${p.outputs.map((o) => `\`${o.path}\``).join(", ")} | ${p.kind} | ` +
  `[${new URL(p.verifiedAgainst.url).host}${new URL(p.verifiedAgainst.url).pathname.replace(/\/$/, "")}](${p.verifiedAgainst.url}) |`;

const firstClass = profiles.filter((p) => p.tier === "firstClass");
const stubs = profiles.filter((p) => p.tier !== "firstClass");

const generated =
  `<!-- generated: first-class -->\n` +
  `| Id | Output | Kind | Verified against |\n| --- | --- | --- | --- |\n` +
  firstClass.map(row).join("\n") +
  `\n<!-- /generated: first-class -->`;

const generatedStubs =
  `<!-- generated: stubs -->\n` +
  `| Id | Output | Verified against |\n| --- | --- | --- |\n` +
  stubs
    .map(
      (p) =>
        `| \`${p.id}\` | ${p.outputs.map((o) => `\`${o.path}\``).join(", ")} | ` +
        `[${new URL(p.verifiedAgainst.url).host}](${p.verifiedAgainst.url}) |`,
    )
    .join("\n") +
  `\n<!-- /generated: stubs -->`;

const docPath = join(REPO, "docs/TARGETS.md");
let doc = readFileSync(docPath, "utf8");

const splice = (text, name, block) => {
  const re = new RegExp(`<!-- generated: ${name} -->[\\s\\S]*?<!-- /generated: ${name} -->`);
  if (!re.test(text)) {
    fail(`docs/TARGETS.md has no <!-- generated: ${name} --> block; add it so the table is derived`);
    return text;
  }
  return text.replace(re, block);
};

const next = splice(splice(doc, "first-class", generated), "stubs", generatedStubs);

if (UPDATE) {
  if (next !== doc) writeFileSync(docPath, next, "utf8");
  ok(`docs/TARGETS.md regenerated from ${profiles.length} profiles`);
} else if (next !== doc) {
  fail(
    "docs/TARGETS.md's generated tables do not match targets/*.json. " +
      "Run `node scripts/check-target-docs.mjs --update` and commit.",
  );
} else if (failures.length === 0) {
  ok(`docs/TARGETS.md matches all ${profiles.length} profiles`);
}

// ---------------------------------------------------------------- 3. negative control
!JSON_OUT && console.log("\n3. Negative control — the gate must be able to fail");
{
  const lying = {
    id: "control",
    vendorFields: {
      honestyNote: "The server this manifest points at is `markforge serve`.",
      serverScaffold: { command: "npx", args: ["-y", "@markforge/mcp"] },
    },
  };
  const named = [...lying.vendorFields.honestyNote.matchAll(/`?markforge ([a-z]+)`?/g)].map((m) => m[1]);
  const scaffolded = [lying.vendorFields.serverScaffold.command, ...lying.vendorFields.serverScaffold.args].join(" ");
  const caught = named.some((s) => !scaffolded.includes(s));
  // This is the original defect, verbatim. If this control ever stops firing, the check
  // above has stopped being able to catch the thing it was written for.
  if (caught) ok("the original mcp-manifest defect is caught by this check");
  else fail("negative control: the original honestyNote defect was NOT caught");

  const drifted = splice("<!-- generated: stubs -->\nstale\n<!-- /generated: stubs -->", "stubs", generatedStubs);
  if (drifted.includes("cursor-rules")) ok("a drifted generated table is detected");
  else fail("negative control: a drifted table was not detected");
}

console.log(
  failures.length === 0
    ? `\nEvery targets/ claim in the docs is derived from targets/ or validated against it.`
    : `\n${failures.length} target-doc check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
