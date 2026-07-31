/**
 * @markforge/adapters-office — PPTX and XLSX to IR.
 *
 * Both formats are OPC packages with WordprocessingML's sibling schemas, so both
 * are built on `@markforge/ooxml`: the same ZIP container, the same XML reader, the
 * same query helpers. That reuse is the entire argument for making `ooxml` a
 * separate package rather than burying it inside the DOCX adapter — recorded as a
 * deviation from the brief's §9 layout in `docs/OPEN_QUESTIONS.md` §7a, and this is
 * the deviation paying for itself.
 *
 * They share a package because they share a shape: one container, many sub-documents
 * (slides, sheets), each becoming a top-level IR node.
 */
export { parsePptx } from "./pptx.js";
export type { PptxParseOptions } from "./pptx.js";

export { parseXlsx, parseCellRef } from "./xlsx.js";
export type { XlsxParseOptions } from "./xlsx.js";
