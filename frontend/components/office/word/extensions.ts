import { Extension, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { BLOCK_PROPS, CELL_PROPS, displayBlockCss, sanitizeCss, styleFromElement } from "./format";

/**
 * Word's "Title" style. TipTap has no title node, so a title is an h1 carrying
 * this attribute; it arrives from mammoth as ``h1.doc-title`` and leaves as the
 * .docx Title style.
 */
const WordStyles = Extension.create({
  name: "wordStyles",
  addGlobalAttributes() {
    return [
      {
        types: ["heading"],
        attributes: {
          wordStyle: {
            default: null,
            parseHTML: (el) => (el.classList.contains("doc-title") ? "title" : null),
            renderHTML: (attrs) => (attrs.wordStyle === "title" ? { class: "doc-title" } : {}),
          },
        },
      },
    ];
  },
});

/**
 * Direct formatting from Word that TipTap has no attribute for: paragraph
 * spacing, indents, borders and shading, and cell shading, borders, padding
 * and vertical alignment. Each is kept as a whitelisted CSS string in a data
 * attribute (the exact Word values) and drawn through ``style``; paragraphs
 * draw Word's line multiple scaled to CSS (see LINE_HEIGHT_FACTOR).
 */
const DirectFormatting = Extension.create({
  name: "directFormatting",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          blockStyle: {
            default: null,
            parseHTML: (el) =>
              el.hasAttribute("data-block-style")
                ? sanitizeCss(el.getAttribute("data-block-style"), BLOCK_PROPS)
                : styleFromElement(el, BLOCK_PROPS),
            renderHTML: (attrs) =>
              attrs.blockStyle
                ? { "data-block-style": attrs.blockStyle, style: displayBlockCss(attrs.blockStyle) }
                : {},
          },
        },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          cellStyle: {
            default: null,
            parseHTML: (el) =>
              el.hasAttribute("data-cell-style")
                ? sanitizeCss(el.getAttribute("data-cell-style"), CELL_PROPS)
                : styleFromElement(el, CELL_PROPS),
            renderHTML: (attrs) =>
              attrs.cellStyle ? { "data-cell-style": attrs.cellStyle, style: attrs.cellStyle } : {},
          },
        },
      },
      {
        types: ["table"],
        attributes: {
          tableAlign: {
            default: null,
            parseHTML: (el) => {
              const align = el.getAttribute("data-align");
              if (align === "center" || align === "right") return align;
              return el.style.marginLeft === "auto" ? (el.style.marginRight === "auto" ? "center" : "right") : null;
            },
            renderHTML: (attrs) => {
              if (attrs.tableAlign === "center") return { "data-align": "center", style: "margin-left: auto; margin-right: auto" };
              if (attrs.tableAlign === "right") return { "data-align": "right", style: "margin-left: auto" };
              return {};
            },
          },
        },
      },
    ];
  },
});

export function wordExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    // Highlight owns background colour (it maps to Word highlights); line
    // height has no control in the ribbon.
    TextStyleKit.configure({ backgroundColor: false, lineHeight: false }),
    TextAlign.configure({
      types: ["heading", "paragraph"],
      alignments: ["left", "center", "right", "justify"],
    }),
    Highlight.configure({ multicolor: true }),
    TableKit.configure({ table: { resizable: true } }),
    // Inline, because Word anchors pictures inside a paragraph's text; a block
    // image would split every paragraph mammoth hands us around its <img>.
    Image.configure({
      inline: true,
      allowBase64: true,
      resize: {
        enabled: true,
        directions: ["bottom-right", "bottom-left", "top-right", "top-left"],
        minWidth: 24,
        minHeight: 24,
        alwaysPreserveAspectRatio: true,
      },
    }),
    WordStyles,
    DirectFormatting,
  ];
}
