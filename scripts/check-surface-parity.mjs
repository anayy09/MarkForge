#!/usr/bin/env node
/**
 * Phase 5's done-criterion: the same input produces byte-identical output through the CLI,
 * the HTTP API, the MCP server, and the browser build, with `MODEL_API_KEY` unset.
 *
 * This is the check that makes four surfaces one engine rather than four converters. It is
 * SPEC §1's "one IR, many adapters" applied to distribution: a surface that transformed
 * anything on the way in or out would show up here as a byte difference, and nowhere else
 * — a wrapper that trims a trailing newline or re-encodes a string passes every unit test
 * in its own package.
 *
 * Four surfaces, run over every corpus fixture the browser build can read:
 *
 *   - **CLI** — `markforge convert`, spawned, reading and writing real files.
 *   - **HTTP** — `POST /convert` against a listening `@markforge/http` server.
 *   - **MCP** — `tools/call convert` against a spawned stdio server, over real JSON-RPC.
 *   - **Browser** — the bundled `@markforge/browser` evaluated in a `vm` context holding
 *     only web-platform globals: no `process`, no `Buffer`, no `require`.
 *
 * Then the two clauses that come with the criterion:
 *
 *   - **A negative control.** A comparator that always says "equal" would pass everything
 *     above. One byte is flipped in a copy of the CLI output and the comparator must
 *     report it — per fixture, not once, so a comparison that silently skipped a format
 *     is caught too.
 *   - **`--llm` fails loudly.** Pointed at an unreachable endpoint, the CLI must exit
 *     non-zero rather than quietly producing the deterministic answer. The other three
 *     surfaces have no LLM path to fail, which is checked as the stronger property it is.
 *
 * `MODEL_API_KEY` is deleted from every child environment. If any surface reached the
 * network this job fails rather than quietly succeeding — the same reasoning as the
 * Phase 3 cached-LLM job in `ci.yml`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserBundle, loadInSandbox, convertInSandbox } from "./lib/browser-bundle.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "packages/cli/dist/index.js");
const JSON_OUT = process.argv.includes("--json");

const failures = [];
const rows = [];
const ok = (m) => !JSON_OUT && console.log(`  ok    ${m}`);
const fail = (m) => {
  failures.push(m);
  !JSON_OUT && console.log(`  FAIL  ${m}`);
};

/** No key, on every surface. The point is that reaching the network would fail here. */
const OFFLINE_ENV = { ...process.env };
delete OFFLINE_ENV.MODEL_API_KEY;

/**
 * The matrix. Every fixture the browser build can read, against every format it can write.
 *
 * PDF, PPTX, and XLSX fixtures are absent by construction rather than by omission:
 * `@markforge/browser` refuses them by name (ADR-0015 defers `adapters-pdf`, and it still
 * needs Node builtins), so there is no four-way comparison to make. That asymmetry is
 * reported at the end rather than left as a silently smaller matrix.
 */
const INPUTS = [
  ...["clean-report.md", "inline-marks.md", "nested-restarting-lists.md", "tables.md", "unicode-edge-cases.md"].map(
    (f) => ({ path: `fixtures/md/${f}`, from: "md" }),
  ),
  ...["semantic-structure.html", "spans-ground-truth.html"].map((f) => ({ path: `fixtures/html/${f}`, from: "html" })),
  ...["messy-combined.docx", "messy-direct-formatting.docx", "generated-run-per-word.docx"].map((f) => ({
    path: `fixtures/docx/${f}`,
    from: "docx",
  })),
];
const OUTPUTS = ["md", "html", "docx"];

const work = mkdtempSync(join(tmpdir(), "markforge-parity-"));

// ---------------------------------------------------------------- surfaces

function viaCli(inputPath, to, tag) {
  const out = join(work, `cli-${tag}.${to}`);
  const r = spawnSync(process.execPath, [CLI, "convert", join(REPO, inputPath), "-o", out, "--quiet"], {
    env: OFFLINE_ENV,
    encoding: "buffer",
  });
  if (r.status !== 0) {
    throw new Error(`CLI exited ${r.status}: ${r.stderr?.toString("utf8").slice(0, 300)}`);
  }
  return new Uint8Array(readFileSync(out));
}

async function viaHttp(base, bytes, from, to, name) {
  const res = await fetch(`${base}/convert?from=${from}&to=${to}&filename=${encodeURIComponent(name)}`, {
    method: "POST",
    body: bytes,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A long-lived MCP server, driven over real stdio JSON-RPC. */
function startMcp(root) {
  const child = spawn(process.execPath, [CLI, "mcp", "--root", root], { env: OFFLINE_ENV });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 120_000).unref?.();
    });
  return { request, stop: () => child.kill() };
}

async function viaMcp(mcp, root, inputRel, to, tag) {
  const outRel = `out/mcp-${tag}.${to}`;
  const res = await mcp.request("tools/call", {
    name: "convert",
    arguments: { input: inputRel, output: outRel, to },
  });
  if (res.result?.isError) throw new Error(`MCP: ${res.result.content[0]?.text?.slice(0, 300)}`);
  return new Uint8Array(readFileSync(join(root, outRel)));
}

// ---------------------------------------------------------------- 1. parity
!JSON_OUT && console.log("\n1. Four surfaces, same input, same bytes");

// The MCP server is rooted at the repo so it can read fixtures/ by relative path, which
// is also what exercises its root boundary on a real tree rather than a temp one.
mkdirSync(join(REPO, "out"), { recursive: true });
const mcp = startMcp(REPO);
await mcp.request("initialize", { protocolVersion: "2025-06-18" });

const { createServer } = await import(new URL("../packages/http/dist/index.js", import.meta.url).href);
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const httpBase = `http://127.0.0.1:${server.address().port}`;

const { code: bundle } = await buildBrowserBundle();
const sandbox = loadInSandbox(bundle);

let compared = 0;
let controlChecks = 0;
try {
  for (const input of INPUTS) {
    const bytes = new Uint8Array(readFileSync(join(REPO, input.path)));
    const name = basename(input.path);
    for (const to of OUTPUTS) {
      const tag = `${name.replace(/\W/g, "_")}-${to}`;
      let cli, http, mcpOut, browser;
      try {
        cli = viaCli(input.path, to, tag);
        http = await viaHttp(httpBase, bytes, input.from, to, name);
        mcpOut = await viaMcp(mcp, REPO, input.path, to, tag);
        browser = await convertInSandbox(sandbox, bytes, { from: input.from, to, path: name });
      } catch (e) {
        fail(`${name} → ${to}: ${e.message}`);
        continue;
      }

      const surfaces = { cli, http, mcp: mcpOut, browser };
      const digests = Object.fromEntries(
        Object.entries(surfaces).map(([k, v]) => [k, Buffer.from(v).toString("base64").slice(0, 24)]),
      );
      const differing = Object.entries(surfaces).filter(
        ([, v]) => !Buffer.from(v).equals(Buffer.from(cli)),
      );

      compared++;
      rows.push({ fixture: name, to, bytes: cli.length, equal: differing.length === 0, digests });

      if (differing.length === 0) {
        ok(`${name} → ${to}: 4 surfaces, ${cli.length} bytes, identical`);
      } else {
        fail(
          `${name} → ${to}: ${differing.map(([k, v]) => `${k} differs (${v.length} vs ${cli.length} bytes)`).join(", ")}`,
        );
      }

      // Negative control, per comparison rather than once. A comparator that stopped
      // comparing partway through would still pass a single control at the end.
      const tampered = Uint8Array.from(cli);
      tampered[Math.floor(tampered.length / 2)] ^= 0xff;
      if (Buffer.from(tampered).equals(Buffer.from(cli))) {
        fail(`${name} → ${to}: negative control did not alter the bytes, so this comparison proves nothing`);
      } else {
        controlChecks++;
      }
    }
  }
} finally {
  mcp.stop();
  await new Promise((r) => server.close(r));
  rmSync(join(REPO, "out"), { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. the control
!JSON_OUT && console.log("\n2. Negative control — the comparator must be able to report a difference");
if (controlChecks === compared && compared > 0) {
  ok(`a flipped byte is detected in all ${controlChecks} comparisons`);
} else {
  fail(`negative control ran ${controlChecks} times against ${compared} comparisons`);
}

// ---------------------------------------------------------------- 3. --llm fails loudly
!JSON_OUT && console.log("\n3. --llm at an unreachable endpoint fails loudly, and the other surfaces have no such path");

{
  /*
   * Port 1 on loopback: reserved and never listening.
   *
   * The fixture matters as much as the endpoint. The first version of this check used
   * `clean-report.md`, which produces **zero ambiguous heading decisions** (STATUS.md,
   * Phase 3) — so `--llm` had nothing to ask and exiting 0 was correct. A check that
   * cannot provoke a model call cannot detect a broken one.
   * `messy-ambiguous-headings.docx` was authored in Phase 3 precisely to produce them,
   * and it yields four.
   *
   * This check also reported its first real finding wrongly, which is worth recording:
   * it called the behaviour a **silent** fallback. It was not silent — `llmFailures` in
   * the `--json` envelope carried all four failures and the run report showed
   * `failures: 4, liveCalls: 0`. What was actually true is narrower and still a defect:
   * no `Diagnostic` was emitted, so `--strict` could not see it, and `ok: true` with
   * exit 0 made "the model was never reached" indistinguishable from success.
   */
  const out = join(work, "llm.md");
  const r = spawnSync(
    process.execPath,
    [
      CLI, "convert", join(REPO, "fixtures/docx/messy-ambiguous-headings.docx"),
      "-o", out, "--llm", "--llm-base-url", "http://127.0.0.1:1/v1", "--json",
    ],
    { env: { ...OFFLINE_ENV, MODEL_API_KEY: "not-a-real-key" }, encoding: "utf8" },
  );

  if (r.status === 0) {
    fail("CLI --llm exited 0 with every model call failing — indistinguishable from success");
  } else {
    ok(`CLI --llm against an unreachable endpoint exits ${r.status} rather than reporting success`);
  }

  // Exiting non-zero is not enough on its own: brief §3.3 wants the degradation carried
  // by a diagnostic, so a `--json` consumer sees it in the same place as every other one.
  let envelope;
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    envelope = null;
  }
  if (!envelope) {
    fail("CLI --llm produced no JSON envelope, so the degradation is not machine-readable");
  } else {
    const llmDiagnostics = (envelope.diagnostics ?? []).filter((d) => d.code === "MF-LLM-0001");
    if (llmDiagnostics.length === 0) {
      fail("no MF-LLM-0001 diagnostic for a failed model call (brief §3.3, ADR-0009)");
    } else {
      ok(`each failed model call carries a diagnostic (${llmDiagnostics.length} × MF-LLM-0001)`);
    }

    // The diagnostic existing is not enough — `--strict` has to be able to fail on it.
    // Keyed on `lossy` alone it could not: nothing was lost, so no exit code could ever
    // reflect a model that was asked for and never reached. `degraded` is what makes it
    // visible to `--strict`, and asserting the flag here is what stops the widening from
    // being quietly reverted. The predicate itself is unit-tested in
    // `packages/ir/test/degradation.test.ts`.
    const notDegraded = llmDiagnostics.filter((d) => d.degraded !== true);
    if (notDegraded.length > 0) {
      fail(`${notDegraded.length} MF-LLM-0001 diagnostic(s) lack degraded:true, so --strict cannot fail on them`);
    } else if (llmDiagnostics.length > 0) {
      ok("each carries degraded:true, which is what --strict fails on");
    }
    const wronglyLossy = llmDiagnostics.filter((d) => d.lossy === true);
    if (wronglyLossy.length > 0) {
      fail("MF-LLM-0001 is marked lossy, which would claim content was lost when none was");
    }

    if (envelope.ok !== false) fail("`ok` was not false while every model call failed");
    else ok("`ok` is false when the requested model was never reached");
  }
}

for (const [surface, pkg] of [["HTTP", "http"], ["MCP", "mcp"], ["browser", "browser"]]) {
  const manifest = JSON.parse(readFileSync(join(REPO, "packages", pkg, "package.json"), "utf8"));
  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.includes("@markforge/llm")) {
    fail(`${surface} depends on @markforge/llm — this surface can reach a model`);
  } else {
    ok(`${surface} has no LLM path to fail: @markforge/llm is not a dependency`);
  }
}

// ---------------------------------------------------------------- report
rmSync(work, { recursive: true, force: true });

const skipped = ["pdf", "pptx", "xlsx"];
!JSON_OUT &&
  console.log(
    `\n  note  ${skipped.join(", ")} are absent from the matrix: @markforge/browser refuses them ` +
      `by name, so there is no four-way comparison to make (ADR-0015)`,
  );

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, compared, failures, rows }, null, 2));
} else {
  console.log(
    failures.length === 0
      ? `\nSurface parity holds: ${compared} conversions, 4 surfaces each, byte-identical.`
      : `\n${failures.length} surface-parity check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
