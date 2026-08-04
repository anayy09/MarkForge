"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { FolderOpen, Function, Spinner } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import type { CompileSource } from "@/lib/use-compile";

/** What the browser build can ingest. Anything else is reported by name, not dropped. */
const READABLE = /\.(md|markdown|html|htm|docx)$/i;

/**
 * The way in.
 *
 * A folder is the unit this feature works on, so the folder is what the control asks for.
 * `webkitdirectory` is non-standard but is implemented in every current browser, and the
 * plain file input is beside it rather than behind a fallback branch, because plenty of
 * people have five files selected in Finder and no folder to point at.
 */
export function Dropzone({
  onSources,
  onSample,
  busy,
  compact = false,
}: {
  onSources: (sources: CompileSource[]) => void;
  onSample: () => void;
  busy: boolean;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    async (files: File[]) => {
      const usable = files.filter((f) => READABLE.test(f.name));
      const skipped = files.filter((f) => !READABLE.test(f.name));
      setRejected(skipped.map((f) => f.name));
      if (usable.length === 0) return;

      const sources = await Promise.all(
        usable.map(async (file) => ({
          // `webkitRelativePath` keeps the folder structure in the label, which is what the
          // provenance panel shows a user to identify the document later. A bare filename
          // would collide the moment two folders both hold a README.
          path: (file.webkitRelativePath || file.name).replace(/\\/g, "/"),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      onSources(sources);
    },
    [onSources],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      void accept(Array.from(e.dataTransfer.files));
    },
    [accept],
  );

  return (
    <div className={compact ? "" : "mx-auto w-full max-w-2xl"}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-panel border border-dashed transition-colors",
          compact ? "p-4" : "px-6 py-12 md:py-16",
          over ? "border-accent bg-accent-wash" : "border-rule-strong bg-surface",
        )}
      >
        <div className={cn("flex flex-col items-center text-center", compact && "gap-2")}>
          {busy ? (
            <Spinner size={compact ? 20 : 30} className="animate-spin text-accent" />
          ) : (
            <FolderOpen size={compact ? 20 : 30} weight="light" className="text-ink-faint" />
          )}

          {!compact && (
            <p className="mt-4 text-[15px] text-ink">
              Drop a folder of documents, or choose them below.
            </p>
          )}
          {!compact && (
            <p className="mt-1.5 text-[13px] text-ink-muted">
              Markdown, HTML and Word. Nothing leaves this tab.
            </p>
          )}

          <div className={cn("flex flex-wrap items-center justify-center gap-2", compact ? "" : "mt-6")}>
            <button
              type="button"
              disabled={busy}
              onClick={() => dirInput.current?.click()}
              className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-panel bg-accent px-3.5 text-[13px] font-medium text-accent-ink transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px disabled:opacity-45"
            >
              Choose a folder
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-panel border border-rule-strong px-3.5 text-[13px] text-ink transition-colors hover:bg-sunken disabled:opacity-45"
            >
              Choose files
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onSample}
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-panel px-3 text-[13px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink disabled:opacity-45"
            >
              <Function size={14} />
              Use the sample set
            </button>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".md,.markdown,.html,.htm,.docx"
          className="hidden"
          onChange={(e) => {
            void accept(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <input
          ref={dirInput}
          type="file"
          multiple
          className="hidden"
          // `webkitdirectory` is non-standard and React has no prop for it, so it is spread
          // in as a raw attribute. `directory` beside it is the standardised spelling that
          // browsers are moving toward; setting both costs nothing and ages better.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            void accept(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {rejected.length > 0 ? (
        <p role="status" className="mt-3 text-[12px] leading-relaxed text-ink-muted">
          Skipped {rejected.length} file{rejected.length === 1 ? "" : "s"} this build cannot read:{" "}
          <span className="font-mono text-[11px] text-ink-faint">
            {rejected.slice(0, 4).join(", ")}
            {rejected.length > 4 ? `, and ${rejected.length - 4} more` : ""}
          </span>
          . PDF, PPTX and XLSX are readable by the command line tool but are not in the browser
          bundle.
        </p>
      ) : null}
    </div>
  );
}
