"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/lib/store";
import type { PageLayout, Paragraph, TextSpan } from "@/lib/types";
import ParagraphEditor from "./ParagraphEditor";

interface Props {
  page: number;
  layout: PageLayout | undefined;
  scale: number;
}

/**
 * The editable text overlay.
 *
 * Text is edited a paragraph at a time, as in a word processor: each
 * paragraph the server recognised gets a transparent hit box over the glyphs
 * the canvas already painted. Click selects it (the properties panel then
 * styles it); double-click opens it as rich text, and applying the edit
 * reflows the content after it. Runs that belong to no paragraph (stray
 * glyphs, vertical text) keep the single-run editor.
 */
export default function TextLayer({ page, layout, scale }: Props) {
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const selectedSpanIds = useEditor((s) => s.selectedSpanIds);
  const selectSpans = useEditor((s) => s.selectSpans);
  const applyEdits = useEditor((s) => s.applyEdits);
  const editParagraph = useEditor((s) => s.editParagraph);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingParagraph, setEditingParagraph] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLDivElement>(null);

  const active = tool === "editText";

  // Leaving edit mode must not strand a half-typed edit.
  useEffect(() => {
    if (!active) {
      setEditingId(null);
      setEditingParagraph(null);
      setDraft("");
    }
  }, [active]);

  // A new layout (after any edit) invalidates paragraph ids.
  useEffect(() => setEditingParagraph(null), [layout?.version]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(inputRef.current);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [editingId]);

  const paragraphs = layout?.paragraphs ?? [];
  const spans = layout?.spans ?? [];
  const inParagraph = useMemo(() => new Set(paragraphs.flatMap((p) => p.spanIds)), [paragraphs]);
  const looseSpans = spans.filter((span) => !inParagraph.has(span.id));
  const embeddedFonts = useMemo(
    () => new Set(spans.filter((span) => span.embeddable).map((span) => span.fontId)),
    [spans],
  );

  const styleFor = useMemo(
    () => (span: TextSpan) => {
      const [x0, y0, x1, y1] = span.bbox;
      const family = span.mono
        ? "ui-monospace, monospace"
        : span.serif
          ? "Georgia, 'Times New Roman', serif"
          : "Arial, Helvetica, sans-serif";
      return {
        left: x0 * scale,
        top: y0 * scale,
        width: Math.max((x1 - x0) * scale, 4),
        height: Math.max((y1 - y0) * scale, 6),
        fontSize: span.size * scale,
        lineHeight: `${Math.max((y1 - y0) * scale, 6)}px`,
        fontFamily: family,
        fontWeight: span.bold ? 700 : 400,
        fontStyle: span.italic ? "italic" : "normal",
      } as const;
    },
    [scale],
  );

  function beginEdit(span: TextSpan) {
    setEditingId(span.id);
    setDraft(span.text);
    selectSpans([span.id]);
  }

  async function commit(span: TextSpan) {
    const next = (inputRef.current?.innerText ?? draft).replace(/ /g, " ");
    setEditingId(null);
    if (next === span.text) return;
    await applyEdits([
      { page, action: "replace", spanIds: [span.id], text: next },
    ]);
  }

  function paragraphSelected(paragraph: Paragraph) {
    return paragraph.spanIds.length > 0 && paragraph.spanIds.every((id) => selectedSpanIds.includes(id));
  }

  if (!active || !layout) return null;

  return (
    <div className="absolute inset-0" data-layer="text">
      {paragraphs.map((paragraph) => {
        if (editingParagraph === paragraph.id && doc) {
          return (
            <ParagraphEditor
              key={paragraph.id}
              docId={doc.id}
              paragraph={paragraph}
              background={layout.background ?? "#ffffff"}
              scale={scale}
              embeddedFonts={embeddedFonts}
              onCancel={() => setEditingParagraph(null)}
              onCommit={(items, lift) => {
                setEditingParagraph(null);
                void editParagraph(page, paragraph.id, items, layout.version, lift);
              }}
            />
          );
        }
        const [x0, y0, x1, y1] = paragraph.bbox;
        return (
          <div
            key={paragraph.id}
            className={`para-box ${paragraphSelected(paragraph) ? "is-selected" : ""}`}
            style={{ left: x0 * scale - 2, top: y0 * scale - 1, width: (x1 - x0) * scale + 4, height: (y1 - y0) * scale + 2 }}
            title="Double-click to edit this paragraph"
            onMouseDown={(event) => {
              event.stopPropagation();
              selectSpans(paragraph.spanIds, event.shiftKey || event.ctrlKey || event.metaKey);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditingId(null);
              setEditingParagraph(paragraph.id);
            }}
          />
        );
      })}

      {looseSpans.map((span) => {
        const isEditing = editingId === span.id;
        const isSelected = selectedSpanIds.includes(span.id);
        const base = styleFor(span);

        if (isEditing) {
          return (
            <div
              key={span.id}
              ref={inputRef}
              contentEditable
              suppressContentEditableWarning
              spellCheck
              className="span-box is-editing"
              style={{
                ...base,
                color: span.color,
                width: Math.max(base.width, 40),
                minWidth: 40,
                padding: "0 1px",
              }}
              onBlur={() => void commit(span)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingId(null);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void commit(span);
                }
                event.stopPropagation();
              }}
            >
              {draft}
            </div>
          );
        }

        return (
          <div
            key={span.id}
            className={`span-box ${isSelected ? "is-selected" : ""}`}
            style={base}
            title={span.text}
            onMouseDown={(event) => {
              event.stopPropagation();
              selectSpans([span.id], event.shiftKey || event.ctrlKey || event.metaKey);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              beginEdit(span);
            }}
          >
            {span.text}
          </div>
        );
      })}
    </div>
  );
}
