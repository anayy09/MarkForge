/**
 * The OPC (Open Packaging Conventions) container: a ZIP with well-known parts.
 *
 * Shared by the DOCX, XLSX, and PPTX adapters, which is why it is its own package
 * rather than living inside adapters-docx (ADR-0005, and the §9 deviation recorded
 * in docs/OPEN_QUESTIONS.md §7a).
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { parseXml, type XmlElement } from "./xml.js";

export class OpcPackage {
  private readonly entries: Record<string, Uint8Array>;
  private readonly xmlCache = new Map<string, XmlElement>();

  private constructor(entries: Record<string, Uint8Array>) {
    this.entries = entries;
  }

  static open(bytes: Uint8Array): OpcPackage {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch (cause) {
      throw new Error(
        "ooxml: not a readable ZIP container. DOCX, XLSX, and PPTX files are ZIP " +
          "archives; a file that fails here is either corrupt or not an Office document.",
        { cause },
      );
    }
    return new OpcPackage(entries);
  }

  has(path: string): boolean {
    return this.entries[path] !== undefined;
  }

  bytes(path: string): Uint8Array | undefined {
    return this.entries[path];
  }

  text(path: string): string | undefined {
    const b = this.entries[path];
    return b ? strFromU8(b) : undefined;
  }

  /** Parses and caches an XML part. Returns undefined if the part is absent. */
  xml(path: string): XmlElement | undefined {
    const cached = this.xmlCache.get(path);
    if (cached) return cached;
    const source = this.text(path);
    if (source === undefined) return undefined;
    const parsed = parseXml(source);
    this.xmlCache.set(path, parsed);
    return parsed;
  }

  /** Every part path, sorted — sorted because callers iterate and emit diagnostics. */
  paths(): string[] {
    return Object.keys(this.entries).sort();
  }

  /** Parts under a prefix, e.g. `word/media/`. */
  pathsUnder(prefix: string): string[] {
    return this.paths().filter((p) => p.startsWith(prefix));
  }

  set(path: string, data: Uint8Array | string): void {
    this.entries[path] = typeof data === "string" ? strToU8(data) : data;
    this.xmlCache.delete(path);
  }

  delete(path: string): void {
    delete this.entries[path];
    this.xmlCache.delete(path);
  }

  /**
   * Serialises back to a ZIP.
   *
   * `mtime: 0` and level 6 are deliberate: docs/SPEC.md §1 requires byte-identical
   * output for identical input, and ZIP stores a modification time per entry. With
   * the wall clock in there, the same document written twice produces different
   * bytes and every determinism test fails for a reason unrelated to content.
   */
  toBytes(): Uint8Array {
    const ordered: Record<string, Uint8Array> = {};
    for (const key of Object.keys(this.entries).sort()) ordered[key] = this.entries[key]!;
    return zipSync(ordered, { level: 6, mtime: 0 });
  }
}

/** Well-known part paths. Centralised so a typo is a compile error, not a silent miss. */
export const Part = {
  CONTENT_TYPES: "[Content_Types].xml",
  ROOT_RELS: "_rels/.rels",
  DOCUMENT: "word/document.xml",
  DOCUMENT_RELS: "word/_rels/document.xml.rels",
  STYLES: "word/styles.xml",
  NUMBERING: "word/numbering.xml",
  THEME: "word/theme/theme1.xml",
  SETTINGS: "word/settings.xml",
  FOOTNOTES: "word/footnotes.xml",
  ENDNOTES: "word/endnotes.xml",
  COMMENTS: "word/comments.xml",
  CORE_PROPS: "docProps/core.xml",
  APP_PROPS: "docProps/app.xml",
} as const;

export interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

/** Parses a `.rels` part into a map keyed by relationship id. */
export function parseRelationships(pkg: OpcPackage, path: string): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  const root = pkg.xml(path);
  if (!root) return out;
  for (const child of root.children) {
    if (!("name" in child) || child.local !== "Relationship") continue;
    const id = child.attrs["Id"];
    const type = child.attrs["Type"];
    const target = child.attrs["Target"];
    if (!id || !type || !target) continue;
    const rel: Relationship = { id, type, target };
    const mode = child.attrs["TargetMode"];
    if (mode !== undefined) rel.targetMode = mode;
    out.set(id, rel);
  }
  return out;
}

export const RelType = {
  IMAGE: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  HYPERLINK: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  HEADER: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  FOOTER: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
  FOOTNOTES: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
  COMMENTS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
} as const;

/** Resolves a relationship target against the part that declared it. */
export function resolveTarget(basePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const baseDir = basePart.includes("/") ? basePart.slice(0, basePart.lastIndexOf("/")) : "";
  const segments = (baseDir ? baseDir.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
