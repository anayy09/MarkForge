/**
 * Schema-validated structured output with a bounded repair loop (SPEC §6.3).
 *
 * The contract every task in this package goes through, in one place:
 *
 *   1. Compute the cache key. A hit returns immediately and costs nothing — no
 *      network, no tokens, no budget.
 *   2. Refuse to start a live call if the token budget is spent.
 *   3. Send the request, with `response_format` when the probe found guided decoding
 *      and without it otherwise.
 *   4. `JSON.parse` and validate against the schema with ajv. **Never** pull an answer
 *      out of prose with a regex (brief §7.3).
 *   5. On a validation failure, feed the error back and try again, at most
 *      `maxRepairs` times. On final failure, fail the call — the caller applies its
 *      deterministic fallback and emits a diagnostic.
 *
 * ADR-0009's consequence section is the reason step 4 is not optional: the strongest
 * model on this gateway is a competent open-weight model, not a frontier one, so
 * validation is the mechanism and not a safety net. Measured on this deployment,
 * guided decoding *is* available (OPEN_QUESTIONS §3), which makes step 5 rare —
 * but "rare" is a property of one deployment and the loop is the property of the code.
 */
import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import { canonicalJson, sha256Hex } from "@markforge/ir";
import type { ChatClient, ChatMessage, ContentPart, TokenUsage } from "./client.js";
import { LlmTransportError } from "./client.js";
import { CacheMissError, cacheKey, type CacheEntry, type CacheMode, type CacheStore } from "./cache.js";
import type { LoadedPrompt } from "./prompts.js";

// The same ajv interop dance as @markforge/ir's validator, and for the same reason:
// ajv is CJS whose runtime export is a class with a `.default` bolted on, and under
// NodeNext neither `import X from` nor the namespace is constructable.
interface AjvInstance {
  compile(schema: object): ValidateFunction;
}
const require = createRequire(import.meta.url);
type Ajv2020Ctor = new (opts: Record<string, unknown>) => AjvInstance;
const Ajv2020: Ajv2020Ctor = require("ajv/dist/2020.js").default ?? require("ajv/dist/2020.js");

// strict: true rejects a schema with a typo'd keyword instead of ignoring it, which
// is how a constraint silently stops constraining.
const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new Map<string, ValidateFunction>();

/**
 * Compiled validators are memoised by the schema's own digest, not by task name.
 *
 * Task name looked like the obvious key and is wrong: the heading tie-break builds a
 * *different* schema per call, whose `chosen` enum is that node's candidate set. Keying
 * on the task would have compiled the first node's candidate list and then validated
 * every later node against it — which would reject correct answers and, worse,
 * occasionally accept a level that was not on offer. The enum is the mechanism that
 * makes "never invent structure" structural rather than requested, so its validator has
 * to be the one for the schema in hand.
 */
function validatorFor(schema: object): ValidateFunction {
  const key = sha256Hex(canonicalJson(schema));
  const hit = compiled.get(key);
  if (hit) return hit;
  const fn = ajv.compile(schema);
  compiled.set(key, fn);
  return fn;
}

/**
 * The closed set of roles (SPEC §6.1).
 *
 * Closed on purpose: a role is a capability distinction the code has to know how to
 * *use* — `vision` takes image parts, `embed` calls a different endpoint shape — so
 * adding one is properly a code change. Which task uses which role is the open part,
 * and lives in `SessionOptions.taskRoles`.
 */
export type Role = "fast" | "strong" | "vision" | "embed";

export interface StructuredRequest {
  /** Task name: names the cache directory and the failure diagnostic. */
  task: string;
  role: Role;
  prompt: LoadedPrompt;
  /** The filled user message. An array carries images for the vision role. */
  user: string | ContentPart[];
  /** JSON Schema the answer must satisfy. Also sent for guided decoding. */
  schema: object;
  /**
   * Digest of the semantic input. Supplied by the caller rather than computed here
   * because only the caller knows what the input *is* — for a vision call it is the
   * page image, whose bytes never enter the cache entry.
   */
  inputDigest: string;
  inputPreview: string;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  source: "cache" | "live";
  model: string;
  promptVersion: string;
  /** 1 when the first answer validated; higher when the repair loop ran. */
  attempts: number;
  usage: TokenUsage;
  mode: "guided" | "prompted";
}

export type FailureReason = "transport" | "schema" | "budget" | "cacheMiss" | "disabled";

/**
 * A call that did not produce a valid answer.
 *
 * Every caller catches this and falls back to its deterministic result. That is the
 * whole failure story of the LLM layer: no retries, no substitute model, no partial
 * answer — a diagnostic and the answer we would have given anyway.
 */
export class LlmCallFailed extends Error {
  constructor(
    readonly task: string,
    readonly reason: FailureReason,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LlmCallFailed";
  }
}

export interface StructuredDeps {
  /** Absent in readOnly mode: an offline run has no client and needs none. */
  client?: ChatClient;
  cache: CacheStore;
  cacheMode: CacheMode;
  models: Record<Role, string>;
  guidedDecoding: boolean;
  seed?: number;
  maxRepairs: number;
  defaultMaxTokens: number;
  /** Returns the reason the budget is spent, or undefined while there is room. */
  checkBudget(): string | undefined;
  recordUsage(usage: TokenUsage): void;
}

const DEFAULT_MAX_TOKENS = 2048;

export async function callStructured<T>(
  request: StructuredRequest,
  deps: StructuredDeps,
): Promise<StructuredResult<T>> {
  const model = deps.models[request.role];
  const mode: "guided" | "prompted" = deps.guidedDecoding ? "guided" : "prompted";
  const maxTokens = request.maxTokens ?? deps.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  const validate = validatorFor(request.schema);

  const system = deps.guidedDecoding
    ? request.prompt.system
    : // Without guided decoding the schema has to be in the prompt, because nothing
      // else will keep the answer in shape. Appended rather than written into the file
      // so the same prompt file serves both modes and cannot drift between them.
      `${request.prompt.system}\n\nRespond with a single JSON object and nothing else. ` +
      `It must validate against this JSON Schema:\n\n${JSON.stringify(request.schema, null, 2)}`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: request.user },
  ];

  let lastErrors = "";
  let usageTotal: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let attempt = 1; attempt <= deps.maxRepairs + 1; attempt++) {
    const params = {
      temperature: 0,
      maxTokens,
      mode,
      attempt,
      // The prompt's content digest, not just its version: see prompts.ts.
      promptDigest: request.prompt.digest,
      ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
    };
    const key = cacheKey({
      task: request.task,
      inputDigest: request.inputDigest,
      model,
      promptVersion: request.prompt.version,
      params,
    });

    let content: string;
    let source: "cache" | "live";
    let finishReason = "cached";
    const cached = deps.cacheMode === "off" ? undefined : deps.cache.get(key);

    if (cached) {
      content = cached.response.content;
      source = "cache";
      finishReason = cached.response.finishReason;
      // A cache hit does not touch the budget. It cost nothing when it was recorded
      // and costs nothing now, and charging it would make a run's reported token
      // spend depend on cache state rather than on work done.
    } else if (deps.cacheMode === "readOnly") {
      throw new CacheMissError(request.task, key);
    } else if (!deps.client) {
      throw new LlmCallFailed(
        request.task,
        "disabled",
        `llm: task "${request.task}" needed a live call but no client is configured.`,
      );
    } else {
      const spent = deps.checkBudget();
      if (spent !== undefined) {
        throw new LlmCallFailed(request.task, "budget", spent);
      }
      let response;
      try {
        response = await deps.client.chat({
          model,
          messages,
          temperature: 0,
          maxTokens,
          ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
          ...(deps.guidedDecoding
            ? { jsonSchema: { name: schemaName(request.task), schema: request.schema } }
            : {}),
        });
      } catch (error) {
        const transport = error as LlmTransportError;
        throw new LlmCallFailed(
          request.task,
          "transport",
          `llm: task "${request.task}" failed: ${transport.message}`,
          transport instanceof LlmTransportError ? transport.detail : undefined,
        );
      }
      content = response.content;
      finishReason = response.finishReason;
      source = "live";
      deps.recordUsage(response.usage);
      usageTotal = addUsage(usageTotal, response.usage);

      if (deps.cacheMode === "readWrite") {
        const entry: CacheEntry = {
          key,
          task: request.task,
          model,
          promptVersion: request.prompt.version,
          mode,
          inputDigest: request.inputDigest,
          inputPreview: request.inputPreview,
          params,
          response: { content, finishReason, usage: response.usage },
        };
        deps.cache.set(entry);
      }
    }

    const parsed = parseJsonPayload(content);
    if (parsed.ok && validate(parsed.value)) {
      return {
        value: parsed.value as T,
        source,
        model,
        promptVersion: request.prompt.version,
        attempts: attempt,
        usage: usageTotal,
        mode,
      };
    }

    lastErrors = parsed.ok
      ? describeErrors(validate.errors ?? [])
      : `the response was not valid JSON (${parsed.error})`;

    if (finishReason === "length") {
      // Worth naming separately: a truncated answer is not a model that misunderstood
      // the schema, it is a max_tokens that is too low, and repairing it by asking
      // again wastes two more calls to reach the same wall.
      lastErrors += `; the response hit the ${maxTokens}-token limit and was truncated`;
    }

    if (attempt <= deps.maxRepairs) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          `That response did not satisfy the schema: ${lastErrors}. Return the corrected ` +
          `JSON object only.`,
      });
    }
  }

  throw new LlmCallFailed(
    request.task,
    "schema",
    `llm: task "${request.task}" produced no schema-valid response in ` +
      `${deps.maxRepairs + 1} attempt(s). Last problem: ${lastErrors}. The deterministic ` +
      `result stands.`,
  );
}

/** Task names become a JSON-schema name in the request; keep them identifier-shaped. */
function schemaName(task: string): string {
  return task.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * `JSON.parse` on the response, tolerating exactly one wrapper: a fenced code block.
 *
 * This is not the regex-parsing brief §7.3 forbids, and the distinction is worth
 * stating because it looks similar. Nothing here extracts an *answer* from prose: the
 * payload is still parsed as JSON and validated against the schema, and if this strips
 * the wrong thing the result fails validation and the repair loop reports it. Without
 * it, prompted mode fails constantly on models that were trained to fence their JSON,
 * which would mean discarding correct answers over punctuation.
 */
function parseJsonPayload(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = content.trim();
  const unfenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = unfenced?.[1] ?? trimmed;
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function describeErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) return "no reason reported by the validator";
  return errors
    .slice(0, 6)
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
    .join("; ");
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
