"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "@/lib/api";
import { renderScale } from "@/lib/pdf";
import { useEditor } from "@/lib/store";
import type { Rect } from "@/lib/types";
import ImageLayer from "./ImageLayer";
import TextLayer from "./TextLayer";

interface Props {
  pdf: PDFDocumentProxy | null;
  page: number;
  width: number;
  height: number;
  scale: number;
  visible: boolean;
}

/** One rendered page plus every interactive overlay that belongs on it. */
export default function PageView({ pdf, page, width, height, scale, visible }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const renderTask = useRef<{ cancel: () => void } | null>(null);
  const [rendered, setRendered] = useState(false);

  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const layout = useEditor((s) => s.layouts[page]);
  const loadLayout = useEditor((s) => s.loadLayout);
  const loadImages = useEditor((s) => s.loadImages);
  const searchMatches = useEditor((s) => s.searchMatches);
  const activeMatch = useEditor((s) => s.activeMatch);
  const spellIssues = useEditor((s) => s.spellIssues);
  const redactionFindings = useEditor((s) => s.redactionFindings);
  const stagedRedactions = useEditor((s) => s.stagedRedactions);
  const setPage = useEditor((s) => s.setPage);
  const run = useEditor((s) => s.run);
  const setDocument = useEditor((s) => s.setDocument);
  const notify = useEditor((s) => s.notify);

  // Rubber-band selection, used by the markup and redaction tools.
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);

  /* ------------------------------------------------------------- rendering */
  useEffect(() => {
    if (!pdf || !visible) return;
    let cancelled = false;

    (async () => {
      try {
        const pdfPage = await pdf.getPage(page + 1);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const output = renderScale(scale);
        const viewport = pdfPage.getViewport({ scale: output });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${width * scale}px`;
        canvas.style.height = `${height * scale}px`;

        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;

        renderTask.current?.cancel();
        const task = pdfPage.render({ canvasContext: context, viewport });
        renderTask.current = task;
        await task.promise;
        if (!cancelled) setRendered(true);
      } catch (error) {
        // A cancelled render is expected whenever zoom or the document changes.
        const name = (error as { name?: string })?.name;
        if (name !== "RenderingCancelledException" && !cancelled) {
          setRendered(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask.current?.cancel();
      renderTask.current = null;
    };
  }, [pdf, page, scale, visible, width, height]);

  /* --------------------------------------------------------- overlay data */
  useEffect(() => {
    if (!visible || !doc) return;
    if (tool === "editText" || tool === "addText") void loadLayout(page);
    if (tool === "editImage" || tool === "select") void loadImages(page);
  }, [visible, doc, tool, page, loadLayout, loadImages]);

  /* ------------------------------------------------------------- marquee */
  const marqueeTools = new Set(["redact", "addText", "addImage", "comment"]);
  const marqueeActive = marqueeTools.has(tool);

  function toPageSpace(event: React.MouseEvent): { x: number; y: number } {
    const rect = wrapperRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  }

  function onMouseDown(event: React.MouseEvent) {
    setPage(page);
    if (!marqueeActive || event.button !== 0) return;
    const point = toPageSpace(event);
    marqueeStart.current = point;
    setMarquee([point.x, point.y, point.x, point.y]);
  }

  function onMouseMove(event: React.MouseEvent) {
    if (!marqueeStart.current) return;
    const point = toPageSpace(event);
    const start = marqueeStart.current;
    setMarquee([
      Math.min(start.x, point.x),
      Math.min(start.y, point.y),
      Math.max(start.x, point.x),
      Math.max(start.y, point.y),
    ]);
  }

  async function onMouseUp() {
    const box = marquee;
    marqueeStart.current = null;
    setMarquee(null);
    if (!box || !doc) return;

    const tooSmall = box[2] - box[0] < 4 || box[3] - box[1] < 4;

    if (tool === "redact") {
      if (tooSmall) return;
      await run("Marking area", async () => {
        const result = await api.markRedactions(doc.id, [{ page, rects: [box] }]);
        setDocument(result.document);
        notify("info", "Area marked. Use Apply Redactions to remove it permanently.");
      });
      return;
    }

    if (tool === "addText") {
      const rect: Rect = tooSmall ? [box[0], box[1], box[0] + 220, box[1] + 26] : box;
      const text = window.prompt("Text to add:");
      if (!text) return;
      await run("Adding text", async () => {
        const result = await api.editText(doc.id, [
          { page, action: "insert", rect, text, style: { size: 12, color: "#000000" } },
        ]);
        setDocument(result.document);
        await loadLayout(page, true);
      });
      return;
    }

    if (tool === "comment") {
      const text = window.prompt("Comment:");
      if (!text) return;
      await run("Adding comment", async () => {
        const result = await api.addNote(doc.id, page, [box[0], box[1]], text);
        setDocument(result.document);
      });
      return;
    }

    if (tool === "addImage") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const rect: Rect | undefined = tooSmall ? undefined : box;
        await run("Placing image", async () => {
          const result = await api.addImage(doc.id, page, file, rect);
          setDocument(result.document);
          await loadImages(page, true);
        });
      };
      input.click();
    }
  }

  /* ------------------------------------------------- text-selection markup */
  async function applySelectionMarkup() {
    if (!doc) return;
    const kind =
      tool === "highlight" ? "highlight" : tool === "underline" ? "underline" : "strikeout";
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text) {
      notify("info", "Select some text on the page first.");
      return;
    }
    // Resolve the selected string back to page coordinates through search.
    await run("Adding markup", async () => {
      const found = await api.search(doc.id, text, { pages: [page], caseSensitive: true });
      if (!found.matches.length) {
        notify("warn", "Could not locate that selection in the page text.");
        return;
      }
      const rects = found.matches[0].rects;
      const result = await api.addMarkup(doc.id, page, kind, rects);
      setDocument(result.document);
      selection?.removeAllRanges();
    });
  }

  const markupTool = tool === "highlight" || tool === "underline" || tool === "strikeout";

  /* -------------------------------------------------------------- overlays */
  const pageMatches = searchMatches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.page === page);
  const pageSpell = spellIssues.filter((issue) => issue.page === page);
  const pageRedactions = redactionFindings.filter((finding) => finding.page === page);

  return (
    <div
      ref={wrapperRef}
      data-page={page}
      className="relative bg-white page-shadow"
      style={{ width: width * scale, height: height * scale }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => void onMouseUp()}
      onMouseUpCapture={markupTool ? () => void applySelectionMarkup() : undefined}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {!rendered && (
        <div className="absolute inset-0 grid place-items-center bg-white">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-chrome-300 border-t-accent" />
        </div>
      )}

      {/* search results */}
      {pageMatches.map(({ match, index }) =>
        match.rects.map((rect, i) => (
          <div
            key={`${match.id}-${i}`}
            className={`search-hit ${index === activeMatch ? "search-hit-active" : ""}`}
            style={{
              left: rect[0] * scale,
              top: rect[1] * scale,
              width: (rect[2] - rect[0]) * scale,
              height: (rect[3] - rect[1]) * scale,
            }}
          />
        )),
      )}

      {/* spelling */}
      {pageSpell.map((issue) =>
        issue.rects.map((rect, i) => (
          <div
            key={`${issue.id}-${i}`}
            className="spell-underline"
            style={{
              left: rect[0] * scale,
              top: rect[3] * scale - 2,
              width: (rect[2] - rect[0]) * scale,
            }}
          />
        )),
      )}

      {/* pending redactions */}
      {pageRedactions
        .filter((finding) => stagedRedactions.includes(finding.id))
        .map((finding) =>
          finding.rects.map((rect, i) => (
            <div
              key={`${finding.id}-${i}`}
              className="redact-preview"
              style={{
                left: rect[0] * scale,
                top: rect[1] * scale,
                width: (rect[2] - rect[0]) * scale,
                height: (rect[3] - rect[1]) * scale,
              }}
            />
          )),
        )}

      <TextLayer page={page} layout={layout} scale={scale} />
      <ImageLayer page={page} scale={scale} />

      {marquee && (
        <div
          className="pointer-events-none absolute border border-accent bg-accent/20"
          style={{
            left: marquee[0] * scale,
            top: marquee[1] * scale,
            width: (marquee[2] - marquee[0]) * scale,
            height: (marquee[3] - marquee[1]) * scale,
          }}
        />
      )}
    </div>
  );
}
