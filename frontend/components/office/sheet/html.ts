import type { Cell, Sheet } from "@fortune-sheet/core";
import {
  DEFAULT_COL_WIDTH,
  DEFAULT_FONT_SIZE,
  DEFAULT_ROW_HEIGHT,
  type Merge,
  cellNumber,
  cellText,
  isMergeContinuation,
  sheetMatrix,
  sheetMerges,
  usedRange,
} from "./model";

/** A4 portrait less the 42pt margins the server lays HTML out with (convert.py). */
const PAGE_WIDTH_PT = 595 - 2 * 42;
/** Below this the text gets too small to read; wider sheets print in column bands instead. */
const MIN_SCALE = 0.6;
const PX_TO_PT = 0.75;

const H_ALIGN: Record<string, string> = { "0": "center", "1": "left", "2": "right" };
const V_ALIGN: Record<string, string> = { "0": "middle", "1": "top", "2": "bottom" };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Colours go into a style attribute, so only plain hex or rgb() values pass. */
export function cssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (!rgb) return null;
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
    .join("")}`;
}

interface TextStyle {
  bl?: number | string;
  it?: number | string;
  un?: number | string;
  cl?: number | string;
  fc?: string;
  fs?: number | string;
}

function textCss(style: TextStyle, scale: number): string[] {
  const css: string[] = [];
  if (Number(style.bl) === 1) css.push("font-weight:bold");
  if (Number(style.it) === 1) css.push("font-style:italic");
  const lines = [Number(style.un) >= 1 && "underline", Number(style.cl) === 1 && "line-through"];
  const decoration = lines.filter(Boolean).join(" ");
  if (decoration) css.push(`text-decoration:${decoration}`);
  const color = cssColor(style.fc);
  if (color) css.push(`color:${color}`);
  const size = Number(style.fs);
  if (size > 0) css.push(`font-size:${round(Math.min(size, 96) * scale)}pt`);
  return css;
}

function textHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
}

/** Rich-text cells keep each run's own bold/colour/size. */
function cellContent(cell: Cell, scale: number): string {
  if (cell.ct?.t === "inlineStr" && Array.isArray(cell.ct.s)) {
    return cell.ct.s
      .map((run: TextStyle & { v?: unknown }) => {
        const css = textCss(run, scale);
        const text = textHtml(run?.v == null ? "" : String(run.v));
        return css.length ? `<span style="${css.join(";")}">${text}</span>` : text;
      })
      .join("");
  }
  return textHtml(cellText(cell));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function tdHtml(
  cell: Cell | null | undefined,
  showText: boolean,
  widthPt: number,
  heightPt: number,
  scale: number,
  span: { rows: number; cols: number },
): string {
  const css = [
    `width:${round(widthPt)}pt`,
    `height:${round(heightPt)}pt`,
    "border:0.5pt solid #bfbfbf",
    `padding:${round(1 * scale)}pt ${round(2.5 * scale)}pt`,
  ];
  let body = "&nbsp;";
  if (cell) {
    const bg = cssColor(cell.bg);
    if (bg) css.push(`background-color:${bg}`);
    css.push(...textCss(cell, scale));
    if (showText) {
      const content = cellContent(cell, scale);
      if (content) body = content;
      const isNumber = cellNumber(cell) !== null;
      const align =
        H_ALIGN[String(cell.ht)] ??
        (isNumber ? "right" : typeof cell.v === "boolean" ? "center" : "left");
      css.push(`text-align:${align}`);
    }
    css.push(`vertical-align:${V_ALIGN[String(cell.vt)] ?? "bottom"}`);
  } else {
    css.push("vertical-align:bottom");
  }
  const spans =
    (span.rows > 1 ? ` rowspan="${span.rows}"` : "") + (span.cols > 1 ? ` colspan="${span.cols}"` : "");
  return `<td${spans} style="${css.join(";")}">${body}</td>`;
}

/** Splits columns into page-wide bands, as Excel prints a wide sheet across pages. */
function columnBands(cols: number[], widthOf: (c: number) => number): number[][] {
  const bands: number[][] = [];
  let band: number[] = [];
  let used = 0;
  for (const c of cols) {
    const w = widthOf(c);
    if (band.length > 0 && used + w > PAGE_WIDTH_PT + 0.01) {
      bands.push(band);
      band = [];
      used = 0;
    }
    band.push(c);
    used += w;
  }
  if (band.length) bands.push(band);
  return bands;
}

/**
 * A self-contained HTML document of the sheet's used range, for the server's
 * HTML-to-PDF engine. That engine (PyMuPDF Story) understands plain tables and
 * inline styles only, so every cell carries its own style and size. Returns
 * null when the sheet has nothing to print.
 */
export function sheetToHtml(sheet: Sheet, title: string): string | null {
  const data = sheetMatrix(sheet);
  const merges = sheetMerges({ ...sheet, data });
  const range = usedRange(data, merges);
  if (!range) return null;

  const cfg = sheet.config ?? {};
  const rows = Array.from({ length: range.rows }, (_, r) => r).filter((r) => cfg.rowhidden?.[r] == null);
  const cols = Array.from({ length: range.cols }, (_, c) => c).filter((c) => cfg.colhidden?.[c] == null);
  if (!rows.length || !cols.length) return null;

  const colPx = (c: number) => cfg.columnlen?.[c] ?? sheet.defaultColWidth ?? DEFAULT_COL_WIDTH;
  const rowPx = (r: number) => cfg.rowlen?.[r] ?? sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT;
  const totalPt = cols.reduce((sum, c) => sum + colPx(c) * PX_TO_PT, 0);
  const scale = totalPt > PAGE_WIDTH_PT ? Math.max(PAGE_WIDTH_PT / totalPt, MIN_SCALE) : 1;
  const colPt = (c: number) => colPx(c) * PX_TO_PT * scale;
  const rowPt = (r: number) => rowPx(r) * PX_TO_PT * scale;

  const mergeAt = new Map<string, Merge>();
  for (const m of merges) {
    for (let r = m.r; r < m.r + m.rs; r += 1) {
      for (let c = m.c; c < m.c + m.cs; c += 1) mergeAt.set(`${r}_${c}`, m);
    }
  }

  const tables = columnBands(cols, colPt).map((band, index) => {
    const bandFirst = band[0];
    const bandWidth = band.reduce((sum, c) => sum + colPt(c), 0);
    const trs = rows.map((r) => {
      const tds: string[] = [];
      for (const c of band) {
        const m = mergeAt.get(`${r}_${c}`);
        if (!m) {
          const cell = data[r]?.[c];
          tds.push(tdHtml(isMergeContinuation(cell) ? null : cell, true, colPt(c), rowPt(r), scale, { rows: 1, cols: 1 }));
          continue;
        }
        // A merge is drawn once, from its first visible cell in this band.
        const spanRows = rows.filter((x) => x >= m.r && x < m.r + m.rs);
        const spanCols = band.filter((x) => x >= m.c && x < m.c + m.cs);
        if (r !== spanRows[0] || c !== spanCols[0]) continue;
        const width = spanCols.reduce((sum, x) => sum + colPt(x), 0);
        const height = spanRows.reduce((sum, x) => sum + rowPt(x), 0);
        tds.push(
          tdHtml(data[m.r]?.[m.c], m.c >= bandFirst, width, height, scale, {
            rows: spanRows.length,
            cols: spanCols.length,
          }),
        );
      }
      return `<tr>${tds.join("")}</tr>`;
    });
    const breakCss = index > 0 ? "page-break-before:always;" : "";
    return (
      `<table cellspacing="0" cellpadding="0" style="${breakCss}border-collapse:collapse;` +
      `width:${round(bandWidth)}pt">${trs.join("")}</table>`
    );
  });

  const baseSize = round(DEFAULT_FONT_SIZE * scale);
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>@page{size:A4;margin:42pt}` +
    `body{margin:0;font-family:Helvetica,Arial,sans-serif;font-size:${baseSize}pt;color:#000}` +
    `table{border-collapse:collapse;border-spacing:0}td{overflow:hidden}</style></head>` +
    `<body style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:${baseSize}pt;color:#000">` +
    `${tables.join("")}</body></html>`
  );
}
