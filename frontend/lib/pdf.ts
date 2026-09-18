"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * pdf.js is loaded lazily and configured to use a worker copied into /public
 * at build time. Nothing is fetched from a CDN, so rendering works with no
 * network at all.
 */
let pdfjs: typeof import("pdfjs-dist") | null = null;

export async function getPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  pdfjs = lib;
  return lib;
}

export async function loadDocument(url: string): Promise<PDFDocumentProxy> {
  const lib = await getPdfjs();
  const task = lib.getDocument({
    url,
    // The document already lives in our own backend; never let a PDF pull in
    // remote resources of its own.
    isEvalSupported: false,
    disableAutoFetch: false,
    disableFontFace: false,
    useSystemFonts: true,
  });
  return task.promise;
}

/** Device pixel ratio, clamped so huge zoom levels cannot exhaust memory. */
export function renderScale(zoom: number): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(dpr, 2) * Math.min(zoom, 8);
}
