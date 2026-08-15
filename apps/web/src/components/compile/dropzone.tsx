"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { FolderOpen, Function, Spinner } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import type { CompileSource } from "@/lib/use-compile";

/** What the browser build can ingest. Anything else is reported by name, not dropped. */
const READABLE = /\.(md|markdown|html|htm|docx)$/i;

/** A file with the path it should be labelled by, which is not always `file.name`. */
interface Picked {
  file: File;
  path: string;
}

/**
 * Everything under a drop, folders included.
 *
 * `dataTransfer.files` flattens a dropped folder to the folder itself: a single zero-byte
 * entry named after the directory, which fails the extension test and gets reported as a file
 * this build cannot read. Since a folder is the unit this feature works on, that left the
 * control unable to do the one thing its own instruction asks for. The entry API is the way
 * to read a directory out of a drop; it is non-standard and every browser implements it.
 */
async function pick(transfer: DataTransfer): Promise<Picked[]> {
  // Taken synchronously. The item list is emptied when the drop handler returns, so an entry
  // not claimed before the first await is gone by the time it would be asked for.
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    return Array.from(transfer.files).map((file) => ({ file, path: file.name }));
  }

  const picked: Picked[] = [];
  await Promise.all(entries.map((entry) => walk(entry, "", picked)));
  return picked;
}

async function walk(entry: FileSystemEntry, prefix: string, out: Picked[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    // A file the OS declines to hand over is skipped rather than failing the drop: one
    // unreadable file in a folder of forty is not a reason to refuse the other thirty-nine.
    if (file) out.push({ file, path });
    return;
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // `readEntries` returns at most a hundred per call and signals the end with an empty
    // batch, so a single call would silently truncate any folder larger than that.
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return;
    await Promise.all(batch.map((child) => walk(child, path, out)));
  }
}

/** The picker's own answer to the same question. `webkitRelativePath` is set for a folder. */
function fromInput(files: FileList | null): Picked[] {
  return Array.from(files ?? []).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

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
    async (picked: Picked[]) => {
      const usable = picked.filter((p) => READABLE.test(p.path));
      setRejected(picked.filter((p) => !READABLE.test(p.path)).map((p) => p.path));
      if (usable.length === 0) return;

      const sources = await Promise.all(
        usable.map(async (p) => ({
          // The folder structure stays in the label, which is what the provenance panel shows
          // a user to identify the document later. A bare filename would collide the moment
          // two folders both hold a README.
          path: p.path.replace(/\\/g, "/"),
          bytes: new Uint8Array(await p.file.arrayBuffer()),
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
      void pick(e.dataTransfer).then(accept);
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
            void accept(fromInput(e.target.files));
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
            void accept(fromInput(e.target.files));
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
