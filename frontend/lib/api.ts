import { API_PORT } from "./config";
import type {
  Annotation,
  Capabilities,
  DocumentSummary,
  FontFamily,
  ImageObject,
  PageLayout,
  ParagraphEditResult,
  PermissionFlags,
  Rect,
  RedactionFinding,
  SearchMatch,
  SpellIssue,
  TextEdit,
  TextRun,
} from "./types";

/** Same-origin: next.config.mjs rewrites /api to the local Python service. */
const BASE = "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError(
      `Cannot reach the editor service. Is the Python backend running on port ${API_PORT}?`,
      0,
    );
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Trigger a browser download from an endpoint that streams a file. */
async function downloadFrom(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    let detail = `Download failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* streamed binary error */
    }
    throw new ApiError(detail, response.status);
  }

  const disposition = response.headers.get("Content-Disposition") || "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  const name = utf8 ? decodeURIComponent(utf8[1]) : plain ? plain[1] : fallbackName;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const api = {
  /* ------------------------------------------------------------ documents */
  health: () => request<{ status: string; capabilities: Capabilities }>("/api/health"),

  async open(file: File, password?: string): Promise<DocumentSummary> {
    const form = new FormData();
    form.append("file", file);
    if (password) form.append("password", password);
    return request<DocumentSummary>("/api/documents/open", { method: "POST", body: form });
  },

  info: (id: string) => request<DocumentSummary>(`/api/documents/${id}`),
  list: () => request<DocumentSummary[]>("/api/documents"),
  close: (id: string) => request<void>(`/api/documents/${id}`, { method: "DELETE" }),
  undo: (id: string) => request<DocumentSummary>(`/api/documents/${id}/undo`, { method: "POST" }),
  redo: (id: string) => request<DocumentSummary>(`/api/documents/${id}/redo`, { method: "POST" }),

  fileUrl: (id: string, version: number) => `${BASE}/api/documents/${id}/file?v=${version}`,
  pageThumbUrl: (id: string, page: number, version: number, width = 180) =>
    `${BASE}/api/documents/${id}/pages/${page}/thumbnail?width=${width}&v=${version}`,
  imageThumbUrl: (id: string, page: number, xref: number, version: number) =>
    `${BASE}/api/documents/${id}/images/${page}/${xref}/thumbnail?v=${version}`,

  download: (id: string, name: string) =>
    downloadFrom(`/api/documents/${id}/download`, name),

  fonts: (id: string) => request<FontFamily[]>(`/api/documents/${id}/fonts`),
  fontFileUrl: (id: string, fontId: string) =>
    `${BASE}/api/documents/${id}/fonts/${encodeURIComponent(fontId)}/file`,
  security: (id: string) => request<any>(`/api/documents/${id}/security`),
  sanitize: (id: string) => request<any>(`/api/documents/${id}/sanitize`, { method: "POST" }),
  setMetadata: (id: string, meta: Record<string, string>) =>
    request<DocumentSummary>(`/api/documents/${id}/metadata`, {
      ...json(meta),
      method: "PUT",
    }),

  /* ----------------------------------------------------------------- text */
  layout: (id: string, page: number) =>
    request<PageLayout>(`/api/documents/${id}/text/layout/${page}`),

  editText: (id: string, edits: TextEdit[]) =>
    request<{ applied: number; document: DocumentSummary }>(
      `/api/documents/${id}/text/edit`,
      json({ edits }),
    ),

  /** Rewrite a whole paragraph; the content after it reflows across pages. */
  editParagraph: (
    id: string,
    payload: {
      page: number;
      paragraphId: string;
      version?: number;
      items: TextRun[][];
      align?: "left" | "center" | "right" | "justify";
      reflow?: boolean;
      lift?: number;
    },
  ) => request<ParagraphEditResult>(`/api/documents/${id}/text/paragraph`, json(payload)),

  search: (
    id: string,
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; pages?: number[] } = {},
  ) =>
    request<{ count: number; matches: SearchMatch[] }>(
      `/api/documents/${id}/text/search`,
      json({ query, ...opts }),
    ),

  replace: (
    id: string,
    query: string,
    replacement: string,
    opts: {
      regex?: boolean;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      pages?: number[];
      matchIds?: string[];
    } = {},
  ) =>
    request<{ replaced: number; document: DocumentSummary }>(
      `/api/documents/${id}/text/replace`,
      json({ query, replacement, ...opts }),
    ),

  changeCase: (id: string, page: number, spanIds: string[], mode: string) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/text/case`,
      json({ page, spanIds, mode }),
    ),

  spellCheck: (id: string, pages?: number[], language = "en") =>
    request<{ count: number; issues: SpellIssue[] }>(
      `/api/documents/${id}/text/spell`,
      json({ pages, language }),
    ),

  /* --------------------------------------------------------------- images */
  images: (id: string, page: number) =>
    request<ImageObject[]>(`/api/documents/${id}/images/${page}`),

  async addImage(id: string, page: number, file: File, rect?: Rect) {
    const form = new FormData();
    form.append("file", file);
    form.append("page", String(page));
    if (rect) form.append("rect", rect.join(","));
    return request<{ document: DocumentSummary }>(`/api/documents/${id}/images`, {
      method: "POST",
      body: form,
    });
  },

  async replaceImage(id: string, page: number, xref: number, file: File, occurrence = 0) {
    const form = new FormData();
    form.append("file", file);
    form.append("page", String(page));
    form.append("xref", String(xref));
    form.append("occurrence", String(occurrence));
    return request<{ document: DocumentSummary }>(`/api/documents/${id}/images/replace`, {
      method: "POST",
      body: form,
    });
  },

  transformImage: (
    id: string,
    payload: {
      page: number;
      xref: number;
      occurrence?: number;
      rect?: Rect;
      rotate?: number;
      flipH?: boolean;
      flipV?: boolean;
      crop?: [number, number, number, number];
      opacity?: number;
      jpegQuality?: number;
      keepAspect?: boolean;
    },
  ) =>
    request<{ document: DocumentSummary; bbox: Rect }>(
      `/api/documents/${id}/images/transform`,
      json(payload),
    ),

  deleteImage: (id: string, page: number, xref: number, occurrence = 0) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/images/${page}/${xref}?occurrence=${occurrence}`,
      { method: "DELETE" },
    ),

  extractImage: (id: string, page: number, xref: number) =>
    downloadFrom(`/api/documents/${id}/images/${page}/${xref}/extract`, `image-${xref}.png`),

  compressImages: (id: string, quality: number, maxDpi: number) =>
    request<{ document: DocumentSummary; saved: number; images: number }>(
      `/api/documents/${id}/images/compress`,
      json({ quality, maxDpi }),
    ),

  /* ---------------------------------------------------------------- pages */
  addBlank: (id: string, at?: number) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/blank`, json({ at })),
  deletePages: (id: string, pages: number[]) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/delete`, json({ pages })),
  duplicatePages: (id: string, pages: number[]) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/duplicate`, json({ pages })),
  reorderPages: (id: string, order: number[]) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/reorder`, json({ order })),
  movePage: (id: string, source: number, destination: number) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/pages/move`,
      json({ source, destination }),
    ),
  rotatePages: (id: string, pages: number[], angle: number) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/pages/rotate`,
      json({ pages, angle }),
    ),
  extractPages: (id: string, pages: number[]) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/extract`, json({ pages })),
  insertFrom: (id: string, sourceId: string, at?: number, pages?: number[]) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/pages/insert-from`,
      json({ sourceId, at, pages }),
    ),
  replacePages: (id: string, sourceId: string, targets: number[], sourcePages?: number[]) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/pages/replace`,
      json({ sourceId, targets, sourcePages }),
    ),
  splitPages: (id: string, every?: number, at?: number[]) =>
    request<{ parts: DocumentSummary[] }>(`/api/documents/${id}/pages/split`, json({ every, at })),
  movePagesBetween: (id: string, targetId: string, pages: number[], at?: number) =>
    request<{ source: DocumentSummary; target: DocumentSummary }>(
      `/api/documents/${id}/pages/move-between`,
      json({ targetId, pages, at }),
    ),
  addCover: (id: string, title: string, subtitle: string, atEnd = false) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${id}/pages/cover`,
      json({ title, subtitle, atEnd }),
    ),
  addPageNumbers: (
    id: string,
    opts: {
      position?: string;
      template?: string;
      startAt?: number;
      style?: string;
      fontSize?: number;
      color?: string;
      skipFirst?: boolean;
    },
  ) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/pages/numbering`, json(opts)),
  merge: (documentIds: string[], filename = "merged.pdf") =>
    request<{ document: DocumentSummary }>("/api/merge", json({ documentIds, filename })),

  /* ---------------------------------------------------------- annotations */
  annotations: (id: string, page?: number) =>
    request<Annotation[]>(
      `/api/documents/${id}/annotations${page === undefined ? "" : `?page=${page}`}`,
    ),
  addMarkup: (
    id: string,
    page: number,
    kind: string,
    quads: number[][],
    color?: string,
    note = "",
  ) =>
    request<{ annotation: Annotation; document: DocumentSummary }>(
      `/api/documents/${id}/annotations/markup`,
      json({ page, kind, quads, color, note }),
    ),
  addNote: (id: string, page: number, point: [number, number], contents: string) =>
    request<{ annotation: Annotation; document: DocumentSummary }>(
      `/api/documents/${id}/annotations/note`,
      json({ page, point, contents }),
    ),
  addFreeText: (id: string, page: number, rect: Rect, contents: string, size = 11) =>
    request<{ annotation: Annotation; document: DocumentSummary }>(
      `/api/documents/${id}/annotations/free-text`,
      json({ page, rect, contents, size }),
    ),
  updateAnnotation: (
    id: string,
    payload: { page: number; xref: number; contents?: string; color?: string; opacity?: number },
  ) =>
    request<{ annotation: Annotation; document: DocumentSummary }>(
      `/api/documents/${id}/annotations`,
      { ...json(payload), method: "PUT" },
    ),
  deleteAnnotation: (id: string, page: number, xref: number) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/annotations/${page}/${xref}`, {
      method: "DELETE",
    }),

  /* -------------------------------------------------------------- convert */
  capabilities: () => request<Capabilities>("/api/convert/capabilities"),

  async convertToPdf(files: File[]): Promise<{ document: DocumentSummary }> {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("open_after", "true");
    return request<{ document: DocumentSummary }>("/api/convert/to-pdf", {
      method: "POST",
      body: form,
    });
  },

  async htmlToPdf(html: string, filename?: string): Promise<{ document: DocumentSummary }> {
    const form = new FormData();
    form.append("html", html);
    form.append("open_after", "true");
    if (filename) form.append("filename", filename);
    return request<{ document: DocumentSummary }>("/api/convert/html-to-pdf", {
      method: "POST",
      body: form,
    });
  },

  async textToPdf(text: string): Promise<{ document: DocumentSummary }> {
    const form = new FormData();
    form.append("text", text);
    form.append("open_after", "true");
    return request<{ document: DocumentSummary }>("/api/convert/text-to-pdf", {
      method: "POST",
      body: form,
    });
  },

  exportAs: (id: string, format: string, name: string, pages?: string, dpi = 200) => {
    const query = new URLSearchParams({ format, dpi: String(dpi) });
    if (pages) query.set("pages", pages);
    return downloadFrom(`/api/convert/${id}/export?${query}`, `${name}.${format}`);
  },

  /** A conversion's bytes, for opening in the Word or spreadsheet view instead of downloading. */
  async exportBytes(id: string, format: string): Promise<ArrayBuffer> {
    const response = await fetch(`${BASE}/api/convert/${id}/export?${new URLSearchParams({ format })}`);
    if (!response.ok) {
      let detail = `Conversion failed (${response.status})`;
      try {
        const body = await response.json();
        if (body?.detail) detail = body.detail;
      } catch {
        /* streamed binary error */
      }
      throw new ApiError(detail, response.status);
    }
    return response.arrayBuffer();
  },

  /* ------------------------------------------------------------- security */
  protect: (
    id: string,
    payload: {
      openPassword: string;
      ownerPassword: string;
      algorithm: string;
      permissions: PermissionFlags;
    },
  ) => {
    return (async () => {
      const response = await fetch(`${BASE}/api/documents/${id}/protect`, json(payload));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(body.detail || "Encryption failed", response.status);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "protected.pdf";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    })();
  },

  removePassword: (id: string) =>
    downloadFrom(`/api/documents/${id}/remove-password`, "unprotected.pdf"),

  certificateSupport: () =>
    request<{ supported: boolean; reason: string }>("/api/security/certificate-support"),

  /* ------------------------------------------------------------ redaction */
  redactionPatterns: () => request<{ id: string; label: string }[]>("/api/redaction/patterns"),

  detectSensitive: (id: string, kinds: string[], customPatterns: string[] = []) =>
    request<{ count: number; findings: RedactionFinding[] }>(
      `/api/documents/${id}/redaction/detect`,
      json({ kinds, customPatterns }),
    ),

  findForRedaction: (
    id: string,
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {},
  ) =>
    request<{ count: number; findings: RedactionFinding[] }>(
      `/api/documents/${id}/redaction/find`,
      json({ query, ...opts }),
    ),

  listRedactionMarks: (id: string, page?: number) =>
    request<{ id: string; xref: number; page: number; rect: Rect }[]>(
      `/api/documents/${id}/redaction/marks${page === undefined ? "" : `?page=${page}`}`,
    ),

  markRedactions: (
    id: string,
    marks: { page: number; rects: Rect[] }[],
    overlayText = "",
    fill: string | null = "#000000",
  ) =>
    request<{ marked: number; document: DocumentSummary }>(
      `/api/documents/${id}/redaction/mark`,
      json({ marks, overlayText, fill }),
    ),

  clearRedactions: (id: string) =>
    request<{ document: DocumentSummary }>(`/api/documents/${id}/redaction/clear`, json({})),

  applyRedactions: (id: string, removeImages = true, removeVectors = true) =>
    request<{ applied: number; document: DocumentSummary }>(
      `/api/documents/${id}/redaction/apply`,
      json({ removeImages, removeVectors }),
    ),

  verifyRedactions: (id: string, strings: string[]) =>
    request<{ clean: boolean; remaining: { page: number; text: string }[] }>(
      `/api/documents/${id}/redaction/verify`,
      json({ strings }),
    ),

  async unlock(file: File, password: string) {
    const form = new FormData();
    form.append("file", file);
    form.append("password", password);
    return request<{ document: DocumentSummary }>("/api/unlock", {
      method: "POST",
      body: form,
    });
  },
};
