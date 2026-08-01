/**
 * The MCP wire protocol, hand-written.
 *
 * **Why no SDK.** ADR-0009 set this precedent for the LLM layer — "no vendor SDK and no
 * framework, so this is the whole network surface of the project, about a hundred lines,
 * which is the argument for not having added a dependency to hold them." MCP over stdio is
 * the same shape: newline-delimited JSON-RPC 2.0 with four methods that matter
 * (`initialize`, `tools/list`, `tools/call`, `ping`). Taking a dependency to hold this file
 * would be a dependency without a one-line justification anyone could write.
 *
 * The cost is stated rather than hidden: protocol revisions are ours to follow. That is
 * bounded because `PROTOCOL_VERSION` is a string a client negotiates against, so a mismatch
 * is a visible refusal rather than a subtly wrong response.
 */

/** The revision this server implements. A client asking for another is told, not guessed at. */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 reserved codes. Only the ones this server can actually produce. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** One tool, as `tools/list` reports it. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool returns. `isError` is how MCP reports a *tool* failure, distinct from a protocol one. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool failure, which is a successful RPC carrying an error payload — not an RPC error. */
export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
