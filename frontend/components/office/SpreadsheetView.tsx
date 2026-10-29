"use client";

import "@fortune-sheet/react/dist/index.css";
import "./sheet.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import { locale, type Context, type Hooks, type Sheet } from "@fortune-sheet/core";
import type { transformFortuneToExcel } from "@corbe30/fortune-excel";
import { Icon } from "@/components/Icons";
import type { OfficeFile, OfficeViewProps } from "@/lib/office";
import { decodeText, parseDelimited, sheetToDelimited } from "./sheet/csv";
import { sheetToHtml } from "./sheet/html";
import { readXlsx } from "./sheet/xlsx";
import {
  type SelectionStats,
  blankSheet,
  fileStem,
  formatStat,
  pickSheet,
  selectionStats,
  sheetNameFrom,
} from "./sheet/model";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** fortune-excel types its format argument with an enum it does not export. */
type ExcelFileType = Parameters<typeof transformFortuneToExcel>[1];
/** Above this many selected cells the status bar stays quiet rather than stall the grid. */
const STATS_CELL_LIMIT = 500_000;

type Delimiter = "," | "\t";

// Fortune-sheet draws a formatted cell with no font of its own in the first
// listed font, Times New Roman; Excel's default is Calibri. The list is shared
// module state, so this runs once.
const fontList = locale({ lang: "en" } as Context).fontarray;
if (fontList[0] === "Times New Roman") {
  fontList.splice(0, 1, "Calibri");
  fontList.push("Times New Roman");
}

/** Turns the opened file into Fortune-sheet sheets. */
async function loadSheets(file: OfficeFile): Promise<Sheet[]> {
  if (!file.bytes || file.format === "new") return [blankSheet()];
  if (file.format === "csv" || file.format === "tsv") {
    const delimiter = file.format === "tsv" ? "\t" : "";
    return [parseDelimited(decodeText(file.bytes), delimiter, sheetNameFrom(file.filename))];
  }
  return readXlsx(file.bytes, file.filename);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SheetIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 9.5h17M3.5 15h17M9.5 9.5V20" />
    </svg>
  );
}

/**
 * Excel-like editor for .xlsx/.csv/.tsv, built on Fortune-sheet.
 *
 * The grid owns the workbook state; this view only seeds it once and reads it
 * back through the Workbook ref when saving or converting, so edits survive
 * while the view sits hidden behind another tab.
 */
export default function SpreadsheetView({ file, active, onOpenPdf, notify }: OfficeViewProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stats, setStats] = useState<SelectionStats | null>(null);
  const workbookRef = useRef<WorkbookInstance>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetIdRef = useRef<string | null>(null);
  const statsFrame = useRef<number | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const stem = fileStem(file.filename);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    loadSheets(file)
      .catch((error: unknown) => {
        notifyRef.current("error", `Could not open ${file.filename}: ${errorText(error)}`);
        return [blankSheet()];
      })
      .then((loaded) => {
        if (!cancelled) setSheets(loaded);
      });
    return () => {
      cancelled = true;
    };
    // The file object is replaced only when a different file is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // Fortune-sheet sizes its canvas on window resize only, and measures zero
  // while hidden, so it re-measures whenever the view is shown or resized.
  useEffect(() => {
    if (!active || !sheets) return;
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(frame);
  }, [active, sheets]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const refreshStats = useCallback(() => {
    if (statsFrame.current !== null) cancelAnimationFrame(statsFrame.current);
    statsFrame.current = requestAnimationFrame(() => {
      statsFrame.current = null;
      const workbook = workbookRef.current;
      const ranges = workbook?.getSelection() ?? [];
      const area = ranges.reduce(
        (sum, { row, column }) => sum + (row[1] - row[0] + 1) * (column[1] - column[0] + 1),
        0,
      );
      if (!workbook || area < 2 || area > STATS_CELL_LIMIT) {
        setStats(null);
        return;
      }
      try {
        const blocks = ranges.map((range) => workbook.getCellsByRange(range));
        const next = selectionStats(blocks);
        setStats(next.count > 0 ? next : null);
      } catch {
        setStats(null);
      }
    });
  }, []);

  useEffect(
    () => () => {
      if (statsFrame.current !== null) cancelAnimationFrame(statsFrame.current);
    },
    [],
  );

  // Stable identity matters: Fortune-sheet re-initialises its context when hooks change.
  const hooks = useMemo<Hooks>(
    () => ({
      afterSelectionChange: (sheetId) => {
        sheetIdRef.current = sheetId;
        refreshStats();
      },
      afterActivateSheet: (sheetId) => {
        sheetIdRef.current = sheetId;
      },
      afterUpdateCell: () => refreshStats(),
    }),
    [refreshStats],
  );

  const currentSheet = useCallback((): { sheet: Sheet; count: number } => {
    const all = workbookRef.current?.getAllSheets() ?? [];
    const sheet = pickSheet(all, sheetIdRef.current);
    if (!sheet) throw new Error("the workbook is not ready yet");
    return { sheet, count: all.length };
  }, []);

  const run = useCallback(
    async (label: string, task: () => Promise<void> | void) => {
      if (busy) return;
      setBusy(label);
      try {
        await task();
      } catch (error) {
        notify("error", `${label} failed: ${errorText(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, notify],
  );

  const saveXlsx = useCallback(
    () =>
      run("Saving", async () => {
        const { transformFortuneToExcel: exportWorkbook } = await import("@corbe30/fortune-excel");
        const blob = await exportWorkbook(workbookRef, "xlsx" as ExcelFileType, false);
        saveBlob(new Blob([blob], { type: XLSX_MIME }), `${stem}.xlsx`);
      }),
    [run, stem],
  );

  const saveDelimited = useCallback(
    (delimiter: Delimiter) =>
      run("Saving", () => {
        const { sheet, count } = currentSheet();
        const csv = delimiter === ",";
        const text = sheetToDelimited(sheet, delimiter);
        // The BOM is what makes Excel read a UTF-8 CSV as UTF-8.
        const blob = new Blob([csv ? "﻿" : "", text], {
          type: csv ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8",
        });
        saveBlob(blob, `${stem}.${csv ? "csv" : "tsv"}`);
        if (count > 1) {
          notify("info", `Saved only the "${sheet.name}" sheet: ${csv ? "CSV" : "TSV"} files hold one sheet.`);
        }
      }),
    [currentSheet, notify, run, stem],
  );

  const save = useCallback(() => {
    if (file.format === "csv") return saveDelimited(",");
    if (file.format === "tsv") return saveDelimited("\t");
    return saveXlsx();
  }, [file.format, saveDelimited, saveXlsx]);

  const convertToPdf = useCallback(
    () =>
      run("Converting", async () => {
        const { sheet } = currentSheet();
        const html = sheetToHtml(sheet, `${stem} - ${sheet.name}`);
        if (!html) {
          notify("info", `"${sheet.name}" is empty, so there is nothing to convert.`);
          return;
        }
        await onOpenPdf(html, `${stem}.pdf`);
      }),
    [currentSheet, notify, onOpenPdf, run, stem],
  );

  const ready = sheets !== null && !busy;
  const saveLabel = file.format === "csv" ? "CSV" : file.format === "tsv" ? "TSV" : "Excel workbook";

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-chrome-950" style={active ? undefined : { display: "none" }}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-chrome-800 bg-chrome-900 px-3">
        <span className="text-ok">
          <SheetIcon />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-chrome-100" title={file.filename}>
          {file.filename}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button type="button" className="btn-primary" onClick={save} disabled={!ready} title={`Save as ${saveLabel}`}>
            <Icon.Download size={15} />
            Save
          </button>
          <button type="button" className="btn-ghost" onClick={saveXlsx} disabled={!ready}>
            Save as Excel (.xlsx)
          </button>
          <button type="button" className="btn-ghost" onClick={() => saveDelimited(",")} disabled={!ready}>
            Save as CSV
          </button>
          <span className="divider" />
          <button type="button" className="btn-ghost" onClick={convertToPdf} disabled={!ready}>
            <Icon.Export size={15} />
            Convert to PDF
          </button>
        </div>
      </div>

      <div ref={hostRef} className={`relative min-h-0 flex-1 ${sheets ? "sheet-host" : ""}`}>
        {sheets ? (
          <div className="absolute inset-0">
            <Workbook key={file.id} ref={workbookRef} data={sheets} lang="en" currency="$" hooks={hooks} />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-chrome-400">
            Opening {file.filename}…
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center justify-end gap-5 border-t border-chrome-800 bg-chrome-900 px-3 text-2xs text-chrome-400">
        {busy && <span className="mr-auto">{busy}…</span>}
        {stats && stats.numbers > 0 && <span>Average: {formatStat(stats.sum / stats.numbers)}</span>}
        {stats && <span>Count: {stats.count.toLocaleString()}</span>}
        {stats && stats.numbers > 0 && <span>Sum: {formatStat(stats.sum)}</span>}
      </div>
    </div>
  );
}
