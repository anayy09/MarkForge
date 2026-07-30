# scripts/

Phase 0 verification. These are the only executable files in the repository, and they exist to
check the documents rather than to implement anything — `check-docs.mjs` asserts its own
exemption is narrow (no package manifests anywhere, no code outside this directory).

| Script | Dependencies | What it checks |
| --- | --- | --- |
| `check-docs.mjs` | none | Deliverables agree with each other and with the brief |
| `check-schemas.mjs` | `ajv`, `ajv-formats` | The three JSON Schemas compile in strict mode; the worked examples validate |
| `inspect-docx.ps1` | none (Windows PowerShell) | Read-only inspection of a DOCX: styles, provenance, numbering, theme fonts |

## Running them

```sh
node scripts/check-docs.mjs          # works on a fresh clone, no install needed

npm i --no-save ajv ajv-formats      # Phase 0 ships no package.json
node scripts/check-schemas.mjs
```

`check-schemas.mjs` **skips with exit 0** when ajv is absent, rather than failing: a missing dev
dependency is not a specification defect, and a check that fails for environmental reasons
teaches people to ignore it. Phase 1 adds the workspace and both become CI jobs.

Both resolve the repository root from their own location, so neither contains an absolute path.
That is the same rule `SPEC.md` §1 imposes on MarkForge's own output, and it applies here for the
same reason: an absolute path makes a result unreproducible on another machine.

## `inspect-docx.ps1`

A hand tool, not a check. It prints what `markforge check --reference-doc` is specified to report
(`SPEC.md` §4.2.1) before that command exists, which is how the IEEE template measurements in
`docs/TEMPLATES.md` §3.1 were obtained.

```powershell
./scripts/inspect-docx.ps1 -Path fixtures/local/ieee-conference-template.docx
```

Reads the ZIP container in memory and extracts nothing to disk. Reports the part list with
sizes, `docProps` provenance, every defined style with its `basedOn` chain, numbering
definitions and `startOverride` count, theme font tokens, and the styles actually used in the
body with counts plus totals for paragraphs, tables, direct `w:rPr` runs, OMML equations, and
drawings.

Use it on any third-party document before deciding what a fixture or reference document is worth.
The style-name-versus-`styleId` distinction it surfaces is the one that matters most in practice
(`SPEC.md` §4.2.2).

## What these are not

They do not test MarkForge, because MarkForge does not exist yet. They test the *specification*
for internal consistency — that every node type in the schema is documented and reachable, every
ADR is cited, every link resolves, every config field in prose exists in the schema, and no
unlicensed binary is committable. Phase 1 adds real tests against real fixtures.
