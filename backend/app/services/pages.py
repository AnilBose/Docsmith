"""Page-level operations.

Every one of these is structural: pages are copied between documents by object
reference, never re-rendered, so page content is byte-identical after a
reorder, split, merge or extraction.
"""
from __future__ import annotations

import re
from typing import Iterable, Sequence

import fitz

from app.core.session import DocumentError, DocumentSession, store
from app.services import fonts as fontsvc
from app.services.text import TextStyle, draw_text

_ROMAN = [
    (1000, "m"), (900, "cm"), (500, "d"), (400, "cd"),
    (100, "c"), (90, "xc"), (50, "l"), (40, "xl"),
    (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i"),
]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def parse_page_spec(spec: str, page_count: int) -> list[int]:
    """Parse ``"1-3,7,10-"`` into zero-based page indices, order preserved."""
    if not spec or spec.strip().lower() in {"all", "*"}:
        return list(range(page_count))

    pages: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        match = re.fullmatch(r"(\d*)\s*-\s*(\d*)", chunk)
        if match:
            start = int(match.group(1)) if match.group(1) else 1
            end = int(match.group(2)) if match.group(2) else page_count
            if start > end:
                start, end = end, start
            pages.extend(range(start - 1, end))
        elif chunk.isdigit():
            pages.append(int(chunk) - 1)
        else:
            raise DocumentError("Could not read the page range '{0}'.".format(chunk))

    valid = [p for p in pages if 0 <= p < page_count]
    if not valid:
        raise DocumentError("That page range selects no pages.")
    return valid


def _validate(pages: Sequence[int], count: int) -> list[int]:
    bad = [p for p in pages if p < 0 or p >= count]
    if bad:
        raise DocumentError("Page {0} is out of range.".format(bad[0] + 1))
    return list(pages)


def describe(session: DocumentSession) -> list[dict]:
    out = []
    for pno in range(session.doc.page_count):
        page = session.doc[pno]
        rect = page.rect
        out.append(
            {
                "index": pno,
                "number": pno + 1,
                "width": rect.width,
                "height": rect.height,
                "rotation": page.rotation,
                "label": _page_label(session.doc, pno),
            }
        )
    return out


def _page_label(doc: fitz.Document, pno: int) -> str:
    try:
        label = doc[pno].get_label()
        return label or str(pno + 1)
    except Exception:
        return str(pno + 1)


# --------------------------------------------------------------------------- #
# Structural operations
# --------------------------------------------------------------------------- #
def add_blank(
    session: DocumentSession,
    at: int | None = None,
    *,
    width: float | None = None,
    height: float | None = None,
    copy_size_from: int | None = None,
) -> dict:
    with session.lock:
        session.checkpoint()
        doc = session.doc
        if width is None or height is None:
            reference = copy_size_from if copy_size_from is not None else max(at or 0, 0)
            if doc.page_count:
                ref_rect = doc[min(max(reference, 0), doc.page_count - 1)].rect
                width, height = ref_rect.width, ref_rect.height
            else:
                width, height = 595.0, 842.0      # A4
        position = doc.page_count if at is None else max(0, min(at, doc.page_count))
        doc.new_page(pno=position, width=width, height=height)
        session.invalidate_cache()
        return {"inserted": position, "pageCount": doc.page_count}


def delete_pages(session: DocumentSession, pages: Sequence[int]) -> dict:
    with session.lock:
        doc = session.doc
        targets = sorted(set(_validate(pages, doc.page_count)), reverse=True)
        if len(targets) >= doc.page_count:
            raise DocumentError("A PDF must keep at least one page.")
        session.checkpoint()
        for pno in targets:
            doc.delete_page(pno)
        session.invalidate_cache()
        return {"deleted": len(targets), "pageCount": doc.page_count}


def duplicate_pages(session: DocumentSession, pages: Sequence[int]) -> dict:
    with session.lock:
        doc = session.doc
        targets = _validate(pages, doc.page_count)
        session.checkpoint()
        # Insert each copy right after its source, back to front.
        for pno in sorted(set(targets), reverse=True):
            doc.fullcopy_page(pno, to=pno + 1)
        session.invalidate_cache()
        return {"duplicated": len(set(targets)), "pageCount": doc.page_count}


def reorder(session: DocumentSession, order: Sequence[int]) -> dict:
    with session.lock:
        doc = session.doc
        target = _validate(order, doc.page_count)
        if sorted(target) != list(range(doc.page_count)):
            raise DocumentError(
                "A reorder must list every page exactly once "
                "({0} expected, {1} given).".format(doc.page_count, len(target))
            )
        session.checkpoint()
        doc.select(list(target))
        session.invalidate_cache()
        return {"pageCount": doc.page_count}


def move_page(session: DocumentSession, source: int, destination: int) -> dict:
    with session.lock:
        doc = session.doc
        _validate([source], doc.page_count)
        destination = max(0, min(destination, doc.page_count - 1))
        session.checkpoint()
        doc.move_page(source, destination + 1 if destination > source else destination)
        session.invalidate_cache()
        return {"pageCount": doc.page_count}


def rotate_pages(session: DocumentSession, pages: Sequence[int], angle: int, *, absolute=False) -> dict:
    if angle % 90 != 0:
        raise DocumentError("Rotation must be a multiple of 90 degrees.")
    with session.lock:
        doc = session.doc
        targets = _validate(pages, doc.page_count)
        session.checkpoint()
        for pno in targets:
            page = doc[pno]
            page.set_rotation(angle % 360 if absolute else (page.rotation + angle) % 360)
        session.invalidate_cache()
        return {"rotated": len(targets)}


def extract_pages(session: DocumentSession, pages: Sequence[int], filename: str | None = None) -> DocumentSession:
    doc = session.doc
    targets = _validate(pages, doc.page_count)
    new = fitz.open()
    for pno in targets:
        new.insert_pdf(doc, from_page=pno, to_page=pno, annots=True, links=True)
    name = filename or "{0}-pages.pdf".format(session.filename.rsplit(".", 1)[0])
    return store.adopt(new, name)


def insert_from(
    session: DocumentSession,
    source: DocumentSession,
    *,
    at: int | None = None,
    pages: Sequence[int] | None = None,
) -> dict:
    with session.lock:
        doc = session.doc
        src = source.doc
        targets = _validate(pages, src.page_count) if pages is not None else list(range(src.page_count))
        position = doc.page_count if at is None else max(0, min(at, doc.page_count))
        session.checkpoint()
        # insert_pdf only takes contiguous ranges, so walk the selection.
        offset = 0
        for pno in targets:
            doc.insert_pdf(
                src, from_page=pno, to_page=pno, start_at=position + offset,
                annots=True, links=True,
            )
            offset += 1
        session.invalidate_cache()
        return {"inserted": offset, "pageCount": doc.page_count}


def replace_pages(
    session: DocumentSession,
    source: DocumentSession,
    *,
    targets: Sequence[int],
    source_pages: Sequence[int] | None = None,
) -> dict:
    with session.lock:
        doc = session.doc
        victims = sorted(set(_validate(targets, doc.page_count)))
        src_pages = (
            _validate(source_pages, source.doc.page_count)
            if source_pages is not None
            else list(range(source.doc.page_count))
        )
        if not src_pages:
            raise DocumentError("The replacement document has no pages to use.")
        session.checkpoint()

        insert_at = victims[0]
        for pno in reversed(victims):
            doc.delete_page(pno)
        offset = 0
        for pno in src_pages:
            doc.insert_pdf(
                source.doc, from_page=pno, to_page=pno, start_at=insert_at + offset,
                annots=True, links=True,
            )
            offset += 1
        session.invalidate_cache()
        return {"replaced": len(victims), "inserted": offset, "pageCount": doc.page_count}


def split(session: DocumentSession, *, every: int | None = None, at: Sequence[int] | None = None) -> list[DocumentSession]:
    """Split into parts, either every N pages or at explicit break points."""
    doc = session.doc
    count = doc.page_count
    if every is not None:
        if every < 1:
            raise DocumentError("Split size must be at least 1 page.")
        ranges = [(s, min(s + every, count) - 1) for s in range(0, count, every)]
    elif at:
        breaks = sorted({b for b in at if 0 < b < count})
        bounds = [0, *breaks, count]
        ranges = [(bounds[i], bounds[i + 1] - 1) for i in range(len(bounds) - 1)]
    else:
        raise DocumentError("Specify either a split size or split points.")

    stem = session.filename.rsplit(".", 1)[0]
    parts: list[DocumentSession] = []
    for i, (start, end) in enumerate(ranges, start=1):
        if start > end:
            continue
        new = fitz.open()
        new.insert_pdf(doc, from_page=start, to_page=end, annots=True, links=True)
        parts.append(store.adopt(new, "{0}-part{1}.pdf".format(stem, i)))
    return parts


def merge(sessions: Sequence[DocumentSession], filename: str = "merged.pdf") -> DocumentSession:
    if not sessions:
        raise DocumentError("Select at least one document to merge.")
    new = fitz.open()
    for item in sessions:
        new.insert_pdf(item.doc, annots=True, links=True)
    return store.adopt(new, filename)


def move_between(
    source: DocumentSession,
    target: DocumentSession,
    pages: Sequence[int],
    *,
    at: int | None = None,
) -> dict:
    """Cut pages out of one open document and paste them into another."""
    if source.doc_id == target.doc_id:
        raise DocumentError("Use reorder to move pages inside one document.")
    targets = _validate(pages, source.doc.page_count)
    if len(set(targets)) >= source.doc.page_count:
        raise DocumentError("The source document must keep at least one page.")

    with source.lock, target.lock:
        source.checkpoint()
        target.checkpoint()
        position = target.doc.page_count if at is None else max(0, min(at, target.doc.page_count))
        offset = 0
        for pno in targets:
            target.doc.insert_pdf(
                source.doc, from_page=pno, to_page=pno, start_at=position + offset,
                annots=True, links=True,
            )
            offset += 1
        for pno in sorted(set(targets), reverse=True):
            source.doc.delete_page(pno)
        source.invalidate_cache()
        target.invalidate_cache()
        return {
            "moved": offset,
            "sourcePageCount": source.doc.page_count,
            "targetPageCount": target.doc.page_count,
        }


# --------------------------------------------------------------------------- #
# Cover / end pages and numbering
# --------------------------------------------------------------------------- #
def add_cover(session: DocumentSession, *, title: str = "", subtitle: str = "", at_end: bool = False) -> dict:
    with session.lock:
        session.checkpoint()
        doc = session.doc
        rect = doc[0].rect if doc.page_count else fitz.Rect(0, 0, 595, 842)
        position = doc.page_count if at_end else 0
        page = doc.new_page(pno=position, width=rect.width, height=rect.height)
        library = fontsvc.build_library(session)

        if title:
            draw_text(
                page,
                fitz.Rect(rect.width * 0.1, rect.height * 0.35, rect.width * 0.9, rect.height * 0.55),
                title,
                TextStyle(size=30, align="center", bold=True),
                library,
            )
        if subtitle:
            draw_text(
                page,
                fitz.Rect(rect.width * 0.1, rect.height * 0.56, rect.width * 0.9, rect.height * 0.70),
                subtitle,
                TextStyle(size=14, align="center", color="#444444"),
                library,
            )
        session.invalidate_cache()
        return {"inserted": position, "pageCount": doc.page_count}


def _roman(number: int) -> str:
    out = []
    for value, glyph in _ROMAN:
        while number >= value:
            out.append(glyph)
            number -= value
    return "".join(out)


def _format_number(index: int, style: str) -> str:
    if style == "roman":
        return _roman(index)
    if style == "ROMAN":
        return _roman(index).upper()
    if style == "alpha":
        out, n = "", index
        while n > 0:
            n, rem = divmod(n - 1, 26)
            out = chr(97 + rem) + out
        return out
    if style == "ALPHA":
        return _format_number(index, "alpha").upper()
    return str(index)


def add_page_numbers(
    session: DocumentSession,
    *,
    pages: Sequence[int] | None = None,
    position: str = "bottom-center",
    template: str = "{n}",
    start_at: int = 1,
    style: str = "arabic",
    font_size: float = 10.0,
    color: str = "#000000",
    margin: float = 28.0,
    skip_first: bool = False,
) -> dict:
    with session.lock:
        session.checkpoint()
        doc = session.doc
        targets = list(pages) if pages is not None else list(range(doc.page_count))
        if skip_first and targets and targets[0] == 0:
            targets = targets[1:]
        library = fontsvc.build_library(session)
        total = len(targets)

        vertical, _, horizontal = position.partition("-")
        align = {"left": "left", "center": "center", "right": "right"}.get(horizontal, "center")

        for ordinal, pno in enumerate(targets):
            page = doc[pno]
            rect = page.rect
            label = template.replace("{n}", _format_number(start_at + ordinal, style))
            label = label.replace("{total}", _format_number(total, style))
            label = label.replace("{page}", str(pno + 1))

            box_height = font_size * 2.0
            if vertical == "top":
                box = fitz.Rect(margin, margin - font_size * 0.4, rect.width - margin, margin + box_height)
            else:
                box = fitz.Rect(
                    margin, rect.height - margin - box_height, rect.width - margin, rect.height - margin + font_size * 0.4
                )
            draw_text(
                page,
                box,
                label,
                TextStyle(size=font_size, align=align, color=color),
                library,
                grow=False,
            )
        session.invalidate_cache()
        return {"numbered": len(targets)}
