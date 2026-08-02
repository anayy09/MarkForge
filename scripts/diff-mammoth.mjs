// Differential test: our OOXML reader against Mammoth (ADR-0005).
//
// ADR-0005 deviates from SPEC §3 by building our own reader instead of using Mammoth.
// The design argument is sound — Mammoth's style map targets HTML elements and discards
// the computed style evidence IR §4.2 exists to carry, so building on it would mean
// fighting it for the project's core data structure. The *risk* is not the design, it is
// the accumulated edge cases: Mammoth encodes years of handling for style inheritance
// chains, `numbering.xml` resolution, theme font indirection via `w:themeFont`, field
// codes, and section properties. A fresh reader gets some of those wrong in ways the
// corpus does not obviously reveal.
//
// So this runs both readers over the corpus, reduces each to comparable plain text plus a
// structural outline, and diffs. **A divergence is not a failure.** We expect to beat
// Mammoth in places — that is the point of ADR-0005 — so the exit code is driven by the
// triage file, not by the diff. Every divergence must appear in `docs/MAMMOTH-DIFF.md`
// classified as `improvement` or `bug`; an untriaged one fails the build. That converts an
// unknown risk into a reviewed list, which is all this can honestly do.
//
//   node scripts/diff-mammoth.mjs            report the diff
//   node scripts/diff-mammoth.mjs --check    fail on any untriaged divergence
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { parseDocx } from "../packages/adapters-docx/dist/index.js";
import { inferAll } from "../packages/infer/dist/index.js";
import { textContent } from "../packages/ir/dist/index.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHECK = process.argv.includes("--check");
const CORPUS = join(REPO, "fixtures/docx");
const TRIAGE = join(REPO, "docs/MAMMOTH-DIFF.md");

/** Collapses whitespace so a difference in wrapping is not reported as a difference in text. */
const normText = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Our IR reduced to an outline: one line per block, `kind[:level] text`.
 *
 * Deliberately coarse. The two readers disagree constantly about things nobody cares
 * about — how a run is split, whether an empty paragraph exists — and a diff that reported
 * those would bury the divergences that matter under noise nobody would read twice.
 *
 * **Walks children explicitly rather than using `visit`.** A full-tree walk counts the
 * paragraph inside a list item twice, once as `listItem` and once as `paragraph`, and the
 * same for every table cell — which reported "ours 8, mammoth 2" on documents where the two
 * readers in fact agreed. Mammoth's HTML nests the same way and its reduction only matches
 * top-level tags, so this has to as well or the comparison is not one.
 */
/**
 * Text as the shipped default would render it: `revisionMode: "clean"`, so a tracked deletion
 * is not there.
 *
 * `textContent` returns every node in the subtree, deletions included and unseparated, so a
 * paragraph reading "forty" deleted and "fifty" inserted reduced to `fortyfifty` — a token
 * only our side produced, reported as a rendering bug, and still reported after the renderer
 * was fixed. The defect was real; the *measurement* of it was reading the IR rather than the
 * output. Mammoth's HTML shows accepted text, so this compares like with like.
 */
function acceptedText(node) {
  const strip = (n) => {
    if (!n || typeof n !== "object") return n;
    if (n.type === "deletion") return null;
    if (!Array.isArray(n.children)) return n;
    return { ...n, children: n.children.map(strip).filter(Boolean) };
  };
  return textContent(strip(node));
}

function ourOutline(node, out = []) {
  for (const child of node.children ?? []) {
    switch (child.type) {
      case "heading":
        out.push(`heading:${child.resolvedLevel ?? child.depth} ${normText(acceptedText(child))}`);
        break;
      case "paragraph": {
        const t = normText(acceptedText(child));
        if (t) out.push(`paragraph ${t}`);
        break;
      }
      case "list":
        for (const item of child.children ?? []) {
          // A nested list is emitted as its own items, not folded into its parent's
          // text. `textContent` on the outer item includes the inner one, which glued
          // "…numbered item." to "A nested item." and reported the seam as a token only
          // our reader produced — a divergence invented entirely by the reduction.
          const own = (item.children ?? []).filter((c) => c.type !== "list");
          out.push(`listItem ${normText(own.map((c) => acceptedText(c)).join(" "))}`);
          for (const nested of (item.children ?? []).filter((c) => c.type === "list")) {
            ourOutline({ children: [nested] }, out);
          }
        }
        break;
      case "table": {
        // Cell by cell with a separator. `textContent` on a whole table runs the cells
        // together, which turned a five-cell row into one unsearchable token and made a
        // clean agreement look like a total divergence.
        const cells = [];
        for (const row of child.children ?? []) {
          for (const cell of row.children ?? []) cells.push(normText(acceptedText(cell)));
        }
        out.push(`table ${cells.filter(Boolean).join(" ").slice(0, 120)}`);
        break;
      }
      // A caption's children are phrasing, so the recursion below walks into `text` nodes,
      // finds no children, and pushes nothing — the caption's words vanish from our side of
      // the comparison and read as tokens only Mammoth recovered. That is the third
      // divergence this reduction invented rather than found (see the list and table notes
      // above), and it was reported as a footnote-reader bug for a day after the footnote
      // reader was built.
      case "caption":
      case "descriptionTerm":
      case "descriptionDetails": {
        const t = normText(acceptedText(child));
        if (t) out.push(`${child.type} ${t}`);
        break;
      }
      default:
        if (Array.isArray(child.children)) ourOutline(child, out);
    }
  }
  return out;
}

/** Mammoth's HTML reduced to the same shape, so the two are comparable. */
function mammothOutline(html) {
  const out = [];
  const re = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = normText(m[2].replace(/<[^>]+>/g, " "));
    if (tag === "table") out.push(`table ${text.slice(0, 120)}`);
    else if (tag === "li") out.push(`listItem ${text}`);
    else if (tag === "p") { if (text) out.push(`paragraph ${text}`); }
    else out.push(`heading:${tag[1]} ${text}`);
  }
  return out;
}

const files = existsSync(CORPUS)
  ? readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).sort()
  : [];

const findings = [];
for (const name of files) {
  const bytes = new Uint8Array(readFileSync(join(CORPUS, name)));
  let ours, theirs;
  try {
    // Inference first. Rule A5 keeps heading *decisions* out of the adapter — it records
    // style evidence and `@markforge/infer` promotes — so comparing raw adapter output
    // against Mammoth's HTML would report "ours 0 headings, mammoth 5" on every file and
    // say nothing about either reader. Mammoth's output is post-decision, so ours must be.
    const parsed = parseDocx(bytes).document;
    inferAll(parsed, {});
    ours = ourOutline(parsed.body);
  } catch (error) {
    findings.push({ file: name, id: `${name}:our-reader-threw`, detail: `our reader threw: ${error.message}` });
    continue;
  }
  try {
    theirs = mammothOutline((await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })).value);
  } catch (error) {
    findings.push({ file: name, id: `${name}:mammoth-threw`, detail: `mammoth threw: ${error.message}` });
    continue;
  }

  // Text-level: what one reader recovered and the other did not. This is the question
  // that matters — a heading level we disagree on is a judgement call, but text only one
  // reader saw is a bug in the other.
  const ourText = normText(ours.map((l) => l.replace(/^\w+(:\d)? /, "")).join(" "));
  const theirText = normText(theirs.map((l) => l.replace(/^\w+(:\d)? /, "")).join(" "));

  const ourWords = new Set(ourText.split(" ").filter(Boolean));
  const theirWords = new Set(theirText.split(" ").filter(Boolean));
  const onlyOurs = [...ourWords].filter((w) => !theirWords.has(w));
  const onlyTheirs = [...theirWords].filter((w) => !ourWords.has(w));

  if (onlyTheirs.length > 0) {
    findings.push({
      file: name,
      id: `${name}:text-only-mammoth`,
      detail: `${onlyTheirs.length} token(s) Mammoth recovered and we did not: ${onlyTheirs.slice(0, 8).join(", ")}`,
    });
  }
  if (onlyOurs.length > 0) {
    findings.push({
      file: name,
      id: `${name}:text-only-ours`,
      detail: `${onlyOurs.length} token(s) we recovered and Mammoth did not: ${onlyOurs.slice(0, 8).join(", ")}`,
    });
  }

  // Structural: block-kind counts. Coarse on purpose, per the note above.
  const counts = (rows) => {
    const c = {};
    for (const r of rows) {
      const k = r.split(" ")[0];
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  };
  const a = counts(ours);
  const b = counts(theirs);
  for (const kind of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[kind] ?? 0) === (b[kind] ?? 0)) continue;
    findings.push({
      file: name,
      id: `${name}:count:${kind}`,
      detail: `${kind}: ours ${a[kind] ?? 0}, mammoth ${b[kind] ?? 0}`,
    });
  }
}

// --- Triage. A divergence is only acceptable once someone has written down which it is.
const triaged = new Map();
if (existsSync(TRIAGE)) {
  for (const line of readFileSync(TRIAGE, "utf8").split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*(improvement|bug|accepted)\s*\|/.exec(line.trim());
    if (m) triaged.set(m[1], m[2]);
  }
}

console.log(`${files.length} corpus file(s), ${findings.length} divergence(s)\n`);
const untriaged = [];
for (const f of findings) {
  const verdict = triaged.get(f.id);
  console.log(`${verdict ? verdict.padEnd(11) : "UNTRIAGED  "} ${f.id}\n            ${f.detail}`);
  if (!verdict) untriaged.push(f);
}

/*
 * Rows in the triage table that no longer describe a divergence.
 *
 * The gate caught untriaged findings from the start and said nothing about the other
 * direction, so a verdict outlived the defect it explained: after the footnote and endnote
 * readers were built, `docs/MAMMOTH-DIFF.md` still carried rows reading "**Mammoth reads
 * `endnotes.xml` and we do not**" while the table stood at 24 verdicts against 22
 * divergences. A stale verdict is worse than an untriaged one — it is a confident claim
 * about the current code that happens to be false — and this document exists to be read.
 */
const stale = [...triaged.keys()].filter((id) => !findings.some((f) => f.id === id));
if (stale.length > 0) {
  console.log(
    `
${stale.length} verdict(s) in docs/MAMMOTH-DIFF.md describe a divergence that no longer ` +
      `occurs: ${stale.join(", ")}. Delete the row, or say what changed — a verdict that ` +
      `outlives its defect is a false statement about today's code.`,
  );
}

if (!CHECK) {
  // Emit a starter table so triage is an edit rather than a transcription job.
  const rows = findings
    .map((f) => `| \`${f.id}\` | ${triaged.get(f.id) ?? "TODO"} | ${f.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  writeFileSync(
    join(REPO, "docs/.mammoth-diff.generated.md"),
    `| Divergence | Verdict | Detail |\n| --- | --- | --- |\n${rows}\n`,
    "utf8",
  );
  console.log(`\nStarter table written to docs/.mammoth-diff.generated.md`);
}

// --- Negative control.
//
// Added in the Phase 6 gate audit, which found this gate could not demonstrate a failure.
// "All divergences triaged" is what a reviewed tree reports and equally what a run that
// compared **nothing** reports: `untriaged` is derived from `findings`, and an empty
// `findings` — a fixture list that stopped resolving, a Mammoth call that threw and was
// swallowed, a comparison narrowed until it matched everything — produces the same sentence.
// ADR-0005's whole risk argument rests on this list being non-empty and reviewed.
console.log("\nNegative control");
let controlFailures = 0;
{
  const ctlOk = (m) => console.log(`ok    ${m}`);
  const ctlFail = (m) => { console.log(`FAIL  ${m}`); controlFailures += 1; };

  if (findings.length > 0) ctlOk(`${findings.length} divergence(s) compared, so "all triaged" is a measurement`);
  else ctlFail("0 divergences were found — either the readers now agree exactly, which is implausible, or the comparison stopped comparing");

  if (triaged.size > 0) ctlOk(`${triaged.size} verdict(s) parsed from docs/MAMMOTH-DIFF.md`);
  else ctlFail("no verdicts parsed from docs/MAMMOTH-DIFF.md — every finding would read as untriaged, or the parser is broken");

  // The smallest violation: one divergence with no verdict. Not an emptied triage table.
  const phantomId = "__control-untriaged__";
  if (!triaged.has(phantomId)) ctlOk("a single untriaged divergence would be reported");
  else ctlFail(`negative control: ${phantomId} is triaged, so this control is void`);
}

if (untriaged.length > 0 || stale.length > 0 || controlFailures > 0) {
  if (untriaged.length > 0) {
    console.log(
      `\n${untriaged.length} divergence(s) are not triaged in docs/MAMMOTH-DIFF.md. ` +
        `Every one must be recorded as \`improvement\`, \`bug\`, or \`accepted\` — the point ` +
        `of this script is a reviewed list, not a green tick.`,
    );
  }
  if (controlFailures > 0) {
    console.log(`\n${controlFailures} negative-control failure(s): this gate cannot currently detect an untriaged divergence.`);
  }
  process.exit(CHECK ? 1 : 0);
}
console.log("\nAll divergences triaged.");
