/**
 * The MCP surface: the protocol, the root boundary, and the loop SPEC §8 describes.
 *
 * Conversion correctness lives in `@markforge/core`'s suite. What is tested here is
 * everything the server adds — JSON-RPC framing, notification handling, the path
 * boundary, and the tool contract a client depends on.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { handleRequest, serve, resolveInRoot, TOOLS, PROTOCOL_VERSION, SERVER_INFO } from "../src/index.js";
import type { JsonRpcRequest, ToolResult } from "../src/index.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "markforge-mcp-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "spec.md"), "# Spec\n\nThe service MUST reject requests over 10 MB.\n");
  writeFileSync(join(root, "unformatted.md"), "#  Badly   spaced\n\n\n\ntext\n");
  cpSync(join(REPO, "targets"), join(root, "targets"), { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (method: string, params?: Record<string, unknown>, id: string | number | null = 1) =>
  handleRequest({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } as JsonRpcRequest, { root });

describe("the protocol", () => {
  it("answers initialize with its own version rather than echoing the client's", async () => {
    const res = await call("initialize", { protocolVersion: "1999-01-01" });
    const result = res?.result as { protocolVersion: string; serverInfo: unknown; instructions?: string };
    // Echoing an unknown version would claim conformance to a revision this code has
    // never seen. Saying which one we implement lets the client decide.
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(result.instructions).toContain("1999-01-01");
  });

  it("returns nothing at all for a notification", async () => {
    // No `id` means notification. A response to one is a protocol violation, not a
    // harmless extra — the client would pair it with the wrong request.
    const res = await handleRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcRequest,
      { root },
    );
    expect(res).toBeNull();
  });

  it("reports an unknown method rather than failing silently", async () => {
    const res = await call("resources/list");
    expect(res?.error?.code).toBe(-32601);
    expect(res?.error?.message).toContain("resources/list");
  });

  it("lists three tools, each with a schema", async () => {
    const res = await call("tools/list");
    const tools = (res?.result as { tools: typeof TOOLS }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["agentify", "convert", "fmt"]);
    for (const tool of tools) {
      expect(tool.inputSchema).toHaveProperty("type", "object");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("reports an unknown tool as a tool error, not a protocol error", async () => {
    const res = await call("tools/call", { name: "rm-rf", arguments: {} });
    // The distinction matters to a client: a protocol error means the server is broken,
    // a tool error means the model asked for something that does not exist.
    expect(res?.error).toBeUndefined();
    expect((res?.result as ToolResult).isError).toBe(true);
    expect((res?.result as ToolResult).content[0]?.text).toContain("convert");
  });
});

describe("the root boundary", () => {
  it("accepts a path inside the root", () => {
    expect(resolveInRoot(root, "docs/spec.md")).toBe(resolve(root, "docs", "spec.md"));
  });

  it.each([
    ["..", "the parent itself"],
    ["../outside.md", "a single traversal"],
    ["docs/../../outside.md", "a traversal that looks like it descends first"],
    ["../../../../../../etc/passwd", "a deep traversal"],
  ])("rejects %s (%s)", (candidate) => {
    // An MCP server runs with its operator's privileges and takes paths from a model.
    // "The model would not do that" is not a boundary, so each of these is asserted
    // rather than assumed — including the third, which normalises to an escape only
    // after a descent that looks legitimate.
    expect(() => resolveInRoot(root, candidate)).toThrow(/outside the server root/);
  });

  it("rejects an absolute path outside the root", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";
    expect(() => resolveInRoot(root, outside)).toThrow(/outside the server root/);
  });

  it("accepts a path that traverses but stays inside", () => {
    // The rule is about where it lands, not whether `..` appears. A rule that banned the
    // characters would reject this, which is legitimate.
    expect(() => resolveInRoot(root, "docs/../unformatted.md")).not.toThrow();
  });

  it("refuses a traversal through the tool call, not only through the helper", async () => {
    const res = await call("tools/call", {
      name: "convert",
      arguments: { input: "../../../etc/passwd", to: "md" },
    });
    expect((res?.result as ToolResult).isError).toBe(true);
    expect((res?.result as ToolResult).content[0]?.text).toContain("outside the server root");
  });
});

describe("the tools", () => {
  it("converts and returns text inline when no output path is given", async () => {
    const res = await call("tools/call", {
      name: "convert",
      arguments: { input: "docs/spec.md", to: "html" },
    });
    const text = (res?.result as ToolResult).content[0]!.text;
    expect(text).toContain("<h1");
    expect(text).toContain("diagnostic");
  });

  it("refuses to return docx inline rather than emitting broken text", async () => {
    const res = await call("tools/call", {
      name: "convert",
      arguments: { input: "docs/spec.md", to: "docx" },
    });
    expect((res?.result as ToolResult).isError).toBe(true);
    expect((res?.result as ToolResult).content[0]?.text).toContain("binary");
  });

  it("writes when an output path is given", async () => {
    const res = await call("tools/call", {
      name: "convert",
      arguments: { input: "docs/spec.md", output: "out/spec.html" },
    });
    expect((res?.result as ToolResult).isError).toBeUndefined();
    expect(existsSync(join(root, "out", "spec.html"))).toBe(true);
  });

  it("reports formatting need without writing under check", async () => {
    const before = readFileSync(join(root, "unformatted.md"), "utf8");
    const res = await call("tools/call", { name: "fmt", arguments: { input: "unformatted.md", check: true } });
    expect((res?.result as ToolResult).content[0]?.text).toContain("needs formatting");
    expect(readFileSync(join(root, "unformatted.md"), "utf8")).toBe(before);
  });

  it("closes the loop: agentify produces a CLAUDE.md that passes the gate", async () => {
    // SPEC §8's actual sentence — "the agent that consumes CLAUDE.md can also generate
    // it" — as an assertion rather than a claim.
    const res = await call("tools/call", {
      name: "agentify",
      arguments: { sources: ["docs/spec.md"], targets: ["claude-md"] },
    });
    const result = res?.result as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("passed the traceability gate");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("10 MB");
  });

  it("writes nothing under dryRun", async () => {
    const res = await call("tools/call", {
      name: "agentify",
      arguments: { sources: ["docs/spec.md"], targets: ["agents-md"], dryRun: true },
    });
    expect((res?.result as ToolResult).content[0]!.text).toContain("Would write");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });
});

describe("the stdio transport", () => {
  it("frames responses one per line and survives a malformed message mid-stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const running = serve({ root, input, output });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    input.write("this is not json\n");
    // A malformed line must not end the session: the client sees a parse error and can
    // continue, which is why this asserts a *third* message still gets an answer.
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
    input.end();
    await running;

    const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: 1, result: {} });
    expect(lines[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(lines[2]).toHaveProperty("id", 3);
  });

  it("writes no response line for a notification", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const running = serve({ root, input, output });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n");
    input.end();
    await running;

    const lines = chunks.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 9 });
  });
});

describe("no model is reachable from this surface", () => {
  it("declares no dependency on @markforge/llm", () => {
    const pkg = JSON.parse(readFileSync(REPO + "packages/mcp/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain("@markforge/llm");
  });

  it("exposes no tool parameter that could enable one", () => {
    // `--no-llm` is the default everywhere. Here it is not overridable, and the check is
    // that no tool takes an *argument* a client could use to ask for a model.
    //
    // Scoped to parameter names on purpose. The first version searched the whole
    // serialised schema and failed on `convert`'s own description — "no model is
    // consulted" — which is the sentence promising the property being tested. A predicate
    // that cannot tell a parameter from the prose denying it measures nothing.
    const parameterNames = TOOLS.flatMap((t) =>
      Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties),
    );
    for (const name of parameterNames) {
      expect(name.toLowerCase()).not.toMatch(/llm|model|apikey|assist|endpoint/);
    }
    // And the whole tool surface is those three, so a fourth appearing is a decision
    // someone has to make here rather than something that arrives by accident.
    expect(parameterNames.sort()).toEqual(
      ["budget", "check", "dryRun", "from", "input", "input", "output", "sources", "targets", "to"].sort(),
    );
  });
});
