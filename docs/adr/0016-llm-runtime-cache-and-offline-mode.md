# ADR-0016: LLM runtime — committable cache, offline `readOnly` mode, and what a failure means

- Status: **Accepted** (Phase 3)
- Date: 2026-07-31
- Relates to: brief §7.3, §3.6, §10; `SPEC.md` §6.3; [ADR-0009](0009-llm-openai-compatible-only.md)

## Context

ADR-0009 settled *what* the LLM layer talks to: one OpenAI-compatible endpoint, three model
names, no registry. It left the runtime open, and building it surfaced three questions that
the specification's phrasing does not answer on its own.

**First, the credential rule and the offline test suite contradict each other as written.**
ADR-0009 says a missing `$MODEL_API_KEY` while the LLM is enabled is a startup error, never a
downgrade. `SPEC.md` §6.3 says the response cache is committable "so CI is deterministic and
offline". Both cannot hold literally: an offline CI run has no key, so under the first rule it
cannot start, and under the second it must.

**Second, `seed` and `response_format` turned out to be supported** (`OPEN_QUESTIONS.md` §3),
which changes what reproducibility rests on and therefore what the cache key must contain.

**Third, "the prompt version participates in the cache key" is not sufficient.** A version is
a promise a human keeps by hand, and the failure mode is silent: edit `v1.md`, keep the name,
and every cached answer is now attributed to a prompt that no longer exists in the repository.

## Decision

**A key is required unless the cache is `readOnly`.** `readOnly` is not a performance setting;
it means *this run must not touch the network*. In that mode no client is constructed even if a
key is present, and a cache miss is a hard, named error (`CacheMissError`) rather than a call.
So both of ADR-0009's guarantees hold, restated precisely: the LLM never reaches the network
without explicit intent, and it never silently produces different output. Every LLM measurement
in `docs/FIDELITY.md` and every test in the suite runs this way.

**The cache key is `sha256(task + inputDigest + model + promptVersion + canonicalJson(params))`,
and `params` includes the prompt file's content digest and the repair attempt number.** The
content digest closes the unversioned-edit hole above: editing a prompt invalidates its cached
answers automatically, so a stale hit is impossible rather than merely discouraged. The attempt
number is there because a repair turn is a different request and must not collide with the
first one.

**Entries are one file each, pretty-printed, with no timestamp and no image bytes.**
One file per entry rather than an index, because two conversions writing an index would
conflict on the same line and a cache nobody can merge is a cache nobody commits. No
timestamp, for the same reason. Image bytes are replaced by their digest plus a short
`inputPreview`: a page scan is hundreds of kilobytes, the fixture is already in the repository,
and a cache entry should be readable in a pull request.

**A failure is always "no answer", never a failed conversion.** No retries, no substitute
model, no partial answers. A transport error, a schema violation surviving the repair loop, an
exhausted budget, and a cache miss in offline mode all resolve the same way: the deterministic
result stands, and a diagnostic records what did not happen (`MF-LLM-0001`). The budget refuses
a call *before* making it once the ceiling is spent, so the ceiling is a limit rather than a
notification. Cache hits never consume budget — they cost nothing, and charging them would make
a run's reported spend depend on cache state instead of on work done.

**Guided decoding and `seed` are used when the probe found them, and the mode is reported.**
`LlmRunReport.mode` is `"guided"` or `"prompted"`, so a quality difference is visible in the
run report rather than absorbed silently.

## Rejected alternatives

**Letting an offline run start without a key by treating a missing key as `readOnly`.** The
convenient reading, and it reintroduces exactly what ADR-0009 forbids: a run that quietly
behaves differently because an environment variable is absent. Requiring the mode to be stated
means the offline promise is something the user asked for.

**Keying the cache on the prompt version alone**, as `SPEC.md` §6.3 says literally. Rejected
because it makes reproducibility depend on a human remembering to rename a file, and the
failure is invisible: the cache returns an answer attributed to a prompt that no longer exists.
The version is kept for humans; the digest is what enforces it.

**Retrying transient failures.** A 429 or 503 is noise, and retrying it is the obvious
kindness. Rejected: it makes output depend on endpoint health, which is the same objection
ADR-0009 raises against fallback chains, and the deterministic fallback is already correct.
The repair loop is the only loop in the layer, and it exists because a schema violation is
*information* where a 503 is not.

**A single index file for the cache**, or SQLite. Simpler to read, and unmergeable. The cache
is meant to be committed and reviewed, which makes git the constraint that matters.

**Storing image bytes in vision cache entries** so an entry is self-contained. Rejected: it
doubles the repository size for every scanned fixture and makes the cache unreadable in a diff.
The digest is what the key needs; the fixture is what the bytes are for.

**Making the cache the default-off.** Considered for the sake of "no hidden state". Rejected:
without a cache on by default, the first thing every user discovers is that a conversion costs
tokens twice, and CI reproducibility becomes opt-in.

## Consequences

- **Editing a prompt file silently invalidates cached answers**, which is correct and does have
  a cost: re-recording the committed cache needs a key and a live gateway, and until it happens
  the affected measurements fall back to the deterministic path. The prompt digest makes this
  loud (a miss) rather than quiet (a stale hit), which is the trade being made.
- **`docs/FIDELITY.md`'s LLM rows are only as current as the committed cache.** A model
  improving on the gateway does not improve those numbers until someone re-records. That is the
  price of reproducible measurement, and the non-blocking drift job in CI is what notices.
- A run's token spend is reported but its *cost* is not, because the gateway publishes no
  pricing (ADR-0009). `budget.maxTokens` is the only ceiling.
- The cache directory is committable but not committed automatically. Whoever records entries
  decides whether they belong in the repository, and for the Phase 3 measurement subsets they
  do.
- `@markforge/llm` is Node-only: the cache and the prompt loader use `node:fs`. This is the
  degradation ADR-0015 already specifies for browser builds — LLM features unavailable, never
  silently different.
