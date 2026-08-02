#!/usr/bin/env node
/**
 * Parsed IR against an **authored declaration** — never against its own round trip.
 *
 * ## The class of defect this exists for
 *
 * `docs/FIDELITY.md` measures round trips. A round trip applies the same code to both sides,
 * so **a defect applied symmetrically is invisible to it**: the same wrong answer is compared
 * against itself and agrees perfectly.
 *
 * The instance that proved the class: `textContent` joined block-level siblings with nothing,
 * so a table cell holding three paragraphs read as
 * `Stop the intake.Wait for depth to reach zero.Confirm with the dashboard.` and a nested
 * table read as `keyvaluemodestrict`. The fidelity text metric calls `textContent` on both
 * sides, so `fixtures/docx/tables-block-content.docx` scored **100% on every metric** while
 * carrying it. This is the second blind spot found in the measurement layer in one phase; the
 * first was the census scoring an absent node type as agreement.
 *
 * ## Why a declaration rather than a snapshot
 *
 * A captured snapshot is symmetric too — regenerate it from the same broken code and it
 * agrees. Every expectation here is **written by hand from the fixture's XML**, so the
 * comparison has an independent side. That is the whole mechanism, and it is why the
 * declarations are small: a hand-written expectation nobody can check is worse than none.
 *
 * `docs/CORPUS.md` §1 rule 3 already prefers authored fixtures for this reason. This applies
 * the same argument one level up, to what we expect of them.
 *
 * **Also enforces ADR-0022.** Section 3 asserts that a document with images carries their
 * *bytes*, not merely their hash and length — the property whose absence meant every adapter
 * discarded every image while the ledger blamed the writer.
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

const { parseDocx } = await import(pathToFileURL(join(REPO, "packages/adapters-docx/dist/index.js")).href);
const { textContent, selectType } = await import(pathToFileURL(join(REPO, "packages/ir/dist/index.js")).href);

/**
 * Declarations, written from each fixture's generator source rather than from its output.
 *
 * `counts` are exact node-type counts in the body. `text` asserts a specific extraction, which
 * is where the symmetric defects live — a count is often right while the string is wrong.
 */
const DECLARATIONS = [
  {
    fixture: "fixtures/docx/tables-block-content.docx",
    why: "The fixture that proved the symmetric-defect class exists.",
    counts: { table: 2, tableRow: 5, tableCell: 10, list: 1 },
    text: [
      {
        // Three separate paragraphs in one cell. SPEC §9.2 joins block nodes with a blank
        // line; before 2026-08-01 this returned them run together with no separator at all.
        of: { type: "tableCell", index: 3 },
        equals: "Stop the intake.\n\nWait for depth to reach zero.\n\nConfirm with the dashboard.",
      },
      {
        // A nested table's four cells. Returned `keyvaluemodestrict` before the fix.
        of: { type: "tableCell", index: 5 },
        equals: "key\n\nvalue\n\nmode\n\nstrict",
      },
    ],
  },
  {
    fixture: "fixtures/docx/manuscript-footnotes-equations.docx",
    why:
      "Three footnote references must each have a definition, or the Markdown is invalid rather " +
      "than degraded. One of the two OMML equations is inline in a sentence, and the IR has no " +
      "inline OMML node, so it is an `unknown` carrying the markup — see docs/LIMITS.md.",
    counts: { footnoteReference: 3, footnoteDefinition: 3, equationBlock: 1, unknown: 1 },
    text: [],
  },
  {
    fixture: "fixtures/docx/manuscript-endnotes-crossrefs.docx",
    why: "Endnotes take a different part from footnotes and were equally unread.",
    counts: { footnoteReference: 2, footnoteDefinition: 2, equationBlock: 1 },
    text: [],
  },
  {
    fixture: "fixtures/docx/comments-anchored.docx",
    why: "SPEC §3.1 lists comments under 'Also extracted'; the anchors sat in PROPERTY_ELEMENTS until 2026-08-01.",
    counts: { comment: 2 },
    text: [],
  },
  {
    fixture: "fixtures/docx/tracked-changes-two-authors.docx",
    why: "Overlapping revisions from two authors — the case a range-based model corrupts.",
    counts: { insertion: 5, deletion: 2 },
    text: [],
  },
  {
    fixture: "fixtures/docx/tables-merged-vertical.docx",
    why: "Six rows of three columns with three vMerge continuations collapsed into their originators.",
    counts: { table: 1, tableRow: 6, tableCell: 15 },
    text: [],
  },
];

const census = (root) => {
  const out = {};
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.type === "string") out[n.type] = (out[n.type] ?? 0) + 1;
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  };
  walk(root);
  return out;
};

!JSON_OUT && console.log("\n1. Parsed IR matches its authored declaration");
let assertions = 0;
for (const d of DECLARATIONS) {
  const { document } = parseDocx(new Uint8Array(readFileSync(join(REPO, d.fixture))), { path: d.fixture });
  const actual = census(document.body);
  const name = d.fixture.replace("fixtures/docx/", "");

  for (const [type, expected] of Object.entries(d.counts)) {
    assertions += 1;
    const got = actual[type] ?? 0;
    if (got === expected) continue;
    fail(`${name}: declared ${expected} ${type} node(s), parsed ${got}`);
  }

  for (const t of d.text) {
    assertions += 1;
    const nodes = selectType(document.body, t.of.type);
    const node = nodes[t.of.index];
    if (!node) {
      fail(`${name}: no ${t.of.type}[${t.of.index}] to extract text from`);
      continue;
    }
    const got = textContent(node);
    if (got === t.equals) continue;
    fail(
      `${name}: ${t.of.type}[${t.of.index}] text is ${JSON.stringify(got.slice(0, 90))}, ` +
        `declared ${JSON.stringify(t.equals.slice(0, 90))}`,
    );
  }
}
if (failures.length === 0) ok(`${assertions} assertion(s) across ${DECLARATIONS.length} fixture(s)`);

// ---------------------------------------------------------------- 2. the general rule
!JSON_OUT && console.log("\n2. SPEC §9.2's block separator holds across the whole corpus");
{
  /*
   * The declarations above catch the instances someone thought to write down. This catches
   * the rule: any container with two or more block children must have a blank line between
   * them in its extracted text. Scanning every committed DOCX fixture is what turns "we fixed
   * the cell we found" into "we know how many there were".
   */
  const { readdirSync } = await import("node:fs");
  let containers = 0;
  let violations = 0;
  for (const f of readdirSync(join(REPO, "fixtures/docx")).filter((n) => n.endsWith(".docx"))) {
    const path = join(REPO, "fixtures/docx", f);
    const { document } = parseDocx(new Uint8Array(readFileSync(path)), { path: f });
    for (const cell of selectType(document.body, "tableCell")) {
      const blocks = (cell.children ?? []).filter((c) =>
        ["paragraph", "table", "list", "blockquote", "code", "heading"].includes(c.type),
      );
      if (blocks.length < 2) continue;
      containers += 1;
      const text = textContent(cell);
      if (text.length > 0 && !text.includes("\n\n")) {
        violations += 1;
        fail(`${f}: a cell with ${blocks.length} block children extracts with no separator: ${JSON.stringify(text.slice(0, 60))}`);
      }
    }
  }
  if (containers === 0) {
    fail("no multi-block container found in the corpus, so this rule is vacuous — §2.5's DOCX half is what makes it testable");
  } else if (violations === 0) {
    ok(`${containers} multi-block container(s) across the corpus, all separated`);
  }
}

// ---------------------------------------------------------------- 3. ADR-0022: bytes survive
!JSON_OUT && console.log("\n3. Resources carry their bytes, not just a description (ADR-0022)");
{
  const { document } = parseDocx(
    new Uint8Array(readFileSync(join(REPO, "templates/academic-manuscript.docx"))),
    { path: "templates/academic-manuscript.docx" },
  );
  const resources = Object.values(document.resources ?? {});
  if (resources.length >= 2) ok(`${resources.length} resource(s) collected`);
  else fail(`only ${resources.length} resource(s) collected — the probe cannot discriminate`);

  const withoutData = resources.filter((r) => typeof r.data !== "string" || r.data === "");
  if (withoutData.length === 0) {
    ok("every resource carries base64 bytes");
  } else {
    fail(
      `${withoutData.length} resource(s) carry only metadata. That is the ADR-0022 defect: ` +
        `a description of an image is not an image, and no renderer can embed one.`,
    );
  }

  // And the bytes must be the *image*, not a truncation. A PNG starts with a fixed signature,
  // so decoding and checking it proves the round trip through base64 rather than assuming it.
  const png = resources.find((r) => r.mediaType === "image/png");
  if (png?.data) {
    const bytes = Buffer.from(png.data, "base64");
    const signature = [0x89, 0x50, 0x4e, 0x47];
    if (signature.every((b, i) => bytes[i] === b) && bytes.length === png.byteLength) {
      ok(`PNG signature intact and ${bytes.length} bytes match byteLength`);
    } else {
      fail(`decoded PNG is ${bytes.length} bytes against a declared ${png.byteLength}, or the signature is wrong`);
    }
  } else {
    fail("no PNG resource to check, so the base64 round trip is unverified");
  }
}

// ---------------------------------------------------------------- 3b. every fixture validates
!JSON_OUT && console.log("\n3b. Every corpus fixture produces a schema-valid IR");
{
  /*
   * The gap this closes: `markforge check fixtures/md/clean-report.md` reported **INVALID IR**
   * while `pnpm verify` was green, for the whole of Phases 1–6.
   *
   * SPEC §2.7.1 makes `rowSpan`, `colSpan`, and `isHeader` required on every cell and records
   * that four adapters once omitted them — "fixed by routing cell construction through
   * `tableCell()`". The Markdown adapter never took that route, so **every Markdown document
   * containing a table produced an invalid IR**. Nothing caught it because every
   * fixture-backed validation test starts from DOCX or HTML; the Markdown path had unit tests
   * on hand-built trees and no fixture-backed validation at all.
   *
   * So this validates *every* committed fixture through *its own* adapter, which is the shape
   * that would have found it: not a new assertion about tables, but the same assertion applied
   * to the input format nobody had applied it to.
   */
  const { readdirSync, existsSync } = await import("node:fs");
  const { parseMarkdown } = await import(pathToFileURL(join(REPO, "packages/adapters-md/dist/index.js")).href);
  const { parseHtmlDocument } = await import(pathToFileURL(join(REPO, "packages/adapters-html/dist/index.js")).href);
  const { validateDocument } = await import(pathToFileURL(join(REPO, "packages/ir/dist/index.js")).href);

  const dir = (d) => (existsSync(join(REPO, d)) ? readdirSync(join(REPO, d)) : []);
  const inputs = [
    ...dir("fixtures/md").filter((f) => f.endsWith(".md")).map((f) => ["md", `fixtures/md/${f}`]),
    ...dir("fixtures/html").filter((f) => f.endsWith(".html")).map((f) => ["html", `fixtures/html/${f}`]),
    ...dir("fixtures/docx").filter((f) => f.endsWith(".docx")).map((f) => ["docx", `fixtures/docx/${f}`]),
    ...dir("templates").filter((f) => f.endsWith(".docx")).map((f) => ["docx", `templates/${f}`]),
  ];

  let checked = 0;
  for (const [format, rel] of inputs) {
    const bytes = new Uint8Array(readFileSync(join(REPO, rel)));
    const doc =
      format === "md"
        ? parseMarkdown(bytes, { path: rel }).document
        : format === "html"
          ? parseHtmlDocument(bytes, { path: rel }).document
          : parseDocx(bytes, { path: rel }).document;
    const r = validateDocument(doc);
    checked += 1;
    if (r.valid) continue;
    const first = r.errors[0];
    fail(
      `${rel}: IR does not validate — ${first?.path ?? "?"}: ${first?.message ?? "?"} ` +
        `(${r.errors.length} error(s))`,
    );
  }
  if (inputs.length >= 30) ok(`${checked} fixture(s) across md, html, and docx all validate`);
  else fail(`only ${inputs.length} fixture(s) resolved — the walk is broken and this passes vacuously`);
}

// ---------------------------------------------------------------- 4. negative control
!JSON_OUT && console.log("\n3. Negative control — the comparison must be able to fail");
{
  const probe = { type: "tableCell", children: [
    { type: "paragraph", children: [{ type: "text", value: "one" }] },
    { type: "paragraph", children: [{ type: "text", value: "two" }] },
  ] };
  const got = textContent(probe);
  if (got === "one\n\ntwo") ok("two block siblings extract with a blank line between them");
  else fail(`negative control: two paragraphs extracted as ${JSON.stringify(got)}, expected "one\\n\\ntwo"`);

  // The inline half must NOT gain a separator, or the fix has over-applied and every
  // emphasised word becomes its own block.
  const inline = { type: "paragraph", children: [
    { type: "text", value: "a" },
    { type: "strong", children: [{ type: "text", value: "b" }] },
    { type: "text", value: "c" },
  ] };
  const gotInline = textContent(inline);
  if (gotInline === "abc") ok("inline siblings still concatenate with no separator");
  else fail(`negative control: inline nodes extracted as ${JSON.stringify(gotInline)}, expected "abc"`);

  // And a declaration that cannot fail is worth nothing: assert the comparison discriminates.
  if (textContent(probe) !== "onetwo") ok("the pre-fix concatenation would be reported");
  else fail("negative control: the separator rule is not being applied");

  if (assertions >= 15) ok(`${assertions} declared assertion(s), so section 1 is not vacuous`);
  else fail(`only ${assertions} declared assertion(s) — section 1 checks almost nothing`);

  /*
   * Section 3b's own control. The defect it was written for was a *missing required field on
   * a table cell*, so that is what the control reproduces — deleting `rowSpan` from a parsed
   * fixture's first cell, which is byte-for-byte the shape the Markdown adapter shipped for
   * five phases. A control that broke the document some easier way (a node with no `type`,
   * say) would prove the validator rejects garbage, which was never in doubt.
   */
  const { validateDocument: validate } = await import(
    pathToFileURL(join(REPO, "packages/ir/dist/index.js")).href
  );
  const probeDoc = parseDocx(new Uint8Array(readFileSync(join(REPO, "fixtures/docx/tables-merged-combined.docx"))), {
    path: "control",
  }).document;
  if (!validate(probeDoc).valid) {
    fail("negative control: the unperturbed fixture is already invalid, so 3b proves nothing");
  } else {
    const table = probeDoc.body.children.find((n) => n.type === "table");
    const cell = table?.children?.[0]?.children?.[0];
    if (!cell) {
      fail("negative control: no table cell found in tables-merged-combined.docx");
    } else {
      delete cell.rowSpan;
      const after = validate(probeDoc);
      if (!after.valid && after.errors.some((e) => e.message.includes("rowSpan"))) {
        ok("deleting one cell's rowSpan is detected, and the error names rowSpan");
      } else {
        fail(
          `negative control: a cell missing rowSpan validated as ${after.valid ? "valid" : "invalid but unnamed"} ` +
            `— 3b would not have caught the defect it was written for`,
        );
      }
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, assertions }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nParsed IR matches its authored declaration on ${DECLARATIONS.length} fixture(s).`
      : `\n${failures.length} structure failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
