"use client";

import { engine } from "@/lib/engine";

/**
 * Markdown to display-ready HTML, for every preview pane on the site.
 *
 * ## Why this exists
 *
 * The complaint it answers is that seeing your own output meant downloading it or copying a
 * wall of Markdown into another program. A preview is not a nicety for a conversion tool; it
 * is how a user finds out whether the conversion did what they wanted.
 *
 * ## The HTML comes from the engine, not from a Markdown library
 *
 * `apps/web` has no Markdown renderer of its own and must not grow one. `marked` or
 * `markdown-it` here would mean the preview shows one program's reading of the document
 * while the download contains another's, and the difference would appear exactly where this
 * project's claims live: tables with merged cells, footnotes, tracked changes. So the
 * preview is a real `md -> html` conversion through the same bundle that writes the file.
 * What you see is what the engine produced.
 */

/**
 * Elements dropped entirely, and the attribute patterns stripped from what survives.
 *
 * Everything on this page runs in the visitor's own tab against their own documents, so the
 * exposure here is self-inflicted rather than cross-user, and there is no session for a
 * script to steal. That is an argument for keeping the mitigation small, not for skipping
 * it: a DOCX from a stranger is a plausible input to a document converter, and "the blast
 * radius is small" is a worse answer than not executing it.
 *
 * The pass is structural rather than textual. It parses to a DOM and walks it, so it cannot
 * be defeated by the encoding tricks that beat a regex over a string.
 */
const FORBIDDEN = new Set([
  "SCRIPT",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "LINK",
  "META",
  "BASE",
  "FORM",
  // A `<style>` in the body is not a script but it is not local either: one `*` rule reaches
  // out of the preview pane and repositions the page around it.
  "STYLE",
]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/**
 * Attributes the browser fetches as a subresource rather than navigates to.
 *
 * This is the distinction `data:` turns on. On `href` it is navigable and belongs in the
 * blocklist; on `img src` it cannot script and is exactly what a document converter emits for
 * an embedded image, so blocking it there breaks the picture in every preview and explains
 * nothing about why — the one failure mode this project is least willing to ship.
 */
const SUBRESOURCE_ATTRS = new Set(["src"]);

/**
 * The scheme, read the way the browser will read it.
 *
 * Tabs, newlines and leading control characters are stripped from a URL before it is
 * resolved, so `java&#9;script:` is `javascript:` by the time anything runs. The HTML parser
 * upstream has already decoded the entity, so a pattern anchored on the literal text matches
 * neither the attribute as stored nor the URL as executed.
 *
 * Everything outside printable ASCII is dropped, which is broader than the browser's own rule
 * and errs in the safe direction: a scheme is ASCII, so nothing removed here could have been
 * part of one.
 */
function schemeOf(value: string): string | null {
  const stripped = value.replace(/[^!-~]/g, "");
  return /^([a-z][a-z0-9+.-]*):/i.exec(stripped)?.[1]?.toLowerCase() ?? null;
}

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    // Uppercased rather than compared as reported: HTML elements report an uppercase
    // `tagName` but foreign content does not, so a `<script>` inside `<svg>` arrives here
    // as "script" and missed a set written in the HTML spelling.
    if (FORBIDDEN.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // `on*` covers every event handler without enumerating them, which matters because
      // the list grows with the platform and an enumeration would silently fall behind.
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      const scheme = schemeOf(attr.value);
      if (
        scheme === "javascript" ||
        scheme === "vbscript" ||
        (scheme === "data" && !SUBRESOURCE_ATTRS.has(name))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }

  return doc.body.innerHTML;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Renders Markdown through the engine and returns HTML safe to inject. */
export async function markdownToHtml(markdown: string, path = "preview.md"): Promise<string> {
  const mf = await engine();
  const result = await mf.convertInBrowser(TEXT_ENCODER.encode(markdown), {
    from: "md",
    to: "html",
    path,
  });
  return sanitize(TEXT_DECODER.decode(result.bytes));
}

/** Sanitises HTML the engine already produced, for the `to: "html"` conversion path. */
export function sanitizeHtml(html: string): string {
  return sanitize(html);
}
