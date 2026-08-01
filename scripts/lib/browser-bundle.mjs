/**
 * Building and running the browser bundle. Shared so there is one browser build, not two
 * that could drift — `check-browser-bundle.mjs` asserts what is in it and
 * `check-surface-parity.mjs` runs it, and both must be talking about the same artifact.
 */
import * as esbuild from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Replaces the deferred packages with a module that throws.
 *
 * `@markforge/core` reaches `@markforge/adapters-pdf` through `await import(...)`, which
 * is exactly the lazy boundary ADR-0015 asks for — but a single-file bundle has no chunks
 * to defer *into*, so the bundler inlines it and the build fails on `node:module`,
 * `node:path`, and `node:zlib`.
 *
 * Stubbing rather than marking it external, because the two say different things. An
 * external leaves a bare import that the host would have to satisfy, and in a browser that
 * is a network request nobody asked for. A stub says what is true: PDF is not in this
 * build, and here is the message you get if you reach it. `convertInBrowser` refuses `pdf`
 * before this can execute, so the throw is a backstop rather than a path anyone travels —
 * and a backstop that names its own reason is better than an unresolved specifier.
 *
 * This is the honest version of ADR-0015's lazy tier as it stands today: `adapters-pdf`
 * is deferred *and* not yet browser-capable, so the browser build excludes it rather than
 * pretending a lazy chunk would work.
 */
const stubDeferred = {
  name: "stub-deferred-packages",
  setup(build) {
    const deferred = /^@markforge\/(adapters-pdf|adapters-ocr|render-pdf)$/;
    build.onResolve({ filter: deferred }, (args) => ({ path: args.path, namespace: "deferred-stub" }));
    build.onLoad({ filter: /.*/, namespace: "deferred-stub" }, (args) => ({
      contents: `
        const refuse = () => {
          throw new Error(
            "markforge (browser): ${args.path} is not in the browser build. ADR-0015 defers it " +
            "behind a lazy load, and as of 2026-08-01 it still needs Node builtins, so it is " +
            "deferred rather than browser-capable. Use the CLI or the HTTP API for this format."
          );
        };
        export const readPdf = refuse;
        export const documentFromPages = refuse;
        export const createTesseractRecognizer = refuse;
        export default refuse;
      `,
      loader: "js",
    }));
  },
};

/**
 * Export conditions for the browser build, and the reason this is not the default.
 *
 * `platform: "browser"` makes esbuild prefer the `browser` export condition, and one
 * dependency uses that to swap in a **DOM-based implementation**:
 * `decode-named-character-reference` resolves to `index.dom.js`, which decodes HTML
 * entities by writing them into a detached `<i>` element and reading `textContent` back.
 *
 * That is a sensible optimisation for a page and a determinism hazard for this project.
 * It routes entity decoding through the host's HTML parser, so the browser build's output
 * would depend on the browser — and Phase 5's done-criterion is that the browser and the
 * CLI produce **byte-identical** output for the same input. A construct where a parser
 * disagrees at all with the `character-entities` table would diverge silently, in the one
 * direction nobody would think to test.
 *
 * `worker` appears before `browser` in that package's export map and resolves to the
 * table-based `index.js` — the same module Node loads. Measured: this changes exactly one
 * package's resolution and costs 47 KB (865 → 912 KB). One implementation cannot disagree
 * with itself, which is the same reasoning that put `@noble/hashes` in `@markforge/ir` for
 * both platforms rather than one each.
 */
const BROWSER_CONDITIONS = ["worker"];

/** Builds `@markforge/browser` as a single self-contained IIFE. */
export async function buildBrowserBundle() {
  const result = await esbuild.build({
    entryPoints: [`${REPO}packages/browser/dist/index.js`],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "MarkForge",
    conditions: BROWSER_CONDITIONS,
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: [stubDeferred],
  });
  return {
    code: Buffer.from(result.outputFiles[0].contents).toString("utf8"),
    metafile: result.metafile,
  };
}

/**
 * The web platform, and nothing else.
 *
 * This list is the check. A `vm` context starts with the ECMAScript globals only, so
 * anything the bundle needs beyond plain JavaScript has to be named here — and every
 * entry is something a browser genuinely provides. No `process`, no `Buffer`, no
 * `require`, no `setTimeout` unless the code turns out to need it, so a Node dependency
 * that survived bundling fails here with the name of what it reached for.
 *
 * This is **not** a browser, and the difference is worth stating: it shares V8 with the
 * host, so it would not catch a genuine engine difference, and it has no DOM. ADR-0015's
 * *Consequences* promise Playwright running the same fixtures, which remains unbuilt. What
 * this does catch is the failure that actually occurs — code reaching for a Node global —
 * without adding a browser-binary dependency to run it.
 */
export function webPlatformSandbox() {
  const sandbox = {
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    structuredClone,
    queueMicrotask,
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

/** Evaluates the bundle in a fresh sandbox and returns the context, with `MarkForge` on it. */
export function loadInSandbox(code) {
  const sandbox = webPlatformSandbox();
  vm.runInContext(code, sandbox, { timeout: 60_000 });
  return sandbox;
}

/** Runs one conversion inside the sandbox and returns the output bytes. */
export async function convertInSandbox(sandbox, bytes, options) {
  sandbox.__input = new Uint8Array(bytes);
  sandbox.__options = { ...options };
  const result = await vm.runInContext(
    `MarkForge.convertInBrowser(__input, __options)`,
    sandbox,
    { timeout: 120_000 },
  );
  // The result crosses the context boundary, so its Uint8Array is the sandbox's realm.
  // Copying through a plain array keeps the comparison about bytes rather than about
  // which realm minted the view.
  return new Uint8Array(Array.from(result.bytes));
}
