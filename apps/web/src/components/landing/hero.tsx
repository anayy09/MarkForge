"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderOpen } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { engine } from "@/lib/engine";
import { cn } from "@/lib/cn";

/**
 * A source with something at stake in every line.
 *
 * A bolded obligation, a table, a block quote carrying an invariant. Each is a construct
 * that survives some targets and not others, so the panel beside it is showing a real
 * decision rather than echoing plain paragraphs back.
 */
const SEED = `# Ingestion runbook

Batches **must** be acknowledged before processing.

| Stage   | Owner    | p95  |
| ------- | -------- | ---- |
| receive | platform | 48ms |
| commit  | platform | 61ms |

> A batch is committed whole or not at all.
`;

type Target = "html" | "md" | "docx";

/**
 * The hero, and the one panel on the site that runs the engine unprompted.
 *
 * The panel is not decoration and it is not a screenshot. This product's claim is about what
 * happens to a document, and the only honest way to show that is to do it to one: the output
 * is byte-identical to what `markforge convert` writes for the same input, and the
 * diagnostic count under it is whatever the engine actually reported.
 *
 * The megabyte of engine is off the critical path. The panel paints its seed text
 * immediately, loads the engine when the browser goes idle, and only then becomes editable.
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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 900));
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
          path: "runbook.md",
        });
        if (!live) return;
        setBytes(r.bytes.length);
        setDiagnostics(r.diagnostics.length);
        setLossy(r.diagnostics.filter((d) => d.lossy || d.severity === "error").length);
        setOutput(target === "docx" ? null : new TextDecoder().decode(r.bytes));
      })();
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, target, ready]);

  return (
    <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 pb-16 pt-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 lg:px-8 lg:pb-24 lg:pt-20">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <h1 className="display text-[2.75rem] text-ink md:text-6xl lg:text-[4.25rem]">
          Agent context, compiled from your <i>own</i> documents.
        </h1>

        <p className="mt-6 max-w-[48ch] text-[15px] leading-relaxed text-ink-muted md:text-base">
          AGENTS.md, CLAUDE.md and skill files, built from a folder of specs and runbooks.
          Every sentence traces back to the document it came from.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/compile"
            className="inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-panel bg-accent px-5 text-sm font-medium text-accent-ink transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px"
          >
            <FolderOpen size={16} />
            Compile a folder
          </Link>
          <Link
            href="/forge"
            className="inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-panel border border-rule-strong px-5 text-sm font-medium text-ink transition-colors hover:bg-sunken active:translate-y-px"
          >
            Convert a document
            <ArrowRight size={14} />
          </Link>
        </div>
      </motion.div>

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden rounded-panel border border-rule bg-surface shadow-[0_20px_60px_-28px_rgb(var(--shadow-tint)/0.3)]"
      >
        <div className="rule-b flex h-10 items-center gap-3 px-3">
          <span className="font-mono text-[11px] text-ink-faint">runbook.md</span>
          <ArrowRight size={11} className="text-ink-faint" />
          <div className="flex items-center gap-px rounded-chip bg-sunken p-0.5">
            {(["md", "html", "docx"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTarget(t)}
                className={cn(
                  "rounded-chip px-2 py-0.5 font-mono text-[11px] transition-colors",
                  target === t ? "bg-accent text-accent-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] text-ink-faint">
            {ready ? "editable" : "loading"}
          </span>
        </div>

        <div className="grid grid-cols-1 divide-y divide-rule sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <textarea
            value={source}
            readOnly={!ready}
            spellCheck={false}
            aria-label="Markdown source"
            onChange={(e) => setSource(e.target.value)}
            className="h-[220px] resize-none bg-transparent p-3.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none sm:h-[320px]"
          />
          <pre className="h-[220px] overflow-auto whitespace-pre-wrap break-words bg-sunken/50 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink-muted sm:h-[320px]">
            {output ??
              (target === "docx" && bytes > 0
                ? `${bytes.toLocaleString("en-US")} bytes of Office Open XML`
                : "")}
          </pre>
        </div>

        <div className="rule-t flex h-9 items-center gap-3 px-3.5">
          {ready ? (
            <>
              <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                {diagnostics} diagnostic{diagnostics === 1 ? "" : "s"}
              </span>
              {lossy > 0 ? (
                <span className="font-mono text-[11px] tabular-nums text-accent">
                  {lossy} lossy
                </span>
              ) : null}
              <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">
                {bytes.toLocaleString("en-US")} B
              </span>
            </>
          ) : (
            <span className="font-mono text-[11px] text-ink-faint">
              loading the engine, then this becomes editable
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}
