import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { Reveal, Section } from "@/components/landing/reveal";
import { DOCS } from "@/lib/links";

/**
 * The closing moment, and the only centred composition on the page.
 *
 * Centred is right here for the reason it is wrong in a hero: there is one thing to do and
 * no asset competing with it. The label matches the nav and the hero exactly, because three
 * different words for the same destination is three destinations as far as a reader is
 * concerned.
 */
export function Closing() {
  return (
    <Section className="rule-t py-20 lg:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          Load one of your own documents and read the diagnostics.
        </h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-ink-muted">
          The corpus numbers describe the corpus. The only measurement that answers your
          question runs on your file, and it runs in this tab.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/forge"
            className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-panel bg-ember px-4 text-sm font-medium text-ember-ink transition-[filter,transform] duration-150 hover:brightness-[1.08] active:translate-y-px"
          >
            Open the forge
            <ArrowRight size={14} />
          </Link>
          <a
            href={DOCS.limits}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-10 items-center whitespace-nowrap rounded-panel border border-rule-strong px-4 text-sm font-medium text-ink transition-colors hover:bg-sunken active:translate-y-px"
          >
            Read the limits first
          </a>
        </div>
      </Reveal>
    </Section>
  );
}
