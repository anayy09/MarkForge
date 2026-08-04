"use client";

import { ArrowUUpLeft, FileText } from "@phosphor-icons/react";
import { Chip } from "@/components/ui/primitives";

export interface ManifestUnit {
  id: string;
  category: string;
  text: string;
  rationale?: string;
  sources: { path: string; nodeIds: string[] }[];
  conflictsWith?: string[];
}

/**
 * Where a sentence came from.
 *
 * The acceptance criterion for this whole feature is that every generated sentence traces
 * back to a source document, and until now that was a number in a report. This panel is the
 * number made checkable by a person: pick any sentence in the output, see the document it
 * came from, the category the extractor filed it under, and the exact text it was derived
 * from. A claim of 100% traceability that a user cannot inspect is a claim they have to take
 * on faith.
 */
export function ProvenancePanel({
  unitIds,
  units,
  onClear,
}: {
  unitIds: string[] | null;
  units: ManifestUnit[];
  onClear: () => void;
}) {
  if (unitIds === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <FileText size={22} weight="light" className="text-ink-faint" />
        <p className="mt-3 max-w-[26ch] text-[13px] leading-relaxed text-ink-muted">
          Click any underlined sentence in the output to see the document it came from.
        </p>
      </div>
    );
  }

  const selected = unitIds
    .map((id) => units.find((u) => u.id === id))
    .filter((u): u is ManifestUnit => u !== undefined);

  return (
    <div className="flex h-full flex-col">
      <div className="rule-b flex h-10 shrink-0 items-center px-3">
        <span className="text-[12px] font-medium text-ink">
          {selected.length === 1 ? "Source" : `${selected.length} sources`}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-chip px-2 text-[12px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <ArrowUUpLeft size={12} />
          Clear
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-3 py-4">
        {selected.map((unit) => (
          <div key={unit.id}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="accent" mono>
                {unit.category}
              </Chip>
              {unit.conflictsWith?.length ? (
                <Chip tone="danger" mono>
                  conflicts with {unit.conflictsWith.length}
                </Chip>
              ) : null}
            </div>

            {unit.sources.map((source) => (
              <div key={source.path} className="mt-2.5">
                <div className="flex items-baseline gap-1.5">
                  <FileText size={12} className="shrink-0 translate-y-0.5 text-ink-faint" />
                  <span className="break-all font-mono text-[11.5px] text-ink">{source.path}</span>
                </div>
                {/*
                 * The node ids are the IR nodes the sentence was extracted from. They look
                 * like noise until the moment someone is trying to work out why a line ended
                 * up in their CLAUDE.md, and then they are the only thing that answers it.
                 */}
                {source.nodeIds.length > 0 ? (
                  <p className="mt-1 pl-[18px] font-mono text-[10.5px] leading-relaxed text-ink-faint">
                    {source.nodeIds.slice(0, 3).join(", ")}
                    {source.nodeIds.length > 3 ? `, +${source.nodeIds.length - 3}` : ""}
                  </p>
                ) : null}
              </div>
            ))}

            <blockquote className="mt-3 border-l-2 border-rule-strong pl-3 text-[13px] leading-relaxed text-ink-muted">
              {unit.text}
            </blockquote>

            {unit.rationale ? (
              <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">{unit.rationale}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
