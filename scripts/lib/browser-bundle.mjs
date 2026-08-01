/**
 * Building and running the browser bundle. Shared so there is one browser build, not two
 * that could drift — `check-browser-bundle.mjs` asserts what is in it and
 * `check-surface-parity.mjs` runs it, and both must be talking about the same artifact.
 */
import * as esbuild from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/*
 * There is deliberately **no plugin here, and no `external`**.
 *
 * There used to be one: a stub that replaced `@markforge/adapters-pdf` and friends with a
 * module that threw, because `@markforge/core` reached the PDF adapter through
 * `await import(...)` and a single-file bundle has no chunk to defer it into. That stub
 * was a mistake of exactly the kind this project keeps finding — a **build-tool flag
 * standing in for a property of the code**. With it, the gate passed; without it,
 * `@markforge/core` and `@markforge/browser` failed to bundle under *every* standard
 * esbuild configuration, `splitting: true` included, because splitting decides which chunk
 * a module lands in and not whether `node:zlib` resolves.
 *
 * The fix was in the code, not the config: the PDF reader is now injected into `core` the
 * way ADR-0017 already injects the OCR recogniser, `core` has no reference of any kind to
 * `adapters-pdf`, and both bundle with nothing configured. Keeping the build honest means
 * the gate must not help, so it does not.
 */

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
 * would depend on the browser — and the surface-parity gate requires the browser and the
 * CLI to produce **byte-identical** output for the same input. A construct where a parser
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
