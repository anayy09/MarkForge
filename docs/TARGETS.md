# Target registry

> **These conventions change, and this page will go stale.** Every filename, path, and
> front-matter field below was checked against vendor documentation on the date recorded in
> that profile's `verifiedAgainst.date`. Brief §6.3 says to verify them at implementation
> time rather than trust training data, and doing so on 2026-07-31 found **three** things
> that a confident answer would have got wrong — see *What re-verification found*. The
> registry is designed to be updated without a code release: a target is a JSON file in
> `targets/`, and correcting one is editing it.

Targets are **data, not code** (ADR-0013, SPEC §10.9). No module in `@markforge/agentify`
knows a vendor filename. The authoritative schema is
`packages/agentify/schema/target.v0.schema.json`, and it makes `verifiedAgainst: {url, date}`
a **required** field — a profile whose conventions were never checked against a vendor doc
cannot be represented at all.

## How to update a profile

1. Open the vendor's current documentation. Not a blog post, not this file.
2. Edit `targets/<id>.json`.
3. Set `verifiedAgainst.url` to the page you actually read and `verifiedAgainst.date` to
   today. Put what you learned in `note`, including anything that contradicts what you
   expected — those notes are the most useful part of this registry.
4. Run `node scripts/check-agentify.mjs`. A profile that no longer validates fails there.

No rebuild is needed for a path or budget change. Adding a new assembly *kind* is a code
change, because a kind is behaviour; everything else is data.

## What re-verification found

Three corrections on one afternoon, which is the argument for the required field.

**1. ADR-0013 was wrong about Claude Code and `AGENTS.md`.** Its context section states that
"Claude Code added `AGENTS.md` support during spring 2026". The current documentation says
plainly: *"Claude Code reads `CLAUDE.md`, not `AGENTS.md`."* The **decision** survives intact
— `AGENTS.md` as the base with other targets as deltas — because the vendor's own remedy for
a repository holding both is a `CLAUDE.md` whose first line is `@AGENTS.md`, which is this
registry's base-plus-delta shape written in the target's own import syntax. But the premise
was wrong and is corrected here rather than left to be inherited.

**2. Windsurf's documentation now lives on another company's domain.** `docs.windsurf.com`
307-redirects to `docs.devin.ai`. Workspace rules are now `.devin/rules/*.md`, with
`.windsurf/rules/*.md` kept as a legacy fallback. A registry that trusted a remembered URL
would have been reading a redirect to a competitor's docs without noticing.

**3. `.clinerules` is a directory, not a file.** Cline reads every `.md` and `.txt` inside
`.clinerules/` and combines them. The single-file answer is plausible, common in secondary
sources, and wrong.

Also worth recording: **Claude Code's custom commands have been merged into skills.**
`.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both produce `/deploy`;
the commands path still works and takes the same front matter, but skills are the current
recommendation and win a name collision. The `claude-commands` target is therefore a live
but superseded convention, and its profile says so.

## First-class targets

Gated: each carries the §10.6 traceability gate and a fixture test in
`scripts/check-agentify.mjs`. Measured numbers are in [AGENTIFY.md](AGENTIFY.md).

| Id | Output | Kind | Verified against |
| --- | --- | --- | --- |
| `agents-md` | `AGENTS.md` | flatMarkdown | [agents.md](https://agents.md/) |
| `claude-md` | `CLAUDE.md` | flatMarkdown | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) |
| `claude-skills` | `.claude/skills/{slug}/SKILL.md` | skillPackage | [agentskills.io/specification](https://agentskills.io/specification) |
| `claude-commands` | `.claude/commands/{slug}.md` | commandSet | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) |
| `mcp-manifest` | `.mcp.json` | manifest | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) |

**Two of these five are gated against fixtures we authored, not against a format anyone
handed us.** `claude-skills` has a normative specification and is checked against it — the
`name` field's 64-character limit, its character class, and the requirement that it match
the parent directory are all asserted. `claude-commands` and `mcp-manifest` have a verified
*envelope* and no specified *content*: brief §6.3 asks for "an MCP server manifest" without
saying what a document-derived one should contain. What goes inside is our design, described
in each profile's `vendorFields`, and the gate on them measures our expectation rather than a
vendor's. That is a weaker claim than the other three and is stated here rather than implied
by the shared word "first-class".

### Where the spec and the docs disagree

`claude-skills` emits the stricter of two live sources. The [Agent Skills
specification](https://agentskills.io/specification) makes `name` and `description` both
**required**; [Claude Code's own skills page](https://code.claude.com/docs/en/skills) lists
`name` as optional (defaulting to the directory name) and `description` as merely
recommended, and adds a 1,536-character cap across `description` plus `when_to_use` that the
spec does not mention. Emitting both fields, with `description` under the spec's 1,024-character
limit, satisfies both readings. Where two sources disagree the registry takes the intersection,
and the profile's note says which is which.

## Stub targets

Schema-valid and shipped, but **ungated**: no traceability gate, no fixture test. Their
presence proves the schema generalizes; the `tier` field says plainly that they are not
tested. ADR-0013 chose to ship them because a delta on a base costs almost nothing.

| Id | Output | Note |
| --- | --- | --- |
| `cursor-rules` | `.cursor/rules/{slug}.mdc` | The one target with genuinely different assembly semantics — units partition by glob rather than filling a budget. `kind: scopedRuleSet` and the `scoping` block exist for it, and the schema is proven to express its front matter, but nothing emits it: the corpus carries no path scoping to derive a glob from, so every rule would fall back to `alwaysApply` and demonstrate nothing. |
| `copilot-instructions` | `.github/copilot-instructions.md` | Also reads `AGENTS.md` anywhere in the tree, plus `CLAUDE.md` and `GEMINI.md` at the root — so the base target already serves Copilot. |
| `gemini-md` | `GEMINI.md` | Filename overridable via the `context.fileName` setting. Imports are `@file.md`, Markdown only. |
| `windsurf-rules` | `.windsurf/rules/{slug}.md` | See correction 2 above. `.devin/rules/` is now preferred; the profile records both. |
| `cline-rules` | `.clinerules/{slug}.md` | A directory (correction 3). Cline reads `AGENTS.md` natively, so the base usually suffices. |
| `aider-conventions` | `CONVENTIONS.md` | **Not auto-discovered.** Needs `aider --read CONVENTIONS.md` or `read: CONVENTIONS.md` in `.aider.conf.yml`; emitting the file is not enough, and the profile records the config line a user still has to add. |
| `generic` | `AGENT_CONTEXT.md` | No vendor, and therefore nothing to verify against — the profile says so in its own note rather than implying a check happened. Prefer `agents-md`. |

## Staleness

`verifiedAgainst.date` is machine-readable, so a profile that has not been re-checked within
a chosen window is detectable rather than merely regrettable. `Registry.verificationAges()`
returns the age of every profile's check. Wiring that into a CI warning is a small, unbuilt
follow-up (ADR-0013 anticipated it); today the dates are visible and the responsibility is a
human's.
