# Publishing decision

**Status: DECIDED 2026-08-01 — option B+.** Publish the CLI and `@markforge/ir`. The other
eighteen packages stay private, each with a stated reason. This supersedes the open state of
`OPEN_QUESTIONS.md` §5 for the publication half of that question; the name half is answered
below and the answer is not the one the memo assumed.

Everything in the release-mechanics gate depends on this file. Nothing here is a claim without
either a check named beside it or an explicit marker that it is not yet enforced.

## The name is taken, and that changes the install command

Checked against the live npm registry and the GitHub API on 2026-08-01. Recorded with the
evidence, because the whole reason §5 deferred this is that a rename discovered late cascades
into twenty package names, the scope, the binary, the docs, `targets/mcp-manifest.json`, and
the schema filename.

| Namespace | State | Evidence |
| --- | --- | --- |
| npm `markforge` | **TAKEN** | `registry.npmjs.org/markforge` → 200. Real package, not a squat: "Modern TypeScript library for crafting HTML into Markdown with built-in GFM support", MIT, maintainer `mcen`, repo `maqen/markforge`, v1.0.0 and v1.0.1 both published 2024-11-28 |
| npm `markforge` — deprecated? | **No** | no `deprecated` field on `1.0.1` |
| npm `markforge` — active? | Effectively not | last publish 2024-11-28, **1 download in the week ending 2026-07-30** |
| npm `markforge` — ships a binary? | **No** | `bin: null` on `1.0.1` |
| npm scope `@markforge` | No public package, ownership **unproven** | `search?text=scope:markforge` → `total: 0`; `@markforge/ir`, `/core`, `/cli` all 404 |
| GitHub org `markforge` | **Unavailable as an org** | `/orgs/markforge` → 404, `/users/MarkForge` → 200. It is a user account, created 2019-03-04, 2 public repos |
| GitHub repo | Fine as is | `anayy09/MarkForge` → 200 |
| Fallbacks, all free | `markforge-cli`, `mdforge`, `forgemd`, `markforged`, `markforge-toolkit` | all 404 |

**The collision is in the same problem domain** — an HTML-to-Markdown converter — which is the
worst kind, because a user who finds the wrong one will not immediately know they have.
Requesting the name through npm's dispute process is not an option worth pursuing: that process
covers squatting and empty packages, and this package has real published content.

### The decision that follows, and why it costs almost nothing

**Publish the CLI as `@markforge/cli`, declaring `"bin": { "markforge": "./dist/index.js" }`.**

The package name and the binary name are independent, and only the package name is taken. The
existing `markforge` package ships no `bin` at all, so the terminal command a user types is
uncontested even for someone who installs both. What changes:

```sh
npm install -g @markforge/cli     # was: npm install -g markforge
markforge convert report.md -o report.docx    # unchanged
npx @markforge/cli convert report.md -o report.docx   # was: npx markforge
```

What does **not** change: the `@markforge` scope, all twenty package names, the binary,
`ir.v0.schema.json`, and every command in the README that a user runs after installing. The
cascade this check existed to prevent does not happen.

### `npx markforge` now runs somebody else's package

This is the one thing the resolution costs, and it costs it in the place a user meets the tool
first. `npx markforge` is the command anyone would guess — it is the binary name, and it is the
shape every README in this ecosystem uses. It will fetch `maqen/markforge`, find `bin: null`,
and fail with an error about a missing executable that explains nothing.

Three consequences, all live:

1. **Every document uses `npx -y @markforge/cli` and nothing else.** The bare installed
   `markforge` command is still correct and still documented; only the `npx` form moves.
2. **`scripts/check-docs.mjs` §14a-ii fails on the literal string** `npx markforge` anywhere in
   `README.md`, `action.yml`, `targets/mcp-manifest.json`, or any deliverable doc. Seen to fail:
   adding the line to `README.md` produced
   `FAIL "npx markforge" resolves to an unrelated npm package … README.md:174`.
3. **`targets/mcp-manifest.json` is re-derived.** Its scaffold was `markforge mcp`, which
   assumes a global install an MCP client on a clean machine does not have. It is now
   `npx -y @markforge/cli mcp`. That manifest has already been wrong about its own profile
   once, so the scaffolded command gets its own assertion in the clean-machine gate rather than
   being covered incidentally by the CLI's.

### Two risks recorded as risks, not as properties

**The binary name is uncontested today, not by guarantee.** `bin: null` is a fact about
`markforge@1.0.1`, not a commitment by its maintainer. If that package ever ships a `bin`, two
global installs collide and npm resolves it by link order, silently. The probability is low —
one download per week, no publish since 2024-11-28 — but low is not zero and this is the
difference between a measured fact and a guarantee.

**An in-domain namesake owns the search result.** Anyone searching npm for a Markdown converter
finds `markforge` before `@markforge/cli`, and the two do adjacent things. The mitigation is
that the published `description` must disambiguate **in its first clause**, before any
truncation: something of the shape *"CLI for fidelity-preserving document conversion and agent
context compilation — unrelated to the `markforge` package."*

### If the scope is taken, rename — do not split the difference

**Unproven, and marked as such:** that the `@markforge` scope is unclaimed. Zero public
packages under it is evidence, not proof — an org can exist with nothing published, and the
endpoints that would settle it (`/-/user/org.couchdb.user:markforge`, `npmjs.com/org/markforge`)
return 401 and 403 to an unauthenticated caller. The only conclusive test is attempting to
create the scope with credentials, and **that is step one of the release gate**, ahead of
everything else.

If it fails, the answer is **a clean rename to an unscoped free name** — `mdforge` and
`forgemd` are both free — and not `markforge-toolkit` as the scope with `markforge` as the
binary. At that point the name is contested on both sides, and the combination buys the worst
of each: a scope nobody recognises, a binary that collides, and an `npx` path that still runs
the wrong package. A rename is cheap before the first publish and expensive after it.

Worth stating plainly, since this trade hardens on first publish: an unscoped free name would
buy back `npx <name>` working, a clean search result, and no namesake risk, at the cost of the
`@markforge` scope. B+ takes the scope because it is the scarce asset and the `npx` path is
documentable — but only if the scope actually exists.

## What was decided

**Public (2):**

| Package | Published as | Why |
| --- | --- | --- |
| `@markforge/cli` | `@markforge/cli`, binary `markforge` | The thing a user runs. Bundled — see the bundle boundary below |
| `@markforge/ir` | `@markforge/ir` | Ships `ir.v0.schema.json` so other tooling can validate IR JSON without the CLI. Zero workspace dependencies, so it publishes standalone with no version cascade |

**Private (18):** `adapters-docx`, `adapters-html`, `adapters-md`, `adapters-ocr`,
`adapters-office`, `adapters-pdf`, `agentify`, `browser`, `core`, `fidelity`, `http`, `infer`,
`llm`, `mcp`, `ooxml`, `render-docx`, `render-html`, `render-md`. Each carries its one-line
reason in its own `package.json` under `markforge.publishReason` (see modification 3).

### Correction to the reasoning that produced this

The memo's original case for B+ over B was that B removes third-party adapter authorship and
B+ restores it. **That is wrong and is corrected here rather than quietly dropped.**

Publishing the contract is not publishing the mechanism. An author can install
`@markforge/ir`, write an `Adapter` against it, and then has nowhere to load it: the CLI
bundles its own copy of the IR, and there is no loader. Structural typing settles the
compile-time question and none of the runtime ones — a separately installed IR and a bundled
IR meet at ajv validation, at any `Symbol`-keyed brand, and at any identity check a loader
would perform. The comparison table below records this accurately.

B+ is still the right choice, for three reasons that survive:

1. **It stakes the scope**, which is the asset the name check just showed is scarce.
2. **It makes `ir.v0.schema.json` installable**, so a third party can validate IR JSON, build
   tooling around the format, and check conformance without the CLI. That is real and it is
   what the IR being "the contract" actually buys today.
3. **It is genuinely zero-cascade.** `@markforge/ir` has no workspace dependencies, so an IR
   release bumps one version and rewrites no protocol ranges.

### Adapter loading: decided, not discovered

**`0.1.0` ships no plugin loading path.** The README states that third-party adapters can be
*written* against `@markforge/ir` and cannot yet be *loaded* into the CLI, and
`docs/ROADMAP.md` carries the loader. The alternative — building a loader for `0.1.0` — is
machinery with no user today and would need to settle IR instance identity across a bundle
boundary before it could work at all, which is a design question this release has no evidence
to answer.

**Enforced by, both halves:** `scripts/check-docs.mjs` (amended in Gate 6). A one-sided check
here would fail if the statement were deleted and pass if a loader were built while the
statement stayed — which is the more likely drift, because building the loader is the
interesting work and editing the README is not. So:

- the README statement exists, **and**
- the CLI exposes no adapter-loading surface: no `--adapter`, `--plugin`, `--load`, or
  `--require` flag in `--help`, and no `registerAdapter`-shaped export from the published
  entry point.

Either half failing is a failure. When the loader is built, both change together.

## Modification 1 — the bundle boundary is declared per dependency and enforced

"esbuild with `platform: node`" was optimistic. `pdfjs-dist` and the Tesseract runtime carry
WASM and worker assets that do not survive inlining, and several dependencies are
`fflate`-style pure ESM that inline fine. Guessing which is which at publish time is how a
tarball ships broken.

So the published CLI declares the boundary explicitly, per dependency, and a check compares the
declaration against the **tarball that was actually produced**:

- `markforge.bundle.inline` — inlined into `dist/`, absent from `dependencies`.
- `markforge.bundle.external` — declared in the published `dependencies` and resolved by the
  user's installer.

**Enforced by:** `scripts/check-publish-bundle.mjs` (unbuilt — Gate 6), which runs
`npm pack --dry-run --json`, reads the tarball's file list and its `package.json`
`dependencies`, and fails when either disagrees with the declaration. Not a package.json walk:
the artifact is the evidence.

### Third-party notices

Bundling other people's MIT and Apache-2.0 code into a published artifact carries attribution
obligations. `fixtures/LICENSES.md` does not discharge them — it is a register of *fixtures*,
which are inputs, not of *dependencies shipped inside a tarball*.

**Only inlined code creates the obligation.** A package listed in `dependencies` is fetched by
the user's installer with its own license text and registry metadata attached; nothing is
redistributed, so nothing needs restating. Code copied into `dist/` is redistribution, and it
is exactly the set `markforge.bundle.inline` names.

So the tarball ships `THIRD-PARTY-NOTICES.md` **derived from the bundle's own contents**, via
esbuild's metafile input list, not from a `package.json` dependency walk. The two differ in
both directions: tree-shaking removes packages a walk would list, and a walk cannot distinguish
inlined from external. Attribution has to describe the artifact.

**Apache-2.0 `NOTICE` propagation is a separate obligation from the license text**, and is
easy to discharge accidentally-incompletely. Apache-2.0 §4(d) requires that if an inlined
dependency ships a `NOTICE` file, its contents are carried into the notices of any derivative
distribution — that is on top of, not instead of, reproducing the license. The generator reads
each inlined package's directory for a `NOTICE`/`NOTICE.txt` and appends its verbatim contents
under that package's heading. `@markforge/*` code is our own and is covered by the repository
`LICENSE`.

**Enforced by:** the same `scripts/check-publish-bundle.mjs`, which regenerates the notices
from the metafile and fails on drift — the same shape as `check-target-docs.mjs` regenerating
`TARGETS.md` from `targets/*.json` — and which fails when an inlined Apache-2.0 package ships
a `NOTICE` that the generated file does not carry.

## Modification 2 — the CLI contract is written down

B+ commits to exactly one semver surface, and that surface is currently undocumented. An
undocumented contract is a claim with no check.

`docs/CLI-CONTRACT.md` (unbuilt — Gate 6) states, and a check asserts against the running
binary:

- **Commands and their stability tier.** `convert`, `fmt`, `check`, `agentify`, `serve`, `mcp`
  are the surface. `diff` and `init` are resolved in Gate 4 and whatever survives is listed
  with its state.
- **Flags per command**, with which are stable and which are provisional.
- **Exit codes**, which are already a table in `packages/core/src/index.ts:385–396` and are not
  documented anywhere a user reads:

  | Code | Meaning |
  | --- | --- |
  | 0 | success |
  | 1 | error |
  | 2 | completed with lossy or degraded diagnostics **and** `--strict` was set |
  | 3 | `fmt --check` found files needing changes |
  | 4 | fidelity regression against baseline |
  | 5 | agentify traceability gate failed, no bypass flag |

  Exit 2 is load-bearing: `scripts/check-surface-parity.mjs` §3 now asserts a partial model
  failure exits 2 under `--strict` and 0 without it, and nothing currently states that this is
  a stable interface rather than an implementation detail.

- **The `--json` envelope shape** per command, which is the machine-readable contract and is
  today defined only by the code that emits it.

**Enforced by:** `scripts/check-cli-contract.mjs` (unbuilt — Gate 6), which spawns the built
binary and asserts every documented command, flag, and exit code exists and behaves as
documented. A contract nothing executes is the defect this modification exists to avoid.

## Modification 3 — publication tier is a probed field, not a list

`scripts/check-docs.mjs:471–482` today fails when any package is not private. Inverting it into
a hand-maintained list of two public names beside a list of eighteen private ones would
reproduce exactly the defect that `markforge.browserTier` was introduced to remove: a table
maintained next to the thing it describes, which a new package can be added without touching.

So each `package.json` declares:

```jsonc
"markforge": {
  "browserTier": "nodeOnly",
  "publishTier": "public",           // or "private"
  "publishReason": "the binary users run"   // required when private
}
```

and the gate probes every package rather than consulting a list: an undeclared `publishTier`
fails, a `publishTier` disagreeing with the manifest's `private` flag fails, and a `private`
package with no `publishReason` fails. Adding a package forces the decision, which is the
property that made the browser tier gate work.

**Enforced by:** `scripts/check-docs.mjs`, amended in Gate 6.

## The three consequences, affirmed

1. **ADR-0011 is amended, not overridden** — in the same style as ADR-0015. Its public list of
   fifteen becomes a stated intention with a **trigger**, because an intention with no trigger
   is an ADR with no enforcing check wearing a different costume. The trigger:

   > A package moves from `private` to `public` when (a) its public exports are documented with
   > their stability tier per ADR-0011, (b) a check asserts those exports exist and are
   > importable from the published tarball, and (c) `docs/STATUS.md` carries no `not done` or
   > `partial` row naming a capability that package is the primary implementation of.

   **The trigger is machine-evaluated, not asserted.** Demonstrating it on two packages by hand
   is the same shape as the capability table before it was probe-derived: next time, publication
   would be decided by hand again and the ADR would be back to naming a check rather than having
   one. `scripts/check-publish-tier.mjs` (unbuilt — Gate 6) evaluates all twenty against (a),
   (b), and (c) and prints the matrix, so `publishTier` becomes **derived and then asserted**
   rather than chosen: a package whose declared tier disagrees with its computed eligibility
   fails, in either direction. A package that becomes eligible and stays private fails just as
   loudly as one that is public while ineligible — otherwise the trigger is a ratchet nobody
   ever pulls.

   This is also what finally gives ADR-0011 a real enforcing check. It currently names
   `scripts/check-docs.mjs`, which asserts scope naming and the private flag and nothing about
   the public API shape the ADR is actually about — the same defect found in ADR-0012.

   By hand, ahead of the script: `@markforge/ir` meets all three today, which is why it is in
   the public set. Condition (c) is why `adapters-pdf` cannot be — ADR-0012 has four unbuilt
   Decision clauses and `adapters-pdf` implements all four.

2. **`check-docs.mjs:471` inverts**, per modification 3.

3. **The names were checked**, above. The result changed the plan.

## Three additions

**npm build provenance via GitHub Actions OIDC.** `npm publish --provenance` from a workflow
with `id-token: write` attaches a signed attestation linking the tarball to the commit and
workflow that built it. It costs one flag and one permission, needs no key material, and is the
same evidentiary shape as everything else here — the artifact carries proof of where it came
from rather than a claim about it.

**The MCP manifest's documented command joins the clean-machine gate.**
`targets/mcp-manifest.json` has already carried a claim wrong about its own profile once, and
publishing changes what resolves: today it scaffolds `markforge mcp`, which works only if the
binary is on `PATH`. The clean-machine test runs the scaffolded command exactly as written and
asserts the server answers a real `tools/list` over stdio.

**Correction to the earlier blocked list.** It said "setting versions to `0.1.0`" was blocked.
All twenty packages are already at `0.1.0` — verified in every `package.json`. The blocked item
is flipping `private`, not setting the version.

## Comparison, corrected

| | A: all 20 | B: CLI only | **B+ (chosen)** | C: GitHub Packages | D: binary |
| --- | --- | --- | --- | --- | --- |
| Public packages | 20 | 1 | **2** | as chosen | 0 |
| Install | `npm i -g @markforge/cli` | same | **same** | registry config first | `curl` + `chmod` |
| `npx` works | yes | yes | **yes** | no | no |
| Publishes per release | 20 | 1 | **2** | as chosen | 3+ binaries |
| Version cascade on an IR change | all 19 dependents | none | **none** | as chosen | none |
| Semver surfaces committed | 15 | 1 | **2** | as chosen | 1 |
| Third party can **write** an adapter | yes | no | **yes** | yes | no |
| Third party can **load** an adapter | yes | no | **no** | yes | no |
| Third party can validate IR JSON | yes | no | **yes** | yes | no |
| Reversible without breaking users | no | yes | **yes** | partly | yes |

## The named-but-unbuilt scripts are the ADR-0012 shape

Five scripts are named above and none of them exists: `check-publish-bundle.mjs`,
`check-cli-contract.mjs`, `check-publish-tier.mjs`, plus amendments to `check-docs.mjs` and the
clean-machine gate. **A named script that has not been written is not enforcement**, which is
exactly what ADR-0012's `Enforced by: scripts/check-degradation.mjs` turned out to mean.

The difference is that these are marked, and the marking has to be somewhere a reader of the
status document sees it, not only here. So until each script exists **and has been seen to
pass**, `docs/STATUS.md` carries the corresponding capability as `not verified — <why>`, which
`scripts/check-status-claims.mjs` already requires a reason for. The rows are added in Gate 6
alongside the scripts; listing a capability as `done` on the strength of a script named in this
memo would be the defect this memo is trying not to commit.

## What Gate 6 now owes

Each item below is either a check that can fail or is marked as not yet enforced.

| Item | State |
| --- | --- |
| Create the `@markforge` scope, **or rename** if it is taken | **step one**, the only conclusive scope test |
| Published `description` disambiguates from the namesake in its first clause | unbuilt |
| `publishTier` / `publishReason` on all 20, gate inverted | unbuilt — `scripts/check-docs.mjs` |
| ADR-0011's three conditions evaluated over all 20 | unbuilt — `scripts/check-publish-tier.mjs` |
| Bundle boundary declared and asserted against the tarball | unbuilt — `scripts/check-publish-bundle.mjs` |
| `THIRD-PARTY-NOTICES.md` from the metafile, with Apache-2.0 `NOTICE` propagation | unbuilt — same script |
| `docs/CLI-CONTRACT.md` and its executable check | unbuilt — `scripts/check-cli-contract.mjs` |
| Adapter-loading absence asserted on both halves | unbuilt — `scripts/check-docs.mjs` |
| Changesets or equivalent, release reproducible from a tag | unbuilt |
| `npm publish --provenance` under OIDC | unbuilt |
| Clean-machine smoke test | unbuilt |
| — its own assertion for the MCP scaffolded command | unbuilt |
| README install section rewritten to `npm i -g @markforge/cli` | unbuilt |
| ADR-0011 amended with the publication trigger | unbuilt |
| `action.yml` installs the published CLI instead of building from source | unbuilt |
| A `not verified` STATUS.md row per unbuilt script above | unbuilt |

Done already, in this pass: the `npx markforge` guard (`scripts/check-docs.mjs` §14a-ii, seen
to fail) and the re-derived `targets/mcp-manifest.json` scaffold.
