/**
 * The one transport: OpenAI-compatible chat completions over `fetch`.
 *
 * ADR-0009 permits no vendor SDK and no framework, so this is the whole network
 * surface of the project — about a hundred lines, which is the argument for not
 * having added a dependency to hold them.
 *
 * Two things it deliberately does not do:
 *
 *   - **No retries.** A transient 429 or 503 fails the call, and the caller applies
 *     its deterministic fallback with a diagnostic. Retrying would make output depend
 *     on endpoint health, which is the same objection ADR-0009 raises against fallback
 *     chains. The repair loop in `structured.ts` is the only loop in the layer, and it
 *     exists because a *schema violation* is information, where a 503 is noise.
 *   - **No key handling beyond reading one variable.** The key is passed in as a
 *     string by whoever read the environment; this module never touches `process.env`,
 *     so a key cannot reach a log line from here.
 */

/** A single content part. Images are how the vision role receives a scanned page. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Always 0 in this project (SPEC §6.3). Present as a field so it is visible. */
  temperature: number;
  maxTokens: number;
  /** Sent only when the probe found the endpoint accepts it. */
  seed?: number;
  /**
   * Sent only when the probe found guided decoding available. When absent the
   * schema still governs the result — `structured.ts` validates either way.
   */
  jsonSchema?: { name: string; schema: object };
}

export interface ChatResponse {
  content: string;
  usage: TokenUsage;
  finishReason: string;
}

/** Everything the client needs from its environment, so tests need no network. */
export interface Transport {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    status: number;
    text(): Promise<string>;
  }>;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so the whole layer is testable without a network or a key. */
  transport?: Transport;
  timeoutMs?: number;
}

/**
 * Thrown for anything the endpoint refused or returned unusably.
 *
 * Carries the status so a caller can tell "your key is wrong" (401, worth stopping
 * the run) from "the model is busy" (429, worth a diagnostic and a fallback).
 */
export class LlmTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LlmTransportError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    // Trailing slashes are the most common configuration mistake in a base URL and
    // produce a 404 that looks like a missing model, so they are normalised here
    // rather than diagnosed later.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };
    if (request.seed !== undefined) body["seed"] = request.seed;
    if (request.jsonSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // An aborted request and a DNS failure both land here. Naming the endpoint
      // without the key is the useful half of the message.
      throw new LlmTransportError(
        `request to ${this.baseUrl}/chat/completions failed: ${(error as Error).message}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    if (status !== 200) {
      throw new LlmTransportError(
        `endpoint returned HTTP ${status} for model "${request.model}"`,
        status,
        text.slice(0, 600),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmTransportError(
        `endpoint returned a non-JSON body for model "${request.model}"`,
        status,
        text.slice(0, 600),
      );
    }

    const choice = (parsed as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })
      .choices?.[0];
    if (!choice?.message) {
      throw new LlmTransportError(
        `endpoint returned no choices for model "${request.model}"`,
        status,
        text.slice(0, 600),
      );
    }

    // Empty content is a *result*, not a transport failure, and conflating the two cost a
    // wrong answer the first time this ran: the capability probe asked a reasoning model
    // for one word inside a 16-token ceiling, got a 200 with `content: ""` because the
    // budget went on reasoning, and reported the endpoint as broken. A truncated or empty
    // answer belongs to the schema layer, which will fail validation and say why — with
    // `finish_reason` in hand to explain that the ceiling, not the model, was the problem.
    const raw = choice.message.content;
    const content = typeof raw === "string" ? raw : "";

    const rawUsage = (parsed as { usage?: Record<string, unknown> }).usage ?? {};
    return {
      content,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown",
      usage: {
        promptTokens: numberOr(rawUsage["prompt_tokens"], 0),
        completionTokens: numberOr(rawUsage["completion_tokens"], 0),
        totalTokens: numberOr(rawUsage["total_tokens"], 0),
      },
    };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
