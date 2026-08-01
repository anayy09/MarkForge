/**
 * The model-backed tasks, one function each.
 *
 * SPEC §6.2 maps nine permitted tasks to three roles. Three are built: heading tie-breaking
 * (Phase 3), scanned-page transcription (Phase 3), and near-duplicate adjudication (Phase 4,
 * ADR-0020).
 *
 * ## Two tasks are deliberately unbuilt, and the blocker is evidence, not effort
 *
 * Read this before writing either prompt file. Both are held because nothing could currently
 * tell a good answer from a plausible one, and a task whose output cannot fail is worse than
 * an absent one — it produces a number that gets quoted.
 *
 * **`document-role-classification`.** Unblocked when the rule-based classifier has been
 * measured on documents it was not written against. That measurement now exists and the
 * answer is bad: `fixtures/agentify/classification/` scores **1 of 5**, against 10/10
 * in-distribution. So a comparison is finally available — but the holdout is five documents,
 * which is enough to show the rules are weak and not enough to show a model is better.
 * *Condition: a holdout large enough that a difference between rules and model is
 * distinguishable from noise.* Until then the rules stand and report `unknown` when they have
 * no opinion, which is at least honest.
 *
 * **`context-unit-extraction`.** The blocker is the key, not the prompt. `expected-units.json`
 * was authored by the same person who wrote the extractor; grading a *second* extractor
 * against it measures agreement with the first one's idea of a unit. *Condition: a unit key
 * produced by blind annotation — someone who has seen neither extractor's output, with
 * disagreements adjudicated.* That is manual and is the more expensive of the two to unblock,
 * so start it early if SPEC §10.3's prose categories are on the critical path.
 *
 * Recorded in OPEN_QUESTIONS §7o so this is not relitigated from scratch.
 *
 * ## The shape all three share
 *
 * **The schema is the guarantee.** The tie-break's `chosen` is an enum of that node's own
 * candidate set; the adjudicator answers `"A"` or `"B"` and the code maps it back to verbatim
 * text. Neither can invent. Transcription is the one task that produces content rather than
 * choosing, and it is permitted only because the deterministic alternative on a page with no
 * text layer is nothing at all.
 *
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
// Near-duplicate adjudication (role `strong`)
// --------------------------------------------------------------------------------

export interface UnitEquivalenceInput {
  textA: string;
  textB: string;
  pathA: string;
  pathB: string;
}

export interface UnitEquivalenceResult {
  sameFact: boolean;
  survivingText: string;
  rationale: string;
  producedBy: ModelProducer;
  source: "cache" | "live";
  attempts: number;
}

const EQUIVALENCE_TASK = "context-unit-summarization";
const EQUIVALENCE_VERSION = "v1";

/**
 * Decides whether two context units state one fact — SPEC §10.4's merge, after measurement
 * showed a cosine threshold could not make the call.
 *
 * Permitted by brief §7.1 as "context-unit … summarization": the question being answered is
 * which single unit two units collapse into. It is the *second* stage; the embedding pass
 * still runs first and decides which pairs are worth asking about, so this is bounded by a
 * shortlist rather than quadratic in the corpus.
 *
 * Like the heading tie-break, the guarantee is the schema, not the prompt: `survivingText`
 * is an enum of the two inputs, so a merged unit's text is always one of the two verbatim
 * and never something the model composed.
 */
export async function judgeUnitEquivalence(
  session: LlmSession,
  input: UnitEquivalenceInput,
): Promise<UnitEquivalenceResult> {
  const prompt = loadPrompt(EQUIVALENCE_TASK, EQUIVALENCE_VERSION);

  // `surviving` is "A" or "B", not the sentence itself.
  //
  // It was an enum of the two full texts, which is the obvious way to make the schema
  // guarantee that a merged unit's wording comes from a source. Measured, it was also a
  // pathological guided-decoding constraint: the grammar required the model to reproduce a
  // ~150-character string exactly, and when its preferred continuation diverged the
  // constrained sampler had nowhere to go and emitted whitespace until the ceiling. 41 of
  // 50 adjudications on the clean corpus died that way at a 3000-token budget, having spent
  // every token. A two-letter enum gives the same guarantee — the code below maps the letter
  // back to verbatim text, so the model still cannot compose a third sentence — with a
  // grammar the model can actually satisfy.
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["sameFact", "surviving", "rationale"],
    properties: {
      sameFact: { type: "boolean" },
      surviving: { type: "string", enum: ["A", "B"] },
      rationale: { type: "string", maxLength: 300 },
    },
  };

  const user = fill(prompt.user, {
    textA: input.textA,
    textB: input.textB,
    pathA: input.pathA,
    pathB: input.pathB,
  });

  // Ordered, and deliberately not sorted. The prompt tells the model to fall back to
  // statement A when it is unsure, so A and B are not interchangeable and a canonicalised
  // key would let one pair's answer be served for the other orientation.
  const inputDigest = digestOf({ a: input.textA, b: input.textB });

  const result = await session.structured<{
    sameFact: boolean;
    surviving: "A" | "B";
    rationale: string;
  }>({
    task: EQUIVALENCE_TASK,
    role: session.roleFor(EQUIVALENCE_TASK),
    prompt,
    user,
    schema,
    inputDigest,
    inputPreview: `${previewOf(input.textA)} || ${previewOf(input.textB)}`,
    // 3000, not the 500 this started with. `nemotron-3-super-120b-a12b` is a reasoning
    // model and spends most of its budget before writing any JSON: at 500 tokens, 50 of 65
    // adjudications on the clean corpus came back `finish_reason: "length"` with a wall of
    // newlines. They failed safe — an unanswered pair stays unmerged — but they were 50
    // wasted calls that looked like model incompetence rather than a ceiling. STATUS.md
    // records the identical mistake from Phase 3's capability probe, which is why this
    // comment names the number.
    maxTokens: 3000,
  });

  if (result.value.surviving !== "A" && result.value.surviving !== "B") {
    throw new Error(
      `llm: unit-equivalence returned surviving="${String(result.value.surviving)}", which is ` +
        `neither "A" nor "B". Refusing it — a merged unit must be one of the two verbatim ` +
        `(SPEC §10.6).`,
    );
  }

  return {
    sameFact: result.value.sameFact,
    // Mapped here, from the letter. This is the line that keeps §10.6's guarantee: the
    // merged unit's text is always one of the two inputs, byte for byte, and the model never
    // had the opportunity to write a third.
    survivingText: result.value.surviving === "B" ? input.textB : input.textA,
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
