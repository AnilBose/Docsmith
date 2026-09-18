"use client";

import { create } from "zustand";
import { api, ApiError } from "./api";
import type {
  Annotation,
  Capabilities,
  DocumentSummary,
  FontFamily,
  ImageObject,
  PageLayout,
  ReadingMode,
  RedactionFinding,
  SearchMatch,
  SpellIssue,
  TextEdit,
  ToolMode,
  ViewMode,
  ZoomMode,
} from "./types";

export type Toast = {
  id: number;
  kind: "info" | "success" | "error" | "warn";
  message: string;
};

export type SidebarTab = "thumbnails" | "search" | "comments" | "redact" | "spell" | "images";

interface EditorState {
  /* ------------------------------------------------------------ document */
  doc: DocumentSummary | null;
  openDocs: DocumentSummary[];
  loading: boolean;
  busy: string | null;

  /* ---------------------------------------------------------------- view */
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  viewMode: ViewMode;
  readingMode: ReadingMode;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  propertiesOpen: boolean;
  ribbonTab: string;

  /* ---------------------------------------------------------------- tools */
  tool: ToolMode;
  selectedSpanIds: string[];
  selectedImage: ImageObject | null;
  selectedAnnotation: Annotation | null;
  selectedPages: number[];

  /* ---------------------------------------------------------------- data */
  layouts: Record<number, PageLayout>;
  images: Record<number, ImageObject[]>;
  annotations: Annotation[];
  fonts: FontFamily[];
  capabilities: Capabilities | null;

  searchQuery: string;
  searchMatches: SearchMatch[];
  activeMatch: number;
  searchOptions: { regex: boolean; caseSensitive: boolean; wholeWord: boolean };

  redactionFindings: RedactionFinding[];
  stagedRedactions: string[];
  spellIssues: SpellIssue[];

  toasts: Toast[];

  /* ------------------------------------------------------------- actions */
  notify: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  run: <T>(label: string, task: () => Promise<T>) => Promise<T | undefined>;

  openFile: (file: File, password?: string) => Promise<void>;
  setDocument: (doc: DocumentSummary) => void;
  refreshDocument: () => Promise<void>;
  closeDocument: (id: string) => Promise<void>;
  switchDocument: (id: string) => void;

  setPage: (page: number) => void;
  setZoom: (zoom: number, mode?: ZoomMode) => void;
  setZoomMode: (mode: ZoomMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setReadingMode: (mode: ReadingMode) => void;
  toggleSidebar: (open?: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setPropertiesOpen: (open: boolean) => void;
  setRibbonTab: (tab: string) => void;

  setTool: (tool: ToolMode) => void;
  selectSpans: (ids: string[], additive?: boolean) => void;
  selectImage: (image: ImageObject | null) => void;
  selectAnnotation: (annotation: Annotation | null) => void;
  setSelectedPages: (pages: number[]) => void;

  loadLayout: (page: number, force?: boolean) => Promise<PageLayout | undefined>;
  loadImages: (page: number, force?: boolean) => Promise<ImageObject[] | undefined>;
  loadAnnotations: () => Promise<void>;
  invalidate: () => void;

  applyEdits: (edits: TextEdit[]) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  runSearch: (query: string) => Promise<void>;
  setSearchOptions: (options: Partial<EditorState["searchOptions"]>) => void;
  gotoMatch: (index: number) => void;
  replaceAll: (replacement: string) => Promise<void>;
  replaceOne: (matchId: string, replacement: string) => Promise<void>;

  detectSensitive: (kinds: string[]) => Promise<void>;
  stageRedactions: (ids: string[]) => Promise<void>;
  applyRedactions: () => Promise<void>;

  runSpellCheck: () => Promise<void>;
  fixSpelling: (issue: SpellIssue, replacement: string) => Promise<void>;
}

let toastSeq = 0;

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  openDocs: [],
  loading: false,
  busy: null,

  currentPage: 0,
  zoom: 1,
  zoomMode: "fitWidth",
  viewMode: "continuous",
  readingMode: "normal",
  sidebarOpen: true,
  sidebarTab: "thumbnails",
  propertiesOpen: true,
  ribbonTab: "home",

  tool: "select",
  selectedSpanIds: [],
  selectedImage: null,
  selectedAnnotation: null,
  selectedPages: [],

  layouts: {},
  images: {},
  annotations: [],
  fonts: [],
  capabilities: null,

  searchQuery: "",
  searchMatches: [],
  activeMatch: -1,
  searchOptions: { regex: false, caseSensitive: false, wholeWord: false },

  redactionFindings: [],
  stagedRedactions: [],
  spellIssues: [],

  toasts: [],

  /* --------------------------------------------------------------- toasts */
  notify: (kind, message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    const ttl = kind === "error" ? 8000 : 3600;
    setTimeout(() => get().dismissToast(id), ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /** Wrap an async action with a busy label and uniform error reporting. */
  run: async (label, task) => {
    set({ busy: label });
    try {
      return await task();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Something went wrong.";
      get().notify("error", message);
      return undefined;
    } finally {
      set({ busy: null });
    }
  },

  /* ------------------------------------------------------------ documents */
  openFile: async (file, password) => {
    set({ loading: true });
    try {
      const doc = await api.open(file, password);
      set((s) => ({
        doc,
        openDocs: [...s.openDocs.filter((d) => d.id !== doc.id), doc],
        currentPage: 0,
        layouts: {},
        images: {},
        annotations: [],
        selectedSpanIds: [],
        selectedImage: null,
        selectedPages: [],
        searchMatches: [],
        redactionFindings: [],
        spellIssues: [],
      }));
      const [fonts, capabilities] = await Promise.all([
        api.fonts(doc.id).catch(() => []),
        api.capabilities().catch(() => null),
      ]);
      set({ fonts, capabilities });
      get().notify("success", `Opened ${doc.filename} (${doc.pageCount} pages)`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      const message = error instanceof Error ? error.message : "Could not open the file.";
      get().notify("error", message);
    } finally {
      set({ loading: false });
    }
  },

  setDocument: (doc) =>
    set((s) => ({
      doc,
      openDocs: s.openDocs.map((d) => (d.id === doc.id ? doc : d)),
      layouts: {},
      images: {},
      currentPage: Math.min(s.currentPage, Math.max(doc.pageCount - 1, 0)),
    })),

  refreshDocument: async () => {
    const { doc } = get();
    if (!doc) return;
    const fresh = await api.info(doc.id).catch(() => null);
    if (fresh) get().setDocument(fresh);
  },

  closeDocument: async (id) => {
    await api.close(id).catch(() => undefined);
    set((s) => {
      const remaining = s.openDocs.filter((d) => d.id !== id);
      const nextDoc = s.doc?.id === id ? (remaining[0] ?? null) : s.doc;
      return {
        openDocs: remaining,
        doc: nextDoc,
        layouts: {},
        images: {},
        annotations: [],
        currentPage: 0,
      };
    });
  },

  switchDocument: (id) => {
    const target = get().openDocs.find((d) => d.id === id);
    if (!target) return;
    set({
      doc: target,
      currentPage: 0,
      layouts: {},
      images: {},
      annotations: [],
      selectedSpanIds: [],
      selectedImage: null,
    });
    api.fonts(id).then((fonts) => set({ fonts })).catch(() => undefined);
  },

  /* ----------------------------------------------------------------- view */
  setPage: (page) => {
    const doc = get().doc;
    if (!doc) return;
    set({ currentPage: Math.max(0, Math.min(page, doc.pageCount - 1)) });
  },
  setZoom: (zoom, mode = "custom") =>
    set({ zoom: Math.max(0.1, Math.min(zoom, 10)), zoomMode: mode }),
  setZoomMode: (zoomMode) => set({ zoomMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setReadingMode: (readingMode) =>
    set((s) => ({
      readingMode,
      sidebarOpen: readingMode === "normal" ? s.sidebarOpen : false,
      propertiesOpen: readingMode === "normal" ? s.propertiesOpen : false,
    })),
  toggleSidebar: (open) => set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen })),
  setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
  setPropertiesOpen: (propertiesOpen) => set({ propertiesOpen }),
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),

  /* ---------------------------------------------------------------- tools */
  setTool: (tool) => {
    set({ tool, selectedSpanIds: [], selectedImage: null, selectedAnnotation: null });
    const page = get().currentPage;
    if (tool === "editText") void get().loadLayout(page);
    if (tool === "editImage") void get().loadImages(page);
  },

  selectSpans: (ids, additive = false) =>
    set((s) => ({
      selectedSpanIds: additive
        ? Array.from(new Set([...s.selectedSpanIds, ...ids]))
        : ids,
      selectedImage: null,
      propertiesOpen: ids.length > 0 ? true : s.propertiesOpen,
    })),

  selectImage: (selectedImage) =>
    set((s) => ({
      selectedImage,
      selectedSpanIds: [],
      propertiesOpen: selectedImage ? true : s.propertiesOpen,
    })),

  selectAnnotation: (selectedAnnotation) => set({ selectedAnnotation }),
  setSelectedPages: (selectedPages) => set({ selectedPages }),

  /* ----------------------------------------------------------------- data */
  loadLayout: async (page, force = false) => {
    const { doc, layouts } = get();
    if (!doc) return undefined;
    if (!force && layouts[page]) return layouts[page];
    try {
      const layout = await api.layout(doc.id, page);
      set((s) => ({ layouts: { ...s.layouts, [page]: layout } }));
      return layout;
    } catch {
      return undefined;
    }
  },

  loadImages: async (page, force = false) => {
    const { doc, images } = get();
    if (!doc) return undefined;
    if (!force && images[page]) return images[page];
    try {
      const list = await api.images(doc.id, page);
      set((s) => ({ images: { ...s.images, [page]: list } }));
      return list;
    } catch {
      return undefined;
    }
  },

  loadAnnotations: async () => {
    const { doc } = get();
    if (!doc) return;
    const annotations = await api.annotations(doc.id).catch(() => []);
    set({ annotations });
  },

  /** Drop every derived cache after the document bytes change. */
  invalidate: () =>
    set({ layouts: {}, images: {}, selectedSpanIds: [], selectedImage: null }),

  /* ---------------------------------------------------------------- edits */
  applyEdits: async (edits) => {
    const { doc } = get();
    if (!doc || edits.length === 0) return;
    await get().run("Applying edit", async () => {
      const result = await api.editText(doc.id, edits);
      get().setDocument(result.document);
      get().notify("success", `Applied ${result.applied} change${result.applied === 1 ? "" : "s"}`);
      await get().loadLayout(get().currentPage, true);
    });
  },

  undo: async () => {
    const { doc } = get();
    if (!doc?.canUndo) return;
    await get().run("Undo", async () => {
      const fresh = await api.undo(doc.id);
      get().setDocument(fresh);
      await get().loadLayout(get().currentPage, true);
    });
  },

  redo: async () => {
    const { doc } = get();
    if (!doc?.canRedo) return;
    await get().run("Redo", async () => {
      const fresh = await api.redo(doc.id);
      get().setDocument(fresh);
      await get().loadLayout(get().currentPage, true);
    });
  },

  /* --------------------------------------------------------------- search */
  runSearch: async (query) => {
    const { doc, searchOptions } = get();
    set({ searchQuery: query });
    if (!doc || !query.trim()) {
      set({ searchMatches: [], activeMatch: -1 });
      return;
    }
    await get().run("Searching", async () => {
      const result = await api.search(doc.id, query, searchOptions);
      set({ searchMatches: result.matches, activeMatch: result.matches.length ? 0 : -1 });
      if (result.matches.length) {
        set({ currentPage: result.matches[0].page });
      } else {
        get().notify("info", "No matches found.");
      }
    });
  },

  setSearchOptions: (options) =>
    set((s) => ({ searchOptions: { ...s.searchOptions, ...options } })),

  gotoMatch: (index) => {
    const { searchMatches } = get();
    if (!searchMatches.length) return;
    const wrapped = (index + searchMatches.length) % searchMatches.length;
    set({ activeMatch: wrapped, currentPage: searchMatches[wrapped].page });
  },

  replaceAll: async (replacement) => {
    const { doc, searchQuery, searchOptions } = get();
    if (!doc || !searchQuery) return;
    await get().run("Replacing", async () => {
      const result = await api.replace(doc.id, searchQuery, replacement, searchOptions);
      get().setDocument(result.document);
      get().notify("success", `Replaced ${result.replaced} occurrence(s)`);
      await get().runSearch(searchQuery);
    });
  },

  replaceOne: async (matchId, replacement) => {
    const { doc, searchQuery, searchOptions } = get();
    if (!doc || !searchQuery) return;
    await get().run("Replacing", async () => {
      const result = await api.replace(doc.id, searchQuery, replacement, {
        ...searchOptions,
        matchIds: [matchId],
      });
      get().setDocument(result.document);
      await get().runSearch(searchQuery);
    });
  },

  /* ------------------------------------------------------------ redaction */
  detectSensitive: async (kinds) => {
    const { doc } = get();
    if (!doc) return;
    await get().run("Scanning for sensitive data", async () => {
      const result = await api.detectSensitive(doc.id, kinds);
      set({ redactionFindings: result.findings, stagedRedactions: [] });
      get().notify(
        result.count ? "warn" : "success",
        result.count
          ? `Found ${result.count} item(s) that may need redacting`
          : "No sensitive patterns found.",
      );
    });
  },

  stageRedactions: async (ids) => {
    const { doc, redactionFindings } = get();
    if (!doc) return;
    const chosen = redactionFindings.filter((f) => ids.includes(f.id));
    if (!chosen.length) return;
    await get().run("Marking for redaction", async () => {
      const result = await api.markRedactions(
        doc.id,
        chosen.map((f) => ({ page: f.page, rects: f.rects })),
      );
      get().setDocument(result.document);
      set({ stagedRedactions: ids });
      get().notify("info", `${result.marked} area(s) marked. Apply to remove permanently.`);
    });
  },

  applyRedactions: async () => {
    const { doc, redactionFindings, stagedRedactions } = get();
    if (!doc) return;
    await get().run("Applying redactions", async () => {
      const result = await api.applyRedactions(doc.id);
      get().setDocument(result.document);

      // Prove the content is really gone rather than merely covered.
      const targets = redactionFindings
        .filter((f) => stagedRedactions.includes(f.id))
        .map((f) => f.text);
      if (targets.length) {
        const verdict = await api.verifyRedactions(doc.id, targets).catch(() => null);
        if (verdict && !verdict.clean) {
          get().notify(
            "warn",
            `${verdict.remaining.length} item(s) still appear in the text layer.`,
          );
        } else {
          get().notify("success", `${result.applied} area(s) permanently removed and verified.`);
        }
      } else {
        get().notify("success", `${result.applied} area(s) permanently removed.`);
      }
      set({ redactionFindings: [], stagedRedactions: [] });
    });
  },

  /* ----------------------------------------------------------------- spell */
  runSpellCheck: async () => {
    const { doc } = get();
    if (!doc) return;
    await get().run("Checking spelling", async () => {
      const result = await api.spellCheck(doc.id);
      set({ spellIssues: result.issues });
      get().notify(
        result.count ? "info" : "success",
        result.count ? `${result.count} possible spelling issue(s)` : "No spelling issues found.",
      );
    });
  },

  fixSpelling: async (issue, replacement) => {
    const { doc, layouts } = get();
    if (!doc) return;
    const layout = layouts[issue.page] ?? (await get().loadLayout(issue.page));
    const span = layout?.spans.find((s) => issue.spanIds.includes(s.id));
    if (!span) {
      get().notify("error", "That text run has moved; re-run the check.");
      return;
    }
    const updated = span.text.replace(issue.word, replacement);
    await get().applyEdits([
      { page: issue.page, action: "replace", spanIds: [span.id], text: updated },
    ]);
    set((s) => ({ spellIssues: s.spellIssues.filter((i) => i.id !== issue.id) }));
  },
}));
