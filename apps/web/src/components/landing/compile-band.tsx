import Link from "next/link";
import { ArrowRight, FileText } from "@phosphor-icons/react/dist/ssr";
import type { AgentifyExample } from "@/lib/data";
import { Reveal, Section } from "@/components/landing/reveal";

/**
 * The core feature, shown by its output.
 *
 * Every number and every line of Markdown below came out of `prepare-assets.mjs` running the
 * real compiler over `fixtures/agentify/clean/`, the same five documents the acceptance
 * criterion in docs/AGENTIFY.md is measured on. The build fails if that run stops reaching
 * 100% traceability, so this section cannot drift into advertising a number the compiler no
 * longer produces.
 */
export function CompileBand({ example }: { example: AgentifyExample }) {
  const skills = example.files.filter((f) => f.path.endsWith("SKILL.md"));

  return (
    <Section className="rule-t bg-surface py-16 lg:py-24">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <Reveal>
          <h2 className="display max-w-[16ch] text-3xl text-ink md:text-[2.75rem]">
            Five documents in. One AGENTS.md out.
          </h2>

          <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted">
            Point it at the specs, runbooks and decision records you already keep. It reads
            Markdown, HTML and Word, works out what each document is, pulls out the
            obligations and commands, and writes the files your agent reads.
          </p>

          <dl className="mt-8 grid grid-cols-3 gap-6 border-t border-rule pt-6">
            <div>
              <dt className="text-[12px] text-ink-muted">Documents</dt>
              <dd className="mt-1 font-mono text-2xl tabular-nums text-ink">
                {example.documents}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Sentences</dt>
              <dd className="mt-1 font-mono text-2xl tabular-nums text-ink">
                {example.tracedSentences}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Traced</dt>
              <dd className="mt-1 font-mono text-2xl tabular-nums text-accent">
                {(example.traceability * 100).toFixed(0)}%
              </dd>
            </div>
          </dl>

          <p className="mt-5 max-w-[46ch] text-[13px] leading-relaxed text-ink-muted">
            Traceability is a gate, not a statistic. A sentence the compiler cannot attribute
            to a source document is dropped before the file is written.
          </p>

          <Link
            href="/compile"
            className="mt-7 inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-panel bg-accent px-5 text-sm font-medium text-accent-ink transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px"
          >
            Compile a folder
            <ArrowRight size={14} />
          </Link>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="overflow-hidden rounded-panel border border-rule">
            <div className="rule-b flex h-9 items-center gap-2 bg-sunken/60 px-3">
              <FileText size={12} className="text-ink-faint" />
              <span className="font-mono text-[11px] text-ink">AGENTS.md</span>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">
                {example.files[0]?.tokens} tokens
              </span>
            </div>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-paper p-4 font-mono text-[11.5px] leading-[1.7] text-ink-muted">
              {example.excerpt}
            </pre>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-[12px] text-ink-muted">
              Same run also wrote {skills.length} skill files:
            </span>
            {skills.map((file) => (
              <span key={file.path} className="font-mono text-[11px] text-ink-faint">
                {file.path.split("/").slice(-2, -1)[0]}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
