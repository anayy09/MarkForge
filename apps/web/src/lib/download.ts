"use client";

/**
 * Handing bytes to the browser, in one place.
 *
 * Three panels offer a download and each had its own copy of this, which is how the compile
 * pane came to label a `.mcp.json` as `text/markdown`: a hardcoded MIME type in the copy that
 * was written when Markdown was the only thing that pane produced.
 *
 * The anchor is attached before it is clicked and the object URL is released on the next tick
 * rather than the same one. Clicking a detached anchor and revoking immediately is the
 * combination browsers have historically cancelled the download over, and it costs nothing to
 * not depend on the timing.
 */
export function downloadBlob(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
