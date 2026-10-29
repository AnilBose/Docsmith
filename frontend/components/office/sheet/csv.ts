import Papa from "papaparse";
import type { Cell, CellWithRowAndCol, Sheet } from "@fortune-sheet/core";
import { cellText, isMergeContinuation, sheetMatrix, usedRange } from "./model";

/** Plain decimals and scientific notation, the shapes Excel turns into numbers. */
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * Text that should become a number cell. Leading zeros ("007"), a leading "+"
 * (phone numbers) and more than 15 digits (IDs, card numbers) stay text: as
 * numbers they would lose characters.
 */
export function toNumber(text: string): number | null {
  const t = text.trim();
  if (!NUMBER_RE.test(t) || /^-?0\d/.test(t)) return null;
  if (t.replace(/e.*$/i, "").replace(/\D/g, "").replace(/^0+/, "").length > 15) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** CSV files come from everywhere; fall back to Windows-1252 when they are not UTF-8. */
export function decodeText(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function textCell(value: string): Cell {
  const n = toNumber(value);
  if (n !== null) return { v: n, m: String(n), ct: { fa: "General", t: "n" } };
  return { v: value, m: value, ct: { fa: "General", t: "g" } };
}

/** One sheet from delimited text; the delimiter is sniffed for CSV. */
export function parseDelimited(text: string, delimiter: "," | "\t" | "", name: string): Sheet {
  const result = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  const fatal = result.errors.find((e) => e.type !== "Delimiter");
  if (fatal && result.data.length === 0) {
    throw new Error(`${fatal.message} (row ${fatal.row ?? 0})`);
  }
  const celldata: CellWithRowAndCol[] = [];
  result.data.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value !== "") celldata.push({ r, c, v: textCell(value) });
    }),
  );
  return { name, order: 0, status: 1, celldata };
}

/** RFC 4180 field: quoted only when it has to be, quotes doubled. */
export function quoteField(value: string, delimiter: string): string {
  const needs =
    value.includes(delimiter) ||
    /["\r\n]/.test(value) ||
    (value !== value.trim() && value.length > 0);
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The sheet's used range as delimited text, written as Excel shows it
 * (formatted values, formula results). Rows end in CRLF, as Excel writes them.
 */
export function sheetToDelimited(sheet: Sheet, delimiter: "," | "\t"): string {
  const data = sheetMatrix(sheet);
  const range = usedRange(data, [], (cell) => !isMergeContinuation(cell) && cellText(cell) !== "");
  if (!range) return "";
  const lines: string[] = [];
  for (let r = 0; r < range.rows; r += 1) {
    const fields: string[] = [];
    for (let c = 0; c < range.cols; c += 1) {
      const cell = data[r]?.[c];
      fields.push(isMergeContinuation(cell) ? "" : quoteField(cellText(cell), delimiter));
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join("\r\n") + "\r\n";
}
