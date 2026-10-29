import { api } from "./api";

/**
 * Loads a document's embedded fonts into the browser so the paragraph editor
 * previews text in the real face.
 *
 * Faces of one family (Inter, Inter-Bold) are registered under a single
 * family name with their real weight and style, so bold text uses the bold
 * face and Ctrl+B switches faces instead of smearing the regular one. Ids are
 * only unique within a document, so the family name carries the document id.
 *
 * Each face is limited to the characters it really draws (the server sends
 * them as a unicode-range): subsets often map "x" or "+" to an empty glyph,
 * and without the range the browser would show a blank instead of falling
 * back to the next font.
 */
const loading = new Map<string, Promise<boolean>>();

export function documentFontFamily(docId: string, familyId: string): string {
  return `pdfe-${familyId}--${docId.slice(0, 8)}`;
}

export function loadDocumentFont(
  docId: string,
  fontId: string,
  familyId: string,
  bold: boolean,
  italic: boolean,
): Promise<boolean> {
  const family = documentFontFamily(docId, familyId);
  const key = `${family}/${fontId}`;
  let pending = loading.get(key);
  if (!pending) {
    pending = fetch(api.fontFileUrl(docId, fontId))
      .then(async (response) => {
        if (!response.ok) return false;
        const range = response.headers.get("X-Unicode-Range");
        const face = new FontFace(family, await response.arrayBuffer(), {
          weight: bold ? "700" : "400",
          style: italic ? "italic" : "normal",
          ...(range ? { unicodeRange: range } : {}),
        });
        document.fonts.add(await face.load());
        return true;
      })
      // Subset fonts are sometimes too broken for the browser; fall back quietly.
      .catch(() => false);
    loading.set(key, pending);
  }
  return pending;
}
