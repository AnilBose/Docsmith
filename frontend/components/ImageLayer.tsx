"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useEditor } from "@/lib/store";
import type { ImageObject, Rect } from "@/lib/types";

interface Props {
  page: number;
  scale: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

const HANDLES: { id: Handle; style: React.CSSProperties; cursor: string }[] = [
  { id: "nw", style: { left: -5, top: -5 }, cursor: "nwse-resize" },
  { id: "n", style: { left: "calc(50% - 4.5px)", top: -5 }, cursor: "ns-resize" },
  { id: "ne", style: { right: -5, top: -5 }, cursor: "nesw-resize" },
  { id: "e", style: { right: -5, top: "calc(50% - 4.5px)" }, cursor: "ew-resize" },
  { id: "se", style: { right: -5, bottom: -5 }, cursor: "nwse-resize" },
  { id: "s", style: { left: "calc(50% - 4.5px)", bottom: -5 }, cursor: "ns-resize" },
  { id: "sw", style: { left: -5, bottom: -5 }, cursor: "nesw-resize" },
  { id: "w", style: { left: -5, top: "calc(50% - 4.5px)" }, cursor: "ew-resize" },
];

/**
 * Direct manipulation for placed images: drag to move, pull a handle to
 * resize. Geometry is committed to the backend only on mouse-up, and a
 * geometry-only change re-places the stored image stream untouched -- moving a
 * photo costs it no quality at all.
 */
export default function ImageLayer({ page, scale }: Props) {
  const tool = useEditor((s) => s.tool);
  const doc = useEditor((s) => s.doc);
  const images = useEditor((s) => s.images[page]);
  const selected = useEditor((s) => s.selectedImage);
  const selectImage = useEditor((s) => s.selectImage);
  const setDocument = useEditor((s) => s.setDocument);
  const loadImages = useEditor((s) => s.loadImages);
  const run = useEditor((s) => s.run);

  const [drag, setDrag] = useState<{
    handle: Handle;
    startX: number;
    startY: number;
    origin: Rect;
    xref: number;
    occurrence: number;
  } | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  const previewRef = useRef<Rect | null>(null);

  const active = tool === "editImage" || tool === "select";

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  const onMove = useCallback(
    (event: MouseEvent) => {
      if (!drag) return;
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      let [x0, y0, x1, y1] = drag.origin;

      if (drag.handle === "move") {
        x0 += dx;
        x1 += dx;
        y0 += dy;
        y1 += dy;
      } else {
        if (drag.handle.includes("w")) x0 += dx;
        if (drag.handle.includes("e")) x1 += dx;
        if (drag.handle.includes("n")) y0 += dy;
        if (drag.handle.includes("s")) y1 += dy;
      }

      // Never let a drag collapse or invert the box.
      if (x1 - x0 < 8) x1 = x0 + 8;
      if (y1 - y0 < 8) y1 = y0 + 8;
      setPreview([x0, y0, x1, y1]);
    },
    [drag, scale],
  );

  const onUp = useCallback(() => {
    const current = previewRef.current;
    const info = drag;
    setDrag(null);
    setPreview(null);
    if (!info || !current || !doc) return;

    const unchanged =
      Math.abs(current[0] - info.origin[0]) < 0.5 &&
      Math.abs(current[1] - info.origin[1]) < 0.5 &&
      Math.abs(current[2] - info.origin[2]) < 0.5 &&
      Math.abs(current[3] - info.origin[3]) < 0.5;
    if (unchanged) return;

    void run("Moving image", async () => {
      const result = await api.transformImage(doc.id, {
        page,
        xref: info.xref,
        occurrence: info.occurrence,
        rect: current,
      });
      setDocument(result.document);
      await loadImages(page, true);
    });
  }, [drag, doc, page, run, setDocument, loadImages]);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, onMove, onUp]);

  if (!active || !images?.length) return null;

  return (
    <div className="absolute inset-0" data-layer="image">
      {images.map((image: ImageObject) => {
        const isSelected =
          selected?.xref === image.xref &&
          selected?.page === image.page &&
          selected?.occurrence === image.occurrence;
        const box = isSelected && preview ? preview : image.bbox;
        const [x0, y0, x1, y1] = box;

        return (
          <div
            key={image.id}
            className={`image-box ${isSelected ? "is-selected" : ""}`}
            style={{
              left: x0 * scale,
              top: y0 * scale,
              width: (x1 - x0) * scale,
              height: (y1 - y0) * scale,
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              selectImage(image);
              setPreview(image.bbox);
              setDrag({
                handle: "move",
                startX: event.clientX,
                startY: event.clientY,
                origin: image.bbox,
                xref: image.xref,
                occurrence: image.occurrence,
              });
            }}
          >
            {isSelected &&
              HANDLES.map((handle) => (
                <span
                  key={handle.id}
                  className="handle"
                  style={{ ...handle.style, cursor: handle.cursor }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    setPreview(image.bbox);
                    setDrag({
                      handle: handle.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      origin: image.bbox,
                      xref: image.xref,
                      occurrence: image.occurrence,
                    });
                  }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
