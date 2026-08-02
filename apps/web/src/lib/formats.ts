import type { BrowserInputFormat, BrowserOutputFormat } from "@markforge/browser";

export type Format = "md" | "docx" | "html" | "pptx" | "xlsx" | "pdf";
export type OutputFormat = "md" | "docx" | "html" | "pdf";

/** Where a format can be read. `server` means the bytes have to leave the browser. */
export type ReadSite = "browser" | "server" | "no";

export interface FormatInfo {
  id: Format;
  label: string;
  ext: string;
  mime: string;
  /** Text formats can be shown and edited in the source pane. Binary ones cannot. */
  text: boolean;
  read: ReadSite;
  write: boolean;
  /**
   * Why a format is not readable here, in the engine's own words. Quoted from
   * `packages/browser/src/index.ts`'s REFUSAL table so the UI and the engine cannot disagree
   * about the reason.
   */
  readNote?: string;
  writeNote?: string;
}

export const FORMATS: Record<Format, FormatInfo> = {
  md: {
    id: "md", label: "Markdown", ext: "md", mime: "text/markdown; charset=utf-8",
    text: true, read: "browser", write: true,
  },
  docx: {
    id: "docx", label: "DOCX", ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    text: false, read: "browser", write: true,
  },
  html: {
    id: "html", label: "HTML", ext: "html", mime: "text/html; charset=utf-8",
    text: true, read: "browser", write: true,
  },
  pdf: {
    id: "pdf", label: "PDF", ext: "pdf", mime: "application/pdf",
    text: false, read: "server", write: true,
    readNote:
      "Reading a PDF needs the pdf.js adapter, which still reaches for node:module, node:path " +
      "and node:zlib. It is not browser-capable, only deferred.",
    writeNote:
      "Written here through the Typst compiler, compiled to WebAssembly and fetched on demand.",
  },
  pptx: {
    id: "pptx", label: "PPTX", ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    text: false, read: "server", write: false,
    readNote:
      "PPTX is readable in Node but is left out of the browser bundle, to keep the eager " +
      "download to the DOCX, Markdown and HTML path.",
    writeNote:
      "Nobody asked MarkForge to generate a presentation, and building it on speculation " +
      "would be machinery with no user.",
  },
  xlsx: {
    id: "xlsx", label: "XLSX", ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    text: false, read: "server", write: false,
    readNote:
      "XLSX is readable in Node but is left out of the browser bundle, for the same reason " +
      "as PPTX.",
    writeNote:
      "Nobody asked MarkForge to generate a spreadsheet, and building it on speculation " +
      "would be machinery with no user.",
  },
};

export const INPUT_FORMATS = ["md", "docx", "html", "pptx", "xlsx", "pdf"] as const;
export const OUTPUT_FORMATS = ["md", "docx", "html", "pdf"] as const;

/** Formats the engine reads without a server. Mirrors BROWSER_INPUT_FORMATS. */
export const BROWSER_READS: readonly BrowserInputFormat[] = ["md", "docx", "html"];
export const BROWSER_WRITES: readonly BrowserOutputFormat[] = ["md", "docx", "html", "pdf"];

export function formatFromName(name: string): Format | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "htm" || ext === "html") return "html";
  if (ext === "docx" || ext === "pptx" || ext === "xlsx" || ext === "pdf") return ext;
  return undefined;
}

export function isOutputFormat(f: Format): f is OutputFormat {
  return f === "md" || f === "docx" || f === "html" || f === "pdf";
}

/* --------------------------------------------------------------------------------------
 * Renderer options
 *
 * Values and defaults are the renderer's own, loaded from public/markforge/flavors.json,
 * which prepare-assets.mjs writes from the built package. Nothing here is retyped.
 */

export interface FlavorPresetInfo {
  id: string;
  displayName: string;
  reference: string;
  syntax: {
    footnotes: string | false;
    math: string | false;
    admonitions: string | false;
    tables: string | false;
    frontMatter: string | false;
    rawHtml: boolean;
  };
  stringify: Record<string, string | number | boolean>;
}

export interface FlavorData {
  defaults: MarkdownSettings;
  presets: FlavorPresetInfo[];
}

export interface MarkdownSettings {
  flavor: string;
  headings: "atx" | "setext";
  bullet: "-" | "*" | "+";
  emphasis: "_" | "*";
  strong: "_" | "*";
  fence: "`" | "~";
  listIndent: "one" | "tab" | "mixed";
  revisionMode: RevisionMode;
  lineWidth: number;
  tables: "auto" | "gfm" | "html";
}

export type RevisionMode = "clean" | "showInsertions" | "showAll";

export interface HtmlSettings {
  fullDocument: boolean;
  headingIds: boolean;
  title: string;
  lang: string;
}

export interface DocxSettings {
  onMissingStyle: "warn" | "error" | "synthesize";
  revisionMode: RevisionMode;
}

export interface Settings {
  markdown: MarkdownSettings;
  html: HtmlSettings;
  docx: DocxSettings;
  /** The CLI's `--no-infer`. Off means headings are never promoted from evidence. */
  infer: boolean;
}

/**
 * The renderer defaults for everything except Markdown.
 *
 * Markdown's come from flavors.json. These two do not have an exported defaults object to
 * read, so they are written here and are the only retyped defaults in the app. `title` and
 * `lang` are empty because the renderer's default is to omit them, not to guess.
 */
export const HTML_DEFAULTS: HtmlSettings = {
  fullDocument: true,
  headingIds: true,
  title: "",
  lang: "",
};

/**
 * `synthesize`, not `warn`.
 *
 * `@markforge/core` forces this for every surface: a reader that stopped at a missing style
 * would make four surfaces disagree depending on which reference document each was given.
 */
export const DOCX_DEFAULTS: DocxSettings = {
  onMissingStyle: "synthesize",
  revisionMode: "clean",
};

export const REVISION_MODES = [
  { value: "clean", label: "clean", note: "accept insertions, drop deletions" },
  { value: "showInsertions", label: "showInsertions", note: "mark what was added" },
  { value: "showAll", label: "showAll", note: "mark both" },
] as const;

/** The effective Markdown options for a flavour, before any user override. */
export function effectiveMarkdown(data: FlavorData, flavor: string): MarkdownSettings {
  const preset = data.presets.find((p) => p.id === flavor);
  return { ...data.defaults, ...(preset?.stringify ?? {}), flavor } as MarkdownSettings;
}

/**
 * Only what the user actually changed.
 *
 * The renderer resolves `{ ...DEFAULT_MD_OPTIONS, ...preset.stringify, ...options }`, so an
 * explicit value wins over the flavour that would otherwise have set it. Sending every field
 * would therefore pin the flavour's own spelling choices to whatever the panel happened to
 * show, and a conversion left entirely on defaults would stop being byte-identical to the
 * one the CLI does with no flags. Sending only overrides keeps both properties.
 */
export function markdownOverrides(
  data: FlavorData,
  current: MarkdownSettings,
): Partial<MarkdownSettings> {
  const base = effectiveMarkdown(data, current.flavor);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(current) as (keyof MarkdownSettings)[]) {
    if (current[key] !== base[key]) out[key] = current[key];
  }
  // The flavour itself is never a "difference from the flavour", so it is added separately.
  if (current.flavor !== data.defaults.flavor) out["flavor"] = current.flavor;
  return out as Partial<MarkdownSettings>;
}

export function htmlOverrides(current: HtmlSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (current.fullDocument !== HTML_DEFAULTS.fullDocument) out["fullDocument"] = current.fullDocument;
  if (current.headingIds !== HTML_DEFAULTS.headingIds) out["headingIds"] = current.headingIds;
  if (current.title.trim()) out["title"] = current.title.trim();
  if (current.lang.trim()) out["lang"] = current.lang.trim();
  return out;
}

export function docxOverrides(current: DocxSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (current.onMissingStyle !== DOCX_DEFAULTS.onMissingStyle) {
    out["onMissingStyle"] = current.onMissingStyle;
  }
  if (current.revisionMode !== DOCX_DEFAULTS.revisionMode) out["revisionMode"] = current.revisionMode;
  return out;
}

export function countOverrides(data: FlavorData, s: Settings): number {
  return (
    Object.keys(markdownOverrides(data, s.markdown)).length +
    Object.keys(htmlOverrides(s.html)).length +
    Object.keys(docxOverrides(s.docx)).length +
    (s.infer ? 0 : 1)
  );
}

export function defaultSettings(data: FlavorData): Settings {
  return {
    markdown: effectiveMarkdown(data, data.defaults.flavor),
    html: { ...HTML_DEFAULTS },
    docx: { ...DOCX_DEFAULTS },
    infer: true,
  };
}
