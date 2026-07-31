// Fetches the tesseract language data the OCR path needs to run offline.
//
// `createTesseractRecognizer` refuses to start unless `langPath` names a directory holding
// `<lang>.traineddata`, or `allowDownload: true` is passed deliberately (ADR-0017, brief
// §3.6: every network call is opt-in and explicit). That rule is what makes "MarkForge ran
// offline" a promise rather than a hope — but it also means the data has to arrive somehow,
// and this is the somehow.
//
// **Deliberately not committed.** `eng.traineddata` is ~4 MB of Apache-2.0 licensed model
// weights from the tesseract project. `docs/CORPUS.md` §4 keeps anything of that size out of
// git history when a committed script can reproduce it, and `fixtures/local/` is already the
// gitignored home for third-party files we may use but not redistribute.
//
// Everything downstream degrades rather than failing when it is absent: the OCR measurement
// skips with a note, and the test suite skips the tesseract cases. Running this is what turns
// them on.
//
//   node scripts/fetch-ocr-assets.mjs
//   node scripts/fetch-ocr-assets.mjs --check    exit 1 if assets are missing
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const TESSDATA_DIR = join(REPO, "fixtures/local/tessdata");

// tessdata_fast, not tessdata_best: 4 MB against 15 MB, and the difference in accuracy is
// far smaller than the difference between our synthesized bitmap font and a real typeface,
// which is the dominant error term in every number these fixtures produce (CORPUS.md §2.7).
const FOUND_SCANS_DIR = join(REPO, "fixtures/local/found-scans");

const ASSETS = [
  {
    name: "eng.traineddata",
    dir: TESSDATA_DIR,
    url: "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata",
    minBytes: 1_000_000,
    licence: "Apache-2.0 (tesseract-ocr/tessdata_fast)",
  },
  {
    // CORPUS.md §2.7's "found scan". A 1973 NASA technical report: genuinely scanned
    // paper, real typeface, real scanner noise — everything the synthesized fixtures
    // cannot be, since their glyphs are a 5x7 bitmap font authored in the builder.
    //
    // It carries an archive-added OCR text layer, which is not a defect in the choice but
    // the finding: see CORPUS.md §2.7. Public domain as a work of the US government.
    name: "nasa-19730010146.pdf",
    dir: FOUND_SCANS_DIR,
    url: "https://ntrs.nasa.gov/api/citations/19730010146/downloads/19730010146.pdf",
    minBytes: 500_000,
    licence: "Public domain (work of the US federal government, NASA NTRS 19730010146)",
  },
];

const CHECK = process.argv.includes("--check");

let missing = 0;
for (const asset of ASSETS) {
  const path = join(asset.dir, asset.name);
  if (existsSync(path) && statSync(path).size >= asset.minBytes) {
    console.log(`ok    ${asset.name} present (${(statSync(path).size / 1024 / 1024).toFixed(1)} MB)`);
    continue;
  }
  if (CHECK) {
    console.log(`missing  ${asset.name} — run \`node scripts/fetch-ocr-assets.mjs\``);
    missing += 1;
    continue;
  }

  console.log(`fetching ${asset.name} from ${asset.url}`);
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) {
    console.log(`FAIL  ${asset.name}: HTTP ${response.status}`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < asset.minBytes) {
    // A redirect to an HTML error page is the usual failure here, and it is silent: the
    // file exists, is the wrong thing, and tesseract reports a confusing parse error later.
    console.log(`FAIL  ${asset.name}: got ${bytes.byteLength} bytes, expected at least ${asset.minBytes}`);
    process.exit(1);
  }
  mkdirSync(asset.dir, { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote ${path}  ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB  ${asset.licence}`);
}

if (CHECK && missing > 0) process.exit(1);
console.log(missing === 0 ? "\nOCR assets ready." : "");
