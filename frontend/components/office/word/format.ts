/**
 * Formatting vocabulary shared by the editor, the .docx importer/exporter and
 * the PDF/HTML output, so a font, size or colour means the same thing in all
 * four places.
 */

export interface FontChoice {
  label: string;
  /** CSS stack. Metric-compatible fallbacks (Carlito, Liberation) keep Word's
   * line breaks on machines without the Microsoft fonts. */
  css: string;
}

export const FONTS: FontChoice[] = [
  { label: "Calibri", css: "Calibri, Carlito, Arial, sans-serif" },
  { label: "Calibri Light", css: "'Calibri Light', Calibri, Carlito, Arial, sans-serif" },
  { label: "Arial", css: "Arial, 'Liberation Sans', Helvetica, sans-serif" },
  { label: "Cambria", css: "Cambria, Caladea, Georgia, serif" },
  { label: "Times New Roman", css: "'Times New Roman', 'Liberation Serif', Times, serif" },
  { label: "Georgia", css: "Georgia, 'Times New Roman', serif" },
  { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  { label: "Segoe UI", css: "'Segoe UI', Tahoma, Arial, sans-serif" },
  { label: "Courier New", css: "'Courier New', 'Liberation Mono', Courier, monospace" },
];

export const DEFAULT_FONT = FONTS[0];
/** Word's Normal style: Calibri 11 pt. */
export const DEFAULT_SIZE_PT = 11;
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** First family of a CSS font stack, unquoted: what Word calls the font. */
export function primaryFont(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** CSS stack for a Word font name, with a sensible fallback for unknown fonts. */
export function fontStack(name: string): string {
  const known = FONTS.find((f) => f.label.toLowerCase() === name.toLowerCase());
  if (known) return known.css;
  const serif = /times|roman|serif|cambria|garamond|georgia|book|minion/i.test(name);
  const mono = /courier|mono|consol/i.test(name);
  const generic = mono ? "monospace" : serif ? "Georgia, serif" : "Calibri, Carlito, Arial, sans-serif";
  return `'${name.replace(/'/g, "")}', ${generic}`;
}

/** "12pt" / "16px" -> points; anything relative is unknown. */
export function toPoints(size: string | null | undefined): number | null {
  const m = /^\s*([\d.]+)\s*(pt|px)?\s*$/i.exec(size ?? "");
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return (m[2] ?? "px").toLowerCase() === "pt" ? value : Math.round(value * 0.75 * 2) / 2;
}

/** CSS colour -> "RRGGBB" (what .docx stores), or null if unparseable. */
export function toHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return m[1].split("").map((d) => d + d).join("").toUpperCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
  if (m) {
    return [m[1], m[2], m[3]]
      .map((v) => Math.min(255, parseInt(v, 10)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return NAMED[c] ?? null;
}

const NAMED: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  gray: "808080",
  grey: "808080",
};

/**
 * Word's highlight colours. .docx highlights are named, not arbitrary, so the
 * palette offers exactly these and the exporter maps them back by hex.
 */
export const HIGHLIGHTS: Record<string, string> = {
  yellow: "#FFFF00",
  green: "#00FF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  blue: "#0000FF",
  red: "#FF0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#C0C0C0",
  black: "#000000",
};

export function highlightName(color: string | null | undefined): string | null {
  const hex = toHex(color ?? HIGHLIGHTS.yellow);
  const hit = Object.entries(HIGHLIGHTS).find(([, h]) => h.slice(1) === hex);
  return hit ? hit[0] : null;
}

/** Word's font-colour gallery: theme greys and accents, then the standard row. */
export const TEXT_COLORS = [
  "#000000", "#404040", "#7F7F7F", "#BFBFBF", "#FFFFFF",
  "#44546A", "#4472C4", "#ED7D31", "#A5A5A5", "#70AD47",
  "#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050",
  "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0",
];

/** Page size and margins of a section, in points. */
export interface PageSetup {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
}

/** A4 with Word's default 1-inch margins: the page of a new document. */
export const A4_PAGE: PageSetup = {
  widthPt: 595.3,
  heightPt: 841.9,
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
};

export const PT_TO_PX = 96 / 72;

/** Width available to content, in CSS pixels (96 dpi). */
export function contentWidthPx(page: PageSetup): number {
  return Math.floor((page.widthPt - page.marginLeftPt - page.marginRightPt) * PT_TO_PX);
}

// --------------------------------------------------------------------------- //
// Paragraph and cell formatting kept as sanitised inline CSS
// --------------------------------------------------------------------------- //

/** Paragraph properties a .docx can carry as direct formatting. */
export const BLOCK_PROPS = [
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "text-indent",
  "line-height",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "background-color",
] as const;

/** Table cell properties a .docx can carry as direct formatting. */
export const CELL_PROPS = [
  "background-color",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "vertical-align",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
] as const;

/** Lengths, colours and keywords only: no url(), expressions or quotes. */
const SAFE_VALUE = /^[#\w\s.,%()-]+$/;

export function parseDecls(css: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of (css ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

export function serializeDecls(decls: Map<string, string>): string {
  return Array.from(decls, ([k, v]) => `${k}: ${v}`).join("; ");
}

/** Keep only whitelisted properties with harmless values; null when empty. */
export function sanitizeCss(css: string | null | undefined, allowed: readonly string[]): string | null {
  const kept = new Map<string, string>();
  parseDecls(css).forEach((value, prop) => {
    if (allowed.includes(prop) && SAFE_VALUE.test(value) && !/url|expression/i.test(value)) kept.set(prop, value);
  });
  return kept.size ? serializeDecls(kept) : null;
}

/** Whitelisted properties straight from an element's inline style. */
export function styleFromElement(el: HTMLElement, allowed: readonly string[]): string | null {
  const kept = new Map<string, string>();
  for (const prop of allowed) {
    const value = el.style.getPropertyValue(prop);
    if (value) kept.set(prop, value);
  }
  return sanitizeCss(serializeDecls(kept), allowed);
}

/**
 * Word's "multiple" line spacing is relative to the font's natural line
 * height (about 1.17 em for Calibri, Cambria and Arial), CSS's to the font
 * size. Paragraphs store Word's multiple and are drawn scaled by this.
 */
export const LINE_HEIGHT_FACTOR = 1.17;

export function displayBlockCss(css: string): string {
  const decls = parseDecls(css);
  const lh = decls.get("line-height");
  if (lh && /^[\d.]+$/.test(lh)) decls.set("line-height", String(Math.round(parseFloat(lh) * LINE_HEIGHT_FACTOR * 1000) / 1000));
  return serializeDecls(decls);
}

/** Length in a CSS unit -> points (unitless counts as px, as in computed styles). */
export function cssToPt(value: string | null | undefined): number | null {
  const m = /^\s*(-?[\d.]+)\s*(pt|px|mm|cm|in)?\s*$/i.exec(value ?? "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "px").toLowerCase();
  const factor: Record<string, number> = { pt: 1, px: 0.75, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 };
  return n * factor[unit];
}

/** A CSS border shorthand ("0.75pt solid #C8C8C8") taken apart. */
export function parseBorder(value: string | null | undefined): { widthPt: number; style: string; color: string | null } | null {
  if (!value) return null;
  const color = /(#[0-9a-f]{3,8}|rgba?\([^)]*\)|\b[a-z]+\b)\s*$/i.exec(value.replace(/\b(solid|double|dashed|dotted|groove|ridge|inset|outset|none|hidden)\b/gi, " ").trim());
  const style = /\b(solid|double|dashed|dotted|groove|ridge|inset|outset|none|hidden)\b/i.exec(value)?.[1]?.toLowerCase() ?? "solid";
  const width = /(-?[\d.]+(?:pt|px|mm|cm|in))/i.exec(value)?.[1];
  return { widthPt: cssToPt(width) ?? 0.75, style, color: color ? toHex(color[1]) : null };
}
