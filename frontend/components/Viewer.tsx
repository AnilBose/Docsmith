"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "@/lib/api";
import { loadDocument } from "@/lib/pdf";
import { useEditor } from "@/lib/store";
import PageView from "./PageView";

const GAP = 18;

/**
 * The scrolling workspace.
 *
 * Pages are laid out at their true size so the scrollbar is accurate from the
 * first frame, but only pages near the viewport are rasterised. That keeps a
 * 500-page document responsive without a virtual-list library.
 */
export default function Viewer() {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const zoomMode = useEditor((s) => s.zoomMode);
  const viewMode = useEditor((s) => s.viewMode);
  const readingMode = useEditor((s) => s.readingMode);
  const currentPage = useEditor((s) => s.currentPage);
  const setZoom = useEditor((s) => s.setZoom);
  const setPage = useEditor((s) => s.setPage);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [range, setRange] = useState<[number, number]>([0, 3]);
  const programmaticScroll = useRef(false);

  /* ------------------------------------------------------- load the bytes */
  useEffect(() => {
    if (!doc) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    let handle: PDFDocumentProxy | null = null;

    (async () => {
      try {
        const loaded = await loadDocument(api.fileUrl(doc.id, doc.version));
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        handle = loaded;
        setPdf(loaded);
      } catch {
        if (!cancelled) setPdf(null);
      }
    })();

    return () => {
      cancelled = true;
      // Destroying on the next tick avoids racing an in-flight page render.
      setTimeout(() => void handle?.destroy(), 0);
    };
  }, [doc?.id, doc?.version]);

  /* ------------------------------------------------------ viewport metrics */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    });
    observer.observe(element);
    setViewportWidth(element.clientWidth);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  /* ---------------------------------------------------------- zoom fitting */
  useEffect(() => {
    if (!doc || zoomMode === "custom") return;
    const page = doc.pages[Math.min(currentPage, doc.pages.length - 1)];
    if (!page) return;

    const horizontalPadding = 64;
    const verticalPadding = 48;
    if (zoomMode === "fitWidth") {
      setZoom((viewportWidth - horizontalPadding) / page.width, "fitWidth");
    } else if (zoomMode === "fitPage") {
      setZoom(
        Math.min(
          (viewportWidth - horizontalPadding) / page.width,
          (viewportHeight - verticalPadding) / page.height,
        ),
        "fitPage",
      );
    } else if (zoomMode === "actual") {
      setZoom(1, "actual");
    }
  }, [doc, zoomMode, viewportWidth, viewportHeight, currentPage, setZoom]);

  /* --------------------------------------------------- page offsets & range */
  const offsets = useCallback(() => {
    if (!doc) return [] as number[];
    const out: number[] = [];
    let y = GAP;
    for (const page of doc.pages) {
      out.push(y);
      y += page.height * zoom + GAP;
    }
    return out;
  }, [doc, zoom]);

  const updateRange = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !doc) return;
    const tops = offsets();
    const top = element.scrollTop;
    const bottom = top + element.clientHeight;

    let first = 0;
    let last = 0;
    for (let i = 0; i < tops.length; i += 1) {
      const pageTop = tops[i];
      const pageBottom = pageTop + doc.pages[i].height * zoom;
      if (pageBottom >= top - 200 && pageTop <= bottom + 200) {
        if (first === 0 && last === 0) first = i;
        last = i;
      }
    }
    setRange([Math.max(0, first - 1), Math.min(doc.pageCount - 1, last + 1)]);

    if (!programmaticScroll.current) {
      // Whichever page covers the middle of the viewport is "current".
      const middle = top + element.clientHeight / 2;
      let best = 0;
      for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= middle) best = i;
      }
      if (best !== currentPage) setPage(best);
    }
  }, [doc, offsets, zoom, currentPage, setPage]);

  useEffect(() => {
    updateRange();
  }, [updateRange]);

  /* -------------------------------------------------- scroll to a new page */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !doc || viewMode !== "continuous") return;
    const tops = offsets();
    const target = tops[currentPage];
    if (target === undefined) return;
    const visible =
      target >= element.scrollTop - 8 &&
      target <= element.scrollTop + element.clientHeight - 60;
    if (visible) return;

    programmaticScroll.current = true;
    element.scrollTo({ top: Math.max(target - GAP, 0), behavior: "smooth" });
    const timer = setTimeout(() => {
      programmaticScroll.current = false;
    }, 420);
    return () => clearTimeout(timer);
  }, [currentPage, doc, offsets, viewMode]);

  /* ------------------------------------------------- ctrl+wheel to zoom */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(useEditor.getState().zoom * factor, "custom");
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  if (!doc) return null;

  const readingClass =
    readingMode === "night" ? "reading-night" : readingMode === "reading" ? "reading-sepia" : "";

  const pagesToShow =
    viewMode === "continuous"
      ? doc.pages
      : viewMode === "single"
        ? doc.pages.slice(currentPage, currentPage + 1)
        : doc.pages.slice(
            Math.floor(currentPage / 2) * 2,
            Math.floor(currentPage / 2) * 2 + 2,
          );

  return (
    <div
      ref={scrollRef}
      onScroll={updateRange}
      className={`relative flex-1 overflow-auto bg-canvas ${readingClass}`}
    >
      <div
        className={
          viewMode === "facing"
            ? "mx-auto flex w-fit flex-row items-start gap-4 px-8 py-5"
            : "mx-auto flex w-fit flex-col items-center gap-[18px] px-8 py-[18px]"
        }
      >
        {pagesToShow.map((page) => {
          const inRange =
            viewMode !== "continuous" ||
            (page.index >= range[0] && page.index <= range[1]);
          return (
            <PageView
              key={`${page.index}-${doc.version}`}
              pdf={pdf}
              page={page.index}
              width={page.width}
              height={page.height}
              scale={zoom}
              visible={inRange}
            />
          );
        })}
      </div>
    </div>
  );
}
