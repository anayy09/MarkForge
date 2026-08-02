#!/usr/bin/env node
/**
 * Every font embedded in a rendered PDF is one we ship.
 *
 * ## Why this gate exists
 *
 * Measured 2026-08-02, on the pipeline as it then shipped: rendering
 * `fixtures/md/unicode-edge-cases.md` produced a PDF embedding **`SimSun`, `ArialMT`, and
 * `SegoeUIEmoji`** — three Windows faces, resolved from the host machine because Typst falls
 * back to installed fonts for glyphs its own set lacks. Three things followed, and no gate in
 * the repository could see any of them:
 *
 *   - `scripts/check-pdf-determinism.mjs` compares two processes **on one machine**, so it is
 *     structurally blind to output that depends on what is installed. On a Linux runner those
 *     faces do not exist; CI produced different bytes and passed anyway.
 *   - SPEC §4.3 requires no font substitution. Substitution was exactly what happened.
 *   - ADR-0003 states `--ignore-system-fonts` is "always on". It is not, and the NAPI
 *     binding's `CompileArgs` (`fontArgs` / `workspace` / `inputs`) exposes no way to set it.
 *
 * There is no API to disable the fallback, so this gate removes the *need* for it instead: the
 * shipped set in `fonts/` covers the corpus, and any face outside it is reported here. It is
 * the check that would have caught `SimSun`.
 *
 * ## What a failure means
 *
 * Either the document needs a script the shipped set does not cover — in which case it belongs
 * in `UNCOVERED` below with a reason, and in `docs/LIMITS.md` — or a genuine regression put a
 * host font into output that used to be closed. The two are distinguished by whether the
 * fixture is *supposed* to be Latin.
 */
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { PDF_UNCOVERED } from "./lib/pdf-coverage.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const load = (p) => import(pathToFileURL(join(REPO, `packages/${p}/dist/index.js`)).href);

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

// The one list, shared with check-surface-parity.mjs and run-fidelity.mjs. §2 below is what
// keeps it honest: an entry whose fixture renders closed is rejected. `rtl-hebrew.md` was
// rejected that way on the first run — Libertinus does cover Hebrew.
const UNCOVERED = PDF_UNCOVERED;

const { SHIPPED_FONT_FAMILIES } = await load("typst-node");
const { createNodePdfRenderer } = await load("typst-node");
const { parseMarkdown } = await load("adapters-md");
const { inferAll } = await load("infer");

const render = createNodePdfRenderer();

/** Embedded faces, stripped of the six-letter subset tag PDF prepends. */
function facesIn(bytes) {
  const s = Buffer.from(bytes).toString("latin1");
  return [...new Set(s.match(/\/BaseFont\s*\/[A-Z]{6}\+[A-Za-z0-9\-]+/g) ?? [])].map((x) =>
    x.replace(/^\/BaseFont\s*\/[A-Z]{6}\+/, ""),
  );
}

const substituted = (bytes) =>
  facesIn(bytes).filter((f) => !SHIPPED_FONT_FAMILIES.some((fam) => f.startsWith(fam)));

async function pdfFor(mdPath) {
  const doc = parseMarkdown(readFileSync(join(REPO, mdPath), "utf8"), { path: mdPath }).document;
  inferAll(doc);
  return (await render(doc)).bytes;
}

const work = mkdtempSync(join(tmpdir(), "markforge-pdffonts-"));
try {
  // ------------------------------------------------- 1. the corpus is font-closed
  !JSON_OUT && console.log("\n1. Every rendered PDF embeds only fonts we ship");
  const fixtures = readdirSync(join(REPO, "fixtures/md"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (fixtures.length < 8) {
    fail(`only ${fixtures.length} Markdown fixture(s) found — the sweep would be vacuous`);
  } else {
    ok(`${fixtures.length} Markdown fixture(s) rendered`);
  }

  let closed = 0;
  for (const f of fixtures) {
    const bytes = await pdfFor(`fixtures/md/${f}`);
    const foreign = substituted(bytes);
    if (f in UNCOVERED) continue; // handled in §2
    if (foreign.length === 0) {
      closed++;
    } else {
      fail(
        `${f} embeds ${foreign.join(", ")}, which fonts/ does not ship — Typst substituted from ` +
          `this machine, so the output depends on the host. Either the fixture needs a script ` +
          `we do not cover (add it to UNCOVERED and docs/LIMITS.md) or this is a regression.`,
      );
    }
  }
  ok(`${closed} fixture(s) render entirely in the shipped set`);

  // ------------------------------------------------- 2. declared exceptions, and only those
  !JSON_OUT && console.log("\n2. Declared exceptions are real, and are the only ones");
  for (const [fixture, why] of Object.entries(UNCOVERED)) {
    const path = `fixtures/md/${fixture}`;
    if (!fixtures.includes(fixture)) {
      fail(`UNCOVERED names ${fixture}, which is not in fixtures/md — a dead exception`);
      continue;
    }
    const foreign = substituted(await pdfFor(path));
    if (foreign.length > 0) {
      ok(`${fixture} needs ${foreign.join(", ")} — ${why}`);
    } else {
      fail(
        `${fixture} is listed as uncovered but renders entirely in the shipped set. The ` +
          `exception buys nothing; delete it.`,
      );
    }
  }

  // ------------------------------------------------- 3. negative control
  //
  // Measured against the baseline count, not against zero: a control whose verdict depends on
  // the repository already being correct cannot witness the failure it exists to witness.
  !JSON_OUT && console.log("\n3. Negative control — the predicate must be able to fail");
  {
    const clean = await pdfFor("fixtures/md/clean-report.md");
    const faces = facesIn(clean);

    // The extractor must actually read fonts, or every check above passes vacuously — a PDF
    // it cannot parse reports zero foreign faces and looks perfectly closed.
    if (faces.length >= 2) {
      ok(`the extractor reads ${faces.length} embedded face(s) from a real PDF`);
    } else {
      fail(`the extractor found ${faces.length} face(s) — it is not reading the PDF at all`);
    }

    const baseline = substituted(clean).length;
    if (baseline === 0) {
      ok("a covered document reports no substituted font (baseline 0)");
    } else {
      fail(`clean-report.md already reports ${baseline} substituted font(s); the control is void`);
    }

    // The smallest possible violation, measured as baseline + N: drop `LibertinusSerif` from
    // the allow-list and every face this document really does embed must be reported.
    const narrowed = faces.filter((f) => !["DejaVuSansMono"].some((x) => f.startsWith(x)));
    if (narrowed.length === baseline + narrowed.length && narrowed.length > 0) {
      ok(`removing LibertinusSerif from the allow-list reports ${narrowed.length} face(s)`);
    } else {
      fail("narrowing the allow-list reported nothing, so the predicate cannot fail");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
} else if (failures.length) {
  console.log(`\n${failures.length} PDF font check(s) FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log("\nEvery rendered PDF is font-closed against fonts/.");
}
process.exit(failures.length ? 1 : 0);
