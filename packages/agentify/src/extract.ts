/**
 * Deterministic context-unit extraction — SPEC §10.3.
 *
 * §10.3 divides the work: "Deterministic extractors handle the mechanical categories …
 * The LLM handles the prose categories." That division is real but it is not a licence to
 * leave the prose categories empty offline, because `--no-llm` is the default (ADR-0009)
 * and §10.6's traceability gate has no bypass. A pipeline whose deterministic half produced
 * only commands and environment variables would emit an agent file with no constraints in
 * it and still pass every gate, which is the kind of green that means nothing.
 *
 * So the rules here go as far as structure honestly allows, and no further:
 *
 *   - **Mechanical, from shape alone.** Commands from shell fences, environment variables
 *     from `NAME=value`, glossary terms from `**Term** — definition`.
 *   - **Structural prose**, where a document's own markup states the category. An
 *     `## ADR-3: …` section is a decision because it is labelled one; a `## Rule 7:`
 *     section is a convention for the same reason.
 *   - **Normative prose**, one unit per sentence carrying a modal. This over-extracts, on
 *     purpose: a false unit is visible in the output and removable, whereas a missed
 *     constraint is invisible. Precision and recall against the authored answer keys are
 *     both reported in docs/AGENTIFY.md rather than one being quietly preferred.
 *
 * **What the rules deliberately cannot reach**, measured rather than hidden: `invariant`
 * and `entity`. An invariant ("a batch is committed whole or not at all") is a constraint
 * with no agent — the grammar that separates it from an ordinary `must` is exactly the
 * judgement §10.3 assigns to the model. The rules label those `constraint`, which is wrong
 * in category and right in content, and the answer-key comparison counts it as a miss.
 * Fitting a regular expression to the one invariant in the corpus would have turned a
 * measurement into a decoration.
 */
import {
  DiagnosticCode,
  textContent,
  visit,
  type DiagnosticBag,
  type Locator,
  type MarkForgeDocument,
  type Producer,
} from "@markforge/ir";
import { makeUnit, type ContextUnit, type DocumentRole, type UnitCategory, type UnitSource } from "./units.js";

const RULE_VERSION = "0.1.0";
const producer = (name: string): Producer => ({ kind: "rule", name: `agentify/${name}`, version: RULE_VERSION });

export interface SourceDocument {
  /** Repo-relative, forward-slashed. */
  path: string;
  document: MarkForgeDocument;
  /** Decoded source text, used only to locate nodes. Empty for binary formats. */
  sourceText: string;
  role: DocumentRole;
  /** 0..1 — see `authorityOf`. */
  authority: number;
}

/** Shell fence languages whose lines are commands. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shellsession", "terminal"]);

const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*?)\s*$/;
const ENV_IN_PROSE = /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g;
const DEFINITION_SHAPE = /^\s*(?:\*\*|__)?(.+?)(?:\*\*|__)?\s*[—–]\s+(.{3,})$/u;
const ADR_HEADING = /^ADR[-\s]?(\d+)\s*[::]\s*(.+)$/i;
const RULE_HEADING = /^Rule\s+(\d+)\s*[::]\s*(.+)$/i;
const RATIONALE_LEAD = /^\s*(?:\*\*|__)?\s*Rationale\s*(?:\*\*|__)?\s*[::]\s*/i;

/**
 * Deontic modals — the unambiguous marker of an obligation rather than a report.
 * `should` is deliberately absent: it states a preference, and a preference recorded in
 * an ADR is the decision, not a rule the system has to satisfy.
 */
const DEONTIC = /\b(?:must|shall|may not|cannot|is required to|are required to|is forbidden|are forbidden)\b/i;

/**
 * Absolute constructions: a statement that closes off the alternative is asserting a rule
 * even without a modal. "A submission is committed in one transaction **or not at all**"
 * is the corpus case, and it has no modal verb at all — which is why a modal-only
 * predicate was not enough.
 */
const ABSOLUTE = /\b(?:or not at all|never|always|under no circumstances|in all cases|without exception)\b/i;

/**
 * Does an ADR statement assert a rule, as opposed to recording a choice?
 *
 * OPEN_QUESTIONS §7q. Deliberately narrow, and its limits are worth stating because it is
 * the kind of predicate that invites over-fitting: it recognises obligation expressed
 * *grammatically*, and it will not recognise obligation expressed only semantically. On
 * the authored corpus it separates the three ADR statements the way a reader would —
 * ADR-2's "or not at all" is a rule, ADR-1's "we accept batches into a durable queue" and
 * ADR-3's "customers register a schema" are choices — but three statements is a sample, not
 * evidence, and it was written after reading them. The measured effect is in
 * `docs/AGENTIFY.md`; a holdout would be the way to learn whether it generalises, and one
 * does not exist.
 *
 * Getting this wrong is not silent. A false positive files a decision as a constraint,
 * which changes which section it lands in and makes it eligible for a merge the
 * adjudicator still has to approve; a false negative leaves today's behaviour unchanged.
 * Neither deletes anything, which is why this is the option §7q could take unilaterally
 * and loosening §10.4's category block was not.
 */
function assertsARule(text: string): boolean {
  return DEONTIC.test(text) || ABSOLUTE.test(text);
}

/** A prohibition aimed at the reader. */
const PROHIBITION = /^(do not|don't|never|avoid|do not ever)\b/i;
/** A sentence carrying an obligation or permission worth recording. */
const MODAL = /\b(must|shall|should|may not|cannot|can not|never|always|required to|are named|is not enforced)\b/i;

/**
 * Splits prose into sentences with the platform segmenter.
 *
 * `Intl.Segmenter` is builtin from Node 18, so this is ICU sentence breaking with no
 * dependency added — it gets `e.g.` and `Dr.` right, which a `/[.!?]/` split does not,
 * and a wrong split here would corrupt a unit rather than merely misalign a report.
 */
const SENTENCE_SEGMENTER = new Intl.Segmenter("en", { granularity: "sentence" });

export function splitSentences(text: string): string[] {
  return [...SENTENCE_SEGMENTER.segment(text)]
    .map((s) => s.segment.trim())
    .filter((s) => s.length > 0);
}

/**
 * Source authority, 0..1 — one input to conflict *ordering*, never to conflict suppression
 * (SPEC §10 requires both sides reported regardless).
 *
 * Derived from a `Last reviewed YYYY-MM-DD` line when the document states one, because
 * that is the only recency signal a committed fixture can carry honestly: a filesystem
 * mtime is a property of the checkout, not of the document, and would make the conflict
 * report depend on the order git happened to write files.
 */
export function authorityOf(sourceText: string, declaredRanking: string[], path: string): number {
  const ranked = declaredRanking.indexOf(path);
  if (ranked >= 0) return 1 - ranked / Math.max(declaredRanking.length, 1) / 2;
  const reviewed = /last reviewed\s+(\d{4})-(\d{2})-(\d{2})/i.exec(sourceText);
  if (reviewed) {
    // Maps 2020-01-01 → ~0.3 and 2030-01-01 → ~0.8, monotonic in recency and never
    // saturating, so two dated documents always order.
    const year = Number(reviewed[1]) + Number(reviewed[2]) / 12;
    return Math.min(0.85, Math.max(0.25, 0.3 + (year - 2020) * 0.05));
  }
  return 0.5;
}

interface ExtractContext {
  source: SourceDocument;
  diagnostics: DiagnosticBag;
  sourceId: string;
  order: () => number;
  /**
   * Sentences a structural pass has already turned into a unit.
   *
   * The passes overlap by construction — a conventions paragraph is also a sentence with a
   * verb in it — and without this the same sentence became two units in two categories,
   * which deduplication cannot merge because merging across categories would be a claim
   * about meaning that §10.4 does not make. Two units meant the sentence appeared twice in
   * the emitted file, in two different sections. The structural pass wins because it knows
   * the category from markup rather than from a modal verb.
   */
  claimed: Set<string>;
}

const claimKey = (sentence: string): string => sentence.toLowerCase().replace(/\s+/gu, " ").trim();

export function extractUnits(source: SourceDocument, diagnostics: DiagnosticBag): ContextUnit[] {
  const sourceId = Object.keys(source.document.sources ?? {})[0] ?? "s0";
  let counter = 0;
  const ctx: ExtractContext = {
    source,
    diagnostics,
    sourceId,
    order: () => counter++,
    claimed: new Set(),
  };

  const units: ContextUnit[] = [];
  const blocks = blocksInOrder(source.document);

  units.push(...extractStructuredSections(ctx, blocks));
  units.push(...extractCodeBlocks(ctx, blocks));
  units.push(...extractDefinitions(ctx, blocks));
  units.push(...extractRoleImpliedUnits(ctx, blocks));
  units.push(...extractNormativeProse(ctx, blocks));

  return units;
}

interface Block {
  node: Record<string, unknown>;
  type: string;
  text: string;
  index: number;
}

/**
 * Top-level blocks in document order, with list items flattened in place.
 *
 * `code` nodes read their own `value` rather than going through `textContent`, which walks
 * children and returns "" for a literal node. That cost the first run of this extractor
 * every command and every environment variable in the corpus — a code fence produced an
 * empty block, so the shell-fence and env-assignment rules had nothing to match and
 * reported nothing rather than failing. Found by running it, not by reading it.
 */
function blocksInOrder(doc: MarkForgeDocument): Block[] {
  const out: Block[] = [];
  let index = 0;
  visit(doc.body as never, (node) => {
    const type = (node as { type: string }).type;
    if (type === "heading" || type === "paragraph" || type === "code" || type === "listItem") {
      const literal = (node as { value?: unknown }).value;
      const text = type === "code" && typeof literal === "string" ? literal : textContent(node as never);
      out.push({ node: node as never, type, text: text.trim(), index: index++ });
    }
    return undefined;
  });
  return out;
}

function nodeIdOf(node: Record<string, unknown>): string {
  return typeof node["id"] === "string" ? node["id"] : "";
}

/**
 * A locator for the node, not for the unit.
 *
 * The distinction matters once units are rewritten: a merged or summarised unit's text is
 * not verbatim in any source, so searching for *it* would fail or, worse, match somewhere
 * else. A supporting node's text is always verbatim by construction.
 */
function locate(ctx: ExtractContext, node: Record<string, unknown>, nodeText: string): Locator {
  const text = ctx.source.sourceText;
  if (text === "") {
    // Binary source (DOCX, PPTX). The block index is the honest coordinate we have; the
    // xpath is the OOXML body-child position the reader walked, not a re-derivation.
    const blockIndex = typeof node["__blockIndex"] === "number" ? node["__blockIndex"] : 0;
    return { kind: "ooxml", part: "word/document.xml", xpath: `/w:document/w:body/*[${blockIndex + 1}]` };
  }
  const needle = nodeText.slice(0, 60);
  let at = needle.length > 0 ? text.indexOf(needle) : -1;
  if (at < 0 && needle.length > 20) at = text.indexOf(needle.slice(0, 20));
  if (at < 0) {
    // The node's text has had its inline markup removed by the adapter, so `**Rationale:**
    // the p95 budget…` in the file is `Rationale: the p95 budget…` here and a plain
    // indexOf misses. Searching a marker-stripped copy of the source, with an index map
    // back to real offsets, recovers the true position instead of reporting a fake one.
    const stripped: string[] = [];
    const backTo: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "*" || ch === "_" || ch === "`") continue;
      stripped.push(ch);
      backTo.push(i);
    }
    const found = stripped.join("").indexOf(needle);
    if (found >= 0) {
      const start = backTo[found] ?? 0;
      const endIndex = Math.min(found + nodeText.length, backTo.length - 1);
      return { kind: "text", startOffset: start, endOffset: (backTo[endIndex] ?? start) + 1 };
    }
  }
  if (at < 0) {
    ctx.diagnostics.info(
      DiagnosticCode.AGENTIFY_ROLE_UNCERTAIN,
      `agentify: could not locate "${needle.slice(0, 40)}" in ${ctx.source.path}; the unit's ` +
        `locator points at the start of the file. Its nodeIds are still exact, so provenance ` +
        `is complete — only the character offset is approximate.`,
    );
    return { kind: "text", startOffset: 0, endOffset: 0 };
  }
  return { kind: "text", startOffset: at, endOffset: at + nodeText.length };
}

function sourceFor(ctx: ExtractContext, node: Record<string, unknown>, nodeText: string): UnitSource {
  return {
    sourceId: ctx.sourceId,
    nodeIds: [nodeIdOf(node)].filter((id) => id !== ""),
    locator: locate(ctx, node, nodeText),
    order: ctx.order(),
    path: ctx.source.path,
  };
}

/**
 * `## ADR-n: Title` → a decision with its rationale; `## Rule n: Title` → a convention.
 *
 * These are the cases where the document's own markup declares the category, which is why
 * they are worth a structural pass rather than being left to the prose rules. The ADR case
 * is also where the rationale requirement of SPEC §10 is actually satisfiable offline:
 * the paragraph is labelled `**Rationale:**`, so there is nothing to infer.
 */
function extractStructuredSections(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== "heading") continue;

    const adr = ADR_HEADING.exec(block.text);
    const rule = RULE_HEADING.exec(block.text);
    if (!adr && !rule) continue;

    // The section body: blocks up to the next heading.
    const body: Block[] = [];
    for (let j = i + 1; j < blocks.length && blocks[j]!.type !== "heading"; j++) body.push(blocks[j]!);

    const statement = body.find((b) => b.type === "paragraph" && !RATIONALE_LEAD.test(b.text));
    if (!statement) continue;

    if (adr) {
      const rationaleBlock = body.find((b) => RATIONALE_LEAD.test(b.text));
      const rationale = rationaleBlock ? rationaleBlock.text.replace(RATIONALE_LEAD, "").trim() : "";
      if (rationale === "") {
        // SPEC §10 makes the rationale part of what a decision is. Without one this is
        // not a decision unit, and inventing a rationale is the one thing a deterministic
        // extractor must never do — so it degrades to a constraint and says so.
        ctx.diagnostics.degraded(
          DiagnosticCode.AGENTIFY_UNIT_DROPPED,
          "decision",
          `agentify: "${block.text}" in ${ctx.source.path} is shaped like a decision record but ` +
            `states no rationale, and SPEC §10 requires one. Recorded as a constraint instead, ` +
            `so the statement survives without claiming to be a decision.`,
        );
        ctx.claimed.add(claimKey(firstSentence(statement.text)));
        units.push(
          makeUnit({
            category: "constraint",
            text: firstSentence(statement.text),
            source: sourceFor(ctx, statement.node, statement.text),
            documentRole: ctx.source.role,
            authority: ctx.source.authority,
            confidence: 0.6,
            producedBy: producer("adr-section"),
          }),
        );
        continue;
      }
      /*
       * OPEN_QUESTIONS §7q, ruled on 2026-08-01: an ADR statement that **asserts a rule**
       * is filed as a `constraint`, carrying its rationale, rather than as a `decision`.
       *
       * The contradiction being resolved: `CORPUS.md` §2.14 declares a product-spec
       * constraint and ADR-2's statement to be the same fact, while `SPEC.md` §10.4 blocks
       * cross-category merges — so the pair could never be compared and dedup measured
       * 0 of 2 authored pairs merged. Of the three ways out, this is the one that leaves
       * §10.4's block intact: loosening the block is what risks silently deleting a real
       * fact, and it was not taken unilaterally.
       *
       * `decision` stays reachable. An ADR that records a *choice* ("we accept batches into
       * a durable queue") is still a decision; one that states a *rule* the system or its
       * users must satisfy is a constraint that happens to have been written down in an
       * ADR. The rationale rides along either way, so nothing is lost in the reclassification.
       */
      const normative = assertsARule(firstSentence(statement.text));
      ctx.claimed.add(claimKey(firstSentence(statement.text)));
      units.push(
        makeUnit({
          category: normative ? "constraint" : "decision",
          text: firstSentence(statement.text),
          rationale,
          source: sourceFor(ctx, statement.node, statement.text),
          documentRole: ctx.source.role,
          authority: ctx.source.authority,
          // High: the document labelled this a decision and supplied the rationale. Nothing
          // was inferred, so the confidence reflects reading rather than guessing.
          confidence: 0.95,
          producedBy: producer(normative ? "adr-section-rule" : "adr-section"),
        }),
      );
    } else {
      ctx.claimed.add(claimKey(firstSentence(statement.text)));
      units.push(
        makeUnit({
          category: "convention",
          text: firstSentence(statement.text),
          source: sourceFor(ctx, statement.node, statement.text),
          documentRole: ctx.source.role,
          authority: ctx.source.authority,
          confidence: 0.9,
          producedBy: producer("rule-section"),
        }),
      );
    }
  }
  return units;
}

/** Commands from shell fences; environment variables from `NAME=value` in any fence. */
function extractCodeBlocks(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  for (const block of blocks) {
    if (block.type !== "code") continue;
    const heading = nearestHeading(blocks, block);
    const lang = String(block.node["lang"] ?? "").toLowerCase();
    const lines = block.text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

    for (const line of lines) {
      const env = ENV_LINE.exec(line);
      if (env) {
        const [, name, value] = env;
        units.push(
          makeUnit({
            category: "environmentVariable",
            text: `${name}=${value}`,
            source: sourceFor(ctx, block.node, block.text),
            documentRole: ctx.source.role,
            authority: ctx.source.authority,
            confidence: 0.95,
            producedBy: producer("env-assignment"),
            entityKey: name!,
            entityValue: value!,
          }),
        );
        continue;
      }
      // Only shell-tagged fences yield commands. An untagged fence of `NAME=value` lines is
      // an environment block, and treating its lines as commands would put `export`-less
      // assignments in a Commands section as though someone should run them.
      if (SHELL_LANGS.has(lang)) {
        units.push(
          makeUnit({
            category: "command",
            text: line.replace(/^\$\s+/, ""),
            source: sourceFor(ctx, block.node, block.text),
            documentRole: ctx.source.role,
            authority: ctx.source.authority,
            confidence: 0.95,
            producedBy: producer("shell-fence"),
            ...(commandTask(line, heading) !== undefined
              ? { entityKey: commandTask(line, heading)!, entityValue: line.replace(/^\$\s+/, "") }
              : {}),
          }),
        );
      }
    }
  }
  return units;
}

/**
 * The task a command performs, used as the conflict key.
 *
 * `pnpm build` and `npm run compile` are the corpus's authored command conflict, and they
 * share no token — so the key cannot come from the command string. It comes from the
 * nearest heading, supplied by the caller, with this function handling the common case
 * where the verb is in the command itself.
 */
function commandTask(line: string, heading: string | undefined): string | undefined {
  // The heading is consulted first, because it is the only thing the two sides of the
  // corpus's authored command conflict have in common. `pnpm build` and `npm run compile`
  // both sit under a `## Build` heading; keyed off their own text they would be "build" and
  // "compile", never compared, and the conflict would go unreported while every test passed.
  const fromHeading = heading
    ? /\b(build|test|lint|deploy|install|start|compile|migrate|drain|restart|release|publish)\b/i.exec(heading)
    : null;
  if (fromHeading) return fromHeading[1]!.toLowerCase();
  const known = /\b(build|test|lint|deploy|install|start|compile|migrate|drain|restart)\b/i.exec(line);
  return known ? known[1]!.toLowerCase() : undefined;
}

/** Text of the nearest heading at or above a block, in document order. */
function nearestHeading(blocks: Block[], block: Block): string | undefined {
  for (let i = blocks.indexOf(block) - 1; i >= 0; i--) {
    const candidate = blocks[i]!;
    if (candidate.type === "heading") return candidate.text;
  }
  return undefined;
}

/** `**Term** — definition` paragraphs become glossary terms. */
function extractDefinitions(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    // Em dash only. A hyphen or a colon matches far too much ordinary prose, and a
    // glossary that swallowed every colon-bearing sentence would be worse than none.
    if (!/[—–]/u.test(block.text)) continue;
    const match = DEFINITION_SHAPE.exec(block.text);
    if (!match) continue;
    const [, term, definition] = match;
    if (!term || !definition) continue;
    if (term.length > 60 || term.split(/\s+/).length > 6) continue;
    for (const sentence of splitSentences(block.text)) ctx.claimed.add(claimKey(sentence));
    units.push(
      makeUnit({
        category: "glossaryTerm",
        text: `${term.trim()} — ${definition.trim()}`,
        source: sourceFor(ctx, block.node, block.text),
        documentRole: ctx.source.role,
        authority: ctx.source.authority,
        confidence: 0.9,
        producedBy: producer("definition-paragraph"),
        entityKey: term.trim().toLowerCase(),
      }),
    );
  }
  return units;
}

/**
 * Units the document's *role* implies, where the prose carries no modal to detect.
 *
 * A conventions document is a list of conventions. That sounds circular and is not: the
 * role came from §10.2's classifier reading headings and structure, so using it here is
 * using evidence the pipeline already established, the same way the ADR rule uses a heading.
 * Without it the corpus loses half its conventions — "Every bug fix ships with the test that
 * would have caught it" is a rule stated as a plain declarative, and no modal appears in it.
 *
 * Scoped tightly on purpose. It fires only for the two roles whose entire content is one
 * category, and only for short standalone statements, because the failure mode of a rule
 * like this is swallowing a document's prose introduction as though it were policy.
 */
function extractRoleImpliedUnits(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const role = ctx.source.role;
  if (role !== "codingConventions" && role !== "testPolicy") return [];

  const units: ContextUnit[] = [];
  for (const block of blocks) {
    if (block.type !== "listItem" && block.type !== "paragraph") continue;
    const first = splitSentences(block.text)[0];
    if (!first) continue;
    // The first sentence only. A conventions document states the rule and then explains it
    // — "Modules are named after what they do…" followed by an example of a bad name — and
    // the rule is the first sentence. Taking the paragraph whole would put the explanation
    // into the agent file, where it costs budget for something the reader already accepted.
    //
    // An earlier version skipped multi-sentence paragraphs entirely, to avoid swallowing
    // exposition. On this corpus that rejected every convention in conventions.docx, because
    // rule-then-explanation is the shape a conventions document actually has. The length
    // bounds below are what keeps prose out, not the sentence count.
    const words = first.split(/\s+/).length;
    if (words < 4 || words > 40) continue;
    if (PROHIBITION.test(first)) continue; // the prose pass records this as an antiPattern
    // The `## Rule N:` pass has already claimed the rules it recognised structurally.
    // Without this check the oversized handbook produced 61 conventions for its 30 rules:
    // every rule once from its heading and once from the same paragraph's first sentence.
    if (ctx.claimed.has(claimKey(first))) continue;
    ctx.claimed.add(claimKey(first));
    units.push(
      makeUnit({
        category: "convention",
        text: first,
        source: sourceFor(ctx, block.node, block.text),
        documentRole: role,
        authority: ctx.source.authority,
        confidence: 0.7,
        producedBy: producer("role-implied-convention"),
      }),
    );
  }
  return units;
}

/**
 * One unit per normative sentence.
 *
 * Runs over every paragraph and list item, including the rationale paragraph of an ADR
 * section. That overlap is deliberate: the corpus's first near-duplicate pair is a product
 * requirement against a latency figure stated inside an architecture rationale, and if
 * rationale prose produced no unit there would be nothing for §10.4 to merge it with —
 * the pair would prove nothing about embeddings because one side would not exist.
 */
function extractNormativeProse(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.type !== "paragraph" && block.type !== "listItem") continue;
    const text = RATIONALE_LEAD.test(block.text) ? block.text.replace(RATIONALE_LEAD, "") : block.text;

    for (const sentence of splitSentences(text)) {
      if (sentence.split(/\s+/).length < 4) continue;
      const prohibition = PROHIBITION.test(sentence);
      if (!prohibition && !MODAL.test(sentence)) continue;
      // A sentence can appear in both a list item and its parent paragraph's text content
      // depending on how the adapter nested them; the same sentence must not become two units.
      const key = claimKey(sentence);
      if (seen.has(key) || ctx.claimed.has(key)) continue;
      seen.add(key);

      units.push(
        makeUnit({
          category: prohibition ? "antiPattern" : "constraint",
          text: sentence,
          source: sourceFor(ctx, block.node, block.text),
          documentRole: ctx.source.role,
          authority: ctx.source.authority,
          // Lower than the structural extractors on purpose. "This sentence has a modal, so
          // it is a constraint" is a guess; "this heading says ADR-3" is a reading. The
          // budget ranks on this, so the difference has to be numeric.
          confidence: prohibition ? 0.8 : 0.65,
          producedBy: producer("normative-sentence"),
        }),
      );
    }
  }
  return units;
}

function firstSentence(text: string): string {
  return splitSentences(text)[0] ?? text;
}

/** Environment variables named in prose as `process.env.NAME`, with no value to bind. */
export function extractEnvReferences(ctx: ExtractContext, blocks: Block[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  for (const block of blocks) {
    if (block.type === "code") continue;
    for (const match of block.text.matchAll(ENV_IN_PROSE)) {
      units.push(
        makeUnit({
          category: "environmentVariable",
          text: match[1]!,
          source: sourceFor(ctx, block.node, block.text),
          documentRole: ctx.source.role,
          authority: ctx.source.authority,
          confidence: 0.7,
          producedBy: producer("env-reference"),
          entityKey: match[1]!,
        }),
      );
    }
  }
  return units;
}

export { blocksInOrder, type Block };
