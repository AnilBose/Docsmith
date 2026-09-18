"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useEditor } from "@/lib/store";
import type { PermissionFlags } from "@/lib/types";
import { Icon } from "../Icons";

export type DialogId =
  | "protect"
  | "split"
  | "numbering"
  | "cover"
  | "compress"
  | "import"
  | "unlock"
  | null;

interface DialogApi {
  open: (id: Exclude<DialogId, null>) => void;
  close: () => void;
}

const DialogContext = createContext<DialogApi>({ open: () => undefined, close: () => undefined });
export const useDialogs = () => useContext(DialogContext);

/* -------------------------------------------------------------------------- */
function Modal({
  title,
  onClose,
  children,
  width = 420,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/55 p-6"
      onMouseDown={onClose}
    >
      <div
        className="animate-slide-up rounded-lg border border-chrome-700 bg-chrome-850 shadow-panel"
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-chrome-800 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button type="button" className="tool-btn" onClick={onClose} aria-label="Close">
            <Icon.Close size={16} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-2xs uppercase tracking-wider text-chrome-400">{label}</span>
      {children}
    </label>
  );
}

/* ========================================================================== */
export default function DialogHost({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogId>(null);
  const value = useMemo<DialogApi>(
    () => ({ open: (id) => setDialog(id), close: () => setDialog(null) }),
    [],
  );
  const close = useCallback(() => setDialog(null), []);

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog === "protect" && <ProtectDialog onClose={close} />}
      {dialog === "split" && <SplitDialog onClose={close} />}
      {dialog === "numbering" && <NumberingDialog onClose={close} />}
      {dialog === "cover" && <CoverDialog onClose={close} />}
      {dialog === "compress" && <CompressDialog onClose={close} />}
      {dialog === "import" && <ImportDialog onClose={close} />}
    </DialogContext.Provider>
  );
}

/* ========================================================================== */
function ProtectDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const run = useEditor((s) => s.run);
  const notify = useEditor((s) => s.notify);

  const [openPassword, setOpenPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [algorithm, setAlgorithm] = useState("aes-256");
  const [permissions, setPermissions] = useState<PermissionFlags>({
    printDocument: true,
    printHighResolution: true,
    copyContent: true,
    modifyContent: true,
    modifyAnnotations: true,
    fillForms: true,
    accessibility: true,
    assembleDocument: true,
  });

  const labels: [keyof PermissionFlags, string][] = [
    ["printDocument", "Allow printing"],
    ["printHighResolution", "Allow high-resolution printing"],
    ["copyContent", "Allow copying text and images"],
    ["modifyContent", "Allow editing content"],
    ["modifyAnnotations", "Allow commenting"],
    ["fillForms", "Allow filling forms"],
    ["assembleDocument", "Allow page assembly"],
    ["accessibility", "Allow screen readers"],
  ];

  return (
    <Modal title="Protect document" onClose={onClose} width={460}>
      <Field label="Open password (required to view)">
        <input
          type="password"
          className="field w-full"
          value={openPassword}
          onChange={(event) => setOpenPassword(event.target.value)}
          placeholder="Leave blank for no open password"
        />
      </Field>
      <Field label="Owner password (required to change permissions)">
        <input
          type="password"
          className="field w-full"
          value={ownerPassword}
          onChange={(event) => setOwnerPassword(event.target.value)}
        />
      </Field>
      <Field label="Encryption">
        <select
          className="field w-full"
          value={algorithm}
          onChange={(event) => setAlgorithm(event.target.value)}
        >
          <option value="aes-256">AES-256 (recommended)</option>
          <option value="aes-128">AES-128</option>
          <option value="rc4-128">RC4-128 (legacy readers only)</option>
        </select>
      </Field>

      <div className="mb-3 space-y-1 rounded border border-chrome-800 p-2.5">
        {labels.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-2xs text-chrome-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-accent"
              checked={permissions[key]}
              onChange={(event) =>
                setPermissions({ ...permissions, [key]: event.target.checked })
              }
            />
            {label}
          </label>
        ))}
      </div>

      <p className="mb-3 flex gap-2 rounded border border-warn/40 bg-warn/10 p-2.5 text-[10px] leading-relaxed text-chrome-300">
        <Icon.Warning size={14} />
        <span>
          Permission flags are advisory: a conforming reader honours them, but they are not
          enforced cryptographically. Only the open password actually restricts access to the
          content.
        </span>
      </p>

      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() =>
            doc &&
            void run("Encrypting", async () => {
              await api.protect(doc.id, {
                openPassword,
                ownerPassword,
                algorithm,
                permissions,
              });
              notify("success", "Encrypted copy downloaded.");
              onClose();
            })
          }
        >
          Encrypt &amp; download
        </button>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
function SplitDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const run = useEditor((s) => s.run);
  const notify = useEditor((s) => s.notify);
  const [every, setEvery] = useState(1);

  return (
    <Modal title="Split document" onClose={onClose}>
      <Field label="Pages per part">
        <input
          type="number"
          min={1}
          max={doc?.pageCount ?? 1}
          className="field w-full"
          value={every}
          onChange={(event) => setEvery(Number(event.target.value))}
        />
      </Field>
      <p className="mb-3 text-2xs text-chrome-500">
        Each part opens as its own document, ready to download separately.
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() =>
            doc &&
            void run("Splitting", async () => {
              const result = await api.splitPages(doc.id, every);
              useEditor.setState((s) => ({ openDocs: [...s.openDocs, ...result.parts] }));
              notify("success", `Split into ${result.parts.length} document(s)`);
              onClose();
            })
          }
        >
          Split
        </button>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
function NumberingDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);

  const [position, setPosition] = useState("bottom-center");
  const [template, setTemplate] = useState("{n}");
  const [style, setStyle] = useState("arabic");
  const [startAt, setStartAt] = useState(1);
  const [fontSize, setFontSize] = useState(10);
  const [color, setColor] = useState("#000000");
  const [skipFirst, setSkipFirst] = useState(false);

  return (
    <Modal title="Add page numbers" onClose={onClose}>
      <Field label="Position">
        <select
          className="field w-full"
          value={position}
          onChange={(event) => setPosition(event.target.value)}
        >
          {["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"].map(
            (option) => (
              <option key={option} value={option}>
                {option.replace("-", " ")}
              </option>
            ),
          )}
        </select>
      </Field>
      <Field label="Format — {n} is the number, {total} the count">
        <input
          className="field w-full"
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Numbering">
          <select
            className="field w-full"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
          >
            <option value="arabic">1, 2, 3</option>
            <option value="roman">i, ii, iii</option>
            <option value="ROMAN">I, II, III</option>
            <option value="alpha">a, b, c</option>
            <option value="ALPHA">A, B, C</option>
          </select>
        </Field>
        <Field label="Start at">
          <input
            type="number"
            min={1}
            className="field w-full"
            value={startAt}
            onChange={(event) => setStartAt(Number(event.target.value))}
          />
        </Field>
        <Field label="Size">
          <input
            type="number"
            min={4}
            max={72}
            className="field w-full"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            className="h-7 w-full cursor-pointer rounded border border-chrome-700 bg-chrome-900"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </Field>
      </div>
      <label className="mb-3 flex items-center gap-2 text-2xs text-chrome-300">
        <input
          type="checkbox"
          className="h-3 w-3 accent-accent"
          checked={skipFirst}
          onChange={(event) => setSkipFirst(event.target.checked)}
        />
        Skip the first page (cover)
      </label>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() =>
            doc &&
            void run("Numbering pages", async () => {
              const result = await api.addPageNumbers(doc.id, {
                position,
                template,
                style,
                startAt,
                fontSize,
                color,
                skipFirst,
              });
              setDocument(result.document);
              onClose();
            })
          }
        >
          Add numbers
        </button>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
function CoverDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [atEnd, setAtEnd] = useState(false);

  return (
    <Modal title={atEnd ? "Add end page" : "Add cover page"} onClose={onClose}>
      <Field label="Title">
        <input
          className="field w-full"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field label="Subtitle">
        <input
          className="field w-full"
          value={subtitle}
          onChange={(event) => setSubtitle(event.target.value)}
        />
      </Field>
      <label className="mb-3 flex items-center gap-2 text-2xs text-chrome-300">
        <input
          type="checkbox"
          className="h-3 w-3 accent-accent"
          checked={atEnd}
          onChange={(event) => setAtEnd(event.target.checked)}
        />
        Add at the end instead of the beginning
      </label>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() =>
            doc &&
            void run("Adding page", async () => {
              const result = await api.addCover(doc.id, title, subtitle, atEnd);
              setDocument(result.document);
              onClose();
            })
          }
        >
          Add page
        </button>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
function CompressDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);
  const notify = useEditor((s) => s.notify);
  const [quality, setQuality] = useState(75);
  const [maxDpi, setMaxDpi] = useState(200);

  return (
    <Modal title="Compress images" onClose={onClose}>
      <Field label={`JPEG quality — ${quality}`}>
        <input
          type="range"
          min={10}
          max={100}
          className="w-full accent-accent"
          value={quality}
          onChange={(event) => setQuality(Number(event.target.value))}
        />
      </Field>
      <Field label={`Maximum resolution — ${maxDpi} dpi`}>
        <input
          type="range"
          min={72}
          max={600}
          step={12}
          className="w-full accent-accent"
          value={maxDpi}
          onChange={(event) => setMaxDpi(Number(event.target.value))}
        />
      </Field>
      <p className="mb-3 flex gap-2 rounded border border-warn/40 bg-warn/10 p-2.5 text-[10px] leading-relaxed text-chrome-300">
        <Icon.Warning size={14} />
        <span>
          This is the one operation that deliberately loses quality. Text, vectors and layout are
          untouched; only raster images are downsampled. Undo restores the originals.
        </span>
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() =>
            doc &&
            void run("Compressing", async () => {
              const result = await api.compressImages(doc.id, quality, maxDpi);
              setDocument(result.document);
              notify(
                "success",
                `Recompressed ${result.images} image(s), saved ${(result.saved / 1024).toFixed(0)} KB`,
              );
              onClose();
            })
          }
        >
          Compress
        </button>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const capabilities = useEditor((s) => s.capabilities);
  const run = useEditor((s) => s.run);
  const notify = useEditor((s) => s.notify);
  const [text, setText] = useState("");
  const [html, setHtml] = useState("");

  function adopt(document_: any) {
    useEditor.setState((s) => ({
      doc: document_,
      openDocs: [...s.openDocs, document_],
      currentPage: 0,
      layouts: {},
      images: {},
    }));
  }

  return (
    <Modal title="Create a PDF" onClose={onClose} width={480}>
      <Field label="From a file (Word, Excel, PowerPoint, images, HTML, text)">
        <input
          type="file"
          multiple
          className="field w-full py-1"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (!files.length) return;
            void run("Converting", async () => {
              const result = await api.convertToPdf(files);
              adopt(result.document);
              notify("success", "Converted to PDF");
              onClose();
            });
          }}
        />
      </Field>
      {capabilities && !capabilities.libreOffice && (
        <p className="mb-3 flex gap-2 rounded border border-warn/40 bg-warn/10 p-2.5 text-[10px] leading-relaxed text-chrome-300">
          <Icon.Warning size={14} />
          <span>
            LibreOffice is not installed, so Word, Excel and PowerPoint files cannot be converted.
            Images, HTML and text still work.
          </span>
        </p>
      )}

      <Field label="From plain text">
        <textarea
          className="field h-24 w-full resize-none py-1"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type or paste text…"
        />
      </Field>
      <button
        type="button"
        className="btn-ghost mb-4 w-full"
        disabled={!text.trim()}
        onClick={() =>
          void run("Creating PDF", async () => {
            const result = await api.textToPdf(text);
            adopt(result.document);
            onClose();
          })
        }
      >
        Create from text
      </button>

      <Field label="From HTML">
        <textarea
          className="field h-24 w-full resize-none py-1 font-mono"
          value={html}
          onChange={(event) => setHtml(event.target.value)}
          placeholder="<h1>Hello</h1>"
        />
      </Field>
      <button
        type="button"
        className="btn-ghost w-full"
        disabled={!html.trim()}
        onClick={() =>
          void run("Creating PDF", async () => {
            const result = await api.htmlToPdf(html);
            adopt(result.document);
            onClose();
          })
        }
      >
        Create from HTML
      </button>
    </Modal>
  );
}
