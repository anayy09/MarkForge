/**
 * Typst escaping, asserted by **compiling** rather than by matching the source.
 *
 * ## Why these tests exist and what they deliberately do not cover
 *
 * `scripts/check-pdf-determinism.mjs` proves the same input twice gives the same bytes, and
 * the `md->pdf->md` fidelity loop proves how much survives a round trip. Neither can see the
 * failure mode this file is about: **source that is well-formed to look at and invalid to
 * compile.** Both of those gates run the committed corpus, and the corpus is written by people
 * being reasonable. Nobody writes a heading called `#let x = 1`.
 *
 * The shape to generalise from is the `#figure(` defect fixed on 2026-08-02. `block()` returns
 * *markup*; a function argument is *code* context, where a leading `#` is a syntax error. The
 * emitted source looked entirely plausible — `#figure(\n#emph[A diagram], caption: [...])` —
 * and Typst rejected the whole document with a bare `Error`, so the CLI printed `markforge: `
 * and nothing else. No unit test existed, and no fixture reached it: the four Markdown files
 * in the determinism gate have no figure. It took adding a PDF column to the surface-parity
 * matrix, three phases later, for an HTML fixture to hit it.
 *
 * So: **every case here compiles the generated source**, and the inputs are adversarial rather
 * than corpus-realistic. A test that asserted `expect(source).toContain("\\#")` would encode
 * what we already believe. Compiling asks Typst.
 *
 * ADR-0003 rejected LaTeX partly because escaping arbitrary text into it is an unbounded
 * source of silent corruption, and claimed Typst's set is nine characters that `esc` handles.
 * That claim had nothing behind it until this file.
 */
import { describe, it, expect } from "vitest";
import { toTypst, esc } from "../src/index.js";
import { parseMarkdown } from "@markforge/adapters-md";
import type { AnyNode, MarkForgeDocument } from "@markforge/ir";

const { NodeCompiler } = await import("@myriaddreamin/typst-ts-node-compiler");

/**
 * Compiles, and surfaces the failure as a readable assertion rather than a thrown `Error`.
 *
 * The binding reports syntax failures as an `Error` whose `message` is empty and whose `code`
 * carries the real text — which is exactly why the original defect reached the user as
 * `markforge: ` with nothing after it.
 */
function compiles(source: string): { ok: true } | { ok: false; why: string } {
  try {
    NodeCompiler.create({}).pdf({ mainFileContent: source });
    return { ok: true };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    return { ok: false, why: String(err.code ?? err.message ?? e) };
  }
}

/** Asserts the document compiles, naming the Typst diagnostic when it does not. */
function expectCompiles(doc: MarkForgeDocument, label: string): void {
  const { source } = toTypst(doc);
  const result = compiles(source);
  expect(result.ok ? "compiles" : `${label}: ${result.why}\n---\n${source}`).toBe("compiles");
}

const fromMd = (md: string): MarkForgeDocument => parseMarkdown(md, { path: "t.md" }).document;

/** A document whose body is exactly these nodes. `toTypst` reads `body` and `metadata` only. */
const fromNodes = (...children: AnyNode[]): MarkForgeDocument =>
  ({ body: { type: "root", children } }) as unknown as MarkForgeDocument;

const text = (value: string): AnyNode => ({ type: "text", value }) as unknown as AnyNode;
const para = (...kids: AnyNode[]): AnyNode =>
  ({ type: "paragraph", children: kids }) as unknown as AnyNode;

/**
 * The adversarial set. Every one is a Typst construct, not an awkward character.
 *
 * `#` opens code mode, `$` opens math, `@` starts a reference, `<>` delimit labels, `[]`
 * delimit content blocks, `\` is the escape itself, and `*`/`_`/`` ` `` are markup. A closing
 * `]` is the one that generalises the figure bug: anywhere we emit `[...]`, an unescaped `]`
 * in the payload ends the block early and everything after it is read as code.
 */
const HOSTILE: Record<string, string> = {
  "code-mode opener": "#let x = 1",
  "bare hash": "# not a heading",
  "math opener": "$a + b$",
  "reference sigil": "@some-key",
  "label delimiters": "<label>",
  "content-block close": "]] and [[",
  "lone closing bracket": "]",
  "backslash": "C:\\Users\\x\\y",
  "double backslash": "\\\\",
  "markup chars": "*bold* _under_ `tick`",
  "quotes": 'he said "hi" and \'bye\'',
  "figure-slot shape": "#figure(caption: [x])",
  "everything": "#$@<>[]\\*_`\"",
};

describe("the harness itself can fail", () => {
  // Every assertion in this file is "it compiled", and a suite whose every case passes is
  // indistinguishable from a suite that cannot fail. `compiles()` wraps a try/catch, so a
  // binding that silently returned success — or a typo that never invoked it — would turn all
  // 94 cases green. This is the check on the checker.

  it("reports invalid Typst as invalid", () => {
    const bad = compiles("#let = = =\n#figure(\n#emph[x]\n)");
    expect(bad.ok).toBe(false);
  });

  it("reports the original defect's exact shape as invalid", () => {
    // Markup in a code-context argument: what the figure emitter produced before the fix.
    const bad = compiles("#figure(\n#emph[A diagram], caption: [Figure 1.]\n)");
    expect(bad.ok).toBe(false);
  });

  it("reports valid Typst as valid, so the predicate is not simply always-false", () => {
    expect(compiles("#set document(date: none)\n= Title\n\nBody.").ok).toBe(true);
  });

  it("catches an unescaped hostile string, so the escaping cases are not vacuous", () => {
    // The same text `esc` would neutralise, injected raw into markup. If this compiled, the
    // escaping tests above would prove nothing about escaping.
    const raw = compiles("#set document(date: none)\n\n#let x = 1 ] unbalanced [");
    expect(raw.ok).toBe(false);
  });
});

describe("toTypst escaping — hostile text in markup context", () => {
  for (const [name, hostile] of Object.entries(HOSTILE)) {
    it(`survives ${name} in prose`, () => {
      expectCompiles(fromNodes(para(text(hostile))), name);
    });

    it(`survives ${name} in a heading`, () => {
      expectCompiles(
        fromNodes({ type: "heading", depth: 2, children: [text(hostile)] } as unknown as AnyNode),
        name,
      );
    });
  }

  it("escapes every character it claims to, and no others", () => {
    // ADR-0003 names the set. Asserted directly because `esc` is exported and the claim is
    // about the function rather than about any document.
    expect(esc("#$@*_`<>[]\\")).toBe("\\#\\$\\@\\*\\_\\`\\<\\>\\[\\]\\\\");
    // Anything else is literal — the property ADR-0003 preferred over LaTeX.
    expect(esc("a-b/c:d;e,f.g?h!i(j)k{l}m")).toBe("a-b/c:d;e,f.g?h!i(j)k{l}m");
  });
});

describe("toTypst escaping — hostile text in argument and content slots", () => {
  // These are the `#figure(` family: places where the emitter writes `[...]` or `"..."` into
  // a code-context argument. An unescaped `]` or `"` ends the slot early, and the rest of the
  // document is then parsed as something else entirely.

  for (const [name, hostile] of Object.entries(HOSTILE)) {
    it(`survives ${name} in link text and URL`, () => {
      expectCompiles(
        fromNodes(
          para({
            type: "link",
            url: `https://example.com/?q=${hostile}`,
            children: [text(hostile)],
          } as unknown as AnyNode),
        ),
        name,
      );
    });

    it(`survives ${name} in inline code`, () => {
      expectCompiles(fromNodes(para({ type: "inlineCode", value: hostile } as unknown as AnyNode)), name);
    });

    it(`survives ${name} in a code block, including its language`, () => {
      expectCompiles(
        fromNodes({ type: "code", lang: hostile, value: hostile } as unknown as AnyNode),
        name,
      );
    });

    it(`survives ${name} in a figure caption — the slot that broke`, () => {
      expectCompiles(
        fromNodes({
          type: "figure",
          children: [
            para(text("body")),
            { type: "caption", children: [text(hostile)] } as unknown as AnyNode,
          ],
        } as unknown as AnyNode),
        name,
      );
    });

    it(`survives ${name} in a table cell`, () => {
      const cell = (v: string): AnyNode =>
        ({
          type: "tableCell",
          rowSpan: 1,
          colSpan: 1,
          isHeader: false,
          children: [para(text(v))],
        }) as unknown as AnyNode;
      expectCompiles(
        fromNodes({
          type: "table",
          children: [{ type: "tableRow", children: [cell(hostile), cell("ok")] } as unknown as AnyNode],
        } as unknown as AnyNode),
        name,
      );
    });
  }

  it("survives a figure whose body is markup, which is the original defect", () => {
    // `block()` returns markup and a function argument is code context. Emitted bare, this
    // produced `#figure(\n#emph[...])` and Typst rejected the document.
    expectCompiles(
      fromNodes({
        type: "figure",
        children: [
          para({ type: "emphasis", children: [text("A diagram")] } as unknown as AnyNode),
          { type: "caption", children: [text("Figure 1.")] } as unknown as AnyNode,
        ],
      } as unknown as AnyNode),
      "markup in a figure body",
    );
  });

  it("survives hostile text arriving through the Markdown adapter, not only hand-built IR", () => {
    // Hand-built nodes could accidentally avoid a path the real adapter takes. This is the
    // same hostility through `parseMarkdown`, which is what a user actually types.
    const md = [
      "# Heading with #hash and $dollar$",
      "",
      "Prose with `inline #code`, a [link](https://x/?q=]) and \\*escapes\\*.",
      "",
      "```#lang",
      "#let x = 1",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| `]` | #x |",
    ].join("\n");
    expectCompiles(fromMd(md), "markdown-sourced hostility");
  });
});
