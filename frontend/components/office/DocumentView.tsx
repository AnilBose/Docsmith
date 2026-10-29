"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Packer } from "docx";
import type { OfficeViewProps } from "@/lib/office";
import { Icon } from "@/components/Icons";
import { wordExtensions } from "./word/extensions";
import { importDocx } from "./word/importDocx";
import { importDocxRich } from "./word/importDocxRich";
import { buildDocx, type ResolvedImage } from "./word/exportDocx";
import { buildDocumentHtml } from "./word/exportHtml";
import {
  A4_PAGE,
  PT_TO_PX,
  DEFAULT_SIZE_PT,
  FONTS,
  FONT_SIZES,
  HIGHLIGHTS,
  TEXT_COLORS,
  contentWidthPx,
  fontStack,
  primaryFont,
  toPoints,
  type PageSetup,
} from "./word/format";
import { ColorPanel, Dropdown, LinkPanel, MenuItem, ToolButton, WordIcon } from "./word/controls";
import "./word.css";


type BlockStyle = "p" | "title" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

const BLOCK_STYLES: { value: BlockStyle; label: string }[] = [
  { value: "p", label: "Normal" },
  { value: "title", label: "Title" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
];

/**
 * docx-preview gives the look Word shows; mammoth is the fallback for files
 * it cannot render, at the cost of most formatting.
 */
async function openDocx(bytes: ArrayBuffer): Promise<{ html: string; page: PageSetup | null; warnings: string[] }> {
  try {
    const { html, page } = await importDocxRich(bytes);
    return { html, page, warnings: [] };
  } catch (err) {
    const fallback = await importDocx(bytes);
    const reason = err instanceof Error ? err.message : String(err);
    return { html: fallback.html, page: null, warnings: [`formatting simplified: ${reason}`, ...fallback.warnings] };
  }
}

/** Point size each style is drawn at, for the size box when no size is set. */
const STYLE_SIZE: Record<BlockStyle, number> = {
  p: DEFAULT_SIZE_PT,
  title: 28,
  h1: 16,
  h2: 13,
  h3: 12,
  h4: 11,
  h5: 11,
  h6: 11,
};

const ALIGNMENTS = [
  { value: "left", label: "Align left (Ctrl+Shift+L)", icon: Icon.AlignLeft },
  { value: "center", label: "Centre (Ctrl+Shift+E)", icon: Icon.AlignCenter },
  { value: "right", label: "Align right (Ctrl+Shift+R)", icon: Icon.AlignRight },
  { value: "justify", label: "Justify (Ctrl+Shift+J)", icon: Icon.AlignJustify },
] as const;

const counts = new WeakMap<PMNode, { words: number; chars: number }>();

/** Word and character counts, cached per document so selection moves are free. */
function countText(doc: PMNode): { words: number; chars: number } {
  let hit = counts.get(doc);
  if (!hit) {
    const text = doc.textBetween(0, doc.content.size, " ", " ");
    hit = { words: text.match(/\S+/g)?.length ?? 0, chars: text.replace(/\s/g, "").length };
    counts.set(doc, hit);
  }
  return hit;
}

function snapshot(e: Editor) {
  const heading = e.isActive("heading") ? e.getAttributes("heading") : null;
  const block: BlockStyle = heading
    ? heading.wordStyle === "title"
      ? "title"
      : (`h${Math.min(Math.max(Number(heading.level) || 1, 1), 6)}` as BlockStyle)
    : "p";
  const style = e.getAttributes("textStyle");
  return {
    block,
    align: ALIGNMENTS.find((a) => a.value !== "left" && e.isActive({ textAlign: a.value }))?.value ?? "left",
    bold: e.isActive("bold"),
    italic: e.isActive("italic"),
    underline: e.isActive("underline"),
    strike: e.isActive("strike"),
    bulletList: e.isActive("bulletList"),
    orderedList: e.isActive("orderedList"),
    link: e.isActive("link") ? ((e.getAttributes("link").href as string | undefined) ?? "") : null,
    inTable: e.isActive("table"),
    font: typeof style.fontFamily === "string" ? style.fontFamily : null,
    size: typeof style.fontSize === "string" ? style.fontSize : null,
    color: typeof style.color === "string" ? style.color : null,
    highlight: e.isActive("highlight") ? ((e.getAttributes("highlight").color as string | null) ?? HIGHLIGHTS.yellow) : null,
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
    canSink: e.can().sinkListItem("listItem"),
    canLift: e.can().liftListItem("listItem"),
    ...countText(e.state.doc),
  };
}

function paperName(page: PageSetup): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  const sizes: [string, number, number][] = [["A4", 595.3, 841.9], ["Letter", 612, 792], ["Legal", 612, 1008], ["A5", 419.5, 595.3]];
  const hit = sizes.find(([, w, h]) => (near(page.widthPt, w) && near(page.heightPt, h)) || (near(page.widthPt, h) && near(page.heightPt, w)));
  return hit ? hit[0] : `${Math.round(page.widthPt / 2.835)} × ${Math.round(page.heightPt / 2.835)} mm`;
}

function docxName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return `${stem || "Document"}.docx`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new window.Image();
  img.src = src;
  await img.decode();
  return img;
}

function drawToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 300;
  canvas.height = img.naturalHeight || 150;
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** PNG copy of an image .docx cannot embed directly (webp, svg, …). */
async function rasterize(src: string): Promise<ResolvedImage | null> {
  const canvas = drawToCanvas(await loadImage(src));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return {
    type: "png",
    data: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Word-style editor for .docx files: a ribbon over a white A4 page.
 *
 * Opening goes through mammoth (docx -> HTML), saving through docx (editor
 * JSON -> docx), so the file never leaves the browser; only "Convert to PDF"
 * sends HTML to the server for layout.
 */
export default function DocumentView({ file, active, onOpenPdf, notify }: OfficeViewProps) {
  const extensions = useMemo(() => wordExtensions(), []);
  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    editorProps: { attributes: { spellcheck: "true", "aria-label": "Document" } },
  });

  const [loading, setLoading] = useState(file.format === "docx" && !!file.bytes);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pages, setPages] = useState({ current: 1, total: 1 });
  const [page, setPage] = useState<PageSetup>(A4_PAGE);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const canvasRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const state = useEditorState({ editor, selector: ({ editor: e }) => (e ? snapshot(e) : null) });

  // Load once per editor instance. The import is kept out of the undo history
  // so Ctrl+Z cannot empty the freshly opened document.
  useEffect(() => {
    if (!editor) return;
    if (file.format !== "docx" || !file.bytes) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    openDocx(file.bytes)
      .then(({ html, page: setup, warnings }) => {
        if (cancelled || editor.isDestroyed) return;
        setPage(setup ?? A4_PAGE);
        editor.chain().setMeta("addToHistory", false).setContent(html, { emitUpdate: false }).run();
        setDirty(false);
        if (warnings.length) {
          notifyRef.current(
            "info",
            `${file.filename}: ${warnings.length} item${warnings.length === 1 ? "" : "s"} could not be imported exactly (${warnings[0]}).`,
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        notifyRef.current(
          "error",
          `Could not open ${file.filename}: ${err instanceof Error ? err.message : "the file is not a valid Word document."}`,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editor, file.bytes, file.format, file.filename]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => setDirty(true);
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  // Page count from the content height; the sheet grows a page at a time and
  // the current page follows the scroll position.
  const measure = useCallback(() => {
    const content = contentRef.current;
    const canvas = canvasRef.current;
    const sheet = sheetRef.current;
    if (!content || !canvas || !sheet || content.offsetHeight === 0) return;
    const pagePx = page.heightPt * PT_TO_PX;
    const marginsPx = (page.marginTopPt + page.marginBottomPt) * PT_TO_PX;
    const total = Math.max(1, Math.ceil((content.offsetHeight + marginsPx) / pagePx));
    const y = canvas.scrollTop + canvas.clientHeight / 3 - sheet.offsetTop;
    const current = Math.min(total, Math.max(1, Math.floor(y / pagePx) + 1));
    setPages((p) => (p.current === current && p.total === total ? p : { current, total }));
  }, [page]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure]);

  const title = docxName(file.filename).replace(/\.docx$/i, "");

  const save = useCallback(async () => {
    if (!editor || busy) return;
    setBusy("Saving");
    try {
      const { document, skippedImages } = await buildDocx(editor.getJSON(), { title, rasterize, page });
      download(await Packer.toBlob(document), docxName(file.filename));
      setDirty(false);
      notify(
        skippedImages ? "info" : "success",
        skippedImages
          ? `Saved ${docxName(file.filename)}; ${skippedImages} image${skippedImages === 1 ? "" : "s"} could not be embedded.`
          : `Saved ${docxName(file.filename)}.`,
      );
    } catch (err) {
      notify("error", `Could not save the document: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [editor, busy, file.filename, title, notify, page]);

  const saveHtml = useCallback(() => {
    if (!editor) return;
    const html = buildDocumentHtml(editor.getHTML(), title, "file", page);
    download(new Blob([html], { type: "text/html;charset=utf-8" }), `${title}.html`);
  }, [editor, title, page]);

  const convertToPdf = useCallback(async () => {
    if (!editor || busy) return;
    setBusy("Converting to PDF");
    try {
      await onOpenPdf(buildDocumentHtml(editor.getHTML(), title, "pdf", page), `${title}.pdf`);
    } catch (err) {
      notify("error", `Could not convert to PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [editor, busy, onOpenPdf, title, notify, page]);

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  const onPickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked || !editor) return;
    try {
      let src = await readAsDataUrl(picked);
      const img = await loadImage(src);
      if (!/^data:image\/(png|jpe?g|gif|bmp)[;,]/i.test(src)) src = drawToCanvas(img).toDataURL("image/png");
      let width = img.naturalWidth || 300;
      let height = img.naturalHeight || 150;
      const maxWidth = contentWidthPx(page);
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }
      editor.chain().focus().setImage({ src, width: Math.round(width), height: Math.round(height) }).run();
    } catch {
      notify("error", `${picked.name} is not an image this browser can read.`);
    }
  };

  const chain = () => editor!.chain().focus();
  const ready = !!editor && !!state && !loading;
  const s = state;

  const setBlock = (value: BlockStyle) => {
    if (!editor || !s) return;
    const textAlign = s.align === "left" ? null : s.align;
    if (value === "p") chain().setNode("paragraph", { textAlign }).run();
    else if (value === "title") chain().setNode("heading", { level: 1, wordStyle: "title", textAlign }).run();
    else chain().setNode("heading", { level: Number(value.slice(1)), wordStyle: null, textAlign }).run();
  };

  const fontLabel = s?.font ? primaryFont(s.font) : s && s.block !== "p" ? "Calibri Light" : FONTS[0].label;
  const sizePt = toPoints(s?.size) ?? STYLE_SIZE[s?.block ?? "p"];
  const blockOptions = s && !BLOCK_STYLES.some((b) => b.value === s.block)
    ? [...BLOCK_STYLES, { value: s.block, label: `Heading ${s.block.slice(1)}` }]
    : BLOCK_STYLES;

  return (
    <div
      className="word-view flex h-full min-h-0 w-full flex-col bg-chrome-950"
      style={active ? undefined : { display: "none" }}
      onKeyDown={onKeyDown}
    >
      {/* File bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-chrome-800 bg-chrome-900 px-3">
        <span className="text-accent">
          <WordIcon.Doc size={18} />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-chrome-100" title={file.filename}>
          {file.filename || "Document.docx"}
        </span>
        {dirty && <span className="chip shrink-0">Edited</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={!ready || !!busy} title="Save as Word document (Ctrl+S)">
            <Icon.Download size={15} />
            Save
          </button>
          <button type="button" className="btn-ghost" onClick={saveHtml} disabled={!ready || !!busy}>
            Save as HTML
          </button>
          <span className="divider" />
          <button type="button" className="btn-ghost" onClick={() => void convertToPdf()} disabled={!ready || !!busy}>
            <WordIcon.Pdf size={15} />
            Convert to PDF
          </button>
        </div>
      </div>

      {/* Home ribbon */}
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-chrome-800 bg-chrome-850 px-2 py-1">
        <ToolButton title="Undo (Ctrl+Z)" disabled={!ready || !s?.canUndo} onClick={() => chain().undo().run()}>
          <Icon.Undo size={16} />
        </ToolButton>
        <ToolButton title="Redo (Ctrl+Y)" disabled={!ready || !s?.canRedo} onClick={() => chain().redo().run()}>
          <Icon.Redo size={16} />
        </ToolButton>
        <span className="divider" />

        <select
          className="field w-28"
          title="Style"
          disabled={!ready}
          value={s?.block ?? "p"}
          onChange={(e) => setBlock(e.target.value as BlockStyle)}
        >
          {blockOptions.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <select
          className="field ml-1 w-36"
          title="Font"
          disabled={!ready}
          value={fontLabel}
          onChange={(e) => chain().setFontFamily(fontStack(e.target.value)).run()}
        >
          {!FONTS.some((f) => f.label === fontLabel) && <option value={fontLabel}>{fontLabel}</option>}
          {FONTS.map((f) => (
            <option key={f.label} value={f.label} style={{ fontFamily: f.css }}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          className="field ml-1 w-16"
          title="Font size"
          disabled={!ready}
          value={String(sizePt)}
          onChange={(e) => chain().setFontSize(`${e.target.value}pt`).run()}
        >
          {!FONT_SIZES.includes(sizePt) && <option value={String(sizePt)}>{sizePt}</option>}
          {FONT_SIZES.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
        <span className="divider" />

        <ToolButton title="Bold (Ctrl+B)" active={s?.bold} disabled={!ready} onClick={() => chain().toggleBold().run()}>
          <Icon.Bold size={16} />
        </ToolButton>
        <ToolButton title="Italic (Ctrl+I)" active={s?.italic} disabled={!ready} onClick={() => chain().toggleItalic().run()}>
          <Icon.Italic size={16} />
        </ToolButton>
        <ToolButton title="Underline (Ctrl+U)" active={s?.underline} disabled={!ready} onClick={() => chain().toggleUnderline().run()}>
          <Icon.Underline size={16} />
        </ToolButton>
        <ToolButton title="Strikethrough" active={s?.strike} disabled={!ready} onClick={() => chain().toggleStrike().run()}>
          <Icon.Strike size={16} />
        </ToolButton>
        <Dropdown
          title="Font colour"
          disabled={!ready}
          label={
            <span className="flex flex-col items-center leading-none">
              <WordIcon.TextColor size={15} />
              <span className="mt-px h-[3px] w-4 rounded-sm" style={{ backgroundColor: s?.color ?? "#e34850" }} />
            </span>
          }
        >
          {(close) => (
            <ColorPanel
              colors={TEXT_COLORS}
              current={s?.color ?? null}
              noneLabel="Automatic"
              columns={5}
              custom
              onPick={(c) => {
                if (c) chain().setColor(c).run();
                else chain().unsetColor().run();
                close();
              }}
            />
          )}
        </Dropdown>
        <Dropdown
          title="Text highlight colour"
          disabled={!ready}
          label={
            <span className="flex flex-col items-center leading-none">
              <Icon.Highlight size={15} />
              <span className="mt-px h-[3px] w-4 rounded-sm" style={{ backgroundColor: s?.highlight ?? HIGHLIGHTS.yellow }} />
            </span>
          }
        >
          {(close) => (
            <ColorPanel
              colors={Object.values(HIGHLIGHTS)}
              current={s?.highlight ?? null}
              noneLabel="No colour"
              columns={5}
              onPick={(c) => {
                if (c) chain().setHighlight({ color: c }).run();
                else chain().unsetHighlight().run();
                close();
              }}
            />
          )}
        </Dropdown>
        <span className="divider" />

        {ALIGNMENTS.map((a) => (
          <ToolButton
            key={a.value}
            title={a.label}
            active={s?.align === a.value}
            disabled={!ready}
            onClick={() => chain().setTextAlign(a.value).run()}
          >
            <a.icon size={16} />
          </ToolButton>
        ))}
        <span className="divider" />

        <ToolButton title="Bullets" active={s?.bulletList} disabled={!ready} onClick={() => chain().toggleBulletList().run()}>
          <WordIcon.BulletList size={17} />
        </ToolButton>
        <ToolButton title="Numbering" active={s?.orderedList} disabled={!ready} onClick={() => chain().toggleOrderedList().run()}>
          <WordIcon.NumberList size={17} />
        </ToolButton>
        <ToolButton title="Decrease indent (Shift+Tab)" disabled={!ready || !s?.canLift} onClick={() => chain().liftListItem("listItem").run()}>
          <WordIcon.Outdent size={17} />
        </ToolButton>
        <ToolButton title="Increase indent (Tab)" disabled={!ready || !s?.canSink} onClick={() => chain().sinkListItem("listItem").run()}>
          <WordIcon.Indent size={17} />
        </ToolButton>
        <span className="divider" />

        <ToolButton
          title="Insert table"
          disabled={!ready}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <WordIcon.Table size={17} />
        </ToolButton>
        {s?.inTable && (
          <Dropdown title="Table layout" label={<span className="text-sm">Table</span>} disabled={!ready} active>
            {(close) => {
              const run = (fn: () => boolean) => () => {
                fn();
                close();
              };
              return (
                <div className="flex w-44 flex-col">
                  <MenuItem onClick={run(() => chain().addRowBefore().run())}>Insert row above</MenuItem>
                  <MenuItem onClick={run(() => chain().addRowAfter().run())}>Insert row below</MenuItem>
                  <MenuItem onClick={run(() => chain().addColumnBefore().run())}>Insert column left</MenuItem>
                  <MenuItem onClick={run(() => chain().addColumnAfter().run())}>Insert column right</MenuItem>
                  <div className="my-1 h-px bg-chrome-700" />
                  <MenuItem onClick={run(() => chain().mergeOrSplit().run())}>Merge / split cells</MenuItem>
                  <MenuItem onClick={run(() => chain().toggleHeaderRow().run())}>Toggle header row</MenuItem>
                  <div className="my-1 h-px bg-chrome-700" />
                  <MenuItem onClick={run(() => chain().deleteRow().run())}>Delete row</MenuItem>
                  <MenuItem onClick={run(() => chain().deleteColumn().run())}>Delete column</MenuItem>
                  <MenuItem danger onClick={run(() => chain().deleteTable().run())}>
                    Delete table
                  </MenuItem>
                </div>
              );
            }}
          </Dropdown>
        )}
        <ToolButton title="Insert picture" disabled={!ready} onClick={() => imageInputRef.current?.click()}>
          <Icon.Image size={17} />
        </ToolButton>
        <Dropdown title="Link" label={<WordIcon.Link size={17} />} disabled={!ready} active={s?.link != null}>
          {(close) => (
            <LinkPanel
              current={s?.link || null}
              onApply={(href) => {
                if (editor!.state.selection.empty && !s?.link) {
                  chain()
                    .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
                    .run();
                } else {
                  chain().extendMarkRange("link").setLink({ href }).run();
                }
                close();
              }}
              onRemove={() => {
                chain().extendMarkRange("link").unsetLink().run();
                close();
              }}
            />
          )}
        </Dropdown>
        <span className="divider" />

        <ToolButton
          title="Clear all formatting"
          disabled={!ready}
          onClick={() => {
            const c = chain()
              .unsetAllMarks()
              .unsetTextAlign()
              .resetAttributes("paragraph", "blockStyle")
              .resetAttributes("heading", "blockStyle");
            (s?.block !== "p" ? c.setParagraph() : c).run();
          }}
        >
          <WordIcon.ClearFormat size={17} />
        </ToolButton>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml"
          className="hidden"
          onChange={(e) => void onPickImage(e)}
        />
      </div>

      {/* Page canvas */}
      <div ref={canvasRef} className="word-canvas relative min-h-0 flex-1 overflow-auto" onScroll={measure}>
        <div className="flex min-w-max justify-center px-6 py-8">
          <div
            ref={sheetRef}
            className="word-page"
            style={
              {
                width: `${page.widthPt}pt`,
                minHeight: `${pages.total * page.heightPt}pt`,
                padding: `${page.marginTopPt}pt ${page.marginRightPt}pt ${page.marginBottomPt}pt ${page.marginLeftPt}pt`,
                "--page-h": `${page.heightPt}pt`,
                "--page-body-h": `${page.heightPt - page.marginTopPt - page.marginBottomPt}pt`,
              } as CSSProperties
            }
            onMouseDown={(e) => {
              // A click in the margin puts the caret on the nearest line, as in Word.
              const content = contentRef.current;
              if (!editor || !content || e.target !== e.currentTarget) return;
              e.preventDefault();
              const r = content.getBoundingClientRect();
              const hit = editor.view.posAtCoords({
                left: Math.min(Math.max(e.clientX, r.left + 1), r.right - 1),
                top: Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1),
              });
              const c = editor.chain().focus();
              (hit ? c.setTextSelection(hit.pos) : c).run();
            }}
          >
            <div ref={contentRef}>
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#e3e3e6]/70 text-sm text-chrome-700">
            Opening {file.filename}…
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex h-6 shrink-0 items-center gap-5 border-t border-chrome-800 bg-chrome-900 px-3 text-2xs text-chrome-400">
        <span>
          Page {pages.current} of {pages.total}
        </span>
        <span title={`${(s?.chars ?? 0).toLocaleString()} characters (no spaces)`}>
          {(s?.words ?? 0).toLocaleString()} word{s?.words === 1 ? "" : "s"}
        </span>
        <span className="ml-auto">{busy ? `${busy}…` : dirty ? "Unsaved changes" : ""}</span>
        <span>{paperName(page)}</span>
      </div>
    </div>
  );
}
