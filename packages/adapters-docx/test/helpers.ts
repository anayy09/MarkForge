/**
 * Builds minimal DOCX packages in memory for adapter tests.
 *
 * Authored rather than committed as binaries: a fixture whose XML is visible in the
 * test file makes a failure readable, and docs/CORPUS.md rule 3 prefers authored
 * fixtures precisely because we control exactly which construct is under test.
 */
import { OpcPackage } from "@markforge/ooxml";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface DocxParts {
  body: string;
  styles?: string;
  numbering?: string;
  theme?: string | null;
  rels?: string;
  extra?: Record<string, Uint8Array | string>;
  coreProps?: string;
}

export const DEFAULT_STYLES = `<w:styles ${W}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="+mn-lt"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:sz w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
  </w:style>
  <w:style w:type="character" w:styleId="VerbatimChar">
    <w:name w:val="Verbatim Char"/>
  </w:style>
</w:styles>`;

export const DEFAULT_NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="0"/>
    <w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>
</w:numbering>`;

export const DEFAULT_THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
  </a:fontScheme></a:themeElements></a:theme>`;

export function buildDocx(parts: DocxParts): Uint8Array {
  const pkg = OpcPackage.create();
  const put = (path: string, content: string | Uint8Array): void => pkg.set(path, content);

  put(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Default Extension="tiff" ContentType="image/tiff"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  put(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  put("word/document.xml", `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${parts.body}</w:body></w:document>`);
  put("word/styles.xml", parts.styles ?? DEFAULT_STYLES);
  put("word/numbering.xml", parts.numbering ?? DEFAULT_NUMBERING);
  if (parts.theme !== null) put("word/theme/theme1.xml", parts.theme ?? DEFAULT_THEME);
  put(
    "word/_rels/document.xml.rels",
    parts.rels ??
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );
  if (parts.coreProps) put("docProps/core.xml", parts.coreProps);
  for (const [path, content] of Object.entries(parts.extra ?? {})) put(path, content);

  return pkg.toBytes();
}

/** A `w:p` with plain text. */
export function p(text: string, opts: { style?: string; numId?: string; ilvl?: number } = {}): string {
  const pPr =
    opts.style || opts.numId
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${
          opts.numId
            ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
            : ""
        }</w:pPr>`
      : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
