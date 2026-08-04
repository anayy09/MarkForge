"use client";

import { useCallback, useRef, useState } from "react";
import type { BrowserCompileResult } from "@/lib/engine";
import { engine } from "@/lib/engine";
import type { TargetSummary } from "@/lib/data";

/** One document the user handed over. `bytes` is all the compiler ever sees. */
export interface CompileSource {
  path: string;
  bytes: Uint8Array;
}

export type CompileStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "compiling" }
  | { kind: "ok"; ms: number }
  | { kind: "error"; message: string };

/**
 * One run of the Agent Context Compiler, in the browser.
 *
 * Deliberately **not** debounced-on-change the way `useConversion` is. A conversion is one
 * document and runs in single-digit milliseconds, so recomputing it as the user types is
 * free and feels live. A compile reads a folder, extracts and ranks every sentence in it and
 * verifies the result against a traceability gate, and firing that on every checkbox tick
 * would make the page feel worse rather than better. It runs when asked.
 */
export function useCompile() {
  const [result, setResult] = useState<BrowserCompileResult | null>(null);
  const [status, setStatus] = useState<CompileStatus>({ kind: "idle" });
  const runId = useRef(0);

  const run = useCallback(
    async (sources: CompileSource[], profiles: TargetSummary[], targets: string[]) => {
      if (sources.length === 0 || targets.length === 0) {
        setResult(null);
        setStatus({ kind: "idle" });
        return;
      }

      const id = ++runId.current;
      try {
        setStatus({ kind: "loading" });
        const mf = await engine();
        if (id !== runId.current) return;

        setStatus({ kind: "compiling" });
        const started = performance.now();

        // The profiles go through untouched. They were resolved and schema-validated in Node
        // by prepare-assets.mjs, and anything this app did to them on the way would be an
        // unvalidated edit arriving after the only validator in the pipeline.
        const out = await mf.compileAgentContext(sources, {
          profiles: profiles as unknown as Parameters<typeof mf.compileAgentContext>[1]["profiles"],
          targets,
        });

        if (id !== runId.current) return;
        setResult(out);
        setStatus({ kind: "ok", ms: Math.round(performance.now() - started) });
      } catch (e) {
        if (id !== runId.current) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    setResult(null);
    setStatus({ kind: "idle" });
  }, []);

  return { result, status, run, reset };
}

/* ------------------------------------------------------------------------------------- */

export interface TracedSegment {
  text: string;
  /** Null for scaffolding: headings, list markers, fences. Not everything is traced. */
  sentence: { start: number; end: number; unitIds: string[] } | null;
}

/**
 * Splits a generated file into traced and untraced runs, in order.
 *
 * This is what makes the provenance claim visible instead of merely true. The manifest
 * records a character range for every sentence the compiler can attribute, so the file is
 * cut at those boundaries and the gaps between them are the scaffolding the profile
 * declared. A file that rendered every character as traced would be lying about the
 * headings, and one that rendered none would be hiding the whole feature.
 */
export function traceSegments(
  content: string,
  file: { sections: { sentences: { start: number; end: number; unitIds: string[] }[] }[] } | undefined,
): TracedSegment[] {
  if (!file) return [{ text: content, sentence: null }];

  const traced = file.sections
    .flatMap((s) => s.sentences)
    .filter((s) => s.unitIds.length > 0)
    .sort((a, b) => a.start - b.start);

  const out: TracedSegment[] = [];
  let pos = 0;
  for (const sentence of traced) {
    // Ranges are half-open and non-overlapping by construction, but a defensive skip beats
    // rendering a negative slice if that ever stops being true.
    if (sentence.start < pos) continue;
    if (sentence.start > pos) out.push({ text: content.slice(pos, sentence.start), sentence: null });
    out.push({ text: content.slice(sentence.start, sentence.end), sentence });
    pos = sentence.end;
  }
  if (pos < content.length) out.push({ text: content.slice(pos), sentence: null });
  return out;
}
