"use client";

import { useCallback, useRef, useState } from "react";
import { FileArrowUp, FileText, X } from "@phosphor-icons/react";
import type { SampleInfo } from "@/lib/data";
import { FORMATS, formatFromName, type Format } from "@/lib/formats";
import type { Source } from "@/lib/use-conversion";
import { Chip } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const TEXT_DECODER = new TextDecoder();

export function SourcePanel({
  source,
  samples,
  onSource,
  onText,
  onClear,
}: {
  source: Source | null;
  samples: SampleInfo[];
  onSource: (file: File) => void;
  onText: (text: string) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const drop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) onSource(file);
    },
    [onSource],
  );

  if (!source) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={cn(
            "m-4 rounded-panel border border-dashed p-6 text-center transition-colors",
            dragging ? "border-ember bg-ember-wash" : "border-rule-strong",
          )}
        >
          <FileArrowUp size={22} className="mx-auto text-ink-faint" />
          <p className="mt-3 text-[13px] text-ink">Drop a document here</p>
          <p className="mx-auto mt-1 max-w-[34ch] text-[11px] leading-relaxed text-ink-muted">
            Markdown, DOCX and HTML are read in this tab and never uploaded. PDF, PPTX and
            XLSX need the server, and will ask first.
          </p>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="mt-3 rounded-chip px-2 py-1 text-[12px] text-ember underline underline-offset-4 hover:bg-ember-wash"
          >
            or choose a file
          </button>
          <input
            ref={input}
            type="file"
            className="sr-only"
            accept=".md,.markdown,.docx,.html,.htm,.pdf,.pptx,.xlsx"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onSource(f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            Or start from the corpus
          </h3>
          <ul className="space-y-px">
            {samples.map((s) => (
              <li key={s.file}>
                <button
                  type="button"
                  onClick={() => void loadSample(s, onSource)}
                  className="group w-full rounded-chip px-2 py-2 text-left transition-colors hover:bg-sunken"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-ink">{s.label}</span>
                    <Chip mono tone="quiet">
                      {s.from}
                    </Chip>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{s.note}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const info = FORMATS[source.from];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-9 shrink-0 items-center gap-2 px-3">
        <FileText size={13} className="shrink-0 text-ink-faint" />
        <span className="truncate font-mono text-[11px] text-ink">{source.name}</span>
        <Chip mono tone="quiet">
          {info.label}
        </Chip>
        {source.serverRead ? <Chip tone="neutral">read on the server</Chip> : null}
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear the source document"
          className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-chip text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
        >
          <X size={12} />
        </button>
      </header>

      {source.text !== null ? (
        <textarea
          value={source.text}
          onChange={(e) => onText(e.target.value)}
          spellCheck={false}
          aria-label="Source document"
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-relaxed text-ink outline-none"
        />
      ) : (
        <BinarySummary source={source} />
      )}
    </div>
  );
}

/**
 * A binary source has nothing to show and pretending otherwise is worse than saying so.
 *
 * A hex dump would be decoration. What is actually useful is the size, and the reminder that
 * the structure is visible in the Inspect tab once it has been read into the IR.
 */
function BinarySummary({ source }: { source: Source }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-4 text-center">
      <p className="font-mono text-2xl tabular-nums text-ink">
        {source.bytes.length.toLocaleString("en-US")}
        <span className="ml-1.5 text-sm text-ink-faint">bytes</span>
      </p>
      <p className="mx-auto max-w-[32ch] text-[12px] leading-relaxed text-ink-muted">
        {FORMATS[source.from].label} is a container, not text. Open Inspect to see what the
        reader found inside it.
      </p>
    </div>
  );
}

async function loadSample(s: SampleInfo, onSource: (file: File) => void) {
  const res = await fetch(`/markforge/samples/${s.file}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  onSource(new File([bytes], s.file, { type: FORMATS[s.from].mime }));
}

/** Decodes bytes for the source pane, or returns null for a format that is not text. */
export function decodeIfText(bytes: Uint8Array, from: Format): string | null {
  return FORMATS[from].text ? TEXT_DECODER.decode(bytes) : null;
}

export { formatFromName };
