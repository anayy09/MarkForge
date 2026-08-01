# ADR-0009: LLM access — OpenAI-compatible client, three named models, no registry

- Status: **Confirmed** (the descoping in this record was decided by the reviewer, 2026-07-30)
- Date: 2026-07-29, amended 2026-07-30
- Relates to: brief §7.2, §7.3, §3.6; `SPEC.md` §6
- Enforced by: scripts/check-docs.mjs

## Context

Brief §7.2 requires an OpenAI-compatible client abstraction so self-hosted endpoints work
identically to hosted APIs, credentials from environment variables only, and a model registry
generated from `Navigator-Models.xlsx` carrying cost tier, latency tier, hosted-vs-local, and
structured-output tags, plus a cost-aware routing policy. Brief §3.6 requires that any network
call be opt-in and explicit, never a default.

The spreadsheet was read rather than assumed (brief §7.2 insists on this): one sheet
`available-models`, range `A1:H22`, 21 model rows, columns `Model Name | Model Path |
Category | Architecture | Model Size | Input Modalities | Output Modalities | Context
Window`. The endpoint is UF NaviGator AI at `https://api.ai.it.ufl.edu/v1`, OpenAI-compatible,
with models addressed by `Model Name`.

Reading it surfaced the problem with the brief's design: **four of the tags §7.2 requires are
not in the sheet**, and three of them are unknowable — the gateway publishes no pricing and no
latency data. A registry built from it would carry two derived columns and four invented ones,
and the routing policy would rank 21 models on fabricated cost tiers. The reviewer resolved
this by descoping rather than by sourcing the missing data: *"the only motive of the navigator
models is to select some powerful models... and use them, as simple as that. No need for a
registry and all."*

## Decision

**One transport: an OpenAI-compatible chat-completions client.** No provider-specific SDKs,
no provider branching in application code.

**No model registry, no routing policy file, no generator script, no capability tags.** The
entire configuration is a URL, an env-var *name*, and three model names:

```ts
llm: {
  enabled: false,
  baseUrl: "https://api.ai.it.ufl.edu/v1",
  apiKeyEnv: "MODEL_API_KEY",
  models: { fast: "gpt-oss-120b", strong: "nemotron-3-super-120b-a12b", vision: "gemma-4-31b-it" },
}
```

- **Three roles, `fast | strong | vision`**, each a bare string passed through as the OpenAI
  `model` parameter. The task → role mapping is **fixed in code** (`SPEC.md` §6.2); the model
  name per role is the only configurable part. Adding or swapping a model is a one-string edit.
- **`Navigator-Models.xlsx` is not a build input.** It was read once to pick the three
  defaults. No code reads it, nothing is generated from it, and it appears in no dependency
  graph. The inventory stays in `OPEN_QUESTIONS.md` §1 as a record of what was available at
  decision time, nothing more.
- Credentials are read from the environment variable named by `llm.apiKeyEnv`, default
  `MODEL_API_KEY` to match the convention already in use in the reviewer's other projects
  against this gateway. The key value never appears in config or in any committed artifact.
- `llm.enabled` defaults to `false`, and the config schema requires `baseUrl`, `apiKeyEnv`,
  and all three `models` entries when it is `true` — so enabling the LLM cannot half-happen.
  A missing env var at that point is a startup error, never a silent downgrade to `--no-llm`.
- **Budget is token-based only.** No `maxUsd`, because a dollar ceiling would be computed from
  numbers we do not have.
- **No fallback chains.** A failed call after its repair attempts fails, and the deterministic
  fallback for that task applies with a diagnostic.
- Structured output is requested via JSON Schema and validated with `ajv`, with a bounded
  repair loop (default 2 attempts). Model responses are never regex-parsed (brief §7.3).
  Whether the gateway accepts `response_format` and `seed` is **probed once and cached**
  (`SPEC.md` §6.3) rather than configured, since it is a property of the deployment.
- Every LLM-derived node carries `producedBy: {kind:"model", model, promptVersion}`, which is
  the only `Producer` variant permitted outside the deterministic core — making
  "did a model touch this document" a machine-checkable question.
- `@markforge/adapters-*` and `@markforge/render-*` may not depend on `@markforge/llm`,
  enforced in CI (ADR-0007).

## Rejected alternatives

**Provider-specific SDKs** (`@anthropic-ai/sdk`, `openai`, `@google/genai`) behind an internal
interface. Better ergonomics and access to provider-only features such as prompt caching or
extended thinking. Rejected: it multiplies dependencies, and the actual deployment target is a
self-hosted OpenAI-compatible gateway where those features are unavailable anyway. Brief §7.2
asks specifically for self-hosted endpoints to work identically to hosted ones, and one
transport is how that is achieved rather than approximated.

**A framework abstraction layer** (LangChain, Vercel AI SDK, LiteLLM). Rejected under brief
§13's rule that no abstraction layer is added without justification. Our LLM surface is small
and fixed — chat completion with a JSON schema and a cache — and a framework would add a large
dependency plus its own opinions about retries, prompt templating, and tracing, all of which
we specify differently.

**Reading endpoint or credential data from the spreadsheet.** Rejected explicitly by brief
§7.2, and now moot — nothing reads the spreadsheet at all.

**Defaulting `llm.enabled` to true when an API key is present in the environment.** Convenient
and a common pattern. Rejected: brief §3.6 says network access is never a default, and
"an environment variable happens to be set" is not explicit user intent.

**The generated registry and cost-aware routing policy of brief §7.2.** This is the
alternative the brief actually specified, so it gets the fullest treatment. It would have
given per-model capability tags, fallback chains, and a dollar budget ceiling. Rejected on
the reviewer's instruction, and the instruction is right on the merits: three of the four
required tags are unknowable from the gateway, so the registry's routing-relevant columns
would have been invented, and invented capability data is worse than absent capability data
because it looks authoritative. A `routing.policy.json` ranking 21 models on fabricated cost
tiers is ceremony that obscures a two-line decision. The genuine costs of descoping are
stated in Consequences below rather than hidden.

**Trusting the spreadsheet for capability tags it does not contain**, i.e. inferring cost and
latency tier from model size or architecture. Rejected for the same reason, and this was
rejected before the descoping too: a guess presented as a capability tag would have driven
routing decisions and budget ceilings on invented data.

**Keeping a registry but with only the honest columns** (`vision`, `contextWindow`,
`category`). Considered as a middle path. Rejected: with cost and latency gone, what remains
does not determine any routing decision that the three-role mapping does not already make.
It would be a data file that exists to be data.

## Consequences

- **Model choice is a code-level decision, not a data-level one.** Changing which model
  handles synthesis means editing config or a default constant, and it will not be
  automatically informed by cost or capability. Accepted: the deployment is one gateway with
  a stable model list, and a human reads the list when they care.
- **Adding a fourth role means a code change**, not a config edit. If task-specific model
  selection turns out to matter more than expected, the roles map is where it grows — the
  three-role shape is the thing most likely to need revisiting, and it is cheap to widen.
- **No automatic recovery if a model is retired from the gateway.** A removed model produces
  a hard failure with a clear error rather than a silent substitution. This is deliberate
  (see the no-fallback-chains decision) but it does mean the gateway's model list changing
  under us is a user-visible break.
- Vendor-only features are unavailable. Acceptable given the deployment target.
- Everything downstream must assume competent open-weight models rather than frontier
  reasoning, since the catalog's strongest general model is `nemotron-3-super-120b-a12b`.
  This raises the importance of schema validation, the repair loop, and the mandatory
  verification gate of `SPEC.md` §10.6.
- Guided-decoding and `seed` support are discovered by probe (`SPEC.md` §6.3), so Phase 3 is
  no longer blocked on knowing them in advance. If guided decoding is absent the repair loop
  becomes the primary mechanism rather than a fallback — a quality difference that the probe
  makes visible in the run report instead of silent.
- The content-addressed cache (`SPEC.md` §6.3) means CI never calls the network, so provider
  behaviour cannot make the test suite flaky.
- The brief's `models.registry.json`, its generator script, and `routing.policy.json` are
  **not deliverables**. Phase 3 shrinks accordingly.
