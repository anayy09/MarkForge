# ADR-0013: Target registry — AGENTS.md as base, other targets as deltas

- Status: **Confirmed by reviewer**
- Date: 2026-07-29
- Relates to: brief §6.3; `SPEC.md` §10.9

## Context

Brief §6.3 requires that targets be data, not code, and lists profiles for Claude Code,
OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor, Windsurf, Cline, Aider, and a generic
fallback. It also insists — twice — that filenames and conventions be verified against current
vendor documentation rather than trusted from training data, because these change.

Verified 2026-07-29: `AGENTS.md` was released by OpenAI in August 2025, transferred to the
Linux Foundation's Agentic AI Foundation in late 2025, and by May 2026 was adopted by 60,000+
repositories and read natively by Codex, Cursor, Copilot, Gemini CLI, Aider, Windsurf, and Zed.
Claude Code added `AGENTS.md` support during spring 2026 while retaining the richer `CLAUDE.md`
memory model. Cursor uses `.cursor/rules/*.mdc` with YAML front matter for glob-scoped
activation; Copilot uses `.github/copilot-instructions.md`; Gemini CLI reads `GEMINI.md`.

That changes the shape of the problem. The brief's list implies nine peer targets; the current
landscape is one standard plus a small number of genuine variations.

## Decision

**`AGENTS.md` is the base target profile. Other flat-Markdown targets are declarative deltas
on it**, declaring only what differs via `extends: "agents-md"`.

Profiles are validated by `packages/agentify/schema/target.v0.schema.json`. A profile declares
output paths, token budget and counting method, front-matter support and schema, import/link
support, section template, tone, glob scoping, and a `vendorFields` escape hatch. No target
behaviour lives in code.

Every profile **must** carry `verifiedAgainst: { url, date }` — the schema makes it a required
field. A profile whose conventions were never checked against a vendor doc cannot be
represented, which is brief §6.3's warning turned into a schema constraint rather than a note
someone might read.

**Tiering, per the reviewer's Phase 4 priorities.** `tier: "firstClass"` targets carry a
traceability gate and fixture tests: `agents-md`, `claude-md`, `claude-skills` (`SKILL.md`
packages), `claude-commands` (slash-command definitions), and `mcp-manifest`. The last three
are promoted from brief §6.3's stretch list to planned work. `tier: "stub"` targets are
schema-valid and shipped but ungated: `cursor-rules`, `copilot-instructions`, `gemini-md`,
`windsurf-rules`, `cline-rules`, `aider-conventions`, and a generic fallback.

`kind` distinguishes assembly semantics: `flatMarkdown`, `scopedRuleSet`, `skillPackage`,
`commandSet`, `manifest`. Cursor is the one target with genuinely different semantics — it
partitions units by path glob instead of budgeting a single file — so the schema must express
that even while Cursor is a stub. Verified in Phase 0: a Cursor profile with glob-scoped front
matter validates against the schema.

## Rejected alternatives

**Nine peer profiles, as brief §6.3's list implies.** Rejected because most of those files are
now the same file with a different name. Nine peers means nine near-identical profiles to keep
in sync, and every convention change touches all of them. With `AGENTS.md` as base, a rename is
a two-line delta.

**`CLAUDE.md` as the base**, given the reviewer uses Claude Code and it has the richest memory
model. Rejected: `CLAUDE.md`'s three-layer memory model and imports are a superset, so deriving
the simpler standard from the richer one means every other target's delta is subtractive and
must know what to remove. Deriving richness from a plain base is additive and safer. `CLAUDE.md`
is nonetheless first-class and fully tested.

**Targets as code modules** implementing an `emit()` interface. More flexible for genuinely
odd targets. Rejected by brief §6.3's "data, not code" requirement, and because it makes the
registry un-updatable by anyone who is not a TypeScript contributor — exactly wrong for
conventions that change on vendor timelines. `vendorFields` plus five `kind` values covers the
observed variation.

**Treating Cursor's glob scoping as a `vendorFields` detail.** Rejected: glob scoping changes
*assembly*, not just serialization — units are partitioned rather than budgeted — so it needs a
first-class `kind` and a `scoping` block. Burying it in an escape hatch would mean the
budgeting code silently did the wrong thing for the one target that differs.

**Shipping only the confirmed Phase 4 targets and omitting the rest.** Rejected: the stubs cost
almost nothing once they are deltas on a base, and their presence proves the schema generalizes.
The honest part is the `tier` field, which says plainly which ones are tested.

## Consequences

- `docs/TARGETS.md` must state prominently that these conventions change and that the registry
  is designed to be updated without a code release.
- A stale `verifiedAgainst.date` is machine-detectable, so CI can warn when a profile has not
  been re-verified within a chosen window. Cheap, and it addresses the brief's actual worry.
- Cursor and Copilot users get output that is schema-correct but not fidelity-gated. The `tier`
  field makes that visible rather than implied.
- Promoting skills, commands, and the MCP manifest to planned work means `agentify` must emit
  multi-file packages and a JSON manifest, not only Markdown. The `outputs` array and the
  `manifest` kind account for that.
