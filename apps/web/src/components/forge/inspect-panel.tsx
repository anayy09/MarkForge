"use client";

import { useMemo, useState } from "react";
import { CaretRight, DownloadSimple } from "@phosphor-icons/react";
import type { MarkForgeDocument, Producer, Provenance, StyleEvidence } from "@markforge/ir";
import { Chip } from "@/components/ui/primitives";
import type { Conversion } from "@/lib/use-conversion";
import { cn } from "@/lib/cn";

/**
 * The intermediate representation, which is the actual product.
 *
 * Both formats in a conversion are views of this tree, and everything the project claims
 * about provenance is a property of it: every node records what produced it, and style
 * evidence sits in a side table keyed by node id rather than on the node, so a plugin that
 * rebuilt the tree could not silently drop it. None of that is visible from the output alone.
 */

interface TreeNode {
  type: string;
  id?: string;
  contentHash?: string;
  children?: TreeNode[];
  value?: string;
  [key: string]: unknown;
}

const PRODUCER_TONE = {
  adapter: "neutral",
  rule: "neutral",
  model: "accent",
  ocr: "accent",
} as const;

/**
 * `Producer` is a discriminated union and the identifying field is named differently in each
 * arm: `name` for an adapter or a rule, `model` for a model, `engine` for OCR. That is a
 * schema decision worth keeping, because "which model" and "which adapter" are not the same
 * question, and it means this cannot be one property access.
 */
function producerName(p: Producer): string {
  switch (p.kind) {
    case "model":
      return `${p.model} / prompt ${p.promptVersion}`;
    case "ocr":
      return `${p.engine} ${p.version}`;
    default:
      return p.name;
  }
}

export function InspectPanel({ result }: { result: Conversion | null }) {
  if (!result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-[36ch] text-center text-[13px] leading-relaxed text-ink-muted">
          Load a document. Both formats in a conversion are views of one tree, and this is the
          tree.
        </p>
      </div>
    );
  }
  return <Tree doc={result.document} />;
}

function Tree({ doc }: { doc: MarkForgeDocument }) {
  const [selected, setSelected] = useState<string | null>(null);

  const census = useMemo(() => {
    const counts = new Map<string, number>();
    const walk = (n: TreeNode) => {
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
      for (const c of n.children ?? []) walk(c);
    };
    walk(doc.body as unknown as TreeNode);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [doc]);

  const provenance = doc.provenance as unknown as Record<string, Provenance> | undefined;
  const sidecar = doc.sidecar as unknown as Record<string, StyleEvidence> | undefined;

  const download = () => {
    // Canonical JSON is the engine's own concern; this is a readable copy for a human.
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.id}.mfir.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-9 shrink-0 items-center gap-2 overflow-x-auto px-3">
        <Chip mono tone="quiet">
          ir v{doc.irVersion}
        </Chip>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
          {census.reduce((n, [, c]) => n + c, 0)} nodes
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
          {census.length} types
        </span>
        {doc.furniture.length > 0 ? (
          <Chip mono tone="neutral">
            {doc.furniture.length} furniture
          </Chip>
        ) : null}
        <button
          type="button"
          onClick={download}
          className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-chip px-2 text-[11px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <DownloadSimple size={12} />
          .mfir.json
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-h-0 overflow-auto p-2">
          <Branch
            node={doc.body as unknown as TreeNode}
            depth={0}
            selected={selected}
            onSelect={setSelected}
            provenance={provenance}
          />
        </div>

        <aside className="rule-t min-h-0 overflow-y-auto p-3 xl:border-l xl:border-t-0 xl:border-rule">
          {selected ? (
            <NodeDetail
              id={selected}
              provenance={provenance?.[selected]}
              evidence={sidecar?.[selected]}
            />
          ) : (
            <Census census={census} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Branch({
  node,
  depth,
  selected,
  onSelect,
  provenance,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  provenance: Record<string, Provenance> | undefined;
}) {
  // Deep trees collapse below the first two levels, or a long document opens as a wall.
  const [open, setOpen] = useState(depth < 2);
  const children = node.children ?? [];
  const producer = node.id ? provenance?.[node.id]?.producedBy.kind : undefined;
  const isSelected = node.id !== undefined && node.id === selected;

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-chip py-0.5 pr-1.5",
          isSelected ? "bg-ember-wash" : "hover:bg-sunken",
        )}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse" : "Expand"}
            className="grid h-4 w-4 shrink-0 place-items-center text-ink-faint"
          >
            <CaretRight size={9} className={cn("transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => node.id && onSelect(node.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="shrink-0 font-mono text-[11px] text-ink">{node.type}</span>
          {producer && producer !== "adapter" ? (
            <Chip tone={PRODUCER_TONE[producer as keyof typeof PRODUCER_TONE] ?? "neutral"}>
              {producer}
            </Chip>
          ) : null}
          {typeof node.value === "string" && node.value.trim() ? (
            <span className="truncate text-[11px] text-ink-muted">{node.value}</span>
          ) : null}
          {children.length > 0 ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
              {children.length}
            </span>
          ) : null}
        </button>
      </div>

      {open
        ? children.map((c, i) => (
            <Branch
              key={c.id ?? `${c.type}-${i}`}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              provenance={provenance}
            />
          ))
        : null}
    </div>
  );
}

function Census({ census }: { census: [string, number][] }) {
  const max = census[0]?.[1] ?? 1;
  return (
    <div>
      <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        Node types
      </h3>
      <ul className="space-y-1.5">
        {census.map(([type, count]) => (
          <li key={type} className="flex items-baseline gap-2">
            <span className="w-3/5 truncate font-mono text-[11px] text-ink">{type}</span>
            {/* A bar with no track: the comparison is between rows, not against a maximum. */}
            <span
              aria-hidden
              className="h-px bg-rule-strong"
              style={{ width: `${Math.max(4, (count / max) * 30)}%` }}
            />
            <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-muted">
              {count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeDetail({
  id,
  provenance,
  evidence,
}: {
  id: string;
  provenance: Provenance | undefined;
  evidence: StyleEvidence | undefined;
}) {
  return (
    <div className="space-y-4">
      <Field label="Node id">
        {/* Content-addressed: a bottom-up hash of type, salient attributes and child ids. */}
        <span className="break-all font-mono text-[11px] text-ink">{id}</span>
      </Field>

      {provenance ? (
        <>
          <Field label="Produced by">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip
                mono
                tone={PRODUCER_TONE[provenance.producedBy.kind as keyof typeof PRODUCER_TONE] ?? "neutral"}
              >
                {provenance.producedBy.kind}
              </Chip>
              <span className="font-mono text-[11px] text-ink-muted">
                {producerName(provenance.producedBy)}
              </span>
            </div>
          </Field>
          <Field label="Locator">
            <span className="break-all font-mono text-[11px] text-ink-muted">
              {provenance.locator.kind}
              {": "}
              {JSON.stringify(provenance.locator).slice(0, 160)}
            </span>
          </Field>
          {provenance.confidence !== undefined ? (
            <Field label="Confidence">
              <span className="font-mono text-[11px] tabular-nums text-ink">
                {provenance.confidence}
              </span>
              <p className="mt-1 text-[10px] leading-snug text-ink-faint">
                Monotonic, not a probability. Higher means more evidence, and the number has no
                calibration behind it.
              </p>
            </Field>
          ) : null}
        </>
      ) : null}

      {evidence ? (
        <Field label="Style evidence">
          <dl className="space-y-1">
            {evidence.sourceStyleName ? (
              <Row k="style" v={evidence.sourceStyleName} />
            ) : null}
            {evidence.outlineLevel !== undefined ? (
              <Row k="outline" v={String(evidence.outlineLevel)} />
            ) : null}
            {evidence.font?.family ? <Row k="font" v={evidence.font.family} /> : null}
            {evidence.font?.sizePt !== undefined ? (
              <Row k="size" v={`${evidence.font.sizePt} pt`} />
            ) : null}
            {evidence.font?.weight !== undefined ? (
              <Row k="weight" v={String(evidence.font.weight)} />
            ) : null}
          </dl>
          <p className="mt-2 text-[10px] leading-snug text-ink-faint">
            Recorded, not acted on. The reader records what the document said; inference is the
            separate step that decides what it meant.
          </p>
        </Field>
      ) : null}

      {!provenance && !evidence ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          No provenance or style evidence for this node. Nodes created by a renderer carry
          neither, because neither came from a source document.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[11px] text-ink-muted">{k}</dt>
      <dd className="truncate font-mono text-[11px] text-ink">{v}</dd>
    </div>
  );
}
