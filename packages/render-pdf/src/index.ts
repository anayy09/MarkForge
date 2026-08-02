/**
 * @markforge/render-pdf — IR to PDF via Typst (ADR-0003).
 *
 * Unbuilt from Phase 2 until 2026-08-01, which made ADR-0003 the longest-standing decision in
 * the repository with nothing behind it and left ADR-0015's lazy tier ratified for two of its
 * three members.
 *
 * ## Determinism, which is the requirement that decided the design
 *
 * SPEC §1.1 forbids reading the wall clock; SPEC §4.3 requires deterministic pagination and no
 * font substitution. Measured before any of this was written:
 *
 *   - Two compiles of one input **in the same process** are byte-identical.
 *   - Two compiles **in separate processes** differ at byte 11533, in `/CreationDate` and
 *     `/ModDate`, which Typst fills from the wall clock.
 *   - The compiler's `creationTimestamp` option does **not** override them; it applies only
 *     to a document that opted into an automatic date.
 *   - `#set document(date: none)` omits both fields, after which separate processes agree
 *     byte for byte.
 *
 * So the timestamp is omitted rather than pinned, which SPEC §1.1 explicitly permits. That
 * measurement is the reason this package exists rather than being struck: the standing
 * authorisation to strike it was conditional on determinism being unreachable, and it is not.
 *
 * ## The narrow interface ADR-0003 requires
 *
 * ADR-0003's *Consequences* make `compile(typstSource, fonts) → pdfBytes` a requirement rather
 * than a nicety, so that swapping the single-maintainer binding for the official artifact or a
 * CLI invocation is a one-file change. `CompileFn` below is that interface, and it is
 * **injected** — the same shape ADR-0017 uses for the OCR recogniser, and for the same reason:
 * it keeps the heavy artifact behind an injection point rather than behind an import, which is
 * what `check-browser-bundle.mjs` measures.
 */
import { DiagnosticBag, DiagnosticCode, type MarkForgeDocument } from "@markforge/ir";
import { toTypst } from "./typst.js";

export { toTypst, esc } from "./typst.js";

const RENDERER = { kind: "adapter" as const, name: "@markforge/render-pdf", version: "0.1.0" };

/** A font supplied by the profile, embedded in the output. */
export interface PdfFont {
  family: string;
  bytes: Uint8Array;
}

/**
 * The narrow compile interface of ADR-0003's *Consequences*.
 *
 * Injected rather than imported so this package does not depend on the Typst binding. The
 * binding is a single-maintainer wrapper around a well-funded upstream; the risk is the
 * binding, and this is the seam that contains it.
 */
export type CompileFn = (
  source: string,
  fonts: readonly PdfFont[],
) => Uint8Array | Promise<Uint8Array>;

export interface PdfRenderOptions {
  /** The compiler. Required — there is no default, so nothing pulls Typst in implicitly. */
  compile: CompileFn;
  /**
   * Fonts to embed. SPEC §4.3 requires no substitution, so a profile supplying none gets
   * whatever the compiler has, and that is reported rather than assumed to be fine.
   */
  fonts?: readonly PdfFont[];
  title?: string;
}

export interface PdfRenderResult {
  bytes: Uint8Array;
  /** The Typst source, so a failure is debuggable without re-deriving it. */
  source: string;
  diagnostics: DiagnosticBag;
}

/**
 * Async because one of the two compilers is.
 *
 * The Node NAPI binding returns bytes synchronously; the Typst WASM binding returns a promise.
 * `CompileFn` therefore permits either, and this function awaits. ADR-0003's seam is unchanged
 * in substance — it is still `compile(source, fonts) → bytes`, and swapping the binding is
 * still a one-file change — but a synchronous-only seam would have made the browser compiler
 * unusable behind it, which was not visible until there were two implementations.
 */
export async function renderPdf(
  doc: MarkForgeDocument,
  options: PdfRenderOptions,
): Promise<PdfRenderResult> {
  const diagnostics = new DiagnosticBag(RENDERER);
  const { source, lost } = toTypst(doc, options.title === undefined ? {} : { title: options.title });

  for (const l of lost) {
    diagnostics.degraded(
      DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
      l.type,
      `PDF: ${l.reason}.`,
    );
  }

  const fonts = options.fonts ?? [];
  if (fonts.length === 0) {
    // Not an error, and not silence either. SPEC §4.3 requires fonts to come from the
    // profile and be embedded; with none supplied the compiler falls back to whatever it
    // bundles, which is reproducible but is not the profile's typography.
    diagnostics.info(
      DiagnosticCode.RENDER_CONSTRUCT_DROPPED,
      "No profile fonts were supplied, so the compiler's bundled faces are used. Output " +
        "stays deterministic; it is not the profile's typography.",
    );
  }

  return { bytes: await options.compile(source, fonts), source, diagnostics };
}
