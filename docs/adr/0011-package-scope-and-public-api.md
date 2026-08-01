# ADR-0011: Package scope and public API shape

- Status: Proposed
- Date: 2026-07-29
- Relates to: brief §0, §8, §9; `SPEC.md` §3, §4, §11
- Enforced by: scripts/check-docs.mjs

## Context

Brief §0 lists public API shape among the decisions expensive enough to reverse that they
warrant explicit attention. Brief §8 requires a typed, tree-shakeable Node API that is the
CLI's only dependency for logic. Brief §9 requires adapters and renderers to be independently
publishable.

## Decision

**Scope `@markforge/*`**, with `markforge` as the CLI package (the name users type). The
working name from brief §1 is carried through Phase 0; confirming or changing it is raised in
`OPEN_QUESTIONS.md` before publication.

**Public, semver-stable packages:** `@markforge/ir` (the contract third parties write
against), `@markforge/core`, all `@markforge/adapters-*`, all `@markforge/render-*`,
`@markforge/infer`, `@markforge/agentify`, `@markforge/fidelity`, `@markforge/llm`, and
`markforge`.

**Internal, versioned but not a support commitment:** `@markforge/ooxml`, `@markforge/http`,
`@markforge/mcp`, `@markforge/browser`. Marked in their READMEs and by an `internal: true`
flag in package metadata.

**Three stability tiers, declared per export:** the IR schema and the `Adapter`/`Renderer`
interfaces are tier 1 (breaking change requires a major version and a migration note);
pipeline and config APIs are tier 2 (breaking change requires a major version); everything
else is tier 3. Tier is recorded in the TSDoc of each export, so it is visible where it
matters rather than only in a document.

**API shape:** every public entry point is a named ESM export. No default exports, no class
hierarchies where a function suffices, no plugin registry with global mutable state —
adapters and renderers are passed in explicitly. `Adapter` and `Renderer` (`SPEC.md` §3, §4)
are the two extension points, and both are plain interfaces with no base class to inherit.

Errors are typed and discriminated, following the reference project's instinct
(`UnsupportedFileError`, `FileNotFoundError`, `InvalidFileError`) and extending it: every
error carries a stable `code` from the same `MF-<AREA>-<NNNN>` namespace as diagnostics, so
CLI, API, and HTTP surfaces report the same identifier for the same condition.

## Rejected alternatives

**Unscoped package names** (`markforge-ir`, `markforge-docx`). Rejected: a scope makes the
trust boundary obvious and prevents name squatting on the ~17 satellite packages.

**One package with subpath exports** (`markforge/adapters/docx`). Genuinely simpler to release
and easier for users. Rejected by brief §9's independent-publishability requirement, and
because it would let the browser bundle pull in `pdfjs-dist` and the Tesseract WASM through a
careless import.

**A global plugin registry** with `registerAdapter()`. Common and convenient. Rejected: global
mutable state makes determinism harder to reason about, breaks tree-shaking, and creates
order-dependent behaviour when two packages register for the same media type. Explicit
passing costs one line at the call site and removes the whole class of problem.

**Classes with inheritance for adapters** (`class DocxAdapter extends BaseAdapter`). Rejected:
plain interfaces keep third-party adapters free of a dependency on our base class, which
matters because brief §4 wants third parties writing adapters. A shared base class would make
`@markforge/ir` a runtime dependency rather than a types-only one for those authors.

**Deferring the naming decision entirely.** Rejected as a Phase 0 output: the scope appears in
every import in every document and example, so leaving it unnamed would make the spec harder
to read. It is cheap to rename before publication and is flagged as such.

## Consequences

- ~17 packages to release, which is why changesets is in ADR-0007.
- Tier 1 stability on the IR schema and the two interfaces means those get the most Phase 0
  design attention, which matches brief §4 calling the IR the most important decision.
- Tree-shakeability requires no side effects at module load, so `"sideEffects": false` in
  every package and a CI check that importing any package performs no I/O.
- `@markforge/ooxml` being internal means we can iterate on the OOXML reader freely while
  ADR-0005's edge cases shake out.
