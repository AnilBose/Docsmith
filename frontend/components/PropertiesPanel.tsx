"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useEditor } from "@/lib/store";
import type { TextSpan, TextStyleInput } from "@/lib/types";
import { Icon } from "./Icons";

/**
 * The right-hand inspector.
 *
 * It reflects whatever is selected -- a run of text, an image, or nothing --
 * and every control writes straight through to the document. Typography values
 * are read back from the PDF itself, so what is shown is the file's real
 * formatting rather than a guess.
 */
export default function PropertiesPanel() {
  const open = useEditor((s) => s.propertiesOpen);
  const selectedSpanIds = useEditor((s) => s.selectedSpanIds);
  const selectedImage = useEditor((s) => s.selectedImage);

  if (!open) return null;

  return (
    <aside className="flex w-[268px] shrink-0 flex-col overflow-y-auto border-l border-chrome-800 bg-chrome-900">
      {selectedSpanIds.length > 0 ? (
        <TextProperties />
      ) : selectedImage ? (
        <ImageProperties />
      ) : (
        <DocumentProperties />
      )}
    </aside>
  );
}

/* ========================================================================== */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="w-[62px] shrink-0 text-2xs text-chrome-400">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-chrome-850 pb-2">
      <div className="panel-title">{title}</div>
      {children}
    </div>
  );
}

/* ========================================================================== */
function TextProperties() {
  const doc = useEditor((s) => s.doc);
  const currentPage = useEditor((s) => s.currentPage);
  const selectedSpanIds = useEditor((s) => s.selectedSpanIds);
  const layout = useEditor((s) => s.layouts[currentPage]);
  const fonts = useEditor((s) => s.fonts);
  const applyEdits = useEditor((s) => s.applyEdits);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);

  const spans = useMemo(
    () => (layout?.spans ?? []).filter((span) => selectedSpanIds.includes(span.id)),
    [layout, selectedSpanIds],
  );
  const first: TextSpan | undefined = spans[0];

  const [draft, setDraft] = useState<TextStyleInput>({});
  useEffect(() => setDraft({}), [selectedSpanIds.join(",")]);

  if (!first) return <Empty text="Select a run of text to edit its formatting." />;

  const value = <K extends keyof TextStyleInput>(key: K, fallback: TextStyleInput[K]) =>
    (draft[key] ?? fallback) as TextStyleInput[K];

  async function push(patch: TextStyleInput) {
    const merged = { ...draft, ...patch };
    setDraft(merged);
    await applyEdits(
      spans.map((span) => ({
        page: currentPage,
        action: "replace" as const,
        spanIds: [span.id],
        text: span.text,
        style: {
          font: merged.font ?? span.font,
          size: merged.size ?? span.size,
          color: merged.color ?? span.color,
          bold: merged.bold ?? span.bold,
          italic: merged.italic ?? span.italic,
          underline: merged.underline ?? false,
          strike: merged.strike ?? false,
          align: merged.align ?? "left",
          lineHeight: merged.lineHeight ?? 1,
          letterSpacing: merged.letterSpacing ?? 0,
        },
      })),
    );
  }

  async function changeCase(mode: string) {
    if (!doc) return;
    await run("Changing case", async () => {
      const result = await api.changeCase(doc.id, currentPage, selectedSpanIds, mode);
      setDocument(result.document);
      await useEditor.getState().loadLayout(currentPage, true);
    });
  }

  async function remove() {
    await applyEdits([{ page: currentPage, action: "delete", spanIds: selectedSpanIds }]);
  }

  const align = value("align", "left");

  return (
    <>
      <Section title={`Text · ${spans.length} run${spans.length === 1 ? "" : "s"}`}>
        <Row label="Font">
          <select
            className="field w-full"
            value={value("font", first.font) as string}
            onChange={(event) => void push({ font: event.target.value })}
          >
            <option value={first.font}>{first.fontFamily}</option>
            {fonts.map((font) => (
              <option key={font.id} value={font.label}>
                {font.label}
                {font.source === "document" ? " · in file" : ""}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Size">
          <input
            type="number"
            min={1}
            max={400}
            step={0.5}
            className="field w-16"
            value={Number(value("size", first.size)).toFixed(1)}
            onChange={(event) => setDraft({ ...draft, size: Number(event.target.value) })}
            onBlur={(event) => void push({ size: Number(event.target.value) })}
          />
          <span className="text-2xs text-chrome-500">pt</span>
        </Row>
        <Row label="Color">
          <input
            type="color"
            className="h-7 w-10 cursor-pointer rounded border border-chrome-700 bg-chrome-900"
            value={value("color", first.color) as string}
            onChange={(event) => setDraft({ ...draft, color: event.target.value })}
            onBlur={(event) => void push({ color: event.target.value })}
          />
          <span className="font-mono text-2xs text-chrome-400">
            {value("color", first.color) as string}
          </span>
        </Row>
        <Row label="Style">
          <button
            type="button"
            className={`tool-btn ${value("bold", first.bold) ? "tool-btn-active" : ""}`}
            onClick={() => void push({ bold: !value("bold", first.bold) })}
            title="Bold"
          >
            <Icon.Bold size={15} />
          </button>
          <button
            type="button"
            className={`tool-btn ${value("italic", first.italic) ? "tool-btn-active" : ""}`}
            onClick={() => void push({ italic: !value("italic", first.italic) })}
            title="Italic"
          >
            <Icon.Italic size={15} />
          </button>
          <button
            type="button"
            className={`tool-btn ${value("underline", false) ? "tool-btn-active" : ""}`}
            onClick={() => void push({ underline: !value("underline", false) })}
            title="Underline"
          >
            <Icon.Underline size={15} />
          </button>
          <button
            type="button"
            className={`tool-btn ${value("strike", false) ? "tool-btn-active" : ""}`}
            onClick={() => void push({ strike: !value("strike", false) })}
            title="Strikethrough"
          >
            <Icon.Strike size={15} />
          </button>
        </Row>
        <Row label="Align">
          {(
            [
              ["left", Icon.AlignLeft],
              ["center", Icon.AlignCenter],
              ["right", Icon.AlignRight],
              ["justify", Icon.AlignJustify],
            ] as const
          ).map(([mode, Glyph]) => (
            <button
              key={mode}
              type="button"
              className={`tool-btn ${align === mode ? "tool-btn-active" : ""}`}
              onClick={() => void push({ align: mode })}
              title={mode}
            >
              <Glyph size={15} />
            </button>
          ))}
        </Row>
      </Section>

      <Section title="Spacing">
        <Row label="Line">
          <input
            type="range"
            min={0.6}
            max={3}
            step={0.05}
            className="w-full accent-accent"
            value={value("lineHeight", 1) as number}
            onChange={(event) => setDraft({ ...draft, lineHeight: Number(event.target.value) })}
            onMouseUp={(event) =>
              void push({ lineHeight: Number((event.target as HTMLInputElement).value) })
            }
          />
          <span className="w-8 shrink-0 text-right text-2xs text-chrome-400">
            {Number(value("lineHeight", 1)).toFixed(2)}
          </span>
        </Row>
        <Row label="Character">
          <input
            type="range"
            min={-2}
            max={10}
            step={0.1}
            className="w-full accent-accent"
            value={value("letterSpacing", 0) as number}
            onChange={(event) => setDraft({ ...draft, letterSpacing: Number(event.target.value) })}
            onMouseUp={(event) =>
              void push({ letterSpacing: Number((event.target as HTMLInputElement).value) })
            }
          />
          <span className="w-8 shrink-0 text-right text-2xs text-chrome-400">
            {Number(value("letterSpacing", 0)).toFixed(1)}
          </span>
        </Row>
      </Section>

      <Section title="Capitalization">
        <div className="flex flex-wrap gap-1 px-3">
          {[
            ["upper", "UPPER"],
            ["lower", "lower"],
            ["title", "Title"],
            ["sentence", "Sentence"],
            ["toggle", "tOGGLE"],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className="chip hover:bg-accent hover:text-white"
              onClick={() => void changeCase(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <div className="p-3">
        <button type="button" className="btn-danger w-full" onClick={() => void remove()}>
          <Icon.Trash size={15} /> Delete text
        </button>
      </div>
    </>
  );
}

/* ========================================================================== */
/** Everything the transform endpoint accepts except the object's own identity. */
type ImageTransform = Omit<
  Parameters<typeof api.transformImage>[1],
  "page" | "xref" | "occurrence"
>;

function ImageProperties() {
  const doc = useEditor((s) => s.doc);
  const image = useEditor((s) => s.selectedImage)!;
  const setDocument = useEditor((s) => s.setDocument);
  const loadImages = useEditor((s) => s.loadImages);
  const selectImage = useEditor((s) => s.selectImage);
  const run = useEditor((s) => s.run);

  const [opacity, setOpacity] = useState(1);
  const [crop, setCrop] = useState<[number, number, number, number]>([0, 0, 1, 1]);

  useEffect(() => {
    setOpacity(1);
    setCrop([0, 0, 1, 1]);
  }, [image.id]);

  async function transform(payload: ImageTransform) {
    if (!doc) return;
    await run("Updating image", async () => {
      const result = await api.transformImage(doc.id, {
        ...payload,
        page: image.page,
        xref: image.xref,
        occurrence: image.occurrence,
      });
      setDocument(result.document);
      const refreshed = await loadImages(image.page, true);
      // The xref changes whenever pixels are rewritten; re-point the selection.
      selectImage(refreshed?.[0] ?? null);
    });
  }

  async function remove() {
    if (!doc) return;
    await run("Deleting image", async () => {
      const result = await api.deleteImage(doc.id, image.page, image.xref, image.occurrence);
      setDocument(result.document);
      await loadImages(image.page, true);
      selectImage(null);
    });
  }

  function replace() {
    if (!doc) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      await run("Replacing image", async () => {
        const result = await api.replaceImage(
          doc.id,
          image.page,
          image.xref,
          file,
          image.occurrence,
        );
        setDocument(result.document);
        await loadImages(image.page, true);
        selectImage(null);
      });
    };
    input.click();
  }

  const [x0, y0, x1, y1] = image.bbox;

  return (
    <>
      <Section title="Image">
        <div className="px-3 pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={api.imageThumbUrl(doc!.id, image.page, image.xref, doc!.version)}
            alt=""
            className="max-h-28 w-full rounded border border-chrome-800 bg-chrome-850 object-contain"
          />
        </div>
        <Row label="Source">
          <span className="text-2xs text-chrome-300">
            {image.width} × {image.height} px · {image.colorspace}
          </span>
        </Row>
        <Row label="Placed">
          <span className="text-2xs text-chrome-300">
            {(x1 - x0).toFixed(0)} × {(y1 - y0).toFixed(0)} pt · {image.dpiX} dpi
          </span>
        </Row>
      </Section>

      <Section title="Transform">
        <Row label="Rotate">
          <button type="button" className="tool-btn" onClick={() => void transform({ rotate: 90 })}>
            <Icon.Rotate size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => void transform({ rotate: 270 })}
          >
            <span className="scale-x-[-1]">
              <Icon.Rotate size={15} />
            </span>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => void transform({ rotate: 180 })}
            title="180°"
          >
            180
          </button>
        </Row>
        <Row label="Flip">
          <button
            type="button"
            className="tool-btn"
            onClick={() => void transform({ flipH: true })}
            title="Flip horizontally"
          >
            <Icon.Flip size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => void transform({ flipV: true })}
            title="Flip vertically"
          >
            <span className="rotate-90">
              <Icon.Flip size={15} />
            </span>
          </button>
        </Row>
        <Row label="Opacity">
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            className="w-full accent-accent"
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
            onMouseUp={() => void transform({ opacity })}
          />
          <span className="w-8 shrink-0 text-right text-2xs text-chrome-400">
            {Math.round(opacity * 100)}%
          </span>
        </Row>
      </Section>

      <Section title="Crop">
        <div className="grid grid-cols-2 gap-1.5 px-3">
          {(["left", "top", "right", "bottom"] as const).map((edge, index) => (
            <label key={edge} className="text-2xs text-chrome-400">
              {edge}
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="field w-full"
                value={crop[index]}
                onChange={(event) => {
                  const next = [...crop] as typeof crop;
                  next[index] = Number(event.target.value);
                  setCrop(next);
                }}
              />
            </label>
          ))}
        </div>
        <div className="px-3 pt-2">
          <button
            type="button"
            className="btn-ghost w-full"
            onClick={() => void transform({ crop })}
          >
            <Icon.Crop size={15} /> Apply crop
          </button>
        </div>
      </Section>

      <div className="space-y-1.5 p-3">
        <button type="button" className="btn-ghost w-full" onClick={replace}>
          Replace image…
        </button>
        <button
          type="button"
          className="btn-ghost w-full"
          onClick={() => doc && void api.extractImage(doc.id, image.page, image.xref)}
        >
          <Icon.Download size={15} /> Extract
        </button>
        <button type="button" className="btn-danger w-full" onClick={() => void remove()}>
          <Icon.Trash size={15} /> Delete image
        </button>
      </div>
    </>
  );
}

/* ========================================================================== */
function DocumentProperties() {
  const doc = useEditor((s) => s.doc);
  const capabilities = useEditor((s) => s.capabilities);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);
  const [meta, setMeta] = useState<Record<string, string>>({});

  useEffect(() => setMeta(doc?.metadata ?? {}), [doc?.id, doc?.metadata]);

  if (!doc) return <Empty text="No document open." />;

  async function save() {
    if (!doc) return;
    await run("Saving properties", async () => {
      const fresh = await api.setMetadata(doc.id, meta);
      setDocument(fresh);
    });
  }

  return (
    <>
      <Section title="Document">
        <Row label="File">
          <span className="truncate text-2xs text-chrome-200">{doc.filename}</span>
        </Row>
        <Row label="Pages">
          <span className="text-2xs text-chrome-300">{doc.pageCount}</span>
        </Row>
        <Row label="Size">
          <span className="text-2xs text-chrome-300">
            {doc.pages[0]
              ? `${doc.pages[0].width.toFixed(0)} × ${doc.pages[0].height.toFixed(0)} pt`
              : "—"}
          </span>
        </Row>
        <Row label="Form">
          <span className="text-2xs text-chrome-300">{doc.isFormPdf ? "AcroForm" : "None"}</span>
        </Row>
      </Section>

      <Section title="Metadata">
        {(["title", "author", "subject", "keywords"] as const).map((field) => (
          <Row key={field} label={field[0].toUpperCase() + field.slice(1)}>
            <input
              className="field w-full"
              value={meta[field] ?? ""}
              onChange={(event) => setMeta({ ...meta, [field]: event.target.value })}
            />
          </Row>
        ))}
        <div className="px-3 pt-1">
          <button type="button" className="btn-ghost w-full" onClick={() => void save()}>
            Save metadata
          </button>
        </div>
      </Section>

      {capabilities && (
        <Section title="Environment">
          <Row label="Office">
            <span className="text-2xs text-chrome-300">
              {capabilities.libreOffice ? "LibreOffice found" : "LibreOffice not installed"}
            </span>
          </Row>
          <Row label="HTML">
            <span className="text-2xs text-chrome-300">{capabilities.htmlRenderer}</span>
          </Row>
        </Section>
      )}
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-center text-2xs leading-relaxed text-chrome-500">{text}</p>;
}
