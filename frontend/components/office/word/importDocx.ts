import mammoth from "mammoth";
import { HIGHLIGHTS, fontStack } from "./format";

export interface ImportResult {
  html: string;
  /** Mammoth messages worth telling the user about (not unmapped style names). */
  warnings: string[];
}

/** Minimal view of mammoth's document model, as passed to transformDocument. */
interface MammothElement {
  type: string;
  children?: MammothElement[];
  alignment?: string | null;
  font?: string | null;
  fontSize?: number | null;
  highlight?: string | null;
  [key: string]: unknown;
}

const ALIGN: Record<string, string> = {
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  distribute: "justify",
};

/** Sentinel text in alignment markers: mammoth drops elements with no text. */
const MARK = "​";

function wrapperRun(styleName: string, children: MammothElement[]): MammothElement {
  return {
    type: "run",
    children,
    styleId: null,
    styleName,
    isBold: false,
    isUnderline: false,
    isItalic: false,
    isStrikethrough: false,
    isAllCaps: false,
    isSmallCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
  };
}

/**
 * .docx -> HTML for the editor.
 *
 * Mammoth reads alignment, fonts, sizes and highlights but deliberately leaves
 * them out of its HTML. A document transform wraps such runs in marker runs
 * with synthetic style names, the style map turns those into classed elements,
 * and the classes are swapped for inline styles afterwards, which TipTap's
 * TextStyle, Highlight and TextAlign extensions parse. Mammoth reads the style
 * map only after transforming (pinned 1.13.0), so the transform can extend it.
 */
export async function importDocx(bytes: ArrayBuffer): Promise<ImportResult> {
  const formats: string[] = [];
  const formatIds = new Map<string, number>();
  const styleMap: string[] = [
    "u => u",
    "strike => s",
    "p[style-name='Title'] => h1.doc-title:fresh",
    "p[style-name='Subtitle'] => p:fresh",
    ...Object.keys(HIGHLIGHTS).map((name) => `r[style-name='whl-${name}'] => mark.whl-${name}`),
    ...Object.values(ALIGN)
      .filter((v, i, all) => all.indexOf(v) === i)
      .map((a) => `r[style-name='walign-${a}'] => span.walign-${a}`),
  ];

  const formatClass = (css: string): string => {
    let id = formatIds.get(css);
    if (id === undefined) {
      id = formats.length;
      formats.push(css);
      formatIds.set(css, id);
      styleMap.push(`r[style-name='wfmt-${id}'] => span.wfmt-${id}`);
    }
    return `wfmt-${id}`;
  };

  const visit = (el: MammothElement): MammothElement => {
    if (el.children) el.children = el.children.map(visit);
    if (el.type === "paragraph" && el.alignment && ALIGN[el.alignment]) {
      const marker = wrapperRun(`walign-${ALIGN[el.alignment]}`, [{ type: "text", value: MARK }]);
      el.children = [marker, ...(el.children ?? [])];
    }
    // Children are visited before wrapping, so marker runs are never revisited.
    if (el.type === "run") {
      let inner = el.children ?? [];
      const css: string[] = [];
      if (el.font) css.push(`font-family: ${fontStack(el.font)}`);
      if (el.fontSize) css.push(`font-size: ${el.fontSize}pt`);
      if (css.length) inner = [wrapperRun(formatClass(css.join("; ")), inner)];
      if (el.highlight && el.highlight in HIGHLIGHTS) {
        inner = [wrapperRun(`whl-${el.highlight}`, inner)];
      }
      el.highlight = null;
      el.children = inner;
    }
    return el;
  };

  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes },
    {
      styleMap,
      convertImage: mammoth.images.dataUri,
      transformDocument: (doc: MammothElement) => visit(doc),
    },
  );

  const warnings = result.messages
    .filter((m) => !/^Unrecognised (paragraph|run|table) style/i.test(m.message))
    .map((m) => m.message);

  return { html: restyle(result.value, formats), warnings };
}

/** Swap the marker classes for the inline styles the editor understands. */
export function restyle(html: string, formats: string[]): string {
  return html
    .replace(
      /<(p|h[1-6]|li)((?:\s[^>]*)?)><span class="walign-(\w+)">​<\/span>/g,
      (_m, tag: string, attrs: string, align: string) => `<${tag}${attrs} style="text-align: ${align}">`,
    )
    .replace(/<span class="walign-\w+">​<\/span>/g, "")
    .replace(/class="wfmt-(\d+)"/g, (_m, id: string) => `style="${formats[Number(id)] ?? ""}"`)
    .replace(/class="whl-(\w+)"/g, (_m, name: string) => {
      const color = HIGHLIGHTS[name] ?? HIGHLIGHTS.yellow;
      return `data-color="${color}" style="background-color: ${color}"`;
    });
}
