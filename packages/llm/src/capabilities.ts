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
  /** What each probe actually observed, so a surprising result is auditable. */
  evidence: string[];
}

/** Assumed when no probe has run: the safe assumption is the weaker endpoint. */
export function conservativeCapabilities(baseUrl: string): LlmCapabilities {
  return {
    baseUrl,
    probedModel: "(unprobed)",
    guidedDecoding: false,
    seed: false,
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

  return { baseUrl, probedModel: model, guidedDecoding, seed, evidence };
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
 * Reads a previous probe, if it describes the endpoint we are about to use.
 *
 * A cached probe for a different `baseUrl` is discarded rather than trusted: pointing
 * at a new gateway and inheriting the old one's capabilities is exactly the silent
 * wrongness the probe exists to prevent.
 */
export function loadCapabilities(path: string, baseUrl: string): LlmCapabilities | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LlmCapabilities;
    if (parsed.baseUrl !== baseUrl) return undefined;
    if (typeof parsed.guidedDecoding !== "boolean" || typeof parsed.seed !== "boolean") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export const CAPABILITIES_PATH = ".markforge/llm-capabilities.json";
