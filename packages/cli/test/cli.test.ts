import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const built = existsSync(CLI);

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

describe.skipIf(!built)("unimplemented subcommands", () => {
  const dir = tmpdir();

  // Declared so --help tells the truth about the intended surface, but refusing
  // rather than silently succeeding.
  it.each(["agentify", "diff", "serve", "init"])("%s refuses instead of doing nothing", (name) => {
    const r = run([name], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not implemented yet \(Phase/);
  });

  it("lists every planned subcommand in --help", () => {
    const help = run(["--help"], dir).stdout;
    for (const name of ["convert", "fmt", "agentify", "check", "diff", "serve", "init"]) {
      expect(help).toContain(name);
    }
  });
});
