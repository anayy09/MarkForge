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
import { shippedCoverage, uncoveredIn } from "./lib/font-coverage.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const load = (p) => import(pathToFileURL(join(REPO, `packages/${p}/dist/index.js`)).href);

const failures = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

// The one list, shared with check-surface-parity.mjs and run-fidelity.mjs. §2 keeps it honest
// in both directions: an entry whose fixture is fully drawable is rejected, and a fixture that
// is *not* listed but contains an undrawable character is rejected too. `rtl-hebrew.md` was
// rejected by the first rule on the first run — Libertinus does cover Hebrew.
const UNCOVERED = PDF_UNCOVERED;

const { SHIPPED_FONT_FAMILIES, SHIPPED_BODY_FONTS, createNodePdfRenderer } = await load("typst-node");
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
  //
  // Asked of the **font files**, not of a rendered PDF.
  //
  // The first version asked "did rendering this pull in a face we do not ship", and CI failed
  // it on the first push — for the right reason. That question is machine-dependent, which is
  // the exact property this gate exists to eliminate: on Windows `cjk-chinese.md` substituted
  // SimSun, and on the Linux runner, which has no CJK face installed, it substituted *nothing*
  // and looked perfectly closed. Both observations are true and neither is a fact about this
  // repository. `scripts/lib/font-coverage.mjs` reads the cmaps instead, so the answer is the
  // same everywhere.
  !JSON_OUT && console.log("\n2. Declared exceptions are real, and are the only ones");
  // Body faces only. `SHIPPED_FONTS` would include DejaVuSansMono, which covers Arabic that
  // Libertinus does not — and Typst will not set prose in a mono face, so counting it made
  // `rtl-arabic.md` look drawable while every machine still substituted for it.
  const covered = shippedCoverage(join(REPO, "fonts"), SHIPPED_BODY_FONTS);
  ok(`the shipped body faces draw ${covered.size} code point(s) between them`);

  for (const [fixture, why] of Object.entries(UNCOVERED)) {
    if (!fixtures.includes(fixture)) {
      fail(`UNCOVERED names ${fixture}, which is not in fixtures/md — a dead exception`);
      continue;
    }
    const source = readFileSync(join(REPO, "fixtures/md", fixture), "utf8");
    const missing = uncoveredIn(source, covered);
    if (missing.length > 0) {
      const shown = missing.slice(0, 6).map((c) => JSON.stringify(c)).join(" ");
      ok(`${fixture} has ${missing.length} character(s) no shipped face draws (${shown}) — ${why}`);
    } else {
      fail(
        `${fixture} is listed as uncovered, but every character in it is drawable by the ` +
          `shipped faces. The exception buys nothing; delete it.`,
      );
    }
  }

  // And the other direction: a fixture that is *not* exempt must be fully drawable, or §1 is
  // passing only because the machine happened to have a font to substitute.
  for (const f of fixtures) {
    if (f in UNCOVERED) continue;
    const missing = uncoveredIn(readFileSync(join(REPO, "fixtures/md", f), "utf8"), covered);
    if (missing.length > 0) {
      fail(
        `${f} is not exempt but contains ${missing.length} character(s) no shipped face draws ` +
          `(${missing.slice(0, 6).map((c) => JSON.stringify(c)).join(" ")}). On a machine with a ` +
          `matching system font this renders and §1 passes; on one without, the glyphs are lost. ` +
          `Add it to scripts/lib/pdf-coverage.mjs or ship a face that covers it.`,
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
