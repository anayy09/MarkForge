/**
 * The session: one configured LLM layer for one run.
 *
 * Holds the client, the cache, the capability answer, and the token budget, and is the
 * only thing the rest of the project passes around. Tasks are functions over a session
 * (`tasks.ts`) rather than methods on it, so adding a task is adding a file.
 *
 * **The credential rule, and its one refinement.** ADR-0009 says a
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
  CacheMissError,
  FileCacheStore,
  MemoryCacheStore,
  cacheKey,
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
  /**
   * Which role serves each task, overriding `DEFAULT_TASK_ROLES` per key.
   *
   * The role names are closed and the bindings are open, because they fail differently.
   * A fourth role needs code that knows how to use it; a rebinding needs nothing but a
   * decision, and the bindings are where experience actually changes its mind — a
   * heading tie-break worth sending to `strong` on one corpus belongs on `fast` for
   * another. That should be a config edit, not a patch.
   */
  taskRoles?: Record<string, Role>;
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

/**
 * The embedding task's cache identity.
 *
 * The task name is the one `DEFAULT_TASK_ROLES` binds to `embed`, so `roleFor` and the
 * cache agree on what this work is called; the version is the vector *encoding* contract
 * rather than a prompt version, and bumping it is how a change to rounding or truncation
 * invalidates recorded vectors.
 */
const EMBED_TASK = "context-unit-dedup";
const EMBED_VERSION = "e2";

/**
 * `nomic-embed-text-v1.5` requires a task prefix on every input, and silently degrades
 * without one rather than erroring.
 *
 * `clustering:` is the documented prefix for grouping similar texts, which is what §10.4's
 * shortlist does. Measured on the agentify corpus it lifts the authored near-duplicate pairs
 * from 0.63/0.62 to 0.78/0.74 — worth having for recall into the adjudication stage, though
 * it does *not* reorder true pairs above topical decoys, which is why a threshold alone was
 * abandoned (ADR-0020). Changing this string changes every vector, so EMBED_VERSION moved
 * with it and the un-prefixed entries are unreachable rather than silently mixed in.
 */
const EMBED_PREFIX = "clustering: ";

/**
 * The SPEC §6.2 table, as defaults rather than as law.
 *
 * Every task on SPEC §6.2's permitted list appears here, including the seven that are
 * not built yet — listing a binding costs one line and makes the mapping legible in
 * one place, where discovering it task by task as each is implemented would not.
 * `alt-text` is bound to `fast` because its usual input is surrounding text; when the
 * image itself is the input the caller passes `vision` explicitly.
 */
export const DEFAULT_TASK_ROLES: Record<string, Role> = {
  "document-role-classification": "fast",
  "context-unit-extraction": "fast",
  "alt-text": "fast",
  "heading-tiebreak": "fast",
  "context-unit-summarization": "strong",
  "conflict-analysis": "strong",
  "glossary-extraction": "strong",
  "page-transcription": "vision",
  "table-structure-recovery": "vision",
  "context-unit-dedup": "embed",
};

export class LlmSession {
  readonly models: Record<Role, string>;
  readonly taskRoles: Record<string, Role>;
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
    this.taskRoles = { ...DEFAULT_TASK_ROLES, ...options.taskRoles };
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

  /**
   * The role bound to a task.
   *
   * An unbound task is an error rather than a silent default. A typo in `llm.taskRoles`
   * that quietly fell through to `fast` would send work to the wrong model and show up
   * only as output that got slightly worse, which is the least debuggable failure this
   * layer can produce.
   */
  roleFor(task: string): Role {
    const role = this.taskRoles[task];
    if (role === undefined) {
      throw new Error(
        `llm: no role is bound to task "${task}". Known tasks: ` +
          `${Object.keys(this.taskRoles).sort().join(", ")}. Bind it in llm.taskRoles, or ` +
          `add it to DEFAULT_TASK_ROLES if it is a permitted task from SPEC §6.2.`,
      );
    }
    return role;
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
    // degradation: rethrows
    } catch (error) {
      this.failures++;
      throw error;
    }
  }

  /**
   * Embeddings for `context-unit-dedup` (SPEC §10.4), cached per text.
   *
   * **Cached per text, not per batch**, which is the only detail here worth arguing about.
   * A batch key would be stable only while the batch is, so adding one context unit to a
   * corpus would miss the cache for every unit beside it and turn a one-unit edit into a
   * full re-embed — and, in `readOnly`, into a hard failure on a document nobody touched.
   * Per-text keys make the committed cache survive edits to the corpus, which is what
   * makes offline CI possible at all.
   *
   * Vectors are rounded to six decimals before storage. The threshold comparisons in
   * §10.4 are at two decimals, so six is far more precision than any decision uses, and
   * the full float64 text was several times larger for no behavioural difference — in a
   * file that is meant to be committed and read in a diff.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = this.models.embed;
    const out = new Array<number[] | undefined>(texts.length);
    const missing: { index: number; text: string }[] = [];

    texts.forEach((text, index) => {
      if (this.cacheMode === "off") {
        missing.push({ index, text });
        return;
      }
      const hit = this.cache.get(this.embedKey(text, model));
      if (hit) {
        this.calls++;
        this.cacheHits++;
        out[index] = JSON.parse(hit.response.content) as number[];
      } else {
        missing.push({ index, text });
      }
    });

    if (missing.length > 0) {
      if (!this.client) {
        throw new CacheMissError(
          `llm: ${missing.length} embedding(s) are not in the cache and this session cannot ` +
            `reach the network (cache mode "${this.cacheMode}"${this.client ? "" : ", no client"}). ` +
            `Re-record with --llm-cache-mode readWrite and commit the result, or run without ` +
            `--llm so deduplication uses text comparison alone.`,
          this.embedKey(missing[0]!.text, model),
        );
      }
      const problem = this.budgetProblem();
      if (problem) throw new Error(problem);

      const response = await this.client.embed({
        model,
        input: missing.map((m) => EMBED_PREFIX + m.text),
      });
      this.addUsage(response.usage);
      missing.forEach((entry, i) => {
        const vector = (response.vectors[i] ?? []).map((v) => Math.round(v * 1e6) / 1e6);
        out[entry.index] = vector;
        this.calls++;
        this.liveCalls++;
        if (this.cacheMode === "readWrite") {
          this.cache.set({
            key: this.embedKey(entry.text, model),
            task: EMBED_TASK,
            model,
            promptVersion: EMBED_VERSION,
            mode: this.capabilities.guidedDecoding ? "guided" : "prompted",
            inputDigest: digestOf(entry.text),
            inputPreview: entry.text.slice(0, 100),
            params: { dimensions: vector.length },
            response: {
              content: JSON.stringify(vector),
              finishReason: "stop",
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          });
        }
      });
    }

    return out.map((vector, index) => {
      if (!vector) throw new Error(`llm: no embedding produced for input ${index}`);
      return vector;
    });
  }

  private embedKey(text: string, model: string): string {
    // No prompt file and no decoding parameters take part: an embedding depends on the
    // model and the text and nothing else. Including `mode` or `seed` here — both of which
    // belong in a *completion* key — would invalidate every vector whenever an unrelated
    // capability probe changed its mind.
    return cacheKey({
      task: EMBED_TASK,
      inputDigest: digestOf(text),
      model,
      promptVersion: EMBED_VERSION,
      params: {},
    });
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
 * committed artifact, or in an error message from here (SPEC §6.1, ADR-0009).
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
