import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { canonicalJson, canonicalBytes } from "../src/canonical-json.js";

// A fixed seed, deliberately. fast-check defaults to a random one per run, which finds
// bugs well and keeps them found badly: a normalize non-idempotency was caught on CI
// and not locally purely because the seeds differed. Pinning makes a pass mean the same
// thing on every machine. Counterexamples are kept as named cases, which is what
// actually keeps a fixed bug fixed; to hunt for new ones, drop the seed locally.
const SEED = 20260731;


describe("canonicalJson", () => {
  it("sorts object keys by code point, not insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalJson({ c: 3, a: 2, b: 1 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("orders astral keys by code point rather than UTF-16 code unit", () => {
    // "\u{1F600}" is above "�" by code point but below it as UTF-16 units,
    // because its surrogate pair starts at 0xD83D. Naive sorting gets this backwards.
    const out = canonicalJson({ "\u{1F600}": 1, "�": 2 });
    expect(out).toBe('{"�":2,"\u{1F600}":1}');
  });

  it("omits absent keys but preserves null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("NFC-normalises strings and keys", () => {
    const decomposed = "é"; // e + combining acute
    const composed = "é";
    expect(canonicalJson({ k: decomposed })).toBe(canonicalJson({ k: composed }));
    expect(canonicalJson({ [decomposed]: 1 })).toBe(canonicalJson({ [composed]: 1 }));
  });

  it("normalises negative zero, which JSON cannot represent", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("throws on values with no canonical form rather than guessing", () => {
    expect(() => canonicalJson(NaN)).toThrow(/not representable/);
    expect(() => canonicalJson(Infinity)).toThrow(/not representable/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson(new Date())).toThrow(/no canonical JSON form/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  // The property that actually matters: canonical form is a function of value, not
  // of how the value was built. Two objects that are deep-equal must serialise
  // identically regardless of key insertion order at any depth.
  it("is order-independent for deep-equal values", () => {
    const jsonValue = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie("value"), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
      ),
    })).value;

    fc.assert(
      fc.property(jsonValue, (v) => {
        const reshuffle = (x: unknown): unknown => {
          if (Array.isArray(x)) return x.map(reshuffle);
          if (x && typeof x === "object") {
            const entries = Object.entries(x as Record<string, unknown>).reverse();
            const out: Record<string, unknown> = {};
            for (const [k, val] of entries) out[k] = reshuffle(val);
            return out;
          }
          return x;
        };
        expect(canonicalJson(reshuffle(v))).toBe(canonicalJson(v));
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("round-trips through JSON.parse", () => {
    const jsonValue = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.string(),
        fc.array(tie("value"), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
      ),
    })).value;

    fc.assert(
      fc.property(jsonValue, (v) => {
        const once = canonicalJson(v);
        const twice = canonicalJson(JSON.parse(once));
        expect(twice).toBe(once);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("produces UTF-8 bytes", () => {
    expect(new TextDecoder().decode(canonicalBytes({ a: "é" }))).toBe('{"a":"é"}');
  });
});
