/**
 * Tests for the LLM layer.
 *
 * Every one of these runs offline against a fake transport, which is not a compromise —
 * it is the property the layer is built for. If a test here needed a network, the cache
 * and the repair loop would not be doing their job.
 *
 * What is deliberately *not* tested here: whether the gateway supports guided decoding.
 * That is a fact about a deployment, discovered by `markforge check --llm` and recorded in
 * `docs/OPEN_QUESTIONS.md` §3. Asserting it in a unit test would be asserting that someone
 * else's server is configured a particular way.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatClient,
  LlmCallFailed,
  LlmSession,
  LlmTransportError,
  MemoryCacheStore,
  CacheMissError,
  breakHeadingTie,
  cacheKey,
  conservativeCapabilities,
  fill,
  loadCapabilities,
  loadPrompt,
  probeCapabilities,
  resolveApiKey,
  type CacheEntry,
  type Transport,
} from "../src/index.js";

/** A transport that answers from a script and records what it was asked. */
function fakeTransport(
  script: (body: Record<string, unknown>, call: number) => { status?: number; content?: unknown; raw?: string },
): { transport: Transport; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const transport: Transport = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    requests.push(body);
    const answer = script(body, requests.length);
    if (answer.raw !== undefined) {
      return { status: answer.status ?? 200, text: async () => answer.raw! };
    }
    return {
      status: answer.status ?? 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: answer.content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    };
  };
  return { transport, requests };
}

const MODELS = {
  fast: "fast-model",
  strong: "strong-model",
  vision: "vision-model",
  embed: "embed-model",
};

function session(
  transport: Transport,
  overrides: Partial<ConstructorParameters<typeof LlmSession>[0]> = {},
): LlmSession {
  return new LlmSession({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    models: MODELS,
    transport,
    cacheStore: new MemoryCacheStore(),
    capabilities: { ...conservativeCapabilities("https://example.invalid/v1"), guidedDecoding: true },
    ...overrides,
  });
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
};

function request(prompt = loadPrompt("heading-tiebreak", "v2")) {
  return {
    task: "test-task",
    role: "fast" as const,
    prompt,
    user: "the question",
    schema: SCHEMA,
    inputDigest: "digest-1",
    inputPreview: "the question",
  };
}

describe("credentials", () => {
  it("reads the key from the environment by name, never from config", () => {
    expect(resolveApiKey("SOME_KEY", { required: true, env: { SOME_KEY: "abc" } })).toBe("abc");
  });

  // ADR-0009: a missing key while the LLM is on is a startup error, never a silent
  // downgrade — producing quietly different output is worse than failing.
  it("treats a missing key as an error rather than a downgrade", () => {
    expect(() => resolveApiKey("SOME_KEY", { required: true, env: {} })).toThrow(/\$SOME_KEY is not set/);
    expect(() => resolveApiKey("SOME_KEY", { required: true, env: { SOME_KEY: "  " } })).toThrow();
  });

  it("does not require a key when the caller cannot reach the network", () => {
    expect(resolveApiKey("SOME_KEY", { required: false, env: {} })).toBeUndefined();
  });

  it("never puts the key value in the error message", () => {
    try {
      resolveApiKey("SOME_KEY", { required: true, env: {} });
    } catch (error) {
      expect((error as Error).message).not.toContain("SOME_VALUE");
    }
  });
});

describe("prompts are files, and their version is part of the key", () => {
  it("loads a prompt with both sections and a digest", () => {
    const prompt = loadPrompt("heading-tiebreak", "v2");
    expect(prompt.system).toMatch(/deterministic document converter/);
    expect(prompt.user).toContain("{{text}}");
    expect(prompt.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the missing file rather than falling back to an inline string", () => {
    expect(() => loadPrompt("heading-tiebreak", "v99")).toThrow(/prompts\/heading-tiebreak\/v99\.md/);
  });

  // The reason the digest exists at all: two versions of a prompt must not share a cache
  // entry, and neither must two *edits* of one version.
  it("gives different versions different digests", () => {
    expect(loadPrompt("heading-tiebreak", "v1").digest).not.toBe(
      loadPrompt("heading-tiebreak", "v2").digest,
    );
  });

  it("refuses to send an unfilled placeholder to a model", () => {
    expect(() => fill("a {{missing}} b", {})).toThrow(/\{\{missing\}\}/);
    expect(fill("a {{x}} b", { x: "1" })).toBe("a 1 b");
  });
});

describe("the cache key", () => {
  const base = {
    task: "t",
    inputDigest: "d",
    model: "m",
    promptVersion: "v1",
    params: { temperature: 0, attempt: 1 },
  };

  it("is stable across key insertion order", () => {
    expect(cacheKey({ ...base, params: { attempt: 1, temperature: 0 } })).toBe(cacheKey(base));
  });

  it("changes when any component changes", () => {
    const original = cacheKey(base);
    expect(cacheKey({ ...base, task: "other" })).not.toBe(original);
    expect(cacheKey({ ...base, inputDigest: "other" })).not.toBe(original);
    expect(cacheKey({ ...base, model: "other" })).not.toBe(original);
    expect(cacheKey({ ...base, promptVersion: "v2" })).not.toBe(original);
    expect(cacheKey({ ...base, params: { temperature: 0, attempt: 2 } })).not.toBe(original);
  });
});

describe("structured output", () => {
  it("returns a validated answer and records it in the cache", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    const store = new MemoryCacheStore();
    const s = session(transport, { cacheStore: store });
    const result = await s.structured<{ answer: string }>(request());
    expect(result.value.answer).toBe("yes");
    expect(result.source).toBe("live");
    expect(result.attempts).toBe(1);
    expect(store.size).toBe(1);
    // Guided decoding was available, so the schema went to the endpoint.
    expect(requests[0]?.["response_format"]).toBeDefined();
    expect(requests[0]?.["temperature"]).toBe(0);
  });

  it("serves the second identical call from the cache without a network call", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    const store = new MemoryCacheStore();
    const first = session(transport, { cacheStore: store });
    await first.structured(request());
    const second = session(transport, { cacheStore: store });
    const result = await second.structured<{ answer: string }>(request());
    expect(result.source).toBe("cache");
    expect(requests).toHaveLength(1);
    // A cache hit costs nothing, so it must not move the token counters.
    expect(second.report().usage.totalTokens).toBe(0);
  });

  it("repairs a schema violation, bounded, and feeds the error back", async () => {
    const { transport, requests } = fakeTransport((_body, call) => ({
      content: call === 1 ? '{"answer":"maybe"}' : '{"answer":"no"}',
    }));
    const result = await session(transport).structured<{ answer: string }>(request());
    expect(result.value.answer).toBe("no");
    expect(result.attempts).toBe(2);
    // The repair turn carries the validation error, not a bare "try again".
    const repair = requests[1]?.["messages"] as { role: string; content: string }[];
    expect(repair.at(-1)?.content).toMatch(/did not satisfy the schema/);
    expect(repair.at(-1)?.content).toMatch(/answer/);
  });

  it("gives up after maxRepairs and fails rather than returning something invalid", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: '{"answer":"maybe"}' }));
    const s = session(transport, { maxRepairs: 2 });
    await expect(s.structured(request())).rejects.toThrow(LlmCallFailed);
    // One initial attempt plus two repairs. Bounded means bounded.
    expect(requests).toHaveLength(3);
    expect(s.report().failures).toBe(1);
  });

  it("never regex-parses a response: prose fails validation", async () => {
    const { transport } = fakeTransport(() => ({ content: "The answer is definitely yes." }));
    await expect(session(transport, { maxRepairs: 0 }).structured(request())).rejects.toThrow(
      /not valid JSON/,
    );
  });

  // A fenced block is unwrapped because models trained to fence their JSON would otherwise
  // have correct answers thrown away over punctuation. The payload is still parsed and
  // validated, so a wrong unwrap fails loudly.
  it("accepts a fenced JSON payload", async () => {
    const { transport } = fakeTransport(() => ({ content: '```json\n{"answer":"no"}\n```' }));
    const result = await session(transport).structured<{ answer: string }>(request());
    expect(result.value.answer).toBe("no");
  });

  it("omits response_format when the endpoint does not support it, and says so in the prompt", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    const s = session(transport, {
      capabilities: conservativeCapabilities("https://example.invalid/v1"),
    });
    const result = await s.structured(request());
    expect(result.mode).toBe("prompted");
    expect(requests[0]?.["response_format"]).toBeUndefined();
    const messages = requests[0]?.["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toMatch(/JSON Schema/);
    expect(s.report().mode).toBe("prompted");
  });

  it("sends a seed only when the endpoint honours it", async () => {
    const withSeed = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    await session(withSeed.transport, {
      seed: 7,
      capabilities: { ...conservativeCapabilities("x"), guidedDecoding: true, seed: true },
    }).structured(request());
    expect(withSeed.requests[0]?.["seed"]).toBe(7);

    const withoutSeed = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    await session(withoutSeed.transport, { seed: 7 }).structured(request());
    expect(withoutSeed.requests[0]?.["seed"]).toBeUndefined();
  });

  it("reports a transport failure as a failure, with no retry", async () => {
    const { transport, requests } = fakeTransport(() => ({ status: 503, raw: "upstream down" }));
    await expect(session(transport).structured(request())).rejects.toThrow(LlmCallFailed);
    // Deliberately no retry: retrying would make output depend on endpoint health.
    expect(requests).toHaveLength(1);
  });
});

describe("the budget", () => {
  it("stops before a call once the ceiling is spent, rather than after", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    const s = session(transport, { budget: { maxTokens: 15 }, cacheStore: new MemoryCacheStore() });
    await s.structured(request());
    expect(s.report().budget.spent).toBe(15);
    await expect(
      s.structured({ ...request(), inputDigest: "digest-2" }),
    ).rejects.toThrow(/budget of 15 is spent/);
    expect(requests).toHaveLength(1);
  });
});

describe("offline mode", () => {
  it("needs no key and no transport, and hits the committed cache", async () => {
    const prompt = loadPrompt("heading-tiebreak", "v2");
    const seeded = new MemoryCacheStore();
    // Record with a writing session, then read with an offline one — the same flow as
    // recording a cache locally and running CI from it.
    const { transport } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    await session(transport, { cacheStore: seeded }).structured(request(prompt));

    const offline = new LlmSession({
      baseUrl: "https://example.invalid/v1",
      models: MODELS,
      cacheStore: seeded,
      cache: { mode: "readOnly" },
      capabilities: { ...conservativeCapabilities("https://example.invalid/v1"), guidedDecoding: true },
    });
    expect(offline.offline).toBe(true);
    const result = await offline.structured<{ answer: string }>(request(prompt));
    expect(result.source).toBe("cache");
  });

  // The alternative would be a silent network call, which is what readOnly exists to
  // forbid. A miss has to be loud.
  it("fails by name on a cache miss instead of reaching the network", async () => {
    const offline = new LlmSession({
      baseUrl: "https://example.invalid/v1",
      apiKey: "present-but-unusable",
      models: MODELS,
      cacheStore: new MemoryCacheStore(),
      cache: { mode: "readOnly" },
    });
    await expect(offline.structured(request())).rejects.toThrow(CacheMissError);
    expect(offline.offline).toBe(true);
  });
});

describe("the heading tie-break task", () => {
  const candidates = [
    { interpretation: "heading4", score: 0.536, reasons: ["bold", "short"] },
    { interpretation: "paragraph", score: 0.464, reasons: ["default interpretation"] },
  ];

  it("constrains the answer to this node's own candidate set", async () => {
    const { transport, requests } = fakeTransport(() => ({
      content: '{"chosen":"paragraph","rationale":"reads as a sentence"}',
    }));
    const result = await breakHeadingTie(session(transport), {
      nodeId: "n_x:0",
      text: "Note that the following applies",
      candidates,
      precedingHeadings: [1],
      followingText: "Access arrangements were unchanged.",
    });
    expect(result.chosen).toBe("paragraph");
    expect(result.producedBy).toEqual({ kind: "model", model: "fast-model", promptVersion: "v2" });

    // The enum *is* the guarantee in brief §5.3, so it must actually be sent.
    const format = requests[0]?.["response_format"] as {
      json_schema: { schema: { properties: { chosen: { enum: string[] } } } };
    };
    expect(format.json_schema.schema.properties.chosen.enum).toEqual(["heading4", "paragraph"]);
  });

  it("refuses an off-menu answer even if the endpoint produced one", async () => {
    // What a cached entry recorded against a different candidate set would look like.
    const { transport } = fakeTransport(() => ({
      content: '{"chosen":"heading2","rationale":"invented a level"}',
    }));
    await expect(
      breakHeadingTie(session(transport, { maxRepairs: 0 }), {
        nodeId: "n_x:0",
        text: "Scope",
        candidates,
        precedingHeadings: [1],
        followingText: "Three sites were assessed.",
      }),
    ).rejects.toThrow();
  });

  it("does not spend a call when there is nothing to decide", async () => {
    const { transport, requests } = fakeTransport(() => ({ content: "{}" }));
    await expect(
      breakHeadingTie(session(transport), {
        nodeId: "n_x:0",
        text: "Scope",
        candidates: [candidates[0]!],
        precedingHeadings: [],
        followingText: "",
      }),
    ).rejects.toThrow(/at least two candidates/);
    expect(requests).toHaveLength(0);
  });
});

describe("the capability probe", () => {
  const client = (transport: Transport) =>
    new ChatClient({ baseUrl: "https://example.invalid/v1", apiKey: "k", transport });

  // The probe's whole design: asking for JSON and getting JSON proves nothing, so it asks
  // for prose and checks whether the schema won anyway.
  it("reports guided decoding only when a prose request comes back as schema-valid JSON", async () => {
    const enforced = fakeTransport((body) =>
      body["response_format"] ? { content: '{"catCount":1,"verdict":"aloof"}' } : { status: 400, raw: "seed" },
    );
    const result = await probeCapabilities(client(enforced.transport), "https://example.invalid/v1", "m");
    expect(result.guidedDecoding).toBe(true);
    expect(result.evidence[0]).toMatch(/enforced/);
  });

  it("reports guided decoding as unavailable when response_format is ignored", async () => {
    const ignored = fakeTransport((body) =>
      body["response_format"] ? { content: "Cats are independent animals." } : { status: 400, raw: "seed" },
    );
    const result = await probeCapabilities(client(ignored.transport), "https://example.invalid/v1", "m");
    expect(result.guidedDecoding).toBe(false);
    expect(result.evidence[0]).toMatch(/unavailable/);
  });

  // Seed support is established by sending a deliberately invalid seed: an endpoint that
  // validates the field rejects it, one that ignores it answers happily.
  it("reads a 400 naming the seed as support, and a 200 as the field being ignored", async () => {
    const validates = fakeTransport((body) =>
      body["seed"] !== undefined
        ? { status: 400, raw: JSON.stringify({ message: "invalid seed: int_parsing" }) }
        : { content: '{"catCount":1,"verdict":"aloof"}' },
    );
    expect((await probeCapabilities(client(validates.transport), "u", "m")).seed).toBe(true);

    const ignores = fakeTransport(() => ({ content: '{"catCount":1,"verdict":"aloof"}' }));
    expect((await probeCapabilities(client(ignores.transport), "u", "m")).seed).toBe(false);
  });

  /**
   * The defect this test exists for. The first version of the probe recorded "guided
   * decoding unavailable" when run with a wrong key — writing a confident wrong answer to
   * the capabilities file that every later run would inherit. An inconclusive probe must
   * record nothing.
   */
  it("refuses to conclude anything from an authentication failure", async () => {
    const unauthorised = fakeTransport(() => ({ status: 401, raw: "no" }));
    await expect(probeCapabilities(client(unauthorised.transport), "u", "m")).rejects.toThrow(
      /cannot determine guided decoding: the key was refused/,
    );
  });

  it("refuses to conclude anything from a rate limit or an unreachable endpoint", async () => {
    const limited = fakeTransport(() => ({ status: 429, raw: "slow down" }));
    await expect(probeCapabilities(client(limited.transport), "u", "m")).rejects.toThrow(/429/);
  });
});

describe("the transport", () => {
  it("treats an empty completion as a result, not as a broken endpoint", async () => {
    // A reasoning model that spends its ceiling on reasoning returns 200 with no content.
    // The first version of the client called that a transport failure, which made the
    // capability probe report a working endpoint as broken.
    const transport: Transport = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
    });
    const response = await new ChatClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      transport,
    }).chat({ model: "m", messages: [], temperature: 0, maxTokens: 8 });
    expect(response.content).toBe("");
    expect(response.finishReason).toBe("length");
  });

  it("reports a truncated answer as a truncation in the failure message", async () => {
    const transport: Transport = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"ans' }, finish_reason: "length" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });
    await expect(session(transport, { maxRepairs: 0 }).structured(request())).rejects.toThrow(
      /token limit and was truncated/,
    );
  });

  it("raises a transport error rather than returning a partial response", async () => {
    const transport: Transport = async () => ({ status: 200, text: async () => "not json" });
    await expect(
      new ChatClient({ baseUrl: "u", apiKey: "k", transport }).chat({
        model: "m",
        messages: [],
        temperature: 0,
        maxTokens: 8,
      }),
    ).rejects.toThrow(LlmTransportError);
  });
});

describe("the cache entry", () => {
  it("records the response but never the image bytes of a vision call", async () => {
    const { transport } = fakeTransport(() => ({ content: '{"answer":"yes"}' }));
    const store = new MemoryCacheStore();
    await session(transport, { cacheStore: store }).structured({
      ...request(),
      inputDigest: "sha-of-a-large-image",
      inputPreview: "page 1, image/png, 33000 bytes",
    });
    const entry = [...(store as unknown as { entries: Map<string, CacheEntry> }).entries.values()][0]!;
    expect(entry.inputDigest).toBe("sha-of-a-large-image");
    expect(entry.inputPreview).toBe("page 1, image/png, 33000 bytes");
    expect(JSON.stringify(entry)).not.toContain("base64");
    // No timestamp anywhere: the cache is committable, and a clock would make it churn.
    expect(JSON.stringify(entry)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// OPEN_QUESTIONS §7c. The role names are closed and the bindings are open, and the
// distinction only earns its keep if changing a binding actually changes which model is
// called — so that is what these assert, rather than the shape of the map.
describe("task to role bindings", () => {
  it("defaults to the SPEC §6.2 table", () => {
    const s = session(fakeTransport(() => ({ content: "{}" })).transport);
    expect(s.roleFor("heading-tiebreak")).toBe("fast");
    expect(s.roleFor("page-transcription")).toBe("vision");
    expect(s.roleFor("conflict-analysis")).toBe("strong");
    expect(s.roleFor("context-unit-dedup")).toBe("embed");
  });

  it("sends a rebound task to the model of its new role", async () => {
    const { transport, requests } = fakeTransport(() => ({
      content: '{"chosen":"paragraph","rationale":"reads as a sentence"}',
    }));
    const result = await breakHeadingTie(
      session(transport, { taskRoles: { "heading-tiebreak": "strong" } }),
      {
        nodeId: "n_x:0",
        text: "Note that the following applies",
        candidates: [
          { interpretation: "heading4", score: 0.536, reasons: ["bold"] },
          { interpretation: "paragraph", score: 0.464, reasons: ["default"] },
        ],
        precedingHeadings: [1],
        followingText: "Access arrangements were unchanged.",
      },
    );

    expect(requests[0]?.["model"]).toBe("strong-model");
    // And the provenance says so, so "which model decided this" stays answerable.
    expect(result.producedBy.model).toBe("strong-model");
  });

  it("rebinds one task without disturbing the others", () => {
    const s = session(fakeTransport(() => ({ content: "{}" })).transport, {
      taskRoles: { "heading-tiebreak": "strong" },
    });
    expect(s.roleFor("heading-tiebreak")).toBe("strong");
    expect(s.roleFor("page-transcription")).toBe("vision");
  });

  it("throws on an unbound task rather than defaulting", () => {
    const s = session(fakeTransport(() => ({ content: "{}" })).transport);
    // A typo silently falling through to `fast` would send work to the wrong model and
    // surface only as slightly worse output.
    expect(() => s.roleFor("heading-tiebrake")).toThrow(/no role is bound/);
    expect(() => s.roleFor("heading-tiebrake")).toThrow(/heading-tiebreak/);
  });

  it("carries embed in the model set, for Phase 4 near-duplicate merging", () => {
    const s = session(fakeTransport(() => ({ content: "{}" })).transport);
    expect(s.models.embed).toBe("embed-model");
  });
});

// OPEN_QUESTIONS §7d. A capability record describes one deployment on one day. The probe
// exists to stop silent quality differences, so a record it can no longer vouch for has
// to be discarded rather than believed.
describe("capability records go stale", () => {
  const BASE = "https://gateway.invalid/v1";
  const write = (record: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "markforge-caps-"));
    const path = join(dir, "llm-capabilities.json");
    writeFileSync(path, JSON.stringify(record), "utf8");
    return path;
  };
  const record = (over: Record<string, unknown> = {}) => ({
    baseUrl: BASE,
    probedModel: "fast-model",
    guidedDecoding: true,
    seed: true,
    probedAt: new Date().toISOString(),
    evidence: [],
    ...over,
  });

  it("accepts a recent record for the same endpoint", () => {
    expect(loadCapabilities(write(record()), BASE)?.guidedDecoding).toBe(true);
  });

  it("discards a record older than the maximum age", () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(loadCapabilities(write(record({ probedAt: old })), BASE)).toBeUndefined();
  });

  it("keeps a record that is old but still inside the window", () => {
    const recent = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(loadCapabilities(write(record({ probedAt: recent })), BASE)).toBeDefined();
  });

  it("discards a record written for a different endpoint", () => {
    expect(loadCapabilities(write(record()), "https://elsewhere.invalid/v1")).toBeUndefined();
  });

  it("discards a record with no probedAt, because unknown age is not evidence", () => {
    const legacy = record();
    delete (legacy as { probedAt?: unknown }).probedAt;
    expect(loadCapabilities(write(legacy), BASE)).toBeUndefined();
  });

  it("discards a record dated in the future, because a clock moved", () => {
    const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(loadCapabilities(write(record({ probedAt: ahead })), BASE)).toBeUndefined();
  });

  it("stamps a real probe with the time it ran", async () => {
    const { transport } = fakeTransport(() => ({ content: '{"catCount":1,"verdict":"fluffy"}' }));
    const client = new ChatClient({ baseUrl: BASE, apiKey: "k", transport });
    const probed = await probeCapabilities(client, BASE, "fast-model");
    expect(Date.now() - Date.parse(probed.probedAt)).toBeLessThan(60_000);
  });

  it("treats the unprobed fallback as already expired", () => {
    const conservative = conservativeCapabilities(BASE);
    expect(loadCapabilities(write(conservative), BASE)).toBeUndefined();
  });
});
