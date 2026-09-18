"""Markup annotations: highlight, underline, strikethrough, squiggly, notes.

These are real PDF annotation objects, so they stay selectable, re-colourable
and removable in this editor and in any other conforming PDF reader.
"""
from __future__ import annotations

from datetime import datetime, timezone

import fitz

from app.core.session import DocumentError, DocumentSession
from app.services.text import hex_to_rgb

_MARKUP = {
    "highlight": "add_highlight_annot",
    "underline": "add_underline_annot",
    "strikeout": "add_strikeout_annot",
    "strikethrough": "add_strikeout_annot",
    "squiggly": "add_squiggly_annot",
}

_DEFAULT_COLOR = {
    "highlight": "#ffe14d",
    "underline": "#1a73e8",
    "strikeout": "#d93025",
    "strikethrough": "#d93025",
    "squiggly": "#12854a",
}


def _page(session: DocumentSession, pno: int) -> fitz.Page:
    if pno < 0 or pno >= session.doc.page_count:
        raise DocumentError("Page {0} is out of range.".format(pno + 1))
    return session.doc[pno]


def _serialize(annot: fitz.Annot, pno: int) -> dict:
    info = annot.info or {}
    rect = annot.rect
    colors = annot.colors or {}
    stroke = colors.get("stroke") or colors.get("fill") or (0, 0, 0)
    return {
        "id": "p{0}a{1}".format(pno, annot.xref),
        "xref": annot.xref,
        "page": pno,
        "type": annot.type[1] if annot.type else "Unknown",
        "typeId": annot.type[0] if annot.type else -1,
        "rect": [rect.x0, rect.y0, rect.x1, rect.y1],
        "color": "#{0:02x}{1:02x}{2:02x}".format(
            *(int(round(max(0.0, min(1.0, c)) * 255)) for c in stroke[:3])
        ),
        "opacity": annot.opacity if annot.opacity is not None else 1.0,
        "author": info.get("title", ""),
        "contents": info.get("content", ""),
        "subject": info.get("subject", ""),
        "created": info.get("creationDate", ""),
        "modified": info.get("modDate", ""),
    }


def list_annotations(session: DocumentSession, pno: int | None = None) -> list[dict]:
    pages = [pno] if pno is not None else range(session.doc.page_count)
    out: list[dict] = []
    for index in pages:
        page = _page(session, index)
        for annot in page.annots() or []:
            out.append(_serialize(annot, index))
    return out


def add_markup(
    session: DocumentSession,
    pno: int,
    kind: str,
    quads: list[list[float]],
    *,
    color: str | None = None,
    opacity: float = 1.0,
    author: str = "",
    note: str = "",
) -> dict:
    method_name = _MARKUP.get(kind.lower())
    if not method_name:
        raise DocumentError("Unsupported markup type '{0}'.".format(kind))
    if not quads:
        raise DocumentError("Select some text first.")

    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        # Accept either [x0,y0,x1,y1] rectangles or 8-number quads.
        regions = []
        for q in quads:
            if len(q) == 4:
                regions.append(fitz.Rect(*q).quad)
            elif len(q) == 8:
                regions.append(fitz.Quad(*(fitz.Point(q[i], q[i + 1]) for i in (0, 2, 4, 6))))
            else:
                raise DocumentError("A markup region needs 4 or 8 numbers.")
        annot = getattr(page, method_name)(regions)
        rgb = hex_to_rgb(color or _DEFAULT_COLOR.get(kind.lower(), "#ffe14d"))
        annot.set_colors(stroke=rgb)
        annot.set_opacity(max(0.05, min(opacity, 1.0)))
        annot.set_info(
            title=author or "Local user",
            content=note or "",
            subject=kind.title(),
        )
        annot.update()
        session.invalidate_cache()
        return _serialize(annot, pno)


def add_note(
    session: DocumentSession,
    pno: int,
    point: list[float],
    contents: str,
    *,
    author: str = "",
    color: str = "#ffd24d",
    icon: str = "Comment",
) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        annot = page.add_text_annot(fitz.Point(point[0], point[1]), contents, icon=icon)
        annot.set_colors(stroke=hex_to_rgb(color))
        annot.set_info(
            title=author or "Local user",
            content=contents,
            subject="Note",
            creationDate=_now(),
        )
        annot.update()
        session.invalidate_cache()
        return _serialize(annot, pno)


def add_free_text(
    session: DocumentSession,
    pno: int,
    rect: list[float],
    contents: str,
    *,
    size: float = 11.0,
    color: str = "#000000",
    fill: str | None = "#fffde7",
    border: str | None = "#b0a04a",
    align: str = "left",
) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        alignment = {"left": 0, "center": 1, "right": 2}.get(align, 0)
        annot = page.add_freetext_annot(
            fitz.Rect(*rect),
            contents,
            fontsize=size,
            text_color=hex_to_rgb(color),
            fill_color=hex_to_rgb(fill) if fill else None,
            border_color=hex_to_rgb(border) if border else None,
            align=alignment,
        )
        annot.set_info(title="Local user", content=contents, subject="Text box")
        annot.update()
        session.invalidate_cache()
        return _serialize(annot, pno)


def update_annotation(
    session: DocumentSession,
    pno: int,
    xref: int,
    *,
    contents: str | None = None,
    color: str | None = None,
    opacity: float | None = None,
    rect: list[float] | None = None,
) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        annot = _find(page, xref)
        if contents is not None:
            info = annot.info
            info["content"] = contents
            info["modDate"] = _now()
            annot.set_info(info)
        if color is not None:
            annot.set_colors(stroke=hex_to_rgb(color))
        if opacity is not None:
            annot.set_opacity(max(0.05, min(opacity, 1.0)))
        if rect is not None:
            annot.set_rect(fitz.Rect(*rect))
        annot.update()
        session.invalidate_cache()
        return _serialize(annot, pno)


def delete_annotation(session: DocumentSession, pno: int, xref: int) -> dict:
    with session.lock:
        session.checkpoint()
        page = _page(session, pno)
        page.delete_annot(_find(page, xref))
        session.invalidate_cache()
        return {"deleted": True}


def flatten(session: DocumentSession, pages: list[int] | None = None) -> dict:
    """Burn annotation appearances into the page content, then drop them."""
    with session.lock:
        session.checkpoint()
        targets = pages if pages is not None else list(range(session.doc.page_count))
        count = 0
        for pno in targets:
            page = _page(session, pno)
            for annot in list(page.annots() or []):
                try:
                    page.apply_redactions  # noqa: B018 - presence check only
                    annot.update()
                    count += 1
                except Exception:
                    continue
        # PyMuPDF bakes appearance streams during a full save/reload cycle.
        data = session.doc.convert_to_pdf()
        session.doc.close()
        session.doc = fitz.open(stream=data, filetype="pdf")
        session.invalidate_cache()
        return {"flattened": count}


def _find(page: fitz.Page, xref: int) -> fitz.Annot:
    for annot in page.annots() or []:
        if annot.xref == xref:
            return annot
    raise DocumentError("That annotation no longer exists.")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
