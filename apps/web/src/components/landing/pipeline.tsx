"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Reveal, Section } from "@/components/landing/reveal";

const STAGES = [
  { name: "adapter", text: "Reads the bytes and records what the document says. A DOCX states a font size; that is evidence, and evidence is what gets stored." },
  { name: "normalize", text: "Applies whitespace and structure rules once, at the tree, so no renderer has to guess what an empty paragraph meant." },
  { name: "infer", text: "Turns evidence into structure. This is the only place bold 16pt text becomes a heading, and every decision it makes is logged." },
  { name: "render", text: "Writes the target format, and emits a diagnostic for every construct that cannot survive it." },
];

/**
 * Four deterministic stages, plus the one that is none of them.
 *
 * The line draws itself as the section scrolls, which is the only scroll-driven animation on
 * the site. It earns that because the thing being shown is an order: these stages happen in
 * sequence, the boundary between `infer` and everything else is the argument, and drawing it
 * left to right is the shortest way to say so.
 */
export function Pipeline() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "center 0.55"],
  });
  const drawn = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <Section className="rule-t py-16 lg:py-24">
      <Reveal>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          One pipeline, and only one step in it is allowed to be clever.
        </h2>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-muted">
          Adapters record, renderers consume, and inference sits between them in the open
          where it can be logged and switched off. Every stage is deterministic: same input,
          same bytes, no wall clock, no random source.
        </p>
      </Reveal>

      <div ref={ref} className="mt-14">
        <div className="relative">
          {/* The rule the stages sit on, drawn rather than merely present. */}
          <svg
            className="absolute left-0 right-0 top-[7px] hidden h-px w-full md:block"
            preserveAspectRatio="none"
            viewBox="0 0 100 1"
            aria-hidden
          >
            <line x1="0" y1="0.5" x2="100" y2="0.5" stroke="var(--rule)" strokeWidth="1" />
            <motion.line
              x1="0"
              y1="0.5"
              x2="100"
              y2="0.5"
              stroke="var(--ember)"
              strokeWidth="1"
              style={reduce ? { pathLength: 1 } : { pathLength: drawn }}
            />
          </svg>

          <ol className="grid gap-9 md:grid-cols-4 md:gap-6">
            {STAGES.map((stage, i) => (
              <li key={stage.name} className="relative">
                <div className="mb-4 hidden md:block">
                  <motion.span
                    className="block h-[15px] w-[15px] rounded-full border-2 border-paper bg-ember"
                    initial={reduce ? false : { scale: 0 }}
                    whileInView={{ scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.35, delay: 0.12 + i * 0.12, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
                <h3 className="font-mono text-[13px] text-ink">{stage.name}</h3>
                <p className="mt-2 max-w-[38ch] text-[12.5px] leading-relaxed text-ink-muted">
                  {stage.text}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <Reveal delay={0.1}>
          <div className="mt-12 max-w-prose border-l-2 border-rule-strong pl-5">
            <h3 className="font-mono text-[13px] text-ink-muted">enrich</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
              The fifth stage, off by default and never on the critical path. When it is
              switched on, a model may do exactly two things: break a tie between heading
              levels the deterministic scorer already called too close, choosing from that
              scorer&apos;s own candidates and never inventing one, and transcribe a scanned
              page with no text layer, where the deterministic alternative is nothing at all.
              Only the command line can reach it. This website cannot, by construction.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
