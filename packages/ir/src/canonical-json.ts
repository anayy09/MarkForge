/**
 * Canonical JSON, per docs/SPEC.md §2.7.
 *
 * Every hash in MarkForge is taken over this form, and the on-disk `.mfir.json`
 * uses it too. The rules exist so that two machines serialising the same document
 * produce the same bytes:
 *
 *   - UTF-8 output
 *   - all strings NFC-normalised
 *   - object keys sorted by Unicode code point
 *   - no insignificant whitespace
 *   - numbers in shortest round-trip form
 *   - absent keys omitted, so absent and null stay distinguishable
 *
 * `JSON.stringify` gets three of the six right. The differences that matter are key
 * order (insertion order, not sorted), NFC (untouched), and `undefined` handling in
 * arrays (becomes `null`, which would silently turn an absent value into a present
 * one).
 */

/**
 * Sort by UTF-16 code unit is *not* the same as sort by Unicode code point: for
 * astral characters, surrogate pairs order before U+E000..U+FFFF in UTF-16 but
 * after them by code point. Keys are usually ASCII, so this almost never differs —
 * which is exactly why it must be handled explicitly rather than left to luck. A
 * document with an emoji key would otherwise hash differently depending on which
 * comparison the engine happened to use.
 */
function compareCodePoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ac = ai[i]!.codePointAt(0)!;
    const bc = bi[i]!.codePointAt(0)!;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

/**
 * Shortest round-trip form. `String(n)` is already shortest-round-trip in every
 * ECMAScript engine (the spec pins Number::toString to that algorithm), so the
 * work here is rejecting values JSON cannot represent, and normalising -0.
 *
 * -0 serialises as "0": JSON has no negative zero, and letting it through would
 * make `-0` and `0` hash differently while comparing equal with `===`.
 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `canonicalJson: ${String(n)} is not representable in JSON. ` +
        `NaN and Infinity in an IR document indicate a computation bug upstream, ` +
        `so this throws rather than emitting null.`,
    );
  }
  if (n === 0) return "0";
  return String(n);
}

function normalizeString(s: string): string {
  return s.normalize("NFC");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatNumber(value);
    case "string":
      return JSON.stringify(normalizeString(value));
    case "bigint":
      throw new TypeError(`canonicalJson: bigint at ${path} is not representable in JSON`);
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} at ${path} is not serialisable`);
    case "undefined":
      // Only reachable inside an array; object properties are filtered before this.
      throw new TypeError(
        `canonicalJson: undefined at ${path}. In an array it cannot be omitted without ` +
          `changing the indices, and encoding it as null would turn an absent value into ` +
          `a present one.`,
      );
  }

  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => encode(v, `${path}[${i}]`)).join(",") + "]";
  }

  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new TypeError(
      `canonicalJson: ${value.constructor.name} at ${path} has no canonical JSON form. ` +
        `Convert it to a plain value first — an implicit conversion here would be a ` +
        `silent decision about representation.`,
    );
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    // Absent keys are omitted. This is the rule that keeps absent distinguishable
    // from null, which the IR relies on: `alt: null` on an image means "explicitly
    // no alt text" while an absent `alt` means "unknown".
    .filter((k) => obj[k] !== undefined)
    .sort(compareCodePoints);

  const parts = keys.map(
    (k) => JSON.stringify(normalizeString(k)) + ":" + encode(obj[k], `${path}.${k}`),
  );
  return "{" + parts.join(",") + "}";
}

/** Serialise to canonical JSON. Throws on values with no canonical form. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

/**
 * Canonical JSON as UTF-8 bytes, which is what actually gets hashed. Kept separate
 * so no caller has to remember the encoding.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * Pretty-printed canonical form for the on-disk `.mfir.json`: identical key order
 * and identical string normalisation, but indented so a human can read a diff.
 *
 * Hashes are always taken over `canonicalJson`, never over this — the two differ
 * only in whitespace, and pinning hashing to the compact form means an
 * indentation change can never alter an id.
 */
export function canonicalJsonPretty(value: unknown, indent = 2): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, indent) + "\n";
}
