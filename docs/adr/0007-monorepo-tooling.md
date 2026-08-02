# ADR-0007: Monorepo tooling

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §9, §13; `SPEC.md` §11
- Enforced by: scripts/check-docs.mjs

## Context

Brief §9 specifies a pnpm-workspace monorepo with TypeScript strict, where adapters and
renderers are independently publishable and independently testable. Brief §13 requires Node
20+, actively maintained dependencies with maintenance recorded, and a one-line justification
for every dependency or abstraction layer.

## Decision

| Concern | Choice | Justification (brief §13) |
| --- | --- | --- |
| Workspace | pnpm workspaces | Specified by brief §9; strict node_modules layout catches undeclared dependencies, which matters for independently publishable packages |
| Language | TypeScript strict + project references | Specified by brief §13; project references give per-package type isolation, enforcing the dependency rules of `SPEC.md` §11 at compile time |
| Build | `tsdown` (0.22.14, 2026-07-23) | Rolldown-based, actively maintained, ESM+CJS+dts from one config; needed because packages ship to npm and to a browser bundle |
| Test | `vitest` (4.1.10, 2026-07-06) | Native ESM, browser mode for the browser-build tests, and fast watch mode; ESM is non-negotiable given the `unified` ecosystem is ESM-only |
| Property tests | `fast-check` | Brief §3.5 and §10 require property tests for idempotency; hand-written cases cannot discharge a universal claim |
| Schema validation | `ajv` (8.20.0, 2026-04-24) | Validates the IR schema and LLM structured output (brief §7.3 forbids regex-parsing model responses) |
| Config validation | `zod` (4.4.3, 2026-05-04) | Runtime validation of user config with good errors; the config JSON Schema is generated from it so the two cannot drift |
| Type generation | `json-schema-to-typescript` (15.0.4) | ADR-0001 makes the JSON Schema authoritative; types must be generated, not hand-maintained |
| Releases | `@changesets/cli` (2.31.1, 2026-07-15) | Independent versioning across ~17 packages with a human-readable changelog per package |
| CLI parsing | `commander` (15.0.0, 2026-05-29) | Seven subcommands with `--json` on each; hand-rolling argument parsing is not a differentiator |
| Lint/format | ESLint + Prettier for source | Note: Prettier formats *our source*, and is deliberately absent from the Markdown output pipeline (ADR-0006) |
| CI | GitHub Actions | Brief §8 also requires a shipped GitHub Action, so the CI and the product share a platform |

Two CI-enforced rules, because they encode architecture rather than style:

1. `adapters-*` and `render-*` may depend on `ir`, `ooxml`, and `core`, and **must not**
   depend on `llm`, on each other, or on `cli`. This turns brief §3.1's
   "LLMs never inside the deterministic path" from a policy into a build failure.
2. The full test suite runs twice, once with network access blocked, to enforce brief §3.1's
   offline `--no-llm` guarantee.

### What of this table is true, 2026-08-01

Found by making `scripts/check-adr-enforcement.mjs` test whether a named check is *about* the
ADR it is bound to, rather than only that the filename resolves. Four of the twelve rows name
tools that are **not installed anywhere in this repository**, and one of the two CI-enforced
rules does not exist. Enumerated rather than quietly corrected, because a decision record that
lists a toolchain nobody can find is worse than one that admits a gap.

| Row | State |
| --- | --- |
| pnpm workspaces | true — `pnpm-workspace.yaml`, `packageManager` pinned |
| TypeScript strict + project references | true — `tsconfig.base.json`, `tsc -b` |
| **Build: `tsdown`** | **false.** Not a dependency of the root or of any package. The build is `tsc -b`, and the browser bundle is `esbuild` (ADR-0015). `tsdown` was chosen for ESM+CJS+dts output "because packages ship to npm" — nothing ships to npm, so the requirement that selected it never arrived |
| Test: `vitest` | true |
| Property tests: `fast-check` | true — a root devDependency, seeds pinned in four property files |
| Schema validation: `ajv` | true — root plus three packages |
| Config validation: `zod` | true — `@markforge/core` |
| Type generation: `json-schema-to-typescript` | true |
| **Releases: `@changesets/cli`** | **false.** Not installed. Owed by the release gate (`docs/decisions/PUBLISHING.md`) |
| CLI parsing: `commander` | true — `@markforge/cli` |
| **Lint/format: ESLint + Prettier** | **false.** Neither is installed and neither has a configuration file. Source formatting is unenforced; `scripts/check-markdown-lint.mjs` governs *rendered Markdown* only, which is a different thing (ADR-0006) |
| CI: GitHub Actions | true |
| **Rule 2 — the suite runs twice, once with the network blocked** | **false.** CI unsets `MODEL_API_KEY` on the jobs that touch the LLM path, which makes a network attempt *fail* rather than making it *impossible*, and it is per-job rather than over the full suite. The guarantee brief §3.1 asks for is stronger than what is built |

Rule 1 is real and is the clause this ADR is bound to: `scripts/check-docs.mjs` §14b and
§14b-ii assert it on every run, over manifests and over source imports, because a manifest
check alone would miss a stray deep import.

## Rejected alternatives

**Nx or Turborepo.** Better caching and task orchestration at scale. Rejected for now: ~17
packages with a simple dependency graph do not need a task runner beyond pnpm's own
`--filter` and TypeScript project references, and both add configuration surface plus a
learning cost for contributors. Revisit if CI time becomes a real problem — this is a cheap
decision to reverse, which is why it is being made now rather than deferred.

**Jest.** Rejected: the `unified` ecosystem is ESM-only and Jest's ESM support remains
friction. The reference project uses Jest plus Playwright; we take the Playwright idea and
not the Jest one.

**`tsup`.** Perfectly good (8.5.1, 2025-11-12) and a smaller step. `tsdown` chosen for the
newer bundler and more recent maintenance, both being from the same lineage. Low-stakes,
easily reversed.

**A single package instead of a monorepo.** Simpler to build and release. Rejected by brief
§9's requirement that adapters and renderers be independently publishable, and because it
would make the dependency rules above unenforceable.

**Hand-written TypeScript types for the IR.** Rejected by ADR-0001: two definitions of one
contract diverge.

## Consequences

- Contributors need pnpm and **Node 22+** — not 20, as this line said until 2026-08-01.
  pnpm 11.9.0 is pinned by `packageManager` and uses a builtin module Node 20 lacks, so the
  Node 20 claim was untrue from the moment the pin landed. `OPEN_QUESTIONS.md` §7y.
- Project references mean a stricter build order and occasional `tsc -b` friction, in
  exchange for the dependency rules being compile-time facts.
- Running the suite twice roughly doubles CI test time. Accepted: the offline guarantee is a
  headline promise and an untested promise is a lie.
