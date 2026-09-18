"""True redaction: content is removed from the file, not covered up.

A black rectangle drawn over text is not redaction -- the glyphs remain in the
content stream and any text extractor recovers them. Here, redaction marks are
staged as ``/Redact`` annotations and then *applied*, which rewrites the page's
content stream with the covered glyphs, image regions and vector art deleted.
After ``apply``, the removed bytes are gone from the document.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

import fitz

from app.core.session import DocumentError, DocumentSession
from app.services.text import build_index, hex_to_rgb, search

# --------------------------------------------------------------------------- #
# Built-in detectors for sensitive data
# --------------------------------------------------------------------------- #
PATTERNS: dict[str, dict] = {
    "email": {
        "label": "Email addresses",
        "regex": r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
    },
    "phone": {
        "label": "Phone numbers",
        "regex": r"(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}(?:[\s.\-]?\d{2,4})?",
    },
    "ssn": {
        "label": "US Social Security numbers",
        "regex": r"\b(?!000|666|9\d\d)\d{3}[\s\-]?(?!00)\d{2}[\s\-]?(?!0000)\d{4}\b",
    },
    "credit_card": {
        "label": "Payment card numbers",
        "regex": r"\b(?:\d[ \-]?){13,19}\b",
        "validator": "luhn",
    },
    "iban": {
        "label": "IBAN account numbers",
        "regex": r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b",
    },
    "ip": {
        "label": "IP addresses",
        "regex": r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b",
    },
    "date_of_birth": {
        "label": "Dates",
        "regex": r"\b(?:0?[1-9]|[12]\d|3[01])[/.\-](?:0?[1-9]|1[0-2])[/.\-](?:19|20)\d{2}\b",
    },
    "aadhaar": {
        "label": "Aadhaar numbers",
        "regex": r"\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b",
    },
}


def _luhn(value: str) -> bool:
    digits = [int(c) for c in value if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    checksum = 0
    for i, digit in enumerate(reversed(digits)):
        if i % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        checksum += digit
    return checksum % 10 == 0


_VALIDATORS = {"luhn": _luhn}


@dataclass
class Mark:
    page: int
    rect: fitz.Rect
    text: str = ""
    source: str = "manual"


def _page(session: DocumentSession, pno: int) -> fitz.Page:
    if pno < 0 or pno >= session.doc.page_count:
        raise DocumentError("Page {0} is out of range.".format(pno + 1))
    return session.doc[pno]


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #
def detect(
    session: DocumentSession,
    kinds: Sequence[str],
    *,
    pages: Sequence[int] | None = None,
    custom_patterns: Sequence[str] = (),
) -> list[dict]:
    """Scan for sensitive strings and return candidate redaction rectangles."""
    unknown = [k for k in kinds if k not in PATTERNS]
    if unknown:
        raise DocumentError("Unknown detector '{0}'.".format(unknown[0]))

    findings: list[dict] = []
    seen: set[tuple] = set()

    def collect(regex: str, kind: str, label: str, validator: str | None = None):
        hits = search(session, regex, regex=True, case=False, pages=pages)
        check = _VALIDATORS.get(validator or "")
        for hit in hits:
            if check and not check(hit["text"]):
                continue
            key = (hit["page"], hit["start"], hit["end"])
            if key in seen:
                continue
            seen.add(key)
            findings.append(
                {
                    "id": "r{0}-{1}-{2}".format(hit["page"], hit["start"], kind),
                    "kind": kind,
                    "label": label,
                    "page": hit["page"],
                    "text": hit["text"],
                    "rects": hit["rects"],
                    "context": hit["context"],
                }
            )

    for kind in kinds:
        spec = PATTERNS[kind]
        collect(spec["regex"], kind, spec["label"], spec.get("validator"))

    for i, pattern in enumerate(custom_patterns):
        collect(pattern, "custom", "Custom pattern {0}".format(i + 1))

    findings.sort(key=lambda f: (f["page"], f["rects"][0][1] if f["rects"] else 0))
    return findings


def find_text(
    session: DocumentSession,
    query: str,
    *,
    regex: bool = False,
    case: bool = False,
    whole_word: bool = False,
    pages: Sequence[int] | None = None,
) -> list[dict]:
    """Search-and-redact: locate every occurrence of a phrase."""
    hits = search(
        session, query, regex=regex, case=case, whole_word=whole_word, pages=pages
    )
    return [
        {
            "id": hit["id"],
            "kind": "search",
            "label": "Search match",
            "page": hit["page"],
            "text": hit["text"],
            "rects": hit["rects"],
            "context": hit["context"],
        }
        for hit in hits
    ]


# --------------------------------------------------------------------------- #
# Marking and applying
# --------------------------------------------------------------------------- #
def mark(
    session: DocumentSession,
    marks: Sequence[dict],
    *,
    fill: str | None = "#000000",
    overlay_text: str = "",
    text_color: str = "#ffffff",
    font_size: float = 8.0,
) -> dict:
    """Stage redaction annotations. Nothing is destroyed until ``apply``."""
    if not marks:
        raise DocumentError("Nothing was marked for redaction.")
    with session.lock:
        session.checkpoint()
        staged = 0
        for item in marks:
            pno = int(item.get("page", 0))
            page = _page(session, pno)
            for rect in item.get("rects", [item.get("rect")]):
                if not rect:
                    continue
                area = fitz.Rect(*rect)
                if area.is_empty:
                    continue
                page.add_redact_annot(
                    area,
                    text=overlay_text or None,
                    fontsize=font_size,
                    text_color=hex_to_rgb(text_color, (1, 1, 1)),
                    fill=hex_to_rgb(fill) if fill else None,
                    cross_out=False,
                )
                staged += 1
        session.invalidate_cache()
        return {"marked": staged}


def list_marks(session: DocumentSession, pno: int | None = None) -> list[dict]:
    pages = [pno] if pno is not None else range(session.doc.page_count)
    out = []
    for index in pages:
        page = _page(session, index)
        for annot in page.annots(types=[fitz.PDF_ANNOT_REDACT]) or []:
            rect = annot.rect
            out.append(
                {
                    "id": "p{0}a{1}".format(index, annot.xref),
                    "xref": annot.xref,
                    "page": index,
                    "rect": [rect.x0, rect.y0, rect.x1, rect.y1],
                }
            )
    return out


def clear_marks(session: DocumentSession, pages: Sequence[int] | None = None) -> dict:
    with session.lock:
        session.checkpoint()
        targets = pages if pages is not None else range(session.doc.page_count)
        removed = 0
        for pno in targets:
            page = _page(session, pno)
            for annot in list(page.annots(types=[fitz.PDF_ANNOT_REDACT]) or []):
                page.delete_annot(annot)
                removed += 1
        session.invalidate_cache()
        return {"cleared": removed}


def apply(
    session: DocumentSession,
    *,
    pages: Sequence[int] | None = None,
    remove_images: bool = True,
    remove_vectors: bool = True,
    scrub_metadata: bool = True,
) -> dict:
    """Destroy the marked content permanently.

    ``remove_images`` and ``remove_vectors`` control whether picture data and
    line art intersecting a mark are deleted too. Text under a mark is always
    deleted -- that is the whole point.
    """
    with session.lock:
        session.checkpoint()
        targets = list(pages) if pages is not None else list(range(session.doc.page_count))
        applied = 0
        for pno in targets:
            page = _page(session, pno)
            pending = list(page.annots(types=[fitz.PDF_ANNOT_REDACT]) or [])
            if not pending:
                continue
            applied += len(pending)
            page.apply_redactions(
                images=(
                    getattr(fitz, "PDF_REDACT_IMAGE_REMOVE", 2)
                    if remove_images
                    else getattr(fitz, "PDF_REDACT_IMAGE_NONE", 0)
                ),
                graphics=(
                    getattr(fitz, "PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED", 2)
                    if remove_vectors
                    else getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0)
                ),
                text=getattr(fitz, "PDF_REDACT_TEXT_REMOVE", 0),
            )

        if scrub_metadata:
            _scrub(session)

        # Rewrite the file with full garbage collection so the old, now
        # unreferenced content streams are physically dropped.
        data = session.doc.tobytes(garbage=4, deflate=True, clean=True)
        session.doc.close()
        session.doc = fitz.open(stream=data, filetype="pdf")
        session.invalidate_cache()
        return {"applied": applied, "permanent": True}


def redact_area(session: DocumentSession, pno: int, rect: list[float], **kwargs) -> dict:
    """Mark and immediately apply a single rectangular area."""
    mark(session, [{"page": pno, "rects": [rect]}], **kwargs)
    return apply(session, pages=[pno])


def _scrub(session: DocumentSession) -> None:
    """Clear metadata and XMP that could leak the removed content."""
    try:
        session.doc.set_metadata({})
    except Exception:
        pass
    try:
        session.doc.del_xml_metadata()
    except Exception:
        pass


def verify(session: DocumentSession, needles: Sequence[str]) -> dict:
    """Confirm that redacted strings are truly absent from the file."""
    remaining: list[dict] = []
    for pno in range(session.doc.page_count):
        index = build_index(session, pno)
        haystack = index.text.lower()
        for needle in needles:
            if needle and needle.lower() in haystack:
                remaining.append({"page": pno, "text": needle})
    return {"clean": not remaining, "remaining": remaining}
