/**
 * Turning CLI flags into an LLM session, in one place.
 *
 * The CLI is the composition root: it is the only package allowed to know that both the
 * deterministic pipeline and the LLM layer exist (ADR-0009), so the wiring lives here
 * rather than in `@markforge/core`.
 *
 * Three rules this module enforces, all from ADR-0009:
 *
 *   - **`--llm` is required.** No environment variable, config file, or present API key
 *     turns the network on by itself.
 *   - **A missing key is a startup error**, not a downgrade to `--no-llm`. Producing
 *     quietly different output is worse than refusing to start.
 *   - **`--llm-cache-mode readOnly` needs no key**, because it cannot reach the network.
 *     That is the mode CI and the test suite use against the committed cache.
 */
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_DIR,
  DEFAULT_MODELS,
  CAPABILITIES_PATH,
  LlmSession,
  headingTiebreaker,
  judgeUnitEquivalence,
  loadCapabilities,
  resolveApiKey,
  visionRecognizer,
  type CacheMode,
} from "@markforge/llm";

/**
 * Attaches the `--llm-*` family to a command.
 *
 * One definition shared by `convert` and `check`, because the alternative is two lists
 * that drift and a flag that works on one command and not the other. Every one of these
 * is inert without `--llm`: they configure a session that is never built otherwise.
 */
export function withLlmOptions<T extends CommandLike>(command: T): T {
  return command
    .option("--llm-base-url <url>", "OpenAI-compatible endpoint", DEFAULT_BASE_URL)
    .option(
      "--llm-api-key-env <name>",
      "name of the environment variable holding the key; the value never goes in config",
      DEFAULT_API_KEY_ENV,
    )
    .option("--llm-model-fast <name>", "model for classification and tie-breaks", DEFAULT_MODELS.fast)
    .option("--llm-model-strong <name>", "model for synthesis", DEFAULT_MODELS.strong)
    .option("--llm-model-vision <name>", "model for scanned pages", DEFAULT_MODELS.vision)
    .option(
      "--llm-model-embed <name>",
      "model for near-duplicate detection between context units",
      DEFAULT_MODELS.embed,
    )
    .option("--llm-cache-dir <dir>", "content-addressed response cache", DEFAULT_CACHE_DIR)
    .option(
      "--llm-cache-mode <mode>",
      "readWrite | readOnly | off. readOnly never touches the network and needs no key",
      "readWrite",
    )
    .option("--llm-max-tokens <n>", "token budget for the run; exceeding it aborts", "200000")
    .option("--llm-max-repairs <n>", "schema-repair attempts per call", "2")
    .option("--llm-seed <n>", "seed, sent only if the endpoint honours it", "20260731") as T;
}

/** The slice of commander's Command this module needs, so it imports no types from it. */
interface CommandLike {
  option(flags: string, description: string, defaultValue?: string): CommandLike;
}

export interface LlmFlags {
  llm?: boolean;
  llmBaseUrl?: string;
  llmApiKeyEnv?: string;
  llmModelFast?: string;
  llmModelStrong?: string;
  llmModelVision?: string;
  llmModelEmbed?: string;
  llmCacheDir?: string;
  llmCacheMode?: string;
  llmMaxTokens?: string;
  llmMaxRepairs?: string;
  llmSeed?: string;
}

/**
 * Whether the LLM was asked for, from the flags as typed.
 *
 * `--llm` and `--no-llm` are read from argv rather than declared as a commander option
 * pair on purpose. Commander implements `--no-x` as the *negation* of `--x` and, when both
 * are declared, defaults the value to `true` — which would make the LLM opt-*out*. ADR-0009
 * requires the opposite, and a flag default that subtle is not worth inheriting from a
 * library's convention: so `--llm` enables, `--no-llm` is accepted and is the default, and
 * asking for both is an error rather than a coin toss.
 */
export function resolveLlmRequest(argv: string[]): { enabled: boolean; explicitOff: boolean } {
  const on = argv.includes("--llm");
  const off = argv.includes("--no-llm");
  if (on && off) {
    throw new Error(
      "markforge: --llm and --no-llm contradict each other. --no-llm is the default, so " +
        "pass neither to convert deterministically.",
    );
  }
  return { enabled: on, explicitOff: off };
}

export interface BuiltSession {
  session: LlmSession;
  /** Reported so a run says which model answered and whether the schema was enforced. */
  describe(): string;
}

const CACHE_MODES = new Set<CacheMode>(["readWrite", "readOnly", "off"]);

export function buildSession(flags: LlmFlags): BuiltSession {
  const baseUrl = flags.llmBaseUrl ?? DEFAULT_BASE_URL;
  const apiKeyEnv = flags.llmApiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const cacheMode = parseCacheMode(flags.llmCacheMode);
  const cacheDir = flags.llmCacheDir ?? DEFAULT_CACHE_DIR;

  // The one place a key is read. `required` is false only for readOnly, which is a
  // promise about the network rather than a convenience.
  const apiKey = resolveApiKey(apiKeyEnv, { required: cacheMode !== "readOnly" });

  // A readOnly run reaches no network, so an aged capability record cannot cause a bad
  // call — the only thing it does there is reproduce the cache key the committed entries
  // were recorded under. Expiring it would turn every hit into a miss and let the
  // deterministic result stand, which is the silent difference in output the probe exists
  // to prevent (OPEN_QUESTIONS §7d).
  const capabilities = loadCapabilities(CAPABILITIES_PATH, baseUrl, {
    ...(cacheMode === "readOnly" ? { maxAgeMs: Number.POSITIVE_INFINITY } : {}),
  });
  const session = new LlmSession({
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    models: {
      fast: flags.llmModelFast ?? DEFAULT_MODELS.fast,
      strong: flags.llmModelStrong ?? DEFAULT_MODELS.strong,
      vision: flags.llmModelVision ?? DEFAULT_MODELS.vision,
      embed: flags.llmModelEmbed ?? DEFAULT_MODELS.embed,
    },
    cache: { dir: cacheDir, mode: cacheMode },
    budget: { maxTokens: parseCount(flags.llmMaxTokens, 200_000, "--llm-max-tokens") },
    maxRepairs: parseCount(flags.llmMaxRepairs, 2, "--llm-max-repairs"),
    seed: parseCount(flags.llmSeed, 20260731, "--llm-seed"),
    ...(capabilities ? { capabilities } : {}),
  });

  return {
    session,
    describe: () => {
      const report = session.report();
      return (
        `llm: ${report.mode} structured output, models ${report.models.fast} / ` +
        `${report.models.strong} / ${report.models.vision}, cache ${report.cache.mode} ` +
        `(${report.cache.entries} entr${report.cache.entries === 1 ? "y" : "ies"})` +
        (capabilities
          ? ""
          : `\n     no capability probe has run for ${baseUrl}, so guided decoding and seed ` +
            `are assumed unavailable and the repair loop is doing the work. ` +
            `Run \`markforge check --llm\` once to find out.`)
      );
    },
  };
}

/** Both injection points `@markforge/core` accepts, built from one session. */
export function assistFrom(
  built: BuiltSession,
  onFailure: (context: { task: string; nodeOrPage: string; reason: string; message: string }) => void,
): { headingTiebreak: ReturnType<typeof headingTiebreaker>; recognize: ReturnType<typeof visionRecognizer> } {
  return {
    headingTiebreak: headingTiebreaker(built.session, { onFailure }),
    recognize: visionRecognizer(built.session, { onFailure }),
  };
}

/**
 * The injection points `@markforge/agentify` accepts (SPEC §10.2–10.4).
 *
 * `embed` and `adjudicate` are wired; `classifyRole` and `extraUnits` are not, and that is a
 * statement about what is measurable rather than about what is possible. §10.4's merge is the
 * one stage whose correctness the corpus can actually check, and checking it refuted the
 * design: cosine alone ranked two unrelated environment variables above both authored
 * near-duplicate pairs, so the embedding shortlists and a `strong` model decides (ADR-0020).
 * `classifyRole` and `extraUnits` are left unbound because this corpus gives no
 * way to tell a good answer from a plausible one — the rule-based classifier is already
 * 10 for 10 on the authored roles, so a model could only agree or be wrong, and generated
 * context units would be graded against an answer key written before either existed.
 * Wiring them would add two prompt files whose quality nothing would keep honest, which is
 * the trap `packages/llm/src/tasks.ts` names at the top. Recorded in docs/AGENTIFY.md.
 */
export function agentifyAssistFrom(
  session: LlmSession,
  onFailure?: (message: string) => void,
): {
  embed: (texts: string[]) => Promise<number[][]>;
  adjudicate: (pair: {
    a: { text: string; sources: { path: string }[] };
    b: { text: string; sources: { path: string }[] };
  }) => Promise<{ sameFact: boolean; survivingText: string } | undefined>;
} {
  return {
    embed: (texts) => session.embed(texts),
    adjudicate: async ({ a, b }) => {
      try {
        const verdict = await judgeUnitEquivalence(session, {
          textA: a.text,
          textB: b.text,
          pathA: a.sources[0]?.path ?? "(unknown)",
          pathB: b.sources[0]?.path ?? "(unknown)",
        });
        return { sameFact: verdict.sameFact, survivingText: verdict.survivingText };
      // degradation: rethrows
      } catch (error) {
        // A failed adjudication leaves the pair unmerged, which is the safe direction: an
        // unmerged duplicate repeats itself where a wrongly merged one deletes a fact.
        onFailure?.(
          `llm could not adjudicate a near-duplicate pair, so it stays unmerged: ` +
            `${(error as Error).message}`,
        );
        return undefined;
      }
    },
  };
}

function parseCacheMode(value: string | undefined): CacheMode {
  if (value === undefined) return "readWrite";
  if (!CACHE_MODES.has(value as CacheMode)) {
    throw new Error(
      `markforge: --llm-cache-mode must be readWrite, readOnly, or off; got "${value}".`,
    );
  }
  return value as CacheMode;
}

function parseCount(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`markforge: ${flag} must be a non-negative integer; got "${value}".`);
  }
  return parsed;
}
