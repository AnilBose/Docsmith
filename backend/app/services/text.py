"""Text extraction and lossless text editing.

The editing strategy, and why it preserves fidelity:

1.  We read the page at *character* granularity (``rawdict``), so every glyph
    carries its own bbox, origin, font, size, colour and style flags.
2.  To change a run of text we place a redaction annotation over exactly the
    glyph boxes being replaced and apply it with image and vector-art removal
    switched **off**. That deletes the old glyphs from the content stream and
    leaves every other object -- photographs, logos, tables, background art --
    bit-identical.
3.  We then draw the replacement with ``insert_htmlbox``, feeding it the fonts
    extracted from the document itself plus CSS carrying size, weight, style,
    colour, alignment, line height and letter spacing.

Nothing in this path rasterises the page, so a document can be edited any
number of times without softening, re-compression or colour shift.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import fitz

from app.core.session import DocumentError, DocumentSession
from app.services import fonts as fontsvc

# Keep full ascender/descender values so our line boxes match the real glyph
# boxes; PyMuPDF otherwise reports "small" heights that hug the ink.
fitz.TOOLS.set_small_glyph_heights(False)

_REDACT_KWARGS: dict[str, Any] = {
    "images": getattr(fitz, "PDF_REDACT_IMAGE_NONE", 0),
    "graphics": getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0),
    "text": getattr(fitz, "PDF_REDACT_TEXT_REMOVE", 0),
}


# --------------------------------------------------------------------------- #
# Layout model
# --------------------------------------------------------------------------- #
@dataclass
class Char:
    ch: str
    bbox: fitz.Rect
    origin: tuple[float, float]
    span_id: str


@dataclass
class Span:
    span_id: str
    page: int
    text: str
    bbox: fitz.Rect
    origin: tuple[float, float]
    font: str
    size: float
    color: int
    flags: int
    ascender: float
    descender: float
    line_id: str
    block_id: str
    char_start: int          # offset into PageIndex.text
    char_end: int

    @property
    def bold(self) -> bool:
        return fontsvc.guess_style(self.font, self.flags)[0]

    @property
    def italic(self) -> bool:
        return fontsvc.guess_style(self.font, self.flags)[1]


@dataclass
class PageIndex:
    """A flattened, character-addressable view of one page."""

    page: int
    text: str = ""
    chars: list[Char] = field(default_factory=list)
    spans: dict[str, Span] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    blocks: list[dict] = field(default_factory=list)

    def span_list(self) -> list[Span]:
        return [self.spans[s] for s in self.order]


def _int_to_rgb(color: int) -> tuple[float, float, float]:
    return (
        ((color >> 16) & 0xFF) / 255.0,
        ((color >> 8) & 0xFF) / 255.0,
        (color & 0xFF) / 255.0,
    )


def rgb_to_hex(color: int) -> str:
    return "#{:06x}".format(color & 0xFFFFFF)


def hex_to_rgb(value: str | None, default: tuple[float, float, float] = (0, 0, 0)):
    if not value:
        return default
    raw = value.strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(c * 2 for c in raw)
    if len(raw) != 6:
        return default
    try:
        return (int(raw[0:2], 16) / 255, int(raw[2:4], 16) / 255, int(raw[4:6], 16) / 255)
    except ValueError:
        return default


def build_index(session: DocumentSession, pno: int) -> PageIndex:
    """Build (and memoise) the character index for a page."""
    key = "index:{0}".format(pno)
    cached = session.cache.get(key)
    if isinstance(cached, PageIndex):
        return cached

    page = _get_page(session, pno)
    raw = page.get_text("rawdict")
    index = PageIndex(page=pno)
    parts: list[str] = []
    cursor = 0

    for bi, block in enumerate(raw.get("blocks", [])):
        if block.get("type") != 0:      # 0 == text, 1 == image
            continue
        block_id = "p{0}b{1}".format(pno, bi)
        block_spans: list[str] = []
        for li, line in enumerate(block.get("lines", [])):
            line_id = "{0}l{1}".format(block_id, li)
            for si, span in enumerate(line.get("spans", [])):
                span_id = "{0}s{1}".format(line_id, si)
                span_chars = span.get("chars", [])
                span_text = "".join(c.get("c", "") for c in span_chars)
                if not span_text:
                    continue
                start = cursor
                for c in span_chars:
                    index.chars.append(
                        Char(
                            ch=c.get("c", ""),
                            bbox=fitz.Rect(c["bbox"]),
                            origin=tuple(c.get("origin", (0, 0))),
                            span_id=span_id,
                        )
                    )
                    cursor += 1
                parts.append(span_text)

                size = float(span.get("size", 0) or 0)
                index.spans[span_id] = Span(
                    span_id=span_id,
                    page=pno,
                    text=span_text,
                    bbox=fitz.Rect(span["bbox"]),
                    origin=tuple(span.get("origin", (0, 0))),
                    font=span.get("font", "") or "",
                    size=size,
                    color=int(span.get("color", 0) or 0),
                    flags=int(span.get("flags", 0) or 0),
                    ascender=float(span.get("ascender", 0.8) or 0.8),
                    descender=float(span.get("descender", -0.2) or -0.2),
                    line_id=line_id,
                    block_id=block_id,
                    char_start=start,
                    char_end=cursor,
                )
                index.order.append(span_id)
                block_spans.append(span_id)
            # A newline separates lines in the flat text stream.
            parts.append("\n")
            index.chars.append(
                Char(ch="\n", bbox=fitz.Rect(0, 0, 0, 0), origin=(0, 0), span_id=line_id)
            )
            cursor += 1
        index.blocks.append(
            {"id": block_id, "bbox": list(block.get("bbox", (0, 0, 0, 0))), "spans": block_spans}
        )

    index.text = "".join(parts)
    session.cache[key] = index
    return index


def _get_page(session: DocumentSession, pno: int) -> fitz.Page:
    if pno < 0 or pno >= session.doc.page_count:
        raise DocumentError("Page {0} is out of range.".format(pno + 1))
    return session.doc[pno]


# --------------------------------------------------------------------------- #
# Serialisation for the client
# --------------------------------------------------------------------------- #
def serialize_layout(session: DocumentSession, pno: int) -> dict:
    index = build_index(session, pno)
    library = fontsvc.build_library(session)
    page = _get_page(session, pno)

    spans_out = []
    for span in index.span_list():
        bold, italic = fontsvc.guess_style(span.font, span.flags)
        face = library.variant(span.font, bold=bold, italic=italic)
        record = library.record_for(face)
        spans_out.append(
            {
                "id": span.span_id,
                "lineId": span.line_id,
                "blockId": span.block_id,
                "text": span.text,
                "bbox": [span.bbox.x0, span.bbox.y0, span.bbox.x1, span.bbox.y1],
                "origin": list(span.origin),
                "font": span.font,
                "fontFamily": fontsvc.strip_subset_tag(span.font),
                "fontId": fontsvc.css_family_for(face),
                "size": round(span.size, 3),
                "color": rgb_to_hex(span.color),
                "bold": bold,
                "italic": italic,
                "serif": bool(record.serif) if record else fontsvc.looks_serif(span.font),
                "mono": bool(record.mono) if record else False,
                "embeddable": bool(record.embeddable) if record else False,
                "ascender": span.ascender,
                "descender": span.descender,
                "charStart": span.char_start,
                "charEnd": span.char_end,
            }
        )

    rect = page.rect
    return {
        "page": pno,
        "width": rect.width,
        "height": rect.height,
        "rotation": page.rotation,
        "spans": spans_out,
        "blocks": index.blocks,
        "text": index.text,
    }


# --------------------------------------------------------------------------- #
# Style handling
# --------------------------------------------------------------------------- #
@dataclass
class TextStyle:
    font: str = "helv"                 # BaseFont name or a UI family id
    size: float = 11.0
    color: str = "#000000"
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strike: bool = False
    align: str = "left"                # left | center | right | justify
    line_height: float = 1.0           # multiplier
    letter_spacing: float = 0.0        # in points
    background: str | None = None

    @classmethod
    def from_payload(cls, payload: dict | None, base: "TextStyle | None" = None) -> "TextStyle":
        base = base or cls()
        payload = payload or {}

        def pick(key, attr, cast=lambda v: v):
            if key in payload and payload[key] is not None:
                try:
                    return cast(payload[key])
                except (TypeError, ValueError):
                    return getattr(base, attr)
            return getattr(base, attr)

        return cls(
            font=pick("font", "font", str),
            size=pick("size", "size", float),
            color=pick("color", "color", str),
            bold=pick("bold", "bold", bool),
            italic=pick("italic", "italic", bool),
            underline=pick("underline", "underline", bool),
            strike=pick("strike", "strike", bool),
            align=pick("align", "align", str),
            line_height=pick("lineHeight", "line_height", float),
            letter_spacing=pick("letterSpacing", "letter_spacing", float),
            background=payload.get("background", base.background),
        )

    @classmethod
    def from_span(cls, span: Span) -> "TextStyle":
        bold, italic = fontsvc.guess_style(span.font, span.flags)
        return cls(
            font=span.font,
            size=span.size or 11.0,
            color=rgb_to_hex(span.color),
            bold=bold,
            italic=italic,
        )


_ALIGN_CSS = {"left": "left", "center": "center", "right": "right", "justify": "justify"}


def build_css(style: TextStyle, library: fontsvc.FontLibrary, line_box_px: float | None) -> str:
    decorations = []
    if style.underline:
        decorations.append("underline")
    if style.strike:
        decorations.append("line-through")

    rules = [
        "font-family: {0};".format(
            library.font_stack(library.variant(style.font, bold=style.bold, italic=style.italic))
        ),
        "font-size: {0:.4f}px;".format(style.size),
        "color: {0};".format(style.color or "#000000"),
        "font-weight: {0};".format("bold" if style.bold else "normal"),
        "font-style: {0};".format("italic" if style.italic else "normal"),
        "text-align: {0};".format(_ALIGN_CSS.get(style.align, "left")),
        "margin: 0; padding: 0;",
        "white-space: pre-wrap;",
        "word-break: normal;",
    ]
    if line_box_px:
        rules.append("line-height: {0:.4f}px;".format(line_box_px))
    else:
        rules.append("line-height: {0:.4f};".format(max(style.line_height, 0.1)))
    if abs(style.letter_spacing) > 1e-6:
        rules.append("letter-spacing: {0:.4f}px;".format(style.letter_spacing))
    if decorations:
        rules.append("text-decoration: {0};".format(" ".join(decorations)))
    if style.background:
        rules.append("background-color: {0};".format(style.background))

    return "{0}\n#pdfe {{ {1} }}".format(library.css, " ".join(rules))


def to_html(text: str) -> str:
    escaped = html.escape(text, quote=False)
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br/>")
    return '<div id="pdfe">{0}</div>'.format(escaped)


# --------------------------------------------------------------------------- #
# Drawing
# --------------------------------------------------------------------------- #
def draw_text(
    page: fitz.Page,
    rect: fitz.Rect,
    text: str,
    style: TextStyle,
    library: fontsvc.FontLibrary,
    *,
    line_box_px: float | None = None,
    grow: bool = True,
    max_grow: float = 6.0,
) -> fitz.Rect:
    """Render ``text`` into ``rect``; grow the box downward if it overflows.

    Returns the rectangle actually used, so callers can report the final
    geometry back to the UI.
    """
    if not text:
        return rect

    body = to_html(text)
    css = build_css(style, library, line_box_px)
    target = fitz.Rect(rect)

    attempts = 0
    while True:
        try:
            spare, _scale = page.insert_htmlbox(
                target, body, css=css, archive=library.archive, scale_low=1.0
            )
        except Exception as exc:
            raise DocumentError("Could not lay out the text: {0}".format(exc)) from exc

        if spare >= 0 or not grow or attempts >= 12:
            break
        # insert_htmlbox reports how much height was missing (negative spare).
        needed = abs(spare) + max(style.size * 0.25, 2.0)
        limit = page.rect.y1 - target.y0
        new_height = min(target.height + needed, limit)
        if new_height <= target.height + 0.01 or target.height >= rect.height * max_grow:
            # Out of room on the page: fall back to shrink-to-fit.
            page.insert_htmlbox(target, body, css=css, archive=library.archive, scale_low=0.2)
            break
        target = fitz.Rect(target.x0, target.y0, target.x1, target.y0 + new_height)
        attempts += 1

    return target


def estimate_width(text: str, style: TextStyle) -> float:
    """Approximate the rendered width of a single line, in points."""
    fontname = fontsvc.base14_for(style.font, bold=style.bold, italic=style.italic)
    try:
        width = fitz.get_text_length(text, fontname=fontname, fontsize=style.size)
    except Exception:
        # Unknown base-14 code: fall back to a conservative average advance.
        width = len(text) * style.size * 0.55
    return width + abs(style.letter_spacing) * max(len(text) - 1, 0)


def fit_single_line(
    page: fitz.Page,
    rect: fitz.Rect,
    text: str,
    style: TextStyle,
    *,
    margin: float = 6.0,
) -> fitz.Rect:
    """Widen a single-line box so longer replacement text grows sideways.

    Without this, retyping a heading into something longer would wrap onto a
    second line inside the original box -- correct for a paragraph, wrong for
    the one-line runs that most edits touch. We let the box run toward the page
    edge first and only fall back to wrapping when there is genuinely no room.
    """
    if "\n" in text:
        return rect
    needed = estimate_width(text, style) * 1.04 + style.size * 0.4
    if needed <= rect.width:
        return rect
    limit = page.rect.x1 - margin
    return fitz.Rect(rect.x0, rect.y0, min(rect.x0 + needed, limit), rect.y1)


def line_box_for(style: TextStyle, span: Span | None) -> float | None:
    """Height of one line box, chosen so replacement baselines match the original."""
    if span is not None and span.size > 0:
        natural = (span.ascender - span.descender) * style.size
    else:
        natural = style.size * 1.2
    return natural * max(style.line_height, 0.1)


def erase_rects(page: fitz.Page, rects: Iterable[fitz.Rect]) -> None:
    """Remove the glyphs under ``rects`` without disturbing anything else."""
    applied = False
    for rect in rects:
        area = fitz.Rect(rect)
        if area.is_empty or area.is_infinite:
            continue
        # A hair of padding catches anti-aliased side bearings.
        area = fitz.Rect(area.x0 - 0.35, area.y0 - 0.2, area.x1 + 0.35, area.y1 + 0.2)
        page.add_redact_annot(area)   # no fill -> background is preserved
        applied = True
    if applied:
        page.apply_redactions(**_REDACT_KWARGS)


# --------------------------------------------------------------------------- #
# Public operations
# --------------------------------------------------------------------------- #
def _rects_for_spans(index: PageIndex, span_ids: Sequence[str]) -> list[fitz.Rect]:
    rects = []
    for sid in span_ids:
        span = index.spans.get(sid)
        if span is None:
            raise DocumentError("Unknown text run '{0}'; reload the page.".format(sid))
        rects.append(fitz.Rect(span.bbox))
    return rects


def _union(rects: Sequence[fitz.Rect]) -> fitz.Rect:
    out = fitz.Rect(rects[0])
    for r in rects[1:]:
        out |= r
    return out


def apply_edits(session: DocumentSession, edits: list[dict]) -> dict:
    """Apply a batch of text edits as one undoable operation."""
    if not edits:
        return {"applied": 0}

    with session.lock:
        session.checkpoint()
        library = fontsvc.build_library(session)
        applied = 0
        results: list[dict] = []

        # Group by page so redactions for a page are applied together.
        by_page: dict[int, list[dict]] = {}
        for edit in edits:
            by_page.setdefault(int(edit.get("page", 0)), []).append(edit)

        for pno, page_edits in by_page.items():
            page = _get_page(session, pno)
            index = build_index(session, pno)

            # --- phase 1: erase everything this batch replaces or deletes ----
            erase: list[fitz.Rect] = []
            plans: list[dict] = []
            for edit in page_edits:
                action = edit.get("action", "replace")
                span_ids = edit.get("spanIds") or ([edit["spanId"]] if edit.get("spanId") else [])
                explicit = edit.get("rect")

                if action == "insert":
                    if not explicit:
                        raise DocumentError("Adding text requires a rectangle.")
                    plans.append(
                        {"edit": edit, "rect": fitz.Rect(*explicit), "span": None}
                    )
                    continue

                if not span_ids and not explicit:
                    raise DocumentError("This edit selects no text.")

                if span_ids:
                    rects = _rects_for_spans(index, span_ids)
                    erase.extend(rects)
                    target = fitz.Rect(*explicit) if explicit else _union(rects)
                    anchor = index.spans[span_ids[0]]
                else:
                    target = fitz.Rect(*explicit)
                    erase.append(target)
                    anchor = None

                if action == "delete":
                    applied += 1
                    results.append({"page": pno, "action": "delete"})
                    continue

                plans.append({"edit": edit, "rect": target, "span": anchor})

            erase_rects(page, erase)

            # --- phase 2: draw replacements ---------------------------------
            for plan in plans:
                edit = plan["edit"]
                anchor: Span | None = plan["span"]
                base = TextStyle.from_span(anchor) if anchor else TextStyle()
                style = TextStyle.from_payload(edit.get("style"), base)
                text = edit.get("text", "")
                if not text:
                    applied += 1
                    continue

                rect = plan["rect"]
                if anchor is not None:
                    # Re-seat the box on the original glyph box so the new
                    # baseline lands exactly where the old one did.
                    top = anchor.origin[1] - anchor.ascender * style.size
                    bottom = anchor.origin[1] - anchor.descender * style.size
                    slack = max(rect.width * 0.02, 1.5)
                    rect = fitz.Rect(
                        rect.x0, min(rect.y0, top), rect.x1 + slack, max(rect.y1, bottom)
                    )
                    rect = fit_single_line(page, rect, text, style)

                used = draw_text(
                    page,
                    rect,
                    text,
                    style,
                    library,
                    line_box_px=line_box_for(style, anchor),
                )
                applied += 1
                results.append(
                    {
                        "page": pno,
                        "action": edit.get("action", "replace"),
                        "rect": [used.x0, used.y0, used.x1, used.y1],
                    }
                )

        session.invalidate_cache()
        session.touch()
        return {"applied": applied, "results": results}


# --------------------------------------------------------------------------- #
# Search / replace
# --------------------------------------------------------------------------- #
def _compile(query: str, *, regex: bool, case: bool, whole_word: bool) -> re.Pattern:
    pattern = query if regex else re.escape(query)
    if whole_word:
        pattern = r"\b(?:{0})\b".format(pattern)
    flags = 0 if case else re.IGNORECASE
    try:
        return re.compile(pattern, flags)
    except re.error as exc:
        raise DocumentError("Invalid search pattern: {0}".format(exc)) from exc


def _match_rects(index: PageIndex, start: int, end: int) -> list[fitz.Rect]:
    """Union the glyph boxes of a match, split into one rect per visual line."""
    groups: list[list[fitz.Rect]] = []
    current: list[fitz.Rect] = []
    last_y: float | None = None
    for c in index.chars[start:end]:
        if c.ch == "\n" or c.bbox.is_empty:
            continue
        if last_y is not None and abs(c.bbox.y0 - last_y) > 1.5:
            if current:
                groups.append(current)
            current = []
        current.append(c.bbox)
        last_y = c.bbox.y0
    if current:
        groups.append(current)
    return [_union(g) for g in groups if g]


def search(
    session: DocumentSession,
    query: str,
    *,
    regex: bool = False,
    case: bool = False,
    whole_word: bool = False,
    pages: Sequence[int] | None = None,
    limit: int = 2000,
) -> list[dict]:
    if not query:
        return []
    pattern = _compile(query, regex=regex, case=case, whole_word=whole_word)
    page_range = pages if pages is not None else range(session.doc.page_count)
    hits: list[dict] = []

    for pno in page_range:
        index = build_index(session, pno)
        for match in pattern.finditer(index.text):
            if match.start() == match.end():
                continue
            rects = _match_rects(index, match.start(), match.end())
            if not rects:
                continue
            span_ids: list[str] = []
            for c in index.chars[match.start():match.end()]:
                if c.span_id not in span_ids and c.ch != "\n":
                    span_ids.append(c.span_id)
            context_start = max(0, match.start() - 40)
            context_end = min(len(index.text), match.end() + 40)
            hits.append(
                {
                    "id": "m{0}-{1}-{2}".format(pno, match.start(), match.end()),
                    "page": pno,
                    "text": match.group(0),
                    "start": match.start(),
                    "end": match.end(),
                    "rects": [[r.x0, r.y0, r.x1, r.y1] for r in rects],
                    "spanIds": span_ids,
                    "context": index.text[context_start:context_end].replace("\n", " "),
                }
            )
            if len(hits) >= limit:
                return hits
    return hits


def replace(
    session: DocumentSession,
    query: str,
    replacement: str,
    *,
    regex: bool = False,
    case: bool = False,
    whole_word: bool = False,
    pages: Sequence[int] | None = None,
    match_ids: Sequence[str] | None = None,
) -> dict:
    """Find and replace, keeping each hit's original typography."""
    hits = search(
        session, query, regex=regex, case=case, whole_word=whole_word, pages=pages
    )
    if match_ids is not None:
        wanted = set(match_ids)
        hits = [h for h in hits if h["id"] in wanted]
    if not hits:
        return {"replaced": 0}

    pattern = _compile(query, regex=regex, case=case, whole_word=whole_word)

    with session.lock:
        session.checkpoint()
        library = fontsvc.build_library(session)
        replaced = 0

        by_page: dict[int, list[dict]] = {}
        for hit in hits:
            by_page.setdefault(hit["page"], []).append(hit)

        for pno, page_hits in by_page.items():
            page = _get_page(session, pno)
            index = build_index(session, pno)

            # Work back-to-front so earlier offsets stay valid.
            page_hits.sort(key=lambda h: h["start"], reverse=True)

            erase: list[fitz.Rect] = []
            plans: list[tuple[fitz.Rect, str, Span]] = []
            for hit in page_hits:
                anchor_id = hit["spanIds"][0] if hit["spanIds"] else None
                anchor = index.spans.get(anchor_id) if anchor_id else None
                if anchor is None:
                    continue
                rects = [fitz.Rect(*r) for r in hit["rects"]]
                erase.extend(rects)
                text = (
                    pattern.sub(replacement, hit["text"], count=1) if regex else replacement
                )
                plans.append((_union(rects), text, anchor))

            erase_rects(page, erase)

            for rect, text, anchor in plans:
                style = TextStyle.from_span(anchor)
                top = anchor.origin[1] - anchor.ascender * style.size
                bottom = anchor.origin[1] - anchor.descender * style.size
                box = fitz.Rect(
                    rect.x0, min(rect.y0, top), rect.x1 + 2, max(rect.y1, bottom)
                )
                box = fit_single_line(page, box, text, style)
                draw_text(
                    page, box, text, style, library, line_box_px=line_box_for(style, anchor)
                )
                replaced += 1

        session.invalidate_cache()
        session.touch()
        return {"replaced": replaced}


def extract_text(session: DocumentSession, pages: Sequence[int] | None = None) -> str:
    page_range = pages if pages is not None else range(session.doc.page_count)
    return "\n\n".join(session.doc[p].get_text("text") for p in page_range)


def change_case(text: str, mode: str) -> str:
    if mode == "upper":
        return text.upper()
    if mode == "lower":
        return text.lower()
    if mode == "title":
        return text.title()
    if mode == "sentence":
        chunks = re.split(r"([.!?]\s+)", text.lower())
        return "".join(
            c[:1].upper() + c[1:] if i % 2 == 0 else c for i, c in enumerate(chunks)
        )
    if mode == "toggle":
        return text.swapcase()
    return text
