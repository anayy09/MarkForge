"use client";

import { useEffect, useState } from "react";
import type { FidelityScore } from "@markforge/fidelity";
import { Chip } from "@/components/ui/primitives";
import { LOOPS, METRICS, UNAVAILABLE, metricValues, runLoop, type MetricKey } from "@/lib/loops";
import type { FlavorData, Settings } from "@/lib/formats";
import type { PdfRenderer } from "@/lib/pdf";
import type { Source } from "@/lib/use-conversion";
import { cn } from "@/lib/cn";

/**
 * The measurement, run on the user's own document.
 *
 * docs/FIDELITY.md reports these six numbers over a fixed corpus. That answers "how well does
 * MarkForge do on documents MarkForge chose", which is the right question for a regression
 * gate and the wrong one for someone deciding whether to use it. This runs the same metrics,
 * composed the same way, on whatever they loaded.
 */
export function RoundTripPanel({
  source,
}: {
  source: Source | null;
  settings: Settings;
  flavors: FlavorData;
  pdfRenderer: PdfRenderer | null;
  onLoadPdf: () => void;
}) {
  const available = source ? (LOOPS[source.from] ?? []) : [];
  const [loopId, setLoopId] = useState<string | null>(null);
  const [score, setScore] = useState<FidelityScore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // A new document invalidates the previous result. Leaving it on screen beside a different
  // filename would be the worst kind of wrong number: one that looks current.
  useEffect(() => {
    setScore(null);
    setError(null);
    setLoopId(available[0]?.id ?? null);
    // `available` is derived from source.from, so source is the real dependency.
  }, [source?.name, source?.from]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!source || !loopId) return;
    let live = true;
    setRunning(true);
    setError(null);
    runLoop(loopId, source.bytes, source.name)
      .then((r) => {
        if (live) setScore(r.score);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setRunning(false);
      });
    return () => {
      live = false;
    };
  }, [source, loopId]);

  if (!source) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-[38ch] text-center text-[13px] leading-relaxed text-ink-muted">
          Load a document to measure what a round trip costs it. The six metrics are the ones
          the build gates on, composed the same way.
        </p>
      </div>
    );
  }

  const values = score ? metricValues(score) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-3">
        {available.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setLoopId(l.id)}
            className={cn(
              "shrink-0 rounded-chip px-2 py-1 font-mono text-[11px] transition-colors",
              loopId === l.id ? "bg-ember-wash text-ember" : "text-ink-muted hover:bg-sunken",
            )}
          >
            {l.label}
          </button>
        ))}
        {running ? (
          <span className="ml-auto shrink-0 text-[11px] text-ink-faint">measuring</span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <p className="max-w-prose text-[12px] leading-relaxed text-ink-muted">{error}</p>
        ) : null}

        {available.find((l) => l.id === loopId) ? (
          <p className="mb-5 max-w-prose text-[12px] leading-relaxed text-ink-muted">
            {available.find((l) => l.id === loopId)?.description}
          </p>
        ) : null}

        {values ? (
          <dl className="space-y-3">
            {METRICS.map((m) => (
              <MetricRow key={m.key} label={m.label} explain={m.explain} value={values[m.key as MetricKey]} />
            ))}
          </dl>
        ) : (
          <div className="space-y-3" aria-busy="true">
            {METRICS.map((m) => (
              <div key={m.key} className="h-8 animate-pulse rounded-chip bg-sunken" />
            ))}
          </div>
        )}

        {score && score.census.length > 0 ? <CensusTable census={score.census} /> : null}
        {score && score.census.length === 0 ? (
          <p className="mt-6 text-[12px] leading-relaxed text-ink-muted">
            Every node type survives in the same count. When one does not, the difference is
            listed here, which is what turns a dropped structural score into a named cause.
          </p>
        ) : null}

        <Unavailable />
      </div>
    </div>
  );
}

function MetricRow({ label, explain, value }: { label: string; explain: string; value: number }) {
  const pct = value * 100;
  // Perfect, good, and the rest. Three bands rather than a gradient, because a gradient
  // implies a precision the corpus does not have.
  const tone = value >= 0.999 ? "text-ink" : value >= 0.9 ? "text-ink" : "text-ember";

  return (
    <div className="rule-b pb-3 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <dt className="text-[12px] text-ink">{label}</dt>
        <span
          aria-hidden
          className="h-px flex-1 bg-rule"
          style={{ maxWidth: 180 }}
        />
        <dd className={cn("font-mono text-[13px] tabular-nums", tone)}>{pct.toFixed(1)}%</dd>
      </div>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-ink-faint">{explain}</p>
    </div>
  );
}

function CensusTable({ census }: { census: { nodeType: string; expected: number; actual: number }[] }) {
  return (
    <div className="mt-7">
      <h3 className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        Where the difference is
      </h3>
      <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-ink-muted">
        Node types whose counts changed. This is the difference between knowing a score
        dropped and knowing that three tables became three paragraphs.
      </p>
      <table className="w-full">
        <thead>
          <tr className="rule-b text-left">
            <th className="pb-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-faint">
              node type
            </th>
            <th className="pb-1.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-faint">
              expected
            </th>
            <th className="pb-1.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-faint">
              actual
            </th>
            <th className="pb-1.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-faint">
              delta
            </th>
          </tr>
        </thead>
        <tbody>
          {census.map((c) => {
            const delta = c.actual - c.expected;
            return (
              <tr key={c.nodeType}>
                <td className="py-1 font-mono text-[11px] text-ink">{c.nodeType}</td>
                <td className="py-1 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                  {c.expected}
                </td>
                <td className="py-1 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                  {c.actual}
                </td>
                <td
                  className={cn(
                    "py-1 text-right font-mono text-[11px] tabular-nums",
                    delta === 0 ? "text-ink-faint" : "text-ember",
                  )}
                >
                  {delta > 0 ? `+${delta}` : delta}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The loops that are not here, and why.
 *
 * Omitting them would leave the impression that this is the whole corpus. It is not, and the
 * three missing loops include the two lowest-scoring ones.
 */
function Unavailable() {
  return (
    <div className="mt-8 max-w-prose">
      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        Not measurable in a browser
      </h3>
      <dl className="space-y-2.5">
        {UNAVAILABLE.map((u) => (
          <div key={u.label}>
            <dt className="mb-0.5">
              <Chip mono tone="quiet">
                {u.label}
              </Chip>
            </dt>
            <dd className="text-[11px] leading-relaxed text-ink-muted">{u.reason}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
