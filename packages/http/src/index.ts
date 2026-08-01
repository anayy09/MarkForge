/**
 * @markforge/http — the stateless HTTP API of SPEC §8.
 *
 * ## Statelessness is the product, not a detail
 *
 * SPEC §8 says "stateless, no document retention", and ADR-0015 rejected a server-side
 * fallback for the browser's heavy paths on the grounds that silently transmitting a
 * user's document inverts ADR-0009. Both are privacy claims, and a privacy claim that
 * is merely asserted is worth nothing — so this module is written to make the claim
 * *checkable* rather than to make it true by intention:
 *
 * - **`ROUTES` is exported.** The whole route table is one array, so a gate can assert
 *   there is no `GET /:id` — no route that could address a previous request's content.
 *   A retention bug that added one would have to add it here, in public.
 * - **Nothing is written and nothing is kept.** No cache, no temp file, no request log
 *   holding bodies. `scripts/check-http-retention.mjs` hashes the entire filesystem tree
 *   under the server's working directory before and after a batch of requests and fails
 *   on any delta, with a negative control that deliberately caches.
 * - **No id is minted.** A response carries no handle that could be exchanged for the
 *   document later, because there is nothing to exchange it for.
 *
 * ## No LLM, and not by default — at all
 *
 * `--no-llm` is the default on every surface. Here it is stronger than a default: this
 * package does not depend on `@markforge/llm` and has no code path that reaches a model.
 * A hosted converter that could phone a model on a user's document is the thing ADR-0009
 * exists to prevent, and the dependency rule in SPEC §11 is what stops this surface
 * becoming the loophole. `convert()` from `@markforge/core` takes an optional `assist`,
 * and this module never populates it.
 *
 * ## No framework
 *
 * `node:http` only. A router for two routes would be a dependency bought with a one-line
 * justification nobody could write.
 */
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { convert, formatFromPath, isOutputFormat, type Format } from "@markforge/core";
import type { Diagnostic } from "@markforge/ir";

/**
 * The complete route table.
 *
 * Exported so the no-retention gate can assert on it rather than on prose. Two entries,
 * both of which take everything they need from the request: there is deliberately no
 * route shaped `GET /something/:id`, because such a route could only exist if something
 * had been kept.
 */
export const ROUTES = [
  { method: "POST", path: "/convert", description: "Convert a document. Body is the input bytes." },
  { method: "GET", path: "/health", description: "Liveness and the formats this build supports." },
] as const;

/** Default cap on a request body. Refused before it is read into memory, not after. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ServerOptions {
  /** Cap on request body size. A larger body is refused with 413. */
  maxBodyBytes?: number;
  /**
   * Origins permitted by CORS. Empty (the default) sends no CORS headers at all, which
   * is what a local `markforge serve` wants: a browser page on another origin should not
   * be able to post a user's document to a server running on their machine.
   */
  allowedOrigins?: readonly string[];
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Formats readable as input. Mirrors `@markforge/core`'s `Format` minus nothing. */
const INPUT_FORMATS: readonly Format[] = ["md", "docx", "html", "pptx", "xlsx", "pdf"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads the request body with the cap enforced *during* the read.
 *
 * Checking `content-length` alone would be a cap a client controls: a chunked request
 * can omit the header, and a lying header is not a promise. The running total is what
 * actually bounds memory, and the header check just fails the obvious case earlier.
 */
async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    throw new HttpError(413, `body of ${declared} bytes exceeds the ${max}-byte limit`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) throw new HttpError(413, `body exceeds the ${max}-byte limit`);
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function parseFormat(value: string | null, what: string): Format {
  if (!value) throw new HttpError(400, `missing ${what}`);
  if (!(INPUT_FORMATS as readonly string[]).includes(value)) {
    throw new HttpError(400, `unknown ${what} "${value}" — expected one of ${INPUT_FORMATS.join(", ")}`);
  }
  return value as Format;
}

interface ConvertResponse {
  bytes: Uint8Array;
  diagnostics: Diagnostic[];
  from: Format;
  to: Format;
}

async function handleConvert(
  req: IncomingMessage,
  url: URL,
  options: Required<Pick<ServerOptions, "maxBodyBytes">>,
): Promise<ConvertResponse> {
  const body = await readBody(req, options.maxBodyBytes);
  if (body.length === 0) throw new HttpError(400, "empty body — POST the document bytes");

  // `from` may be inferred from a supplied filename, exactly as the CLI infers it from a
  // path. The filename is used for that and for provenance and is never used to open
  // anything: this surface has no filesystem access to a caller-supplied path, which is
  // the property that keeps a crafted `../` harmless rather than merely unlikely.
  const filename = url.searchParams.get("filename");
  const fromParam = url.searchParams.get("from") ?? (filename ? (formatFromPath(filename) ?? null) : null);
  const from = parseFormat(fromParam, "`from` (or a `filename` it can be inferred from)");
  const to = parseFormat(url.searchParams.get("to"), "`to`");

  if (!isOutputFormat(to)) {
    throw new HttpError(400, `${to} is an input format only — it has no renderer (OPEN_QUESTIONS §7f)`);
  }

  try {
    // No `assist`. This surface has no LLM path; see the module comment.
    const result = await convert(body, { from, to, ...(filename ? { path: filename } : {}) });
    return { bytes: result.bytes, diagnostics: result.diagnostics, from, to };
  // degradation: rethrows
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Creates the server. Does not listen — the caller decides the port, so tests can bind
 * to an ephemeral one and `markforge serve` can report what it got.
 */
export function createServer(options: ServerOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = options.allowedOrigins ?? [];

  return createNodeServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }

      try {
        if (req.method === "GET" && url.pathname === "/health") {
          send(res, 200, "application/json; charset=utf-8", Buffer.from(
            JSON.stringify({
              ok: true,
              // Stated in the payload rather than only in documentation, so a client can
              // see that this deployment retains nothing without taking anyone's word.
              stateless: true,
              documentRetention: "none",
              llm: "unavailable on this surface",
              inputFormats: INPUT_FORMATS,
              outputFormats: INPUT_FORMATS.filter(isOutputFormat),
              routes: ROUTES,
            }, null, 2)
          ));
          return;
        }

        if (req.method === "POST" && url.pathname === "/convert") {
          const result = await handleConvert(req, url, { maxBodyBytes });
          const lossy = result.diagnostics.filter((d) => d.severity === "error" || d.lossy);

          // Diagnostics ride in headers so the body stays exactly the bytes the CLI would
          // have written — that is what makes four-surface byte parity checkable at all.
          // `?json=1` returns the envelope instead, for a client that wants both.
          if (url.searchParams.get("json") === "1") {
            send(res, 200, "application/json; charset=utf-8", Buffer.from(
              JSON.stringify({
                from: result.from,
                to: result.to,
                bytes: Buffer.from(result.bytes).toString("base64"),
                diagnostics: result.diagnostics,
                lossy: lossy.length > 0,
              })
            ));
            return;
          }

          res.setHeader("X-MarkForge-Diagnostics", String(result.diagnostics.length));
          res.setHeader("X-MarkForge-Lossy", lossy.length > 0 ? "true" : "false");
          send(res, 200, CONTENT_TYPES[result.to] ?? "application/octet-stream", Buffer.from(result.bytes));
          return;
        }

        // Unknown route. The message lists the whole table, because the table being
        // short is the point.
        throw new HttpError(
          404,
          `no route ${req.method} ${url.pathname}. This API has exactly two: ` +
            ROUTES.map((r) => `${r.method} ${r.path}`).join(", ")
        );
      // degradation: benign — the request handler converts any throw into an HTTP status and a JSON body, which is the surface a client reads
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        const message = e instanceof Error ? e.message : String(e);
        send(res, status, "application/json; charset=utf-8", Buffer.from(
          JSON.stringify({ error: message, status })
        ));
      }
    })();
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(body.length));
  // Nothing here is cacheable by anyone: the response is derived from a body we do not
  // keep, and an intermediary storing it would reintroduce the retention this surface
  // exists without.
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}
