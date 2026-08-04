"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Trash, Warning, X } from "@phosphor-icons/react";
import type { AgentifySampleDoc, TargetSummary } from "@/lib/data";
import { useCompile, type CompileSource } from "@/lib/use-compile";
import { Dropzone } from "@/components/compile/dropzone";
import { FileView, type ManifestFile } from "@/components/compile/file-view";
import { ProvenancePanel, type ManifestUnit } from "@/components/compile/provenance";
import { cn } from "@/lib/cn";

/**
 * The default selection.
 *
 * The two flat files, because they are what a person means when they say they want agent
 * context, and they are the pair the acceptance criterion in docs/AGENTIFY.md is stated
 * over. `claude-skills` is first-class too but emits five files, which is a lot of tabs to
 * open on someone before they have decided they want them.
 */
const DEFAULT_TARGETS = ["agents-md", "claude-md"];

export function CompileWorkbench({
  targets,
  sample,
}: {
  targets: TargetSummary[];
  sample: AgentifySampleDoc[];
}) {
  const [sources, setSources] = useState<CompileSource[]>([]);
  const [chosen, setChosen] = useState<string[]>(DEFAULT_TARGETS);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [selectedUnits, setSelectedUnits] = useState<string[] | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);

  const { result, status, run, reset } = useCompile();

  /*
   * Everything except the stubs, which is the five targets `docs/AGENTIFY.md` measures.
   *
   * Filtering on `tier === "firstClass"` would have been wrong and quietly so: the tier field
   * has three values, and `claude-commands` and `mcp-manifest` are `authored`. Both are real,
   * verified targets. The stubs exist so the registry can demonstrate that adding a vendor is
   * adding a file (ADR-0013), which is a claim about the architecture rather than an
   * invitation to compile against a profile whose vendor conventions nobody has checked.
   */
  const offered = useMemo(() => targets.filter((t) => t.tier !== "stub"), [targets]);

  const addSources = useCallback((incoming: CompileSource[]) => {
    setSources((current) => {
      const byPath = new Map(current.map((s) => [s.path, s]));
      for (const source of incoming) byPath.set(source.path, source);
      return [...byPath.values()];
    });
  }, []);

  const loadSample = useCallback(async () => {
    setLoadingSample(true);
    try {
      const loaded = await Promise.all(
        sample.map(async (doc) => {
          const response = await fetch(`/markforge/agentify-sample/${doc.file}`);
          return { path: doc.file, bytes: new Uint8Array(await response.arrayBuffer()) };
        }),
      );
      setSources(loaded);
    } finally {
      setLoadingSample(false);
    }
  }, [sample]);

  // Compile when the inputs change. The hook itself does not debounce (a compile is not a
  // keystroke-scale operation), but adding five files should not queue five runs, so the
  // effect coalesces them into one.
  useEffect(() => {
    if (sources.length === 0 || chosen.length === 0) return;
    const t = setTimeout(() => void run(sources, offered, chosen), 60);
    return () => clearTimeout(t);
  }, [sources, chosen, offered, run]);

  const files = useMemo(
    () => (result?.results ?? []).flatMap((r) => r.files.map((f) => ({ ...f, target: r.target }))),
    [result],
  );

  // Keep the open tab valid across recompiles, and open the first file when there is none.
  useEffect(() => {
    if (files.length === 0) {
      setActiveFile(null);
      return;
    }
    setActiveFile((current) =>
      current && files.some((f) => f.path === current) ? current : (files[0]?.path ?? null),
    );
  }, [files]);

  // A selection is a set of unit ids from a file that may no longer exist after a recompile.
  useEffect(() => setSelectedUnits(null), [activeFile]);

  const active = files.find((f) => f.path === activeFile);
  const manifestFiles = (result?.manifest.files ?? []) as unknown as ManifestFile[];
  const units = (result?.manifest.units ?? []) as unknown as ManifestUnit[];
  const busy = status.kind === "loading" || status.kind === "compiling" || loadingSample;

  if (sources.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-5 py-16 lg:px-8 lg:py-24">
        <Dropzone onSources={addSources} onSample={() => void loadSample()} busy={loadingSample} />
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
      <Summary
        result={result}
        status={status}
        sourceCount={sources.length}
        onRecompile={() => void run(sources, offered, chosen)}
        onClear={() => {
          setSources([]);
          reset();
        }}
        busy={busy}
      />

      {status.kind === "error" ? (
        <div role="alert" className="rule-b flex shrink-0 items-start gap-2 bg-danger-wash px-4 py-2.5">
          <Warning size={14} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-relaxed text-ink">{status.message}</p>
        </div>
      ) : null}

      <div className="grid min-h-0 grid-cols-1 lg:flex-1 lg:grid-cols-[264px_minmax(0,1fr)_300px]">
        <section className="rule-b flex flex-col overflow-y-auto lg:min-h-0 lg:border-b-0 lg:border-r lg:border-rule">
          <SourceList
            sources={sources}
            skipped={result?.skipped ?? []}
            onAdd={addSources}
            onSample={() => void loadSample()}
            busy={busy}
            onRemove={(path) => setSources((s) => s.filter((x) => x.path !== path))}
          />
          <TargetPicker targets={offered} chosen={chosen} onChange={setChosen} />
        </section>

        <section className="rule-b flex min-h-[520px] flex-col overflow-hidden bg-surface lg:min-h-0 lg:border-b-0">
          {files.length > 0 ? (
            <>
              <FileTabs files={files} active={activeFile} onSelect={setActiveFile} />
              {active ? (
                <FileView
                  key={active.path}
                  path={active.path}
                  content={active.content}
                  manifestFile={manifestFiles.find((f) => f.path === active.path)}
                  selected={selectedUnits}
                  onSelect={setSelectedUnits}
                />
              ) : null}
            </>
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <p className="max-w-[32ch] text-[13px] leading-relaxed text-ink-muted">
                {busy
                  ? "Compiling."
                  : chosen.length === 0
                    ? "Choose at least one target to compile."
                    : "Nothing was extracted from these documents."}
              </p>
            </div>
          )}
        </section>

        <section className="min-h-[280px] lg:min-h-0 lg:border-l lg:border-rule">
          <ProvenancePanel
            unitIds={selectedUnits}
            units={units}
            onClear={() => setSelectedUnits(null)}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * The run, in one line.
 *
 * Traceability is the number that matters and it is stated as a fraction of sentences rather
 * than as a bare percentage, because "100%" over four sentences and over four hundred are
 * different facts and a percentage hides which one you have.
 */
function Summary({
  result,
  status,
  sourceCount,
  onRecompile,
  onClear,
  busy,
}: {
  result: ReturnType<typeof useCompile>["result"];
  status: ReturnType<typeof useCompile>["status"];
  sourceCount: number;
  onRecompile: () => void;
  onClear: () => void;
  busy: boolean;
}) {
  const targets = result?.report.targets ?? [];
  const fileCount = targets.reduce((n, t) => n + t.files.length, 0);
  const traceability = targets.length
    ? Math.min(...targets.map((t) => t.traceability))
    : null;
  const conflicts = result?.report.conflicts ?? 0;

  return (
    <div className="rule-b flex h-14 shrink-0 items-center gap-4 overflow-x-auto bg-surface px-4">
      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="font-mono text-[15px] tabular-nums text-ink">{sourceCount}</span>
        <span className="text-[12px] text-ink-muted">
          document{sourceCount === 1 ? "" : "s"}
        </span>
      </div>

      <span className="text-ink-faint">/</span>

      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="font-mono text-[15px] tabular-nums text-ink">{fileCount}</span>
        <span className="text-[12px] text-ink-muted">file{fileCount === 1 ? "" : "s"}</span>
      </div>

      {traceability !== null ? (
        <>
          <span className="text-ink-faint">/</span>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <span
              className={cn(
                "font-mono text-[15px] tabular-nums",
                traceability >= 1 ? "text-accent" : "text-danger",
              )}
            >
              {(traceability * 100).toFixed(1)}%
            </span>
            <span className="text-[12px] text-ink-muted">traced</span>
          </div>
        </>
      ) : null}

      {conflicts > 0 ? (
        <>
          <span className="text-ink-faint">/</span>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <span className="font-mono text-[15px] tabular-nums text-danger">{conflicts}</span>
            <span className="text-[12px] text-ink-muted">
              conflict{conflicts === 1 ? "" : "s"}
            </span>
          </div>
        </>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {status.kind === "ok" ? (
          <span className="mr-1 hidden font-mono text-[11px] tabular-nums text-ink-faint sm:inline">
            {status.ms} ms
          </span>
        ) : null}
        <button
          type="button"
          onClick={onRecompile}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-panel px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink disabled:opacity-45"
        >
          <ArrowClockwise size={13} className={busy ? "animate-spin" : undefined} />
          {busy ? "Compiling" : "Recompile"}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-8 items-center gap-1.5 rounded-panel px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <Trash size={13} />
          Clear
        </button>
      </div>
    </div>
  );
}

function SourceList({
  sources,
  skipped,
  onAdd,
  onSample,
  busy,
  onRemove,
}: {
  sources: CompileSource[];
  skipped: { path: string; reason: string }[];
  onAdd: (s: CompileSource[]) => void;
  onSample: () => void;
  busy: boolean;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="rule-b p-3">
      <h2 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
        Sources
      </h2>
      <ul className="space-y-px">
        {sources.map((source) => (
          <li key={source.path} className="group flex items-center gap-2 rounded-chip px-1.5 py-1 hover:bg-sunken">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink" title={source.path}>
              {source.path}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
              {Math.max(1, Math.round(source.bytes.length / 1024))}K
            </span>
            <button
              type="button"
              onClick={() => onRemove(source.path)}
              aria-label={`Remove ${source.path}`}
              className="shrink-0 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>

      {skipped.length > 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {skipped.length} skipped as unreadable.
        </p>
      ) : null}

      <div className="mt-3">
        <Dropzone onSources={onAdd} onSample={onSample} busy={busy} compact />
      </div>
    </div>
  );
}

function TargetPicker({
  targets,
  chosen,
  onChange,
}: {
  targets: TargetSummary[];
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="p-3">
      <h2 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
        Targets
      </h2>
      <div className="space-y-px">
        {targets.map((target) => {
          const on = chosen.includes(target.id);
          return (
            <label
              key={target.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-chip px-1.5 py-1.5 hover:bg-sunken"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() =>
                  onChange(on ? chosen.filter((id) => id !== target.id) : [...chosen, target.id])
                }
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] leading-tight text-ink">
                  {target.displayName}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint">
                  {target.outputs.length === 1
                    ? target.outputs[0]?.path
                    : `${target.outputs.length} files`}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function FileTabs({
  files,
  active,
  onSelect,
}: {
  files: { path: string; target: string }[];
  active: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="rule-b flex h-9 shrink-0 items-stretch gap-px overflow-x-auto px-2">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          onClick={() => onSelect(file.path)}
          title={file.path}
          className={cn(
            "relative shrink-0 px-2.5 font-mono text-[11.5px] transition-colors",
            active === file.path ? "text-ink" : "text-ink-muted hover:text-ink",
          )}
        >
          {file.path.split("/").pop()}
          {active === file.path ? (
            <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-chip bg-accent" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
