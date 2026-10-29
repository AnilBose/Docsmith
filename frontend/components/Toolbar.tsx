"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useEditor } from "@/lib/store";
import type { ReadingMode, ViewMode } from "@/lib/types";
import { Icon } from "./Icons";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/** The compact command strip directly above the page canvas. */
export default function Toolbar() {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const zoomMode = useEditor((s) => s.zoomMode);
  const setZoom = useEditor((s) => s.setZoom);
  const setZoomMode = useEditor((s) => s.setZoomMode);
  const viewMode = useEditor((s) => s.viewMode);
  const setViewMode = useEditor((s) => s.setViewMode);
  const readingMode = useEditor((s) => s.readingMode);
  const setReadingMode = useEditor((s) => s.setReadingMode);
  const currentPage = useEditor((s) => s.currentPage);
  const setPage = useEditor((s) => s.setPage);
  const sidebarOpen = useEditor((s) => s.sidebarOpen);
  const toggleSidebar = useEditor((s) => s.toggleSidebar);
  const propertiesOpen = useEditor((s) => s.propertiesOpen);
  const setPropertiesOpen = useEditor((s) => s.setPropertiesOpen);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);

  // Track the browser's own state so leaving with Esc keeps the button in sync.
  useEffect(() => {
    setCanFullscreen(document.fullscreenEnabled);
    const sync = () => setFullscreen(document.fullscreenElement !== null);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {
        /* the browser refused (e.g. not triggered by a click); nothing to do */
      });
    }
  }

  function stepZoom(direction: 1 | -1) {
    const index = ZOOM_STEPS.findIndex((step) => step > zoom + 1e-6);
    if (direction > 0) {
      setZoom(ZOOM_STEPS[index === -1 ? ZOOM_STEPS.length - 1 : index], "custom");
    } else {
      const below = [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-6);
      setZoom(below ?? ZOOM_STEPS[0], "custom");
    }
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-chrome-800 bg-chrome-850 px-2">
      <button
        type="button"
        className={`tool-btn ${sidebarOpen ? "tool-btn-active" : ""}`}
        onClick={() => toggleSidebar()}
        title="Toggle side panel"
      >
        <Icon.Sidebar size={16} />
      </button>

      <span className="divider" />

      <button
        type="button"
        className="tool-btn"
        disabled={!doc?.canUndo}
        onClick={() => void undo()}
        title="Undo (Ctrl+Z)"
      >
        <Icon.Undo size={16} />
      </button>
      <button
        type="button"
        className="tool-btn"
        disabled={!doc?.canRedo}
        onClick={() => void redo()}
        title="Redo (Ctrl+Y)"
      >
        <Icon.Redo size={16} />
      </button>

      <span className="divider" />

      {/* page navigation */}
      <button
        type="button"
        className="tool-btn"
        disabled={!doc || currentPage === 0}
        onClick={() => setPage(currentPage - 1)}
        title="Previous page"
      >
        <span className="rotate-180">
          <Icon.Chevron size={15} />
        </span>
      </button>
      <input
        className="field w-11 text-center"
        value={doc ? currentPage + 1 : ""}
        disabled={!doc}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next >= 1) setPage(next - 1);
        }}
        aria-label="Page number"
      />
      <span className="px-0.5 text-2xs text-chrome-500">/ {doc?.pageCount ?? 0}</span>
      <button
        type="button"
        className="tool-btn"
        disabled={!doc || currentPage >= (doc?.pageCount ?? 1) - 1}
        onClick={() => setPage(currentPage + 1)}
        title="Next page"
      >
        <Icon.Chevron size={15} />
      </button>

      <span className="divider" />

      {/* zoom */}
      <button type="button" className="tool-btn" onClick={() => stepZoom(-1)} title="Zoom out">
        <Icon.ZoomOut size={16} />
      </button>
      <select
        className="field w-[96px]"
        value={zoomMode === "custom" ? "custom" : zoomMode}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "custom") return;
          setZoomMode(next as typeof zoomMode);
        }}
      >
        <option value="custom">{Math.round(zoom * 100)}%</option>
        <option value="fitWidth">Fit width</option>
        <option value="fitPage">Fit page</option>
        <option value="actual">100%</option>
      </select>
      <button type="button" className="tool-btn" onClick={() => stepZoom(1)} title="Zoom in">
        <Icon.ZoomIn size={16} />
      </button>
      <button
        type="button"
        className={`tool-btn ${zoomMode === "fitWidth" ? "tool-btn-active" : ""}`}
        onClick={() => setZoomMode("fitWidth")}
        title="Fit width"
      >
        <Icon.FitWidth size={16} />
      </button>
      <button
        type="button"
        className={`tool-btn ${zoomMode === "fitPage" ? "tool-btn-active" : ""}`}
        onClick={() => setZoomMode("fitPage")}
        title="Fit page"
      >
        <Icon.FitPage size={16} />
      </button>
      {canFullscreen && (
        <button
          type="button"
          className={`tool-btn ${fullscreen ? "tool-btn-active" : ""}`}
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <Icon.ExitFullscreen size={16} /> : <Icon.Fullscreen size={16} />}
        </button>
      )}

      <span className="divider" />

      <select
        className="field w-[118px]"
        value={viewMode}
        onChange={(event) => setViewMode(event.target.value as ViewMode)}
        title="Page layout"
      >
        <option value="continuous">Continuous</option>
        <option value="single">Single page</option>
        <option value="facing">Two pages</option>
      </select>

      <select
        className="field w-[100px]"
        value={readingMode}
        onChange={(event) => setReadingMode(event.target.value as ReadingMode)}
        title="Reading mode"
      >
        <option value="normal">Normal</option>
        <option value="reading">Reading</option>
        <option value="night">Night</option>
      </select>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className="btn-primary"
          disabled={!doc}
          onClick={() => doc && void api.download(doc.id, doc.filename)}
          title="Download the edited PDF"
        >
          <Icon.Download size={15} /> Download
        </button>
        <button
          type="button"
          className={`tool-btn ${propertiesOpen ? "tool-btn-active" : ""}`}
          onClick={() => setPropertiesOpen(!propertiesOpen)}
          title="Toggle properties"
        >
          <Icon.Properties size={16} />
        </button>
      </div>
    </div>
  );
}
