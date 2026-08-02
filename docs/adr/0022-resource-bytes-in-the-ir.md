# ADR-0022: The IR carries resource bytes, because a description of an image is not an image

- Status: **Accepted**
- Date: 2026-08-01
- Relates to: `SPEC.md` §2.2, §2.3, §3 rule A7, §4.2; brief §3.2, §3.3
- Enforced by: scripts/check-ir-structure.mjs

## Context

`STATUS.md` carried *"Images are not embedded in DOCX output — an image becomes `[alt text]`"*
as a **writer** gap from Phase 1 to Phase 6, and it was the first item under *What to fix
first*. Six phases of that framing were wrong.

`Resource` — the table SPEC §2.2 describes as holding "images, embedded files, by content
hash" — declared `resourceId`, `mediaType`, `contentHash`, `byteLength`, and an optional
`path`. **No bytes.** So `collectResources` in the DOCX adapter read an image out of the
package, hashed it, recorded its length, and discarded it; `path` pointed into the *source*
package, which does not exist once parsing is done.

The DOCX writer's `[alt text]` placeholder was therefore not a shortcut. It was the only thing
the writer could do, because the IR handed it a description of an image and no image.

Two consequences the old framing hid:

1. **Every adapter lost every image**, not just the DOCX one, and every `X → IR → Y`
   conversion lost them — HTML, PPTX, and the OCR path included.
2. **A diagnostic actively claimed otherwise.** The TIFF warning read *"preserved in the IR,
   but no browser renders TIFF natively"*. The first clause was false; only the metadata was
   preserved.

It was found by trying to write the images out and discovering there was nothing to write.

## Decision

**Add `data` to `Resource`: the bytes, base64-encoded, optional.**

The schema's own description said "Never base64-inlined into the tree", and that stays true —
`data` is on the resource *table*, keyed by content hash, which is the whole point of A7's
"never base64-inlined into the tree" and of deduplicating by hash. An image used twice is
stored once.

`base64`/`fromBase64` live in `@markforge/ir` and are hand-written rather than using `Buffer`,
because `ir` is in ADR-0015's eager browser tier and `check-browser-bundle.mjs` fails on any
`node:` reach. One implementation, not two selected by platform, for the reason ADR-0015
already gives about `@noble/hashes`.

## Rejected alternatives

**Leave `Resource` alone and have the renderer read from `path`.** Smallest change, and it
breaks renderer rule R2 — "a renderer reads `doc` and `profile` and nothing else, no
filesystem access outside declared profile assets". It also cannot work at all in the browser
build or over the HTTP API, where there is no source package to read from. The IR is supposed
to be self-contained; a resource table that only works when the original file is still on disk
is not.

**A side-channel: `parse` returns `{ document, resources }` and the caller wires it through.**
Keeps the schema unchanged and moves the problem to every caller — CLI, HTTP, MCP, and browser
would each need to remember, and the one that forgot would lose images silently. The surface
parity gate compares bytes across those four, so it would have caught a *divergence*, but not
all four being wrong the same way.

**Store a path into a sidecar directory the renderer may read.** Externalization is a real
need for large media and `path` already expresses it — but making it the *only* mechanism
means the common case (convert this file to that file) requires a temporary directory. Kept as
the optional escape it already was.

**Strike images from the IR and document the limit.** Honest, and it removes a capability the
brief asks for by name (§5.2, "embedded images with alt text") for a schema field.

## Consequences

- **`.mfir.json` grows by roughly 4/3 of the embedded media.** Real, and stated in
  `docs/LIMITS.md`. `path` remains available for a caller who would rather externalize.
- Images now round-trip DOCX → IR → DOCX as media parts with relationships and a `w:drawing`,
  measured on `templates/academic-manuscript.docx`.
- **An image with no bytes is still reported**, and that branch is now the genuine residue: an
  HTML `<img src="https://…">` has no inline data and this project does not fetch over the
  network (brief §3.6), so it degrades to alt text with a diagnostic saying exactly that.
- The TIFF diagnostic's false clause is corrected rather than deleted, because the sentence
  was evidence of the same misunderstanding.
- `byteLength` is now redundant with `data` when both are present. Kept: it is required, it is
  cheap, and a consumer that only wants to know how big something is should not have to decode
  base64 to find out.
