"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/lib/store";
import type { PageLayout, TextSpan } from "@/lib/types";

interface Props {
  page: number;
  layout: PageLayout | undefined;
  scale: number;
}

/**
 * The editable text overlay.
 *
 * Each run of text from the PDF becomes an absolutely-positioned box sitting
 * exactly on top of the glyphs the canvas already painted. The boxes are
 * transparent, so what the user sees is the real rendered page; they only
 * become opaque while a run is actually being edited. Committing an edit sends
 * the new string plus its styling to the backend, which rewrites just those
 * glyphs in the PDF.
 */
export default function TextLayer({ page, layout, scale }: Props) {
  const tool = useEditor((s) => s.tool);
  const selectedSpanIds = useEditor((s) => s.selectedSpanIds);
  const selectSpans = useEditor((s) => s.selectSpans);
  const applyEdits = useEditor((s) => s.applyEdits);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLDivElement>(null);

  const active = tool === "editText";

  // Leaving edit mode must not strand a half-typed edit.
  useEffect(() => {
    if (!active) {
      setEditingId(null);
      setDraft("");
    }
  }, [active]);

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

  const spans = layout?.spans ?? [];

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

  if (!active || !layout) return null;

  return (
    <div className="absolute inset-0" data-layer="text">
      {spans.map((span) => {
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
