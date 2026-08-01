/**
 * Document role classification — SPEC §10.2.
 *
 * Rule-based priors produce a scored distribution; an LLM classifier may adjust it but
 * never replace it — never LLM-only. The final role is the prior's winner
 * unless the model's choice beats it by a configured margin, and the disagreement is
 * logged either way.
 *
 * **Content outranks the filename, and the corpus insists on it.** `architecture.md` in
 * `fixtures/agentify/clean/` has an authored answer of `decisionRecord`, not
 * `architecture` — it is a file full of `## ADR-n:` sections with `**Rationale:**`
 * paragraphs, and the filename is a decoy. Symmetrically, `service-overview.md` answers
 * `architecture` with no such word in its name. A classifier that read filenames first
 * would get both wrong, so filename evidence is worth about a third of what a structural
 * signal is worth, and the weights below say so numerically rather than in a comment.
 */
import { selectType, textContent, type MarkForgeDocument } from "@markforge/ir";
import { DOCUMENT_ROLES, type DocumentRole } from "./units.js";

export interface RoleScore {
  role: DocumentRole;
  score: number;
  /** Which signals fired, so `--explain` can show why rather than only what. */
  reasons: string[];
}

export interface Classification {
  role: DocumentRole;
  distribution: RoleScore[];
  /** Gap between the winner and the runner-up, normalised. Drives the LLM margin. */
  margin: number;
  decidedBy: "rule" | "model";
  modelChoice?: DocumentRole;
  modelRationale?: string;
}

interface Signal {
  role: Exclude<DocumentRole, "unknown">;
  weight: number;
  label: string;
  /** Tested against the lowercased filename. */
  filename?: RegExp;
  /** Tested against each heading's text, lowercased. Scores once per matching heading. */
  heading?: RegExp;
  /** Tested against the whole lowercased body. Scores once per match, capped. */
  body?: RegExp;
  /** Structural predicate over the parsed document. */
  structure?: (doc: DocumentFeatures) => number;
}

interface DocumentFeatures {
  headings: string[];
  bodyText: string;
  codeFenceCount: number;
  /** Paragraphs shaped `**Term** — definition`, the glossary tell. */
  definitionCount: number;
  tableCount: number;
  listItemCount: number;
}

// Weights: structure 3, heading 2, body keyword 1, filename 1. A filename can break a tie
// between two roles the content does not separate, and cannot outvote the content itself.
const SIGNALS: Signal[] = [
  // --- decisionRecord: the strongest structural tell in the corpus.
  { role: "decisionRecord", weight: 3, label: "ADR-numbered headings", heading: /^adr[-\s]?\d+/ },
  { role: "decisionRecord", weight: 3, label: "rationale paragraphs", body: /\brationale\b\s*[::]/ },
  { role: "decisionRecord", weight: 2, label: "decision vocabulary in a heading", heading: /\bdecisions?\b/ },
  { role: "decisionRecord", weight: 1, label: "filename names decisions", filename: /\b(adr|decision)/ },
  { role: "decisionRecord", weight: 1, label: "supersession language", body: /\b(supersedes|superseded by|deprecates)\b/ },

  // --- architecture
  { role: "architecture", weight: 2, label: "architecture vocabulary in a heading", heading: /\b(architecture|system design|components?|data flow|topology)\b/ },
  { role: "architecture", weight: 2, label: "overview heading", heading: /\b(overview|service overview)\b/ },
  { role: "architecture", weight: 1, label: "filename names architecture", filename: /\b(architect|design|overview)/ },
  { role: "architecture", weight: 1, label: "component vocabulary", body: /\b(queue|boundary|upstream|downstream|service|worker)\b/ },

  // --- productSpec
  { role: "productSpec", weight: 2, label: "requirements heading", heading: /\b(requirements?|scope|out of scope|goals?|non-goals?)\b/ },
  { role: "productSpec", weight: 2, label: "purpose heading", heading: /\b(purpose|problem|background|motivation)\b/ },
  { role: "productSpec", weight: 1, label: "filename names a spec", filename: /\b(spec|prd|product|requirement)/ },
  { role: "productSpec", weight: 1, label: "normative user language", body: /\b(must|shall)\b[^.]{0,60}\b(user|customer|operator)\b/ },

  // --- apiContract
  { role: "apiContract", weight: 3, label: "HTTP method and path table", structure: (d) => (d.tableCount > 0 && /\b(get|post|put|patch|delete)\b/.test(d.bodyText) && /\/v?\d?\//.test(d.bodyText) ? 1 : 0) },
  { role: "apiContract", weight: 2, label: "endpoint heading", heading: /\b(endpoints?|api|routes?|authentication|errors?)\b/ },
  { role: "apiContract", weight: 1, label: "filename names an API", filename: /\b(api|contract|openapi|swagger)/ },
  { role: "apiContract", weight: 1, label: "status codes", body: /\b(200|201|400|401|403|404|409|422|500)\b/ },

  // --- runbook
  { role: "runbook", weight: 3, label: "shell command fences", structure: (d) => (d.codeFenceCount >= 2 ? 1 : 0) },
  { role: "runbook", weight: 2, label: "operational heading", heading: /\b(deploy|rollback|runbook|on-?call|incident|check health|drain|restart|maintenance|build)\b/ },
  { role: "runbook", weight: 2, label: "failure-mode heading", heading: /^if\b|\bstalls?\b|\bfails?\b|\btroubleshoot/ },
  { role: "runbook", weight: 1, label: "filename names a runbook", filename: /\b(runbook|ops|operations|deploy|playbook)/ },

  // --- codingConventions
  { role: "codingConventions", weight: 3, label: "numbered rule headings", structure: (d) => (d.headings.filter((h) => /^rule\s+\d+/.test(h)).length >= 3 ? 1 : 0) },
  { role: "codingConventions", weight: 2, label: "conventions heading", heading: /\b(conventions?|style|standards?|guidelines?|handbook|rules?)\b/ },
  { role: "codingConventions", weight: 1, label: "filename names conventions", filename: /\b(convention|style|handbook|guideline|standard)/ },
  { role: "codingConventions", weight: 1, label: "code-review vocabulary", body: /\b(pull request|code review|lint|formatter|naming)\b/ },

  // --- domainGlossary
  { role: "domainGlossary", weight: 3, label: "term-definition paragraphs", structure: (d) => (d.definitionCount >= 3 ? 1 : 0) },
  { role: "domainGlossary", weight: 2, label: "glossary heading", heading: /\b(glossary|terminology|definitions?|vocabulary)\b/ },
  { role: "domainGlossary", weight: 1, label: "filename names a glossary", filename: /\b(glossary|terms|terminology)/ },

  // --- testPolicy
  { role: "testPolicy", weight: 2, label: "testing heading", heading: /\b(test|testing|coverage|qa|quality)\b/ },
  { role: "testPolicy", weight: 1, label: "filename names testing", filename: /\b(test|qa|quality)/ },
  { role: "testPolicy", weight: 1, label: "coverage vocabulary", body: /\b(unit test|integration test|coverage threshold|flaky)\b/ },

  // --- meetingNotes
  { role: "meetingNotes", weight: 2, label: "meeting heading", heading: /\b(agenda|attendees|action items?|minutes|notes from)\b/ },
  { role: "meetingNotes", weight: 1, label: "filename names a meeting", filename: /\b(meeting|notes|minutes|standup|retro)/ },
  { role: "meetingNotes", weight: 1, label: "attendance vocabulary", body: /\b(attendees|apologies|action item|follow-?up owner)\b/ },
];

/** Paragraph shaped `**Term** — definition` or `**Term**: definition`. */
const DEFINITION_SHAPE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?:[—–-]|:)\s+(.{3,})$/u;

export function documentFeatures(doc: MarkForgeDocument): DocumentFeatures {
  const headings = selectType(doc.body as never, "heading").map((h) =>
    textContent(h as never).trim().toLowerCase(),
  );
  const paragraphs = selectType(doc.body as never, "paragraph").map((p) =>
    textContent(p as never).trim(),
  );
  const code = selectType(doc.body as never, "code");
  const tables = selectType(doc.body as never, "table");
  const listItems = selectType(doc.body as never, "listItem");
  return {
    headings,
    bodyText: textContent(doc.body as never).toLowerCase(),
    codeFenceCount: code.length,
    // Counted from raw source shape *and* from emphasis-led paragraphs, because a DOCX
    // glossary carries the term as a bold run rather than as asterisks.
    definitionCount: paragraphs.filter((p) => DEFINITION_SHAPE.test(p) || /^[A-Z][\w\s-]{1,40}\s+[—–]\s+\S/u.test(p)).length,
    tableCount: tables.length,
    listItemCount: listItems.length,
  };
}

/**
 * The rule-based prior of SPEC §10.2.
 *
 * Scores are normalised to sum to 1 so the margin is comparable across documents of very
 * different lengths — a long runbook should not outscore a short one into a different
 * confidence class merely by having more words.
 */
export function classifyByRules(doc: MarkForgeDocument, path: string): Classification {
  const features = documentFeatures(doc);
  const filename = (path.split(/[\\/]/).pop() ?? path).toLowerCase();

  const raw = new Map<DocumentRole, { score: number; reasons: string[] }>();
  for (const role of DOCUMENT_ROLES) raw.set(role, { score: 0, reasons: [] });

  for (const signal of SIGNALS) {
    let hits = 0;
    if (signal.filename && signal.filename.test(filename)) hits += 1;
    if (signal.heading) {
      // Capped at three: a handbook with thirty "Rule N" headings should not score ten
      // times a runbook with three operational ones. Presence is the evidence; volume
      // past a few repetitions says more about document length than about role.
      hits += Math.min(3, features.headings.filter((h) => signal.heading!.test(h)).length);
    }
    if (signal.body && signal.body.test(features.bodyText)) hits += 1;
    if (signal.structure) hits += signal.structure(features);
    if (hits === 0) continue;
    const entry = raw.get(signal.role)!;
    entry.score += signal.weight * hits;
    entry.reasons.push(`${signal.label} (+${signal.weight * hits})`);
  }

  const total = [...raw.values()].reduce((sum, e) => sum + e.score, 0);
  const distribution: RoleScore[] = DOCUMENT_ROLES.map((role) => {
    const entry = raw.get(role)!;
    return {
      role,
      score: total > 0 ? entry.score / total : role === "unknown" ? 1 : 0,
      reasons: entry.reasons,
    };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  const winner = distribution[0];
  const runnerUp = distribution[1];
  const margin = winner ? winner.score - (runnerUp?.score ?? 0) : 0;

  // A tie is `unknown`, not the alphabetically-first candidate.
  //
  // The sort falls back to `localeCompare` to stay deterministic, which is right — but
  // taking its output as *the answer* meant a document the rules had no opinion about was
  // assigned a role by alphabetical accident and reported as decided. The holdout set found
  // three of these in five documents: `weekly.md` split 0.500/0.500 between architecture and
  // meetingNotes and answered "architecture" because the letter a precedes the letter m.
  //
  // `unknown` is one of §10.2's ten roles and was previously unreachable except on a
  // document with no signal at all. This does not improve the holdout score — the three tied
  // documents were wrong before and are wrong now — which is the evidence that it is a
  // correctness fix rather than tuning against the answers.
  const tied = winner !== undefined && margin < TIE_EPSILON;
  return {
    role: winner && winner.score > 0 && !tied ? winner.role : "unknown",
    distribution,
    margin,
    decidedBy: "rule",
  };
}

/**
 * Below this margin the rules have not decided anything.
 *
 * Small deliberately: it separates an exact tie and near-ties from a genuine narrow win. The
 * three corpus sets score margins of 0.556 to 1.000, so nothing that the rules actually
 * decide falls near it.
 */
const TIE_EPSILON = 0.02;

/**
 * Applies an optional model opinion to a rule-based prior.
 *
 * The model wins only by exceeding the prior's winner by `margin` in the prior's own
 * distribution — that is, only when the prior itself was close. A model choice that the
 * prior scored at zero cannot win at all: SPEC §10.2 says the classifier "may adjust,
 * never replace", and a role the rules found no evidence for is a replacement.
 */
export function applyModelOpinion(
  prior: Classification,
  opinion: { role: DocumentRole; rationale: string } | undefined,
  margin: number,
): Classification {
  if (!opinion || opinion.role === prior.role) {
    return opinion ? { ...prior, modelChoice: opinion.role, modelRationale: opinion.rationale } : prior;
  }
  const priorScoreOfModelChoice =
    prior.distribution.find((d) => d.role === opinion.role)?.score ?? 0;
  const priorWinnerScore = prior.distribution[0]?.score ?? 0;
  const accept = priorScoreOfModelChoice > 0 && priorWinnerScore - priorScoreOfModelChoice < margin;
  return {
    ...prior,
    role: accept ? opinion.role : prior.role,
    decidedBy: accept ? "model" : "rule",
    modelChoice: opinion.role,
    modelRationale: opinion.rationale,
  };
}
