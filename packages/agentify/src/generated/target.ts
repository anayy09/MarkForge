/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: packages/agentify/schema/target.v0.schema.json
 * Regenerate: pnpm codegen
 *
 * Hand edits are lost on the next run. If a type is wrong here, the schema is
 * wrong; fix the schema (docs/SPEC.md §2.2).
 */

/**
 * An agent-context output target, expressed as data (brief section 6.3, ADR-0013). AGENTS.md is the base profile; other flat-Markdown targets declare `extends: "agents-md"` and override only what differs. Every path and filename MUST be re-verified against current vendor documentation at implementation time; see docs/TARGETS.md.
 */
export interface AgentTargetProfile {
  /**
   * Stable profile id, e.g. agents-md, claude-md, claude-skills, mcp-manifest.
   */
  id: string;
  targetVersion: string;
  displayName: string;
  /**
   * Profile id this one is a delta on. AGENTS.md is the base; see ADR-0013.
   */
  extends?: string;
  /**
   * Assembly semantics. scopedRuleSet targets (Cursor .mdc) partition units by glob rather than budgeting one file.
   */
  kind: "flatMarkdown" | "scopedRuleSet" | "skillPackage" | "commandSet" | "manifest";
  /**
   * firstClass targets carry a traceability gate and fixture tests; stub targets are schema-valid but ungated.
   */
  tier?: "firstClass" | "stub";
  vendor?: string;
  docsUrl?: string;
  /**
   * Provenance for the filenames and conventions in this profile. Brief section 6.3 forbids trusting training data here.
   */
  verifiedAgainst: {
    url: string;
    date: string;
    note?: string;
  };
  /**
   * @minItems 1
   */
  outputs: [
    {
      /**
       * Repo-relative output path. May contain {slug} for scopedRuleSet and skillPackage targets.
       */
      path: string;
      role: "primary" | "secondary" | "manifest" | "asset";
      /**
       * Optional expression over the unit set, e.g. 'hasCategory(command)'. Absent means always emitted.
       */
      condition?: string;
    },
    ...{
      /**
       * Repo-relative output path. May contain {slug} for scopedRuleSet and skillPackage targets.
       */
      path: string;
      role: "primary" | "secondary" | "manifest" | "asset";
      /**
       * Optional expression over the unit set, e.g. 'hasCategory(command)'. Absent means always emitted.
       */
      condition?: string;
    }[]
  ];
  budget: {
    primaryTokens: number;
    secondaryTokens?: number;
    /**
     * Token counting method, named in the run report so an estimate is never mistaken for a measurement.
     */
    counter: {
      method: "modelTokenizer" | "approximate";
      model?: string;
      charsPerToken?: number;
    };
    overflow?: "linkToSecondary" | "truncateLowestValue" | "fail";
  };
  frontMatter?: {
    supported: boolean;
    language?: "yaml" | "toml";
    required?: string[];
    /**
     * JSON Schema for the front matter this target expects. Cursor's glob-scoped .mdc front matter is expressed here.
     */
    schema?: {
      [k: string]: unknown;
    };
  };
  /**
   * Whether the target can reference other files, which determines whether progressive disclosure is available.
   */
  imports?: {
    supported: boolean;
    /**
     * e.g. '@{path}' or '[{title}]({path})'.
     */
    syntax?: string;
    maxDepth?: number;
  };
  /**
   * For scopedRuleSet targets: how units are partitioned across files by path glob.
   */
  scoping?: {
    byGlob?: boolean;
    /**
     * Front-matter field carrying the glob, e.g. 'globs'.
     */
    globField?: string;
    alwaysApplyField?: string;
  };
  /**
   * Ordered section template. Ordering is fixed so output is diff-stable (docs/SPEC.md section 10.8).
   */
  sections?: {
    id: string;
    heading: string;
    headingLevel?: number;
    /**
     * @minItems 1
     */
    categories: [
      (
        | "constraint"
        | "invariant"
        | "convention"
        | "command"
        | "entity"
        | "glossaryTerm"
        | "decision"
        | "antiPattern"
        | "dependency"
        | "environmentVariable"
      ),
      ...(
        | "constraint"
        | "invariant"
        | "convention"
        | "command"
        | "entity"
        | "glossaryTerm"
        | "decision"
        | "antiPattern"
        | "dependency"
        | "environmentVariable"
      )[]
    ];
    categoryWeight?: number;
    render?: "bulletList" | "table" | "prose" | "codeBlock" | "definitionList";
    maxUnits?: number;
    /**
     * Marks generated scaffolding exempt from the traceability gate. Templates declare this; it is never inferred (docs/SPEC.md section 10.6).
     */
    scaffoldOnly?: boolean;
    omitWhenEmpty?: boolean;
  }[];
  tone?: {
    voice?: "imperative" | "declarative";
    person?: "second" | "third";
    maxSentenceWords?: number;
  };
  traceability?: {
    required?: number;
    sentenceSegmenter?: "icu" | "simple";
  };
  /**
   * Escape hatch for target-specific keys that do not generalize. Keeping them here rather than in code is the point of ADR-0013.
   */
  vendorFields?: {
    [k: string]: unknown;
  };
}
