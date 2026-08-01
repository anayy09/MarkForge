#!/usr/bin/env node
/**
 * "Stateless, no document retention" (SPEC §8), measured.
 *
 * That sentence is a privacy claim. ADR-0015 rejected a server-side fallback for the
 * browser's heavy paths on the same grounds — silently transmitting a user's document
 * inverts ADR-0009 — so the HTTP surface only earns the exception if the claim is
 * checkable. Prose in a README is not checkable. This is.
 *
 * Four probes, then the control that makes them mean something:
 *
 *   1. **Filesystem delta.** Hash every file under the server's working directory before
 *      and after a batch of conversions. Any new, removed, or altered file is a failure.
 *   2. **No retrieval route.** Ask for the URLs a retaining server would have to expose.
 *      Every one must 404, and the route table must contain no path parameter.
 *   3. **No minted id.** No response may carry a handle that could be exchanged for the
 *      document later, in the body or in a header.
 *   4. **No cross-request contamination.** Post a document carrying a marker nothing else
 *      contains, then post a different one, and assert the second response holds no trace
 *      of the first. This is the probe that reaches an in-memory cache, which probes 1–3
 *      cannot see.
 *   5. **Negative control.** A deliberately retaining server — it writes each body to disk,
 *      mints an id, serves the document back, and keeps the last request in memory — is
 *      run through the identical probes and must be caught by **all four**. A retention
 *      check that only catches the file on disk would pass a server that kept everything
 *      in RAM.
 *
 * What this does not measure, stated rather than implied: memory the process holds and
 * never exposes. Probe 4 catches retention that any *observable* behaviour depends on,
 * which is the part that can leak; a buffer nobody reads is not distinguishable from a
 * buffer the allocator has not reclaimed, and claiming otherwise would be the kind of
 * assertion this file exists to replace.
 */
import { createServer as createNodeServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const { createServer, ROUTES } = await import(new URL("../packages/http/dist/index.js", import.meta.url).href);

const failures = [];
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  console.log(`  FAIL  ${m}`);
};

/** Hashes every file under `dir`, recursively. The unit of comparison for probe 1. */
function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        out.set(relative(dir, full).replaceAll("\\", "/"), createHash("sha256").update(bytes).digest("hex"));
      }
    }
  };
  walk(dir);
  return out;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) changes.push(`added ${path}`);
    else if (before.get(path) !== hash) changes.push(`modified ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`removed ${path}`);
  return changes;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const MARKER = "ZQ7-marker-9f3c1a-only-in-the-first-document";
const DOC_A = `# First\n\nThis paragraph contains ${MARKER} and nothing else does.\n`;
const DOC_B = `# Second\n\nAn unrelated document with different content entirely.\n`;

/**
 * Runs the four probes against a running server. Returns the list of retention signals
 * found — empty means the server retained nothing observable.
 *
 * The same function runs against the real server and against the control, which is the
 * point: if the probes were written per-target they could pass the real one by omission.
 */
async function probe(base, workDir) {
  const signals = [];

  const before = snapshot(workDir);

  const resA = await fetch(`${base}/convert?from=md&to=html`, { method: "POST", body: DOC_A });
  const bodyA = await resA.text();
  const resB = await fetch(`${base}/convert?from=md&to=html`, { method: "POST", body: DOC_B });
  const bodyB = await resB.text();
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/convert?from=md&to=html`, { method: "POST", body: `# Doc ${i}\n\nbody ${i}\n` });
  }

  // 1. filesystem delta
  const changes = diffSnapshots(before, snapshot(workDir));
  if (changes.length) signals.push(`wrote to disk: ${changes.slice(0, 3).join(", ")}`);

  // 2. no retrieval route
  for (const path of ["/documents/1", "/convert/1", "/history", "/documents"]) {
    const res = await fetch(`${base}${path}`);
    if (res.status !== 404) signals.push(`GET ${path} answered ${res.status} rather than 404`);
  }
  for (const route of ROUTES) {
    if (/[:*]/.test(route.path)) signals.push(`route table contains a path parameter: ${route.path}`);
  }

  // 3. no minted id. A UUID or a long hex/base64 handle in a header or an envelope is the
  //    shape a retaining server has to return; the conversion output itself is the body,
  //    so only headers and the JSON envelope are inspected.
  const idish = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})\b/i;
  for (const [name, value] of resA.headers) {
    if (idish.test(value)) signals.push(`response header ${name} looks like a document handle: ${value}`);
  }
  const envelope = await (await fetch(`${base}/convert?from=md&to=html&json=1`, { method: "POST", body: DOC_A })).text();
  for (const key of ["id", "documentId", "handle", "token", "ref"]) {
    if (new RegExp(`"${key}"\\s*:`).test(envelope)) signals.push(`JSON envelope mints "${key}"`);
  }

  // 4. no cross-request contamination
  if (bodyB.includes(MARKER)) signals.push("a later response contained an earlier document's content");
  const health = await (await fetch(`${base}/health`)).text();
  if (health.includes(MARKER)) signals.push("/health exposed an earlier document's content");
  if (!bodyA.includes("First")) signals.push("the first conversion did not actually run, so this probe tested nothing");

  return signals;
}

// ---------------------------------------------------------------- 1. the real server
console.log("\n1. The shipped server retains nothing observable");

const realDir = mkdtempSync(join(tmpdir(), "markforge-http-"));
// Seed the directory so the snapshot has something to be stable *about*. An empty
// directory compared against an empty directory is a comparison that cannot fail.
writeFileSync(join(realDir, "seed.txt"), "present before any request\n");
mkdirSync(join(realDir, "nested"), { recursive: true });
writeFileSync(join(realDir, "nested", "seed2.txt"), "also present before\n");

const realServer = createServer();
const realBase = await listen(realServer);
let realSignals = [];
try {
  realSignals = await probe(realBase, realDir);
  if (realSignals.length === 0) ok("no disk writes, no retrieval route, no minted id, no contamination");
  else for (const s of realSignals) fail(`retention signal: ${s}`);
} finally {
  await new Promise((r) => realServer.close(r));
}

// ---------------------------------------------------------------- 2. negative control
console.log("\n2. Negative control — a server that does retain must be caught by every probe");

const ctlDir = mkdtempSync(join(tmpdir(), "markforge-http-ctl-"));
writeFileSync(join(ctlDir, "seed.txt"), "present before any request\n");
mkdirSync(join(ctlDir, "nested"), { recursive: true });
writeFileSync(join(ctlDir, "nested", "seed2.txt"), "also present before\n");

/**
 * Everything the real server refuses to do, in one handler: it writes each body to disk,
 * mints an id and returns it in a header, serves the document back by that id, and keeps
 * the last request in memory where `/health` leaks it.
 *
 * Written out rather than simulated because the probes have to catch a *real* retaining
 * server. A control that only pretended to retain would test the probe against a
 * fixture of itself.
 */
const stored = new Map();
let lastBody = "";
const control = createNodeServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");

    if (req.method === "POST" && url.pathname === "/convert") {
      const id = createHash("sha256").update(body).digest("hex");
      stored.set(id, body);
      lastBody = body;
      writeFileSync(join(ctlDir, `${id.slice(0, 12)}.md`), body); // retention, on disk
      const html = `<h1>${/^# (.+)$/m.exec(body)?.[1] ?? ""}</h1>`;
      res.setHeader("X-Document-Id", id); // retention, as a handle
      res.setHeader("Content-Type", "text/html");
      res.end(url.searchParams.get("json") === "1" ? JSON.stringify({ id, bytes: html }) : html);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/documents/")) {
      const id = url.pathname.slice("/documents/".length);
      // Retention, as a retrieval route. Answers 200 for a stored id and — deliberately —
      // 200 with an empty body otherwise, because a route that exists at all is the signal.
      res.statusCode = 200;
      res.end(stored.get(id) ?? "");
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, lastDocument: lastBody })); // retention, in memory
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  })();
});

const ctlBase = await listen(control);
try {
  // The control's own route table is not `ROUTES`, so the path-parameter half of probe 2
  // cannot fire here. That is expected: it is the shipped table that must stay flat, and
  // the control exists to prove the other three probes catch a live retaining server.
  const ctlSignals = await probe(ctlBase, ctlDir);
  const caught = {
    "wrote to disk": ctlSignals.some((s) => s.startsWith("wrote to disk")),
    "retrieval route": ctlSignals.some((s) => s.includes("rather than 404")),
    "minted id": ctlSignals.some((s) => s.includes("handle") || s.includes("mints")),
    "contamination": ctlSignals.some((s) => s.includes("exposed an earlier") || s.includes("earlier document")),
  };
  for (const [name, was] of Object.entries(caught)) {
    if (was) ok(`negative control caught: ${name}`);
    else fail(`negative control NOT caught: ${name} — that probe cannot fail and proves nothing`);
  }
} finally {
  await new Promise((r) => control.close(r));
  rmSync(ctlDir, { recursive: true, force: true });
  rmSync(realDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nHTTP retention checks passed: the claim in SPEC §8 is measured, not asserted."
    : `\n${failures.length} HTTP retention check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`
);
process.exit(failures.length === 0 ? 0 : 1);
