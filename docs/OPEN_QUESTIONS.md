# Open Questions

Status: Phase 0 deliverable. Written 2026-07-29, revised 2026-07-30 after review.

**Nothing in this document currently blocks work.** All six questions raised at the end of
Phase 0 were answered on 2026-07-30. What remains is §7, the record of decisions made without
asking, and §8, questions that can only be answered by running code.

## Settled

| Question | Answer | Recorded in |
| --- | --- | --- |
| License | Apache-2.0 | [ADR-0008](adr/0008-license-apache-2.md) |
| PDF engine | Typst via `typst.ts` | [ADR-0003](adr/0003-pdf-engine-typst.md) |
| DOCX parse strategy | Own OOXML reader, not Mammoth (deviation from brief §5.2) | [ADR-0005](adr/0005-docx-adapter-own-ooxml-reader.md) |
| Phase 4 agent targets | `AGENTS.md` + `CLAUDE.md` first-class, plus Claude Code skills, slash commands, and MCP manifest | [ADR-0013](adr/0013-target-registry-agents-md-base.md) |
| Model registry, routing policy, capability tags | **Descoped.** No registry. A URL, an env-var name, and three model names | [ADR-0009](adr/0009-llm-openai-compatible-only.md), `SPEC.md` §6.1–6.2 |
| API key environment variable | `MODEL_API_KEY` | [ADR-0009](adr/0009-llm-openai-compatible-only.md) |
| Structured output and `seed` support | Probed at runtime, not configured or assumed | `SPEC.md` §6.3 |
| DOCX reference documents | Three authored, Apache-2.0; `academic-manuscript` primary, modelled on the IEEE conference template; no publisher template redistributed | [ADR-0004](adr/0004-docx-renderer.md), [TEMPLATES.md](TEMPLATES.md) |
| npm scope and publication | Deferred to future scope; not a Phase 0–4 concern | §5 below |
| Institutional IP constraints | None — personal, non-commercial | [ADR-0008](adr/0008-license-apache-2.md) |

---

## 1. LLM layer — resolved by descoping (was: blocking Phase 3)

**Asked:** confirm the `Navigator-Models.xlsx` column mapping, and supply the four capability
tags brief §7.2 requires that the sheet does not contain (cost tier, latency tier,
hosted-vs-local, structured-output support).

**Answered:** the registry premise was wrong. Per the reviewer, *"the only motive of the
navigator models is to select some powerful models... and use them, as simple as that. No need
for a registry and all."* The endpoint is `https://api.ai.it.ufl.edu/v1`, the key comes from
the environment, and the models are chosen by hand.

So `models.registry.json`, `routing.policy.json`, the generator script, the capability tags,
the column mapping, and `models.overrides.json` are **all descoped**. Three model names in
config replace them (`SPEC.md` §6.1):

| Role | Default | Used for |
| --- | --- | --- |
| `fast` | `gpt-oss-120b` | classification, extraction, alt text, heading tie-breaks |
| `strong` | `nemotron-3-super-120b-a12b` | synthesis, conflict analysis, glossary, summarization |
| `vision` | `gemma-4-31b-it` | scanned-page transcription, ambiguous table geometry |

`maxUsd` is gone from the budget; the ceiling is token-based, because the gateway publishes no
pricing (ADR-0009).

**The spreadsheet is no longer a project input at all.** It was read once, in-memory, to pick
those three defaults — which is what brief §7.2's "do not assume its schema" instruction was
protecting against, so the instruction was satisfied before the requirement it served was
dropped. Nothing generates from it, no code reads it, and it is absent from every dependency
graph. The inventory below is retained only as a record of what was available on 2026-07-29,
so a future reader can see what the three defaults were chosen *from*.

<details>
<summary>Inventory as read, 2026-07-29 — sheet <code>available-models</code>, range <code>A1:H22</code>, 21 models, columns <code>Model Name | Model Path | Category | Architecture | Model Size | Input Modalities | Output Modalities | Context Window</code></summary>

| Model Name | Category | Input | Context |
| --- | --- | --- | --- |
| `nemotron-3-super-120b-a12b` | General LLM | Text | 1M tokens |
| `nemotron-3-nano-30b-a3b` | General LLM | Text | 1M tokens |
| `gpt-oss-120b` | General LLM | Text | 128K tokens |
| `gpt-oss-20b` | General LLM | Text | 128K tokens |
| `llama-3.3-70b-instruct` | General LLM | Text | 128K tokens |
| `llama-3.1-70b-instruct` | General LLM | Text | 128K tokens |
| `llama-3.1-8b-instruct` | General LLM | Text | 128K tokens |
| `granite-3.3-8b-instruct` | General LLM | Text | 128K tokens |
| `mistral-7b-instruct` | General LLM | Text | 32K tokens |
| `gemma-4-31b-it` | General LLM | Text, Image, Video | 256K tokens |
| `gemma-3-27b-it` | General LLM | Text, Image | 128K tokens |
| `mistral-small-3.1` | General LLM | Text, Image | 128K tokens |
| `medgemma-27b-it` | Medical LLM | Text, Image | 128K tokens |
| `codestral-22b` | Code | Text | 32K tokens |
| `nomic-embed-text-v1.5` | Embedding | Text | 8K tokens |
| `sfr-embedding-mistral` | Embedding | Text | 32K tokens |
| `whisper-large-v3` | ASR | Audio | 30-second chunks |
| `kokoro` | TTS | Text | N/A |
| `flux.2-klein`, `flux.1-dev`, `flux.1-schnell` | Image Generation | Text | N/A |

</details>

One consequence worth carrying forward: **this catalog has no frontier model.** The strongest
general model is `nemotron-3-super-120b-a12b`. That is why the §10.6 traceability and
verification gates are mandatory with no bypass flag rather than advisory — the design assumes
competent-but-fallible open-weight models throughout.

## 2. API key environment variable — resolved

`MODEL_API_KEY`, matching the convention already in use in the reviewer's other projects
against this gateway, so one exported key serves all of them. The config field `llm.apiKeyEnv`
stores the variable *name*; the value never appears in config or in any committed artifact
(ADR-0009).

A missing variable while `llm.enabled` is `true` is a **startup error**, not a silent
downgrade to `--no-llm` — producing quietly different output would be worse than failing.

## 3. Structured outputs and `seed` — **answered by probing, 2026-07-31**

Whether the gateway accepts `response_format: {type:"json_schema"}` and `seed` is a property
of the deployment, not of anyone's intent, so it is **discovered, not configured**.
`markforge check --llm` issues two throwaway calls, records the result in
`.markforge/llm-capabilities.json`, and the client degrades to prompt-instructed JSON plus the
bounded repair loop when guided decoding is unavailable (`SPEC.md` §6.3). The run report states
which mode was used, so a quality difference is visible rather than silent.

**The answer, measured on 2026-07-31 against `https://api.ai.it.ufl.edu/v1`:**

| Capability | Answer | Evidence |
| --- | --- | --- |
| `response_format: {type:"json_schema"}` | **Supported and enforced** | A prose-only request (`"Write one plain English sentence about cats. No JSON."`) carrying a strict schema returned `{"catCount": 0, "verdict": "fluffy"}`. A grammar beat the prompt. |
| Guided decoding is a real grammar, not a filter | **Confirmed** | A schema with `"type": "not-a-real-type"` is rejected with `Grammar error: Invalid type`, so a grammar is compiled per request. The gateway is LiteLLM in front of vLLM. |
| `seed` | **Accepted and validated** | `seed: "not-a-number"` returns HTTP 400 `int_parsing … ('body', 'seed')`, while an unknown parameter (`bogus_param_xyz_9`) is silently ignored. The endpoint parses `seed`; it does not merely tolerate it. |
| Reproducibility at temperature 0 | **Observed, but not attributable to the seed** | Repeated identical calls returned identical content with *and* without a seed. Temperature 0 is doing the work; the seed's effect is unobservable and is not claimed. |

Verified on all three configured models — `gpt-oss-120b`, `nemotron-3-super-120b-a12b`, and
`gemma-4-31b-it` — not just the default. The consequence for design is the good one: the
repair loop is a genuine fallback here rather than the primary mechanism, which is what
ADR-0009's consequences section hoped for and could not assume.

**Two things the probe got wrong before it got them right**, recorded because they are the
kind of error a capability probe is uniquely able to make convincingly:

1. **Sending a *valid* seed proves nothing.** The first probe sent `seed: 20260731`, got a
   200, and concluded support. But this gateway ignores unknown parameters, so a valid seed
   and a nonsense field are indistinguishable from the response. The discriminating test is a
   deliberate type error, which only a validating endpoint rejects.
2. **A 401 is not evidence about a schema.** The first probe, run with a deliberately wrong
   key, reported "guided decoding unavailable" and **wrote that to the capabilities file** —
   a confident wrong answer that every later run would have inherited, produced by the one
   mechanism whose purpose is to prevent exactly that. `probeCapabilities` now refuses to
   conclude anything from an authentication failure, a rate limit, a missing model, or an
   unreachable endpoint: only a 400 rejecting the parameter, or a 200 honouring it, is
   evidence. Regression-tested in `packages/llm/test/llm.test.ts`.

This removes the item from the blocking list: Phase 3 did not need the answer in advance, and
now has it.

## 4. DOCX reference documents — resolved, with one deviation from the instruction

**Asked:** house templates, or author three from scratch?

**Answered:** use publicly available manuscript templates, because they are well formatted and
cover headings, subheadings, sections, and equations.

The reasoning is adopted in full and drove a real change: **`academic-manuscript.docx` is now
the primary shipped template and the Phase 1 round-trip gate document**, replacing
`technical-documentation` in that role, precisely because a manuscript template exercises the
most constructs in one file (`SPEC.md` §4.2.1).

**The template supplied:** the **IEEE conference proceedings template**, which is now the
structural model for `academic-manuscript.docx` ([TEMPLATES.md](TEMPLATES.md) §2.1) and lives
at `fixtures/local/ieee-conference-template.docx`, gitignored at the reviewer's direction.

**The deviation:** the shipped templates are *authored by us*, modelled on the IEEE template
rather than being a copy of it. IEEE publishes the conference templates for authors preparing
IEEE submissions and grants no redistribution right; the alternatives are no better, since
MDPI's CC BY covers its published *articles*, not its blank `.dot` file. Shipping any of them
inside an Apache-2.0 package would put an unrecorded licence assumption into a distributed
artifact reaching every user. ADR-0004 records this.

**The instruction gets its intended effect three ways**, so the deviation costs nothing:
the authored template reproduces the IEEE structure and adds what it lacks;
`docx.referenceDoc` accepts the reviewer's own copy for IEEE-exact output; and
[TEMPLATES.md](TEMPLATES.md) §3.1 ships a measured, ready-made `styleMap` for the IEEE
template, so pointing at it works on the first try rather than after investigation.

**What measuring it changed.** Running `check --reference-doc` against the real file found it
defines **8 of the 38 Pandoc style names**, which corrected a real assumption in ADR-0004 —
`docx.styleMap` is the *primary* path for third-party templates, not an edge case, and
`onMissingStyle: "synthesize"` is common rather than rare, so synthesized styles must inherit
from the reference document's own `docDefaults` rather than from hardcoded defaults
(`SPEC.md` §4.2.2). It also found the IEEE template has **no OMML at all** — its equation
example is the literal text `a + b = c.` — so the equation coverage that motivated choosing a
manuscript template had to be authored rather than inherited.

Reversible in one direction only: if you would rather ship the IEEE file and accept the licence
question, say so and it drops in — the renderer does not care where the file came from.

## 5. Package name and npm publication — deferred to future scope

Per the reviewer: make the application sound first, then think about publishing. So the
name `markforge`, the `@markforge/*` scope, and public-versus-private publication are **not
decided and do not need to be** — nothing in Phases 0–4 depends on them, and renaming before
first publish is cheap.

Two things are worth doing anyway, both cheap now and annoying later:

- Package directory names stay `packages/<name>` with the scope applied only in
  `package.json`, so a scope change touches one field per package rather than every import.
- No `npm publish` runs, and packages carry `"private": true` until the question is answered,
  so an accidental publish is impossible rather than merely unlikely.

The npm availability of `markforge` is still unchecked, deliberately — checking is only
meaningful once the name is settled.

## 6. Institutional constraints — resolved

None: personal, non-commercial work, so no UF IP review applies. Recorded in ADR-0008 along
with the boundary condition, since the answer depends on the premise — commercial use or
funded-research use would reopen it, and Apache-2.0 relicensing later would require every
contributor's agreement.

One thing the non-commercial framing does **not** change: third-party licences that gate on
*distribution* rather than on revenue still bind, and publishing an Apache-2.0 package is
distribution. `marker`'s RAIL-M revenue threshold, AGPL, and source-available terms are
therefore no more admissible than before.

---

## 7. Decisions made without asking, flagged for reversal

Neither is expensive to reverse, so neither blocked, but both are judgement calls.

**7a. `@markforge/ooxml` and `@markforge/fidelity` are additions to the brief's §9 package
layout.** `ooxml` exists because ADR-0005's reader is shared by three adapters; `fidelity` is a
package rather than test code because brief §3.4 makes fidelity a product capability reachable
from `check` and `diff`. Both argued in `SPEC.md` §11.

**7b. Headers and footers are routed to a `furniture` collection rather than stripped**, a
small deviation from brief §5.2's "header and footer stripping". Stripping would violate brief
§3.3's no-silent-loss principle, so routing satisfies both. Argued in ADR-0002.

Added on 2026-07-30, from the answers above:

**7c. The role set, and where the task → role mapping lives. — RULED ON 2026-07-31: modify.**

*Original entry:* the `fast | strong | vision` role set was my interpretation of how many
distinctions are worth having, with the task mapping fixed in code; a fourth role would be a
code change rather than a config edit.

*Verdict:* the count was not the problem. The reviewer identified the right risk and I had
applied it to the wrong dimension — a fourth role being a code change is tolerable, but every
individual task binding being a code change is not, because the bindings are where experience
actually changes its mind. Two changes, both landed:

- **`embed` added now**, defaulting to `nomic-embed-text-v1.5`. §10.4 merges near-duplicate
  context units and lexical similarity cannot do it: the same constraint written in a PRD and
  in an ADR shares almost no tokens. Discovering this in Phase 4 is exactly the retrofit cost
  this entry warned about, so it was paid up front.
- **The mapping moved to `llm.taskRoles`**, with the §6.2 table as defaults. Role names stay
  closed, bindings open. An unbound or misspelled task throws rather than defaulting, because a
  typo silently falling through to `fast` would surface only as slightly worse output.

`SPEC.md` §6.1–6.2, `schema/markforge.config.v0.schema.json`, `DEFAULT_TASK_ROLES` in
`@markforge/llm`.

**7d. `markforge check --llm` capability probing** was invented to close question 3 rather than
leaving it open. It adds a command flag and a cache file that the brief does not mention.

*Affirmed 2026-07-31, with one requirement now met:* **the record has to be able to go stale.**
`.markforge/llm-capabilities.json` records `baseUrl` and `probedAt`, and `loadCapabilities`
discards it when the endpoint differs, when the record is older than `CAPABILITIES_MAX_AGE_MS`
(seven days), when `probedAt` is absent — an older build could not express its own age, and
unknown age is not evidence — or when it is dated in the future, which means a clock moved. A
university gateway is redeployed without announcement, and a stale record would either
downgrade silently to the repair loop or keep sending a `response_format` the deployment had
stopped accepting: the exact failure the probe exists to prevent.

Added during Phase 2:

**7e. `TableCell.children` was widened to accept block content as well as phrasing content**,
amending the Phase 0 schema. The schema followed mdast literally; `CORPUS.md` §2.5 requires
cells containing block content, so the two contradicted each other. Argued in `SPEC.md` §2.7.1.

**7f. PPTX and XLSX are read-only.** The brief's §11 Phase 2 lists them without saying which
direction. Adapters exist; renderers do not, because generating a presentation or a spreadsheet
was not asked for and would be speculative machinery. `--to pptx` refuses by name. Cheap to
add if wanted.

**7g. `@markforge/adapters-office` holds both PPTX and XLSX** rather than being two packages.
They share a shape — one OPC container, many sub-documents, each becoming a top-level IR node —
and splitting them would duplicate that scaffolding for no boundary anyone needs.

**7h. `@markforge/adapters-pdf` infers, which rule A5 forbids for adapters.** Every other
adapter records evidence and leaves decisions to `@markforge/infer`, because every other format
states its own structure. A PDF has glyphs at coordinates and nothing else, so refusing to infer
would mean refusing to read PDFs. The inference is deterministic, thresholds derive from the
document's own measurements, and provenance carries `confidence: 0.8` so the guess is labelled
as one. ADR-0012 anticipated this; it is recorded here as an explicit A5 exception.

**7i. A PDF with no text layer throws rather than returning an empty document. — RULED ON
2026-07-31: modify. The check is per page, not per document.**

*Original entry:* a conversion that "succeeds" with three words of a forty-page scan is worse
than one that says what is wrong, so the adapter stopped and named the phase that would fix it.

*Verdict:* throwing on a fully scanned PDF is right and is unchanged. The document-level
boolean was wrong for the common real case — a born-digital PDF with scanned pages inserted, a
submission bundle with a signed cover sheet, an appendix photocopied into an otherwise clean
report. Averaging characters over the document puts those comfortably above the threshold, so
the old rule converted them and the scanned pages vanished with no diagnostic anywhere, which
is precisely the silent loss brief §3.3 forbids. The rule is now:

- text coverage is computed **per page**;
- **all** pages below threshold → throw, as before;
- **some** pages below threshold → convert the readable pages, emit an `unknown` placeholder
  node per affected page in reading position, and hand back that page's image for a recogniser.

Each placeholder carries a lossy diagnostic naming its node id and page number, which satisfies
adapter rule A6 and is what makes `--strict` exit non-zero. This keeps no-silent-loss and keeps
the tool useful on documents that actually exist. `packages/adapters-pdf/src/index.ts`; the
mixed case is covered by its own suite in `packages/adapters-pdf/test/pdf.test.ts`.

**7j. `parseAsync`/`convertAsync` exist alongside the synchronous pair.** PDF extraction is
inherently asynchronous, and making every conversion async would force every caller to await a
Markdown conversion that does no I/O. `parse("pdf")` throws and names the function that works.

---

## 8. Questions only Phase 1+ can answer

Not open questions for the reviewer — recorded so they are not mistaken for oversights.

- **Can `docx` reference style ids defined in a reference package without redefining them?**
  If not, the fallback is merging our body part into the reference package with the OOXML
  writer that inverts ADR-0005's reader. Scoped in ADR-0004, settled by writing code.
- **Do the fidelity metric definitions in `SPEC.md` §9 produce stable scores** on the corpus,
  or do they need tolerance tuning? ADR-0010 commits to committed baselines; the initial
  tolerance of 0.005 is a guess until the corpus exists.
- **Is `remark-stringify` + markdownlint autofix genuinely idempotent** under the pinned option
  set of ADR-0006, or does a fixed point require iteration to converge? Property tests decide;
  `maxIterations: 8` is a guard, not a claim.
