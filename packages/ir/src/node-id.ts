/**
 * Content-addressed node ids, per docs/SPEC.md §2.7 and ADR-0014.
 *
 *   localDigest(node) = sha256(canonicalJson({ type, salientAttrs, children: childIds }))
 *   NodeId            = "n_" + base32lower(localDigest).slice(0, 20) + ":" + occurrence
 *
 * Computed bottom-up, so an edit to one paragraph changes that paragraph's id and
 * its ancestors' ids and nothing else. That property is the whole point: it is what
 * makes incremental regeneration produce a minimal diff instead of renumbering
 * everything after the edit, which a positional scheme (`/body/children/3`) would.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "./canonical-json.js";
import { salientAttrsFor } from "./salient.js";

/** RFC 4648 base32 alphabet, lowercased. No padding — the output is truncated anyway. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Base32 rather than hex because it packs 5 bits per character instead of 4, so 20
 * characters carry 100 bits of the digest rather than 80. Lowercase because ids
 * appear in file paths and in generated Markdown, and case-insensitive filesystems
 * would otherwise let two distinct ids collide.
 */
export function base32lower(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * SHA-256, from `@noble/hashes` rather than `node:crypto`.
 *
 * Node ids are synchronous by construction — `localDigest` is called bottom-up during a
 * tree walk — and the browser has no synchronous SHA-256 at all: `crypto.subtle.digest`
 * is async, and making ids async would change every call site in every package to buy
 * one platform. `@noble/hashes` is MIT, dependency-free, audited, and sync, so it is the
 * whole of the fix — the one-line justification a new dependency owes is that sentence.
 *
 * Used in Node too, deliberately. Two implementations chosen by platform would be two
 * things that must agree about every byte forever, and the agreement would be untested
 * on whichever platform CI did not run. One implementation cannot disagree with itself.
 */
const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function sha256Hex(input: string | Uint8Array): string {
  return hex(sha256(typeof input === "string" ? utf8.encode(input) : input));
}

function sha256Bytes(input: string): Uint8Array {
  return sha256(utf8.encode(input));
}

/** Any node-shaped object. Deliberately loose: this runs before ids are assigned. */
interface NodeLike {
  type: string;
  id?: string;
  children?: NodeLike[];
  [key: string]: unknown;
}

/** Child-bearing properties other than `children`, which also feed the digest. */
const CHILD_KEYS = ["children", "body"] as const;

function childrenOf(node: NodeLike): NodeLike[] {
  const out: NodeLike[] = [];
  for (const key of CHILD_KEYS) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === "object" && typeof c.type === "string") out.push(c);
    }
  }
  return out;
}

/**
 * The digest of a node's subtree, in hex. This is also `contentHash` (SPEC §2.7):
 * change-detection and identity are different jobs, but they are derived from the
 * same value, so computing them twice would be a way for them to disagree.
 */
export function localDigest(node: NodeLike, childIds: string[]): string {
  const salient = salientAttrsFor(node.type);
  const payload: Record<string, unknown> = { type: node.type };
  for (const key of salient) {
    // `children` is never in x-salient; children contribute as ids, below.
    if (key === "type") continue;
    const v = node[key];
    if (v !== undefined) payload[key] = v;
  }
  payload["children"] = childIds;
  return sha256Hex(canonicalJson(payload));
}

/**
 * Assigns `id` to every node in a tree, in place, bottom-up. Returns the number
 * assigned.
 *
 * `occurrence` disambiguates genuinely identical content — two `Yes` cells in a
 * table have the same digest and must still be distinct nodes. It is assigned in
 * document order, so it is stable as long as the identical siblings stay in the
 * same relative order.
 */
export function assignIds(root: NodeLike): number {
  const occurrences = new Map<string, number>();
  let count = 0;

  const visit = (node: NodeLike): string => {
    const childIds = childrenOf(node).map(visit);
    const digest = localDigest(node, childIds);
    const prefix = "n_" + base32lower(hexToBytes(digest)).slice(0, 20);
    const occurrence = occurrences.get(prefix) ?? 0;
    occurrences.set(prefix, occurrence + 1);
    const id = `${prefix}:${occurrence}`;
    node.id = id;
    (node as { contentHash?: string }).contentHash = digest;
    count++;
    return id;
  };

  visit(root);
  return count;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Recomputes ids and reports which changed. Used by incremental regeneration to
 * find the affected subtree without diffing the whole document.
 */
export function reassignIds(root: NodeLike): { changed: string[]; total: number } {
  const before = new Map<NodeLike, string | undefined>();
  const collect = (n: NodeLike): void => {
    before.set(n, n.id);
    for (const c of childrenOf(n)) collect(c);
  };
  collect(root);

  const total = assignIds(root);
  const changed: string[] = [];
  for (const [node, oldId] of before) {
    if (oldId !== undefined && node.id !== oldId) changed.push(oldId);
  }
  return { changed, total };
}

/** Parses an id into its digest prefix and occurrence, or null if malformed. */
export function parseNodeId(id: string): { prefix: string; occurrence: number } | null {
  const m = /^n_([a-z2-7]{20}):(\d+)$/.exec(id);
  if (!m) return null;
  return { prefix: m[1]!, occurrence: Number(m[2]!) };
}

export const NODE_ID_PATTERN = /^n_[a-z2-7]{20}:\d+$/;

/** Digest of raw bytes, for source files and resources (SPEC §2.2). */
export function contentHashOfBytes(bytes: Uint8Array): string {
  return hex(sha256(bytes));
}

export { sha256Bytes };
