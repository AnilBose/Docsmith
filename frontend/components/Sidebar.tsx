"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useEditor, type SidebarTab } from "@/lib/store";
import type { Annotation } from "@/lib/types";
import { Icon } from "./Icons";

const TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: "thumbnails", label: "Pages", icon: <Icon.Pages size={17} /> },
  { id: "search", label: "Find", icon: <Icon.Search size={17} /> },
  { id: "comments", label: "Comments", icon: <Icon.Comment size={17} /> },
  { id: "images", label: "Images", icon: <Icon.Image size={17} /> },
  { id: "spell", label: "Spelling", icon: <Icon.Spell size={17} /> },
  { id: "redact", label: "Redact", icon: <Icon.Redact size={17} /> },
];

export default function Sidebar() {
  const open = useEditor((s) => s.sidebarOpen);
  const tab = useEditor((s) => s.sidebarTab);
  const setTab = useEditor((s) => s.setSidebarTab);

  if (!open) return null;

  return (
    <aside className="flex w-[292px] shrink-0 flex-col border-r border-chrome-800 bg-chrome-900">
      <div className="flex shrink-0 border-b border-chrome-800">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.label}
            onClick={() => setTab(item.id)}
            className={`flex h-9 flex-1 items-center justify-center transition-colors ${
              tab === item.id
                ? "bg-chrome-850 text-white shadow-[inset_0_-2px_0_theme(colors.accent.DEFAULT)]"
                : "text-chrome-400 hover:bg-chrome-850 hover:text-chrome-200"
            }`}
          >
            {item.icon}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "thumbnails" && <Thumbnails />}
        {tab === "search" && <SearchPanel />}
        {tab === "comments" && <CommentsPanel />}
        {tab === "images" && <ImagesPanel />}
        {tab === "spell" && <SpellPanel />}
        {tab === "redact" && <RedactPanel />}
      </div>
    </aside>
  );
}

/* ========================================================================== */
function Thumbnails() {
  const doc = useEditor((s) => s.doc);
  const currentPage = useEditor((s) => s.currentPage);
  const setPage = useEditor((s) => s.setPage);
  const selectedPages = useEditor((s) => s.selectedPages);
  const setSelectedPages = useEditor((s) => s.setSelectedPages);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  if (!doc) return <Empty text="Open a PDF to see its pages." />;

  async function drop(to: number) {
    const from = dragFrom;
    setDragFrom(null);
    setDropAt(null);
    if (from === null || from === to || !doc) return;
    await run("Reordering", async () => {
      const result = await api.movePage(doc.id, from, to);
      setDocument(result.document);
    });
  }

  function toggle(index: number, event: React.MouseEvent) {
    if (event.ctrlKey || event.metaKey) {
      setSelectedPages(
        selectedPages.includes(index)
          ? selectedPages.filter((p) => p !== index)
          : [...selectedPages, index],
      );
    } else if (event.shiftKey && selectedPages.length) {
      const anchor = selectedPages[selectedPages.length - 1];
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      const span = [];
      for (let i = lo; i <= hi; i += 1) span.push(i);
      setSelectedPages(span);
    } else {
      setSelectedPages([index]);
      setPage(index);
    }
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-2xs uppercase tracking-wider text-chrome-400">
          {doc.pageCount} pages
        </span>
        {selectedPages.length > 0 && (
          <button
            type="button"
            className="text-2xs text-accent hover:underline"
            onClick={() => setSelectedPages([])}
          >
            Clear ({selectedPages.length})
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {doc.pages.map((page) => {
          const isSelected = selectedPages.includes(page.index);
          const isCurrent = currentPage === page.index;
          return (
            <button
              key={page.index}
              type="button"
              draggable
              onDragStart={() => setDragFrom(page.index)}
              onDragOver={(event) => {
                event.preventDefault();
                setDropAt(page.index);
              }}
              onDrop={() => void drop(page.index)}
              onDragEnd={() => {
                setDragFrom(null);
                setDropAt(null);
              }}
              onClick={(event) => toggle(page.index, event)}
              className={`group relative rounded border p-1 transition-colors ${
                isSelected
                  ? "border-accent bg-accent-soft"
                  : isCurrent
                    ? "border-chrome-500 bg-chrome-850"
                    : "border-chrome-800 hover:border-chrome-600 hover:bg-chrome-850"
              } ${dropAt === page.index && dragFrom !== null ? "ring-2 ring-accent" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={api.pageThumbUrl(doc.id, page.index, doc.version, 160)}
                alt={`Page ${page.number}`}
                className="w-full rounded-sm bg-white"
                loading="lazy"
                draggable={false}
              />
              <span className="mt-1 block text-center text-2xs text-chrome-400">
                {page.number}
                {page.rotation ? ` · ${page.rotation}°` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */
function SearchPanel() {
  const doc = useEditor((s) => s.doc);
  const query = useEditor((s) => s.searchQuery);
  const matches = useEditor((s) => s.searchMatches);
  const activeMatch = useEditor((s) => s.activeMatch);
  const options = useEditor((s) => s.searchOptions);
  const setOptions = useEditor((s) => s.setSearchOptions);
  const runSearch = useEditor((s) => s.runSearch);
  const gotoMatch = useEditor((s) => s.gotoMatch);
  const replaceAll = useEditor((s) => s.replaceAll);
  const replaceOne = useEditor((s) => s.replaceOne);

  const [term, setTerm] = useState(query);
  const [replacement, setReplacement] = useState("");

  if (!doc) return <Empty text="Open a PDF to search it." />;

  return (
    <div className="space-y-3 p-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(term);
        }}
      >
        <input
          className="field w-full"
          placeholder="Find in document"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          autoFocus
        />
        <input
          className="field w-full"
          placeholder="Replace with"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-chrome-300">
          <Toggle
            label="Match case"
            checked={options.caseSensitive}
            onChange={(v) => setOptions({ caseSensitive: v })}
          />
          <Toggle
            label="Whole word"
            checked={options.wholeWord}
            onChange={(v) => setOptions({ wholeWord: v })}
          />
          <Toggle
            label="Regex"
            checked={options.regex}
            onChange={(v) => setOptions({ regex: v })}
          />
        </div>
        <div className="flex gap-1.5">
          <button type="submit" className="btn-primary flex-1">
            Find
          </button>
          <button
            type="button"
            className="btn-ghost flex-1"
            disabled={!matches.length || !query}
            onClick={() => void replaceAll(replacement)}
          >
            Replace all
          </button>
        </div>
      </form>

      {matches.length > 0 && (
        <div className="flex items-center justify-between border-t border-chrome-800 pt-2 text-2xs text-chrome-400">
          <span>
            {activeMatch + 1} of {matches.length}
          </span>
          <div className="flex gap-1">
            <button type="button" className="tool-btn" onClick={() => gotoMatch(activeMatch - 1)}>
              <span className="rotate-180">
                <Icon.Chevron size={14} />
              </span>
            </button>
            <button type="button" className="tool-btn" onClick={() => gotoMatch(activeMatch + 1)}>
              <Icon.Chevron size={14} />
            </button>
          </div>
        </div>
      )}

      <ul className="space-y-1">
        {matches.map((match, index) => (
          <li key={match.id}>
            <button
              type="button"
              onClick={() => gotoMatch(index)}
              className={`w-full rounded border px-2 py-1.5 text-left text-2xs transition-colors ${
                index === activeMatch
                  ? "border-accent bg-accent-soft"
                  : "border-transparent hover:bg-chrome-850"
              }`}
            >
              <div className="mb-0.5 flex items-center justify-between">
                <span className="text-chrome-500">Page {match.page + 1}</span>
                {replacement && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-accent hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      void replaceOne(match.id, replacement);
                    }}
                    onKeyDown={() => undefined}
                  >
                    replace
                  </span>
                )}
              </div>
              <span className="line-clamp-2 text-chrome-300">{match.context}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ========================================================================== */
function CommentsPanel() {
  const doc = useEditor((s) => s.doc);
  const annotations = useEditor((s) => s.annotations);
  const loadAnnotations = useEditor((s) => s.loadAnnotations);
  const setPage = useEditor((s) => s.setPage);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);

  useEffect(() => {
    if (doc) void loadAnnotations();
  }, [doc?.id, doc?.version, loadAnnotations, doc]);

  if (!doc) return <Empty text="Open a PDF to see its comments." />;
  if (!annotations.length)
    return <Empty text="No comments yet. Use the Comment tab to add markup." />;

  async function remove(annotation: Annotation) {
    if (!doc) return;
    await run("Deleting comment", async () => {
      const result = await api.deleteAnnotation(doc.id, annotation.page, annotation.xref);
      setDocument(result.document);
      await loadAnnotations();
    });
  }

  return (
    <ul className="divide-y divide-chrome-850">
      {annotations.map((annotation) => (
        <li key={annotation.id} className="group p-3 hover:bg-chrome-850">
          <div className="mb-1 flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: annotation.color }}
            />
            <button
              type="button"
              className="text-2xs text-chrome-300 hover:text-white"
              onClick={() => setPage(annotation.page)}
            >
              {annotation.type} · page {annotation.page + 1}
            </button>
            <button
              type="button"
              className="ml-auto text-chrome-500 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              onClick={() => void remove(annotation)}
              title="Delete"
            >
              <Icon.Trash size={14} />
            </button>
          </div>
          {annotation.contents && (
            <p className="text-2xs leading-relaxed text-chrome-200">{annotation.contents}</p>
          )}
          {annotation.author && (
            <p className="mt-1 text-[10px] text-chrome-500">{annotation.author}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ========================================================================== */
function ImagesPanel() {
  const doc = useEditor((s) => s.doc);
  const currentPage = useEditor((s) => s.currentPage);
  const images = useEditor((s) => s.images[currentPage]);
  const loadImages = useEditor((s) => s.loadImages);
  const selectImage = useEditor((s) => s.selectImage);
  const selected = useEditor((s) => s.selectedImage);

  useEffect(() => {
    if (doc) void loadImages(currentPage, true);
  }, [doc?.id, doc?.version, currentPage, loadImages, doc]);

  if (!doc) return <Empty text="Open a PDF to list its images." />;
  if (!images?.length) return <Empty text={`No images on page ${currentPage + 1}.`} />;

  return (
    <div className="space-y-2 p-3">
      <div className="text-2xs uppercase tracking-wider text-chrome-400">
        Page {currentPage + 1} · {images.length} image{images.length === 1 ? "" : "s"}
      </div>
      {images.map((image) => (
        <button
          key={image.id}
          type="button"
          onClick={() => selectImage(image)}
          className={`flex w-full gap-2 rounded border p-2 text-left transition-colors ${
            selected?.id === image.id
              ? "border-accent bg-accent-soft"
              : "border-chrome-800 hover:bg-chrome-850"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={api.imageThumbUrl(doc.id, image.page, image.xref, doc.version)}
            alt=""
            className="h-12 w-12 shrink-0 rounded-sm bg-chrome-800 object-contain"
            loading="lazy"
          />
          <div className="min-w-0 text-2xs">
            <div className="text-chrome-200">
              {image.width} × {image.height} px
            </div>
            <div className="text-chrome-500">
              {image.colorspace} · {image.dpiX} dpi
            </div>
            <div className="text-chrome-500">{image.hasAlpha ? "transparent" : "opaque"}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

/* ========================================================================== */
function SpellPanel() {
  const doc = useEditor((s) => s.doc);
  const issues = useEditor((s) => s.spellIssues);
  const runSpellCheck = useEditor((s) => s.runSpellCheck);
  const fixSpelling = useEditor((s) => s.fixSpelling);
  const setPage = useEditor((s) => s.setPage);

  if (!doc) return <Empty text="Open a PDF to check its spelling." />;

  return (
    <div className="space-y-2 p-3">
      <button type="button" className="btn-ghost w-full" onClick={() => void runSpellCheck()}>
        Re-check document
      </button>
      {!issues.length ? (
        <Empty text="No spelling issues found." />
      ) : (
        issues.map((issue) => (
          <div key={issue.id} className="rounded border border-chrome-800 p-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="text-sm font-medium text-danger hover:underline"
                onClick={() => setPage(issue.page)}
              >
                {issue.word}
              </button>
              <span className="text-[10px] text-chrome-500">p{issue.page + 1}</span>
            </div>
            <p className="mb-1.5 mt-0.5 line-clamp-2 text-[10px] text-chrome-500">
              {issue.context}
            </p>
            <div className="flex flex-wrap gap-1">
              {issue.suggestions.length ? (
                issue.suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="chip hover:bg-accent hover:text-white"
                    onClick={() => void fixSpelling(issue, suggestion)}
                  >
                    {suggestion}
                  </button>
                ))
              ) : (
                <span className="text-[10px] text-chrome-500">No suggestions</span>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ========================================================================== */
function RedactPanel() {
  const doc = useEditor((s) => s.doc);
  const findings = useEditor((s) => s.redactionFindings);
  const staged = useEditor((s) => s.stagedRedactions);
  const detect = useEditor((s) => s.detectSensitive);
  const stage = useEditor((s) => s.stageRedactions);
  const apply = useEditor((s) => s.applyRedactions);
  const setPage = useEditor((s) => s.setPage);
  const setDocument = useEditor((s) => s.setDocument);
  const run = useEditor((s) => s.run);

  const [patterns, setPatterns] = useState<{ id: string; label: string }[]>([]);
  const [chosen, setChosen] = useState<string[]>(["email", "phone", "ssn"]);
  const [phrase, setPhrase] = useState("");

  useEffect(() => {
    api.redactionPatterns().then(setPatterns).catch(() => undefined);
  }, []);

  if (!doc) return <Empty text="Open a PDF to redact it." />;

  async function findPhrase() {
    if (!doc || !phrase.trim()) return;
    await run("Searching", async () => {
      const result = await api.findForRedaction(doc.id, phrase);
      useEditor.setState({ redactionFindings: result.findings, stagedRedactions: [] });
    });
  }

  async function clearMarks() {
    if (!doc) return;
    await run("Clearing marks", async () => {
      const result = await api.clearRedactions(doc.id);
      setDocument(result.document);
      useEditor.setState({ stagedRedactions: [] });
    });
  }

  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="panel-title px-0">Detect sensitive data</div>
        <div className="space-y-1">
          {patterns.map((pattern) => (
            <Toggle
              key={pattern.id}
              label={pattern.label}
              checked={chosen.includes(pattern.id)}
              onChange={(value) =>
                setChosen(
                  value ? [...chosen, pattern.id] : chosen.filter((id) => id !== pattern.id),
                )
              }
            />
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost mt-2 w-full"
          onClick={() => void detect(chosen)}
        >
          Scan document
        </button>
      </div>

      <div className="border-t border-chrome-800 pt-3">
        <div className="panel-title px-0">Search &amp; redact</div>
        <div className="flex gap-1.5">
          <input
            className="field min-w-0 flex-1"
            placeholder="Phrase to remove"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void findPhrase()}
          />
          <button type="button" className="btn-ghost" onClick={() => void findPhrase()}>
            Find
          </button>
        </div>
      </div>

      {findings.length > 0 && (
        <div className="border-t border-chrome-800 pt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs uppercase tracking-wider text-chrome-400">
              {findings.length} found
            </span>
            <button
              type="button"
              className="text-2xs text-accent hover:underline"
              onClick={() => void stage(findings.map((f) => f.id))}
            >
              Mark all
            </button>
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {findings.map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPage(finding.page);
                    void stage(Array.from(new Set([...staged, finding.id])));
                  }}
                  className={`w-full rounded border px-2 py-1 text-left text-2xs transition-colors ${
                    staged.includes(finding.id)
                      ? "border-danger bg-danger/15"
                      : "border-chrome-800 hover:bg-chrome-850"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate font-mono text-chrome-100">{finding.text}</span>
                    <span className="ml-2 shrink-0 text-chrome-500">p{finding.page + 1}</span>
                  </div>
                  <span className="text-[10px] text-chrome-500">{finding.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1.5 border-t border-chrome-800 pt-3">
        <button type="button" className="btn-danger w-full" onClick={() => void apply()}>
          Apply redactions permanently
        </button>
        <button type="button" className="btn-ghost w-full" onClick={() => void clearMarks()}>
          Clear marks
        </button>
        <p className="text-[10px] leading-relaxed text-chrome-500">
          Applying rewrites the page content streams. The removed text and image data are deleted
          from the file, not covered over, and the result is verified afterwards.
        </p>
      </div>
    </div>
  );
}

/* ========================================================================== */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-chrome-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-accent"
      />
      {label}
    </label>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-center text-2xs leading-relaxed text-chrome-500">{text}</p>;
}
