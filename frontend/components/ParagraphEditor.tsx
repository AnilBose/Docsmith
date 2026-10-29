"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { documentFontFamily, loadDocumentFont } from "@/lib/fonts";
import type { Paragraph, TextRun } from "@/lib/types";

interface Props {
  docId: string;
  paragraph: Paragraph;
  background: string;
  scale: number;
  /** Font ids the document embeds; only these have a file to preview with. */
  embeddedFonts: Set<string>;
  /** ``lift`` is how far to move the paragraph up into the space above it. */
  onCommit: (items: TextRun[][], lift: number) => void;
  onCancel: () => void;
}

/**
 * Word-style editor for one whole paragraph.
 *
 * The paragraph opens as editable rich text at its real position, in the
 * document's own fonts, wrapping at the same right edge the PDF used. Enter
 * starts a new paragraph (a new bullet in a list), Shift+Enter a line break,
 * Ctrl+B/I/U style the selection. Backspace at the very start removes a blank
 * line's worth of space above the paragraph, and Enter there puts it back.
 * Clicking away applies the change and the server reflows everything after
 * it, onto new pages if needed; Esc cancels.
 *
 * The editable DOM is built once and then owned by the browser, so React never
 * re-renders over what the user is typing. It is laid out in PDF points and
 * zoomed with a transform, so changing the zoom mid-edit is harmless.
 */
export default function ParagraphEditor({
  docId,
  paragraph,
  background,
  scale,
  embeddedFonts,
  onCommit,
  onCancel,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseline = useRef<string>("");
  const finished = useRef(false);
  const [lift, setLift] = useState(0);

  const [x0, top, x1] = paragraph.box;
  const width = Math.max(x1 - x0, 24);
  // One press removes what one empty paragraph (Enter on a blank line) adds.
  const liftStep = paragraph.lineHeight + paragraph.itemGap;

  /* ------------------------------------------------------- build the DOM */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren(itemElement(paragraph.runs, docId, paragraph.firstIndent));
    baseline.current = JSON.stringify(serialize(root));
    placeCaretAtEnd(root);
  }, [docId, paragraph]);

  /* ------------------------------------------------- real fonts, when ready */
  useEffect(() => {
    const seen = new Set<string>();
    for (const run of paragraph.runs) {
      if (!run.fontId || !run.familyId || seen.has(run.fontId) || !embeddedFonts.has(run.fontId)) continue;
      seen.add(run.fontId);
      void loadDocumentFont(docId, run.fontId, run.familyId, !!run.bold, !!run.italic);
    }
  }, [docId, paragraph, embeddedFonts]);

  /* ---------------------------------------------------------------- finish */
  function commit() {
    if (finished.current || !rootRef.current) return;
    finished.current = true;
    const items = serialize(rootRef.current);
    if (JSON.stringify(items) === baseline.current && lift === 0) {
      onCancel();   // nothing changed: leave the PDF untouched
    } else {
      onCommit(items, lift);
    }
  }

  /** Backspace / Enter with the caret before the first character. */
  function adjustSpaceAbove(event: React.KeyboardEvent): boolean {
    const root = rootRef.current;
    if (!root || !caretAtStart(root)) return false;
    if (event.key === "Backspace") {
      const first = root.firstElementChild;
      if (first && root.children.length > 1 && !first.textContent) {
        return false;   // an empty first line: let the browser delete it
      }
      event.preventDefault();
      setLift((value) => Math.min(value + liftStep, paragraph.spaceAbove));
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && lift > 0) {
      // Give back removed space before adding blank lines.
      event.preventDefault();
      setLift((value) => Math.max(value - liftStep, 0));
      return true;
    }
    return false;
  }

  function cancel() {
    if (finished.current) return;
    finished.current = true;
    onCancel();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    event.stopPropagation();   // keep editor shortcuts (undo, delete...) out of the app
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    } else if ((event.key === "Backspace" || event.key === "Enter") && !event.ctrlKey && !event.metaKey) {
      adjustSpaceAbove(event);
    }
  }

  function onPaste(event: React.ClipboardEvent) {
    // Plain text only: pasted formatting would not exist in the PDF's fonts.
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    text.split("\n").forEach((part, no) => {
      if (no > 0) document.execCommand("insertParagraph");
      if (part) document.execCommand("insertText", false, part);
    });
  }

  const marker = paragraph.marker;
  const markerStyle = marker
    ? ({
        "--marker": JSON.stringify(marker.text),
        "--marker-left": `${marker.bbox[0] - x0}px`,
        "--marker-size": `${paragraph.runs[0]?.size ?? 11}px`,
        "--item-gap": `${paragraph.itemGap}px`,
      } as React.CSSProperties)
    : ({ "--item-gap": `${paragraph.itemGap}px` } as React.CSSProperties);
  // The hint sits outside the zoom so it stays readable at any zoom level.
  const hintSize = 10.5 / scale;

  // While lifted, hide the original lines (and bullet) still painted below.
  const coverLeft = marker ? Math.min(marker.bbox[0] - x0 - 1, 0) : 0;

  return (
    <div
      className="para-editor-frame"
      style={{ left: x0 * scale, top: (top - lift) * scale, transform: `scale(${scale})` }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className="para-editor-hint"
        style={{ fontSize: hintSize, padding: `${2 / scale}px ${6 / scale}px`, marginBottom: 5 / scale }}
      >
        Enter new paragraph · Shift+Enter line break · Backspace at start removes space above · Esc cancel ·
        click outside to apply
      </div>
      {lift > 0 && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            zIndex: -1,
            left: coverLeft,
            top: lift,
            width: width - coverLeft,
            height: paragraph.lineHeight * paragraph.lineCount,
            background,
          }}
        />
      )}
      <div
        ref={rootRef}
        className={`para-editor ${marker ? "has-marker" : ""} ${lift > 0 ? "is-lifted" : ""}`}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        style={{
          ...markerStyle,
          width,
          minHeight: paragraph.lineHeight * paragraph.lineCount,
          lineHeight: `${paragraph.lineHeight}px`,
          textAlign: paragraph.align,
          background,
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Building
   -------------------------------------------------------------------------- */
function itemElement(runs: TextRun[], docId: string, indent: number): HTMLDivElement {
  const item = document.createElement("div");
  if (Math.abs(indent) > 0.05) item.style.textIndent = `${indent}px`;
  for (const run of runs) item.appendChild(runElement(run, docId));
  if (!runs.length) item.appendChild(document.createElement("br"));
  return item;
}

function runElement(run: TextRun, docId: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = run.text;
  span.dataset.font = run.font ?? "";
  span.dataset.size = String(run.size ?? 11);
  span.dataset.color = run.color ?? "#000000";
  if (run.spaceWidth) span.dataset.spaceWidth = String(run.spaceWidth);
  const size = run.size ?? 11;
  const style = span.style;
  style.fontSize = `${size}px`;
  style.color = run.color ?? "#000000";
  style.fontWeight = run.bold ? "700" : "400";
  style.fontStyle = run.italic ? "italic" : "normal";
  style.fontFamily = run.familyId
    ? `"${documentFontFamily(docId, run.familyId)}", Arial, Helvetica, sans-serif`
    : "Arial, Helvetica, sans-serif";
  if (run.spaceWidth) {
    // A fixed gap from the original layout: widen this one space to match.
    style.letterSpacing = `${Math.max(run.spaceWidth - 0.28 * size, 0)}px`;
  }
  return span;
}

/** True when the caret sits before the first character, with nothing selected. */
function caretAtStart(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) {
    return false;
  }
  const first = root.firstChild;
  const range = document.createRange();
  range.setStart(first && first.contains(selection.anchorNode) ? first : root, 0);
  try {
    range.setEnd(selection.anchorNode, selection.anchorOffset);
  } catch {
    return false;
  }
  return range.toString() === "" && !range.cloneContents().querySelector("br");
}

function placeCaretAtEnd(root: HTMLElement) {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/* --------------------------------------------------------------------------
   Reading back
   -------------------------------------------------------------------------- */
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6"]);

/** The editor content as paragraphs of styled runs, ready for the server. */
function serialize(root: HTMLElement): TextRun[][] {
  const items: TextRun[][] = [];
  let current: TextRun[] = [];

  const flush = () => {
    // Browsers keep a placeholder <br> in empty or freshly split blocks.
    const last = current[current.length - 1];
    if (last && last.text.endsWith("\n")) last.text = last.text.slice(0, -1);
    items.push(current.filter((run) => run.text.length > 0));
    current = [];
  };

  const push = (text: string, element: Element) => {
    const run = styleOf(element, text);
    const previous = current[current.length - 1];
    if (previous && !previous.spaceWidth && !run.spaceWidth && sameStyle(previous, run)) {
      previous.text += run.text;
    } else {
      current.push(run);
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ");
      if (text) push(text, node.parentElement ?? root);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      push("\n", node.parentElement ?? root);
      return;
    }
    const block = BLOCK_TAGS.has(node.tagName) && node !== root;
    if (block && current.length) flush();
    node.childNodes.forEach(walk);
    if (block) flush();
  };

  root.childNodes.forEach(walk);
  if (current.length) flush();
  while (items.length > 1 && items[items.length - 1].length === 0) items.pop();
  return items;
}

function styleOf(element: Element, text: string): TextRun {
  const computed = window.getComputedStyle(element);
  const source = element.closest<HTMLElement>("[data-font]");
  const declared = Number(source?.dataset.size ?? NaN);
  const measured = parseFloat(computed.fontSize);
  // Keep the document's exact size unless the user really changed it.
  const size = Number.isFinite(declared) && Math.abs(measured - declared) < 0.05 ? declared : round(measured);
  const color = toHex(computed.color);
  const run: TextRun = {
    text,
    font: source?.dataset.font || undefined,
    size,
    color: source && toHex(source.style.color) === color ? source.dataset.color : color,
    bold: Number(computed.fontWeight) >= 600,
    italic: computed.fontStyle === "italic" || computed.fontStyle === "oblique",
    underline: decorated(element, "underline"),
    strike: decorated(element, "line-through"),
  };
  const gap = source?.dataset.spaceWidth;
  if (gap && text === " " && element === source) run.spaceWidth = Number(gap);
  return run;
}

/** text-decoration is not inherited by getComputedStyle, so walk up for it. */
function decorated(element: Element, line: string): boolean {
  for (let node: Element | null = element; node && !node.classList.contains("para-editor"); node = node.parentElement) {
    if (window.getComputedStyle(node).textDecorationLine.includes(line)) return true;
    if ((line === "underline" && node.tagName === "U") || (line === "line-through" && /^(S|STRIKE|DEL)$/.test(node.tagName))) {
      return true;
    }
  }
  return false;
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.font === b.font &&
    a.size === b.size &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toHex(color: string): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return color;
  return `#${[match[1], match[2], match[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}
