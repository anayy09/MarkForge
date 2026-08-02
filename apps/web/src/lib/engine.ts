"use client";

import type {
  BROWSER_INPUT_FORMATS,
  BROWSER_OUTPUT_FORMATS,
  BrowserConvertOptions,
  BrowserConvertResult,
  BrowserInputFormat,
  BrowserOutputFormat,
  convertInBrowser,
  formatMarkdownInBrowser,
  parse,
  render,
} from "@markforge/browser";
import type { loadPdfRenderer } from "@markforge/browser/pdf";

/**
 * The engine, loaded as a script rather than imported.
 *
 * `apps/web/scripts/prepare-assets.mjs` writes `public/markforge/markforge.js` using the same
 * `buildBrowserBundle()` that `scripts/check-surface-parity.mjs` runs, so what this module
 * loads is the artifact parity was measured on. Importing `@markforge/browser` through Next
 * instead would hand the resolution to Turbopack and webpack, and one of the packages
 * underneath resolves to a DOM-based HTML entity decoder under the `browser` condition, which
 * would make output depend on the browser. See the comment in `next.config.ts`.
 *
 * Every type here is `import type` and therefore erased by `verbatimModuleSyntax`. Nothing in
 * this file causes Next to resolve `@markforge/browser` at build time.
 */

type Engine = {
  convertInBrowser: typeof convertInBrowser;
  formatMarkdownInBrowser: typeof formatMarkdownInBrowser;
  parse: typeof parse;
  render: typeof render;
  BROWSER_INPUT_FORMATS: typeof BROWSER_INPUT_FORMATS;
  BROWSER_OUTPUT_FORMATS: typeof BROWSER_OUTPUT_FORMATS;
};

type PdfEngine = { loadPdfRenderer: typeof loadPdfRenderer };

declare global {
  interface Window {
    MarkForge?: Engine;
    MarkForgePdf?: PdfEngine;
  }
}

export type {
  BrowserConvertOptions,
  BrowserConvertResult,
  BrowserInputFormat,
  BrowserOutputFormat,
};

/** Roughly what `markforge.js` weighs, for the one place that tells the user before loading. */
export const ENGINE_BYTES = 986_160;

const scripts = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  const existing = scripts.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // A failed load must not be cached as a permanent failure: the user may simply have
      // been offline for a moment, and a retry should be allowed to work.
      scripts.delete(src);
      reject(new Error(`Could not load ${src}. Check your connection and try again.`));
    };
    document.head.append(el);
  });

  scripts.set(src, promise);
  return promise;
}

let enginePromise: Promise<Engine> | undefined;

/** Resolves once the engine is on the page. Safe to call from anywhere, any number of times. */
export function engine(): Promise<Engine> {
  enginePromise ??= loadScript("/markforge/markforge.js").then(() => {
    const loaded = window.MarkForge;
    if (!loaded) {
      throw new Error(
        "markforge.js loaded but defined no MarkForge global. The bundle in public/ is not " +
          "the one prepare-assets.mjs writes.",
      );
    }
    return loaded;
  });
  return enginePromise;
}

/** True once the engine is resident, without triggering a load. Drives the idle state. */
export function engineReady(): boolean {
  return typeof window !== "undefined" && window.MarkForge !== undefined;
}
