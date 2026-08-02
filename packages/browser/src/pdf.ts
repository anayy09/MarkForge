/**
 * `@markforge/browser/pdf` — the Typst WASM compiler, in a chunk nobody downloads by accident.
 *
 * A **separate entry point**, not an export of `index.ts`. That is the whole design: importing
 * a Typst compiler from the main entry would put the WASM artifact in the browser's eager
 * chunk, which `scripts/check-browser-bundle.mjs` fails by name for the package declaring
 * `browserEntry: true`. A module boundary the bundler can honour is the only kind that counts
 * here — `@markforge/core` records the measurement that a dynamic `import()` alone is not one.
 *
 * ## The two things this loader exists to get right
 *
 * Both measured 2026-08-02, and both fail *silently*, which is why they are handled in shipped
 * code rather than described in a doc a caller might not read.
 *
 * **1. Fonts.** The WASM compiler ships none. Compile without them and you get a structurally
 * valid PDF with zero embedded fonts and **zero extractable text** — our own `parsePdf`
 * classifies the result as a scan. Nothing throws.
 *
 * **2. `assets: false`.** `TypstCompilerDriver.defaultAssets = ['text']` fetches fonts from
 * `https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/` during `init()`: a runtime network
 * call in a toolkit whose privacy story is that it makes none by default, pinned to a Typst
 * version the Node surfaces do not use. Both a privacy regression and a parity hazard.
 *
 * With both handled this surface produces bytes identical to `markforge convert --to pdf`,
 * measured on `clean-report`, `tables`, and `nested-restarting-lists`.
 */
import { renderPdf } from "@markforge/render-pdf";
import type { BrowserPdfRenderer } from "./index.js";

/** A face, as both `renderPdf` and the compiler want it. */
export interface BrowserFont {
  family: string;
  bytes: Uint8Array;
}

/** The parts of `@myriaddreamin/typst.ts/compiler` this loader uses. */
export interface TypstCompilerModule {
  createTypstCompiler(): {
    init(options: Record<string, unknown>): Promise<void>;
    addSource(path: string, content: string): void;
    compile(options: Record<string, unknown>): Promise<unknown>;
  };
  CompileFormatEnum: { pdf: number };
  loadFonts(paths: readonly string[], options: Record<string, unknown>): unknown;
}

export interface LoadPdfCompilerOptions {
  /**
   * The WASM binary. A page supplies it however it likes — `fetch` of a static asset, an
   * inlined blob, a bundler's `?url` import. This package will not fetch it, because choosing
   * a URL on the caller's behalf is choosing a network call on their behalf.
   */
  wasm: ArrayBuffer | Uint8Array;
  /**
   * The faces from `fonts/`. Required in practice — see the module comment. Supply the same
   * set the Node surfaces use, or the output will not match theirs.
   */
  fonts: readonly BrowserFont[];
  /**
   * The compiler module namespace, injected rather than imported so this file has no static
   * dependency on the binding: a page bundling its own copy, or pinning a different version,
   * passes it here.
   */
  compilerModule: TypstCompilerModule;
}

/**
 * Builds a ready PDF renderer bound to the supplied fonts.
 *
 * Returns a renderer rather than a compiler because `@markforge/render-pdf` may only be
 * imported from *this* chunk — see `BrowserPdfRenderer` in `index.ts` for the gate failure
 * that established it.
 *
 * `CompileFn` permits an async compile as of 2026-08-02. It was synchronous-only until this
 * leg existed and the WASM binding cannot satisfy that, which only a second implementation
 * could surface.
 */
export async function loadPdfRenderer(
  options: LoadPdfCompilerOptions,
): Promise<{ render: BrowserPdfRenderer; fonts: readonly BrowserFont[] }> {
  const { createTypstCompiler, CompileFormatEnum, loadFonts } = options.compilerModule;
  const compiler = createTypstCompiler();

  // Fonts are handed over as an in-memory table keyed by a synthetic path, so the loader's
  // fetcher only ever sees keys we put there and can never reach the network.
  const table = new Map<string, Uint8Array>();
  for (const f of options.fonts) table.set(`/fonts/${f.family}`, f.bytes);

  await compiler.init({
    getModule: () => options.wasm,
    beforeBuild: [
      loadFonts([...table.keys()], {
        assets: false, // see the module comment; without this it fetches from jsdelivr
        fetcher: async (url: unknown) => {
          const bytes = table.get(String(url));
          if (!bytes) throw new Error(`markforge (browser): no font registered for ${String(url)}`);
          return {
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          };
        },
      }),
    ],
  });

  const compile = async (source: string): Promise<Uint8Array> => {
    compiler.addSource("/main.typ", source);
    const result = await compiler.compile({
      mainFilePath: "/main.typ",
      // The ordinal, not the string "pdf". A string is truthy, reaches wasm as a non-number,
      // and silently yields the *vector* artifact — a blob with no %PDF- header that reads as
      // a catastrophic byte mismatch rather than as a wrong argument.
      format: CompileFormatEnum.pdf,
    });
    const bytes = (result as { result?: unknown })?.result ?? result;
    // Duck-typed rather than `instanceof Uint8Array`.
    //
    // The compiler may be supplied from another realm — it is in
    // `scripts/check-surface-parity.mjs`, which evaluates this bundle in a `vm` context and
    // hands in the host's binding — and `instanceof` is per-realm, so a perfectly good
    // Uint8Array minted next door fails it. That produced "the Typst compiler returned no PDF
    // bytes" for output that was entirely fine.
    if (!ArrayBuffer.isView(bytes)) {
      throw new Error(
        `markforge (browser): the Typst compiler returned no PDF bytes (got ${typeof bytes})`,
      );
    }
    const view = bytes as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  };

  // `fonts` is handed to `renderPdf` as well as to the compiler. It reaches the compiler
  // through `init` above; passing it here too is what keeps the *diagnostics* identical to
  // the Node surfaces', which emit no font warning because they supply a non-empty array.
  const render: BrowserPdfRenderer = async (document) => {
    const r = await renderPdf(document, { compile, fonts: options.fonts });
    return { bytes: r.bytes, diagnostics: r.diagnostics };
  };

  return { render, fonts: options.fonts };
}
