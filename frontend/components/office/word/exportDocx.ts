import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
  type IBorderOptions,
  type ILevelsOptions,
  type IParagraphOptions,
  type IRunOptions,
  type NumberingDefinition,
  type ParagraphChild,
} from "docx";
import type { JSONContent } from "@tiptap/core";
import {
  A4_PAGE,
  contentWidthPx,
  cssToPt,
  highlightName,
  parseBorder,
  parseDecls,
  primaryFont,
  toHex,
  toPoints,
  type PageSetup,
} from "./format";

type Mutable<T> = { -readonly [K in keyof T]?: T[K] };
type RunOpts = Mutable<IRunOptions>;
type ImageType = "png" | "jpg" | "gif" | "bmp";
type Block = Paragraph | Table;

export interface ResolvedImage {
  type: ImageType;
  data: Uint8Array;
  width: number;
  height: number;
}

/** Turns an image .docx cannot hold (webp, svg, remote) into PNG; browser only. */
export type Rasterize = (src: string) => Promise<ResolvedImage | null>;

export interface ExportResult {
  document: Document;
  /** Images that could not be embedded and were left out. */
  skippedImages: number;
}

const PX_TO_TW = 15;
const tw = (points: number) => Math.round(points * 20);
const LIST_INDENT_TW = 720;

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const BULLETS = ["•", "◦", "▪"];
const ORDERED = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];

function listLevels(ordered: boolean, start = 1): ILevelsOptions[] {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: ordered ? ORDERED[level % 3] : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : BULLETS[level % 3],
    alignment: AlignmentType.LEFT,
    start: level === 0 ? start : 1,
    style: {
      paragraph: { indent: { left: LIST_INDENT_TW * (level + 1), hanging: 360 } },
    },
  }));
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "8C8C8C" };
const GREY_FILL = { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" };

const BORDER_STYLES: Record<string, IBorderOptions["style"]> = {
  solid: BorderStyle.SINGLE,
  double: BorderStyle.DOUBLE,
  dashed: BorderStyle.DASHED,
  dotted: BorderStyle.DOTTED,
  groove: BorderStyle.THREE_D_ENGRAVE,
  ridge: BorderStyle.THREE_D_EMBOSS,
  inset: BorderStyle.INSET,
  outset: BorderStyle.OUTSET,
};

/** CSS border -> .docx border; widths are in eighths of a point there. */
function border(value: string | undefined, spacePt?: number | null): IBorderOptions | undefined {
  const b = parseBorder(value);
  if (!b) return undefined;
  if (b.style === "none" || b.style === "hidden" || b.widthPt <= 0) return { style: BorderStyle.NONE, size: 0, color: "auto" };
  return {
    style: BORDER_STYLES[b.style] ?? BorderStyle.SINGLE,
    size: Math.max(2, Math.round(b.widthPt * 8)),
    color: b.color ?? "auto",
    ...(spacePt != null ? { space: Math.round(spacePt) } : {}),
  };
}

function shading(color: string | undefined) {
  const hex = toHex(color);
  return hex ? { type: ShadingType.CLEAR, fill: hex, color: "auto" } : undefined;
}

/** A paragraph's blockStyle (see extensions.ts) as direct paragraph formatting. */
function blockOptions(css: unknown): Mutable<IParagraphOptions> {
  const d = parseDecls(typeof css === "string" ? css : "");
  const o: Mutable<IParagraphOptions> = {};
  if (!d.size) return o;
  const len = (prop: string) => cssToPt(d.get(prop));

  const spacing: { before?: number; after?: number; line?: number; lineRule?: (typeof LineRuleType)[keyof typeof LineRuleType] } = {};
  const before = len("margin-top");
  const after = len("margin-bottom");
  if (before !== null) spacing.before = tw(before);
  if (after !== null) spacing.after = tw(after);
  const lh = d.get("line-height");
  if (lh && /^[\d.]+$/.test(lh)) {
    spacing.line = Math.round(parseFloat(lh) * 240);
    spacing.lineRule = LineRuleType.AUTO;
  } else if (lh && cssToPt(lh)) {
    spacing.line = tw(cssToPt(lh)!);
    spacing.lineRule = LineRuleType.EXACT;
  }
  if (Object.keys(spacing).length) o.spacing = spacing;

  const left = len("margin-left");
  const right = len("margin-right");
  const first = len("text-indent");
  if (left || right || first) {
    o.indent = {
      ...(left ? { left: tw(left) } : {}),
      ...(right ? { right: tw(right) } : {}),
      ...(first && first > 0 ? { firstLine: tw(first) } : {}),
      ...(first && first < 0 ? { hanging: tw(-first) } : {}),
    };
  }

  const borders = {
    top: border(d.get("border-top"), len("padding-top")),
    bottom: border(d.get("border-bottom"), len("padding-bottom")),
    left: border(d.get("border-left"), len("padding-left")),
    right: border(d.get("border-right"), len("padding-right")),
  };
  if (borders.top || borders.bottom || borders.left || borders.right) {
    o.border = Object.fromEntries(Object.entries(borders).filter(([, v]) => v)) as IParagraphOptions["border"];
  }
  const fill = shading(d.get("background-color"));
  if (fill) o.shading = fill;
  return o;
}

// --------------------------------------------------------------------------- //
// Images
// --------------------------------------------------------------------------- //

function decodeDataUri(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  const payload = m[3];
  if (!m[2]) return { mime: m[1], bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  const bin = atob(payload.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

const MIME_TYPES: Record<string, ImageType> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

/** Pixel size from the file header, so unsized images keep their proportions. */
export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
  if (type === "png" && b.length > 24) return { width: be32(16), height: be32(20) };
  if (type === "gif" && b.length > 10) return { width: le16(6), height: le16(8) };
  if (type === "bmp" && b.length > 26) return { width: Math.abs(le32(18)), height: Math.abs(le32(22)) };
  if (type === "jpg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

function collectImageSources(node: JSONContent, into: Set<string>): Set<string> {
  if (node.type === "image" && typeof node.attrs?.src === "string") into.add(node.attrs.src);
  node.content?.forEach((child) => collectImageSources(child, into));
  return into;
}

async function resolveImage(src: string, rasterize?: Rasterize): Promise<ResolvedImage | null> {
  const decoded = decodeDataUri(src);
  const type = decoded ? MIME_TYPES[decoded.mime] : undefined;
  if (decoded && type) {
    const size = imageSize(decoded.bytes, type);
    if (size && size.width > 0 && size.height > 0) return { type, data: decoded.bytes, ...size };
  }
  return rasterize ? rasterize(src).catch(() => null) : null;
}

// --------------------------------------------------------------------------- //
// Document walk
// --------------------------------------------------------------------------- //

interface Ctx {
  /** Nesting level of the innermost list (-1 outside lists). */
  depth: number;
  /** Instance of the nearest ordered list, so nested levels number under it. */
  orderedInstance: number | null;
  /** Left indent for paragraphs that continue a list item without a number. */
  indent: number;
  quote: boolean;
  cell: boolean;
  header: boolean;
}

const ROOT: Ctx = { depth: -1, orderedInstance: null, indent: 0, quote: false, cell: false, header: false };

class Walker {
  skippedImages = 0;
  private instances = 0;

  private contentTw: number;
  private contentPx: number;

  constructor(
    private images: Map<string, ResolvedImage | null>,
    page: PageSetup,
  ) {
    this.contentTw = tw(page.widthPt - page.marginLeftPt - page.marginRightPt);
    this.contentPx = contentWidthPx(page);
  }

  blocks(nodes: JSONContent[] | undefined, ctx: Ctx): Block[] {
    return (nodes ?? []).flatMap((node) => this.block(node, ctx));
  }

  private block(node: JSONContent, ctx: Ctx): Block[] {
    switch (node.type) {
      case "paragraph":
        return [this.paragraph(node, ctx)];
      case "heading": {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        const heading = node.attrs?.wordStyle === "title" ? HeadingLevel.TITLE : HEADINGS[level - 1];
        return [this.paragraph(node, ctx, { heading })];
      }
      case "bulletList":
      case "orderedList":
        return this.list(node, ctx);
      case "blockquote":
        return this.blocks(node.content, { ...ctx, quote: true });
      case "codeBlock":
        return this.codeBlock(node, ctx);
      case "horizontalRule":
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "A6A6A6", space: 1 } },
          }),
        ];
      case "table":
        return [this.table(node, ctx)];
      case "image":
        return [this.paragraph({ type: "paragraph", content: [node] }, ctx)];
      default:
        return this.blocks(node.content, ctx);
    }
  }

  private paragraph(node: JSONContent, ctx: Ctx, extra: Mutable<IParagraphOptions> = {}): Paragraph {
    const opts: Mutable<IParagraphOptions> = { ...extra };
    const direct = blockOptions(node.attrs?.blockStyle);
    const align = ALIGN[String(node.attrs?.textAlign ?? "")];
    if (align) opts.alignment = align;
    if (ctx.indent && !opts.numbering) opts.indent = { left: ctx.indent };
    if (ctx.quote) {
      opts.indent = { left: (ctx.indent || 0) + LIST_INDENT_TW };
      opts.border = { left: { style: BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 } };
    }
    if (ctx.cell) opts.spacing = { after: 0, line: 240 };
    if (direct.spacing) opts.spacing = { ...opts.spacing, ...direct.spacing };
    // A numbered paragraph keeps its list level's indent.
    if (direct.indent && !opts.numbering) opts.indent = { ...opts.indent, ...direct.indent };
    if (direct.border) opts.border = direct.border;
    if (direct.shading) opts.shading = direct.shading;
    const base: RunOpts = ctx.header ? { bold: true } : {};
    opts.children = this.inlines(node.content ?? [], base);
    return new Paragraph(opts as IParagraphOptions);
  }

  private list(node: JSONContent, ctx: Ctx): Block[] {
    const ordered = node.type === "orderedList";
    const level = Math.min(ctx.depth + 1, 8);
    let reference: string | NumberingDefinition = ordered ? "numbers" : "bullets";
    let instance: number | undefined;
    if (ordered) {
      if (ctx.orderedInstance !== null && level > 0) {
        instance = ctx.orderedInstance;
      } else {
        this.instances += 1;
        instance = this.instances;
        const start = Number(node.attrs?.start ?? 1);
        if (start > 1) reference = { reference: `numbers-from-${start}`, levels: listLevels(true, start) };
      }
    }
    const inner: Ctx = {
      ...ctx,
      depth: level,
      orderedInstance: ordered ? (instance ?? null) : ctx.orderedInstance,
    };
    const out: Block[] = [];
    for (const item of node.content ?? []) {
      (item.content ?? []).forEach((child, i) => {
        if (i === 0 && child.type === "paragraph") {
          out.push(this.paragraph(child, { ...inner, indent: 0 }, { numbering: { reference, level, instance } }));
        } else if (child.type === "bulletList" || child.type === "orderedList") {
          out.push(...this.list(child, inner));
        } else {
          out.push(...this.block(child, { ...inner, indent: LIST_INDENT_TW * (level + 1) }));
        }
      });
    }
    return out;
  }

  private codeBlock(node: JSONContent, ctx: Ctx): Block[] {
    const text = (node.content ?? []).map((n) => n.text ?? "").join("");
    const lines = text.split("\n");
    return lines.map(
      (line, i) =>
        new Paragraph({
          shading: GREY_FILL,
          spacing: { after: i === lines.length - 1 ? 160 : 0, line: 240 },
          indent: ctx.indent ? { left: ctx.indent } : undefined,
          children: [new TextRun({ text: line, font: "Courier New", size: 20 })],
        }),
    );
  }

  private table(node: JSONContent, ctx: Ctx): Table {
    const rows = node.content ?? [];
    const first = rows[0]?.content ?? [];
    const pxWidths: (number | null)[] = [];
    for (const cell of first) {
      const span = Number(cell.attrs?.colspan ?? 1);
      const widths: unknown = cell.attrs?.colwidth;
      for (let i = 0; i < span; i += 1) {
        const w = Array.isArray(widths) ? Number(widths[i]) : NaN;
        pxWidths.push(Number.isFinite(w) && w > 0 ? w : null);
      }
    }
    const cols = Math.max(pxWidths.length, 1);
    let columnWidths: number[];
    if (pxWidths.length && pxWidths.every((w): w is number => w !== null)) {
      const twips = pxWidths.map((w) => w * PX_TO_TW);
      const scale = Math.min(1, this.contentTw / twips.reduce((a, b) => a + b, 0));
      columnWidths = twips.map((w) => Math.round(w * scale));
    } else {
      columnWidths = Array.from({ length: cols }, () => Math.floor(this.contentTw / cols));
    }

    const cellCtx: Ctx = { ...ROOT, cell: true };
    return new Table({
      width: { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths,
      borders: {
        top: CELL_BORDER,
        bottom: CELL_BORDER,
        left: CELL_BORDER,
        right: CELL_BORDER,
        insideHorizontal: CELL_BORDER,
        insideVertical: CELL_BORDER,
      },
      indent: ctx.indent ? { size: ctx.indent, type: WidthType.DXA } : undefined,
      alignment:
        node.attrs?.tableAlign === "center"
          ? AlignmentType.CENTER
          : node.attrs?.tableAlign === "right"
            ? AlignmentType.RIGHT
            : undefined,
      rows: rows.map((row) => {
        const cells = row.content ?? [];
        const isHeader = cells.length > 0 && cells.every((c) => c.type === "tableHeader");
        return new TableRow({
          tableHeader: isHeader || undefined,
          children: cells.map((cell) => {
            const header = cell.type === "tableHeader";
            const children = this.blocks(cell.content, { ...cellCtx, header });
            return new TableCell({
              columnSpan: Number(cell.attrs?.colspan ?? 1),
              rowSpan: Number(cell.attrs?.rowspan ?? 1),
              ...cellOptions(cell.attrs?.cellStyle, header),
              children: children.length ? children : [new Paragraph({ spacing: { after: 0 } })],
            });
          }),
        });
      }),
    });
  }

  private inlines(nodes: JSONContent[], base: RunOpts): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    // Consecutive runs with the same href become one hyperlink.
    const link: { href: string | null; runs: ParagraphChild[] } = { href: null, runs: [] };
    const flush = () => {
      if (link.href && link.runs.length) out.push(new ExternalHyperlink({ link: link.href, children: link.runs }));
      link.href = null;
      link.runs = [];
    };

    for (const node of nodes) {
      const href = node.marks?.find((m) => m.type === "link")?.attrs?.href as string | undefined;
      let child: ParagraphChild | null = null;
      if (node.type === "text") {
        const parts = (node.text ?? "").split("	");
        child = new TextRun({
          ...base,
          ...runOptions(node.marks),
          children: parts.flatMap((part, i) => (i ? [new Tab(), part] : [part])).filter((c) => c !== ""),
        });
      } else if (node.type === "hardBreak") {
        child = new TextRun({ ...base, break: 1 });
      } else if (node.type === "image") {
        child = this.image(node);
      }
      if (!child) continue;
      if (href) {
        if (link.href !== href) {
          flush();
          link.href = href;
        }
        link.runs.push(child);
      } else {
        flush();
        out.push(child);
      }
    }
    flush();
    return out;
  }

  private image(node: JSONContent): ImageRun | null {
    const attrs = node.attrs ?? {};
    const img = typeof attrs.src === "string" ? this.images.get(attrs.src) : null;
    if (!img) {
      this.skippedImages += 1;
      return null;
    }
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    let w = num(attrs.width);
    let h = num(attrs.height);
    if (w && !h) h = (w * img.height) / img.width;
    if (h && !w) w = (h * img.width) / img.height;
    if (!w || !h) {
      w = img.width;
      h = img.height;
    }
    if (w > this.contentPx) {
      h = (h * this.contentPx) / w;
      w = this.contentPx;
    }
    const alt = typeof attrs.alt === "string" && attrs.alt ? attrs.alt : undefined;
    return new ImageRun({
      type: img.type,
      data: img.data,
      transformation: { width: Math.round(w), height: Math.round(h) },
      altText: alt ? { name: alt, description: alt, title: alt } : undefined,
    });
  }
}

/** A cell's cellStyle (see extensions.ts) as direct cell formatting. */
function cellOptions(css: unknown, header: boolean) {
  const d = parseDecls(typeof css === "string" ? css : "");
  if (!d.size) return { shading: header ? GREY_FILL : undefined, margins: { left: 108, right: 108 } };
  const pad = (side: string, fallback: number) => {
    const v = cssToPt(d.get(`padding-${side}`));
    return v === null ? fallback : tw(v);
  };
  const va = d.get("vertical-align");
  const borders = {
    top: border(d.get("border-top")),
    bottom: border(d.get("border-bottom")),
    left: border(d.get("border-left")),
    right: border(d.get("border-right")),
  };
  return {
    shading: shading(d.get("background-color")) ?? (header ? GREY_FILL : undefined),
    margins: { top: pad("top", 0), bottom: pad("bottom", 0), left: pad("left", 108), right: pad("right", 108) },
    verticalAlign:
      va === "middle" ? VerticalAlignTable.CENTER : va === "bottom" ? VerticalAlignTable.BOTTOM : VerticalAlignTable.TOP,
    borders: Object.fromEntries(Object.entries(borders).filter(([, v]) => v)),
  };
}

function runOptions(marks: JSONContent["marks"] = []): RunOpts {
  const o: RunOpts = {};
  for (const mark of marks) {
    const a = mark.attrs ?? {};
    switch (mark.type) {
      case "bold":
        o.bold = true;
        break;
      case "italic":
        o.italics = true;
        break;
      case "underline":
        o.underline = {};
        break;
      case "strike":
        o.strike = true;
        break;
      case "code":
        o.font = "Courier New";
        break;
      case "textStyle": {
        const color = toHex(a.color);
        if (color) o.color = color;
        if (typeof a.fontFamily === "string" && a.fontFamily) o.font = primaryFont(a.fontFamily);
        const pt = toPoints(a.fontSize);
        if (pt) o.size = Math.round(pt * 2);
        break;
      }
      case "highlight": {
        const name = highlightName(a.color);
        const hex = toHex(a.color);
        if (name) o.highlight = name as (typeof HighlightColor)[keyof typeof HighlightColor];
        else if (hex) o.shading = { type: ShadingType.CLEAR, fill: hex, color: "auto" };
        break;
      }
      case "link":
        o.style = "Hyperlink";
        break;
    }
  }
  return o;
}

/**
 * TipTap JSON -> a Word document laid out like the editor page: A4, 1-inch
 * margins, Calibri 11 pt, Word's heading colours, bullets and numbering.
 * Images are resolved up front because decoding (or rasterizing) is async
 * while docx builds its tree synchronously.
 */
export async function buildDocx(
  doc: JSONContent,
  opts: { title?: string; rasterize?: Rasterize; page?: PageSetup | null } = {},
): Promise<ExportResult> {
  const images = new Map<string, ResolvedImage | null>();
  await Promise.all(
    Array.from(collectImageSources(doc, new Set())).map(async (src) => {
      images.set(src, await resolveImage(src, opts.rasterize));
    }),
  );

  const page = opts.page ?? A4_PAGE;
  const walker = new Walker(images, page);
  const children = walker.blocks(doc.content, ROOT);
  const heading = (size: number, color: string, before: number) => ({
    run: { font: "Calibri Light", size, color },
    paragraph: { spacing: { before, after: 80 }, keepNext: true, keepLines: true },
  });

  const document = new Document({
    title: opts.title,
    creator: "Docsmith",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { after: 160, line: 259 } },
        },
        title: { run: { font: "Calibri Light", size: 56, color: "000000" }, paragraph: { spacing: { after: 80 } } },
        heading1: heading(32, "2F5496", 240),
        heading2: heading(26, "2F5496", 160),
        heading3: heading(24, "1F3763", 160),
        heading4: heading(22, "2F5496", 160),
        heading5: heading(22, "2F5496", 160),
        heading6: heading(22, "1F3763", 160),
        // Numbered paragraphs get ListParagraph implicitly; as in Word, items sit
        // tight together and the list keeps the space after its last item.
        listParagraph: { paragraph: { contextualSpacing: true } },
      },
      characterStyles: [
        {
          id: "Hyperlink",
          name: "Hyperlink",
          basedOn: "DefaultParagraphFont",
          run: { color: "0563C1", underline: {} },
        },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: listLevels(false) },
        { reference: "numbers", levels: listLevels(true) },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: tw(page.widthPt), height: tw(page.heightPt) },
            margin: {
              top: tw(page.marginTopPt),
              right: tw(page.marginRightPt),
              bottom: tw(page.marginBottomPt),
              left: tw(page.marginLeftPt),
            },
          },
        },
        children: children.length ? children : [new Paragraph({})],
      },
    ],
  });

  return { document, skippedImages: walker.skippedImages };
}
