/**
 * The invariant SPEC §1.3 states and `--strict` is supposed to enforce: every degradation
 * is visible, and something can fail on it.
 *
 * This file exists because the invariant was broken for a whole phase in a way no test
 * could have caught, because `--strict` keyed on `lossy` alone. A model that was asked for
 * and never reached lost nothing — the deterministic answer is the right answer — so no
 * `lossy` diagnostic was appropriate, and therefore no exit code could ever reflect it.
 * The degradation was invisible to the flag whose entire purpose is to catch degradation,
 * **by construction**, whatever any diagnostic said.
 */
import { describe, expect, it } from "vitest";
import { DiagnosticBag, DiagnosticCode } from "../src/diagnostics.js";

const PRODUCER = { kind: "rule" as const, name: "test", version: "0" };

describe("a degradation that loses nothing", () => {
  it("is excluded from lossy() and included in strictFailing()", () => {
    const bag = new DiagnosticBag(PRODUCER);
    bag.capabilityUnavailable(
      DiagnosticCode.LLM_CALL_FAILED,
      "the model was requested and could not be reached; the deterministic result stands",
    );

    // Both halves matter. If it were `lossy` the count would be wrong and `lossyCount` in
    // the JSON envelope would claim content was lost when none was. If it were absent from
    // `strictFailing` nothing could fail on it, which is the original defect.
    expect(bag.lossy()).toHaveLength(0);
    expect(bag.strictFailing()).toHaveLength(1);
    expect(bag.strictFailing()[0]!.degraded).toBe(true);
    expect(bag.strictFailing()[0]!.lossy).toBe(false);
  });

  it("is a warning, not an error — the output is correct", () => {
    const bag = new DiagnosticBag(PRODUCER);
    bag.capabilityUnavailable(DiagnosticCode.LLM_CALL_FAILED, "unreachable");
    expect(bag.all()[0]!.severity).toBe("warning");
  });
});

describe("strictFailing is a widening, not a replacement", () => {
  it("still includes everything lossy", () => {
    const bag = new DiagnosticBag(PRODUCER);
    bag.lost(DiagnosticCode.LLM_CALL_FAILED, "thing", "a construct that could not be represented");
    expect(bag.lossy()).toHaveLength(1);
    expect(bag.strictFailing()).toHaveLength(1);
  });

  it("stays empty when nothing degraded, so --strict does not fire on a clean run", () => {
    const bag = new DiagnosticBag(PRODUCER);
    bag.info(DiagnosticCode.LLM_CALL_FAILED, "just so you know");
    // The control on the control: a widening that fired on `info` would make `--strict`
    // useless by failing every run, which is the same kind of defect as never firing.
    expect(bag.strictFailing()).toHaveLength(0);
  });
});
