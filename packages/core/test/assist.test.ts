/**
 * Tests for the optional assistance boundary in `@markforge/core`.
 *
 * The invariants here are the ones that make the LLM layer *optional* rather than
 * load-bearing, so they are worth more than the LLM layer's own tests:
 *
 *   - Without assistance, output is exactly what Phase 2 produced.
 *   - With assistance that fails, output is exactly what Phase 2 produced.
 *   - A tie-breaker cannot introduce a structure that was not among the candidates.
 *   - A scan without a recogniser refuses rather than returning an empty document.
 */
import { describe, it, expect } from "vitest";
import { convert, convert, type Assist } from "../src/index.js";
import type { PageImage as OcrPageImage, Recognizer } from "@markforge/adapters-ocr";
import type { PageImage as PdfPageImage } from "@markforge/adapters-pdf";
import { inferAll, resolveAmbiguities, type HeadingTiebreaker } from "@markforge/infer";
import { parseDocx } from "@markforge/adapters-docx";
import { selectType, textContent } from "@markforge/ir";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `new URL(...).pathname`: on Windows the latter yields "/C:/Users/..."
// with a leading slash, `existsSync` says false, and every fixture-backed test in this file
// skips silently. A suite that skips itself is worse than one that fails.
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const AMBIGUOUS = join(REPO, "fixtures/docx/messy-ambiguous-headings.docx");
const SCAN = join(REPO, "fixtures/pdf/scanned-150dpi.pdf");

/**
 * The type-drift check promised in `adapters-ocr`'s and `adapters-pdf`'s comments.
 *
 * `PageImage` is declared in both packages because SPEC §11 forbids one adapter from
 * depending on another, and structural typing is what makes the duplication safe. That only
 * holds while the two shapes agree, so the agreement is asserted here — in the one package
 * allowed to import both — and a divergence becomes a compile error rather than a cast that
 * happens to work.
 */
it("keeps the two PageImage declarations mutually assignable", () => {
  const fromPdf: PdfPageImage = {
    pageNumber: 1,
    bytes: new Uint8Array([1]),
    mediaType: "image/png",
    width: 10,
    height: 20,
  };
  const toOcr: OcrPageImage = fromPdf;
  const backAgain: PdfPageImage = toOcr;
  expect(backAgain).toBe(fromPdf);
});

const describeIfFixture = existsSync(AMBIGUOUS) ? describe : describe.skip;

describeIfFixture("heading tie-breaking", () => {
  const bytes = () => new Uint8Array(readFileSync(AMBIGUOUS));

  it("has something to decide: the fixture is genuinely ambiguous", () => {
    const doc = parseDocx(bytes()).document;
    const result = inferAll(doc);
    // If this ever reaches zero, the Phase 3 ambiguous subset is measuring nothing and
    // every tie-break test below passes vacuously.
    expect(result.ambiguous.length).toBeGreaterThan(0);
    for (const decision of result.ambiguous) {
      expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
      expect(decision.margin).toBeLessThan(0.15);
    }
  });

  it("leaves the document untouched when the tie-breaker declines to answer", async () => {
    const plain = await convert(bytes(), { from: "docx", to: "md" });
    const declined = await convert(bytes(), {
      from: "docx",
      to: "md",
      assist: { headingTiebreak: async () => undefined },
    });
    expect(Buffer.from(declined.bytes).toString()).toBe(Buffer.from(plain.bytes).toString());
  });

  it("leaves the document untouched when the tie-breaker throws", async () => {
    const plain = await convert(bytes(), { from: "docx", to: "md" });
    const failed = await convert(bytes(), {
      from: "docx",
      to: "md",
      assist: {
        headingTiebreak: async () => {
          throw new Error("endpoint down");
        },
      },
    });
    // The whole point of "assistive": a failed model call is a document that is exactly as
    // good as the deterministic one, not a failed conversion.
    expect(Buffer.from(failed.bytes).toString()).toBe(Buffer.from(plain.bytes).toString());
  });

  it("applies an answer from the candidate set, and records the model in provenance", async () => {
    const chooseParagraph: HeadingTiebreaker = async () => ({
      chosen: "paragraph",
      decidedBy: "test model",
      producedBy: { kind: "model", model: "test-model", promptVersion: "v2" },
    });
    const doc = parseDocx(bytes()).document;
    const inferred = inferAll(doc);
    const before = selectType(doc.body, "heading").length;
    const resolved = await resolveAmbiguities(doc, inferred.ambiguous, chooseParagraph);

    expect(resolved.applied).toBe(inferred.ambiguous.length);
    expect(resolved.changed).toBe(inferred.ambiguous.length);
    expect(selectType(doc.body, "heading").length).toBe(before - inferred.ambiguous.length);
    // "Did a model influence this node?" has to be answerable from the document alone.
    const touched = inferred.ambiguous.map((d) => doc.provenance[d.nodeId]?.producedBy);
    for (const producer of touched) {
      expect(producer).toEqual({ kind: "model", model: "test-model", promptVersion: "v2" });
    }
    expect(resolved.diagnostics.all().some((d) => d.code === "MF-LLM-0002")).toBe(true);
  });

  /**
   * Demotion has to be lossless. Promotion unwraps a mark that covered the whole
   * paragraph — the bold *was* the evidence — so demoting without putting it back would
   * silently drop formatting the author wrote, which is worse than a wrong heading level.
   */
  it("restores the emphasis that promotion consumed when demoting back to a paragraph", async () => {
    const doc = parseDocx(bytes()).document;
    const inferred = inferAll(doc);
    expect(selectType(doc.body, "strong")).toHaveLength(0); // consumed by promotion
    await resolveAmbiguities(doc, inferred.ambiguous, async () => ({
      chosen: "paragraph",
      decidedBy: "test model",
      producedBy: { kind: "model", model: "test-model", promptVersion: "v2" },
    }));
    expect(selectType(doc.body, "strong").length).toBe(inferred.ambiguous.length);
  });

  it("refuses an answer that is not among the candidates", async () => {
    const doc = parseDocx(bytes()).document;
    const inferred = inferAll(doc);
    const headingsBefore = selectType(doc.body, "heading").length;
    const resolved = await resolveAmbiguities(doc, inferred.ambiguous, async () => ({
      chosen: "heading1",
      decidedBy: "a model inventing a level",
      producedBy: { kind: "model", model: "test-model", promptVersion: "v2" },
    }));
    expect(resolved.applied).toBe(0);
    expect(selectType(doc.body, "heading").length).toBe(headingsBefore);
    expect(resolved.diagnostics.lossy().some((d) => d.code === "MF-LLM-0001")).toBe(true);
  });

  it("says so in the diagnostics when ambiguity was left to the rules", async () => {
    const plain = await convert(bytes(), { from: "docx", to: "md" });
    expect(plain.diagnostics.some((d) => d.code === "MF-LLM-0004")).toBe(true);
  });

  // Was: "refuses assistance synchronously rather than ignoring it", guarding the old
  // sync `convert` against being handed an async-only option. OPEN_QUESTIONS §7j removed
  // the sync half, so the refusal has nothing left to refuse — assistance is simply
  // awaited. What still matters is that a supplied tie-breaker is actually consulted
  // rather than quietly dropped, which is the failure the old test really guarded.
  it("consults a supplied tie-breaker rather than ignoring it", async () => {
    let consulted = 0;
    await convert(bytes(), {
      from: "docx",
      to: "md",
      assist: {
        headingTiebreak: async () => {
          consulted += 1;
          return undefined;
        },
      },
    });
    expect(consulted).toBeGreaterThan(0);
  });
});

const describeIfScan = existsSync(SCAN) ? describe : describe.skip;

describeIfScan("the scanned-PDF route", () => {
  const bytes = () => new Uint8Array(readFileSync(SCAN));

  const stubRecognizer: Recognizer = async (page) => ({
    blocks: [
      { kind: "heading", level: 1, text: `Page ${page.pageNumber} heading` },
      { kind: "paragraph", text: "Recognised body text." },
    ],
    confidence: 0.9,
    engine: { kind: "ocr", engine: "stub", version: "0" },
  });

  /**
   * The PDF reader, injected — `@markforge/core` no longer imports `@markforge/adapters-pdf`.
   *
   * That import was what stopped `core` and `@markforge/browser` bundling for a browser
   * under every standard esbuild configuration, so the reader became a platform capability
   * the host supplies, exactly as ADR-0017 already does for the OCR recogniser. In the Node
   * test environment it is always available; in a browser build it is absent and `parse`
   * refuses PDFs by name.
   */
  const readPdf: NonNullable<Assist["readPdf"]> = async (b, o) =>
    (await import("@markforge/adapters-pdf")).readPdf(b, o);

  it("refuses a scan with no recogniser rather than producing an empty document", async () => {
    await expect(convert(bytes(), { from: "pdf", to: "md", assist: { readPdf } })).rejects.toThrow(/no text layer/);
    await expect(convert(bytes(), { from: "pdf", to: "md", assist: { readPdf } })).rejects.toThrow(/--ocr|--llm/);
  });

  it("routes a scan to the recogniser and hands it a real page image", async () => {
    const seen: number[] = [];
    const assist: Assist = {
      recognize: async (page) => {
        seen.push(page.bytes.byteLength);
        // A PNG, not a raw buffer: both recognisers want an encoded image, and the LLM
        // cache keys on these bytes.
        expect(Array.from(page.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(page.width).toBeGreaterThan(1000);
        return stubRecognizer(page);
      },
    };
    const result = await convert(bytes(), { from: "pdf", to: "md", assist: { ...assist, readPdf } });
    expect(seen).toHaveLength(1);
    expect(Buffer.from(result.bytes).toString()).toContain("Page 1 heading");
    // Both bags survive: the PDF adapter's says *why* OCR happened, the OCR adapter's says
    // what it produced.
    expect(result.diagnostics.some((d) => d.code === "MF-PDF-0001")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "MF-OCR-0001")).toBe(true);
  });

  it("produces byte-identical output for the same recogniser answers", async () => {
    const assist: Assist = { recognize: stubRecognizer, readPdf };
    const a = await convert(bytes(), { from: "pdf", to: "md", assist, path: "x.pdf" });
    const b = await convert(bytes(), { from: "pdf", to: "md", assist, path: "x.pdf" });
    expect(Buffer.from(a.bytes).toString()).toBe(Buffer.from(b.bytes).toString());
  });

  it("keeps a recogniser's confidence out of the text and in the provenance", async () => {
    const result = await convert(bytes(), {
      from: "pdf",
      to: "md",
      assist: { recognize: stubRecognizer, readPdf },
    });
    expect(textContent(result.document.body)).not.toContain("0.9");
    // A transcribed node, not the root: the root is the adapter's own container and carries
    // the adapter as its producer at confidence 1, which is the honest answer for a node
    // nobody guessed at.
    const paragraph = selectType(result.document.body, "paragraph")[0] as { id?: string };
    expect(result.document.provenance[paragraph.id!]?.confidence).toBe(0.9);
  });
});
