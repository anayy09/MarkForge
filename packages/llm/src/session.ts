/**
 * The session: one configured LLM layer for one run.
 *
 * Holds the client, the cache, the capability answer, and the token budget, and is the
 * only thing the rest of the project passes around. Tasks are functions over a session
 * (`tasks.ts`) rather than methods on it, so adding a task is adding a file.
 *
 * **The credential rule, and the one refinement Phase 3 needed.** ADR-0009 says a
 * missing environment variable while the LLM is enabled is a startup error, never a
 * silent downgrade. That stands. But `cache.mode: "readOnly"` — the mode SPEC §6.3
 * introduces so CI can exercise this code offline — cannot require a key, because its
 * whole meaning is "do not reach the network". So the rule is stated precisely here:
 * **a key is required unless the cache is readOnly**, and in readOnly mode a miss is a
 * hard, named error (`CacheMissError`). Neither branch can quietly produce different
 * output, which is the property ADR-0009 was protecting.
 */
import { canonicalJson, sha256Hex } from "@markforge/ir";
import { ChatClient, type TokenUsage, type Transport } from "./client.js";
import {
  FileCacheStore,
  MemoryCacheStore,
  type CacheMode,
  type CacheStore,
} from "./cache.js";
import { conservativeCapabilities, type LlmCapabilities } from "./capabilities.js";
import { callStructured, type Role, type StructuredRequest, type StructuredResult } from "./structured.js";

export interface SessionOptions {
  baseUrl: string;
  /** The key *value*, already read from the environment by the caller. */
  apiKey?: string;
  models: Record<Role, string>;
  cache?: { dir?: string; mode?: CacheMode };
  budget?: { maxTokens?: number; onExceed?: "abort" | "degrade" };
  maxRepairs?: number;
  seed?: number;
  /** From a previous probe. Unprobed means the conservative assumption. */
  capabilities?: LlmCapabilities;
  /** Injected for tests: no network, no key, no filesystem. */
  transport?: Transport;
  cacheStore?: CacheStore;
  defaultMaxTokens?: number;
}

export interface LlmRunReport {
  /** Which mode structured output actually used — SPEC §6.3 requires reporting it. */
  mode: "guided" | "prompted";
  models: Record<Role, string>;
  calls: number;
  cacheHits: number;
  liveCalls: number;
  failures: number;
  repairs: number;
  usage: TokenUsage;
  budget: { maxTokens: number; spent: number; exceeded: boolean };
  cache: { mode: CacheMode; dir?: string; entries: number };
  capabilities: { guidedDecoding: boolean; seed: boolean; probedModel: string };
}

export const DEFAULT_MAX_REPAIRS = 2;
export const DEFAULT_BUDGET_TOKENS = 200_000;

export class LlmSession {
  readonly models: Record<Role, string>;
  readonly capabilities: LlmCapabilities;
  readonly cacheMode: CacheMode;
  private readonly client: ChatClient | undefined;
  private readonly cache: CacheStore;
  private readonly cacheDir: string | undefined;
  private readonly maxRepairs: number;
  private readonly maxTokens: number;
  private readonly onExceed: "abort" | "degrade";
  private readonly seed: number | undefined;
  private readonly defaultMaxTokens: number;

  private spent = 0;
  private calls = 0;
  private cacheHits = 0;
  private liveCalls = 0;
  private failures = 0;
  private repairs = 0;
  private usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(options: SessionOptions) {
    this.models = options.models;
    this.capabilities = options.capabilities ?? conservativeCapabilities(options.baseUrl);
    this.cacheMode = options.cache?.mode ?? "readWrite";
    this.maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    this.maxTokens = options.budget?.maxTokens ?? DEFAULT_BUDGET_TOKENS;
    this.onExceed = options.budget?.onExceed ?? "abort";
    this.seed = options.seed;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 2048;

    this.cacheDir = options.cacheStore ? undefined : options.cache?.dir;
    this.cache =
      options.cacheStore ??
      (options.cache?.dir ? new FileCacheStore(options.cache.dir) : new MemoryCacheStore());

    // No client in readOnly mode even when a key is present: "readOnly" is a promise
    // about network access, and holding a usable client would make that promise depend
    // on every call site remembering to check the mode.
    this.client =
      this.cacheMode === "readOnly" || options.apiKey === undefined
        ? undefined
        : new ChatClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, ...(options.transport ? { transport: options.transport } : {}) });
  }

  /** True when this session cannot reach the network at all. */
  get offline(): boolean {
    return this.client === undefined;
  }

  async structured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    this.calls++;
    try {
      const result = await callStructured<T>(request, {
        ...(this.client ? { client: this.client } : {}),
        cache: this.cache,
        cacheMode: this.cacheMode,
        models: this.models,
        guidedDecoding: this.capabilities.guidedDecoding,
        ...(this.seed !== undefined && this.capabilities.seed ? { seed: this.seed } : {}),
        maxRepairs: this.maxRepairs,
        defaultMaxTokens: this.defaultMaxTokens,
        checkBudget: () => this.budgetProblem(),
        recordUsage: (usage) => this.addUsage(usage),
      });
      if (result.source === "cache") this.cacheHits++;
      else this.liveCalls++;
      this.repairs += result.attempts - 1;
      return result;
    } catch (error) {
      this.failures++;
      throw error;
    }
  }

  private budgetProblem(): string | undefined {
    if (this.spent < this.maxTokens) return undefined;
    const message =
      `llm: token budget of ${this.maxTokens} is spent (${this.spent} used). ` +
      (this.onExceed === "abort"
        ? `budget.onExceed is "abort", so the run stops here rather than continuing with ` +
          `a mix of model-assisted and deterministic results.`
        : `budget.onExceed is "degrade", so the deterministic result stands for the rest ` +
          `of the run and each skipped call is diagnosed.`);
    return message;
  }

  private addUsage(usage: TokenUsage): void {
    this.usage = {
      promptTokens: this.usage.promptTokens + usage.promptTokens,
      completionTokens: this.usage.completionTokens + usage.completionTokens,
      totalTokens: this.usage.totalTokens + usage.totalTokens,
    };
    this.spent += usage.totalTokens;
  }

  report(): LlmRunReport {
    return {
      mode: this.capabilities.guidedDecoding ? "guided" : "prompted",
      models: this.models,
      calls: this.calls,
      cacheHits: this.cacheHits,
      liveCalls: this.liveCalls,
      failures: this.failures,
      repairs: this.repairs,
      usage: this.usage,
      budget: { maxTokens: this.maxTokens, spent: this.spent, exceeded: this.spent >= this.maxTokens },
      cache: {
        mode: this.cacheMode,
        ...(this.cacheDir !== undefined ? { dir: this.cacheDir } : {}),
        entries: this.cache.size,
      },
      capabilities: {
        guidedDecoding: this.capabilities.guidedDecoding,
        seed: this.capabilities.seed,
        probedModel: this.capabilities.probedModel,
      },
    };
  }
}

/**
 * Reads the API key from the environment, and only from the environment.
 *
 * `apiKeyEnv` is the *name* of a variable; the value never appears in config, in a
 * committed artifact, or in an error message from here (brief §7.2, ADR-0009).
 */
export function resolveApiKey(
  apiKeyEnv: string,
  options: { required: boolean; env?: Record<string, string | undefined> },
): string | undefined {
  const env = options.env ?? process.env;
  const value = env[apiKeyEnv];
  if (value !== undefined && value.trim() !== "") return value.trim();
  if (!options.required) return undefined;
  // No "markforge:" prefix: the CLI adds one when it reports an error, and the first
  // run of this path printed "markforge: markforge: the LLM is enabled but…".
  throw new Error(
    `the LLM is enabled but $${apiKeyEnv} is not set. Credentials come from ` +
      `the environment only (docs/adr/0009-llm-openai-compatible-only.md), and a missing ` +
      `key is a startup error rather than a silent downgrade to --no-llm, because quietly ` +
      `producing different output is worse than failing. Export $${apiKeyEnv}, pass ` +
      `--no-llm, or set llm.cache.mode="readOnly" to run from the committed cache offline.`,
  );
}

/** Digest of any JSON-shaped input, for the cache key. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
