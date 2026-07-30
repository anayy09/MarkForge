/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: schema/markforge.config.v0.schema.json
 * Regenerate: pnpm codegen
 *
 * Hand edits are lost on the next run. If a type is wrong here, the schema is
 * wrong; fix the schema (docs/SPEC.md §2.2).
 */

/**
 * Style profile and run configuration (brief section 5.5, docs/SPEC.md section 7). Generated from the Zod schema in @markforge/core so the two cannot drift. Precedence: CLI flags > MARKFORGE_* env > this file > named profile > built-in defaults.
 */
export interface MarkForgeConfig {
  $schema?: string;
  /**
   * Named preset. Every field below overrides the preset.
   */
  profile?: string;
  /**
   * Exit 2 when any lossy diagnostic is emitted (brief section 3.3).
   */
  strict?: boolean;
  /**
   * Declared root that all recorded paths are relative to. Absolute paths never appear in output (determinism).
   */
  root?: string;
  markdown?: {
    /**
     * Flavour presets are data, not code (docs/SPEC.md section 4.1).
     */
    flavor?:
      "commonmark" | "gfm" | "mdx" | "docusaurus" | "mkdocs-material" | "obsidian" | "pandoc";
    headings?: "atx" | "setext";
    bullet?: "-" | "*" | "+";
    emphasis?: "_" | "*";
    strong?: "*" | "_";
    fence?: "`" | "~";
    fences?: boolean;
    listIndent?: "one" | "tab" | "mixed";
    /**
     * 0 disables reflow. Reflowing destroys diff stability, which brief section 6.2 requires.
     */
    lineWidth?: number;
    frontMatter?: "preserve" | "yaml" | "toml" | "none";
    lint?: {
      config?: string;
      autofix?: boolean;
      /**
       * Autofix runs to a fixed point. Hitting the cap is an error, not a silent stop (docs/SPEC.md section 4.1).
       */
      maxIterations?: number;
    };
  };
  /**
   * Applied once, at the IR level (brief section 5.1). See docs/SPEC.md section 2.8.
   */
  whitespace?: {
    emptyParagraphsToSpacing?: boolean;
    collapseInteriorWhitespace?: boolean;
    preserveHardBreaks?: boolean;
    trimTrailing?: boolean;
    removeSoftHyphens?: boolean;
    preserveNonBreakingSpaces?: boolean;
  };
  docx?: {
    /**
     * Path to a .docx or .dotx. Its stylesheets, theme, numbering, and section properties are used; its content is ignored (ADR-0004).
     */
    referenceDoc?: string;
    /**
     * IR role to named style. Defaults use Pandoc's vocabulary verbatim, so any Pandoc reference doc works unchanged.
     */
    styleMap?: {
      [k: string]: string;
    };
    onMissingStyle?: "warn" | "error" | "synthesize";
    revisionMode?: "clean" | "showInsertions" | "showAll";
    /**
     * Forbids direct formatting on blocks. Turning this off reproduces the 'uneven fonts' defect in brief section 5.1.
     */
    namedStylesOnly?: boolean;
  };
  pdf?: {
    /**
     * ADR-0003.
     */
    engine?: "typst";
    theme?: string;
    fonts?: {
      family: string;
      /**
       * @minItems 1
       */
      files: [string, ...string[]];
    }[];
    /**
     * Must stay true for byte-identical output across machines.
     */
    ignoreSystemFonts?: boolean;
    standard?: "none" | "pdf/a-2b" | "pdf/a-3b" | "pdf/ua-1";
    revisionMode?: "clean" | "showInsertions" | "showAll";
  };
  html?: {
    stylesheet?: string;
    singleFile?: boolean;
    revisionMode?: "clean" | "showInsertions" | "showAll";
  };
  /**
   * docs/SPEC.md section 5.
   */
  inference?: {
    headings?: boolean;
    lists?: boolean;
    tables?: boolean;
    /**
     * Score gap below which a decision is declared ambiguous rather than taken silently.
     */
    ambiguityMargin?: number;
    /**
     * Path to localized heading style-name and numbering-pattern data.
     */
    headingVocabulary?: string;
  };
  /**
   * Off by default; brief section 3.6 forbids network access as a default.
   */
  llm?: {
    [k: string]: unknown;
  };
  /**
   * docs/SPEC.md section 10.
   */
  agentify?: {
    /**
     * @minItems 1
     */
    targets?: [string, ...string[]];
    registry?: string;
    outDir?: string;
    conflicts?: "report" | "failOnConflict";
    dedupeThreshold?: number;
    /**
     * Inputs to conflict ordering. Conflicts are always reported regardless (brief section 6.1).
     */
    authority?: {
      sourceRanking?: string[];
      preferNewer?: boolean;
    };
    traceability?: {
      /**
       * The verification gate. There is deliberately no bypass flag (docs/SPEC.md section 10.6).
       */
      required?: number;
    };
    provenanceManifest?: string;
  };
  fidelity?: {
    baseline?: string;
    tolerance?: number;
    metrics?: (
      "structural" | "textStrict" | "textLoose" | "tableFull" | "tableContent" | "inlineStyling"
    )[];
    /**
     * Scoreboard columns. brief section 10 requires honesty where we lose, so rows cannot be suppressed.
     */
    competitors?: ("word-to-markdown-js" | "pandoc" | "markitdown")[];
  };
  report?: {
    path?: string;
    format?: "json" | "markdown" | "both";
    includeInferenceLog?: boolean;
  };
}
