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
import pymupdf.mupdf as mupdf

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
# Style words stripped from a family name to find its siblings (Inter-Bold -> inter).
_STYLE_WORDS_RE = re.compile(
    r"[-_, ]?(bold|black|heavy|semibold|demibold|medium|light|regular|book|roman|"
    r"italic|oblique|mt|ps|bd|it)\b",
    re.I,
)
# Marks a face renamed because another font already had its name (see ``add``).
_DUPLICATE_RE = re.compile(r"#\d+$")
_FONT_MEDIA = {"ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2"}


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


def family_stem(basefont: str) -> str:
    """The family without its style suffixes: ``ABCDEF+Arial-BoldMT`` -> ``arial``."""
    name = _DUPLICATE_RE.sub("", strip_subset_tag(basefont))
    previous = None
    while previous != name:
        previous = name
        name = _STYLE_WORDS_RE.sub("", name)
    return re.sub(r"[^a-z0-9]+", "", name.lower())


class FontLibrary:
    """All re-usable font programs found in one document."""

    def __init__(self) -> None:
        self.archive = fitz.Archive()
        self.records: dict[int, FontRecord] = {}       # xref -> record
        self.by_family: dict[str, FontRecord] = {}     # css_name -> record
        self._css_blocks: list[str] = []
        self._buffers: dict[str, tuple[bytes, str]] = {}   # css_name -> (program, ext)
        self._faces: dict[str, fitz.Font | None] = {}
        self._drawable: dict[str, frozenset[int]] = {}

    @property
    def css(self) -> str:
        return "\n".join(self._css_blocks)

    def record_for(self, basefont: str) -> FontRecord | None:
        return self.by_family.get(css_family_for(basefont))

    def font_file(self, css_name: str) -> tuple[bytes, str] | None:
        """The embedded font program and its media type, for the browser preview."""
        entry = self._buffers.get(css_name)
        if entry is None:
            return None
        buffer, ext = entry
        return buffer, _FONT_MEDIA.get(ext, "application/octet-stream")

    def _face(self, css_name: str) -> fitz.Font | None:
        if css_name not in self._faces:
            entry = self._buffers.get(css_name)
            try:
                self._faces[css_name] = fitz.Font(fontbuffer=entry[0]) if entry else None
            except Exception:
                self._faces[css_name] = None
        return self._faces[css_name]

    def drawable(self, css_name: str) -> frozenset[int] | None:
        """Code points the face really draws, plus the spaces it maps.

        A subset font often keeps its whole character map but strips the
        outlines of glyphs the document never used, so "x" can map to a glyph
        that draws nothing. Asking the map alone would say "x" is there; the
        outline is the truth. ``None`` when the face cannot be read.
        """
        if css_name not in self._drawable:
            face = self._face(css_name)
            if face is None:
                return None
            self._drawable[css_name] = frozenset(
                cp for cp in face.valid_codepoints() if chr(cp).isspace() or _has_outline(face, cp)
            )
        return self._drawable[css_name]

    def unicode_range(self, css_name: str) -> str | None:
        """The drawable code points as a CSS ``unicode-range`` value."""
        points = self.drawable(css_name)
        if not points:
            return None
        ranges: list[list[int]] = []
        for cp in sorted(points):
            if ranges and cp == ranges[-1][1] + 1:
                ranges[-1][1] = cp
            else:
                ranges.append([cp, cp])
        return ",".join("U+{0:X}".format(a) if a == b else "U+{0:X}-{1:X}".format(a, b) for a, b in ranges)

    def space_advance(self, basefont: str) -> float:
        """Width of the space glyph in em, from the embedded font when possible."""
        record = self.record_for(basefont)
        face = self._face(record.css_name) if record and record.embeddable else None
        if face is not None and face.has_glyph(32):
            width = face.text_length(" ", fontsize=1)
            if width > 0.05:
                return width
        return 0.278   # Helvetica, the layout engine's sans-serif fallback

    def missing_glyphs(self, basefont: str, text: str) -> set[str]:
        """Characters of ``text`` the embedded (usually subset) font cannot draw.

        The HTML writer silently substitutes a fallback face for these, so the
        caller can warn the user the way Acrobat does.
        """
        record = self.record_for(basefont)
        if record is None or not record.embeddable:
            return set()
        points = self.drawable(record.css_name)
        if points is None:
            return set()
        return {ch for ch in set(text) if not ch.isspace() and ord(ch) not in points}

    def sibling_with(self, basefont: str, char: str) -> str | None:
        """Another embedded face of the same family and style that can draw ``char``.

        A subset keeps only the glyphs the document used, so "(" may be missing
        from one subset of Inter Bold while another has it -- a far closer
        match than a generic fallback font. A face of another weight is not:
        a regular "+" inside bold text looks thin and out of place.
        """
        stem = family_stem(basefont)
        own = self.record_for(basefont)
        for record in self.by_family.values():
            if own is not None and (record.bold, record.italic) != (own.bold, own.italic):
                continue
            if record.embeddable and family_stem(record.basefont) == stem and record.css_name != css_family_for(basefont):
                points = self.drawable(record.css_name)
                if points is not None and ord(char) in points:
                    return record.basefont
        return None

    def variant(self, basefont: str, *, bold: bool, italic: bool) -> str:
        """The document font of the same family with the requested style.

        Turning a run bold should switch Inter to Inter-Bold rather than ask the
        layout engine to smear the regular face. Falls back to ``basefont``.
        """
        stem = family_stem(basefont)
        current = self.record_for(basefont)
        if current and current.bold == bold and current.italic == italic:
            return basefont
        candidates = [
            record for record in self.by_family.values()
            if record.embeddable and record.bold == bold and record.italic == italic
            and family_stem(record.basefont) == stem
        ]
        if not candidates:
            return basefont
        # Several subsets of one face: the one that draws the most characters.
        best = max(candidates, key=lambda record: len(self.drawable(record.css_name) or ()))
        return best.basefont

    def generic_family(self, basefont: str) -> str:
        """The CSS generic family closest to ``basefont``."""
        record = self.record_for(basefont)
        if record and record.mono:
            return "monospace"
        if (record and record.serif) or looks_serif(basefont):
            return "serif"
        return "sans-serif"

    def font_stack(self, basefont: str) -> str:
        """A CSS ``font-family`` stack: embedded face first, then a fallback."""
        record = self.record_for(basefont)
        generic = self.generic_family(basefont)
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

        taken = self.by_family.get(css_name)
        if ext in _EMBEDDABLE_EXT:
            try:
                _name, real_ext, _ftype, buffer = doc.extract_font(xref)
                if buffer and len(buffer) > 64:
                    # The program knows its own style even when the name does
                    # not ("Inter" for both Inter Regular and Inter Bold).
                    try:
                        program = fitz.Font(fontbuffer=buffer)
                        bold, italic = bold or bool(program.is_bold), italic or bool(program.is_italic)
                    except Exception:
                        pass
                    if taken is not None and taken.embeddable:
                        # Another font already has this name (pypdf names every
                        # face of a family the same): give this one its own.
                        basefont = self._distinct_name(family, bold, italic, xref)
                        family = strip_subset_tag(basefont)
                        css_name = css_family_for(basefont)
                        taken = None
                    filename = "{0}.{1}".format(css_name, real_ext or ext)
                    self.archive.add(buffer, filename)
                    self._buffers[css_name] = (buffer, (real_ext or ext).lower())
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
        # Keep the first embedded record for a given name.
        if taken is None or (embeddable and not taken.embeddable):
            self.by_family[css_name] = record

    def _distinct_name(self, family: str, bold: bool, italic: bool, xref: int) -> str:
        style = ("Bold" if bold else "") + ("Italic" if italic else "") or "Regular"
        name = "{0}-{1}".format(family, style)
        if css_family_for(name) in self.by_family:
            name = "{0}#{1}".format(name, xref)
        return name


def _has_outline(face: fitz.Font, cp: int) -> bool:
    gid = face.has_glyph(cp)
    if not gid:
        return False
    try:
        path = mupdf.fz_outline_glyph(face.this, gid, mupdf.FzMatrix())
    except Exception:
        return True   # no outline to inspect (bitmap glyphs): trust the map
    if not path.m_internal:
        return False
    bounds = mupdf.fz_bound_path(path, mupdf.FzStrokeState(), mupdf.FzMatrix())
    return not mupdf.fz_is_empty_rect(bounds)


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
