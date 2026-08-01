/**
 * @markforge/mcp — the MCP server of SPEC §8.
 *
 * "So coding agents can call the converter at runtime. This closes the loop: the agent
 * that consumes `CLAUDE.md` can also generate it." The `agentify` tool is that sentence;
 * `convert` and `fmt` are here because an agent generating context files should be able to
 * read the documents they come from.
 *
 * Transport is stdio with newline-delimited JSON-RPC. Two consequences worth stating
 * because they are easy to get wrong and hard to notice:
 *
 *   - **Nothing may be written to stdout except protocol messages.** A stray `console.log`
 *     corrupts the stream and the client sees a parse error rather than the message that
 *     caused it. Every diagnostic here goes to stderr, which is the same rule SPEC §8
 *     already imposes on the CLI's `--json` mode.
 *   - **A notification gets no response.** JSON-RPC distinguishes them by the absence of
 *     `id`, and replying to one is a protocol violation rather than a harmless extra.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  err,
  ok,
  toolError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import { TOOLS, callTool, type ToolContext } from "./tools.js";

export { TOOLS, callTool, resolveInRoot, type ToolContext } from "./tools.js";
export { PROTOCOL_VERSION, type ToolDefinition, type ToolResult } from "./protocol.js";

export const SERVER_INFO = { name: "markforge", version: "0.1.0" } as const;

/**
 * Handles one request and returns the response, or `null` for a notification.
 *
 * Separated from the transport so it is testable without a pipe — the protocol is the
 * part with edge cases, and driving it through stdio to test them would make every
 * assertion a timing question.
 */
export async function handleRequest(
  request: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  switch (request.method) {
    case "initialize": {
      const asked = request.params?.["protocolVersion"];
      // Answer with our version rather than echoing theirs. Echoing an unknown version
      // would claim conformance to a revision this file has never seen; the client can
      // compare and decide, which is what negotiation is for.
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        ...(typeof asked === "string" && asked !== PROTOCOL_VERSION
          ? { instructions: `This server implements MCP ${PROTOCOL_VERSION}; the client asked for ${asked}.` }
          : {}),
      });
    }

    case "notifications/initialized":
      return null;

    case "ping":
      return isNotification ? null : ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = request.params?.["name"];
      if (typeof name !== "string") return err(id, ErrorCode.InvalidParams, "`name` is required");
      const args = (request.params?.["arguments"] ?? {}) as Record<string, unknown>;
      try {
        return ok(id, await callTool(name, args, ctx));
      // degradation: benign — a tool throw becomes a tool result with isError, which is how MCP reports a tool failure as distinct from a protocol one
      } catch (e) {
        // A tool throwing is a *tool* failure, not a protocol failure: the client gets a
        // successful RPC carrying `isError`, so it can show the model what went wrong
        // instead of treating the server as broken.
        return ok(id, toolError(e instanceof Error ? e.message : String(e)));
      }
    }

    default:
      if (isNotification) return null;
      return err(id, ErrorCode.MethodNotFound, `unknown method "${request.method}"`);
  }
}

export interface ServeOptions extends ToolContext {
  input?: Readable;
  output?: Writable;
  /** Where human-readable notices go. Never stdout — that carries the protocol. */
  log?: Writable;
}

/** Runs the server over a stdio-shaped pair of streams until the input closes. */
export async function serve(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ctx: ToolContext = {
    root: options.root,
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
  };

  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === "") continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    // degradation: benign — a malformed line becomes a ParseError response and the session continues, asserted in mcp.test.ts
    } catch {
      output.write(JSON.stringify(err(null, ErrorCode.ParseError, "invalid JSON")) + "\n");
      continue;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      output.write(
        JSON.stringify(err(request.id ?? null, ErrorCode.InvalidRequest, "not a JSON-RPC 2.0 request")) + "\n",
      );
      continue;
    }

    let response: JsonRpcResponse | null;
    try {
      response = await handleRequest(request, ctx);
    // degradation: benign — a handler throw becomes a JSON-RPC InternalError, which is the surface a client reads
    } catch (e) {
      response = err(request.id ?? null, ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
    }
    if (response) output.write(JSON.stringify(response) + "\n");
  }
}
