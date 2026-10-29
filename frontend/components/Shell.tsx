"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { API_PORT } from "@/lib/config";
import { officeKindFor, useOffice, type OfficeFile } from "@/lib/office";
import { useEditor } from "@/lib/store";
import type { DocumentSummary } from "@/lib/types";
import DialogHost from "./dialogs/DialogHost";
import { Icon } from "./Icons";
import PropertiesPanel from "./PropertiesPanel";
import Ribbon from "./Ribbon";
import Sidebar from "./Sidebar";
import Toolbar from "./Toolbar";
import Viewer from "./Viewer";

// The office editors are large and need the browser; load them on first use.
const OfficeLoading = () => <div className="grid flex-1 place-items-center text-2xs text-chrome-400">Loading editor…</div>;
const SpreadsheetView = dynamic(() => import("./office/SpreadsheetView"), { ssr: false, loading: OfficeLoading });
const DocumentView = dynamic(() => import("./office/DocumentView"), { ssr: false, loading: OfficeLoading });

/** Show a PDF the server just made (from a Word or spreadsheet view) in the PDF editor. */
async function showPdf(document: DocumentSummary) {
  useOffice.getState().activate(null);
  useEditor.setState((s) => ({
    doc: document,
    openDocs: [...s.openDocs.filter((d) => d.id !== document.id), document],
    currentPage: 0,
    layouts: {},
    images: {},
  }));
  const fonts = await api.fonts(document.id).catch(() => []);
  useEditor.setState({ fonts });
}

export default function Shell() {
  return (
    <DialogHost>
      <Workspace />
    </DialogHost>
  );
}

function Workspace() {
  const doc = useEditor((s) => s.doc);
  const openDocs = useEditor((s) => s.openDocs);
  const loading = useEditor((s) => s.loading);
  const busy = useEditor((s) => s.busy);
  const openFile = useEditor((s) => s.openFile);
  const switchDocument = useEditor((s) => s.switchDocument);
  const closeDocument = useEditor((s) => s.closeDocument);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const setSidebarTab = useEditor((s) => s.setSidebarTab);
  const setPage = useEditor((s) => s.setPage);
  const currentPage = useEditor((s) => s.currentPage);
  const setZoomMode = useEditor((s) => s.setZoomMode);
  const setZoom = useEditor((s) => s.setZoom);
  const officeFiles = useOffice((s) => s.files);
  const officeActiveId = useOffice((s) => s.activeId);
  const officeActive = officeActiveId !== null;

  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  /* -------------------------------------------------------------- opening */
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const file = list[0];
      try {
        const kind = officeKindFor(file.name);
        if (kind) {
          // Word, Excel and CSV open in their own editors, in the browser.
          for (const entry of list.filter((f) => officeKindFor(f.name))) {
            useOffice.getState().open(entry.name, await entry.arrayBuffer());
          }
        } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          useOffice.getState().activate(null);
          await openFile(file);
        } else {
          const result = await api.convertToPdf(list);
          await showPdf(result.document);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setPending(file);
          setPasswordError("");
        } else {
          useEditor
            .getState()
            .notify("error", error instanceof Error ? error.message : "Could not open the file.");
        }
      }
    },
    [openFile],
  );

  async function submitPassword() {
    if (!pending) return;
    try {
      await openFile(pending, password);
      setPending(null);
      setPassword("");
    } catch {
      setPasswordError("That password did not work. Try again.");
    }
  }

  // A PDF that just opened (from any dialog or conversion) should be visible.
  useEffect(() => {
    if (doc?.id) useOffice.getState().activate(null);
  }, [doc?.id]);

  /* ----------------------------------------------------------- capabilities */
  useEffect(() => {
    api
      .capabilities()
      .then((capabilities) => useEditor.setState({ capabilities }))
      .catch(() =>
        useEditor
          .getState()
          .notify(
            "error",
            `The editor service is not reachable. Start the Python backend on port ${API_PORT}.`,
          ),
      );
  }, []);

  /* -------------------------------------------------------------- shortcuts */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      const mod = event.ctrlKey || event.metaKey;
      if (useOffice.getState().activeId !== null) {
        // A Word or spreadsheet tab handles its own keys; only Open stays global.
        if (mod && event.key.toLowerCase() === "o") {
          event.preventDefault();
          fileInput.current?.click();
        }
        return;
      }
      if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) {
        if (typing) return;
        event.preventDefault();
        void undo();
      } else if (mod && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
        if (typing) return;
        event.preventDefault();
        void redo();
      } else if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSidebarTab("search");
      } else if (mod && event.key.toLowerCase() === "o") {
        event.preventDefault();
        fileInput.current?.click();
      } else if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (doc) void api.download(doc.id, doc.filename);
      } else if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        setZoom(useEditor.getState().zoom * 1.15, "custom");
      } else if (mod && event.key === "-") {
        event.preventDefault();
        setZoom(useEditor.getState().zoom / 1.15, "custom");
      } else if (mod && event.key === "0") {
        event.preventDefault();
        setZoomMode("fitPage");
      } else if (!typing && (event.key === "PageDown" || event.key === "ArrowDown")) {
        if (event.key === "PageDown") {
          event.preventDefault();
          setPage(currentPage + 1);
        }
      } else if (!typing && event.key === "PageUp") {
        event.preventDefault();
        setPage(currentPage - 1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doc, undo, redo, setSidebarTab, setPage, currentPage, setZoom, setZoomMode]);

  /* ------------------------------------------------------------------ render */
  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void handleFiles(event.dataTransfer.files);
      }}
    >
      <TitleBar
        onOpen={() => fileInput.current?.click()}
        tabs={[
          ...openDocs.map((d) => ({ id: d.id, filename: d.filename, kind: "pdf" as const })),
          ...officeFiles.map((f) => ({ id: f.id, filename: f.filename, kind: f.kind })),
        ]}
        activeId={officeActiveId ?? doc?.id ?? null}
        onSwitch={(id) => {
          if (officeFiles.some((f) => f.id === id)) {
            useOffice.getState().activate(id);
          } else {
            useOffice.getState().activate(null);
            switchDocument(id);
          }
        }}
        onClose={(id) => {
          if (officeFiles.some((f) => f.id === id)) useOffice.getState().close(id);
          else void closeDocument(id);
        }}
      />

      {/* PDF workspace; kept mounted (hidden) while a Word or spreadsheet tab is shown. */}
      <div className={officeActive ? "hidden" : "contents"}>
        <Ribbon />
        <Toolbar />

        <div className="flex min-h-0 flex-1">
          <Sidebar />
          {doc ? <Viewer /> : <StartScreen onOpen={() => fileInput.current?.click()} />}
          <PropertiesPanel />
        </div>

        <StatusBar />
      </div>

      {officeFiles.map((file) => (
        <OfficeTab key={file.id} file={file} active={file.id === officeActiveId} />
      ))}

      <input
        id="global-open-input"
        ref={fileInput}
        type="file"
        className="hidden"
        accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.csv,.tsv,.pptx,.ppt,.png,.jpg,.jpeg,.webp,.tif,.tiff,.gif,.bmp,.txt,.md,.html,.htm,.rtf,.odt"
        multiple
        onChange={(event) => {
          if (event.target.files) void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-lg border-2 border-dashed border-accent bg-chrome-900/90 px-10 py-8 text-center">
            <Icon.Open size={34} />
            <p className="mt-2 text-sm text-white">Drop to open</p>
          </div>
        </div>
      )}

      {(loading || busy) && (
        <div className="pointer-events-none fixed bottom-9 left-1/2 z-40 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full bg-chrome-800 px-3.5 py-1.5 text-2xs text-chrome-100 shadow-panel">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-chrome-500 border-t-accent" />
            {busy ?? "Opening…"}
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6">
          <form
            className="w-[380px] rounded-lg border border-chrome-700 bg-chrome-850 p-4 shadow-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPassword();
            }}
          >
            <div className="mb-2 flex items-center gap-2">
              <Icon.Lock size={18} />
              <h2 className="text-sm font-semibold text-white">Password required</h2>
            </div>
            <p className="mb-3 text-2xs leading-relaxed text-chrome-400">
              {pending.name} is encrypted. Enter the open password to edit it. The password stays
              on this machine.
            </p>
            <input
              type="password"
              autoFocus
              className="field mb-2 w-full"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {passwordError && <p className="mb-2 text-2xs text-danger">{passwordError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost flex-1"
                onClick={() => {
                  setPending(null);
                  setPassword("");
                }}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary flex-1">
                Unlock
              </button>
            </div>
          </form>
        </div>
      )}

      <Toasts />
    </div>
  );
}

/* ========================================================================== */
/** One Word or spreadsheet file; hidden, not unmounted, while another tab is shown. */
function OfficeTab({ file, active }: { file: OfficeFile; active: boolean }) {
  const props = {
    file,
    active,
    notify: (kind: "success" | "error" | "info", message: string) => useEditor.getState().notify(kind, message),
    onOpenPdf: async (html: string, filename: string) => {
      await useEditor.getState().run("Converting to PDF", async () => {
        const result = await api.htmlToPdf(html, filename);
        await showPdf(result.document);
        useEditor.getState().notify("success", `Opened ${result.document.filename} in the PDF editor`);
      });
    },
  };
  return (
    <div className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {file.kind === "sheet" ? <SpreadsheetView {...props} /> : <DocumentView {...props} />}
    </div>
  );
}

const TAB_BADGES: Record<"pdf" | "sheet" | "word", { letter: string; className: string }> = {
  pdf: { letter: "P", className: "bg-danger" },
  word: { letter: "W", className: "bg-[#2b579a]" },
  sheet: { letter: "X", className: "bg-[#217346]" },
};

function TitleBar({
  onOpen,
  tabs,
  activeId,
  onSwitch,
  onClose,
}: {
  onOpen: () => void;
  tabs: { id: string; filename: string; kind: "pdf" | "sheet" | "word" }[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-chrome-800 bg-chrome-950 px-2">
      <div className="flex items-center gap-1.5 pr-1">
        <span className="grid h-5 w-5 place-items-center rounded-sm bg-danger text-[9px] font-bold text-white">
          D
        </span>
        <span className="text-sm font-medium text-chrome-200">Docsmith</span>
      </div>

      <span className="divider" />

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((entry) => (
          <div
            key={entry.id}
            className={`group flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-t px-2.5 text-2xs transition-colors ${
              entry.id === activeId
                ? "bg-chrome-850 text-white"
                : "text-chrome-400 hover:bg-chrome-900 hover:text-chrome-200"
            }`}
          >
            <span
              className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] text-[8px] font-bold text-white ${TAB_BADGES[entry.kind].className}`}
              aria-hidden
            >
              {TAB_BADGES[entry.kind].letter}
            </span>
            <button
              type="button"
              className="min-w-0 truncate"
              onClick={() => onSwitch(entry.id)}
              title={entry.filename}
            >
              {entry.filename}
            </button>
            <button
              type="button"
              className="shrink-0 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              onClick={() => onClose(entry.id)}
              aria-label={`Close ${entry.filename}`}
            >
              <Icon.Close size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="tool-btn shrink-0"
          onClick={onOpen}
          title="Open a file (Ctrl+O)"
        >
          <Icon.Plus size={15} />
        </button>
      </div>

      <span className="chip">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        Offline · local only
      </span>
    </div>
  );
}

/* ========================================================================== */
function StartScreen({ onOpen }: { onOpen: () => void }) {
  const capabilities = useEditor((s) => s.capabilities);

  return (
    <div className="grid flex-1 place-items-center bg-canvas/40 p-8">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-chrome-850 text-chrome-300">
          <Icon.Open size={30} />
        </div>
        <h1 className="mb-2 text-xl font-semibold text-white">Open a document to begin</h1>
        <p className="mb-6 text-sm leading-relaxed text-chrome-400">
          Drop a PDF, Word, Excel or CSV file anywhere in this window, or browse for one. Word and
          spreadsheet files open in their own editors; PDFs open in the PDF editor.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="btn-primary" onClick={onOpen}>
            <Icon.Open size={16} /> Open file
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => useOffice.getState().open("Document.docx", null, "word")}
          >
            New Word document
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => useOffice.getState().open("Book1.xlsx", null, "sheet")}
          >
            New spreadsheet
          </button>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-3 text-left">
          {[
            ["Lossless editing", "Text and images are rewritten in place — no rasterizing."],
            ["Full page control", "Reorder, split, merge, rotate, number, extract."],
            ["Real redaction", "Marked content is deleted from the file and verified."],
          ].map(([title, body]) => (
            <div key={title} className="rounded border border-chrome-800 bg-chrome-900 p-3">
              <div className="mb-1 text-2xs font-semibold text-chrome-200">{title}</div>
              <div className="text-[10px] leading-relaxed text-chrome-500">{body}</div>
            </div>
          ))}
        </div>

        {capabilities && !capabilities.libreOffice && (
          <p className="mt-6 text-[10px] leading-relaxed text-chrome-500">
            Tip: install LibreOffice to also open PowerPoint and older .doc and .xls files.
          </p>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
function StatusBar() {
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const zoom = useEditor((s) => s.zoom);
  const currentPage = useEditor((s) => s.currentPage);
  const selectedSpanIds = useEditor((s) => s.selectedSpanIds);
  const selectedImage = useEditor((s) => s.selectedImage);
  const selectedPages = useEditor((s) => s.selectedPages);

  const hints: Record<string, string> = {
    select: "Click an object to select it",
    editText: "Click a paragraph to select it · double-click to edit it; the text after it reflows",
    addText: "Drag a box on the page, then type the text",
    editImage: "Drag an image to move it · pull a handle to resize",
    addImage: "Drag a box to place an image",
    highlight: "Select text on the page to highlight it",
    underline: "Select text on the page to underline it",
    strikeout: "Select text on the page to strike it through",
    comment: "Click where the note should go",
    redact: "Drag over anything that must be removed",
  };

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-chrome-800 bg-chrome-900 px-3 text-[10px] text-chrome-500">
      <span className="text-chrome-300">{hints[tool] ?? ""}</span>
      <span className="ml-auto" />
      {selectedPages.length > 0 && <span>{selectedPages.length} page(s) selected</span>}
      {selectedSpanIds.length > 0 && <span>{selectedSpanIds.length} text run(s)</span>}
      {selectedImage && (
        <span>
          image {selectedImage.width}×{selectedImage.height}
        </span>
      )}
      {doc && (
        <>
          <span>
            page {currentPage + 1} of {doc.pageCount}
          </span>
          <span>{Math.round(zoom * 100)}%</span>
        </>
      )}
    </div>
  );
}

/* ========================================================================== */
function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);

  const tone: Record<string, string> = {
    success: "border-ok/50 bg-ok/15 text-chrome-100",
    error: "border-danger/50 bg-danger/15 text-chrome-100",
    warn: "border-warn/50 bg-warn/15 text-chrome-100",
    info: "border-chrome-600 bg-chrome-800 text-chrome-100",
  };

  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-50 flex w-80 flex-col gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex animate-slide-up items-start gap-2 rounded border px-3 py-2 text-2xs shadow-panel ${tone[toast.kind]}`}
        >
          <span className="mt-px shrink-0">
            {toast.kind === "error" || toast.kind === "warn" ? (
              <Icon.Warning size={13} />
            ) : (
              <Icon.Check size={13} />
            )}
          </span>
          <span className="flex-1 leading-relaxed">{toast.message}</span>
          <button
            type="button"
            className="shrink-0 opacity-60 hover:opacity-100"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <Icon.Close size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
