import { parse, type Format } from "@markforge/core";
import { inferAll } from "@markforge/infer";
import { DiagnosticBag, DiagnosticCode, type Diagnostic } from "@markforge/ir";

/**
 * The one thing the browser cannot do: read a PDF, a PPTX or an XLSX.
 *
 * `@markforge/browser` refuses all three by name. PDF because the pdf.js adapter still
 * reaches for `node:module`, `node:path` and `node:zlib`; PPTX and XLSX because ADR-0015
 * keeps them out of the eager chunk on size grounds, which is a decision recorded in one
 * array rather than an accident of bundling.
 *
 * ## Why this returns the IR and not rendered bytes
 *
 * `convert` in `@markforge/core` is parse, then infer, then render. This route does the
 * first two and hands the document back, so the client can call `render` from the bundle
 * that surface parity was measured on. Rendering here would introduce a fourth renderer
 * nothing measures, and it could not produce a PDF at all without the Typst NAPI binding
 * this app deliberately does not carry.
 *
 * ## What this route does not do
 *
 * It writes nothing, keeps nothing, and mints no id. There is no route that could return a
 * previous request's document, because there is nothing to return. That is the same property
 * `@markforge/http` makes checkable by exporting its whole route table, and it holds here for
 * the same reason: this file is the whole server.
 *
 * It also has no `assist`. No model, no OCR. A scanned PDF therefore refuses by name rather
 * than returning an empty document that would score as a perfect conversion of nothing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel refuses a request body above 4.5 MB before any of this runs. Stated, not discovered. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SERVER_ONLY: readonly Format[] = ["pdf", "pptx", "xlsx"];

const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const filename = url.searchParams.get("filename") ?? `document.${from}`;

  if (!(SERVER_ONLY as readonly string[]).includes(from)) {
    return fail(
      400,
      `markforge: ${from || "that format"} is read in your browser, not here. This route exists ` +
        `only for ${SERVER_ONLY.join(", ")}.`,
    );
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) return fail(400, "Empty body. POST the document bytes.");
  if (body.length > MAX_BODY_BYTES) {
    return fail(
      413,
      `That file is ${body.length.toLocaleString("en-US")} bytes and the limit here is ` +
        `${MAX_BODY_BYTES.toLocaleString("en-US")}. Use the command line for anything larger; ` +
        `it has no such cap.`,
    );
  }

  try {
    // The reader is a platform capability rather than an opt-in, which is the same reasoning
    // the CLI records for its own. Imported dynamically so a PPTX request never loads pdf.js.
    const assist =
      from === "pdf"
        ? {
            readPdf: async (bytes: Uint8Array, options: { path?: string }) =>
              (await import("@markforge/adapters-pdf")).readPdf(bytes, options),
          }
        : undefined;

    const parsed = await parse(body, from as Format, filename, assist);
    const inferred = inferAll(parsed.document, {});

    const diagnostics: Diagnostic[] = [
      ...parsed.diagnostics.all(),
      ...inferred.diagnostics.all(),
      ...ambiguityNotice(inferred.ambiguous.length),
    ];
    parsed.document.diagnostics = diagnostics;

    return Response.json(
      { document: parsed.document, diagnostics },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // The engine refuses by name, and those messages are written for a person: a scan with no
    // recogniser, an encrypted PDF, a corrupt container. 422 rather than 500, because the
    // request was fine and the document was not.
    return fail(422, e instanceof Error ? e.message : String(e));
  }
}

/**
 * The diagnostic `convert` emits when headings were too close to call and nothing broke the tie.
 *
 * Reproduced here rather than skipped. Leaving it out would mean a PDF read on the server
 * carried one fewer diagnostic than the same document read anywhere else, which is a
 * difference in what the tool tells you about your document, not an implementation detail.
 */
function ambiguityNotice(count: number): Diagnostic[] {
  if (count === 0) return [];
  const bag = new DiagnosticBag({ kind: "rule", name: "@markforge/web", version: "0.1.0" });
  bag.info(
    DiagnosticCode.LLM_DISABLED_AMBIGUITY_STANDS,
    `${count} heading decision(s) were too close to call and the highest-scoring candidate ` +
      `was used. No surface but the command line can reach a model, so there was no ` +
      `tie-breaker here and there is no setting that would add one.`,
  );
  return bag.all();
}
