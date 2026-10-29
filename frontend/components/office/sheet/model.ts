import type { Cell, CellMatrix, Sheet } from "@fortune-sheet/core";

/** Fortune-sheet's built-in sizes, used when a sheet does not override them. */
export const DEFAULT_COL_WIDTH = 73;
export const DEFAULT_ROW_HEIGHT = 19;
export const DEFAULT_FONT_SIZE = 10;

export interface Merge {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

/** A blank workbook, as Excel starts one. */
export function blankSheet(name = "Sheet1"): Sheet {
  return { name, order: 0, status: 1, celldata: [] };
}

/** The text a cell shows: its formatted value, or the runs of a rich-text cell. */
export function cellText(cell: Cell | null | undefined): string {
  if (!cell) return "";
  if (cell.ct?.t === "inlineStr" && Array.isArray(cell.ct.s)) {
    return cell.ct.s.map((run: { v?: unknown }) => (run?.v == null ? "" : String(run.v))).join("");
  }
  const shown = cell.m ?? cell.v;
  return shown == null ? "" : String(shown);
}

/** The cell's value as a number, or null when it is not numeric. */
export function cellNumber(cell: Cell | null | undefined): number | null {
  if (!cell || cell.v == null || cell.v === "") return null;
  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : null;
  if (cell.ct?.t === "n") {
    const n = Number(cell.v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Cells that only continue a merge carry ``mc`` without a span. */
export function isMergeContinuation(cell: Cell | null | undefined): boolean {
  return !!cell?.mc && (cell.mc.rs == null || cell.mc.cs == null);
}

function hasContent(cell: Cell | null | undefined): boolean {
  if (!cell || isMergeContinuation(cell)) return false;
  return cellText(cell) !== "" || !!cell.bg;
}

/**
 * Every merge on the sheet. Fortune-sheet records them both in
 * ``config.merge`` and on the anchor cell; either may be missing after edits.
 */
export function sheetMerges(sheet: Sheet): Merge[] {
  const found = new Map<string, Merge>();
  for (const m of Object.values(sheet.config?.merge ?? {})) {
    if (m && m.rs > 0 && m.cs > 0) found.set(`${m.r}_${m.c}`, { r: m.r, c: m.c, rs: m.rs, cs: m.cs });
  }
  sheet.data?.forEach((row, r) =>
    row?.forEach((cell, c) => {
      const mc = cell?.mc;
      if (mc && mc.r === r && mc.c === c && mc.rs && mc.cs && !found.has(`${r}_${c}`)) {
        found.set(`${r}_${c}`, { r, c, rs: mc.rs, cs: mc.cs });
      }
    }),
  );
  return [...found.values()];
}

/** The bottom-right corner of everything worth printing or saving, or null for an empty sheet. */
export function usedRange(
  data: CellMatrix,
  merges: Merge[] = [],
  include: (cell: Cell | null | undefined) => boolean = hasContent,
): { rows: number; cols: number } | null {
  let lastRow = -1;
  let lastCol = -1;
  data.forEach((row, r) =>
    row?.forEach((cell, c) => {
      if (!include(cell)) return;
      if (r > lastRow) lastRow = r;
      if (c > lastCol) lastCol = c;
    }),
  );
  if (lastRow < 0) return null;
  for (const m of merges) {
    if (m.r > lastRow || m.c > lastCol) continue;
    lastRow = Math.max(lastRow, m.r + m.rs - 1);
    lastCol = Math.max(lastCol, m.c + m.cs - 1);
  }
  return { rows: lastRow + 1, cols: lastCol + 1 };
}

/**
 * The sheet the user is looking at. Fortune-sheet's own ``getSheet`` rebuilds
 * the whole cell list on every call, so the shown sheet is looked up by id.
 */
export function pickSheet(sheets: Sheet[], id: string | null): Sheet | undefined {
  return (
    (id ? sheets.find((s) => s.id === id) : undefined) ??
    sheets.find((s) => s.status === 1) ??
    sheets[0]
  );
}

/** Sheet data as a matrix, whether it was loaded (``data``) or not yet (``celldata``). */
export function sheetMatrix(sheet: Sheet): CellMatrix {
  if (sheet.data) return sheet.data;
  const matrix: CellMatrix = [];
  for (const { r, c, v } of sheet.celldata ?? []) {
    (matrix[r] ??= [])[c] = v;
  }
  for (let r = 0; r < matrix.length; r += 1) matrix[r] ??= [];
  return matrix;
}

/** ``Report.xlsx`` -> ``Report``. */
export function fileStem(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, "") || "Workbook";
}

/** Excel caps sheet names at 31 characters and forbids a few symbols. */
export function sheetNameFrom(filename: string): string {
  const cleaned = fileStem(filename).replace(/[[\]:*?/\\]/g, " ").trim();
  return cleaned.slice(0, 31) || "Sheet1";
}

export interface SelectionStats {
  /** Non-empty cells, like Excel's status-bar Count. */
  count: number;
  numbers: number;
  sum: number;
}

/** Excel's status-bar figures for the selected cells. */
export function selectionStats(blocks: (Cell | null)[][][]): SelectionStats {
  const stats: SelectionStats = { count: 0, numbers: 0, sum: 0 };
  for (const block of blocks) {
    for (const row of block) {
      for (const cell of row) {
        if (isMergeContinuation(cell) || cellText(cell) === "") continue;
        stats.count += 1;
        const n = cellNumber(cell);
        if (n !== null) {
          stats.numbers += 1;
          stats.sum += n;
        }
      }
    }
  }
  return stats;
}

/** Status-bar number: rounding noise trimmed, digits grouped. */
export function formatStat(value: number): string {
  return Number(value.toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 10 });
}
