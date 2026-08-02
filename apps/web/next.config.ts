import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const APP = fileURLToPath(new URL(".", import.meta.url));

/**
 * pdf.js's real directory, resolved the way the adapter resolves it at runtime.
 *
 * `packages/adapters-pdf/src/index.ts` computes `standardFontDataUrl` from
 * `createRequire(import.meta.url).resolve("pdfjs-dist/package.json")`. Node follows symlinks,
 * so under pnpm that lands in `node_modules/.pnpm/pdfjs-dist@<version>/...` rather than at
 * either of the two symlinks pointing there. Hand-writing that glob would pin a version and a
 * store layout; asking the resolver gives the same answer the adapter will get.
 *
 * Globs here are relative to this directory, not to the repository and not absolute. An
 * absolute path is silently treated as relative and produces
 * `/vercel/path0/apps/web/vercel/path0/node_modules/...`, which is how this was first written.
 */
const pdfjsGlobs = ((): string[] => {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    const rel = (p: string) => relative(APP, p).split(sep).join("/");
    return [`${rel(join(dir, "standard_fonts"))}/**`, `${rel(join(dir, "legacy/build"))}/**`];
  } catch {
    // A build without pdf.js installed is a build where /api/read cannot read a PDF anyway,
    // and failing the whole config for it would be worse than tracing nothing.
    return [];
  }
})();

/**
 * Next configuration, and the two things here that are load-bearing rather than taste.
 *
 * ## The engine is not bundled by Next, and that is the point
 *
 * There is deliberately no `transpilePackages`, no resolve alias for `@markforge/*`, and no
 * `conditions` override. `scripts/lib/browser-bundle.mjs:51` builds the browser bundle with
 * esbuild `conditions: ["worker"]`, because under `platform: "browser"` the package
 * `decode-named-character-reference` resolves to a DOM-based decoder that routes HTML entity
 * decoding through the host's HTML parser. That would make the page's output depend on the
 * browser, and `scripts/check-surface-parity.mjs` requires the browser and the CLI to produce
 * byte-identical bytes.
 *
 * Reproducing that condition here would mean matching Turbopack's resolver and webpack's
 * resolver to esbuild's, and keeping all three matched as Next changes. Instead
 * `scripts/prepare-assets.mjs` calls the same two exported functions the gates call and writes
 * the resulting IIFEs into `public/markforge/`, which the page loads with a script tag. Next
 * never resolves the engine's dependency graph, so there is nothing here to get wrong.
 *
 * `@markforge/fidelity` IS imported normally, and that is safe rather than inconsistent: its
 * only dependency is `@markforge/ir`, which reaches `@noble/hashes` and `ajv` and no Markdown
 * parser at all. The hazard above lives in the parsing path, and fidelity is not on it.
 *
 * ## The PDF reader must stay outside the bundle
 *
 * `@markforge/adapters-pdf` computes pdf.js's `standardFontDataUrl` at runtime through
 * `createRequire(import.meta.url).resolve(...)` (packages/adapters-pdf/src/index.ts:155-160).
 * Bundled, `import.meta.url` becomes a bundle URL and the path is wrong, and the failure is
 * the silent kind: glyphs from the standard-14 fonts drop with no diagnostic. So it is
 * external, and the font directory is traced in explicitly because a runtime-computed path is
 * invisible to the tracer.
 */
const nextConfig: NextConfig = {
  // Tracing must be rooted at the repo, not at apps/web, or it cannot follow pnpm's symlinks
  // into the workspace store and every @markforge/* package comes up missing at runtime.
  outputFileTracingRoot: REPO,

  serverExternalPackages: ["pdfjs-dist", "@markforge/adapters-pdf"],

  // No optimiser, and therefore no `sharp` (denied in pnpm-workspace.yaml's allowBuilds).
  // This app ships no photography: everything it shows is an artifact the engine produced.
  images: { unoptimized: true },

  outputFileTracingIncludes: { "/api/read": pdfjsGlobs },

  async headers() {
    return [
      {
        // The Typst compiler and the font set are content-addressed by the build that
        // produced them and are refetched on deploy, so a year is honest here. Without this
        // the 28 MB WASM is revalidated on every visit that touches the PDF path.
        source: "/markforge/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
