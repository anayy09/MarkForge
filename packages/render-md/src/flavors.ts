/**
 * Markdown flavour presets — data, not code (SPEC §4.1).
 *
 * ## Why this exists at all
 *
 * `markdown.flavor` has been in `schema/markforge.config.v0.schema.json` since Phase 0,
 * enumerating seven values, generated into `packages/core/src/generated/config.ts`, and
 * **read by nothing**. Setting `flavor: "commonmark"` produced GFM. SPEC §4.1 describes the
 * presets as shipped data in the present tense; there was no data and no consumer.
 *
 * That is a worse defect than an unbuilt feature, because the config schema advertises the
 * option to users and a JSON-schema-aware editor autocompletes it. The choice was to build it
 * or to strike it (ADR-0021 records both); it is built, because §4.1 is normative and the
 * option is already public.
 *
 * ## What a preset is allowed to be
 *
 * A preset declares **which constructs the flavour can express** and **how it spells the ones
 * it can**. It does not contain behaviour. `render-md` reads `syntax` to decide whether to
 * emit or degrade, and `stringify` to decide how — so adding a flavour is an entry here, per
 * §4.1's "nothing about a flavour lives in code".
 *
 * ## The constraint that makes the fixture meaningful
 *
 * `scripts/check-flavor-distinctness.mjs` requires the seven presets to produce seven
 * **byte-distinct** renders of one construct-dense document. A preset that ties with another
 * is not a preset, it is a duplicate name, and the gate strikes it rather than letting the
 * registry imply a distinction that does not exist.
 */

/** Which spelling a flavour uses for a construct, or `false` if it cannot express one. */
export interface FlavorSyntax {
  /** `"gfm"` = `[^1]`; `"pandoc"` = `[^1]` with a different definition placement; `false` = unsupported. */
  footnotes: "gfm" | "pandoc" | false;
  /** `"dollar"` = `$…$` / `$$…$$`; `"mdx"` = JSX expression; `false` = unsupported. */
  math: "dollar" | "mdx" | false;
  /** Admonition spelling. Each ecosystem invented its own and none is portable. */
  admonitions: "gfm" | "docusaurus" | "mkdocs" | "obsidian" | "pandoc" | false;
  /** `"pipe"` = GFM tables; `false` = no table syntax, so tables degrade to HTML. */
  tables: "pipe" | false;
  /** Front-matter language, or `false` where the flavour has no convention. */
  frontMatter: "yaml" | "toml" | false;
  /** Whether raw HTML survives. MDX parses HTML as JSX, so arbitrary HTML is unsafe. */
  rawHtml: boolean;
}

export interface FlavorPreset {
  readonly id: string;
  readonly displayName: string;
  /** Documentation URL, so a disputed claim has somewhere to be checked. */
  readonly reference: string;
  readonly syntax: FlavorSyntax;
  /** Overrides onto `DEFAULT_MD_OPTIONS`. Presentation only — never capability. */
  readonly stringify: Record<string, string | number | boolean>;
}

export const FLAVORS: Record<string, FlavorPreset> = {
  commonmark: {
    id: "commonmark",
    displayName: "CommonMark",
    reference: "https://spec.commonmark.org/0.31.2/",
    // The strict baseline: no tables, no footnotes, no math, no admonitions. This is the
    // preset that makes the no-silent-loss path testable, because it is the only target that
    // genuinely cannot hold constructs the IR routinely carries.
    syntax: {
      footnotes: false,
      math: false,
      admonitions: false,
      tables: false,
      frontMatter: false,
      rawHtml: true,
    },
    stringify: { bullet: "-", emphasis: "_", strong: "*" },
  },

  gfm: {
    id: "gfm",
    displayName: "GitHub Flavored Markdown",
    reference: "https://github.github.com/gfm/",
    syntax: {
      footnotes: "gfm",
      // GitHub added LaTeX rendering in 2022, so `$…$` and `$$…$$` are expressible here.
      // The first draft said `false`, which was a claim about GFM's original spec rather
      // than about the flavour anyone actually targets today.
      math: "dollar",
      // GitHub alerts are `> [!NOTE]`, upper case. Obsidian callouts are `> [!note]`, lower
      // case, and the two renderers each ignore the other's casing. Giving GFM Obsidian's
      // spelling made the two presets byte-identical and the distinctness gate said so.
      admonitions: "gfm",
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: true,
    },
    stringify: { bullet: "-", emphasis: "_", strong: "*" },
  },

  mdx: {
    id: "mdx",
    displayName: "MDX",
    reference: "https://mdxjs.com/docs/what-is-mdx/",
    // Raw HTML is `false` deliberately: MDX parses HTML as JSX, so an unclosed `<br>` or a
    // stray `{` is a compile error rather than text. Emitting arbitrary HTML into MDX
    // produces a file that does not build, which is worse than degrading.
    syntax: {
      footnotes: false,
      math: "mdx",
      admonitions: false,
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: false,
    },
    stringify: { bullet: "*", emphasis: "_", strong: "*" },
  },

  docusaurus: {
    id: "docusaurus",
    displayName: "Docusaurus",
    reference: "https://docusaurus.io/docs/markdown-features/admonitions",
    syntax: {
      footnotes: "gfm",
      math: "dollar",
      admonitions: "docusaurus",
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: false,
    },
    stringify: { bullet: "-", emphasis: "_", strong: "*" },
  },

  "mkdocs-material": {
    id: "mkdocs-material",
    displayName: "MkDocs Material",
    reference: "https://squidfunk.github.io/mkdocs-material/reference/admonitions/",
    syntax: {
      footnotes: "pandoc",
      math: "dollar",
      admonitions: "mkdocs",
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: true,
    },
    stringify: { bullet: "-", emphasis: "*", strong: "*" },
  },

  obsidian: {
    id: "obsidian",
    displayName: "Obsidian",
    reference: "https://help.obsidian.md/callouts",
    syntax: {
      footnotes: "gfm",
      math: "dollar",
      admonitions: "obsidian",
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: true,
    },
    stringify: { bullet: "-", emphasis: "_", strong: "*" },
  },

  pandoc: {
    id: "pandoc",
    displayName: "Pandoc Markdown",
    reference: "https://pandoc.org/MANUAL.html#pandocs-markdown",
    syntax: {
      footnotes: "pandoc",
      math: "dollar",
      admonitions: "pandoc",
      tables: "pipe",
      frontMatter: "yaml",
      rawHtml: true,
    },
    // `strong: "_"` rather than `"**"`: the option names the *character* to repeat, not the
    // delimiter, and `mdast-util-to-markdown` rejects a two-character value outright. Caught
    // by the distinctness gate's first run, which is the cheapest place to learn it.
    stringify: { bullet: "-", emphasis: "*", strong: "_" },
  },
};

export type FlavorId = keyof typeof FLAVORS;

/** Resolves a flavour id, throwing rather than silently falling back. */
export function resolveFlavor(id: string | undefined): FlavorPreset {
  if (id === undefined) return FLAVORS["gfm"] as FlavorPreset;
  const preset = FLAVORS[id];
  if (!preset) {
    // Never a silent fallback. `markdown.flavor` reaching this function with an unknown value
    // means the config schema and this registry have drifted, and quietly emitting GFM is how
    // the setting spent five phases doing nothing.
    throw new Error(
      `render-md: unknown markdown flavour "${id}". Known: ${Object.keys(FLAVORS).sort().join(", ")}.`,
    );
  }
  return preset;
}
