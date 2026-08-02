"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Chip, LinkButton } from "@/components/ui/primitives";
import { engine } from "@/lib/engine";
import { DOCS } from "@/lib/links";
import { cn } from "@/lib/cn";

const SEED = `# Quarterly review

Throughput rose while p95 latency **regressed**.

| Region  | p50 | p95 |
| ------- | --- | --- |
| us-east | 12  | 48  |
| eu-west | 14  | 61  |

> The regression tracks the mid-period migration.
`;

type Target = "html" | "md" | "docx";

/**
 * The hero panel runs the real engine.
 *
 * Not a screenshot, not a video, not a div arranged to look like a product. The reason is
 * not that a live demo is impressive: it is that this product's claim is about what happens
 * to a document, and the only honest way to show that is to do it to one. The output below
 * is byte-identical to what `markforge convert` writes for the same input.
 *
 * The 963 KB engine is not on the critical path. The panel renders its seed text
 * immediately, then loads the engine when the browser is idle, and only then becomes
 * editable. Nothing about the first paint waits for it.
 */
export function Hero() {
  const [source, setSource] = useState(SEED);
  const [target, setTarget] = useState<Target>("html");
  const [output, setOutput] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState(0);
  const [lossy, setLossy] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [ready, setReady] = useState(false);
  const reduce = useReducedMotion();
  const started = useRef(false);

  // Idle, not mount. The hero must paint before anything downloads a megabyte.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const idle =
      window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 900));
    idle(() => void engine().then(() => setReady(true)));
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(() => {
      void (async () => {
        const mf = await engine();
        const r = await mf.convertInBrowser(new TextEncoder().encode(source), {
          from: "md",
          to: target,
          path: "review.md",
        });
        if (!live) return;
        setBytes(r.bytes.length);
        setDiagnostics(r.diagnostics.length);
        setLossy(r.diagnostics.filter((d) => d.lossy || d.severity === "error").length);
        setOutput(
          target === "docx" ? null : new TextDecoder().decode(r.bytes),
        );
      })();
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, target, ready]);

  return (
    <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 pb-16 pt-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:gap-14 lg:px-8 lg:pb-24 lg:pt-20">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <h1 className="text-4xl font-semibold leading-[1.06] tracking-tight text-ink md:text-5xl lg:text-6xl">
          Convert documents
          <br />
          without losing them.
        </h1>

        <p className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted md:text-base">
          Markdown, DOCX, HTML and PDF. Anything that cannot survive the target format says
          so, by name, with a code.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/forge"
            className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-panel bg-ember px-4 text-sm font-medium text-ember-ink transition-[filter,transform] duration-150 hover:brightness-[1.08] active:translate-y-px"
          >
            Open the forge
            <ArrowRight size={14} />
          </Link>
          <LinkButton href={DOCS.spec} target="_blank" rel="noreferrer noopener" variant="secondary">
            Read the spec
          </LinkButton>
        </div>
      </motion.div>

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden rounded-panel border border-rule bg-surface shadow-[0_18px_50px_-24px_rgb(var(--shadow-tint)/0.28)]"
      >
        <div className="rule-b flex h-9 items-center gap-2 px-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            review.md
          </span>
          <div className="ml-auto flex items-center gap-px rounded-chip bg-sunken p-0.5">
            {(["md", "html", "docx"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTarget(t)}
                className={cn(
                  "rounded-chip px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                  target === t ? "bg-ember text-ember-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-rule">
          <textarea
            value={source}
            readOnly={!ready}
            spellCheck={false}
            aria-label="Markdown source"
            onChange={(e) => setSource(e.target.value)}
            className="h-[280px] resize-none bg-transparent p-3 font-mono text-[11px] leading-relaxed text-ink outline-none"
          />
          <pre className="h-[280px] overflow-auto whitespace-pre-wrap break-words bg-sunken/60 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
            {output ??
              (target === "docx"
                ? `${bytes.toLocaleString("en-US")} bytes of Office Open XML`
                : ready
                  ? ""
                  : "")}
          </pre>
        </div>

        <div className="rule-t flex h-8 items-center gap-2 px-3">
          {ready ? (
            <>
              <Chip mono tone={lossy > 0 ? "accent" : "quiet"}>
                {diagnostics} diagnostic{diagnostics === 1 ? "" : "s"}
              </Chip>
              {lossy > 0 ? <Chip mono tone="accent">{lossy} lossy</Chip> : null}
              <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
                {bytes.toLocaleString("en-US")} B
              </span>
            </>
          ) : (
            <span className="font-mono text-[10px] text-ink-faint">
              loading the engine, then this becomes editable
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}
