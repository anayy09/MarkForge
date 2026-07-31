/**
 * The two Phase 3 tasks, one function each.
 *
 * SPEC §6.2 maps nine permitted tasks to three roles. Two of them are what Phase 3's
 * done-criterion turns on — heading tie-breaking on the ambiguous subset, and
 * scanned-page transcription on the scanned subset — and those two are built here. The
 * other seven (classification, context-unit extraction and summarisation, conflict
 * analysis, glossary extraction, alt text, ambiguous table geometry) are Phase 4's
 * agentify pipeline and its PDF table path. Building them now would be seven prompt
 * files with no caller, which brief §13 forbids and which nothing would keep honest.
 *
 * Both functions share a shape worth naming: **the schema is the guarantee.** The
 * tie-break's `chosen` field is an enum of that node's own candidate set, so choosing
 * off-menu is rejected by the endpoint's grammar or by ajv rather than discouraged by
 * the prompt. Transcription is the one task that produces content rather than choosing
 * among candidates, and it is permitted only because the deterministic alternative on a
 * page with no text layer is nothing at all.
 */
import type { LlmSession } from "./session.js";
import { digestOf } from "./session.js";
import { fill, loadPrompt } from "./prompts.js";
import { previewOf } from "./cache.js";
import type { ContentPart } from "./client.js";

/** Provenance for an LLM-influenced node: the `Producer` variant of SPEC §2.5. */
export interface ModelProducer {
  kind: "model";
  model: string;
  promptVersion: string;
}

// --------------------------------------------------------------------------------
// Heading tie-breaking (role `fast`)
// --------------------------------------------------------------------------------

export interface TiebreakCandidate {
  interpretation: string;
  score: number;
  reasons: string[];
}

export interface HeadingTiebreakInput {
  nodeId: string;
  text: string;
  candidates: TiebreakCandidate[];
  /** Resolved levels of the headings above this node, nearest last. */
  precedingHeadings: number[];
  /** Text of the following block, which is what a heading introduces. */
  followingText: string;
}

export interface HeadingTiebreakResult {
  chosen: string;
  rationale: string;
  producedBy: ModelProducer;
  source: "cache" | "live";
  attempts: number;
}

const HEADING_TIEBREAK_TASK = "heading-tiebreak";
const HEADING_TIEBREAK_VERSION = "v2";

export async function breakHeadingTie(
  session: LlmSession,
  input: HeadingTiebreakInput,
): Promise<HeadingTiebreakResult> {
  if (input.candidates.length < 2) {
    // Not a defensive check: a one-candidate enum would let the model "choose" the
    // answer the deterministic path already had, spend a call, and look like a
    // decision. If there is nothing to decide, there is nothing to ask.
    throw new Error(
      `llm: heading tie-break needs at least two candidates, got ${input.candidates.length}`,
    );
  }

  const prompt = loadPrompt(HEADING_TIEBREAK_TASK, HEADING_TIEBREAK_VERSION);
  const interpretations = input.candidates.map((c) => c.interpretation);

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["chosen", "rationale"],
    properties: {
      // The candidate set, as an enum. This is the sentence in brief §5.3 — "it must
      // choose among the candidate set, never invent structure" — expressed as a
      // constraint rather than as an instruction.
      chosen: { type: "string", enum: interpretations },
      rationale: { type: "string", maxLength: 400 },
    },
  };

  const user = fill(prompt.user, {
    text: input.text,
    candidates: input.candidates
      .map((c) => `- ${c.interpretation} (score ${c.score.toFixed(3)}): ${c.reasons.join("; ")}`)
      .join("\n"),
    precedingHeadings:
      input.precedingHeadings.length > 0
        ? input.precedingHeadings.map((l) => `level ${l}`).join(", ")
        : "(none — this is before the first heading)",
    followingText: input.followingText.trim() === "" ? "(nothing follows)" : input.followingText,
  });

  // The node id is deliberately *not* in the digest. Ids are content-addressed but
  // carry an occurrence suffix, so including them would miss the cache for two
  // identically ambiguous paragraphs in the same document — which is exactly the case
  // a content-addressed cache exists to collapse.
  const inputDigest = digestOf({
    text: input.text,
    candidates: input.candidates,
    precedingHeadings: input.precedingHeadings,
    followingText: input.followingText,
  });

  const result = await session.structured<{ chosen: string; rationale: string }>({
    task: HEADING_TIEBREAK_TASK,
    role: session.roleFor(HEADING_TIEBREAK_TASK),
    prompt,
    user,
    schema,
    inputDigest,
    inputPreview: previewOf(input.text),
    maxTokens: 400,
  });

  // Belt and braces over the enum: a cached entry recorded before the candidate set
  // changed would parse and validate against *its* schema, not this one. Cheap to
  // check, and the failure mode it catches is a silently wrong heading level.
  if (!interpretations.includes(result.value.chosen)) {
    throw new Error(
      `llm: heading tie-break returned "${result.value.chosen}", which is not one of ` +
        `${interpretations.join(", ")}. Refusing it — the deterministic result stands.`,
    );
  }

  return {
    chosen: result.value.chosen,
    rationale: result.value.rationale,
    producedBy: { kind: "model", model: result.model, promptVersion: result.promptVersion },
    source: result.source,
    attempts: result.attempts,
  };
}

// --------------------------------------------------------------------------------
// Scanned-page transcription (role `vision`)
// --------------------------------------------------------------------------------

export type TranscribedBlockKind = "heading" | "paragraph" | "listItem" | "caption";

export interface TranscribedBlock {
  kind: TranscribedBlockKind;
  level?: number;
  text: string;
}

export interface PageTranscriptionInput {
  pageNumber: number;
  /** Image bytes. Never stored in the cache — only their digest is (cache.ts). */
  image: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
}

export interface PageTranscriptionResult {
  blocks: TranscribedBlock[];
  confidence: number;
  producedBy: ModelProducer;
  source: "cache" | "live";
  attempts: number;
}

const TRANSCRIPTION_TASK = "page-transcription";
const TRANSCRIPTION_VERSION = "v1";

const TRANSCRIPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "confidence"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: ["heading", "paragraph", "listItem", "caption"] },
          level: { type: "integer", minimum: 1, maximum: 6 },
          text: { type: "string" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

export async function transcribePage(
  session: LlmSession,
  input: PageTranscriptionInput,
): Promise<PageTranscriptionResult> {
  const prompt = loadPrompt(TRANSCRIPTION_TASK, TRANSCRIPTION_VERSION);
  const base64 = Buffer.from(input.image).toString("base64");
  const user: ContentPart[] = [
    { type: "text", text: fill(prompt.user, { pageNumber: String(input.pageNumber) }) },
    { type: "image_url", image_url: { url: `data:${input.mediaType};base64,${base64}` } },
  ];

  // The image's own digest keys the cache: the same page transcribed twice is one call,
  // and a re-rasterised fixture is correctly a different one.
  const inputDigest = digestOf({ image: base64, mediaType: input.mediaType });

  const result = await session.structured<{ blocks: TranscribedBlock[]; confidence: number }>({
    task: TRANSCRIPTION_TASK,
    role: session.roleFor(TRANSCRIPTION_TASK),
    prompt,
    user,
    schema: TRANSCRIPTION_SCHEMA,
    inputDigest,
    inputPreview: `page ${input.pageNumber}, ${input.mediaType}, ${input.image.byteLength} bytes`,
    // A dense page of prose is a few thousand tokens. Too low a ceiling truncates the
    // page and the repair loop cannot fix a wall, so this is generous and the finish
    // reason is reported when it is still hit.
    maxTokens: 4096,
  });

  return {
    blocks: result.value.blocks,
    confidence: result.value.confidence,
    producedBy: { kind: "model", model: result.model, promptVersion: result.promptVersion },
    source: result.source,
    attempts: result.attempts,
  };
}
