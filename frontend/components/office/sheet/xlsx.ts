import { update as formatValue } from "@fortune-sheet/core";
import type { Cell, Sheet } from "@fortune-sheet/core";

const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * fortune-excel hands numbers back as strings without a display value. Left
 * like that, the grid shows raw serials ("45306" for a date), the status bar
 * cannot add them, and its own exporter writes them back as text. Making them
 * real numbers with a formatted ``m`` fixes all three.
 */
export function normalizeCell(cell: Cell): Cell {
  if (cell.ct?.t === "inlineStr" || cell.v == null || cell.v === "") return cell;
  let next = cell;
  const kind = cell.ct?.t;
  // Text cells arrive typed "s" or quote-prefixed (qp); only untyped/numeric ones convert.
  if (
    typeof cell.v === "string" &&
    cell.qp !== 1 &&
    (kind === undefined || kind === "n" || kind === "g") &&
    DECIMAL_RE.test(cell.v.trim())
  ) {
    next = { ...cell, v: Number(cell.v.trim()), ct: { ...(cell.ct ?? { fa: "General" }), t: "n" } };
  }
  if (next.m == null) {
    let shown: unknown;
    try {
      shown = formatValue(next.ct?.fa || "General", next.v);
    } catch {
      shown = next.v;
    }
    next = { ...next, m: shown == null ? String(next.v) : String(shown) };
  }
  return next;
}

/** Reads an .xlsx into Fortune-sheet sheets: values, formulas, styles, merges, sizes. */
export async function readXlsx(bytes: ArrayBuffer, filename: string): Promise<Sheet[]> {
  const { transformExcelToFortune } = await import("@corbe30/fortune-excel");
  let sheets: Sheet[] = [];
  // It reports through React-style setters. Its delayed column/row resize via
  // the ref is skipped (null ref): the sizes already travel in each config.
  await transformExcelToFortune(
    new File([bytes], filename),
    (parsed: Sheet[]) => {
      sheets = parsed;
    },
    () => undefined,
    { current: null },
  );
  if (!sheets.length) throw new Error("the workbook has no sheets");
  return sheets.map((sheet) => ({
    ...sheet,
    celldata: sheet.celldata?.map((d) => (d.v ? { ...d, v: normalizeCell(d.v) } : d)),
  }));
}
