"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { Diagnostic, MarkForgeDocument } from "@markforge/ir";
import { Button } from "@/components/ui/primitives";
import { FORMATS, formatFromName } from "@/lib/formats";
import type { Source } from "@/lib/use-conversion";

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The upload confirmation, which is the whole point of having one.
 *
 * Every other converter on the web uploads first and explains in a privacy policy. Here the
 * default is that nothing leaves the tab, so the exception has to be a decision the user
 * makes rather than a footnote they could have read. The dialog names the format, the reason
 * the browser cannot read it, exactly what is sent, and what is kept, before anything moves.
 *
 * Nothing is sent until the button is pressed. The file sits in memory in this component.
 */
export function ServerReadDialog({
  file,
  onCancel,
  onDone,
}: {
  file: File;
  onCancel: () => void;
  onDone: (source: Source) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const from = formatFromName(file.name);
  const info = from ? FORMATS[from] : undefined;
  const tooBig = file.size > MAX_BYTES;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const send = async () => {
    if (!from) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await fetch(
        `/api/read?from=${from}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: bytes },
      );
      const payload = (await res.json()) as {
        error?: string;
        document?: MarkForgeDocument;
        diagnostics?: Diagnostic[];
      };
      if (!res.ok || !payload.document) {
        throw new Error(payload.error ?? `The server responded ${res.status}.`);
      }

      // The document is already parsed and inferred. The workbench renders it from here on,
      // through the same bundle every other conversion uses.
      onDone({
        name: file.name,
        from,
        bytes,
        text: null,
        serverRead: true,
        document: payload.document,
        diagnostics: payload.diagnostics ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="server-read-title"
      className="fixed inset-0 z-40 grid place-items-center bg-ink/25 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-lg rounded-panel border border-rule bg-surface p-6 shadow-[0_24px_60px_-12px_rgb(var(--shadow-tint)/0.22)]">
        <h2 id="server-read-title" className="text-[15px] font-medium text-ink">
          {info?.label ?? "This format"} has to be read on the server.
        </h2>

        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{info?.readNote}</p>

        <dl className="mt-5 space-y-2.5">
          <Line k="Sent" v={`${file.name}, ${file.size.toLocaleString("en-US")} bytes`} />
          <Line k="Kept" v="Nothing. No cache, no temporary file, no log holding the body." />
          <Line
            k="Returned"
            v="The parsed document tree. Every conversion after this runs in this tab again."
          />
          <Line k="Models" v="None. No surface but the command line can reach one." />
        </dl>

        {tooBig ? (
          <p className="mt-5 rounded-panel bg-ember-wash px-3 py-2.5 text-[12px] leading-relaxed text-ink">
            This file is over the 4 MB the hosting platform accepts in one request. The command
            line has no such cap, and neither does a self-hosted{" "}
            <span className="font-mono">markforge serve</span>.
          </p>
        ) : null}

        {error ? (
          <p className="mt-5 rounded-panel bg-danger-wash px-3 py-2.5 text-[12px] leading-relaxed text-ink">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center gap-2">
          <Button variant="primary" disabled={busy || tooBig || !from} onClick={() => void send()}>
            {busy ? "Reading" : "Send it"}
            {!busy ? <ArrowUpRight size={13} /> : null}
          </Button>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-baseline gap-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{k}</dt>
      <dd className="text-[12px] leading-relaxed text-ink">{v}</dd>
    </div>
  );
}
