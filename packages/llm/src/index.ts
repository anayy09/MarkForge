/**
 * @markforge/llm — the optional enrichment layer (SPEC §6, ADR-0009).
 *
 * Four rules govern everything in this package, and they are the reason it is a
 * separate package at all:
 *
 *   1. **Nothing here runs unless it is switched on.** `llm.enabled` defaults to false
 *      and `--no-llm` is the default mode (ADR-0009). No import of this package
 *      causes a network call.
 *   2. **No adapter and no renderer may depend on it**, enforced by
 *      `scripts/check-docs.mjs` rather than by policy (ADR-0009). Structure inference
 *      does not depend on it either: `@markforge/infer` takes an injected tie-breaker,
 *      so the deterministic package stays deterministic by construction.
 *   3. **Every answer is schema-validated**, and every LLM-influenced node carries
 *      `producedBy: {kind: "model", model, promptVersion}` so "did a model touch this
 *      document" is a machine-checkable question.
 *   4. **Credentials come from the environment only**, by variable name, and the value
 *      never reaches config, a cache entry, a log line, or an error message.
 *
 * Node-only by design (ADR-0015): the cache and the prompt files are filesystem
 * things. In a browser build the LLM features are unavailable, which is the documented
 * degradation — never silently-different output.
 */
export { ChatClient, LlmTransportError } from "./client.js";
export type { ChatMessage, ChatRequest, ChatResponse, ContentPart, TokenUsage, Transport } from "./client.js";

export {
  FileCacheStore,
  MemoryCacheStore,
  CacheMissError,
  cacheKey,
  previewOf,
} from "./cache.js";
export type { CacheEntry, CacheKeyParts, CacheMode, CacheStore } from "./cache.js";

export {
  probeCapabilities,
  loadCapabilities,
  saveCapabilities,
  conservativeCapabilities,
  CAPABILITIES_PATH,
  CAPABILITIES_MAX_AGE_MS,
} from "./capabilities.js";
export type { LlmCapabilities } from "./capabilities.js";

export { LlmCallFailed, callStructured } from "./structured.js";
export type {
  FailureReason,
  Role,
  StructuredRequest,
  StructuredResult,
  StructuredDeps,
} from "./structured.js";

export {
  LlmSession,
  resolveApiKey,
  digestOf,
  DEFAULT_MAX_REPAIRS,
  DEFAULT_TASK_ROLES,
  DEFAULT_BUDGET_TOKENS,
} from "./session.js";
export type { LlmRunReport, SessionOptions } from "./session.js";

export { loadPrompt, fill } from "./prompts.js";
export type { LoadedPrompt } from "./prompts.js";

export { headingTiebreaker, visionRecognizer } from "./assist.js";
export type { AssistOptions } from "./assist.js";

export { breakHeadingTie, judgeUnitEquivalence, transcribePage } from "./tasks.js";
export type {
  UnitEquivalenceInput,
  UnitEquivalenceResult,
  HeadingTiebreakInput,
  HeadingTiebreakResult,
  ModelProducer,
  PageTranscriptionInput,
  PageTranscriptionResult,
  TiebreakCandidate,
  TranscribedBlock,
  TranscribedBlockKind,
} from "./tasks.js";

/**
 * The role → model defaults of SPEC §6.1.
 *
 * Three strings, which is the entire model registry ADR-0009 descoped. They live here
 * as well as in the config schema because a caller constructing a session directly
 * should not have to restate them, and because a single place to change a model name is
 * the whole point of not having a registry.
 */
export const DEFAULT_MODELS = {
  fast: "gpt-oss-120b",
  strong: "nemotron-3-super-120b-a12b",
  vision: "gemma-4-31b-it",
  // SPEC §10.4 merges near-duplicate context units. Lexical similarity cannot do
  // that job: the same constraint stated in a PRD and in an ADR shares almost no
  // tokens, and only an embedding puts them near each other. 8K context is ample —
  // context units are short by construction — which makes this the cheaper of the two
  // embedding models in the catalog at the volume deduplication implies.
  embed: "nomic-embed-text-v1.5",
} as const;

export const DEFAULT_BASE_URL = "https://api.ai.it.ufl.edu/v1";
export const DEFAULT_API_KEY_ENV = "MODEL_API_KEY";
export const DEFAULT_CACHE_DIR = ".markforge/llm-cache";
