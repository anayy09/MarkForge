"use client";

import { useCallback, useState } from "react";
import { ArrowRight, X } from "@phosphor-icons/react";
import type { SampleInfo } from "@/lib/data";
import {
  FORMATS,
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  defaultSettings,
  formatFromName,
  type FlavorData,
  type Format,
  type OutputFormat,
  type Settings,
} from "@/lib/formats";
import { loadPdfRenderer, type PdfLoadProgress, type PdfRenderer } from "@/lib/pdf";
import { useConversion, type Source } from "@/lib/use-conversion";
import { DiagnosticsRail } from "@/components/forge/diagnostics-rail";
import { InspectPanel } from "@/components/forge/inspect-panel";
import { OptionsPanel } from "@/components/forge/options-panel";
import { OutputPanel } from "@/components/forge/output-panel";
import { ServerReadDialog } from "@/components/forge/server-read-dialog";
import { SourcePanel, decodeIfText } from "@/components/forge/source-panel";
import { cn } from "@/lib/cn";

/**
 * Two views, down from four.
 *
 * `Round trip` converted the document out and back and scored the difference, and `Flavours`
 * rendered the same document under all seven Markdown presets side by side. Both were
 * interesting and neither was a task: someone arrives here to convert a document, and four
 * peer tabs made the page read as an instrument panel with the conversion hidden in one
 * quarter of it. Flavour selection was always in the options column as well, so that tab was
 * a second control for a setting that already had one. `Inspect` stays because "what did the
 * reader actually see in my file" is a question people arrive with.
 */
const TABS = [
  { id: "output", label: "Output" },
  { id: "inspect", label: "Inspect" },
] as const;

type Tab = (typeof TABS)[number]["id"];

const TEXT_ENCODER = new TextEncoder();

export function Workbench({ flavors, samples }: { flavors: FlavorData; samples: SampleInfo[] }) {
  const [source, setSource] = useState<Source | null>(null);
  const [to, setTo] = useState<OutputFormat>("md");
  const [settings, setSettings] = useState<Settings>(() => defaultSettings(flavors));
  const [tab, setTab] = useState<Tab>("output");

  const [pdfRenderer, setPdfRenderer] = useState<PdfRenderer | null>(null);
  const [pdfProgress, setPdfProgress] = useState<PdfLoadProgress | null>(null);

  /** A file whose format the browser cannot read. Nothing is sent until this is confirmed. */
  const [pending, setPending] = useState<File | null>(null);
  /** Problems with the file itself, before any conversion. Shown in place, never as a dialog. */
  const [notice, setNotice] = useState<string | null>(null);

  const { result, status } = useConversion(source, to, settings, flavors, pdfRenderer);

  const accept = useCallback(async (file: File) => {
    setNotice(null);
    const from = formatFromName(file.name);
    if (!from) {
      // Naming the extensions beats guessing at the format and producing nonsense.
      setNotice(
        `MarkForge does not recognise "${file.name}". It reads ${INPUT_FORMATS.join(", ")}.`,
      );
      return;
    }
    if (FORMATS[from].read === "server") {
      setPending(file);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setSource({ name: file.name, from, bytes, text: decodeIfText(bytes, from) });
  }, []);

  const editText = useCallback((text: string) => {
    setSource((s) => (s ? { ...s, text, bytes: TEXT_ENCODER.encode(text) } : s));
  }, []);

  const loadPdf = useCallback(() => {
    setNotice(null);
    void loadPdfRenderer(setPdfProgress)
      .then((render) => {
        setPdfRenderer(() => render);
        setPdfProgress(null);
      })
      .catch((e: unknown) => {
        setPdfProgress(null);
        setNotice(
          `The Typst compiler did not load. ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }, []);

  const busy = status.kind === "converting" || status.kind === "loading";

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
      <Toolbar
        source={source}
        to={to}
        onTo={setTo}
        tab={tab}
        onTab={setTab}
        pdfProgress={pdfProgress}
      />

      {notice ? (
        <div
          role="status"
          className="rule-b flex shrink-0 items-start gap-3 bg-accent-wash px-4 py-2.5"
        >
          <p className="text-[12px] leading-relaxed text-ink">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-chip text-ink-muted hover:text-ink"
          >
            <X size={11} />
          </button>
        </div>
      ) : null}

      {/*
       * Two layouts, not one responsive compromise.
       *
       * At lg and above this is a fixed-height workbench: three columns that fill the
       * viewport with the diagnostics rail pinned beneath, and each pane scrolls its own
       * content. Below lg the panes stack and the *page* scrolls, because four regions
       * competing for 700px of phone would give each of them about 150px and make all four
       * useless. Each stacked pane gets a height it can actually work in instead.
       */}
      <div className="grid min-h-0 grid-cols-1 lg:flex-1 lg:grid-cols-[300px_minmax(0,1fr)_290px]">
        <section className="rule-b flex h-[420px] flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:border-b-0 lg:border-r lg:border-rule">
          <SourcePanel
            source={source}
            samples={samples}
            onSource={(f) => void accept(f)}
            onText={editText}
            onClear={() => setSource(null)}
          />
        </section>

        <section className="rule-b flex h-[560px] flex-col overflow-hidden bg-surface lg:h-auto lg:min-h-0 lg:border-b-0">
          {tab === "output" ? (
            <OutputPanel
              result={result}
              status={status}
              to={to}
              name={source?.name ?? "document"}
              onLoadPdf={loadPdf}
            />
          ) : null}
          {tab === "inspect" ? <InspectPanel result={result} /> : null}
        </section>

        <section className="flex h-[460px] flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:border-l lg:border-rule">
          <OptionsPanel to={to} settings={settings} flavors={flavors} onChange={setSettings} />
        </section>
      </div>

      {/*
       * The rail reserves nothing when it is closed, and it is closed unless something went
       * wrong. It used to hold up to 38% of the viewport open at all times, which put a list
       * that is usually empty between the user and the output on every single conversion.
       */}
      <div className="shrink-0 lg:max-h-[38vh]">
        <DiagnosticsRail diagnostics={result?.diagnostics ?? []} busy={busy} />
      </div>

      {pending ? (
        <ServerReadDialog
          file={pending}
          onCancel={() => setPending(null)}
          onDone={(next) => {
            setPending(null);
            setSource(next);
          }}
        />
      ) : null}
    </div>
  );
}

function Toolbar({
  source,
  to,
  onTo,
  tab,
  onTab,
  pdfProgress,
}: {
  source: Source | null;
  to: OutputFormat;
  onTo: (f: OutputFormat) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  pdfProgress: PdfLoadProgress | null;
}) {
  return (
    <div className="rule-b flex h-11 shrink-0 items-center gap-3 overflow-x-auto bg-surface px-3">
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          {source ? FORMATS[source.from].label : "no source"}
        </span>
        <ArrowRight size={11} className="text-ink-faint" />
        <div className="flex items-center gap-px rounded-chip bg-sunken p-0.5">
          {OUTPUT_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onTo(f)}
              className={cn(
                "rounded-chip px-2 py-1 font-mono text-[11px] transition-colors",
                to === f
                  ? "bg-accent text-accent-ink"
                  : "text-ink-muted hover:bg-surface hover:text-ink",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-px">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={cn(
              "relative px-2.5 py-2 text-[12px] transition-colors",
              tab === t.id ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {t.label}
            {tab === t.id ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-chip bg-accent" />
            ) : null}
          </button>
        ))}
      </div>

      {pdfProgress ? <PdfProgress p={pdfProgress} /> : null}
    </div>
  );
}

function PdfProgress({ p }: { p: PdfLoadProgress }) {
  const pct = p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
  return (
    <div className="flex shrink-0 items-center gap-2 pl-3">
      <div className="h-1 w-24 overflow-hidden rounded-chip bg-sunken">
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-ink-muted">
        {p.stage === "starting" ? "starting compiler" : `${pct}%`}
      </span>
    </div>
  );
}

export type { Format };
