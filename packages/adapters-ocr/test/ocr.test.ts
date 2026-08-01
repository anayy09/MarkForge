/**
 * Tests for the OCR adapter, all against a stub recogniser.
 *
 * A stub rather than tesseract, and that is not laziness: tesseract.js fetches a 15 MB
 * language model at runtime, so a test that used it would either download on every run or
 * depend on a machine-local file. Neither is a test CI can run from a clone. What is worth
 * testing here is everything *around* the recogniser — provenance, confidence, diagnostics,
 * and block assembly — and that is all engine-independent by construction.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOW_CONFIDENCE,
  createTesseractRecognizer,
  documentFromPages,
  type PageImage,
  type RecognizedPage,
  type Recognizer,
} from "../src/index.js";
import { selectType, textContent, validateDocument } from "@markforge/ir";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const page = (pageNumber: number): PageImage => ({
  pageNumber,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "image/png",
  width: 100,
  height: 200,
});

const stub =
  (answers: Record<number, RecognizedPage>): Recognizer =>
  async (p) =>
    answers[p.pageNumber] ?? { blocks: [], confidence: 0, engine: { kind: "ocr", engine: "stub", version: "0" } };

const MODEL_ENGINE = { kind: "model" as const, model: "gemma-4-31b-it", promptVersion: "v1" };
const OCR_ENGINE = { kind: "ocr" as const, engine: "tesseract.js", version: "6.x" };

describe("documentFromPages", () => {
  it("builds a valid IR document with headings, paragraphs, and grouped list items", async () => {
    const { document } = await documentFromPages(
      [page(1)],
      stub({
        1: {
          confidence: 0.95,
          engine: MODEL_ENGINE,
          blocks: [
            { kind: "heading", level: 1, text: "Facilities Report" },
            { kind: "paragraph", text: "Body text." },
            { kind: "listItem", text: "First item" },
            { kind: "listItem", text: "Second item" },
            { kind: "paragraph", text: "After the list." },
            { kind: "caption", text: "Figure 1" },
          ],
        },
      }),
    );

    expect(validateDocument(document).valid).toBe(true);
    expect(selectType(document.body, "heading")).toHaveLength(1);
    // Two items, one list: the recogniser reports items and the adapter decides where a
    // list begins, so consecutive items collapse and a paragraph breaks the run.
    expect(selectType(document.body, "list")).toHaveLength(1);
    expect(selectType(document.body, "listItem")).toHaveLength(2);
    // A caption survives as text but not as a caption: it has no figure to bind to, and
    // the loss is reported rather than papered over with a synthesised figure.
    expect(selectType(document.body, "caption")).toHaveLength(0);
    expect(textContent(document.body)).toContain("Figure 1");
    expect(textContent(document.body)).toContain("Facilities Report");
  });

  it("reports an unbindable caption as a lost construct", async () => {
    const { diagnostics } = await documentFromPages(
      [page(1)],
      stub({
        1: { confidence: 0.95, engine: MODEL_ENGINE, blocks: [{ kind: "caption", text: "Figure 1. Site plan." }] },
      }),
    );
    const lost = diagnostics.lossy().filter((d) => d.construct === "caption");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.message).toMatch(/binding is lost/);
  });

  // The load-bearing property of this adapter: everything it produces is a reading of a
  // picture, and provenance has to say so, including *which* reader and how sure it was.
  //
  // "Everything" means the transcribed content. The root node is the adapter's own — it
  // made a container, which is not a guess — so it keeps the adapter as its producer at
  // confidence 1. Asserting one rule for both was the first version of this test, and the
  // distinction it missed is a real one: a confidence on a root would mean nothing.
  it("records the engine and the confidence on every transcribed node", async () => {
    const { document } = await documentFromPages(
      [page(1)],
      stub({
        1: {
          confidence: 0.82,
          engine: MODEL_ENGINE,
          blocks: [{ kind: "paragraph", text: "Text." }, { kind: "heading", level: 2, text: "H" }],
        },
      }),
    );
    const contentIds = [
      ...selectType(document.body, "paragraph"),
      ...selectType(document.body, "heading"),
      ...selectType(document.body, "text"),
    ].map((n) => (n as { id?: string }).id);
    expect(contentIds.length).toBeGreaterThan(2);
    for (const id of contentIds) {
      const p = document.provenance[id!];
      expect(p?.confidence).toBe(0.82);
      expect(p?.producedBy).toEqual({ kind: "model", model: "gemma-4-31b-it", promptVersion: "v1" });
      expect(p?.locator).toEqual({ kind: "page", pageNumber: 1 });
    }
    const rootProvenance = document.provenance[(document.body as { id?: string }).id!];
    expect(rootProvenance?.producedBy).toEqual({
      kind: "adapter",
      name: "@markforge/adapters-ocr",
      version: "0.1.0",
    });
  });

  it("distinguishes an OCR engine from a vision model in provenance", async () => {
    const { document } = await documentFromPages(
      [page(1)],
      stub({
        1: { confidence: 0.7, engine: OCR_ENGINE, blocks: [{ kind: "paragraph", text: "Text." }] },
      }),
    );
    // The `ocr` Producer variant, not `model`: "which kind of reader produced this" is a
    // question the document should answer on its own (SPEC §2.5).
    const paragraph = selectType(document.body, "paragraph")[0] as { id?: string };
    expect(document.provenance[paragraph.id!]?.producedBy).toEqual({
      kind: "ocr",
      engine: "tesseract.js",
      version: "6.x",
    });
  });

  it("reports a confident page as info and a doubtful one as a loss", async () => {
    const confident = await documentFromPages(
      [page(1)],
      stub({ 1: { confidence: 0.95, engine: MODEL_ENGINE, blocks: [{ kind: "paragraph", text: "a" }] } }),
    );
    expect(confident.diagnostics.lossy()).toHaveLength(0);
    expect(confident.diagnostics.all().some((d) => d.code === "MF-OCR-0001")).toBe(true);

    const doubtful = await documentFromPages(
      [page(1)],
      stub({
        1: {
          confidence: DEFAULT_LOW_CONFIDENCE - 0.01,
          engine: MODEL_ENGINE,
          blocks: [{ kind: "paragraph", text: "a" }],
        },
      }),
    );
    // Lossy, so `--strict` fails: text nobody is sure of is potential loss.
    expect(doubtful.diagnostics.lossy().some((d) => d.code === "MF-OCR-0002")).toBe(true);
  });

  // A blank page and a failed transcription look identical from here, so this reports the
  // loss and lets a human decide rather than quietly skipping the page.
  it("reports a page that transcribed to nothing as a loss", async () => {
    const { document, diagnostics } = await documentFromPages([page(1), page(2)], stub({
      1: { confidence: 0.9, engine: MODEL_ENGINE, blocks: [{ kind: "paragraph", text: "Page one." }] },
      2: { confidence: 0, engine: MODEL_ENGINE, blocks: [] },
    }));
    const empty = diagnostics.lossy().filter((d) => d.code === "MF-OCR-0003");
    expect(empty).toHaveLength(1);
    expect(empty[0]?.locator).toEqual({ kind: "page", pageNumber: 2 });
    expect(textContent(document.body)).toBe("Page one.");
  });

  it("keeps pages in order and attributes each node to its own page", async () => {
    const { document } = await documentFromPages([page(1), page(2)], stub({
      1: { confidence: 0.9, engine: MODEL_ENGINE, blocks: [{ kind: "paragraph", text: "First page." }] },
      2: { confidence: 0.5, engine: OCR_ENGINE, blocks: [{ kind: "paragraph", text: "Second page." }] },
    }));
    const text = textContent(document.body);
    expect(text.indexOf("First page")).toBeLessThan(text.indexOf("Second page"));
    const paragraphIds = selectType(document.body, "paragraph").map((n) => (n as { id?: string }).id!);
    const pages = paragraphIds.map((id) => document.provenance[id]?.locator?.pageNumber);
    expect(new Set(pages)).toEqual(new Set([1, 2]));
    // Per-page confidence, not a document-wide average: page 2 was read less certainly and
    // averaging would hide which half to distrust.
    const confidences = new Set(paragraphIds.map((id) => document.provenance[id]?.confidence));
    expect(confidences).toEqual(new Set([0.9, 0.5]));
  });

  it("is deterministic for the same recogniser output", async () => {
    const answers = {
      1: { confidence: 0.9, engine: MODEL_ENGINE, blocks: [{ kind: "heading" as const, level: 2, text: "H" }] },
    };
    const a = await documentFromPages([page(1)], stub(answers), { path: "x.pdf" });
    const b = await documentFromPages([page(1)], stub(answers), { path: "x.pdf" });
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
  });
});

describe("the tesseract recogniser", () => {
  /**
   * The offline promise, enforced rather than documented. tesseract.js downloads its
   * language model from a CDN by default; ADR-0009 says a network call is never a
   * default, so this refuses to be constructed without either a local path or explicit
   * consent.
   */
  it("refuses to be built without local language data or explicit consent", () => {
    expect(() => createTesseractRecognizer()).toThrow(/langPath/);
    expect(() => createTesseractRecognizer()).toThrow(/opt-in and explicit/);
  });

  it("accepts a local language path", () => {
    expect(() => createTesseractRecognizer({ langPath: "./tessdata" })).not.toThrow();
  });

  it("accepts explicit consent to download", () => {
    expect(() => createTesseractRecognizer({ allowDownload: true })).not.toThrow();
  });
});

/**
 * The real engine, on the real corpus — the half the stub tests above cannot cover.
 *
 * Skipped unless `node scripts/fetch-ocr-assets.mjs` has put `eng.traineddata` in
 * `fixtures/local/tessdata`. That data is 4 MB of third-party model weights and
 * `docs/CORPUS.md` §4 keeps it out of git, so these are opt-in rather than absent from CI
 * by accident — the skip message says how to turn them on.
 *
 * Worth having despite that cost. `docs/STATUS.md` carried "tesseract implemented but never
 * measured" for a long time, and the first time it was actually run it failed
 * immediately: tesseract.js looks for `<lang>.traineddata.gz` while every tessdata
 * repository — including the one our own error message points at — publishes the file
 * uncompressed. A wrapper whose documentation contradicted its behaviour, found in the one
 * minute it took to execute rather than read it.
 */
const TESSDATA = join(REPO, "fixtures/local/tessdata");
const describeIfTessdata = existsSync(join(TESSDATA, "eng.traineddata"))
  ? describe
  : describe.skip;

describeIfTessdata("the tesseract recogniser, against real language data", () => {
  const scanPage = async (): Promise<PageImage> => {
    const { readPdf } = await import("@markforge/adapters-pdf");
    const bytes = new Uint8Array(readFileSync(join(REPO, "fixtures/pdf/scanned-150dpi.pdf")));
    const read = await readPdf(bytes);
    if (read.kind !== "scan") throw new Error("fixture is no longer detected as a scan");
    return read.pages[0]!;
  };

  it("runs offline from a local langPath and transcribes the page", async () => {
    const recognize = createTesseractRecognizer({ langPath: TESSDATA });
    try {
      const result = await recognize(await scanPage());
      expect(result.engine).toMatchObject({ kind: "ocr", engine: "tesseract.js" });
      expect(result.confidence).toBeGreaterThan(0.5);
      const text = result.blocks.map((b) => b.text).join(" ");
      expect(text).toContain("Facilities Inspection Report");
      expect(text).toContain("plant room");
    } finally {
      await recognize.close?.();
    }
  }, 120_000);

  // The regression guard for the bug these tests were written to catch.
  it("reads uncompressed .traineddata, which is what tessdata repositories publish", async () => {
    const recognize = createTesseractRecognizer({ langPath: TESSDATA });
    try {
      await expect(recognize(await scanPage())).resolves.toBeDefined();
    } finally {
      await recognize.close?.();
    }
  }, 120_000);

  // SPEC §3.3 ranks the two recognisers rather than treating them as interchangeable, and
  // this is the half that can be checked without a network: tesseract returns text and a
  // confidence, never a heading, so structure has to come from somewhere else.
  it("recovers text but not structure, which is why the vision path exists", async () => {
    const recognize = createTesseractRecognizer({ langPath: TESSDATA });
    try {
      const result = await recognize(await scanPage());
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks.some((b) => b.kind === "heading")).toBe(false);
    } finally {
      await recognize.close?.();
    }
  }, 120_000);
});

/**
 * A genuinely scanned document, not one we rasterised ourselves.
 *
 * `docs/CORPUS.md` §2.7 asks for found scans because the synthesized ones cannot validate
 * their own realism: their glyphs are a 5x7 bitmap font, so absolute accuracy on them
 * predicts nothing about a real page. This is a 1973 NASA technical report — real typeface,
 * real scanner noise, public domain.
 *
 * It carries an archive-added OCR text layer, so it exercises the *text* path rather than
 * the scan path. That is the finding rather than a mis-selection: publishers OCR their scans
 * before releasing them, which makes a text-layer-free public-domain scan genuinely rare and
 * makes "scanned page plus somebody else's OCR" the common real input. See CORPUS.md §2.7.
 */
const FOUND_SCAN = join(REPO, "fixtures/local/found-scans/nasa-19730010146.pdf");
const describeIfFoundScan = existsSync(FOUND_SCAN) ? describe : describe.skip;

describeIfFoundScan("a found scan with an archive-added OCR layer", () => {
  it("reads it as text, and does not mistake it for an unreadable scan", async () => {
    const { readPdf } = await import("@markforge/adapters-pdf");
    const read = await readPdf(new Uint8Array(readFileSync(FOUND_SCAN)), { maxPages: 8 });
    expect(read.kind).toBe("text");
    if (read.kind !== "text") return;
    expect(read.scannedPages).toHaveLength(0);
    expect(textContent(read.document.body)).toContain("RADIATIVE COOLER");
  }, 120_000);

  // The §7h payoff on input nobody tuned it against. A constant would report one value
  // here no matter what the page looked like.
  it("assigns a range of confidences, not one value, on a real document", async () => {
    const { readPdf } = await import("@markforge/adapters-pdf");
    const read = await readPdf(new Uint8Array(readFileSync(FOUND_SCAN)), { maxPages: 8 });
    if (read.kind !== "text") throw new Error("expected a text result");
    const distinct = new Set(Object.values(read.document.provenance).map((p) => p.confidence));
    expect(distinct.size).toBeGreaterThan(2);
    for (const c of distinct) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
