# ADR-0019: No tokenizer is bundled; `modelTokenizer` refuses rather than approximating

- Status: **Accepted** — flagged for reversal in `OPEN_QUESTIONS.md` §7l
- Date: 2026-07-31
- Relates to: `SPEC.md` §10.5; brief §6.1, §13
- Enforced by: scripts/check-agentify.mjs

## Context

`SPEC.md` §10.5 requires per-target token counting and is specific about why: "for targets
whose consumer model is known, the model's own tokenizer; otherwise a documented
approximation, **with the method named in the report so no one mistakes an estimate for a
measurement**." The target schema encodes both options —
`budget.counter.method: "modelTokenizer" | "approximate"`.

Bundling a real tokenizer means a dependency. `js-tiktoken` or `gpt-tokenizer` covers OpenAI
BPE; neither covers the models this project actually points at. The NaviGator catalogue's
`gpt-oss-120b`, `nemotron-3-super-120b-a12b`, and `gemma-4-31b-it` use three different
tokenizers, none of them `cl100k_base`, and the agent files being budgeted are read by Claude
Code, Codex, Cursor, and others — a *fourth* set. Brief §13 forbids adding a dependency
without a one-line justification, and the honest justification here would have to be "it
gives a precise count for a tokenizer none of our consumers use", which is worse than an
approximation because it looks authoritative.

## Decision

**No tokenizer is bundled.** Every shipped profile declares
`counter: { method: "approximate", charsPerToken: 3.8 }`, and `counterDescription()` renders
that in the run report and in `AGENTIFY.md` as *"approximate (3.8 characters per token) — an
estimate, not a measurement"*.

**`modelTokenizer` throws by name.** `countTokens` refuses a profile asking for a tokenizer
that is not present, naming the target, the requested model, and this ADR. It does not fall
back to the approximation.

That refusal is the whole decision. Falling back silently would put an estimate in the report
under the name of a measurement, which is the one thing §10.5's sentence exists to prevent —
and the failure would be invisible, because an approximate count and a real one look identical
in a table. A budget is a safety margin; being quietly wrong about it means an agent file that
overflows its consumer's context, which surfaces as the model ignoring the end of the file
rather than as an error.

The schema keeps `modelTokenizer` so that adding one later is a profile edit rather than a
schema migration.

## Rejected alternatives

**Bundle `js-tiktoken` and use it for everything.** Rejected: it would report `cl100k_base`
counts for Claude, Gemini, and three NVIDIA models, with the confident label
`modelTokenizer`. Precisely wrong beats approximately right here, because the label is what
a reader trusts.

**Silently fall back to the approximation when no tokenizer is available.** Rejected above,
and it is the same class of defect as OPEN_QUESTIONS §7d's capability probe, which wrote a
confident wrong claim to disk after an auth failure. A component that cannot do what it was
asked should say so.

**Drop `modelTokenizer` from the schema entirely.** Rejected: the distinction is real and
will matter as soon as one consumer's tokenizer is worth shipping. A schema that cannot
express the better option would make adding it a breaking change.

**Count words, or characters, with no conversion.** Rejected: budgets are stated in tokens
by every vendor that states one, so a unit conversion has to happen somewhere. Doing it in
the open with a named ratio is better than making every profile author do it in their head.

## Consequences

- Every token figure in `AGENTIFY.md` and every run report is labelled an estimate. None of
  them is a measurement, and none of them claims to be.
- 3.8 characters per token is a reasonable English-prose figure and is **not calibrated
  against any of the models named above.** Calibrating it would need a tokenizer, which is
  the thing being declined; if the ratio matters more later, that is the moment to revisit.
- Budget overflow decisions inherit the estimate's error. `linkToSecondary` makes this cheap
  — being wrong moves a unit to a linked file — and it is the default for that reason.
  `truncateLowestValue` makes an estimation error into real loss, which is why the two
  profiles using it are the two with the smallest, most bounded content.
- A profile can opt into `modelTokenizer` today and will get a clear error naming this ADR,
  which is the intended way to discover the limit.
