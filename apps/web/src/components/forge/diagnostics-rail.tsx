"use client";

import { useEffect, useMemo, useState } from "react";
import { CaretDown, CheckCircle, Info, Warning, WarningOctagon } from "@phosphor-icons/react";
import type { Diagnostic } from "@markforge/ir";
import { Chip } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

/**
 * The rail: always available, open only when it has something to say.
 *
 * Every other converter treats a warning as an interruption, something to show once and
 * dismiss. Here the diagnostics are the product: a conversion that lost a merged cell and one
 * that did not are different results, and this list is the only thing that tells them apart.
 * So it keeps permanent space in the layout rather than becoming a toast.
 *
 * **It no longer keeps that space *open*.** It used to render expanded on every conversion,
 * holding up to 38% of the viewport for a list that is empty in the common case, which is how
 * a component that exists to inform turns into one that interrupts. It now opens itself when
 * a conversion produces an error and stays a single summary line otherwise, so the counts are
 * always visible and the detail is one click away.
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

const SEVERITY = {
  error: { icon: WarningOctagon, tone: "text-danger", label: "error" },
  warning: { icon: Warning, tone: "text-accent", label: "warning" },
  info: { icon: Info, tone: "text-ink-faint", label: "info" },
} as const;

/**
 * The area segment of `MF-<AREA>-<NNNN>`, spelled out.
 *
 * A code is stable forever and greppable, which is what it is for, but `MF-RDOCX-0003` on its
 * own tells a first-time reader nothing about which half of the pipeline spoke.
 */
const AREA: Record<string, string> = {
  IR: "the intermediate representation",
  DOCX: "the DOCX reader",
  PDF: "the PDF reader",
  MD: "the Markdown reader",
  HTML: "the HTML reader",
  PPTX: "the PPTX reader",
  XLSX: "the XLSX reader",
  OCR: "text recognition",
  RMD: "the Markdown writer",
  RDOCX: "the DOCX writer",
  RHTML: "the HTML writer",
  RENDER: "a writer",
  INFER: "structure inference",
  NORM: "normalisation",
  LLM: "the model layer",
  AGENT: "the context compiler",
  CFG: "configuration",
};

function areaOf(code: string): string | undefined {
  const part = code.split("-")[1];
  return part ? AREA[part] : undefined;
}

export function DiagnosticsRail({
  diagnostics,
  busy = false,
}: {
  diagnostics: readonly Diagnostic[];
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const sorted = useMemo(
    () =>
      [...diagnostics].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          Number(b.lossy) - Number(a.lossy) ||
          a.code.localeCompare(b.code),
      ),
    [diagnostics],
  );

  const lossy = sorted.filter((d) => d.lossy).length;
  const errors = sorted.filter((d) => d.severity === "error").length;

  // An error is the one case worth spending the user's screen on unasked. Lossy is not:
  // "this table became HTML" is normal, expected, and exactly what the summary line reports.
  // Opening only, never closing, so a user who collapses it is not overruled on the next run.
  useEffect(() => {
    if (errors > 0) setOpen(true);
  }, [errors]);

  return (
    <section className="rule-t flex min-h-0 flex-col bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-10 shrink-0 items-center gap-3 px-4 text-left transition-colors hover:bg-sunken"
      >
        <CaretDown
          size={12}
          className={cn("shrink-0 text-ink-faint transition-transform", !open && "-rotate-90")}
        />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          Diagnostics
        </span>

        <span className="flex items-center gap-1.5">
          <Chip mono tone={sorted.length ? "neutral" : "quiet"}>
            {sorted.length} total
          </Chip>
          {lossy > 0 ? (
            <Chip mono tone="accent">
              {lossy} lossy
            </Chip>
          ) : null}
          {errors > 0 ? (
            <Chip mono tone="danger">
              {errors} error
            </Chip>
          ) : null}
        </span>

        <span className="ml-auto text-[11px] text-ink-faint">
          {busy ? "converting" : lossy === 0 && errors === 0 ? "nothing was lost" : null}
        </span>
      </button>

      {open ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sorted.length === 0 ? <EmptyRail /> : sorted.map((d, i) => <Row key={`${d.code}-${i}`} d={d} />)}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The empty state, which is the most common one and therefore the one worth composing.
 *
 * "No results" would be wrong here. An empty diagnostics list is a positive finding: the
 * conversion is claiming that everything in the input survived into the output.
 */
function EmptyRail() {
  return (
    <div className="flex items-start gap-3 px-4 py-6">
      <CheckCircle size={18} className="mt-px shrink-0 text-ink-faint" />
      <div>
        <p className="text-[13px] text-ink">Nothing was lost.</p>
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-ink-muted">
          Every construct in the source has a representation in the target. When one does not,
          it is listed here with a code, whether information was lost, and where it went.
        </p>
      </div>
    </div>
  );
}

function Row({ d }: { d: Diagnostic }) {
  const meta = SEVERITY[d.severity];
  const Icon = meta.icon;
  const area = areaOf(d.code);

  return (
    <article className="rule-t grid grid-cols-[16px_128px_1fr] gap-x-3 px-4 py-2.5 first:border-t-0 hover:bg-sunken/60">
      <Icon size={14} className={cn("mt-0.5", meta.tone)} aria-label={meta.label} />

      <div className="min-w-0">
        <div className="font-mono text-[11px] tabular-nums text-ink">{d.code}</div>
        {area ? <div className="mt-0.5 text-[10px] leading-tight text-ink-faint">{area}</div> : null}
      </div>

      <div className="min-w-0">
        <p className="text-[12px] leading-relaxed text-ink">{d.message}</p>

        {(d.lossy || d.construct || d.retained || d.degraded) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {d.lossy ? <Chip tone="accent">information lost</Chip> : null}
            {d.degraded ? <Chip tone="neutral">degraded, nothing lost</Chip> : null}
            {d.construct ? (
              <Chip mono tone="neutral">
                {d.construct}
              </Chip>
            ) : null}
            {d.retained ? (
              <Chip mono tone="neutral">
                kept as {d.retained.as}
              </Chip>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
