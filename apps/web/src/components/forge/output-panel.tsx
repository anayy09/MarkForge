"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, DownloadSimple } from "@phosphor-icons/react";
import { Button, Chip } from "@/components/ui/primitives";
import { FORMATS, type OutputFormat } from "@/lib/formats";
import { PDF_LIMITS } from "@/lib/pdf";
import { markdownToHtml, sanitizeHtml } from "@/lib/preview";
import type { Conversion, Status } from "@/lib/use-conversion";
import { cn } from "@/lib/cn";

type View = "preview" | "code";

export function OutputPanel({
  result,
  status,
  to,
  name,
  onLoadPdf,
}: {
  result: Conversion | null;
  status: Status;
  to: OutputFormat;
  name: string;
  onLoadPdf: () => void;
}) {
  /*
   * Preview first, and this used to have no preview at all.
   *
   * The pane showed a wall of Markdown source and nothing else, so the only way to find out
   * what you had converted was to download the file and open it somewhere. For a tool whose
   * entire job is producing a document, that put the actual result one step outside the
   * product. `code` is still one click away, because for Markdown and HTML the source *is*
   * often what a person came for.
   */
  const [view, setView] = useState<View>("preview");

  if (status.kind === "error" && status.message === "needs-pdf-compiler") {
    return <PdfGate onLoad={onLoadPdf} />;
  }
  if (status.kind === "error") return <ErrorState message={status.message} />;
  if (status.kind === "empty") return <IdleState />;
  if (!result) return <Skeleton />;

  // PDF renders in the browser's own viewer and DOCX has no honest preview, so the toggle is
  // offered only where both views exist rather than being shown disabled.
  const hasBothViews = result.to === "md" || result.to === "html";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-10 shrink-0 items-center gap-2.5 px-3">
        {hasBothViews ? (
          <div className="flex items-center gap-px rounded-chip bg-sunken p-0.5">
            {(["preview", "code"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded-chip px-2 py-1 text-[12px] capitalize transition-colors",
                  view === v ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                )}
              >
                {v}
              </button>
            ))}
          </div>
        ) : (
          <Chip mono tone="quiet">
            {FORMATS[result.to].label}
          </Chip>
        )}

        <span className="font-mono text-[11px] tabular-nums text-ink-muted">
          {result.bytes.length.toLocaleString("en-US")} B
        </span>
        <span className="hidden font-mono text-[11px] tabular-nums text-ink-faint sm:inline">
          {result.ms} ms
        </span>
        {status.kind === "converting" ? (
          <span className="text-[11px] text-ink-faint">reconverting</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {result.text !== null ? <CopyButton text={result.text} /> : null}
          <DownloadButton result={result} name={name} />
        </div>
      </header>

      {result.to === "pdf" ? (
        <PdfPreview bytes={result.bytes} />
      ) : result.text === null ? (
        <DocxSummary result={result} />
      ) : view === "code" ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-[12px] leading-relaxed text-ink">
          {result.text}
        </pre>
      ) : (
        <RenderedPreview text={result.text} to={result.to} />
      )}
    </div>
  );
}

/**
 * The output as a document rather than as source.
 *
 * For an HTML target the engine already produced HTML, so it is shown directly. For Markdown
 * it is converted a second time, `md -> html`, through the same engine. That second
 * conversion is a rendering step for display only: the bytes offered for download are always
 * the first conversion's, so nothing the preview does can change what the user takes away.
 */
function RenderedPreview({ text, to }: { text: string; to: OutputFormat }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (to === "html") {
      setHtml(sanitizeHtml(text));
      return;
    }
    setHtml(null);
    void markdownToHtml(text).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [text, to]);

  if (html === null) return <Skeleton />;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
      <div className="prose-mf" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/* ---------------------------------------------------------------------------------- states */

function IdleState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <p className="max-w-[36ch] text-center text-[13px] leading-relaxed text-ink-muted">
        Load a document and the conversion runs here, in this tab.
      </p>
    </div>
  );
}

/** Shaped like the output it replaces, so nothing jumps when the text arrives. */
function Skeleton() {
  const widths = ["62%", "88%", "45%", "94%", "71%", "83%", "38%"];
  return (
    <div className="min-h-0 flex-1 space-y-2.5 p-3" aria-busy="true" aria-label="Converting">
      {widths.map((w, i) => (
        <div
          key={i}
          style={{ width: w, animationDelay: `${i * 70}ms` }}
          className="h-3 animate-pulse rounded-chip bg-sunken"
        />
      ))}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-start px-6 py-8">
      <div className="max-w-prose">
        <h3 className="text-[13px] font-medium text-ink">This conversion did not happen.</h3>
        {/*
          The engine's refusal messages name the reason and often the ADR behind it. They are
          written for a person, so they are shown rather than replaced with "failed".
        */}
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
          {message}
        </p>
      </div>
    </div>
  );
}

/**
 * The one place the app asks before spending 29 MB of someone's connection.
 *
 * The size is stated before the download, not during it, and the four limits are stated
 * before the output exists rather than beside it. Both of those are the difference between
 * informing someone and telling them afterwards.
 */
function PdfGate({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
      <div className="max-w-prose">
        <h3 className="text-[14px] font-medium text-ink">Writing a PDF needs the Typst compiler.</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          It is WebAssembly, and with the font set it is about{" "}
          <span className="font-mono tabular-nums text-ink">29 MB</span>. It stays out of the
          main download so that people who never render a PDF never pay for one. It runs in
          this tab; the document is not uploaded.
        </p>

        <ul className="mt-5 space-y-2">
          {PDF_LIMITS.map((limit) => (
            <li key={limit} className="flex gap-2.5 text-[12px] leading-relaxed text-ink-muted">
              <span aria-hidden className="mt-[7px] h-px w-3 shrink-0 bg-rule-strong" />
              {limit}
            </li>
          ))}
        </ul>

        <Button variant="primary" className="mt-6" onClick={onLoad}>
          Load the compiler
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------- outputs */

function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const url = useMemo(() => {
    // A copy into a fresh ArrayBuffer: the engine's view may be over a larger buffer, and
    // Blob would then embed the whole thing.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return URL.createObjectURL(new Blob([copy], { type: "application/pdf" }));
  }, [bytes]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return (
    <div className="min-h-0 flex-1 bg-sunken">
      {/* The browser's own PDF viewer. No second PDF renderer ships to prove a first one worked. */}
      <iframe src={url} title="Rendered PDF" className="h-full w-full border-0" />
    </div>
  );
}

/**
 * DOCX has no preview here, and saying so beats inventing one.
 *
 * Rendering a DOCX would mean converting it back to HTML, which is a second conversion whose
 * losses would be attributed to the first. Convert to HTML in the target selector if that is
 * what you want to see.
 */
function DocxSummary({ result }: { result: Conversion }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="font-mono text-2xl tabular-nums text-ink">
        {result.bytes.length.toLocaleString("en-US")}
        <span className="ml-1.5 text-sm text-ink-faint">bytes</span>
      </p>
      <p className="mt-1 max-w-[38ch] text-[12px] leading-relaxed text-ink-muted">
        A DOCX is a ZIP of XML parts. Previewing it would mean rendering it through a second
        converter, and that converter&apos;s losses would look like this one&apos;s. Download
        it, or switch the target to HTML to see the same structure.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------------- actions */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setDone(true));
      }}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-chip px-2 text-[11px] transition-colors",
        done ? "text-accent" : "text-ink-muted hover:bg-sunken hover:text-ink",
      )}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function DownloadButton({ result, name }: { result: Conversion; name: string }) {
  const download = () => {
    const copy = new Uint8Array(result.bytes.length);
    copy.set(result.bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: FORMATS[result.to].mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/\.[^.]+$/, "")}.${FORMATS[result.to].ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={download}
      className="flex h-7 items-center gap-1.5 rounded-chip px-2 text-[11px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      <DownloadSimple size={12} />
      Download
    </button>
  );
}
