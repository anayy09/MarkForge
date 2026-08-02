"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/**
 * The page's one entry animation.
 *
 * What it communicates: sequence. Sections arrive in reading order, which is the order the
 * argument is built in. That is the whole justification, and it is why there is no hover
 * physics, no parallax, and no infinite loop anywhere else on the page. Under reduced motion
 * it renders the final state directly rather than a fast version of the animation.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** A section shell: consistent vertical rhythm, one max width, one gutter. */
export function Section({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={className}>
      <div className="mx-auto max-w-[1400px] px-5 lg:px-8">{children}</div>
    </section>
  );
}
