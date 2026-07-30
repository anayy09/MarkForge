/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: packages/ir/schema/ir.v0.schema.json
 * Regenerate: pnpm codegen
 *
 * Hand edits are lost on the next run. If a type is wrong here, the schema is
 * wrong; fix the schema (docs/SPEC.md §2.2).
 */

/**
 * Content-addressed node id. See docs/SPEC.md section 2.7 and ADR-0014.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "NodeId".
 */
export type NodeId = string;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Sha256Hex".
 */
export type Sha256Hex = string;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Root".
 */
export type Root = NodeBase & {
  type?: "root";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "BlockContent".
 */
export type BlockContent =
  | Paragraph
  | Heading
  | Blockquote
  | List
  | Code
  | Html
  | ThematicBreak
  | Definition
  | Table
  | FootnoteDefinition
  | Yaml
  | Toml
  | Math
  | Section
  | Figure
  | Caption
  | Admonition
  | EquationBlock
  | DescriptionList
  | TextBox
  | PageBreak
  | ColumnBreak
  | Slide
  | Sheet
  | Unknown;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Paragraph".
 */
export type Paragraph = NodeBase & {
  type?: "paragraph";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "PhrasingContent".
 */
export type PhrasingContent =
  | Text
  | Emphasis
  | Strong
  | InlineCode
  | Break
  | Link
  | Image
  | LinkReference
  | ImageReference
  | Delete
  | FootnoteReference
  | InlineMath
  | Html
  | Subscript
  | Superscript
  | Underline
  | SmallCaps
  | Highlight
  | CrossReference
  | Citation
  | Comment
  | Insertion
  | Deletion
  | Unknown;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Text".
 */
export type Text = NodeBase & {
  type?: "text";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Emphasis".
 */
export type Emphasis = NodeBase & {
  type?: "emphasis";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Strong".
 */
export type Strong = NodeBase & {
  type?: "strong";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "InlineCode".
 */
export type InlineCode = NodeBase & {
  type?: "inlineCode";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Break".
 */
export type Break = NodeBase & {
  type?: "break";
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Link".
 */
export type Link = NodeBase & {
  type?: "link";
  url: string;
  title?: string | null;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Image".
 */
export type Image = NodeBase &
  Image1 & {
    type?: "image";
    url?: string;
    resourceId?: ResourceId;
    alt?: string | null;
    title?: string | null;
  };
export type Image1 =
  | {
      url: string;
    }
  | {
      resourceId: ResourceId;
    };
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "ResourceId".
 */
export type ResourceId = string;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "LinkReference".
 */
export type LinkReference = NodeBase & {
  type?: "linkReference";
  identifier: string;
  label?: string;
  referenceType: "shortcut" | "collapsed" | "full";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "ImageReference".
 */
export type ImageReference = NodeBase & {
  type?: "imageReference";
  identifier: string;
  label?: string;
  referenceType: "shortcut" | "collapsed" | "full";
  alt?: string | null;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Delete".
 */
export type Delete = NodeBase & {
  type?: "delete";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "FootnoteReference".
 */
export type FootnoteReference = NodeBase & {
  type?: "footnoteReference";
  identifier: string;
  label?: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "InlineMath".
 */
export type InlineMath = NodeBase & {
  type?: "inlineMath";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Html".
 */
export type Html = NodeBase & {
  type?: "html";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Subscript".
 */
export type Subscript = NodeBase & {
  type?: "subscript";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Superscript".
 */
export type Superscript = NodeBase & {
  type?: "superscript";
  children: PhrasingContent[];
};
/**
 * Retained because DOCX round-trip needs it, though Markdown has no canonical form.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Underline".
 */
export type Underline = NodeBase & {
  type?: "underline";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "SmallCaps".
 */
export type SmallCaps = NodeBase & {
  type?: "smallCaps";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Highlight".
 */
export type Highlight = NodeBase & {
  type?: "highlight";
  color?: string;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "CrossReference".
 */
export type CrossReference = NodeBase & {
  type?: "crossReference";
  targetId?: NodeId;
  /**
   * Unresolved target, e.g. a bookmark name.
   */
  targetKey?: string;
  kind: "heading" | "figure" | "table" | "equation" | "footnote" | "bibliography" | "external";
  label?: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Citation".
 */
export type Citation = NodeBase & {
  type?: "citation";
  /**
   * @minItems 1
   */
  keys: [string, ...string[]];
  prefix?: string;
  suffix?: string;
};
/**
 * Wraps the commented range rather than annotating it, so tree transforms cannot corrupt the anchor.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Comment".
 */
export type Comment = NodeBase & {
  type?: "comment";
  commentId: string;
  author?: string;
  date?: string;
  resolved: boolean;
  body: Root;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Insertion".
 */
export type Insertion = NodeBase & {
  type?: "insertion";
  author?: string;
  date?: string;
  revisionId?: string;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Deletion".
 */
export type Deletion = NodeBase & {
  type?: "deletion";
  author?: string;
  date?: string;
  revisionId?: string;
  children: PhrasingContent[];
};
/**
 * A construct the IR cannot express. MUST be accompanied by a lossy diagnostic (brief section 3.3).
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Unknown".
 */
export type Unknown = NodeBase & {
  type?: "unknown";
  construct: string;
  /**
   * Raw payload, or a ResourceId when large.
   */
  raw: string;
  rawIsResourceId?: boolean;
  renderHint?: "block" | "inline" | "drop";
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Heading".
 */
export type Heading = NodeBase & {
  type?: "heading";
  /**
   * mdast-legal depth, for remark-stringify compatibility.
   */
  depth: number;
  /**
   * Semantic level; may exceed 6.
   */
  resolvedLevel: number;
  /**
   * Source-visible number such as 3.2.1, kept out of the text.
   */
  numberLabel?: string;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Blockquote".
 */
export type Blockquote = NodeBase & {
  type?: "blockquote";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "List".
 */
export type List = NodeBase & {
  type?: "list";
  ordered: boolean;
  start?: number | null;
  spread?: boolean;
  /**
   * Reference into document.numbering.
   */
  numberingId?: string;
  level?: number;
  children: ListItem[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "ListItem".
 */
export type ListItem = NodeBase & {
  type?: "listItem";
  checked?: boolean | null;
  spread?: boolean;
  /**
   * Explicit list restart preserved from the source.
   */
  restartsAt?: number;
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Code".
 */
export type Code = NodeBase & {
  type?: "code";
  lang?: string | null;
  meta?: string | null;
  filename?: string;
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "ThematicBreak".
 */
export type ThematicBreak = NodeBase & {
  type?: "thematicBreak";
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Definition".
 */
export type Definition = NodeBase & {
  type?: "definition";
  identifier: string;
  label?: string;
  url: string;
  title?: string | null;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Table".
 */
export type Table = NodeBase & {
  type?: "table";
  align?: ("left" | "right" | "center" | null)[];
  headerRowCount?: number;
  headerColCount?: number;
  children: TableRow[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "TableRow".
 */
export type TableRow = NodeBase & {
  type?: "tableRow";
  children: TableCell[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "TableCell".
 */
export type TableCell = NodeBase & {
  type?: "tableCell";
  rowSpan: number;
  colSpan: number;
  isHeader: boolean;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "FootnoteDefinition".
 */
export type FootnoteDefinition = NodeBase & {
  type?: "footnoteDefinition";
  identifier: string;
  label?: string;
  kind?: "footnote" | "endnote";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Yaml".
 */
export type Yaml = NodeBase & {
  type?: "yaml";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Toml".
 */
export type Toml = NodeBase & {
  type?: "toml";
  value: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Math".
 */
export type Math = NodeBase & {
  type?: "math";
  meta?: string | null;
  value: string;
};
/**
 * Structural grouping produced by @markforge/infer only; adapters MUST NOT emit this.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Section".
 */
export type Section = NodeBase & {
  type?: "section";
  resolvedLevel: number;
  headingId?: NodeId;
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Figure".
 */
export type Figure = NodeBase & {
  type?: "figure";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Caption".
 */
export type Caption = NodeBase & {
  type?: "caption";
  for: "figure" | "table" | "equation" | "listing";
  numberLabel?: string;
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Admonition".
 */
export type Admonition = NodeBase & {
  type?: "admonition";
  kind: "note" | "tip" | "warning" | "caution" | "important" | "custom";
  customKind?: string;
  title?: string;
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "EquationBlock".
 */
export type EquationBlock = NodeBase & {
  type?: "equationBlock";
  label?: string;
  numberLabel?: string;
  notation: "tex" | "mathml" | "omml";
  source: string;
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "DescriptionList".
 */
export type DescriptionList = NodeBase & {
  type?: "descriptionList";
  children: (DescriptionTerm | DescriptionDetails)[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "DescriptionTerm".
 */
export type DescriptionTerm = NodeBase & {
  type?: "descriptionTerm";
  children: PhrasingContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "DescriptionDetails".
 */
export type DescriptionDetails = NodeBase & {
  type?: "descriptionDetails";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "TextBox".
 */
export type TextBox = NodeBase & {
  type?: "textBox";
  anchor: "inline" | "floating";
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "PageBreak".
 */
export type PageBreak = NodeBase & {
  type?: "pageBreak";
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "ColumnBreak".
 */
export type ColumnBreak = NodeBase & {
  type?: "columnBreak";
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Slide".
 */
export type Slide = NodeBase & {
  type?: "slide";
  slideNumber: number;
  layout?: string;
  title?: string;
  notes?: Root;
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Sheet".
 */
export type Sheet = NodeBase & {
  type?: "sheet";
  name: string;
  index: number;
  /**
   * e.g. A1:H22
   */
  usedRange?: string;
  children: BlockContent[];
};
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "SourceId".
 */
export type SourceId = string;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Locator".
 */
export type Locator =
  | {
      kind: "ooxml";
      /**
       * e.g. word/document.xml
       */
      part: string;
      xpath: string;
    }
  | {
      kind: "page";
      pageNumber: number;
      bbox?: BBox;
    }
  | {
      kind: "text";
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "markdown";
      line: number;
      column: number;
      offset: number;
    }
  | {
      kind: "cell";
      sheet: string;
      ref: string;
    }
  | {
      kind: "slide";
      slideNumber: number;
      shapeId?: string;
    };
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Confidence".
 */
export type Confidence = number;
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Producer".
 */
export type Producer =
  | {
      kind: "adapter";
      name: string;
      version: string;
    }
  | {
      kind: "rule";
      /**
       * e.g. heading/font-cluster
       */
      name: string;
      version: string;
    }
  | {
      kind: "model";
      model: string;
      promptVersion: string;
    }
  | {
      kind: "ocr";
      engine: string;
      version: string;
    };

/**
 * MarkForge canonical intermediate representation, version 0.1.0. See docs/SPEC.md section 2. The semantic tree is mdast-compatible; style evidence and provenance live in id-keyed side tables (ADR-0001, ADR-0002).
 */
export interface MarkForgeDocument {
  /**
   * Semver of this schema. Consumers MUST reject a major version they do not know.
   */
  irVersion: string;
  id: NodeId;
  contentHash?: Sha256Hex;
  body: Root;
  furniture: Furniture[];
  metadata: DocumentMetadata;
  sources: {
    [k: string]: SourceFile;
  };
  resources: {
    [k: string]: Resource;
  };
  styles: {
    [k: string]: StyleDefinition;
  };
  numbering: {
    [k: string]: NumberingDefinition;
  };
  sidecar: {
    [k: string]: StyleEvidence;
  };
  provenance: {
    [k: string]: Provenance;
  };
  diagnostics: Diagnostic[];
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "NodeBase".
 */
export interface NodeBase {
  type: string;
  id: NodeId;
  position?: Position;
  /**
   * Digest of this node's subtree (docs/SPEC.md section 2.7). Present when a consumer needs change detection; never salient, since it is derived from the node's own content.
   */
  contentHash?: string;
}
/**
 * unist position, retained where the source has one.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Position".
 */
export interface Position {
  start: Point;
  end: Point;
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Point".
 */
export interface Point {
  line: number;
  column: number;
  offset?: number;
}
/**
 * Running headers, footers, page numbers. Routed here rather than dropped; see docs/SPEC.md section 2.2.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Furniture".
 */
export interface Furniture {
  kind: "header" | "footer";
  scope: "default" | "firstPage" | "evenPage" | "oddPage";
  sectionIndex: number;
  content: Root;
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "DocumentMetadata".
 */
export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  /**
   * BCP 47.
   */
  language?: string;
  /**
   * ISO 8601, from the source document only. Never the wall clock.
   */
  created?: string;
  modified?: string;
  keywords?: string[];
  pageCount?: number;
  custom?: {
    [k: string]: string;
  };
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "SourceFile".
 */
export interface SourceFile {
  sourceId: SourceId;
  /**
   * Relative to the declared root; absolute paths are forbidden (determinism).
   */
  displayPath: string;
  mediaType: string;
  contentHash: Sha256Hex;
  byteLength: number;
  adapter?: {
    name: string;
    version: string;
  };
}
/**
 * Images and embedded files, deduplicated by content hash. Never base64-inlined into the tree.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Resource".
 */
export interface Resource {
  resourceId: ResourceId;
  mediaType: string;
  contentHash: Sha256Hex;
  byteLength: number;
  /**
   * Relative path when externalized.
   */
  path?: string;
  altText?: string;
  title?: string;
  widthPx?: number;
  heightPx?: number;
}
/**
 * The source document's style vocabulary, recorded so renderers can map roles onto existing ids.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "StyleDefinition".
 */
export interface StyleDefinition {
  styleId: string;
  name?: string;
  type: "paragraph" | "character" | "table" | "numbering";
  basedOn?: string;
  next?: string;
  isDefault?: boolean;
  evidence?: StyleEvidence;
}
/**
 * Evidence about styling, not styling itself. All lengths are points. See docs/SPEC.md section 2.4.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "StyleEvidence".
 */
export interface StyleEvidence {
  sourceStyleId?: string;
  sourceStyleName?: string;
  /**
   * Resolved inheritance chain, root last.
   */
  basedOn?: string[];
  outlineLevel?: number;
  font?: {
    /**
     * Theme-resolved; never a theme token such as +mn-lt.
     */
    family?: string;
    sizePt?: number;
    weight?: number;
    italic?: boolean;
    underline?: string;
    strike?: boolean;
    smallCaps?: boolean;
    allCaps?: boolean;
    color?: string;
    highlight?: string;
  };
  paragraph?: {
    alignment?: "left" | "center" | "right" | "justify";
    indentLeftPt?: number;
    indentRightPt?: number;
    firstLineIndentPt?: number;
    spaceBeforePt?: number;
    spaceAfterPt?: number;
    lineSpacing?: {
      value: number;
      rule: "auto" | "exact" | "atLeast";
    };
    keepWithNext?: boolean;
    keepLines?: boolean;
    pageBreakBefore?: boolean;
  };
  numbering?: {
    numId?: string;
    ilvl?: number;
    format?: string;
    /**
     * e.g. %1.%2.
     */
    levelText?: string;
    startAt?: number;
    restart?: boolean;
  };
  layout?: {
    bbox: BBox;
  };
  cell?: {
    rowIndex: number;
    colIndex: number;
    rowSpan: number;
    colSpan: number;
    widthPt?: number;
    verticalMerge?: "start" | "continue";
    borders?: {
      top?: Border;
      bottom?: Border;
      left?: Border;
      right?: Border;
    };
  };
  /**
   * Innermost cascade level that supplied the values. 'directFormatting' is the signal that heading inference is needed.
   */
  origin: "styleCascade" | "directFormatting" | "layoutGeometry" | "ocr";
}
/**
 * A bounding box MUST declare its coordinate space and origin; see docs/SPEC.md section 2.4.
 *
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "BBox".
 */
export interface BBox {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  space: "pdfPoints" | "cssPixels" | "twips";
  origin: "topLeft" | "bottomLeft";
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Border".
 */
export interface Border {
  style?: string;
  widthPt?: number;
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "NumberingDefinition".
 */
export interface NumberingDefinition {
  numberingId: string;
  abstractId?: string;
  levels: {
    ilvl: number;
    format: string;
    levelText?: string;
    startAt?: number;
    restartAfterLevel?: number;
    indentLeftPt?: number;
    hangingIndentPt?: number;
    isLegal?: boolean;
  }[];
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  sourceId: SourceId;
  locator: Locator;
  confidence?: Confidence;
  producedBy: Producer;
  derivedFrom?: NodeId[];
}
/**
 * This interface was referenced by `MarkForgeDocument`'s JSON-Schema
 * via the `definition` "Diagnostic".
 */
export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  /**
   * True when information did not survive into the IR. Any lossy diagnostic sets exit code 2 under --strict.
   */
  lossy: boolean;
  nodeId?: NodeId;
  locator?: Locator;
  construct?: string;
  retained?: {
    as: "unknown" | "sidecar" | "resource";
    ref: string;
  };
  producedBy: Producer;
}
