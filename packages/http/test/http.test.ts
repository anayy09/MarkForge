/**
 * The HTTP surface, including the two claims brief §8 makes about it that are not about
 * conversion at all: stateless, and no document retention.
 *
 * Conversion correctness is not re-tested here — `@markforge/core` owns that, and a copy
 * of those assertions against a socket would only ever fail at the same time. What this
 * file tests is the surface: that the route table is the whole route table, that a body
 * cap is enforced during the read rather than trusted from a header, and that nothing on
 * this path can reach a model.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createServer, ROUTES, DEFAULT_MAX_BODY_BYTES } from "../src/index.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (p: string) => new Uint8Array(readFileSync(REPO + p));

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the route table", () => {
  it("has exactly two routes, and neither addresses stored content", () => {
    expect(ROUTES).toHaveLength(2);
    // The property that matters is not the count. A retention bug needs somewhere to put
    // the document and a way to get it back; this asserts there is no second half. Any
    // route with a path parameter would be one.
    for (const route of ROUTES) {
      expect(route.path).not.toMatch(/[:*]/);
    }
    expect(ROUTES.filter((r) => r.method === "GET").map((r) => r.path)).toEqual(["/health"]);
  });

  it("refuses an unknown route by naming the whole table", async () => {
    const res = await fetch(`${base}/documents/abc123`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("POST /convert");
    expect(body.error).toContain("GET /health");
  });
});

describe("GET /health", () => {
  it("states the retention posture in the payload, not only in the docs", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stateless).toBe(true);
    expect(body.documentRetention).toBe("none");
    expect(body.outputFormats).toEqual(["md", "docx", "html"]);
  });
});

describe("POST /convert", () => {
  it("converts markdown to html and returns the bytes with no wrapper", async () => {
    const res = await fetch(`${base}/convert?from=md&to=html`, {
      method: "POST",
      body: fixture("fixtures/md/clean-report.md"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("<h1");
  });

  it("returns bytes identical to the same conversion through @markforge/core", async () => {
    // The parity claim in miniature, at the package boundary. The four-surface version is
    // scripts/check-surface-parity.mjs; this one fails faster and points at this file.
    const { convert } = await import("@markforge/core");
    const bytes = fixture("fixtures/md/clean-report.md");
    const direct = await convert(bytes, { from: "md", to: "html" });
    const res = await fetch(`${base}/convert?from=md&to=html`, { method: "POST", body: bytes });
    const served = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(served).equals(Buffer.from(direct.bytes))).toBe(true);
  });

  it("infers the input format from a supplied filename", async () => {
    const res = await fetch(`${base}/convert?filename=report.md&to=html`, {
      method: "POST",
      body: fixture("fixtures/md/clean-report.md"),
    });
    expect(res.status).toBe(200);
  });

  it("reports diagnostics in headers so the body stays exactly the output bytes", async () => {
    const res = await fetch(`${base}/convert?from=md&to=html`, {
      method: "POST",
      body: fixture("fixtures/md/clean-report.md"),
    });
    expect(res.headers.get("x-markforge-diagnostics")).toMatch(/^\d+$/);
    expect(res.headers.get("x-markforge-lossy")).toMatch(/^(true|false)$/);
  });

  it("refuses an input-only output format by name", async () => {
    const res = await fetch(`${base}/convert?from=md&to=xlsx`, {
      method: "POST",
      body: fixture("fixtures/md/clean-report.md"),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("input format only");
  });

  it("refuses an empty body rather than converting nothing", async () => {
    const res = await fetch(`${base}/convert?from=md&to=html`, { method: "POST", body: "" });
    expect(res.status).toBe(400);
  });

  it("enforces the body cap during the read, not from the content-length header", async () => {
    // A dedicated server with a tiny cap, and a body sent without a declared length: the
    // header check cannot fire, so only the running total can refuse this. A cap that
    // trusted `content-length` would pass this test's sibling and fail here.
    const small = createServer({ maxBodyBytes: 64 });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    const addr = small.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/convert?from=md&to=html`;
    try {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("# heading\n\n" + "x".repeat(500)));
          controller.close();
        },
      });
      const res = await fetch(url, { method: "POST", body: stream, duplex: "half" } as RequestInit);
      expect(res.status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    }
  });

  it("has a default cap, so an unconfigured server is not unbounded", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("the LLM is unreachable from this surface", () => {
  it("declares no dependency on @markforge/llm", () => {
    const pkg = JSON.parse(readFileSync(REPO + "packages/http/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    // SPEC §11's dependency rule is CI-enforced for adapters and renderers. A new surface
    // must not become the loophole, and the cheapest way to prove it is not one is that
    // the edge does not exist — checked here as well as in scripts/check-docs.mjs, because
    // this is the file someone adding an LLM feature to the server would be editing.
    expect(Object.keys(pkg.dependencies)).not.toContain("@markforge/llm");
  });

  it("says so in /health rather than leaving it to be assumed", async () => {
    const body = (await (await fetch(`${base}/health`)).json()) as { llm: string };
    expect(body.llm).toContain("unavailable");
  });
});
