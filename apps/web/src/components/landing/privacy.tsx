import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";
import { Reveal, Section } from "@/components/landing/reveal";
import { ADR } from "@/lib/links";

const STAYS = [
  "Markdown, DOCX and HTML, read and written",
  "PDF output, through a compiler compiled to WebAssembly",
  "All six fidelity metrics, and the node census",
  "The intermediate representation, and every diagnostic",
];

const LEAVES = [
  "PDF, PPTX and XLSX input, and only after you press the button",
];

/**
 * The ledger, and the reason it is a ledger.
 *
 * "We respect your privacy" is what a page says when it has nothing checkable to offer.
 * Two columns and an exact list is what it says when the boundary is a property of the
 * build: the browser bundle contains no filesystem, no ambient config, and no `node:`
 * builtin, and a gate fails the build if one appears.
 */
export function Privacy() {
  return (
    <Section className="rule-t py-16 lg:py-24">
      <Reveal>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          What leaves this tab, and what does not.
        </h2>
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-16">
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              Stays in your browser
            </h3>
            <ul className="mt-4 space-y-2.5">
              {STAYS.map((s) => (
                <li key={s} className="flex gap-3 text-[13px] leading-relaxed text-ink">
                  <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-ink-faint" />
                  {s}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ember">
              Sent to a server
            </h3>
            <ul className="mt-4 space-y-2.5">
              {LEAVES.map((s) => (
                <li key={s} className="flex gap-3 text-[13px] leading-relaxed text-ink">
                  <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-ember" />
                  {s}
                </li>
              ))}
            </ul>
            <p className="mt-4 max-w-[42ch] text-[12.5px] leading-relaxed text-ink-muted">
              Those three need code that reaches for Node builtins, so they cannot run here.
              The route that reads them writes nothing, keeps nothing, and mints no
              identifier, because there is no second route that could return a document later.
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-12 max-w-prose border-l-2 border-rule-strong pl-5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            <span className="text-ink">No model is reachable from this website.</span> Not
            disabled by a setting: the browser build and the server route do not depend on the
            model layer at all, so there is no code path to switch on. A hosted converter that
            could quietly send someone&apos;s document to a model is the thing that decision
            exists to prevent.
          </p>
          <a
            href={ADR.llm}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-ember underline-offset-4 hover:underline"
          >
            The decision record
            <ArrowUpRight size={12} />
          </a>
        </div>
      </Reveal>
    </Section>
  );
}
