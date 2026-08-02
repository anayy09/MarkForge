// Builds the CORPUS.md §2.14 agentify source sets: the corpus the agentify gate runs on.
//
//   node scripts/build-agentify-corpus.mjs           write every fixture
//   node scripts/build-agentify-corpus.mjs --check   fail if a committed one drifted
//
// Three sets, per §2.14: a clean set of five documents in five roles, a conflicting set
// where two documents disagree on an environment variable and a build command, and an
// oversized set that forces budget overflow. Each ships an `expected-units.json`.
//
// **The answer keys are authored, not captured.** `expected-units.json` records what a
// correct extractor *should* find, written by hand before the extractor exists. A file
// captured from a run would be a regression snapshot — it would tell you the output
// changed, never that it was wrong, and it would bless whatever the first implementation
// happened to do. The heading work learned this the expensive way: its "ambiguous
// subset" did not exist until it was built to arithmetic, and until then the criterion
// that named it was unmeasurable rather than unmet.
//
// Formats are mixed on purpose — Markdown, HTML, and DOCX — because the criterion says
// "a folder of mixed source documents" and a corpus of one format would not test §10.1's
// claim that ingest is just the adapters.
//
// The DOCX files are rendered from authored Markdown by our own renderer. That is circular
// for *format fidelity* and would be the wrong choice in `fixtures/docx/`, where the whole
// point is catching adapter bugs. Here the fixture is the document's **content and role**,
// which is orthogonal to how faithfully DOCX round-trips, and §2.1–2.15 already cover that.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatorControl } from "./lib/control.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");
const load = (pkg) => import(pathToFileURL(join(REPO, `packages/${pkg}/dist/index.js`)).href);
const { parseMarkdown } = await load("adapters-md");
const { renderDocx } = await load("render-docx");

const OUT = join(REPO, "fixtures/agentify");

// --------------------------------------------------------------------------------
// Set (a): clean. Five documents, five of §10.2's ten roles.
// --------------------------------------------------------------------------------

const CLEAN = {};

CLEAN["product-spec.md"] = `# Nimbus Ingest — Product Specification

## Purpose

Nimbus Ingest accepts customer telemetry batches and normalises them for the reporting
warehouse. It replaces the hand-run import scripts retired last quarter.

## Requirements

- No user should ever wait more than two seconds for a batch to be acknowledged.
- A batch that fails validation must be rejected whole. Partial ingestion is never
  acceptable, because a half-loaded batch is indistinguishable downstream from a complete
  one.
- Every rejected batch must be retrievable for thirty days.
- Operators must be able to replay any accepted batch without contacting engineering.

## Out of scope

Schema inference. Customers declare their schema up front, and guessing it was the single
largest source of incidents in the retired scripts.
`;

CLEAN["architecture.md"] = `# Architecture Decisions

## ADR-1: Queue-backed ingestion

We accept batches into a durable queue and acknowledge before processing.

**Rationale:** the p95 acknowledgement budget for a single submission is 2000 milliseconds,
and synchronous validation against the warehouse cannot meet it under load.

## ADR-2: Whole-batch atomicity

A submission is committed in one transaction or not at all.

**Rationale:** downstream reporting cannot distinguish a truncated load from a complete one,
so any partial write becomes a silent data error rather than a visible failure.

## ADR-3: Declared schemas only

Customers register a schema before their first submission.

**Rationale:** inference was the dominant incident source in the previous system.
`;

CLEAN["api-contract.html"] = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Nimbus Ingest API</title></head>
<body>
<h1>Nimbus Ingest API</h1>
<h2>Endpoints</h2>
<table>
  <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
  <tbody>
    <tr><td>POST</td><td>/v1/batches</td><td>Submit a batch for ingestion</td></tr>
    <tr><td>GET</td><td>/v1/batches/{id}</td><td>Retrieve batch status</td></tr>
    <tr><td>POST</td><td>/v1/batches/{id}/replay</td><td>Replay an accepted batch</td></tr>
    <tr><td>GET</td><td>/v1/rejections</td><td>List rejected batches from the last 30 days</td></tr>
  </tbody>
</table>
<h2>Authentication</h2>
<p>All endpoints require a bearer token in the <code>Authorization</code> header. Tokens are
issued per customer and are never shared between environments.</p>
<h2>Errors</h2>
<p>A rejected batch returns <code>422</code> with a machine-readable reason code. A
<code>409</code> means the batch id has already been accepted and the request is a duplicate.</p>
</body>
</html>
`;

CLEAN["runbook.md"] = `# Nimbus Ingest — Operator Runbook

## Deploy

\`\`\`bash
pnpm install --frozen-lockfile
pnpm build
pnpm deploy --env production
\`\`\`

## Check health

\`\`\`bash
curl -sf https://ingest.internal/healthz
\`\`\`

## Drain the queue before maintenance

\`\`\`bash
nimbusctl queue drain --wait
\`\`\`

## Environment

\`\`\`
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
NIMBUS_BATCH_TIMEOUT_MS=30000
NIMBUS_MAX_BATCH_MB=64
\`\`\`

## If ingestion stalls

Drain the queue, confirm the warehouse is accepting writes, then restart the workers. Do not
delete queued batches: they are the only copy until the warehouse commit succeeds.
`;

CLEAN["conventions.docx.md"] = `# Engineering Conventions

## Naming

Modules are named after what they do, not after the pattern they use. A file called
\`BatchValidatorFactory\` tells a reader nothing that \`validate-batch\` does not.

## Error handling

Never swallow an error to keep a request alive. A request that succeeds while losing data is
worse than one that fails loudly.

## Testing

Every bug fix ships with the test that would have caught it. A fix without one is a claim.

## Dependencies

A new runtime dependency needs a written reason in the pull request. Development
dependencies do not.
`;

// --------------------------------------------------------------------------------
// Set (b): conflicting. §2.14 names the two disagreements exactly.
// --------------------------------------------------------------------------------

const CONFLICTING = {};

CONFLICTING["deploy-guide.md"] = `# Nimbus Deploy Guide

Maintained by the platform team. Last reviewed 2026-06-02.

## Build

\`\`\`bash
pnpm build
\`\`\`

## Environment

\`\`\`
NIMBUS_BATCH_TIMEOUT_MS=30000
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
\`\`\`

The timeout was lowered to 30 seconds after the March incident, when long-running batches
held workers open and starved the queue.
`;

CONFLICTING["ops-runbook.md"] = `# Nimbus Operations Runbook

Maintained by the on-call rotation. Last reviewed 2026-01-14.

## Build

\`\`\`bash
npm run compile
\`\`\`

## Environment

\`\`\`
NIMBUS_BATCH_TIMEOUT_MS=60000
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
\`\`\`

Sixty seconds gives a large customer batch room to finish. Lowering it caused spurious
retries the last time it was tried.
`;

CONFLICTING["service-overview.md"] = `# Nimbus Ingest — Service Overview

Nimbus Ingest normalises customer telemetry for the reporting warehouse. It is owned by the
platform team and operated by the on-call rotation.

The queue is the durable boundary: once a batch is enqueued it survives worker restarts, and
nothing is acknowledged to the customer before it is enqueued.
`;

// --------------------------------------------------------------------------------
// Set (c): oversized. Enough units to overflow a small target budget.
// --------------------------------------------------------------------------------

const RULE_TOPICS = [
  ["Imports", "are sorted by module path, standard library first"],
  ["Exports", "are named; a default export is only for a module with one obvious subject"],
  ["Line length", "is not enforced by a formatter, because reflow destroys diff stability"],
  ["Comments", "explain why, never what; the code already says what"],
  ["Assertions", "carry a message naming the invariant that broke"],
  ["Logging", "is structured; a log line that cannot be queried is a print statement"],
  ["Timeouts", "are explicit on every outbound call, with no library default relied upon"],
  ["Retries", "are bounded and jittered; an unbounded retry is an outage amplifier"],
  ["Feature flags", "are removed within two releases of reaching one hundred percent"],
  ["Migrations", "are forward-only and reversible by a second migration, never by a rollback"],
  ["Secrets", "come from the environment; a secret in a config file is a leaked secret"],
  ["Clocks", "are injected, so a test never waits for real time to pass"],
  ["Randomness", "is seeded in tests, so a failure reproduces from its output alone"],
  ["Fixtures", "are authored, not captured, so they assert intent rather than behaviour"],
  ["Panics", "are for programmer error only; operational failure returns an error value"],
  ["Public types", "are documented at the type, not at each field, unless a field surprises"],
  ["Enums", "are exhaustively matched; a default arm hides the next variant added"],
  ["Nulls", "are absent rather than empty, so a caller cannot confuse the two"],
  ["Booleans", "in a signature become an enum once there are two of them"],
  ["Constructors", "do no I/O; a type that reads a file on construction cannot be tested"],
  ["Interfaces", "are defined by the consumer, not exported hopefully by the producer"],
  ["Generics", "are introduced when the second caller appears, never for the first"],
  ["Caches", "declare an eviction policy at the point they are created"],
  ["Metrics", "are named for what they measure, with the unit in the name"],
  ["Dashboards", "are code, reviewed like code"],
  ["Alerts", "page a human only when a human must act within the hour"],
  ["Runbooks", "are linked from the alert that needs them"],
  ["Postmortems", "name systems and decisions, never people"],
  ["Pull requests", "under four hundred lines; larger ones are not reviewed, they are skimmed"],
  ["Commit messages", "explain the change in the body, not only in the subject"],
];

const OVERSIZED = {};
OVERSIZED["engineering-handbook.md"] =
  "# Engineering Handbook\n\nThe complete conventions set. Too large for a single agent file\n" +
  "by construction: budgeting must push the low-value half into secondary files.\n\n" +
  RULE_TOPICS.map(
    ([topic, rule], i) =>
      `## Rule ${i + 1}: ${topic}\n\n${topic} ${rule}. This rule applies to every service in ` +
      `the platform, and exceptions are recorded in the owning team's decision log rather ` +
      `than negotiated per review.\n`,
  ).join("\n");

OVERSIZED["glossary.md"] =
  "# Domain Glossary\n\n" +
  [
    ["Batch", "one customer submission, validated and committed as a unit"],
    ["Rejection", "a batch that failed validation and was not committed"],
    ["Replay", "re-processing an already-accepted batch without a new submission"],
    ["Drain", "letting the queue empty without accepting new work"],
    ["Warehouse", "the downstream reporting store; the only consumer of committed batches"],
    ["Schema", "the customer-declared shape of a batch, registered before first use"],
    ["Acknowledgement", "the response confirming a batch is durably enqueued"],
    ["Worker", "the process that validates and commits a batch"],
  ]
    .map(([term, def]) => `**${term}** — ${def}.\n`)
    .join("\n");

// --------------------------------------------------------------------------------
// Set (d): classification holdout. Five documents the role rules were NOT written against.
//
// Added because the 10/10 the rules score on sets (a)-(c) measures nothing. `classify.ts`
// and those documents were written in the same sitting, with the signal weights tuned while
// reading the classifier's output on them — in-distribution by construction, with no
// holdout. "The rules already win" was therefore not a finding, and citing it as a reason
// not to wire an LLM classifier was citing an artifact.
//
// These five are authored to be plausibly missed, and the key is fixed BEFORE the rules are
// run against it. Whatever score comes out is the reported result; if it is bad, that is the
// measurement working. Each attacks a different assumption the rules make:
//
//   weekly.md      role only inferable from body structure; filename says nothing
//   overview.md    a PRD written in ADR clothing — the decisionRecord rule's decoy
//   README.md      a filename that suggests everything, a body that is one thing
//   platform.md    architecture with none of the architecture heading vocabulary
//   checks.md      testPolicy, a role sets (a)-(c) never exercise at all
// --------------------------------------------------------------------------------

const CLASSIFICATION = {};

CLASSIFICATION["weekly.md"] = `# 2026-06-18

Present: Priya, Marcus, Dana. Apologies: Sam.

We walked through the ingest backlog. Marcus raised that the replay tooling is still manual
and that two customers have asked about it this month.

Dana will draft a short proposal for automated replay before the next session. Marcus is
following up with the two customers to understand what they actually need. Priya is holding
the queue-depth investigation until the proposal lands.

Next session is the 25th, same time.
`;

CLASSIFICATION["overview.md"] = `# Nimbus Reporting — Overview

## Decision

Nimbus Reporting will present warehouse data to customers through a hosted dashboard rather
than through scheduled email exports.

**Rationale:** customers have asked for self-service access in every quarterly review since
the product launched, and email exports cannot support the filtering they describe.

## Requirements

- A customer must be able to filter any report by date range and by batch status.
- Reports must render within three seconds for a customer with one year of history.
- Every figure shown must be traceable to the batch that produced it.

## Out of scope

Custom report authoring. Customers pick from a fixed set this release.
`;

CLASSIFICATION["README.md"] = `# nimbus-ingest

## Naming

Modules take the name of the thing they do, not the name of the pattern they are built with.

## Errors

An error is either handled where it occurs or allowed to propagate. It is never logged and
swallowed.

## Tests

Every bug fix arrives with the test that would have caught it. A fix without one is a claim.

## Reviews

A pull request that changes behaviour explains why in its description, not only what.

## Dependencies

Adding a runtime dependency needs a written reason. Development dependencies do not.
`;

CLASSIFICATION["platform.md"] = `# Nimbus Platform

Customer submissions arrive at the edge collector, which writes them to the durable queue and
returns immediately. Nothing downstream is on the acknowledgement path.

Workers read from the queue in batches, validate against the registered schema, and write to
the warehouse in a single transaction. A worker that dies mid-batch leaves the batch on the
queue; the next worker picks it up whole.

The warehouse is the only consumer of committed batches. The rejection store sits beside it
and is written by the workers directly, which is why a rejection survives a warehouse outage.
`;

CLASSIFICATION["checks.md"] = `# How we check things

Every change ships with the unit tests for the code it touches. Integration tests cover the
queue boundary and the warehouse write, and nothing else — they are slow and we keep them few.

A flaky test is deleted or fixed within one week of being noticed. We do not retry a flaky
test to make a build green.

Coverage is measured but not enforced by a threshold, because a threshold rewards testing the
easy paths.

Before a release someone runs the replay procedure against staging by hand. That step has
resisted automation twice and we have stopped trying for now.
`;

// --------------------------------------------------------------------------------
// Answer keys.
// --------------------------------------------------------------------------------

const EXPECTED = {
  clean: {
    set: "clean",
    note:
      "Authored ground truth for CORPUS.md §2.14(a). Five documents, five roles. The unit " +
      "list is what a correct extractor should find, written before the extractor existed.",
    roles: {
      "product-spec.md": "productSpec",
      "architecture.md": "decisionRecord",
      "api-contract.html": "apiContract",
      "runbook.md": "runbook",
      "conventions.docx": "codingConventions",
    },
    units: [
      { category: "constraint", text: "A batch must be acknowledged within two seconds.", sources: ["product-spec.md", "architecture.md"] },
      { category: "invariant", text: "A batch is committed whole or not at all; partial ingestion never occurs.", sources: ["product-spec.md", "architecture.md"] },
      { category: "constraint", text: "Rejected batches remain retrievable for thirty days.", sources: ["product-spec.md", "api-contract.html"] },
      { category: "constraint", text: "Operators can replay any accepted batch without engineering involvement.", sources: ["product-spec.md", "api-contract.html"] },
      { category: "decision", text: "Ingestion is queue-backed; batches are acknowledged before processing.", rationale: "Synchronous validation cannot meet the acknowledgement budget under load.", sources: ["architecture.md"] },
      { category: "decision", text: "Schemas are declared by the customer, never inferred.", rationale: "Inference was the dominant incident source in the previous system.", sources: ["product-spec.md", "architecture.md"] },
      { category: "environmentVariable", text: "NIMBUS_QUEUE_URL=amqp://queue.internal:5672", sources: ["runbook.md"] },
      { category: "environmentVariable", text: "NIMBUS_BATCH_TIMEOUT_MS=30000", sources: ["runbook.md"] },
      { category: "environmentVariable", text: "NIMBUS_MAX_BATCH_MB=64", sources: ["runbook.md"] },
      { category: "command", text: "pnpm install --frozen-lockfile", sources: ["runbook.md"] },
      { category: "command", text: "pnpm build", sources: ["runbook.md"] },
      { category: "command", text: "pnpm deploy --env production", sources: ["runbook.md"] },
      { category: "command", text: "curl -sf https://ingest.internal/healthz", sources: ["runbook.md"] },
      { category: "command", text: "nimbusctl queue drain --wait", sources: ["runbook.md"] },
      { category: "convention", text: "Modules are named for what they do, not for the pattern they use.", sources: ["conventions.docx"] },
      { category: "convention", text: "Never swallow an error to keep a request alive.", sources: ["conventions.docx"] },
      { category: "convention", text: "Every bug fix ships with the test that would have caught it.", sources: ["conventions.docx"] },
      { category: "convention", text: "A new runtime dependency requires a written reason in the pull request.", sources: ["conventions.docx"] },
      { category: "antiPattern", text: "Do not delete queued batches; they are the only copy until the warehouse commit succeeds.", sources: ["runbook.md"] },
    ],
    // RETIRED 2026-08-01. Both were asserted to be one fact and both are NOT, measured
    // against the §2.14.1 predicate (CORPUS.md §2.14.2): merging pair 1 drops `more` and
    // `second`, merging pair 2 drops `whole`. The adjudicator was right about both, and the
    // 0-of-2 recall reported through Phases 4 and 5 was the correct answer to a question
    // whose key was wrong.
    //
    // They stay here as documentation and are **not graded**: each has now informed either
    // the fixture or the predicate, so grading §10.4 on them would grade the correction that
    // came out of them. §10.4's live grading moved to `fixtures/agentify/dedup/`
    // (CORPUS.md §2.16), authored afterwards. `retired` is read by check-agentify.mjs.
    nearDuplicates: [],
    retiredNearDuplicates: [
      {
        retired: "2026-08-01",
        verdict: "differentFacts",
        why:
          "Asserted as the same latency constraint stated in a PRD and in an ADR. It is not: " +
          "a p95 engineering budget is not a per-user ceiling, and merging drops `more` and " +
          "`second`. Jaccard 0.000, so the lexical claim held; the identity claim did not.",
        a: { source: "product-spec.md", text: "No user should ever wait more than two seconds for a batch to be acknowledged." },
        b: { source: "architecture.md", text: "The p95 acknowledgement budget for a single submission is 2000 milliseconds." },
      },
      {
        retired: "2026-08-01",
        verdict: "differentFacts",
        why:
          "Asserted as whole-batch atomicity stated twice. It is not: a rule about what " +
          "happens on validation failure is not the rule about commit atomicity, and merging " +
          "drops `whole`. The second implies the first only if you already believe they are " +
          "the same design, which is the assumption the corpus was encoding.",
        a: { source: "product-spec.md", text: "A batch that fails validation must be rejected whole. Partial ingestion is never acceptable." },
        b: { source: "architecture.md", text: "A submission is committed in one transaction or not at all." },
      },
    ],
    // The precision arm. `nearDuplicates` alone grades §10.4 in one direction only: it shows
    // a merge happened, never that the right thing merged, so any method loose enough to
    // merge everything would pass. These four pairs must stay SEPARATE, and each is hard for
    // a different reason — three of them are *closer* in embedding space than either
    // near-duplicate pair above, which is why a cosine threshold cannot do this job at all.
    mustNotMerge: [
      {
        why:
          "The hardest of the four, and the one nothing structural catches: two sequential " +
          "steps of one procedure. Same category, and the SAME entityKey, because both sit " +
          "under the runbook's `## Deploy` heading — so entity blocking does not apply and " +
          "the adjudicator has to reject them on meaning alone. A method that merges these " +
          "collapses a deploy procedure into one step.",
        a: { source: "runbook.md", text: "pnpm install --frozen-lockfile" },
        b: { source: "runbook.md", text: "pnpm build" },
        category: "command",
        blockedBy: "adjudicator",
      },
      {
        why:
          "Measured cosine 0.7428 against nomic-embed-text-v1.5 — above BOTH authored " +
          "near-duplicate pairs (0.63, 0.62). Same category, neither carries an entityKey, " +
          "so this too reaches the model. One is about when a batch is rejected, the other " +
          "about how long a rejected batch is kept: adjacent subject, different facts.",
        a: { source: "product-spec.md", text: "Every rejected batch must be retrievable for thirty days." },
        b: { source: "product-spec.md", text: "A batch that fails validation must be rejected whole." },
        category: "constraint",
        blockedBy: "adjudicator",
      },
      {
        why:
          "Measured cosine 0.8201 — the highest-scoring pair in the entire clean set, higher " +
          "than either true near-duplicate. A timeout and a size cap are maximally topical " +
          "and completely different facts. Caught structurally, by differing entityKeys, " +
          "which is recorded here as a REQUIREMENT rather than left as an accident of " +
          "implementation: remove that block and the highest-cosine pair in the corpus merges.",
        a: { source: "runbook.md", text: "NIMBUS_MAX_BATCH_MB=64" },
        b: { source: "runbook.md", text: "NIMBUS_BATCH_TIMEOUT_MS=30000" },
        category: "environmentVariable",
        blockedBy: "entityKey",
      },
      {
        why:
          "Both concern what an operator may do with a batch after ingestion, in the same " +
          "document and the same category, and they are independent requirements — one could " +
          "be met while the other is violated.",
        a: { source: "product-spec.md", text: "Operators must be able to replay any accepted batch without contacting engineering." },
        b: { source: "product-spec.md", text: "Every rejected batch must be retrievable for thirty days." },
        category: "constraint",
        blockedBy: "adjudicator",
      },
    ],
  },

  classification: {
    set: "classification",
    note:
      "Authored ground truth for the role-classification holdout. Written BEFORE the rules " +
      "were run against it, and the rules were not adjusted afterwards. The 10/10 on the " +
      "other three sets is in-distribution — classify.ts was tuned while reading its own " +
      "output on them — so this set exists to produce a number that can fail.",
    roles: {
      "weekly.md": "meetingNotes",
      "overview.md": "productSpec",
      "README.md": "codingConventions",
      "platform.md": "architecture",
      "checks.md": "testPolicy",
    },
    whyEachIsHard: {
      "weekly.md": "No role word anywhere in the filename, and a date for a title. Everything is in the body: attendees, an apology, and three action items with owners.",
      "overview.md": "A product spec wearing a decision record's clothes — an `## Decision` heading and a `**Rationale:**` paragraph, which are the two strongest signals the decisionRecord rule has. The content is requirements and scope. If the rules answer decisionRecord they have been fooled by format.",
      "README.md": "A filename that could introduce anything, over a body that is nothing but coding conventions. The rules' filename signal offers no help and must not hurt.",
      "platform.md": "Architecture described entirely in prose, with no heading vocabulary at all past the title — no `Components`, no `Data flow`, no `Overview`.",
      "checks.md": "testPolicy, a role none of the other three sets contain, so nothing about it was exercised while the rules were being written.",
    },
  },

  conflicting: {
    set: "conflicting",
    note:
      "Authored ground truth for CORPUS.md §2.14(b). The expected output is a conflict " +
      "report naming both sources, never a resolution (SPEC §10.4).",
    roles: {
      "deploy-guide.md": "runbook",
      "ops-runbook.md": "runbook",
      "service-overview.md": "architecture",
    },
    expectedConflicts: [
      {
        entity: "NIMBUS_BATCH_TIMEOUT_MS",
        category: "environmentVariable",
        values: [
          { value: "30000", source: "deploy-guide.md", reviewed: "2026-06-02" },
          { value: "60000", source: "ops-runbook.md", reviewed: "2026-01-14" },
        ],
        note:
          "Structurally detectable: one entity, two incompatible values. The newer source " +
          "orders first, but both must appear in the report.",
      },
      {
        entity: "build",
        category: "command",
        values: [
          { value: "pnpm build", source: "deploy-guide.md", reviewed: "2026-06-02" },
          { value: "npm run compile", source: "ops-runbook.md", reviewed: "2026-01-14" },
        ],
        note: "Two commands for one task. Same structural shape as the variable above.",
      },
    ],
    nonConflicts: [
      {
        entity: "NIMBUS_QUEUE_URL",
        note:
          "Both documents declare the same value. A conflict detector that reports this is " +
          "producing a false positive, which is why it is recorded here as a negative case.",
      },
    ],
  },

  oversized: {
    set: "oversized",
    note:
      "Authored ground truth for CORPUS.md §2.14(c). Sized to overflow a small target " +
      "budget so §10.5's progressive disclosure has something to disclose.",
    roles: {
      "engineering-handbook.md": "codingConventions",
      "glossary.md": "domainGlossary",
    },
    expected: {
      conventionUnits: RULE_TOPICS.length,
      glossaryTermUnits: 8,
      note:
        "Thirty conventions and eight glossary terms. With any target budget below roughly " +
        "half the total, the primary file must carry the highest-value units and link the " +
        "rest — and every unit must still appear somewhere, because dropping one silently " +
        "would violate SPEC §1.3 as surely as losing a paragraph does.",
    },
  },
};

// --------------------------------------------------------------------------------
// Emit.
// --------------------------------------------------------------------------------

/** Content words, lowercased, minus the stopwords a lexical matcher would also drop. */
const STOP = new Set(
  ("a an and are as at be been by for from has have in is it its of on or that the to " +
    "with within must never should ever more than one two")
    .split(" "),
);
const contentWords = (s) =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)),
  );
const jaccard = (a, b) => {
  const A = contentWords(a);
  const B = contentWords(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
};

const files = [];
const addText = (set, name, text) => files.push({ path: `${set}/${name}`, bytes: Buffer.from(text, "utf8") });

for (const [name, text] of Object.entries(CLEAN)) {
  if (name.endsWith(".docx.md")) {
    const docxName = name.replace(/\.docx\.md$/, ".docx");
    const bytes = renderDocx(parseMarkdown(text).document, { onMissingStyle: "synthesize" }).bytes;
    files.push({ path: `clean/${docxName}`, bytes: Buffer.from(bytes) });
  } else addText("clean", name, text);
}
for (const [name, text] of Object.entries(CLASSIFICATION)) addText("classification", name, text);
for (const [name, text] of Object.entries(CONFLICTING)) addText("conflicting", name, text);
for (const [name, text] of Object.entries(OVERSIZED)) addText("oversized", name, text);
for (const [set, key] of Object.entries(EXPECTED)) {
  addText(set, "expected-units.json", JSON.stringify(key, null, 2) + "\n");
}

let failures = 0;
for (const file of files) {
  const path = join(OUT, file.path);
  if (CHECK) {
    if (!existsSync(path)) { console.log(`FAIL  ${file.path} is missing`); failures++; continue; }
    if (!readFileSync(path).equals(file.bytes)) {
      console.log(`FAIL  ${file.path} does not match its generator — rerun and commit`);
      failures++;
    } else console.log(`ok    ${file.path}  ${file.bytes.length} bytes`);
    continue;
  }
  mkdirSync(join(OUT, file.path.replace(/\/[^/]+$/, "")), { recursive: true });
  writeFileSync(path, file.bytes);
  console.log(`wrote ${file.path}  ${file.bytes.length} bytes`);
}

// The corpus has to *earn* the claim it is built on. §2.14's near-duplicate pairs only
// justify the `embed` role if they are genuinely beyond lexical reach, so that is asserted
// here rather than assumed — the same discipline that caught the ambiguous subset
// being unambiguous.
console.log("\nNear-duplicate lexical similarity (must stay below a lexical threshold):");
let lexicalFailures = 0;
for (const pair of EXPECTED.clean.retiredNearDuplicates) {
  const score = jaccard(pair.a.text, pair.b.text);
  const verdict = score < 0.2 ? "ok   " : "FAIL ";
  if (score >= 0.2) lexicalFailures++;
  console.log(`${verdict} Jaccard ${score.toFixed(3)}  ${pair.a.source} vs ${pair.b.source}`);
}
// A hard negative that a cheaper stage already separates proves nothing about the merge
// decision, so the corpus asserts its own negatives are actually hard: same category (or
// category blocking handles it), and at least half must survive as far as the adjudicator
// (or the whole precision arm is really a test of entity blocking).
console.log("\nHard negatives (must be hard, not merely different):");
let negativeFailures = 0;
const negatives = EXPECTED.clean.mustNotMerge ?? [];
for (const pair of negatives) {
  if (!pair.category) {
    console.log(`FAIL  a mustNotMerge pair declares no category`);
    negativeFailures++;
    continue;
  }
  console.log(`ok    ${pair.category.padEnd(20)} blocked by ${pair.blockedBy.padEnd(12)} ${pair.a.text.slice(0, 34)} / ${pair.b.text.slice(0, 34)}`);
}
const reachAdjudicator = negatives.filter((p) => p.blockedBy === "adjudicator").length;
if (negatives.length > 0 && reachAdjudicator * 2 < negatives.length) {
  console.log(
    `FAIL  only ${reachAdjudicator} of ${negatives.length} hard negatives reach the adjudicator; ` +
      `the rest are separated structurally, so this measures entity blocking rather than the ` +
      `merge decision.`,
  );
  negativeFailures++;
}
failures += negativeFailures;

if (lexicalFailures > 0) {
  console.log(
    `\n${lexicalFailures} near-duplicate pair(s) are lexically similar enough that a ` +
      `normalized-text threshold would already merge them. They then prove nothing about ` +
      `needing embeddings, and the pair should be rewritten or the claim dropped.`,
  );
  failures += lexicalFailures;
}

if (CHECK) {
  // Negative control, added in the Phase 6 gate audit. Three loops here report success by
  // not incrementing a counter, which is also what they do over an empty list — and the
  // lexical arm in particular is the corpus's own premise, so an empty
  // `retiredNearDuplicates` would silently retire the argument for the `embed` role.
  console.log("\nNegative control");
  const ctlOk = (m) => console.log(`ok    ${m}`);
  const ctlFail = (m) => { console.log(`FAIL  ${m}`); failures++; };

  generatorControl({
    artifacts: Object.fromEntries(files.map((f) => [f.path, new Uint8Array(f.bytes)])),
    floor: 10,
    ok: ctlOk,
    fail: ctlFail,
  });

  const pairs = EXPECTED.clean.retiredNearDuplicates ?? [];
  if (pairs.length > 0) ctlOk(`${pairs.length} near-duplicate pair(s) scored, so the lexical arm is not vacuous`);
  else ctlFail("the lexical arm scored 0 pairs, so it passes without measuring the corpus premise");

  // The threshold at its boundary. A pair scoring 0.2 must fail and 0.199 must pass, or the
  // cutoff has been tested only where it is obvious.
  if (!(0.2 < 0.2) && 0.199 < 0.2) ctlOk("the Jaccard cutoff discriminates at 0.2");
  else ctlFail("the Jaccard cutoff does not discriminate at its boundary");

  if (negatives.length > 0) ctlOk(`${negatives.length} hard negative(s) present, so the precision arm is not vacuous`);
  else ctlFail("the precision arm has 0 hard negatives, so a method that merged everything would pass it");

  console.log(failures === 0 ? "\nAgentify corpus matches its generator." : `\n${failures} problem(s).`);
  process.exit(failures === 0 ? 0 : 1);
}
process.exit(failures === 0 ? 0 : 1);
