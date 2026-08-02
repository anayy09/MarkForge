"use client";

import { useEffect, useState } from "react";
import { Chip } from "@/components/ui/primitives";
import { engine } from "@/lib/engine";
import { effectiveMarkdown, type FlavorData } from "@/lib/formats";
import type { Source } from "@/lib/use-conversion";
import { cn } from "@/lib/cn";

/**
 * All seven flavours, rendered from one document.
 *
 * The build gates on these being byte-distinct, because for five phases `markdown.flavor`
 * was in the config schema, generated into the types, and read by nothing: asking for
 * CommonMark silently produced GFM. That is worse than an unbuilt option, since an unbuilt
 * option is absent and this one was advertised. The gate proves seven different outputs
 * exist; this shows them, so the claim is inspectable rather than merely enforced.
 */

interface Rendered {
  id: string;
  displayName: string;
  reference: string;
  text: string;
  bytes: number;
  error?: string;
}

export function FlavorsPanel({ source, flavors }: { source: Source | null; flavors: FlavorData }) {
  const [rows, setRows] = useState<Rendered[] | null>(null);
  const [selected, setSelected] = useState<string>(flavors.defaults.flavor);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setRows(null);
      return;
    }
    let live = true;
    setRows(null);
    setError(null);

    void (async () => {
      try {
        const mf = await engine();
        const out: Rendered[] = [];
        for (const preset of flavors.presets) {
          // Only the flavour differs. Sending the resolved spelling options too would pin
          // them and defeat the very preset being demonstrated.
          const r = await mf.convertInBrowser(source.bytes, {
            from: source.from as "md" | "docx" | "html",
            to: "md",
            path: source.name,
            markdown: { flavor: preset.id },
          });
          const text = new TextDecoder().decode(r.bytes);
          out.push({
            id: preset.id,
            displayName: preset.displayName,
            reference: preset.reference,
            text,
            bytes: r.bytes.length,
          });
        }
        if (live) setRows(out);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [source, flavors]);

  if (!source) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-[38ch] text-center text-[13px] leading-relaxed text-ink-muted">
          Load a document to render it through all seven Markdown flavours at once.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-0 flex-1 px-6 py-8">
        <p className="max-w-prose text-[12px] leading-relaxed text-ink-muted">{error}</p>
      </div>
    );
  }

  // How many produced output nobody else did. On a construct-dense document this is seven.
  const distinct = rows ? new Set(rows.map((r) => r.text)).size : 0;
  const current = rows?.find((r) => r.id === selected) ?? rows?.[0];
  const baseline = rows?.find((r) => r.id === flavors.defaults.flavor);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-3">
        {flavors.presets.map((p) => {
          const row = rows?.find((r) => r.id === p.id);
          const same = row && baseline && row.id !== baseline.id && row.text === baseline.text;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              title={p.displayName}
              className={cn(
                "shrink-0 rounded-chip px-2 py-1 font-mono text-[11px] transition-colors",
                selected === p.id ? "bg-ember-wash text-ember" : "text-ink-muted hover:bg-sunken",
                same && "line-through decoration-ink-faint",
              )}
            >
              {p.id}
            </button>
          );
        })}
        {rows ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
            {distinct} of {rows.length} distinct
          </span>
        ) : null}
      </header>

      {!rows ? (
        <div className="min-h-0 flex-1 space-y-2.5 p-3" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-3 animate-pulse rounded-chip bg-sunken" style={{ width: `${40 + ((i * 17) % 55)}%` }} />
          ))}
        </div>
      ) : current ? (
        <>
          <div className="rule-b flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="text-[12px] font-medium text-ink">{current.displayName}</span>
            <Chip mono tone="quiet">
              {current.bytes} B
            </Chip>
            {baseline && current.id !== baseline.id ? (
              current.text === baseline.text ? (
                <Chip tone="neutral">identical to {baseline.id}</Chip>
              ) : (
                <Chip tone="accent">differs from {baseline.id}</Chip>
              )
            ) : null}
            <a
              href={current.reference}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-auto text-[11px] text-ink-muted underline underline-offset-4 transition-colors hover:text-ember"
            >
              Specification
            </a>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed text-ink">
            {current.text}
          </pre>
        </>
      ) : null}
    </div>
  );
}
