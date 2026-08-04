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
const FORBIDDEN = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (FORBIDDEN.has(el.tagName)) {
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
      if (URL_ATTRS.has(name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
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
