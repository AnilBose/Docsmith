"""Embedded-font recovery.

When the user retypes a run of text we want the replacement glyphs to come from
*the very font the document already embeds*, not from a lookalike. This module
pulls every embeddable font program out of the PDF, stages it in a PyMuPDF
``Archive``, and emits the ``@font-face`` CSS that the HTML text writer needs.

Fonts that cannot be re-embedded (bitmap Type3, bare CFF, "n/a" subsets) fall
back to a metric-compatible base-14 face chosen from the font name itself.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import fitz

from app.core.session import DocumentSession

# Font programs the Story/HTML writer can consume directly.
_EMBEDDABLE_EXT = {"ttf", "otf", "woff", "woff2"}

# Base-14 fallbacks, matched on the family part of the BaseFont name.
_BASE14 = [
    (re.compile(r"times|tinos|liberation ?serif|nimbus ?roman|georgia|garamond|book", re.I), "times"),
    (re.compile(r"courier|mono|consolas|menlo", re.I), "courier"),
    (re.compile(r"symbol", re.I), "symbol"),
    (re.compile(r"zapf|dingbat", re.I), "zadb"),
]
_DEFAULT_BASE14 = "helv"

# PyMuPDF span flag bits.
FLAG_SUPERSCRIPT = 1 << 0
FLAG_ITALIC = 1 << 1
FLAG_SERIF = 1 << 2
FLAG_MONO = 1 << 3
FLAG_BOLD = 1 << 4

_SERIF_RE = re.compile(
    r"times|serif|roman|georgia|garamond|book|minion|cambria|palatino", re.I
)
_MONO_RE = re.compile(r"mono|courier|consol", re.I)
_BOLD_RE = re.compile(r"bold|black|heavy|semibold|demibold|[-_,]bd\b|900|800|700", re.I)
_ITALIC_RE = re.compile(r"italic|oblique|[-_,]it\b", re.I)


@dataclass(frozen=True)
class FontRecord:
    xref: int
    basefont: str      # raw BaseFont, e.g. "ABCDEF+Arial-BoldMT"
    family: str        # subset tag stripped, e.g. "Arial-BoldMT"
    ext: str
    css_name: str      # the family name we expose to CSS
    embeddable: bool
    bold: bool
    italic: bool
    serif: bool
    mono: bool


def strip_subset_tag(basefont: str) -> str:
    """``ABCDEF+Arial-BoldMT`` becomes ``Arial-BoldMT``."""
    if len(basefont) > 7 and basefont[6] == "+" and basefont[:6].isalpha():
        return basefont[7:]
    return basefont


def css_family_for(basefont: str) -> str:
    """A stable, CSS-safe identifier derived from the font name."""
    name = strip_subset_tag(basefont) or "Font"
    return "pdfe-" + re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()


def base14_for(basefont: str, *, bold: bool, italic: bool) -> str:
    """Map an un-embeddable font onto a base-14 PDF font code."""
    family = strip_subset_tag(basefont)
    stem = _DEFAULT_BASE14
    for pattern, code in _BASE14:
        if pattern.search(family):
            stem = code
            break
    if stem in {"symbol", "zadb"}:
        return stem
    suffix = ("b" if bold else "") + ("i" if italic else "")
    return stem + suffix if suffix else stem


def guess_style(basefont: str, flags: int = 0) -> tuple[bool, bool]:
    """Return ``(bold, italic)`` from the font name plus PyMuPDF flag bits."""
    name = strip_subset_tag(basefont)
    bold = bool(flags & FLAG_BOLD) or bool(_BOLD_RE.search(name))
    italic = bool(flags & FLAG_ITALIC) or bool(_ITALIC_RE.search(name))
    return bold, italic


def looks_serif(basefont: str) -> bool:
    return bool(_SERIF_RE.search(strip_subset_tag(basefont)))


class FontLibrary:
    """All re-usable font programs found in one document."""

    def __init__(self) -> None:
        self.archive = fitz.Archive()
        self.records: dict[int, FontRecord] = {}       # xref -> record
        self.by_family: dict[str, FontRecord] = {}     # css_name -> record
        self._css_blocks: list[str] = []

    @property
    def css(self) -> str:
        return "\n".join(self._css_blocks)

    def record_for(self, basefont: str) -> FontRecord | None:
        return self.by_family.get(css_family_for(basefont))

    def font_stack(self, basefont: str) -> str:
        """A CSS ``font-family`` stack: embedded face first, then a fallback."""
        record = self.record_for(basefont)
        if record and record.mono:
            generic = "monospace"
        elif (record and record.serif) or looks_serif(basefont):
            generic = "serif"
        else:
            generic = "sans-serif"
        if record and record.embeddable:
            return '"{0}", {1}'.format(record.css_name, generic)
        return generic

    # ------------------------------------------------------------------ build
    def add(self, doc: fitz.Document, xref: int, info: tuple) -> None:
        if xref in self.records:
            return
        basefont = info[3] or "Font"
        ext = (info[1] or "n/a").lower()
        family = strip_subset_tag(basefont)
        bold, italic = guess_style(basefont)
        css_name = css_family_for(basefont)
        embeddable = False

        if ext in _EMBEDDABLE_EXT and css_name not in self.by_family:
            try:
                _name, real_ext, _ftype, buffer = doc.extract_font(xref)
                if buffer and len(buffer) > 64:
                    filename = "{0}.{1}".format(css_name, real_ext or ext)
                    self.archive.add(buffer, filename)
                    self._css_blocks.append(
                        '@font-face {{ font-family: "{0}"; src: url("{1}"); }}'.format(
                            css_name, filename
                        )
                    )
                    embeddable = True
            except Exception:
                embeddable = False

        record = FontRecord(
            xref=xref,
            basefont=basefont,
            family=family,
            ext=ext,
            css_name=css_name,
            embeddable=embeddable,
            bold=bold,
            italic=italic,
            serif=looks_serif(basefont),
            mono=bool(_MONO_RE.search(family)),
        )
        self.records[xref] = record
        # Keep the first (usually the embedded) record for a given family.
        self.by_family.setdefault(css_name, record)


def build_library(session: DocumentSession) -> FontLibrary:
    """Build (and memoise) the font library for a document."""
    cached = session.cache.get("font_library")
    if isinstance(cached, FontLibrary):
        return cached

    library = FontLibrary()
    doc = session.doc
    for pno in range(doc.page_count):
        try:
            for info in doc.get_page_fonts(pno, full=True):
                library.add(doc, info[0], info)
        except Exception:
            continue
    session.cache["font_library"] = library
    return library


_STANDARD_FAMILIES = (
    ("Helvetica", "helvetica", False, False),
    ("Times New Roman", "times-new-roman", True, False),
    ("Courier", "courier", False, True),
    ("Arial", "arial", False, False),
    ("Georgia", "georgia", True, False),
    ("Verdana", "verdana", False, False),
)


def available_families(session: DocumentSession) -> list[dict]:
    """Font list for the UI picker: document fonts first, then the base-14 set."""
    library = build_library(session)
    seen: set[str] = set()
    families: list[dict] = []
    for record in library.by_family.values():
        if record.family in seen:
            continue
        seen.add(record.family)
        families.append(
            {
                "id": record.css_name,
                "label": record.family,
                "source": "document",
                "embeddable": record.embeddable,
                "serif": record.serif,
                "mono": record.mono,
            }
        )
    families.sort(key=lambda f: f["label"].lower())

    for label, css_name, serif, mono in _STANDARD_FAMILIES:
        if label not in seen:
            families.append(
                {
                    "id": css_name,
                    "label": label,
                    "source": "standard",
                    "embeddable": True,
                    "serif": serif,
                    "mono": mono,
                }
            )
    return families
