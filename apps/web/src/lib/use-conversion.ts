"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Diagnostic, MarkForgeDocument } from "@markforge/ir";
import type { BrowserInputFormat, BrowserOutputFormat } from "@markforge/browser";
import { engine } from "@/lib/engine";
import {
  docxOverrides,
  htmlOverrides,
  markdownOverrides,
  type FlavorData,
  type Format,
  type OutputFormat,
  type Settings,
} from "@/lib/formats";
import type { PdfRenderer } from "@/lib/pdf";

export interface Source {
  name: string;
  from: Format;
  bytes: Uint8Array;
  /** Decoded text, for the formats the source pane can show. */
  text: string | null;
  /** Set when the document was read by /api/read rather than in this tab. */
  serverRead?: boolean;
  /**
   * Present only for a server-read source. The route returns the parsed and inferred
   * document, so this side of the pipeline has already happened and re-running it here is
   * both impossible (no reader) and wrong (it would infer twice).
   */
  document?: MarkForgeDocument;
  /** Diagnostics from that server-side parse and inference, carried forward. */
  diagnostics?: Diagnostic[];
}

export interface Conversion {
  bytes: Uint8Array;
  text: string | null;
  document: MarkForgeDocument;
  diagnostics: Diagnostic[];
  explanation: string | undefined;
  to: OutputFormat;
  /** Wall-clock milliseconds, rounded. Shown because it is small and people do not expect that. */
  ms: number;
}

export type Status =
  | { kind: "empty" }
  | { kind: "loading"; what: string }
  | { kind: "converting" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 220;

/**
 * One conversion, kept current with the inputs.
 *
 * The previous result stays on screen while a new one runs, so changing an option does not
 * blank the output pane and then refill it. Errors replace the status but not the result: a
 * document that failed to convert to PDF should still show the Markdown that worked.
 */
export function useConversion(
  source: Source | null,
  to: OutputFormat,
  settings: Settings,
  flavors: FlavorData,
  pdfRenderer: PdfRenderer | null,
) {
  const [result, setResult] = useState<Conversion | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "empty" });

  // Guards against an older conversion resolving after a newer one and overwriting it.
  const runId = useRef(0);

  const run = useCallback(async () => {
    if (!source) {
      setResult(null);
      setStatus({ kind: "empty" });
      return;
    }

    const id = ++runId.current;

    if (to === "pdf" && !pdfRenderer) {
      setStatus({ kind: "error", message: "needs-pdf-compiler" });
      return;
    }

    try {
      setStatus((s) => (s.kind === "ok" ? { kind: "converting" } : { kind: "loading", what: "engine" }));
      const mf = await engine();
      if (id !== runId.current) return;

      setStatus({ kind: "converting" });
      const started = performance.now();

      const md = markdownOverrides(flavors, settings.markdown);
      const html = htmlOverrides(settings.html);
      const docx = docxOverrides(settings.docx);

      const renderOptions = {
        ...(Object.keys(md).length ? { markdown: md } : {}),
        ...(Object.keys(html).length ? { html } : {}),
        ...(Object.keys(docx).length ? { docx } : {}),
        ...(pdfRenderer ? { pdf: { render: pdfRenderer } } : {}),
      };

      let out: {
        bytes: Uint8Array;
        document: MarkForgeDocument;
        diagnostics: Diagnostic[];
        explanation?: string | undefined;
      };

      if (source.document) {
        // Already parsed and inferred by /api/read. Only the render half runs here, through
        // the same bundle every other conversion uses, so the output bytes are the CLI's.
        const rendered = await mf.render(source.document, to, renderOptions);
        out = {
          bytes: rendered.bytes,
          document: source.document,
          diagnostics: [...(source.diagnostics ?? []), ...rendered.diagnostics.all()],
        };
      } else {
        out = await mf.convertInBrowser(source.bytes, {
          from: source.from as BrowserInputFormat,
          to: to as BrowserOutputFormat,
          path: source.name,
          explain: true,
          ...(settings.infer ? {} : { infer: false as const }),
          ...renderOptions,
        });
      }

      if (id !== runId.current) return;

      const isText = to === "md" || to === "html";
      setResult({
        bytes: out.bytes,
        text: isText ? new TextDecoder().decode(out.bytes) : null,
        document: out.document,
        diagnostics: out.diagnostics,
        explanation: out.explanation,
        to,
        ms: Math.round(performance.now() - started),
      });
      setStatus({ kind: "ok" });
    } catch (e) {
      if (id !== runId.current) return;
      // The engine refuses by name for unsupported combinations, and those messages are
      // written for a person. Passing them through beats replacing them with "failed".
      setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [source, to, settings, flavors, pdfRenderer]);

  useEffect(() => {
    const t = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [run]);

  return { result, status, rerun: run };
}

/** `lossy` is not the same as `severity`, and the rail sorts on both. */
export function lossyCount(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.lossy || d.severity === "error").length;
}
