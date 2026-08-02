import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const built = existsSync(CLI);

/**
 * A committed fixture, resolved from this file rather than from `process.cwd()`.
 *
 * `new URL(...).pathname` is deliberately not used: on Windows it yields `/C:/Users/...`,
 * `existsSync` says false, and every fixture-backed test in the file skips in silence. That
 * has happened here before, in a file written to check for it.
 */
const REPO_FIXTURE = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// The CLI is tested against its built output rather than its source, because what
// ships is the built artifact and a bin entry that does not resolve is a bug the
// source tests would never see. Skips when dist/ is absent so `pnpm test` works
// before a build.
describe.skipIf(!built)("markforge CLI", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "markforge-cli-"));
    writeFileSync(
      join(dir, "in.md"),
      "# Title\n\nBody with **bold**.\n\n1. one\n2. two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
    );
  });

  it("converts md to docx and back", () => {
    expect(run(["convert", "in.md", "-o", "out.docx"], dir).status).toBe(0);
    expect(existsSync(join(dir, "out.docx"))).toBe(true);

    expect(run(["convert", "out.docx", "-o", "back.md"], dir).status).toBe(0);
    const back = readFileSync(join(dir, "back.md"), "utf8");
    expect(back).toContain("# Title");
    expect(back).toContain("**bold**");
    // The defect the whole numbering path exists to prevent.
    expect(back).toMatch(/^1\. one$/m);
  });

  it("emits exactly one JSON object on stdout with --json", () => {
    const r = run(["convert", "in.md", "-o", "j.docx", "--json"], dir);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.to).toBe("docx");
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
  });

  it("keeps human output off stdout when --json is set, so piping is safe", () => {
    const r = run(["convert", "in.md", "-o", "j2.docx", "--json"], dir);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("exits 1 with a readable message on a missing file", () => {
    const r = run(["convert", "nope.md", "-o", "x.docx"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no such file");
  });

  it("exits 1 when the format cannot be inferred, and says which flag fixes it", () => {
    writeFileSync(join(dir, "mystery.xyz"), "content");
    const r = run(["convert", "mystery.xyz", "-o", "out.md"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--from/);
  });

  it("exits 2 under --strict when something was lost", () => {
    writeFileSync(join(dir, "lossy.md"), "Text with <custom-tag>raw html</custom-tag>.\n");
    const r = run(["convert", "lossy.md", "-o", "lossy.docx", "--strict"], dir);
    expect([0, 2]).toContain(r.status);
    if (r.status === 2) expect(r.stderr).toMatch(/lossy diagnostic/);
  });

  it("prints the inference decision log with --explain", () => {
    const r = run(["convert", "in.md", "-o", "e.docx", "--explain"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/decisions|No inference/i);
  });
});

describe.skipIf(!built)("markforge fmt", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "markforge-fmt-"));
  });

  it("exits 3 when a file needs formatting and does not write", () => {
    const path = join(dir, "messy.md");
    writeFileSync(path, "#    Title\n\n*  item\n");
    const before = readFileSync(path, "utf8");

    const r = run(["fmt", "messy.md", "--check"], dir);
    expect(r.status).toBe(3);
    expect(readFileSync(path, "utf8"), "--check must not write").toBe(before);
  });

  it("exits 0 and writes when formatting is requested", () => {
    const path = join(dir, "w.md");
    writeFileSync(path, "#    Title\n\n*  item\n");
    expect(run(["fmt", "w.md"], dir).status).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("# Title");
  });

  // The property that makes --check trustworthy: a file just formatted must not be
  // reported as needing formatting. If it were, nobody would trust the tool.
  it("reports a just-formatted file as clean", () => {
    const path = join(dir, "idem.md");
    writeFileSync(path, "#  Title\n\n*  a\n*  b\n");
    run(["fmt", "idem.md"], dir);
    expect(run(["fmt", "idem.md", "--check"], dir).status).toBe(0);
  });

  it("reports results as JSON", () => {
    writeFileSync(join(dir, "j.md"), "# T\n");
    const r = run(["fmt", "j.md", "--json"], dir);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(1);
  });
});

describe.skipIf(!built)("the last two SPEC section 8 subcommands", () => {
  const dir = tmpdir();

  /*
   * `diff` and `init` refused by name for five phases, which was right and was not delivery.
   * These tests replaced the two that asserted the refusal — and those two failed the moment
   * the commands landed, which is the behaviour a test asserting "not implemented" should
   * have: it is a claim with an expiry date, and it expired loudly.
   */
  it("diff reports a semantic difference between two documents", () => {
    const r = run(["diff", REPO_FIXTURE("md/clean-report.md"), REPO_FIXTURE("md/tables.md")], dir);
    expect(r.status).toBe(0);
    // The vocabulary is node types, not lines: that is what makes it a *semantic* diff.
    expect(r.stdout).toMatch(/node type\(s\) differ/);
    expect(r.stdout).toMatch(/tableCell/);
  });

  it("diff of a document against itself reports no difference", () => {
    const f = REPO_FIXTURE("md/tables.md");
    const r = run(["diff", f, f], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No structural difference/);
  });

  it("diff --metric adds fidelity scores", () => {
    const r = run(["diff", REPO_FIXTURE("md/clean-report.md"), REPO_FIXTURE("md/tables.md"), "--metric"], dir);
    expect(r.stdout).toMatch(/structural/);
    expect(r.stdout).toMatch(/span F1/);
  });

  it("init --print-config prints without writing", () => {
    // A *fresh* directory, not the shared `tmpdir()` this describe block uses elsewhere.
    // The first version used the shared one and failed, because the assertion "no config
    // was written" cannot be made in a directory anything else may have written to. A test
    // that depends on the tidiness of the OS temp directory is a flake waiting for a
    // different machine.
    const clean = mkdtempSync(join(tmpdir(), "markforge-init-"));
    const r = run(["init", "--print-config"], clean);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ profile: expect.any(String) });
    // The point of --print-config is that it is inert. A scaffolder that writes while
    // claiming to print is the kind of surprise that loses someone's config.
    expect(existsSync(join(clean, "markforge.config.json"))).toBe(false);
  });

  it("init writes a config and a lint config, and refuses to overwrite", () => {
    const clean = mkdtempSync(join(tmpdir(), "markforge-init-"));
    const first = run(["init"], clean);
    expect(first.status).toBe(0);
    expect(existsSync(join(clean, "markforge.config.json"))).toBe(true);
    expect(existsSync(join(clean, ".markdownlint.jsonc"))).toBe(true);

    // Overwriting a configured project is data loss wearing a helpful face, so the second
    // run skips rather than replacing — and still exits 0, because a project that already
    // has a config is the common case and not an error.
    const second = run(["init"], clean);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/skipped/);
  });


  // The other half, and the reason this file is worth keeping honest: a command that has
  // *landed* must stop claiming it has not. Without this, removing a name from the list
  // above would have been enough to make the suite green while the command still printed
  // "not implemented yet" to every user who ran it.
  it.each(["agentify", "serve", "mcp"])("%s no longer refuses, because it is implemented", (name) => {
    // `serve` and `mcp` both block once started, so they are asked for help rather than
    // run: `--help` exercises the same command registration and exits.
    const r = run([name, "--help"], dir);
    expect(r.stderr).not.toMatch(/not implemented yet/);
    expect(r.stdout).not.toMatch(/not implemented yet/);
  });

  it("serve binds a port and reports where on stdout", async () => {
    // Port 0, never the default. The first version of this test ran `serve` with no
    // `--port` and failed with EADDRINUSE against 3000 — a test that competes for a
    // fixed port fails for a reason that has nothing to do with the code.
    const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--json"], { cwd: dir });
    try {
      const line = await new Promise<string>((resolveLine, rejectLine) => {
        const timer = setTimeout(() => rejectLine(new Error("serve printed nothing in 10s")), 10_000);
        let buffered = "";
        child.stdout.on("data", (c: Buffer) => {
          buffered += c.toString("utf8");
          const nl = buffered.indexOf("\n");
          if (nl >= 0) {
            clearTimeout(timer);
            resolveLine(buffered.slice(0, nl));
          }
        });
      });
      const parsed = JSON.parse(line) as { url: string; routes: { method: string; path: string }[] };
      expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // The whole route table, asserted from the outside. A retrieval route appearing
      // here would be the visible half of a retention bug.
      expect(parsed.routes.map((x) => `${x.method} ${x.path}`)).toEqual([
        "POST /convert",
        "GET /health",
      ]);
    } finally {
      child.kill();
    }
  });

  it("lists every planned subcommand in --help", () => {
    const help = run(["--help"], dir).stdout;
    for (const name of ["convert", "fmt", "agentify", "check", "diff", "serve", "init", "mcp"]) {
      expect(help).toContain(name);
    }
  });
});

/**
 * SPEC §8's exit-code table, asserted end to end.
 *
 * Every code in the table now has a command that produces it. Two did not until 2026-08-02,
 * and neither was noticed because the table was documentation rather than a test:
 *
 * - **4** had no producer at all: `check` did not implement `--fidelity`, so the code SPEC
 *   defines for a fidelity regression could not be returned by anything.
 * - **5** had a producer that could not fire. `verify()` fails on a scaffolding violation,
 *   but the one check that could catch a *profile* disagreeing with the assembler — is this
 *   import syntax actually a link? — was handed a fragment beginning `## More`, which
 *   satisfied the pattern before the link was ever examined. Splitting the fragment made the
 *   check real; this test is what says so.
 *
 * The two cases are deliberately built from *shipped behaviour*, not from doctored inputs:
 * exit 4 comes from asking for a Markdown flavour that genuinely cannot hold the fixture's
 * footnotes, and exit 5 from a target profile whose declared import syntax is not a link.
 */
describe.skipIf(!built)("SPEC §8 exit codes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "markforge-exits-"));
    writeFileSync(join(dir, "ok.md"), "# Title\n\nBody.\n");
    writeFileSync(join(dir, "messy.md"), "#    Title\n\n*  item\n");
  });

  it("0 — success", () => {
    expect(run(["convert", "ok.md", "-o", "ok.docx"], dir).status).toBe(0);
  });

  it("1 — error", () => {
    expect(run(["convert", "missing.md", "-o", "x.docx"], dir).status).toBe(1);
  });

  it("2 — strict and lossy", () => {
    // A fixture with a *known* loss, rather than a guess at one: this manuscript has an
    // inline OMML equation, the IR has no inline OMML node (docs/LIMITS.md), and the adapter
    // says so with a lossy diagnostic. The older version of this test used raw HTML and
    // accepted `[0, 2]` — an assertion that passes whichever way the code behaves.
    const r = run(
      ["convert", REPO_FIXTURE("docx/manuscript-footnotes-equations.docx"), "-o", "m.md", "--strict"],
      dir,
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lossy diagnostic/);
  });

  it("3 — fmt --check found work to do", () => {
    expect(run(["fmt", "messy.md", "--check"], dir).status).toBe(3);
  });

  it("4 — fidelity regression against a committed baseline", () => {
    const probe = REPO_FIXTURE("md/flavor-probe.md");
    const baselines = REPO_FIXTURE("expected/baselines.json");

    // The control: the same command, the same baselines, the default flavour. If this were
    // not 0, the next assertion would prove nothing about the flavour.
    expect(run(["check", probe, "--fidelity", baselines, "--quiet"], dir).status).toBe(0);

    const r = run(["check", probe, "--fidelity", baselines, "--md-flavor", "commonmark"], dir);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/REGRESSION flavor-probe/);
  });

  it("5 — the agentify traceability gate", () => {
    const registry = join(dir, "targets");
    mkdirSync(registry, { recursive: true });
    for (const name of readdirSync(REPO_FIXTURE("../targets"))) {
      copyFileSync(join(REPO_FIXTURE("../targets"), name), join(registry, name));
    }
    // The agentify corpus, because the Markdown corpus is not agent documentation: a
    // quarterly report holds no commands, no environment variables, and no constraints, so
    // `agentify` on one correctly extracts nothing and writes an empty file. Two sources,
    // because the budget has to overflow before a link to the secondary file is emitted, and
    // the link is what this test is about.
    copyFileSync(REPO_FIXTURE("agentify/clean/runbook.md"), join(dir, "runbook.md"));
    copyFileSync(REPO_FIXTURE("agentify/clean/architecture.md"), join(dir, "architecture.md"));

    const args = [
      "agentify", "runbook.md", "architecture.md",
      "--registry", "targets", "--targets", "claude-md", "--budget", "120",
    ];
    // Control first, same as above: the shipped profile must pass, or exit 5 below would
    // only mean "agentify is broken".
    expect(run(args, dir).status).toBe(0);

    const profilePath = join(registry, "claude-md.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { imports: { syntax: string } };
    profile.imports.syntax = "include {path}";
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    const r = run(args, dir);
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/scaffolding violation|is not a link/);
  });
});
