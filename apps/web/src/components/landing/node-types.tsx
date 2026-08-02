"use client";

import { useReducedMotion } from "motion/react";
import { DOCS } from "@/lib/links";
import { Reveal, Section } from "@/components/landing/reveal";

/**
 * The page's one marquee, and the one thing it is right for.
 *
 * Fifty-three names is more than a list wants to be and less than a table deserves. None of
 * them needs individual attention; what matters is the breadth, which is exactly the case a
 * marquee serves. It pauses on hover and holds still entirely under reduced motion, where it
 * becomes a plain wrapped list.
 */
export function NodeTypes({ types }: { types: string[] }) {
  const reduce = useReducedMotion();

  return (
    <Section className="rule-t py-16 lg:py-24">
      <Reveal>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          Both formats are views of one tree.
        </h2>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-muted">
          {types.length} node types, extended from mdast so an existing tool still recognises
          most of it. Style evidence and provenance live in side tables keyed by node id
          rather than on the nodes, because a plugin that rebuilt the tree would drop fields
          it did not know about, and silently.
        </p>
      </Reveal>

      <div className="mt-12">
        {reduce ? (
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {types.map((t) => (
              <li key={t} className="font-mono text-[12px] text-ink-muted">
                {t}
              </li>
            ))}
          </ul>
        ) : (
          <div
            className="group relative overflow-hidden"
            style={{
              maskImage:
                "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
              WebkitMaskImage:
                "linear-gradient(to right, transparent, black 6%, black 94%, transparent)",
            }}
          >
            <div className="flex w-max animate-[marquee_72s_linear_infinite] gap-5 group-hover:[animation-play-state:paused]">
              {/* Twice, so the seam lands off screen. aria-hidden on the copy. */}
              {[0, 1].map((copy) => (
                <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 gap-5">
                  {types.map((t) => (
                    <li key={t} className="whitespace-nowrap font-mono text-[13px] text-ink-muted">
                      {t}
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        )}
      </div>

      <Reveal delay={0.08}>
        <a
          href={DOCS.irSchema}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-8 inline-block text-[13px] text-ember underline-offset-4 hover:underline"
        >
          The schema is the contract, and the types are generated from it
        </a>
      </Reveal>
    </Section>
  );
}
