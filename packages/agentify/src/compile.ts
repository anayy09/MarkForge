/**
 * The pipeline — brief §6.1's seven stages, in order, with the gate between assembly and
 * emission where §10.6 puts it.
 *
 * Ingest happens *before* this function: the caller hands over parsed IR documents, because
 * §10.1 says ingest is "every source document → IR via the adapters of §3. No separate
 * ingestion path", and importing the adapters here would give this package a second one.
 *
 * The LLM is optional and injected, never imported (`AgentifyAssist`). Same reason
 * `@markforge/core` does it that way: ADR-0015 wants this to run in a browser, and ADR-0009's
 * "the conversion path cannot reach a model" is only enforceable if there is no import to
 * enforce against. With no assist supplied this is `--no-llm`, which is the default, and
 * every stage below still runs.
 */
import { DiagnosticBag, DiagnosticCode, type Diagnostic } from "@markforge/ir";
import { applyModelOpinion, classifyByRules } from "./classify.js";
import { extractUnits, type SourceDocument } from "./extract.js";
import { deduplicate, type Embedder } from "./dedup.js";
import { detectConflicts, type ConflictReport } from "./conflicts.js";
import { planBudget, type BudgetPlan } from "./budget.js";
import { assemble, type EmittedFile } from "./assemble.js";
import { dropUnsupported, verify, type UnsupportedSentence, type VerificationResult } from "./verify.js";
import { buildManifest, type ProvenanceManifest } from "./emit.js";
import { counterDescription, type Registry, type TargetProfile } from "./targets.js";
import type { ContextUnit, DocumentRole } from "./units.js";

const AGENTIFY = { kind: "rule" as const, name: "@markforge/agentify", version: "0.1.0" };

/** Optional model-backed help. Every field absent is `--no-llm`. */
export interface AgentifyAssist {
  /** SPEC §10.4 — merges units restating one fact in different words. */
  embed?: Embedder;
  /** SPEC §10.2 — may adjust the rule-based role, never replace it. */
  classifyRole?: (input: {
    path: string;
    role: DocumentRole;
    candidates: DocumentRole[];
    excerpt: string;
  }) => Promise<{ role: DocumentRole; rationale: string } | undefined>;
  /** SPEC §10.3 — the prose categories the rules cannot reach. */
  extraUnits?: (input: { source: SourceDocument; existing: ContextUnit[] }) => Promise<ContextUnit[]>;
}

export interface CompileOptions {
  registry: Registry;
  targets: string[];
  traceabilityRequired?: number;
  dedupeThreshold?: number;
  conflicts?: "report" | "failOnConflict";
  /** `--budget`, overriding every target's primary budget. */
  budgetOverride?: number;
  /** How far a model opinion must beat the prior to win (SPEC §10.2). */
  roleMargin?: number;
  assist?: AgentifyAssist;
  /** A previous manifest, for §10.8 incremental regeneration. */
  previous?: ProvenanceManifest;
}

export interface TargetResult {
  target: string;
  profile: TargetProfile;
  files: EmittedFile[];
  plan: BudgetPlan;
  verification: VerificationResult;
}

export interface CompileResult {
  units: ContextUnit[];
  results: TargetResult[];
  conflicts: ConflictReport;
  manifest: ProvenanceManifest;
  diagnostics: Diagnostic[];
  drops: UnsupportedSentence[];
  /** True only when every target passed its gate. Drives exit 5. */
  passed: boolean;
  report: RunReport;
}

export interface RunReport {
  sources: { path: string; role: string; decidedBy: string; units: number; reused: boolean }[];
  merges: number;
  conflicts: number;
  targets: {
    id: string;
    tier: string;
    files: { path: string; tokens: number; sections: { heading: string; units: number; tokens: number }[] }[];
    tokenCounter: string;
    traceability: number;
    dropped: number;
    overflowed: number;
  }[];
}

export async function compile(
  sources: SourceDocument[],
  options: CompileOptions,
): Promise<CompileResult> {
  const diagnostics = new DiagnosticBag(AGENTIFY);
  const threshold = options.dedupeThreshold ?? 0.9;
  const roleMargin = options.roleMargin ?? 0.15;

  // --- §10.2 Classify, and §10.3 Extract.
  const perSource: RunReport["sources"] = [];
  const sourceRecords: { path: string; contentHash: string; role: string }[] = [];
  let units: ContextUnit[] = [];

  for (const source of sources) {
    const contentHash = source.document.contentHash ?? "";
    const prior = classifyByRules(source.document, source.path);

    // §10.8: a source whose bytes are unchanged does not need reclassifying or
    // re-extracting. Reported rather than silent, so a run that reused half its work says
    // so — a cache that is invisible is a cache nobody can debug.
    const previousSource = options.previous?.sources.find((s) => s.path === source.path);
    const reused = previousSource !== undefined && previousSource.contentHash === contentHash;
    if (reused) {
      diagnostics.info(
        DiagnosticCode.AGENTIFY_SOURCE_UNCHANGED,
        `agentify: ${source.path} is unchanged since the last run (${contentHash.slice(0, 12)}), ` +
          `so its ${previousSource.units} unit(s) were reused rather than re-extracted.`,
      );
    }

    let classification = prior;
    if (options.assist?.classifyRole) {
      const opinion = await options.assist.classifyRole({
        path: source.path,
        role: prior.role,
        candidates: prior.distribution.map((d) => d.role),
        excerpt: source.sourceText.slice(0, 2000),
      });
      classification = applyModelOpinion(prior, opinion, roleMargin);
      if (classification.modelChoice && classification.modelChoice !== prior.role) {
        diagnostics.info(
          DiagnosticCode.AGENTIFY_ROLE_LLM_DISAGREED,
          `agentify: the classifier proposed "${classification.modelChoice}" for ${source.path} ` +
            `where the rules scored "${prior.role}" highest; the ` +
            `${classification.decidedBy === "model" ? "model's choice was accepted (it was within " +
              `the ${roleMargin} margin)` : "rules stand (outside the margin)"}. ` +
            `Rationale: ${classification.modelRationale ?? "(none given)"}`,
        );
      }
    }
    if (classification.margin < 0.1) {
      diagnostics.info(
        DiagnosticCode.AGENTIFY_ROLE_UNCERTAIN,
        `agentify: ${source.path} classified as "${classification.role}" by a margin of only ` +
          `${classification.margin.toFixed(3)}. Runner-up: ` +
          `${classification.distribution[1]?.role ?? "(none)"}.`,
      );
    }

    const resolved: SourceDocument = { ...source, role: classification.role };
    const found = extractUnits(resolved, diagnostics);
    if (options.assist?.extraUnits) {
      found.push(...(await options.assist.extraUnits({ source: resolved, existing: found })));
    }
    units.push(...found);

    perSource.push({
      path: source.path,
      role: classification.role,
      decidedBy: classification.decidedBy,
      units: found.length,
      reused,
    });
    sourceRecords.push({ path: source.path, contentHash, role: classification.role });
  }

  // --- §10.4 Deduplicate, then detect conflicts.
  const deduped = await deduplicate(
    units,
    { threshold, ...(options.assist?.embed ? { embed: options.assist.embed } : {}) },
    diagnostics,
  );
  units = deduped.units;

  const conflicts = detectConflicts(units, diagnostics);
  if (options.conflicts === "failOnConflict" && conflicts.conflicts.length > 0) {
    diagnostics.error(
      DiagnosticCode.AGENTIFY_CONFLICT,
      `agentify: ${conflicts.conflicts.length} unresolved conflict(s) and ` +
        `agentify.conflicts is "failOnConflict".`,
    );
  }

  // --- §10.5 Budget and assemble, §10.6 Verify, per target.
  const results: TargetResult[] = [];
  const drops: UnsupportedSentence[] = [];
  const reportTargets: RunReport["targets"] = [];

  for (const targetId of options.targets) {
    const profile = options.registry.get(targetId);
    const plan = planBudget(
      units,
      profile,
      diagnostics,
      options.budgetOverride !== undefined ? { primaryTokens: options.budgetOverride } : {},
    );
    let files = assemble({ profile, plan, units });

    const required = options.traceabilityRequired ?? profile.traceability?.required ?? 1;
    let verification = verify(files, profile, units, required, diagnostics);

    // §10.6: unsupported content is dropped and logged, then the gate is applied to what
    // would actually be written. Both halves matter — dropping without the log would be a
    // silent pass, and the log without dropping would emit content the gate rejected.
    if (verification.unsupported.length > 0) {
      drops.push(...verification.unsupported);
      files = files.map((file) => {
        const per = verification.files.find((f) => f.path === file.path);
        return per ? dropUnsupported(file, per) : file;
      });
      verification = verify(files, profile, units, required, diagnostics);
    }

    results.push({ target: targetId, profile, files, plan, verification });
    reportTargets.push({
      id: targetId,
      tier: profile.tier ?? "stub",
      files: files.map((f) => ({
        path: f.path,
        tokens: f.tokens,
        sections: f.sections.map((s) => ({ heading: s.heading, units: s.units, tokens: s.tokens })),
      })),
      tokenCounter: counterDescription(profile),
      traceability: verification.traceability,
      dropped: plan.dropped.length,
      overflowed: plan.secondary.length,
    });
  }

  const manifest = buildManifest({
    files: results.flatMap((r) => r.files.map((file) => ({ file, target: r.target }))),
    units,
    sources: sourceRecords,
    conflicts: conflicts.conflicts,
  });

  const passed =
    results.every((r) => r.verification.passed) &&
    !(options.conflicts === "failOnConflict" && conflicts.conflicts.length > 0);

  return {
    units,
    results,
    conflicts,
    manifest,
    diagnostics: diagnostics.all(),
    drops,
    passed,
    report: {
      sources: perSource,
      merges: deduped.merges.length,
      conflicts: conflicts.conflicts.length,
      targets: reportTargets,
    },
  };
}
