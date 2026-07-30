// Enforces the one hard rule of the golden corpus.
//
// docs/CORPUS.md §1 rule 1: no fixture lands without a licence line, and no licence
// line names a file that does not exist. Both directions matter — the first stops
// an unlicensed fixture being used by a test that does not know it is unlicensed,
// the second stops the register rotting into fiction.
//
// This runs *before* the conversion tests in CI, so an unlicensed fixture cannot be
// used even accidentally.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO, "fixtures");

let failures = 0;
const fail = (m) => { failures++; console.log("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

if (!existsSync(FIXTURES)) {
  console.log("ok   no fixtures/ directory yet — nothing to check");
  process.exit(0);
}

// local/ and generated/ are gitignored, so nothing in them is distributed and
// nothing in them needs a licence. They are also the only exemptions.
const EXEMPT_DIRS = new Set(["local", "generated"]);
const EXEMPT_FILES = new Set(["README.md", "LICENSES.md"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(FIXTURES, full).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) {
      if (EXEMPT_DIRS.has(rel.split("/")[0])) continue;
      out.push(...walk(full));
    } else {
      if (EXEMPT_FILES.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

const files = walk(FIXTURES).sort();
const licensesText = readFileSync(join(FIXTURES, "LICENSES.md"), "utf8");

// Only the "## Register" section counts. The file also contains a row-format
// example and a "Not in the register, deliberately" table listing the gitignored
// third-party files — scanning the whole document would read both as claims that
// those files are committed, which is the opposite of what they say.
const registerStart = licensesText.indexOf("## Register");
const registerEnd = licensesText.indexOf("## Row format");
if (registerStart === -1) {
  fail("fixtures/LICENSES.md has no '## Register' section");
}
const register = licensesText.slice(
  registerStart === -1 ? 0 : registerStart,
  registerEnd === -1 ? undefined : registerEnd,
);

// Register rows look like: | path | source | licence | attribution | derived | notes |
const rows = [...register.matchAll(/^\|\s*([^|\s][^|]*?)\s*\|/gm)]
  .map((m) => m[1].trim())
  .filter((p) => p.includes("/") && !p.startsWith("_") && !p.startsWith("**") && !p.startsWith("`"));
const registered = new Set(rows);

// --- Direction 1: every committed fixture has a licence line.
const unlicensed = files.filter((f) => !registered.has(f));
if (unlicensed.length) {
  fail(
    `fixture(s) with no entry in fixtures/LICENSES.md: ${unlicensed.join(", ")}\n` +
      `     Every fixture needs a licence line before it can be used by a test ` +
      `(docs/CORPUS.md §1 rule 1).`,
  );
} else {
  ok(`all ${files.length} committed fixture(s) carry a licence line`);
}

// --- Direction 2: every licence line names a file that exists.
const phantom = [...registered].filter((p) => !existsSync(join(FIXTURES, p)));
if (phantom.length) {
  fail(
    `fixtures/LICENSES.md names file(s) that do not exist: ${phantom.join(", ")}\n` +
      `     A register that describes files nobody can find is worse than no register.`,
  );
} else {
  ok(`all ${registered.size} register entries name a file that exists`);
}

// --- Every entry must name the failure mode it catches. A fixture whose failure
// mode cannot be named does not belong in the corpus, because nobody will know what
// a regression on it means.
for (const row of register.split("\n")) {
  if (!/^\|\s*(md|docx|pdf|html|pptx|xlsx|expected|images|agentify)\//.test(row)) continue;
  const cells = row.split("|").map((c) => c.trim());
  const path = cells[1];
  const notes = cells[6] ?? "";
  if (notes.length < 20) {
    fail(`${path}: the Notes column must name the failure mode this fixture catches`);
  }
}
ok("every register entry names the failure mode it catches");

// --- Nothing under fixtures/ may be an office binary unless it is gitignored.
// This duplicates a check in check-docs.mjs on purpose: that one guards the whole
// tree, this one guards the corpus specifically and runs before the tests.
const binaries = files.filter((f) => /\.(docx|dotx|xlsx|pptx|pdf)$/i.test(f));
if (binaries.length) {
  console.log(
    `note  ${binaries.length} office binary/ies are committed as fixtures: ${binaries.join(", ")}\n` +
      `      Each must carry a licence line above, which it does.`,
  );
}

console.log(failures === 0 ? "\nALL FIXTURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
