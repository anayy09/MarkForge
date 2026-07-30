/**
 * @markforge/ooxml — the shared OOXML reader.
 *
 * Its own package because ADR-0005's reader is used by three adapters (docx, xlsx,
 * pptx) and duplicating a style-cascade resolver three times guarantees three
 * subtly different cascades. Recorded as a deviation from the brief's §9 package
 * layout in docs/OPEN_QUESTIONS.md §7a.
 */
export {
  parseXml,
  decodeEntities,
  encodeEntities,
  isElement,
  isText,
  childElements,
  childrenNamed,
  childNamed,
  firstByPath,
  descendantsNamed,
  attr,
  val,
  boolVal,
  intVal,
  textOf,
} from "./xml.js";
export type { XmlElement, XmlNode } from "./xml.js";

export {
  OpcPackage,
  Part,
  RelType,
  parseRelationships,
  resolveTarget,
} from "./package.js";
export type { Relationship } from "./package.js";

export {
  resolveStyle,
  readProperties,
  parseStyles,
  parseDocDefaults,
  parseTheme,
  resolveThemeFont,
  layer,
} from "./cascade.js";
export type {
  CascadeInput,
  ResolveRequest,
  ResolvedStyle,
  ThemeFonts,
} from "./cascade.js";

export { parseNumbering, resolveListItem, isOrderedFormat } from "./numbering.js";
export type { ParsedNumbering, ListItemInfo } from "./numbering.js";
