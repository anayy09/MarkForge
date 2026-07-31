/**
 * Adapters from a session to the two injection points the deterministic path exposes.
 *
 * `@markforge/infer` takes a `HeadingTiebreaker` and `@markforge/adapters-ocr` takes a
 * `Recognizer`, both as plain function types neither package imports from here — that is
 * how ADR-0009's "no adapter or renderer depends on the LLM" survives having an LLM-backed
 * OCR engine. These two functions are the adapters, and they live on this side of the
 * boundary because this is the side that is allowed to know about both.
 *
 * They also decide what a *failure* means, which is the interesting part: both convert an
 * exception into "no answer". A tie-break that fails leaves the deterministic heading
 * level; a transcription that fails leaves the page with a diagnostic. Neither aborts a
 * conversion, because the LLM is assistive and an assistive component that can fail a run
 * is not assistive.
 */
import { LlmCallFailed } from "./structured.js";
import type { LlmSession } from "./session.js";
import { breakHeadingTie, transcribePage } from "./tasks.js";
import { CacheMissError } from "./cache.js";

/** The shape `@markforge/infer` asks for, restated so this module imports nothing from it. */
interface AmbiguousDecisionLike {
  nodeId: string;
  text: string;
  candidates: { interpretation: string; score: number; reasons: string[] }[];
  precedingHeadings: number[];
  followingText: string;
}

interface TiebreakAnswerLike {
  chosen: string;
  decidedBy: string;
  producedBy: { kind: "model"; model: string; promptVersion: string };
}

export interface AssistOptions {
  /** Called with every failure, so the caller can turn it into a diagnostic. */
  onFailure?: (context: { task: string; nodeOrPage: string; reason: string; message: string }) => void;
}

/**
 * A heading tie-breaker backed by the `fast` model.
 *
 * Returns `undefined` on any failure — including a cache miss in offline mode, which is
 * the normal case in CI for a document whose ambiguity was never recorded.
 */
export function headingTiebreaker(session: LlmSession, options: AssistOptions = {}) {
  return async (decision: AmbiguousDecisionLike): Promise<TiebreakAnswerLike | undefined> => {
    try {
      const result = await breakHeadingTie(session, {
        nodeId: decision.nodeId,
        text: decision.text,
        candidates: decision.candidates,
        precedingHeadings: decision.precedingHeadings,
        followingText: decision.followingText,
      });
      return {
        chosen: result.chosen,
        decidedBy:
          `model ${result.producedBy.model} (prompt ${result.producedBy.promptVersion}` +
          `${result.source === "cache" ? ", cached" : ""}${result.attempts > 1 ? `, ${result.attempts} attempts` : ""}): ` +
          result.rationale,
        producedBy: result.producedBy,
      };
    } catch (error) {
      options.onFailure?.({
        task: "heading-tiebreak",
        nodeOrPage: decision.nodeId,
        reason: reasonOf(error),
        message: (error as Error).message,
      });
      return undefined;
    }
  };
}

/** One page, as `@markforge/adapters-ocr` describes it. */
interface PageImageLike {
  pageNumber: number;
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
}

interface RecognizedPageLike {
  blocks: { kind: "heading" | "paragraph" | "listItem" | "caption"; level?: number; text: string }[];
  confidence: number;
  engine: { kind: "model"; model: string; promptVersion: string };
}

/**
 * A page recogniser backed by the `vision` model.
 *
 * Unlike the tie-breaker this one cannot fall back to a deterministic answer, because on a
 * page with no text layer there is no deterministic answer — so a failure returns an empty
 * page at confidence 0 and lets `adapters-ocr` report it as a loss. Throwing instead would
 * abandon the pages that did transcribe.
 */
export function visionRecognizer(session: LlmSession, options: AssistOptions = {}) {
  return async (page: PageImageLike): Promise<RecognizedPageLike> => {
    try {
      const result = await transcribePage(session, {
        pageNumber: page.pageNumber,
        image: page.bytes,
        mediaType: page.mediaType,
      });
      return { blocks: result.blocks, confidence: result.confidence, engine: result.producedBy };
    } catch (error) {
      options.onFailure?.({
        task: "page-transcription",
        nodeOrPage: `page ${page.pageNumber}`,
        reason: reasonOf(error),
        message: (error as Error).message,
      });
      return {
        blocks: [],
        confidence: 0,
        engine: {
          kind: "model",
          model: session.models.vision,
          promptVersion: "v1",
        },
      };
    }
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof LlmCallFailed) return error.reason;
  if (error instanceof CacheMissError) return "cacheMiss";
  return "error";
}
