/**
 * The negative control shared by the four `--check` generator gates.
 *
 * `build-messy-fixtures`, `build-agentify-corpus`, `build-reference-templates`, and
 * `build-scanned-fixtures` all answer one question — do the committed bytes still match the
 * generator — and the Phase 6 gate audit found none of the four could demonstrate a failure.
 * They share a shape, so they share a control rather than growing four that drift.
 *
 * Two ways a byte-comparison gate goes quiet, and the control covers both:
 *
 *   1. **Vacuity.** The generator produces nothing, `stale` stays 0, and the gate reports
 *      "all N fixtures match" with N = 0. This is `check-degradation.mjs`'s annotation search
 *      finding its own annotation, arrived at from the other side: the loop ran and had
 *      nothing to run over. A floor is the only thing that catches it.
 *
 *   2. **A comparison that stopped comparing.** `committed.every((b, i) => b === bytes[i])`
 *      is true for every `i` in an empty array, and `Buffer` versus `Uint8Array` versus
 *      string each have a way to make an equality look right while reading past the data.
 *      The control mutates exactly one byte and asserts the gate's own predicate calls it
 *      different — one byte, not a truncation, because a comparison that notices a missing
 *      half can still miss a flipped bit.
 */

/** The byte equality every generator gate uses. Defined once so the control tests the real one. */
export const bytesEqual = (a, b) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * @param {object} o
 * @param {Record<string, Uint8Array|string>} o.artifacts what the generator produced this run
 * @param {number} o.floor  the fewest artifacts a healthy run produces
 * @param {(m: string) => void} o.ok
 * @param {(m: string) => void} o.fail
 */
export function generatorControl({ artifacts, floor, ok, fail }) {
  const names = Object.keys(artifacts);

  if (names.length >= floor) {
    ok(`${names.length} artifact(s) generated, so the comparison is not vacuous`);
  } else {
    fail(
      `only ${names.length} artifact(s) generated, below the floor of ${floor}. ` +
        `A generator that produces nothing reports every committed file as matching.`,
    );
    return;
  }

  // Mutate exactly one byte of the first artifact and assert the gate's predicate notices.
  const [name] = names;
  const original = artifacts[name];

  if (typeof original === "string") {
    if (original.length === 0) {
      fail(`negative control: ${name} is empty, so a one-character mutation cannot be made`);
      return;
    }
    const mutated = (original[0] === "x" ? "y" : "x") + original.slice(1);
    if (mutated !== original) ok(`a one-character change to ${name} is detected`);
    else fail(`negative control: a one-character change to ${name} compared equal`);
    return;
  }

  if (original.byteLength === 0) {
    fail(`negative control: ${name} is zero bytes, so a one-byte mutation cannot be made`);
    return;
  }
  const mutated = Uint8Array.from(original);
  mutated[0] = mutated[0] ^ 0x01;
  if (!bytesEqual(mutated, original)) ok(`a one-byte change to ${name} is detected`);
  else fail(`negative control: a one-byte change to ${name} compared equal`);
}
