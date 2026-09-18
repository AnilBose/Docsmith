"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import { useEditor } from "@/lib/store";
import type { ToolMode } from "@/lib/types";
import { Icon } from "./Icons";
import { useDialogs } from "./dialogs/DialogHost";

const TABS = [
  { id: "home", label: "Home" },
  { id: "edit", label: "Edit" },
  { id: "insert", label: "Insert" },
  { id: "organize", label: "Organize" },
  { id: "comment", label: "Comment" },
  { id: "convert", label: "Convert" },
  { id: "protect", label: "Protect" },
];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center border-r border-chrome-800 px-2 pb-0.5">
      <div className="flex flex-1 items-center gap-0.5">{children}</div>
      <span className="text-[9px] uppercase tracking-wide text-chrome-500">{title}</span>
    </div>
  );
}

function Cmd({
  icon,
  label,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`ribbon-btn ${active ? "ribbon-btn-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {icon}
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

export default function Ribbon() {
  const ribbonTab = useEditor((s) => s.ribbonTab);
  const setRibbonTab = useEditor((s) => s.setRibbonTab);
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const doc = useEditor((s) => s.doc);
  const currentPage = useEditor((s) => s.currentPage);
  const selectedPages = useEditor((s) => s.selectedPages);
  const setDocument = useEditor((s) => s.setDocument);
  const setSidebarTab = useEditor((s) => s.setSidebarTab);
  const runSpellCheck = useEditor((s) => s.runSpellCheck);
  const applyRedactions = useEditor((s) => s.applyRedactions);
  const loadImages = useEditor((s) => s.loadImages);
  const openFile = useEditor((s) => s.openFile);
  const notify = useEditor((s) => s.notify);
  const run = useEditor((s) => s.run);
  const dialogs = useDialogs();

  const insertRef = useRef<HTMLInputElement>(null);
  const mergeRef = useRef<HTMLInputElement>(null);

  const has = Boolean(doc);
  const targetPages = selectedPages.length ? selectedPages : [currentPage];
  const pick = (id: ToolMode) => () => setTool(tool === id ? "select" : id);

  /* ------------------------------------------------------------- handlers */
  async function rotate(angle: number) {
    if (!doc) return;
    await run("Rotating", async () => {
      const result = await api.rotatePages(doc.id, targetPages, angle);
      setDocument(result.document);
    });
  }

  async function pageOp(label: string, task: () => Promise<{ document: any }>) {
    await run(label, async () => {
      const result = await task();
      setDocument(result.document);
      notify("success", `${label} complete`);
    });
  }

  async function insertFromFile(file: File) {
    if (!doc) return;
    await run("Inserting pages", async () => {
      const source = await api.open(file);
      const result = await api.insertFrom(doc.id, source.id, currentPage + 1);
      setDocument(result.document);
      await api.close(source.id).catch(() => undefined);
      notify("success", `Inserted ${source.pageCount} page(s)`);
    });
  }

  async function mergeWith(files: FileList) {
    if (!doc) return;
    await run("Merging", async () => {
      const ids = [doc.id];
      for (const file of Array.from(files)) {
        const opened = await api.open(file);
        ids.push(opened.id);
      }
      const result = await api.merge(ids, `${doc.filename.replace(/\.pdf$/i, "")}-merged.pdf`);
      setDocument(result.document);
      useEditor.setState((s) => ({ openDocs: [...s.openDocs, result.document] }));
      notify("success", `Merged into ${result.document.pageCount} pages`);
    });
  }

  /* ---------------------------------------------------------------- panes */
  function HomeTab() {
    return (
      <>
        <Group title="File">
          <Cmd
            icon={<Icon.Open size={20} />}
            label="Open"
            onClick={() => document.getElementById("global-open-input")?.click()}
          />
          <Cmd
            icon={<Icon.Download size={20} />}
            label="Download"
            disabled={!has}
            onClick={() => doc && void api.download(doc.id, doc.filename)}
          />
        </Group>
        <Group title="Tools">
          <Cmd
            icon={<Icon.Cursor size={20} />}
            label="Select"
            active={tool === "select"}
            onClick={() => setTool("select")}
          />
          <Cmd
            icon={<Icon.TextEdit size={20} />}
            label="Edit Text"
            active={tool === "editText"}
            disabled={!has}
            onClick={pick("editText")}
          />
          <Cmd
            icon={<Icon.Image size={20} />}
            label="Edit Image"
            active={tool === "editImage"}
            disabled={!has}
            onClick={pick("editImage")}
          />
        </Group>
        <Group title="Find">
          <Cmd
            icon={<Icon.Search size={20} />}
            label="Find"
            disabled={!has}
            onClick={() => setSidebarTab("search")}
          />
          <Cmd
            icon={<Icon.Spell size={20} />}
            label="Spelling"
            disabled={!has}
            onClick={() => {
              setSidebarTab("spell");
              void runSpellCheck();
            }}
          />
        </Group>
        <Group title="Pages">
          <Cmd
            icon={<Icon.Pages size={20} />}
            label="Organize"
            disabled={!has}
            onClick={() => setSidebarTab("thumbnails")}
          />
          <Cmd
            icon={<Icon.Rotate size={20} />}
            label="Rotate"
            disabled={!has}
            onClick={() => void rotate(90)}
          />
        </Group>
        <Group title="Protect">
          <Cmd
            icon={<Icon.Lock size={20} />}
            label="Protect"
            disabled={!has}
            onClick={() => dialogs.open("protect")}
          />
          <Cmd
            icon={<Icon.Redact size={20} />}
            label="Redact"
            disabled={!has}
            active={tool === "redact"}
            onClick={() => {
              setTool("redact");
              setSidebarTab("redact");
            }}
          />
        </Group>
      </>
    );
  }

  function EditTab() {
    return (
      <>
        <Group title="Text">
          <Cmd
            icon={<Icon.TextEdit size={20} />}
            label="Edit Text"
            active={tool === "editText"}
            disabled={!has}
            onClick={pick("editText")}
          />
          <Cmd
            icon={<Icon.TextAdd size={20} />}
            label="Add Text"
            active={tool === "addText"}
            disabled={!has}
            onClick={pick("addText")}
          />
        </Group>
        <Group title="Replace">
          <Cmd
            icon={<Icon.Search size={20} />}
            label="Find & Replace"
            disabled={!has}
            onClick={() => setSidebarTab("search")}
          />
          <Cmd
            icon={<Icon.Spell size={20} />}
            label="Spell Check"
            disabled={!has}
            onClick={() => {
              setSidebarTab("spell");
              void runSpellCheck();
            }}
          />
        </Group>
        <Group title="Images">
          <Cmd
            icon={<Icon.Image size={20} />}
            label="Edit Image"
            active={tool === "editImage"}
            disabled={!has}
            onClick={pick("editImage")}
          />
          <Cmd
            icon={<Icon.Plus size={20} />}
            label="Add Image"
            active={tool === "addImage"}
            disabled={!has}
            onClick={pick("addImage")}
          />
          <Cmd
            icon={<Icon.Eye size={20} />}
            label="All Images"
            disabled={!has}
            onClick={() => {
              setSidebarTab("images");
              void loadImages(currentPage, true);
            }}
          />
          <Cmd
            icon={<Icon.Compress size={20} />}
            label="Compress"
            disabled={!has}
            onClick={() => dialogs.open("compress")}
          />
        </Group>
      </>
    );
  }

  function InsertTab() {
    return (
      <>
        <Group title="Pages">
          <Cmd
            icon={<Icon.Plus size={20} />}
            label="Blank Page"
            disabled={!has}
            onClick={() =>
              doc && void pageOp("Add blank page", () => api.addBlank(doc.id, currentPage + 1))
            }
          />
          <Cmd
            icon={<Icon.Open size={20} />}
            label="From File"
            disabled={!has}
            onClick={() => insertRef.current?.click()}
          />
          <Cmd
            icon={<Icon.Merge size={20} />}
            label="Merge"
            disabled={!has}
            onClick={() => mergeRef.current?.click()}
          />
        </Group>
        <Group title="Content">
          <Cmd
            icon={<Icon.Image size={20} />}
            label="Image"
            disabled={!has}
            active={tool === "addImage"}
            onClick={pick("addImage")}
          />
          <Cmd
            icon={<Icon.TextAdd size={20} />}
            label="Text Box"
            disabled={!has}
            active={tool === "addText"}
            onClick={pick("addText")}
          />
        </Group>
        <Group title="Document">
          <Cmd
            icon={<Icon.Book size={20} />}
            label="Cover Page"
            disabled={!has}
            onClick={() => dialogs.open("cover")}
          />
          <Cmd
            icon={<Icon.Number size={20} />}
            label="Page Numbers"
            disabled={!has}
            onClick={() => dialogs.open("numbering")}
          />
        </Group>
      </>
    );
  }

  function OrganizeTab() {
    return (
      <>
        <Group title="Arrange">
          <Cmd
            icon={<Icon.Pages size={20} />}
            label="Thumbnails"
            disabled={!has}
            onClick={() => setSidebarTab("thumbnails")}
          />
          <Cmd
            icon={<Icon.Copy size={20} />}
            label="Duplicate"
            disabled={!has}
            onClick={() =>
              doc && void pageOp("Duplicate", () => api.duplicatePages(doc.id, targetPages))
            }
          />
          <Cmd
            icon={<Icon.Trash size={20} />}
            label="Delete"
            disabled={!has}
            onClick={() =>
              doc && void pageOp("Delete pages", () => api.deletePages(doc.id, targetPages))
            }
          />
        </Group>
        <Group title="Rotate">
          <Cmd
            icon={<Icon.Rotate size={20} />}
            label="Right 90"
            disabled={!has}
            onClick={() => void rotate(90)}
          />
          <Cmd
            icon={
              <span className="scale-x-[-1]">
                <Icon.Rotate size={20} />
              </span>
            }
            label="Left 90"
            disabled={!has}
            onClick={() => void rotate(-90)}
          />
        </Group>
        <Group title="Split">
          <Cmd
            icon={<Icon.Export size={20} />}
            label="Extract"
            disabled={!has}
            onClick={() =>
              doc && void pageOp("Extract", () => api.extractPages(doc.id, targetPages))
            }
          />
          <Cmd
            icon={<Icon.Split size={20} />}
            label="Split"
            disabled={!has}
            onClick={() => dialogs.open("split")}
          />
          <Cmd
            icon={<Icon.Merge size={20} />}
            label="Merge"
            disabled={!has}
            onClick={() => mergeRef.current?.click()}
          />
        </Group>
      </>
    );
  }

  function CommentTab() {
    return (
      <>
        <Group title="Markup">
          <Cmd
            icon={<Icon.Highlight size={20} />}
            label="Highlight"
            active={tool === "highlight"}
            disabled={!has}
            onClick={pick("highlight")}
          />
          <Cmd
            icon={<Icon.Underline size={20} />}
            label="Underline"
            active={tool === "underline"}
            disabled={!has}
            onClick={pick("underline")}
          />
          <Cmd
            icon={<Icon.Strike size={20} />}
            label="Strikeout"
            active={tool === "strikeout"}
            disabled={!has}
            onClick={pick("strikeout")}
          />
        </Group>
        <Group title="Notes">
          <Cmd
            icon={<Icon.Comment size={20} />}
            label="Sticky Note"
            active={tool === "comment"}
            disabled={!has}
            onClick={pick("comment")}
          />
          <Cmd
            icon={<Icon.Properties size={20} />}
            label="All Comments"
            disabled={!has}
            onClick={() => setSidebarTab("comments")}
          />
        </Group>
      </>
    );
  }

  function ConvertTab() {
    const exportAs = (format: string) =>
      doc && void run(`Exporting ${format}`, () =>
        api.exportAs(doc.id, format, doc.filename.replace(/\.pdf$/i, "")),
      );
    return (
      <>
        <Group title="To PDF">
          <Cmd
            icon={<Icon.Open size={20} />}
            label="From File"
            onClick={() => dialogs.open("import")}
          />
        </Group>
        <Group title="Office">
          <Cmd icon={<Icon.Export size={20} />} label="Word" disabled={!has} onClick={() => exportAs("docx")} />
          <Cmd icon={<Icon.Export size={20} />} label="Excel" disabled={!has} onClick={() => exportAs("xlsx")} />
          <Cmd icon={<Icon.Export size={20} />} label="PowerPoint" disabled={!has} onClick={() => exportAs("pptx")} />
        </Group>
        <Group title="Other">
          <Cmd icon={<Icon.Image size={20} />} label="Images" disabled={!has} onClick={() => exportAs("png")} />
          <Cmd icon={<Icon.Export size={20} />} label="Text" disabled={!has} onClick={() => exportAs("txt")} />
          <Cmd icon={<Icon.Export size={20} />} label="HTML" disabled={!has} onClick={() => exportAs("html")} />
          <Cmd icon={<Icon.Export size={20} />} label="CSV" disabled={!has} onClick={() => exportAs("csv")} />
        </Group>
      </>
    );
  }

  function ProtectTab() {
    return (
      <>
        <Group title="Encrypt">
          <Cmd
            icon={<Icon.Lock size={20} />}
            label="Protect"
            disabled={!has}
            onClick={() => dialogs.open("protect")}
          />
          <Cmd
            icon={<Icon.Unlock size={20} />}
            label="Remove"
            disabled={!has}
            onClick={() => doc && void api.removePassword(doc.id)}
          />
        </Group>
        <Group title="Redact">
          <Cmd
            icon={<Icon.Redact size={20} />}
            label="Mark Area"
            active={tool === "redact"}
            disabled={!has}
            onClick={pick("redact")}
          />
          <Cmd
            icon={<Icon.Search size={20} />}
            label="Find & Redact"
            disabled={!has}
            onClick={() => setSidebarTab("redact")}
          />
          <Cmd
            icon={<Icon.Check size={20} />}
            label="Apply"
            disabled={!has}
            onClick={() => void applyRedactions()}
          />
        </Group>
        <Group title="Clean">
          <Cmd
            icon={<Icon.Trash size={20} />}
            label="Sanitize"
            disabled={!has}
            onClick={() =>
              doc &&
              void run("Sanitizing", async () => {
                await api.sanitize(doc.id);
                notify("success", "Metadata, embedded files and scripts removed.");
              })
            }
          />
        </Group>
      </>
    );
  }

  const panes: Record<string, () => JSX.Element> = {
    home: HomeTab,
    edit: EditTab,
    insert: InsertTab,
    organize: OrganizeTab,
    comment: CommentTab,
    convert: ConvertTab,
    protect: ProtectTab,
  };
  const Pane = panes[ribbonTab] ?? HomeTab;

  return (
    <div className="shrink-0 border-b border-chrome-800 bg-chrome-900">
      <div className="flex items-center gap-0.5 border-b border-chrome-850 px-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-ribbon-tab={tab.id}
            onClick={() => setRibbonTab(tab.id)}
            className={`relative h-8 px-3 text-sm transition-colors ${
              ribbonTab === tab.id
                ? "text-white after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent"
                : "text-chrome-400 hover:text-chrome-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex h-[76px] items-stretch overflow-x-auto px-2 py-1">
        <Pane />
      </div>

      <input
        ref={insertRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertFromFile(file);
          event.target.value = "";
        }}
      />
      <input
        ref={mergeRef}
        type="file"
        accept="application/pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) void mergeWith(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
