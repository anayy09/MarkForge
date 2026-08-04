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
        <h2 className="display text-3xl text-ink md:text-[2.75rem]">
          Run it on your own documents.
        </h2>
        <p className="mx-auto mt-5 max-w-[52ch] text-[15px] leading-relaxed text-ink-muted">
          The corpus numbers describe the corpus. The only measurement that answers your
          question runs on your files, and it runs in this tab.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/compile"
            className="inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-panel bg-accent px-5 text-sm font-medium text-accent-ink transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px"
          >
            Compile a folder
            <ArrowRight size={14} />
          </Link>
          <a
            href={DOCS.limits}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 items-center whitespace-nowrap rounded-panel border border-rule-strong px-5 text-sm font-medium text-ink transition-colors hover:bg-sunken active:translate-y-px"
          >
            Read the limits first
          </a>
        </div>
      </Reveal>
    </Section>
  );
}
