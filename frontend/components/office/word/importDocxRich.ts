import { parseAsync, renderDocument } from "docx-preview";
import { cssToPt, fontStack, primaryFont, toHex, type PageSetup } from "./format";

/**
 * .docx -> editor HTML that looks like Word.
 *
 * docx-preview resolves what makes a document look like itself: style
 * inheritance, theme fonts and colours, table styles with their header-row,
 * first-column and banding rules, shading and paragraph borders. It renders
 * into a hidden container; the computed style of every paragraph, run and
 * cell is then written inline, in the shapes the editor's extensions parse
 * (textStyle spans, highlight marks, data-block-style, data-cell-style), so
 * nothing depends on docx-preview's stylesheet once the container is gone.
 */

export interface RichImport {
  html: string;
  /** Page size and margins of the first section. */
  page: PageSetup | null;
}

const CLS = "wimport";

const OPTIONS = {
  className: CLS,
  inWrapper: false,
  breakPages: false,
  ignoreLastRenderedPageBreak: true,
  ignoreFonts: true,
  experimental: false,
  useBase64URL: true,
  renderHeaders: false,
  renderFooters: false,
  renderComments: false,
  renderChanges: false,
  renderFootnotes: true,
  renderEndnotes: true,
};

export async function importDocxRich(bytes: ArrayBuffer): Promise<RichImport> {
  const doc = await parseAsync(bytes, OPTIONS);
  // docx-preview layers a paragraph style's linked character style
  // ("Heading 1 Char") over the paragraph style itself; Word never applies it
  // to a paragraph, so those links would recolour every heading.
  for (const style of doc?.stylesPart?.styles ?? []) style.linked = null;
  const nodes: Node[] = await renderDocument(doc, OPTIONS);
  // The default paragraph style's run rules come out as ".wimport p, p.x span",
  // so unstyled paragraphs miss Normal's font and size; make it ".wimport p span".
  for (const n of nodes) {
    if (n.nodeName === "STYLE" && n.textContent) {
      n.textContent = n.textContent.replace(
        /\.wimport (\w+), (\w+)\.([\w-]+) (\w+)\s*\{/g,
        ".wimport $1 $4, $2.$3 $4 {",
      );
    }
  }

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  // Word's own fallback when a document names no font or size.
  host.style.cssText =
    "position:fixed;left:-30000px;top:0;visibility:hidden;pointer-events:none;" +
    "font-family:'Times New Roman',serif;font-size:10pt;color:#000;line-height:normal";
  nodes.forEach((n) => host.appendChild(n));
  // A row's <w:jc> places the row on the page; docx-preview renders it as the
  // row's text-align, which every cell's paragraphs would then inherit.
  host.querySelectorAll<HTMLElement>("tr").forEach((row) => row.style.removeProperty("text-align"));
  document.body.appendChild(host);
  try {
    return convert(host);
  } finally {
    host.remove();
  }
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const pt = (px: string) => {
  const v = cssToPt(px);
  return v === null ? null : Math.round(v * 100) / 100;
};
const isTransparent = (color: string) => color === "transparent" || /rgba\(.*,\s*0\)$/.test(color);

/** The editor's look for a paragraph with no direct formatting. */
const BASE = { font: "Calibri", sizePt: 11, color: "000000" };

const HEADING = /(?:^|\s)wimport_(title|heading([1-6]))(?:\s|$)/;

function headingOf(el: Element): { tag: string; title: boolean } | null {
  const m = HEADING.exec(el.className);
  if (!m) return null;
  return m[1] === "title" ? { tag: "h1", title: true } : { tag: `h${m[2]}`, title: false };
}

function borderCss(cs: CSSStyleDeclaration, side: "top" | "right" | "bottom" | "left", keepNone: boolean): string | null {
  const style = cs.getPropertyValue(`border-${side}-style`);
  const width = parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0;
  if (style === "none" || style === "hidden" || width === 0) return keepNone ? "none" : null;
  const color = toHex(cs.getPropertyValue(`border-${side}-color`)) ?? "000000";
  return `${Math.round(width * 0.75 * 100) / 100}pt ${style} #${color}`;
}

function sides(cs: CSSStyleDeclaration, prop: "margin" | "padding", names: ("top" | "right" | "bottom" | "left")[], out: string[], always = false) {
  for (const side of names) {
    const v = pt(cs.getPropertyValue(`${prop}-${side}`));
    if (v !== null && (always || v !== 0)) out.push(`${prop}-${side}: ${v}pt`);
  }
}

/** Paragraph formatting as the editor's blockStyle CSS. */
function blockStyle(p: HTMLElement, cs: CSSStyleDeclaration, inList: boolean): string {
  const out: string[] = [];
  sides(cs, "margin", ["top", "bottom"], out, true);
  if (!inList) {
    sides(cs, "margin", ["left", "right"], out);
    const indent = pt(cs.textIndent);
    if (indent) out.push(`text-indent: ${indent}pt`);
  }
  // Computed line-height is in px against the paragraph's own font size;
  // the ratio recovers Word's "multiple".
  const lh = parseFloat(cs.lineHeight);
  const fs = parseFloat(cs.fontSize);
  if (lh && fs) out.push(`line-height: ${Math.round((lh / fs) * 100) / 100}`);
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const b = borderCss(cs, side, false);
    if (b) out.push(`border-${side}: ${b}`);
  }
  sides(cs, "padding", ["top", "bottom", "left", "right"], out);
  if (!isTransparent(cs.backgroundColor)) out.push(`background-color: #${toHex(cs.backgroundColor)}`);
  return out.join("; ");
}

function alignOf(cs: CSSStyleDeclaration): string | null {
  const a = cs.textAlign;
  if (a === "center" || a === "right" || a === "justify") return a;
  if (a === "end") return "right";
  return null;
}

// --------------------------------------------------------------------------- //
// Conversion
// --------------------------------------------------------------------------- //

interface ListItem {
  level: number;
  ordered: boolean;
  html: string;
}

function convert(host: HTMLElement): RichImport {
  const sections = Array.from(host.querySelectorAll<HTMLElement>(`section.${CLS}`));
  let page: PageSetup | null = null;
  if (sections[0]) {
    const cs = getComputedStyle(sections[0]);
    const w = pt(cs.width);
    const h = pt(cs.minHeight);
    if (w && h) {
      page = {
        widthPt: w,
        heightPt: h,
        marginTopPt: pt(cs.paddingTop) ?? 72,
        marginRightPt: pt(cs.paddingRight) ?? 72,
        marginBottomPt: pt(cs.paddingBottom) ?? 72,
        marginLeftPt: pt(cs.paddingLeft) ?? 72,
      };
    }
  }
  const html = sections
    .map((s) => blocks(Array.from(s.querySelectorAll<HTMLElement>(":scope > article > *, :scope > ol"))))
    .join("");
  return { html: html || "<p></p>", page };
}

/** A run of sibling blocks; consecutive numbered paragraphs become lists. */
function blocks(elements: Element[]): string {
  let out = "";
  let list: ListItem[] = [];
  let listId: string | null = null;
  const flush = () => {
    if (list.length) out += renderList(list);
    list = [];
    listId = null;
  };

  for (const el of elements) {
    if (!(el instanceof HTMLElement) || getComputedStyle(el).display === "none") continue;
    if (el.tagName === "P") {
      const num = /(?:^|\s)wimport-num-(\d+)-(\d+)(?:\s|$)/.exec(el.className);
      if (num) {
        const before = getComputedStyle(el, "::before").content;
        const level = Number(num[2]);
        // A new list starts when its numbering definition changes at the top level.
        if (listId !== null && listId !== num[1] && level === 0) flush();
        listId = num[1];
        list.push({ level, ordered: before.includes("counter("), html: paragraph(el, true) });
        continue;
      }
      flush();
      out += paragraph(el, false);
    } else if (el.tagName === "TABLE") {
      flush();
      out += table(el as HTMLTableElement);
    } else if (el.tagName === "OL" || el.tagName === "UL") {
      // Footnotes and endnotes.
      flush();
      const items = Array.from(el.children).map((li) => `<li>${blocks(Array.from(li.children)) || "<p></p>"}</li>`);
      out += `<${el.tagName.toLowerCase()}>${items.join("")}</${el.tagName.toLowerCase()}>`;
    } else {
      flush();
      out += blocks(Array.from(el.children));
    }
  }
  flush();
  return out;
}

function renderList(items: ListItem[]): string {
  const stack: { level: number; tag: string }[] = [];
  let out = "";
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    while (stack.length && stack[stack.length - 1].level > item.level) out += `</li></${stack.pop()!.tag}>`;
    const top = stack[stack.length - 1];
    if (top && top.level === item.level) {
      out += "</li>";
      if (top.tag !== tag) {
        out += `</${top.tag}><${tag}>`;
        top.tag = tag;
      }
    } else {
      out += `<${tag}>`;
      stack.push({ level: item.level, tag });
    }
    out += `<li>${item.html}`;
  }
  while (stack.length) out += `</li></${stack.pop()!.tag}>`;
  return out;
}

function paragraph(p: HTMLElement, inList: boolean): string {
  const cs = getComputedStyle(p);
  const heading = inList ? null : headingOf(p);
  const tag = heading?.tag ?? "p";
  const attrs: string[] = [];
  if (heading?.title) attrs.push('class="doc-title"');
  attrs.push(`data-block-style="${esc(blockStyle(p, cs, inList))}"`);
  const align = alignOf(cs);
  if (align) attrs.push(`style="text-align: ${align}"`);
  return `<${tag} ${attrs.join(" ")}>${inline(p, !!heading)}</${tag}>`;
}

interface Segment {
  text: string;
  key: string;
  open: string;
  close: string;
}

/** Runs of a paragraph as nested editor marks, merging neighbours that match. */
function inline(p: HTMLElement, heading: boolean): string {
  const segments: Segment[] = [];
  let out = "";
  const flushText = () => {
    let i = 0;
    while (i < segments.length) {
      const s = segments[i];
      let text = s.text;
      while (i + 1 < segments.length && segments[i + 1].key === s.key) text += segments[++i].text;
      out += s.open + esc(text) + s.close;
      i += 1;
    }
    segments.length = 0;
  };

  const walk = (node: Node, link: string | null) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text) segments.push(segment(text, node.parentElement ?? p, p, heading, link));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || getComputedStyle(node).display === "none") return;
    if (tag === "BR") {
      flushText();
      out += "<br>";
      return;
    }
    if (tag === "IMG") {
      flushText();
      out += image(node as HTMLImageElement);
      return;
    }
    // A tab is an em space in a span of its own, nested in its run's span.
    if (
      tag === "SPAN" &&
      node.childNodes.length === 1 &&
      node.textContent === " " &&
      !node.className &&
      node.parentElement?.tagName === "SPAN"
    ) {
      segments.push(segment("\t", node.parentElement, p, heading, link));
      return;
    }
    const href = tag === "A" ? (node as HTMLAnchorElement).getAttribute("href") : null;
    node.childNodes.forEach((child) => walk(child, href || link));
  };

  p.childNodes.forEach((child) => walk(child, null));
  flushText();
  return out;
}

function segment(text: string, el: HTMLElement, p: HTMLElement, heading: boolean, link: string | null): Segment {
  const cs = getComputedStyle(el);
  const open: string[] = [];
  const close: string[] = [];
  const wrap = (o: string, c: string) => {
    open.push(o);
    close.unshift(c);
  };

  // Decorations are not inherited in computed style; look up to the paragraph.
  let underline = false;
  let strike = false;
  let background: string | null = null;
  for (let e: HTMLElement | null = el; e && e !== p.parentElement; e = e.parentElement) {
    const ecs = e === el ? cs : getComputedStyle(e);
    const deco = ecs.textDecorationLine;
    if (e.tagName !== "A") underline ||= deco.includes("underline");
    strike ||= deco.includes("line-through");
    if (!background && e !== p && !isTransparent(ecs.backgroundColor)) background = toHex(ecs.backgroundColor);
    if (e === p) break;
  }

  if (link) wrap(`<a href="${esc(link)}">`, "</a>");
  if (parseInt(cs.fontWeight, 10) >= 600) wrap("<strong>", "</strong>");
  if (cs.fontStyle === "italic" || cs.fontStyle === "oblique") wrap("<em>", "</em>");
  if (underline) wrap("<u>", "</u>");
  if (strike) wrap("<s>", "</s>");
  if (background) wrap(`<mark data-color="#${background}">`, "</mark>");

  const styles: string[] = [];
  const color = toHex(cs.color) ?? BASE.color;
  const family = primaryFont(cs.fontFamily);
  const sizePt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
  // Plain paragraphs already draw in the editor's base look; headings have
  // their own stylesheet, so their real look always goes inline.
  if (heading || color !== BASE.color) styles.push(`color: #${color}`);
  if (family && (heading || family.toLowerCase() !== BASE.font.toLowerCase())) styles.push(`font-family: ${fontStack(family)}`);
  if (sizePt && (heading || sizePt !== BASE.sizePt)) styles.push(`font-size: ${sizePt}pt`);
  if (styles.length) wrap(`<span style="${esc(styles.join("; "))}">`, "</span>");

  return { text, key: open.join(""), open: open.join(""), close: close.join("") };
}

function image(img: HTMLImageElement): string {
  const src = img.getAttribute("src") ?? "";
  if (!src.startsWith("data:")) return "";
  const cs = getComputedStyle(img);
  const w = parseFloat(cs.width);
  const h = parseFloat(cs.height);
  const size = w > 0 && h > 0 ? ` width="${Math.round(w)}" height="${Math.round(h)}"` : "";
  const alt = img.getAttribute("alt");
  return `<img src="${esc(src)}"${size}${alt ? ` alt="${esc(alt)}"` : ""}>`;
}

function table(t: HTMLTableElement): string {
  const cols = Array.from(t.querySelectorAll<HTMLElement>(":scope > colgroup > col")).map((c) => {
    const v = cssToPt(c.style.width);
    return v ? Math.round(v * (96 / 72)) : null;
  });
  const tableBg = getComputedStyle(t).backgroundColor;
  const align =
    t.style.marginLeft === "auto" ? (t.style.marginRight === "auto" ? "center" : "right") : null;

  // Grid occupancy, so a cell's first column is known under row spans.
  const taken: boolean[][] = [];
  const rows = Array.from(t.rows).map((tr, r) => {
    const rowBg = getComputedStyle(tr).backgroundColor;
    let col = 0;
    const cells = Array.from(tr.cells)
      .filter((td) => getComputedStyle(td).display !== "none")
      .map((td) => {
        while (taken[r]?.[col]) col += 1;
        const colspan = Math.max(1, td.colSpan || 1);
        const rowspan = Math.max(1, td.rowSpan || 1);
        for (let dr = 0; dr < rowspan; dr += 1) {
          for (let dc = 0; dc < colspan; dc += 1) (taken[r + dr] ??= [])[col + dc] = true;
        }
        const widths = cols.slice(col, col + colspan);
        col += colspan;

        const cs = getComputedStyle(td);
        const css: string[] = [];
        const bg = [cs.backgroundColor, rowBg, tableBg].find((c) => !isTransparent(c));
        if (bg) css.push(`background-color: #${toHex(bg)}`);
        for (const side of ["top", "bottom", "left", "right"] as const) css.push(`border-${side}: ${borderCss(cs, side, true)}`);
        const va = cs.verticalAlign;
        css.push(`vertical-align: ${va === "middle" || va === "bottom" ? va : "top"}`);
        sides(cs, "padding", ["top", "bottom", "left", "right"], css, true);

        const attrs = [`data-cell-style="${esc(css.join("; "))}"`];
        if (colspan > 1) attrs.push(`colspan="${colspan}"`);
        if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
        if (widths.length === colspan && widths.every((w) => w)) attrs.push(`colwidth="${widths.join(",")}"`);
        const content = blocks(Array.from(td.children)) || "<p></p>";
        return `<td ${attrs.join(" ")}>${content}</td>`;
      });
    return `<tr>${cells.join("")}</tr>`;
  });
  const alignAttr = align ? ` data-align="${align}"` : "";
  return `<table${alignAttr}><tbody>${rows.join("")}</tbody></table>`;
}
