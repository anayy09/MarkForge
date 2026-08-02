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

<!-- generated: first-class -->
| Id | Output | Kind | Verified against |
| --- | --- | --- | --- |
| `agents-md` | `AGENTS.md`, `docs/agent-context/{slug}.md` | flatMarkdown | [agents.md](https://agents.md/) |
| `claude-md` | `CLAUDE.md`, `.claude/context/{slug}.md` | flatMarkdown | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) |
| `claude-skills` | `.claude/skills/{slug}/SKILL.md`, `.claude/skills/{slug}/references/detail.md` | skillPackage | [agentskills.io/specification](https://agentskills.io/specification) |
<!-- /generated: first-class -->

**Two of these five are gated against fixtures we authored, not against a format anyone
handed us.** `claude-skills` has a normative specification and is checked against it — the
`name` field's 64-character limit, its character class, and the requirement that it match
the parent directory are all asserted. `claude-commands` and `mcp-manifest` have a verified
*envelope* and no specified *content*: brief §6.3 asks for "an MCP server manifest" without
saying what a document-derived one should contain. What goes inside is our design, described
in each profile's `vendorFields`, and the gate on them measures our expectation rather than a
vendor's. That is a weaker claim than the other three and is stated here rather than implied
by the shared word "first-class".

### The `mcp-manifest` correction, 2026-08-01

This page said the manifest pointed at `markforge serve`, "which is Phase 5 and does not
exist yet". That sentence was inherited from the profile's own `vendorFields.honestyNote`,
and it was wrong about the profile it described — in three ways at once, which is worth
recording because the field's name is `honestyNote`:

1. The scaffold did not say `markforge serve`. It said `npx -y @markforge/mcp --context
   .markforge/provenance.json`.
2. `markforge serve` is the **HTTP API**. An MCP client spawning it on stdio would hang,
   because the two are different protocols on different transports (§7u).
3. `npx @markforge/mcp` names a package nothing publishes and nothing may publish
   (`OPEN_QUESTIONS` §5, reaffirmed for Phase 5 as §7r), so the scaffold could not have
   worked from any checkout. The `--context` flag was one no server ever accepted.

It now scaffolds `markforge mcp`, which exists, exposes `convert`, `fmt`, and `agentify`, and
was driven end to end over real stdio JSON-RPC. `STATUS.md` carried the same wrong claim and
is corrected too. The envelope was verified against vendor documentation and stayed correct
throughout; what was wrong was the sentence describing what we ourselves had built.

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

<!-- generated: stubs -->
| Id | Output | Verified against |
| --- | --- | --- |
| `aider-conventions` | `CONVENTIONS.md` | [aider.chat](https://aider.chat/docs/usage/conventions.html) |
| `claude-commands` | `.claude/commands/{slug}.md` | [code.claude.com](https://code.claude.com/docs/en/skills) |
| `cline-rules` | `.clinerules/{slug}.md` | [docs.cline.bot](https://docs.cline.bot/features/cline-rules) |
| `copilot-instructions` | `.github/copilot-instructions.md`, `.github/instructions/{slug}.instructions.md` | [docs.github.com](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions) |
| `cursor-rules` | `.cursor/rules/{slug}.mdc` | [cursor.com](https://cursor.com/docs/context/rules) |
| `gemini-md` | `GEMINI.md`, `docs/agent-context/{slug}.md` | [google-gemini.github.io](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html) |
| `generic` | `AGENT_CONTEXT.md`, `docs/agent-context/{slug}.md` | [agents.md](https://agents.md/) |
| `mcp-manifest` | `.mcp.json` | [code.claude.com](https://code.claude.com/docs/en/mcp) |
| `windsurf-rules` | `.windsurf/rules/{slug}.md` | [docs.devin.ai](https://docs.devin.ai/desktop/cascade/memories) |
<!-- /generated: stubs -->

## Staleness

`verifiedAgainst.date` is machine-readable, so a profile that has not been re-checked within
a chosen window is detectable rather than merely regrettable. `Registry.verificationAges()`
returns the age of every profile's check, and **`scripts/check-agentify.mjs` check 10 fails
the build when any profile is older than 180 days** — every `pnpm verify` run, not a warning
someone might read.

This paragraph said the opposite until 2026-08-01: *"wiring that into a CI warning is a small,
unbuilt follow-up … the responsibility is a human's."* It had been wired for a phase. The
sentence was hand-written about behaviour that lives in code, which is the same defect as the
`honestyNote` above one layer out, and it is why the tables on this page are generated rather
than typed.
