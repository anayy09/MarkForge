"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, DownloadSimple } from "@phosphor-icons/react";
import { markdownToHtml } from "@/lib/preview";
import { traceSegments } from "@/lib/use-compile";
import { cn } from "@/lib/cn";

type View = "rendered" | "traced";

export interface ManifestFile {
  path: string;
  sections: { sentences: { start: number; end: number; unitIds: string[] }[] }[];
}

/**
 * One generated file, in the two views that answer different questions.
 *
 * **Rendered** answers "what did I get". It is a real `md -> html` conversion through the
 * engine, so it is the document, not an approximation of it.
 *
 * **Traced** answers "where did it come from", and is the reason this feature exists. It
 * shows the Markdown as written, with every attributable sentence underlined and clickable.
 * The two are separate views rather than one clever overlay because the provenance offsets
 * index the Markdown, and mapping them onto rendered HTML would mean guessing which output
 * node a source range landed in. A guess is the wrong thing to put under a claim of
 * complete traceability.
 */
export function FileView({
  path,
  content,
  manifestFile,
  selected,
  onSelect,
}: {
  path: string;
  content: string;
  manifestFile: ManifestFile | undefined;
  selected: string[] | null;
  onSelect: (unitIds: string[] | null) => void;
}) {
  const isMarkdown = /\.mdx?$/i.test(path);
  const [view, setView] = useState<View>(isMarkdown ? "traced" : "rendered");
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Non-Markdown outputs (.mcp.json) have nothing to render and nothing to trace, so the
  // toggle is not offered for them and the raw view is the only one.
  useEffect(() => {
    if (!isMarkdown || view !== "rendered") return;
    let live = true;
    void markdownToHtml(content, path).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [content, path, view, isMarkdown]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    // Only the basename: a browser download cannot create `.claude/skills/x/` anyway, and a
    // slash in the attribute is silently rewritten rather than honoured.
    a.download = path.split("/").pop() ?? "output.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Memoised because it slices the whole file, and the toolbar re-renders on every copy
  // click and every selection change in the pane beside it.
  const segments = useMemo(() => traceSegments(content, manifestFile), [content, manifestFile]);
  const tracedCount = useMemo(() => segments.filter((s) => s.sentence).length, [segments]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="rule-b flex h-10 shrink-0 items-center gap-3 px-3">
        {isMarkdown ? (
          <div className="flex items-center gap-px rounded-chip bg-sunken p-0.5">
            {(["traced", "rendered"] as const).map((v) => (
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
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            {path.split(".").pop()}
          </span>
        )}

        {view === "traced" && isMarkdown ? (
          <span className="hidden text-[12px] text-ink-muted sm:inline">
            {tracedCount} traced sentence{tracedCount === 1 ? "" : "s"}. Click one.
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(content).then(() => setCopied(true));
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-chip px-2 text-[12px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
          >
            {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex h-7 items-center gap-1.5 rounded-chip px-2 text-[12px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
          >
            <DownloadSimple size={13} />
            Download
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {view === "rendered" && isMarkdown ? (
          html === null ? (
            <PreviewSkeleton />
          ) : (
            <div className="prose-mf" dangerouslySetInnerHTML={{ __html: html }} />
          )
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.75] text-ink">
            {segments.map((segment, i) =>
              segment.sentence ? (
                <span
                  key={i}
                  className="traced"
                  data-selected={
                    selected !== null &&
                    segment.sentence.unitIds.some((id) => selected.includes(id))
                  }
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(segment.sentence?.unitIds ?? null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(segment.sentence?.unitIds ?? null);
                    }
                  }}
                >
                  {segment.text}
                </span>
              ) : (
                <span key={i}>{segment.text}</span>
              ),
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Shaped like the prose it replaces, so the pane does not jump when the render lands. */
function PreviewSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden>
      <div className="h-5 w-40 rounded-chip bg-sunken" />
      <div className="h-3 w-full rounded-chip bg-sunken" />
      <div className="h-3 w-[92%] rounded-chip bg-sunken" />
      <div className="h-3 w-[70%] rounded-chip bg-sunken" />
      <div className="mt-6 h-5 w-52 rounded-chip bg-sunken" />
      <div className="h-3 w-[88%] rounded-chip bg-sunken" />
      <div className="h-3 w-[60%] rounded-chip bg-sunken" />
    </div>
  );
}
