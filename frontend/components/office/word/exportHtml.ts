import { A4_PAGE, DEFAULT_FONT, type PageSetup } from "./format";

/** The server's Story fallback always lays out A4 with 42 pt margins. */
const STORY_CONTENT_PT = 595.28 - 2 * 42;

/**
 * Plain CSS for the document outside the editor. It stays within what
 * PyMuPDF's Story engine understands (no flex, grid or custom properties),
 * since that is the server's fallback when WeasyPrint is not installed.
 */
const DOCUMENT_CSS = `
body { font-family: ${DEFAULT_FONT.css}; font-size: 11pt; line-height: 1.3; color: #000000; }
p { margin: 0 0 8pt 0; }
h1, h2, h3, h4, h5, h6 { font-family: 'Calibri Light', ${DEFAULT_FONT.css}; font-weight: normal; margin: 12pt 0 4pt 0; line-height: 1.2; }
h1 { font-size: 16pt; color: #2F5496; }
h1.doc-title { font-size: 28pt; color: #000000; margin: 0 0 4pt 0; }
h2 { font-size: 13pt; color: #2F5496; margin-top: 8pt; }
h3 { font-size: 12pt; color: #1F3763; margin-top: 8pt; }
h4, h5 { font-size: 11pt; color: #2F5496; font-style: italic; margin-top: 8pt; }
h6 { font-size: 11pt; color: #1F3763; margin-top: 8pt; }
ul, ol { margin: 0 0 8pt 0; padding-left: 24pt; }
li { margin: 0; }
li p, li ul, li ol { margin: 0; }
table { border-collapse: collapse; border-spacing: 0; width: 100%; margin: 0 0 8pt 0; }
td, th { border: 0.75pt solid #8C8C8C; padding: 1pt 5.4pt; vertical-align: top; text-align: left; }
th { background-color: #F2F2F2; font-weight: bold; }
td p, th p { margin: 0; }
img { max-width: 100%; }
blockquote { margin: 0 0 8pt 36pt; padding-left: 8pt; border-left: 1.5pt solid #BFBFBF; }
blockquote p { margin: 0 0 4pt 0; }
pre { font-family: 'Courier New', monospace; font-size: 10pt; background-color: #F2F2F2; padding: 6pt; margin: 0 0 8pt 0; white-space: pre-wrap; }
code { font-family: 'Courier New', monospace; }
hr { border: 0; border-top: 0.75pt solid #A6A6A6; margin: 6pt 0; }
a, u { text-decoration: underline; }
a { color: #0563C1; }
s, del, strike { text-decoration: line-through; }
mark { color: inherit; }
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/**
 * Image sizes as points in CSS. The editor stores CSS pixels in width/height
 * attributes, which the Story engine reads as points (a third too large).
 */
function imageSizesInPoints(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const size = (name: string) => {
      const m = new RegExp(`\\s${name}="(\\d+(?:\\.\\d+)?)"`, "i").exec(tag);
      return m ? Math.round(parseFloat(m[1]) * 0.75 * 100) / 100 : null;
    };
    const w = size("width");
    const h = size("height");
    if (w === null && h === null) return tag;
    const style = [w !== null ? `width: ${w}pt` : "", h !== null ? `height: ${h}pt` : ""].filter(Boolean).join("; ");
    return tag
      .replace(/\s(width|height)="[^"]*"/gi, "")
      .replace(/\sstyle="[^"]*"/i, "")
      .replace(/^<img/i, `<img style="${style}"`);
  });
}

/**
 * Self-contained HTML for "Convert to PDF" (``target: "pdf"``) or
 * "Save as HTML" (``target: "file"``), laid out on the document's page.
 *
 * For PDF the content column keeps the page's width under either server
 * renderer: WeasyPrint honours ``@page``, while the Story fallback always
 * uses A4 with 42 pt margins, so the body's side margins make up the
 * difference and ``@page`` takes the rest.
 */
export function buildDocumentHtml(
  bodyHtml: string,
  title: string,
  target: "pdf" | "file",
  page: PageSetup = A4_PAGE,
): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  const { widthPt: W, heightPt: H, marginTopPt: T, marginRightPt: R, marginBottomPt: B, marginLeftPt: L } = page;
  const content = W - L - R;
  let layout: string;
  if (target === "pdf") {
    const sides = Math.max(0, STORY_CONTENT_PT - content);
    const left = L + R > 0 ? (sides * L) / (L + R) : sides / 2;
    const pageSide = Math.max(0, (W - content - sides) / 2);
    layout = `@page { size: ${r(W)}pt ${r(H)}pt; margin: ${r(T)}pt ${r(pageSide)}pt ${r(B)}pt ${r(pageSide)}pt; }
body { margin: 0 ${r(sides - left)}pt 0 ${r(left)}pt; }`;
  } else {
    layout = `@page { size: ${r(W)}pt ${r(H)}pt; margin: ${r(T)}pt ${r(R)}pt ${r(B)}pt ${r(L)}pt; }
@media screen {
  html { background-color: #E6E6E6; }
  body { background-color: #FFFFFF; width: ${r(content)}pt; min-height: ${r(H - T - B)}pt; margin: 24px auto; padding: ${r(T)}pt ${r(R)}pt ${r(B)}pt ${r(L)}pt; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
}
@media print { body { margin: 0; } }`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${DOCUMENT_CSS}
${layout}
</style>
</head>
<body>
${imageSizesInPoints(bodyHtml)}
</body>
</html>
`;
}
