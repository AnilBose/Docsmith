export type Rect = [number, number, number, number];

export interface PageInfo {
  index: number;
  number: number;
  width: number;
  height: number;
  rotation: number;
  label: string;
}

export interface DocumentSummary {
  id: string;
  filename: string;
  pageCount: number;
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  encrypted: boolean;
  isFormPdf: boolean;
  metadata: Record<string, string>;
  pages: PageInfo[];
}

export interface TextSpan {
  id: string;
  lineId: string;
  blockId: string;
  text: string;
  bbox: Rect;
  origin: [number, number];
  font: string;
  fontFamily: string;
  fontId: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  embeddable: boolean;
  ascender: number;
  descender: number;
  charStart: number;
  charEnd: number;
}

/** A run of uniformly styled text inside a paragraph. */
export interface TextRun {
  text: string;
  font?: string;
  fontId?: string;
  familyId?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** A single space of exactly this width (a fixed gap in the original layout). */
  spaceWidth?: number;
}

export interface Paragraph {
  id: string;
  spanIds: string[];
  bbox: Rect;
  /** Where the text wraps: left/right edge, first line top, last line bottom. */
  box: Rect;
  firstIndent: number;
  firstBaseline: number;
  lineHeight: number;
  lineCount: number;
  align: "left" | "center" | "right" | "justify";
  /** Extra space above a new item created with Enter. */
  itemGap: number;
  /** How far the paragraph can move up into the empty space above it. */
  spaceAbove: number;
  marker: { text: string; bbox: Rect; inline: boolean } | null;
  runs: TextRun[];
}

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  rotation: number;
  spans: TextSpan[];
  blocks: { id: string; bbox: Rect; spans: string[] }[];
  text: string;
  paragraphs?: Paragraph[];
  background?: string;
  version?: number;
}

export interface ParagraphEditResult {
  applied: number;
  pagesChanged: number[];
  pagesAdded: number;
  warnings: string[];
  document: DocumentSummary;
}

export interface TextStyleInput {
  font?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  letterSpacing?: number;
  background?: string | null;
}

export interface TextEdit {
  page: number;
  action: "replace" | "delete" | "insert";
  spanId?: string;
  spanIds?: string[];
  rect?: Rect;
  text?: string;
  style?: TextStyleInput;
}

export interface ImageObject {
  id: string;
  xref: number;
  page: number;
  occurrence: number;
  name: string;
  bbox: Rect;
  width: number;
  height: number;
  bpc: number;
  colorspace: string;
  hasAlpha: boolean;
  dpiX: number;
  dpiY: number;
}

export interface SearchMatch {
  id: string;
  page: number;
  text: string;
  start: number;
  end: number;
  rects: Rect[];
  spanIds: string[];
  context: string;
}

export interface Annotation {
  id: string;
  xref: number;
  page: number;
  type: string;
  typeId: number;
  rect: Rect;
  color: string;
  opacity: number;
  author: string;
  contents: string;
  subject: string;
  created: string;
  modified: string;
}

export interface RedactionFinding {
  id: string;
  kind: string;
  label: string;
  page: number;
  text: string;
  rects: Rect[];
  context: string;
}

export interface SpellIssue {
  id: string;
  page: number;
  word: string;
  start: number;
  end: number;
  rects: Rect[];
  spanIds: string[];
  suggestions: string[];
  context: string;
}

export interface FontFamily {
  id: string;
  label: string;
  source: "document" | "standard";
  embeddable: boolean;
  serif: boolean;
  mono: boolean;
}

export interface Capabilities {
  toPdf: Record<string, boolean>;
  fromPdf: Record<string, boolean>;
  libreOffice: string | null;
  htmlRenderer: string;
}

export interface PermissionFlags {
  printDocument: boolean;
  printHighResolution: boolean;
  copyContent: boolean;
  modifyContent: boolean;
  modifyAnnotations: boolean;
  fillForms: boolean;
  accessibility: boolean;
  assembleDocument: boolean;
}

export type ToolMode =
  | "select"
  | "editText"
  | "addText"
  | "editImage"
  | "addImage"
  | "highlight"
  | "underline"
  | "strikeout"
  | "comment"
  | "redact";

export type ViewMode = "continuous" | "single" | "facing";
export type ZoomMode = "custom" | "fitPage" | "fitWidth" | "actual";
export type ReadingMode = "normal" | "reading" | "night";
