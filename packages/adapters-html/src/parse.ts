/**
 * A small, forgiving HTML parser.
 *
 * Not jsdom, and not a browser DOM. `docs/adr/0015-browser-build-boundaries.md`
 * requires the deterministic core to run identically in Node and in a browser, and
 * jsdom is both large and Node-only. A parser that handles the subset of HTML that
 * actually appears in documents — the output of Word, Google Docs, and every
 * Markdown renderer — is a few hundred lines and has no such constraint.
 *
 * "Forgiving" means specific things, each of which appears in real files:
 *   - void elements never need closing
 *   - optional end tags (`<li>`, `<p>`, `<td>`) are implied by the next opener
 *   - unclosed tags at EOF close themselves rather than throwing
 *   - `<script>` and `<style>` contents are raw text, not markup
 */

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlElement | { text: string };

export const isElement = (n: HtmlNode): n is HtmlElement => (n as HtmlElement).tag !== undefined;
export const isText = (n: HtmlNode): n is { text: string } => (n as { text: string }).text !== undefined;

/** Elements that never have children and never need a closing tag. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is raw text rather than markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/**
 * Which open elements a new start tag implicitly closes.
 *
 * This is the table that makes `<li>a<li>b` parse as two siblings rather than
 * nesting the second inside the first. Real HTML omits these end tags constantly,
 * and a parser that requires them produces a tree that is wrong rather than one
 * that fails loudly — which is worse.
 */
const IMPLIED_END: Record<string, Set<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  p: new Set(["p"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  tr: new Set(["td", "th", "tr"]),
  tbody: new Set(["td", "th", "tr", "thead", "tbody"]),
  thead: new Set(["td", "th", "tr"]),
  tfoot: new Set(["td", "th", "tr", "thead", "tbody"]),
  option: new Set(["option"]),
};

/** Block elements that implicitly close an open `<p>`. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω",
  bull: "•", dagger: "†", Dagger: "‡", permil: "‰", euro: "€", pound: "£", yen: "¥",
  shy: "­", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  let i = 0;

  const top = (): HtmlElement => stack[stack.length - 1]!;

  const closeUpTo = (tag: string): void => {
    // Close the nearest matching open element. Only unwinds if the tag is actually
    // open — a stray `</div>` in real-world HTML must not close the document.
    const index = stack.findLastIndex((e) => e.tag === tag);
    if (index > 0) stack.length = index;
  };

  while (i < source.length) {
    if (source[i] === "<") {
      if (source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith("<!", i) || source.startsWith("<?", i)) {
        const end = source.indexOf(">", i);
        i = end === -1 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("</", i)) {
        const end = source.indexOf(">", i);
        const tag = source.slice(i + 2, end === -1 ? source.length : end).trim().toLowerCase();
        closeUpTo(tag);
        i = end === -1 ? source.length : end + 1;
        continue;
      }

      // Start tag.
      const match = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source.slice(i));
      if (!match) {
        // A `<` that does not begin a tag is literal text, which is common in
        // hand-written HTML and must not derail the parse.
        appendText(top(), "<");
        i++;
        continue;
      }
      const tag = match[1]!.toLowerCase();
      let j = i + match[0].length;
      const attrs: Record<string, string> = {};

      while (j < source.length && source[j] !== ">") {
        if (source[j] === "/" ) { j++; continue; }
        if (/\s/.test(source[j]!)) { j++; continue; }
        const nameStart = j;
        while (j < source.length && !/[\s=>/]/.test(source[j]!)) j++;
        const name = source.slice(nameStart, j).toLowerCase();
        while (j < source.length && /\s/.test(source[j]!)) j++;
        if (source[j] === "=") {
          j++;
          while (j < source.length && /\s/.test(source[j]!)) j++;
          const quote = source[j];
          if (quote === '"' || quote === "'") {
            j++;
            const valueStart = j;
            while (j < source.length && source[j] !== quote) j++;
            attrs[name] = decodeEntities(source.slice(valueStart, j));
            j++;
          } else {
            const valueStart = j;
            while (j < source.length && !/[\s>]/.test(source[j]!)) j++;
            attrs[name] = decodeEntities(source.slice(valueStart, j));
          }
        } else {
          // Bare attribute such as `disabled`. HTML treats it as present-and-empty.
          attrs[name] = "";
        }
      }

      const selfClosing = source[j - 1] === "/";
      i = j + 1;

      // Implied end tags, before the new element is pushed.
      const implied = IMPLIED_END[tag];
      if (implied && implied.has(top().tag)) closeUpTo(top().tag);
      if (CLOSES_P.has(tag) && top().tag === "p") closeUpTo("p");

      const element: HtmlElement = { tag, attrs, children: [] };
      top().children.push(element);

      if (VOID.has(tag) || selfClosing) continue;

      if (RAW_TEXT.has(tag)) {
        const close = source.toLowerCase().indexOf(`</${tag}`, i);
        const end = close === -1 ? source.length : close;
        const raw = source.slice(i, end);
        if (raw.length > 0) element.children.push({ text: raw });
        i = close === -1 ? source.length : source.indexOf(">", close) + 1;
        continue;
      }

      stack.push(element);
      continue;
    }

    const nextTag = source.indexOf("<", i);
    const end = nextTag === -1 ? source.length : nextTag;
    appendText(top(), decodeEntities(source.slice(i, end)));
    i = end;
  }

  // Anything still open at EOF closes itself. Throwing here would reject files that
  // every browser renders fine.
  return root;
}

function appendText(parent: HtmlElement, text: string): void {
  if (text === "") return;
  const last = parent.children[parent.children.length - 1];
  if (last && isText(last)) last.text += text;
  else parent.children.push({ text });
}

// --- Query helpers ---------------------------------------------------------

export function childrenNamed(el: HtmlElement, tag: string): HtmlElement[] {
  return el.children.filter((c): c is HtmlElement => isElement(c) && c.tag === tag);
}

export function descendantsNamed(el: HtmlElement, tag: string): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (e: HtmlElement): void => {
    for (const c of e.children) {
      if (!isElement(c)) continue;
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export function textOf(node: HtmlNode): string {
  if (isText(node)) return node.text;
  let out = "";
  for (const c of node.children) out += textOf(c);
  return out;
}
