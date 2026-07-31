/**
 * A minimal XML reader for OOXML parts.
 *
 * Why not an XML library: OOXML parts are machine-generated, namespace-prefixed,
 * and never contain DTDs, entities beyond the five predefined ones, or processing
 * instructions that matter to us. A general parser brings XXE handling, DTD
 * resolution, and entity expansion — attack surface we do not need on files that
 * arrive from users. This parser has no entity expansion at all, so billion-laughs
 * is not expressible.
 *
 * The one thing it must get exactly right is `xml:space="preserve"`, because
 * whitespace in `w:t` is content (docs/SPEC.md §2.8) and dropping it silently is the
 * single most common OOXML parsing bug.
 */

export interface XmlElement {
  /** Tag with prefix, e.g. `w:p`. OOXML prefixes are stable in practice. */
  name: string;
  /** Local name without the prefix, e.g. `p`. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | { text: string };

export function isElement(n: XmlNode): n is XmlElement {
  return (n as XmlElement).name !== undefined;
}

export function isText(n: XmlNode): n is { text: string } {
  return (n as { text: string }).text !== undefined;
}

const PREDEFINED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five predefined entities plus numeric character references.
 *
 * Anything else is left as literal text rather than resolved: a custom entity in an
 * OOXML part means either a corrupt file or an attack, and resolving it would be the
 * wrong response to both.
 */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return PREDEFINED[body] ?? whole;
  });
}

export function encodeEntities(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parses an XML document into a tree. Throws on malformed input. */
export function parseXml(source: string): XmlElement {
  let i = 0;
  const n = source.length;

  const skipMisc = (): void => {
    for (;;) {
      if (source.startsWith("<?", i)) {
        const end = source.indexOf("?>", i);
        if (end === -1) throw new Error("ooxml: unterminated processing instruction");
        i = end + 2;
      } else if (source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i);
        if (end === -1) throw new Error("ooxml: unterminated comment");
        i = end + 3;
      } else if (source.startsWith("<!", i)) {
        // A DOCTYPE. Skipped without resolving anything — see the file header.
        const end = source.indexOf(">", i);
        if (end === -1) throw new Error("ooxml: unterminated declaration");
        i = end + 1;
      } else if (i < n && /\s/.test(source[i]!)) {
        i++;
      } else {
        return;
      }
    }
  };

  const parseAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      while (i < n && /\s/.test(source[i]!)) i++;
      if (i >= n) throw new Error("ooxml: unexpected end of input in tag");
      const c = source[i]!;
      if (c === ">" || c === "/") return attrs;
      const nameStart = i;
      while (i < n && !/[\s=>/]/.test(source[i]!)) i++;
      const name = source.slice(nameStart, i);
      while (i < n && /\s/.test(source[i]!)) i++;
      if (source[i] !== "=") {
        // Valueless attribute: not legal XML, but present in some generators'
        // output. Recorded as empty rather than rejected, since the file is
        // otherwise readable and refusing it would lose the whole document.
        attrs[name] = "";
        continue;
      }
      i++;
      while (i < n && /\s/.test(source[i]!)) i++;
      const quote = source[i];
      if (quote !== '"' && quote !== "'") throw new Error(`ooxml: unquoted attribute ${name}`);
      i++;
      const valueStart = i;
      while (i < n && source[i] !== quote) i++;
      attrs[name] = decodeEntities(source.slice(valueStart, i));
      i++;
    }
  };

  const parseElement = (): XmlElement => {
    if (source[i] !== "<") throw new Error("ooxml: expected element");
    i++;
    const nameStart = i;
    while (i < n && !/[\s>/]/.test(source[i]!)) i++;
    const name = source.slice(nameStart, i);
    const attrs = parseAttrs();
    const colon = name.indexOf(":");
    const element: XmlElement = {
      name,
      local: colon === -1 ? name : name.slice(colon + 1),
      attrs,
      children: [],
    };

    if (source[i] === "/") {
      i += 2; // "/>"
      return element;
    }
    i++; // ">"

    for (;;) {
      if (i >= n) throw new Error(`ooxml: unclosed element <${name}>`);
      if (source.startsWith("</", i)) {
        const end = source.indexOf(">", i);
        if (end === -1) throw new Error("ooxml: unterminated close tag");
        i = end + 1;
        return element;
      }
      if (source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", i)) {
        const end = source.indexOf("]]>", i);
        const raw = source.slice(i + 9, end === -1 ? n : end);
        element.children.push({ text: raw });
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (source[i] === "<") {
        element.children.push(parseElement());
        continue;
      }
      const textStart = i;
      while (i < n && source[i] !== "<") i++;
      const raw = source.slice(textStart, i);
      // Whitespace-only text between elements is layout, not content — except
      // inside w:t, which the caller handles via xml:space. Keeping it here and
      // filtering at the call site would mean every caller has to remember to.
      if (raw.length > 0) element.children.push({ text: decodeEntities(raw) });
      continue;
    }
  };

  skipMisc();
  const root = parseElement();
  return root;
}

// --- Query helpers ---------------------------------------------------------
// Written against local names, because OOXML files in the wild use `w:`, `w14:`,
// and occasionally a default namespace for the same elements.

export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter(isElement);
}

/** Direct children with the given local name. */
export function childrenNamed(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => isElement(c) && c.local === local);
}

/** First direct child with the given local name. */
export function childNamed(el: XmlElement, local: string): XmlElement | undefined {
  for (const c of el.children) if (isElement(c) && c.local === local) return c;
  return undefined;
}

/** Follows a chain of local names, e.g. `path(root, "body", "p")`. */
export function firstByPath(el: XmlElement, ...locals: string[]): XmlElement | undefined {
  let current: XmlElement | undefined = el;
  for (const local of locals) {
    if (!current) return undefined;
    current = childNamed(current, local);
  }
  return current;
}

/** All descendants with the given local name, in document order. */
export function descendantsNamed(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    for (const c of e.children) {
      if (!isElement(c)) continue;
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * An attribute by local name, ignoring the prefix. OOXML uses `w:val` almost
 * everywhere but `r:id`, `xml:space`, and unprefixed attributes all appear.
 */
export function attr(el: XmlElement, local: string): string | undefined {
  const direct = el.attrs[local];
  if (direct !== undefined) return direct;
  for (const [k, v] of Object.entries(el.attrs)) {
    const colon = k.indexOf(":");
    if (colon !== -1 && k.slice(colon + 1) === local) return v;
  }
  return undefined;
}

/** `w:val` as a string. */
export function val(el: XmlElement | undefined): string | undefined {
  return el ? attr(el, "val") : undefined;
}

/**
 * OOXML boolean: absent element is false, present with no `w:val` is true, and
 * `w:val` of `0`/`false`/`off` is false. Getting the "present means true" case
 * wrong makes every `<w:b/>` read as not-bold.
 */
export function boolVal(el: XmlElement | undefined): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, "val");
  if (v === undefined) return true;
  return v !== "0" && v !== "false" && v !== "off";
}

export function intVal(el: XmlElement | undefined): number | undefined {
  const v = val(el);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Concatenated text of an element's descendants, honouring `xml:space`. */
export function textOf(el: XmlElement): string {
  let out = "";
  const walk = (e: XmlElement): void => {
    for (const c of e.children) {
      if (isText(c)) out += c.text;
      else walk(c);
    }
  };
  walk(el);
  return out;
}
