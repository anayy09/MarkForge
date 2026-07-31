/**
 * Endpoint capability probing (SPEC §6.3, OPEN_QUESTIONS §3).
 *
 * Whether a gateway honours `response_format: {type:"json_schema"}` and `seed` is a
 * property of the deployment, not of anyone's intent, so it is discovered rather than
 * configured. `markforge check --llm` issues two throwaway calls and writes the answer
 * to `.markforge/llm-capabilities.json`, which is gitignored because it describes one
 * deployment on one day.
 *
 * The guided-decoding probe is **hostile on purpose.** Asking for JSON and receiving
 * JSON proves nothing — a model does that unprompted. So the probe asks for one plain
 * English sentence and attaches a schema demanding an object with an enum field. If a
 * grammar is being enforced, the endpoint cannot comply with the prose request; if
 * `response_format` is being accepted and ignored, we get a sentence about cats. That
 * asymmetry is the only way to tell "supported" from "not rejected", and an earlier
 * design that checked for a 200 response would have reported guided decoding on any
 * endpoint tolerant enough to ignore an unknown field.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatClient } from "./client.js";
import { LlmTransportError } from "./client.js";

export interface LlmCapabilities {
  /** Which endpoint this describes: a probe result is not portable between them. */
  baseUrl: string;
  /** Which model answered. Capability can differ per model on a mixed gateway. */
  probedModel: string;
  /** `response_format: json_schema` is enforced, not merely tolerated. */
  guidedDecoding: boolean;
  /** `seed` is accepted rather than rejected as an unknown parameter. */
  seed: boolean;
  /**
   * When the probe ran, ISO 8601. A capability record describes one deployment on one
   * day, and a university gateway is redeployed without announcement — so this is not
   * bookkeeping, it is the field that lets a stale record be recognised as stale.
   */
  probedAt: string;
  /** What each probe actually observed, so a surprising result is auditable. */
  evidence: string[];
}

/**
 * How long a probe result is trusted.
 *
 * Seven days is a judgement, not a measurement: long enough that `check --llm` is not a
 * daily chore, short enough that a redeploy is noticed within a working week. The cost
 * of being wrong in one direction is two throwaway calls; in the other it is either a
 * silent downgrade to the repair loop or a `response_format` the deployment has stopped
 * accepting, which is the exact class of silent quality difference the probe exists to
 * prevent.
 */
export const CAPABILITIES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Assumed when no probe has run: the safe assumption is the weaker endpoint. */
export function conservativeCapabilities(baseUrl: string): LlmCapabilities {
  return {
    baseUrl,
    probedModel: "(unprobed)",
    guidedDecoding: false,
    seed: false,
    // The epoch, so that if this in-memory fallback is ever written to disk it reads as
    // already expired and provokes a real probe, rather than pinning "unprobed" in place
    // for a week.
    probedAt: new Date(0).toISOString(),
    evidence: [
      "No probe has run, so guided decoding and seed are assumed unavailable. " +
        "The repair loop is the primary mechanism until `markforge check --llm` says otherwise.",
    ],
  };
}

const PROSE_REQUEST =
  "Write one plain English sentence about cats. Prose only: no JSON, no code, no lists.";

const HOSTILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["catCount", "verdict"],
  properties: {
    catCount: { type: "integer" },
    verdict: { type: "string", enum: ["fluffy", "aloof"] },
  },
} as const;

/**
 * Two throwaway calls, as SPEC §6.3 specifies. Never counted against the run budget:
 * probing is a `check` operation, not conversion work.
 */
export async function probeCapabilities(
  client: ChatClient,
  baseUrl: string,
  model: string,
): Promise<LlmCapabilities> {
  const evidence: string[] = [];

  // --- Probe 1: is a JSON Schema enforced, or just not rejected?
  let guidedDecoding = false;
  try {
    const response = await client.chat({
      model,
      messages: [{ role: "user", content: PROSE_REQUEST }],
      temperature: 0,
      maxTokens: 120,
      jsonSchema: { name: "probe", schema: HOSTILE_SCHEMA as unknown as object },
    });
    const parsed = tryParse(response.content);
    if (
      parsed &&
      typeof parsed === "object" &&
      "catCount" in parsed &&
      "verdict" in parsed &&
      (parsed as { verdict: unknown }).verdict !== undefined
    ) {
      guidedDecoding = true;
      evidence.push(
        `Guided decoding: enforced. A prose-only request answered with schema-valid JSON ` +
          `(${JSON.stringify(response.content).slice(0, 80)}), which only happens when a ` +
          `grammar constrains the sampler.`,
      );
    } else {
      evidence.push(
        `Guided decoding: unavailable. response_format was accepted but the answer was ` +
          `prose, so the schema was ignored. The repair loop is the primary mechanism.`,
      );
    }
  } catch (error) {
    assertConclusive(error, "guided decoding");
    const status = error instanceof LlmTransportError ? error.status : 0;
    evidence.push(
      `Guided decoding: unavailable. The endpoint rejected response_format ` +
        `(HTTP ${status}): ${(error as Error).message}`,
    );
  }

  // --- Probe 2: is `seed` a parameter this endpoint knows, or one it swallows?
  //
  // Sending a *valid* seed proves nothing, for the same reason probe 1 does not check for
  // a 200: this gateway — like most — ignores parameters it does not recognise, so a valid
  // seed and a nonsense parameter both come back 200. The discriminating test is a
  // deliberate type error. An endpoint that validates `seed` rejects `"not-a-number"` and
  // names the field; an endpoint that never looked at it answers the prompt happily.
  //
  // The first version of this probe sent a valid seed and reported support from the
  // response's shape. It reported "rejected" on a deployment where `seed` demonstrably
  // works, because a reasoning model spent the token ceiling on reasoning and returned
  // empty content — a probe that fails for a reason unrelated to what it is probing.
  let seed = false;
  try {
    await client.chat({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      temperature: 0,
      maxTokens: 16,
      seed: "not-an-integer" as unknown as number,
    });
    evidence.push(
      `Seed: unavailable. A deliberately invalid seed ("not-an-integer") was accepted, ` +
        `which means the parameter is being ignored rather than honoured.`,
    );
  } catch (error) {
    assertConclusive(error, "seed support");
    const status = error instanceof LlmTransportError ? error.status : 0;
    const detail = error instanceof LlmTransportError ? (error.detail ?? "") : "";
    if (status === 400 && /seed/i.test(detail)) {
      seed = true;
      evidence.push(
        `Seed: accepted. An invalid seed was rejected with HTTP 400 naming the field, so ` +
          `the endpoint validates it rather than discarding it. Note what this does *not* ` +
          `establish: at temperature 0 a seed's effect is unobservable, so this says the ` +
          `parameter is honoured, not that sampling is reproducible because of it.`,
      );
    } else {
      evidence.push(
        `Seed: unavailable. The probe call failed for an unrelated reason ` +
          `(HTTP ${status}): ${(error as Error).message}`,
      );
    }
  }

  return {
    baseUrl,
    probedModel: model,
    guidedDecoding,
    seed,
    probedAt: new Date().toISOString(),
    evidence,
  };
}

/**
 * Refuses to draw a capability conclusion from a failure that is about something else.
 *
 * The first run of this probe against a deliberately wrong key reported "guided decoding
 * unavailable" and **wrote that to the capabilities file** — so a typo'd key would have
 * left a persistent, confident, wrong claim about the endpoint, and every later run would
 * have quietly used the weaker path. Exactly the silent wrongness probing exists to
 * prevent.
 *
 * Only two outcomes are evidence about a parameter: the endpoint honoured it, or the
 * endpoint rejected *it* with a 400. Authentication, rate limiting, a missing model, a
 * gateway error, and a dead network are all "ask again later".
 */
function assertConclusive(error: unknown, probing: string): void {
  const status = error instanceof LlmTransportError ? error.status : 0;
  if (status === 400) return; // a rejection of the parameter itself: conclusive
  const reason =
    status === 401 || status === 403
      ? `the key was refused (HTTP ${status})`
      : status === 404
        ? `the model or endpoint was not found (HTTP 404)`
        : status === 429
          ? `the endpoint rate-limited the probe (HTTP 429)`
          : status === 0
            ? `the endpoint could not be reached`
            : `the endpoint returned HTTP ${status}`;
  throw new Error(
    `cannot determine ${probing}: ${reason}. Nothing was recorded, because a capability ` +
      `file written from a failure like this one would be a confident wrong answer that ` +
      `every later run inherits. Fix the endpoint or the credential and probe again. ` +
      `Underlying error: ${(error as Error).message}`,
  );
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

export function saveCapabilities(path: string, capabilities: LlmCapabilities): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(capabilities, null, 2) + "\n", "utf8");
}

/**
 * Reads a previous probe, if it still describes the endpoint we are about to use.
 *
 * Two ways a record stops being evidence, and both discard it rather than trusting it:
 *
 *   1. **The endpoint moved.** Pointing at a new gateway and inheriting the old one's
 *      capabilities is exactly the silent wrongness the probe exists to prevent.
 *   2. **The record went stale.** A capability is a property of a deployment, and a
 *      university gateway is redeployed without announcement. An expired record would
 *      either downgrade us to the repair loop for no reason, or keep sending a
 *      `response_format` the deployment no longer accepts.
 *
 * A record with no `probedAt`, or an unparseable one, is treated as expired — it was
 * written by an older build that could not express its own age, so its age is unknown,
 * and unknown age is not evidence.
 */
export function loadCapabilities(
  path: string,
  baseUrl: string,
  options: { maxAgeMs?: number; now?: number } = {},
): LlmCapabilities | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LlmCapabilities;
    if (parsed.baseUrl !== baseUrl) return undefined;
    if (typeof parsed.guidedDecoding !== "boolean" || typeof parsed.seed !== "boolean") return undefined;

    const maxAgeMs = options.maxAgeMs ?? CAPABILITIES_MAX_AGE_MS;
    const probedAt = typeof parsed.probedAt === "string" ? Date.parse(parsed.probedAt) : NaN;
    if (Number.isNaN(probedAt)) return undefined;
    const age = (options.now ?? Date.now()) - probedAt;
    // A future timestamp means a clock changed under us, which is no more trustworthy
    // than an expired one.
    if (age < 0 || age > maxAgeMs) return undefined;

    return parsed;
  } catch {
    return undefined;
  }
}

export const CAPABILITIES_PATH = ".markforge/llm-capabilities.json";
