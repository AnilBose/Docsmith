import { create } from "zustand";

/**
 * Word and spreadsheet files, edited in the browser.
 *
 * PDFs live on the server (lib/store.ts); these never leave the browser: the
 * file is parsed, edited and saved client-side, so they need no server memory.
 * Each open file is a tab next to the PDF tabs. The views stay mounted while
 * another tab is shown, so switching tabs never loses an edit.
 */
export type OfficeKind = "sheet" | "word";
export type OfficeFormat = "xlsx" | "csv" | "tsv" | "docx" | "new";

export interface OfficeFile {
  id: string;
  kind: OfficeKind;
  /** Shown on the tab and used as the default name when saving. */
  filename: string;
  /** Where the content came from; "new" is a blank document. */
  format: OfficeFormat;
  /** The original file, or null for a blank document. */
  bytes: ArrayBuffer | null;
}

/** What every office view receives from the shell. */
export interface OfficeViewProps {
  file: OfficeFile;
  /** False while another tab is shown (the view stays mounted, hidden). */
  active: boolean;
  /** Convert to PDF: the server lays out ``html`` and opens it in the PDF editor. */
  onOpenPdf: (html: string, filename: string) => Promise<void>;
  notify: (kind: "success" | "error" | "info", message: string) => void;
}

const SHEET_EXT = /\.(xlsx|xlsm|csv|tsv)$/i;
const WORD_EXT = /\.docx$/i;

/** Which office view opens ``filename``, or null for the PDF pipeline. */
export function officeKindFor(filename: string): OfficeKind | null {
  if (SHEET_EXT.test(filename)) return "sheet";
  if (WORD_EXT.test(filename)) return "word";
  return null;
}

function formatFor(filename: string): OfficeFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "docx") return ext;
  return "xlsx";
}

let counter = 0;

interface OfficeState {
  files: OfficeFile[];
  /** The office tab being shown, or null when a PDF tab is. */
  activeId: string | null;
  open: (filename: string, bytes: ArrayBuffer | null, kind?: OfficeKind) => OfficeFile;
  close: (id: string) => void;
  activate: (id: string | null) => void;
}

export const useOffice = create<OfficeState>((set, get) => ({
  files: [],
  activeId: null,

  open: (filename, bytes, kind) => {
    const resolved = kind ?? officeKindFor(filename) ?? "word";
    const file: OfficeFile = {
      id: `office-${Date.now().toString(36)}-${(counter += 1)}`,
      kind: resolved,
      filename,
      format: bytes ? formatFor(filename) : "new",
      bytes,
    };
    set((s) => ({ files: [...s.files, file], activeId: file.id }));
    return file;
  },

  close: (id) =>
    set((s) => {
      const files = s.files.filter((f) => f.id !== id);
      const activeId = s.activeId === id ? (files[files.length - 1]?.id ?? null) : s.activeId;
      return { files, activeId };
    }),

  activate: (id) => {
    if (id === null || get().files.some((f) => f.id === id)) set({ activeId: id });
  },
}));
