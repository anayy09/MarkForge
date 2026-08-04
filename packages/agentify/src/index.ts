/**
 * @markforge/agentify — the Agent Context Compiler (SPEC §10).
 *
 * Three rules shape this package, and they are why it looks the way it does:
 *
 *   1. **Targets are data, not code** (ADR-0013). No module here knows a vendor filename.
 *      A target is JSON in `targets/`, validated against `schema/target.v0.schema.json`,
 *      and adding one is adding a file.
 *   2. **The traceability gate is mandatory and has no bypass** (§10.6). `verify.ts` works
 *      from the emitted string rather than from the fragment list it was built with, and
 *      re-checks scaffolding against the profile, so "mark it scaffolding" cannot become
 *      the bypass flag the spec refuses to have.
 *   3. **Nothing reaches a model unless asked.** This package does not depend on
 *      `@markforge/llm`; the optional help is injected as functions (`AgentifyAssist`), the
 *      same composition `@markforge/core` uses, so `--no-llm` is the default by
 *      construction rather than by discipline.
 */
export { compile } from "./compile.js";
export type {
  AgentifyAssist,
  CompileOptions,
  CompileResult,
  RunReport,
  TargetResult,
} from "./compile.js";

/*
 * `loadRegistry` is deliberately **not** re-exported here.
 *
 * It lives at `@markforge/agentify/registry-node` because it needs node:fs, node:module and
 * ajv, and this index must bundle and evaluate against web-platform globals alone —
 * `check-browser-bundle.mjs` probes exactly this file. Re-exporting it would pull four Node
 * builtins into the browser entry point and put SPEC §10 back out of the browser's reach,
 * which is the state this package was in until the split. Callers holding resolved profiles
 * use `registryFromProfiles`; callers holding a directory import the subpath.
 */
export { registryFromProfiles, sectionForCategory, countTokens, counterDescription, verificationAge } from "./targets.js";
export type {
  Registry,
  SectionRender,
  TargetKind,
  TargetOutput,
  TargetProfile,
  TargetSection,
} from "./targets.js";

export { classifyByRules, applyModelOpinion, documentFeatures } from "./classify.js";
export type { Classification, RoleScore } from "./classify.js";

export { extractUnits, splitSentences, authorityOf } from "./extract.js";
export type { SourceDocument } from "./extract.js";

export { deduplicate, cosine } from "./dedup.js";
export { mergeVerdict, salientTokens } from "./merge-predicate.js";
export type { MergeVerdict } from "./merge-predicate.js";
export type { DedupOptions, DedupResult, Embedder } from "./dedup.js";

export { detectConflicts, renderConflictReport } from "./conflicts.js";
export type { Conflict, ConflictReport, ConflictSide } from "./conflicts.js";

export { planBudget, valueOf, compareUnitsIn } from "./budget.js";
export type { BudgetPlan, RankedUnit } from "./budget.js";

export { assemble, satisfiesCondition, kebab, MARKERS } from "./assemble.js";
export type { EmittedFile, EmittedSection, Fragment, ScaffoldKind } from "./assemble.js";

export { verify, verifyFile, dropUnsupported } from "./verify.js";
export type { FileVerification, UnsupportedSentence, VerificationResult } from "./verify.js";

export { buildManifest, serializeManifest } from "./emit.js";
export type {
  ProvenanceFile,
  ProvenanceManifest,
  ProvenanceSection,
  ProvenanceSentence,
} from "./emit.js";

export {
  compareUnits,
  makeUnit,
  normalizeUnitText,
  sourceOrderOf,
  unitContentHash,
  unitId,
  DOCUMENT_ROLES,
  UNIT_CATEGORIES,
} from "./units.js";
export type { ContextUnit, DocumentRole, UnitCategory, UnitSource } from "./units.js";
