"""Word-style paragraph editing with content reflow across pages.

Editing a paragraph happens in three steps:

1.  **Render.** The new text is laid out with the document's own fonts on a
    scratch page that has the target page's geometry, one paragraph item at a
    time so that list markers repeat for items created with Enter. The first
    baseline is pinned to where the old first baseline was, and the line pitch,
    alignment, indent and right edge come from the original paragraph.
2.  **Slice.** The scratch rendering and everything on the page below the
    paragraph are cut into horizontal strips at whitespace gaps. Whatever sits
    between two gaps -- a line of text, a bullet, a coloured heading band, an
    image -- travels together.
3.  **Flow.** Strips are laid back down top to bottom keeping their original
    spacing. A strip that no longer fits above the bottom margin moves to the
    next page and pushes that page's content down in turn; a new page is added
    after the last one when needed. That is how a word processor paginates.

Strips are drawn with ``show_pdf_page`` from a snapshot of the untouched page,
so moved content keeps its original operators: text stays real text in its
original fonts, vectors stay vectors, images are never re-encoded. Headers,
footers and full-page backgrounds are recognised and left where they are.
"""
from __future__ import annotations

import html
import math
import re
import statistics
from dataclasses import dataclass, field

import fitz

from app.core.session import DocumentError, DocumentSession
from app.services import fonts as fontsvc
from app.services import paragraphs as parasvc
from app.services import text as textsvc

# Anything covering this share of the page is a background, not content.
_BACKGROUND_SHARE = 0.3
# Headers and footers live in the outer 12% of the page, set apart by a gap.
_EDGE_ZONE = 0.12
_EDGE_GAP = 12.0
_PAGE_NUMBER_RE = re.compile(r"^\s*(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?\s*$", re.I)
# Strip clips reach this far into the surrounding whitespace, to keep
# anti-aliased edges and overhanging glyphs.
_PAD = 0.8
_MAX_NEW_PAGES = 50
# A strip this short that hugs what follows it is treated as a heading.
_HEADING_MAX_HEIGHT = 40.0


# --------------------------------------------------------------------------- #
# Page geometry
# --------------------------------------------------------------------------- #
@dataclass
class Element:
    rect: fitz.Rect
    kind: str
    text: str = ""
    baseline: float | None = None
    # What redaction judges the object by: a text line's font box, a path's
    # full outline before clipping.
    extent: fitz.Rect | None = None


@dataclass
class Group:
    top: float
    bottom: float
    elements: list[Element]

    @property
    def text(self) -> str:
        return " ".join(e.text for e in self.elements if e.kind == "text").strip()


@dataclass
class Frame:
    """The flowable body of one page."""

    body: list[Element]
    background_image: bool
    top: float | None
    limit: float


def _image_info(page: fitz.Page) -> list[dict]:
    """Placed images, skipping the scan on pages that have none.

    get_image_info() expands every form XObject separately, and moved content
    is nested forms, so on a page edited several times it slows down
    geometrically. The resource listing (which includes images inside forms)
    is cheap.
    """
    return page.get_image_info() if page.get_images(full=True) else []


def _elements(page: fitz.Page, area: float | None = None) -> tuple[list[Element], bool]:
    """Text lines, images and vector shapes, minus full-page backgrounds.

    ``area`` is the page area backgrounds are judged against; the scratch
    canvas is taller than a real page, so it passes the real page's area.
    """
    area = area or page.rect.width * page.rect.height
    elements: list[Element] = []
    for block in page.get_text("rawdict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            # Visible glyphs only: a space has no ink, and a sized space (used
            # for exact gaps) would otherwise make its line look taller.
            ink = None
            text = ""
            baseline = None
            for span in line["spans"]:
                for char in span["chars"]:
                    text += char["c"]
                    if not char["c"].isspace():
                        box = fitz.Rect(char["bbox"])
                        ink = box if ink is None else ink | box
                        baseline = max(baseline or char["origin"][1], char["origin"][1])
            if ink is not None:
                elements.append(Element(ink, "text", text, baseline, fitz.Rect(line["bbox"]) | ink))

    background_image = False
    for info in _image_info(page):
        rect = fitz.Rect(info["bbox"]) & page.rect
        if rect.is_empty:
            continue
        if rect.width * rect.height >= _BACKGROUND_SHARE * area:
            background_image = True
            continue
        elements.append(Element(rect, "image"))

    # Content moved by an earlier edit is a clipped copy of the whole page, and
    # get_drawings() reports every path in it at full size; only the part
    # inside the active clips is really there.
    clips: list[tuple[int, fitz.Rect | None]] = []
    for path in page.get_drawings(extended=True):
        level = path.get("level", 0)
        clips = [c for c in clips if c[0] < level]
        if path["type"] in ("clip", "group"):
            clips.append((level, fitz.Rect(path["scissor"]) if path["type"] == "clip" else None))
            continue
        half = (path.get("width") or 1.0) / 2
        raw = fitz.Rect(path["rect"])
        rect = fitz.Rect(raw.x0 - half, raw.y0 - half, raw.x1 + half, raw.y1 + half) & page.rect
        if rect.is_empty or rect.width * rect.height >= _BACKGROUND_SHARE * area:
            continue
        outline = fitz.Rect(rect)
        for _level, scissor in clips:
            if scissor is not None:
                rect &= scissor
        if rect.is_empty or rect.width <= 0 or rect.height <= 0:
            continue
        elements.append(Element(rect, "drawing", extent=outline))
    return elements, background_image


def page_elements(page: fitz.Page) -> list[Element]:
    return _elements(page)[0]


def _groups(elements: list[Element]) -> list[Group]:
    """Merge elements whose vertical extents overlap into horizontal bands."""
    groups: list[Group] = []
    for element in sorted(elements, key=lambda e: e.rect.y0):
        if groups and element.rect.y0 < groups[-1].bottom - 0.01:
            group = groups[-1]
            group.bottom = max(group.bottom, element.rect.y1)
            group.elements.append(element)
        else:
            groups.append(Group(element.rect.y0, element.rect.y1, [element]))
    return groups


def _signature(group: Group) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", group.text.lower())).strip()


def _edge(groups: list[Group], height: float, top: bool) -> Group | None:
    if len(groups) < 2:
        return None
    if top:
        group, neighbour = groups[0], groups[1]
        if group.bottom <= height * _EDGE_ZONE and neighbour.top - group.bottom >= _EDGE_GAP:
            return group
    else:
        group, neighbour = groups[-1], groups[-2]
        if group.top >= height * (1 - _EDGE_ZONE) and group.top - neighbour.bottom >= _EDGE_GAP:
            return group
    return None


def _confirmed_edges(per_page: list[list[Group]], heights: list[float], top: bool) -> list[Group | None]:
    """Header/footer bands: page numbers, or bands repeated on most pages."""
    candidates = [_edge(groups, h, top) for groups, h in zip(per_page, heights)]
    confirmed: list[Group | None] = [None] * len(candidates)
    for no, candidate in enumerate(candidates):
        if candidate is None:
            continue
        if _PAGE_NUMBER_RE.match(candidate.text):
            confirmed[no] = candidate
            continue
        if len(candidates) < 2:
            continue
        peers = [
            other
            for other_no, other in enumerate(candidates)
            if other_no != no
            and other is not None
            and abs(other.top - candidate.top) <= 4
            and _signature(other) == _signature(candidate)
        ]
        if len(peers) >= max(1, (len(candidates) - 1) // 2):
            confirmed[no] = candidate
    return confirmed


def frames(doc: fitz.Document) -> list[Frame]:
    """Body content and bottom limit of every page."""
    raw = [_elements(page) for page in doc]
    heights = [page.rect.height for page in doc]
    per_page = [_groups(elements) for elements, _bg in raw]
    headers = _confirmed_edges(per_page, heights, top=True)
    footers = _confirmed_edges(per_page, heights, top=False)

    bodies: list[list[Element]] = []
    for (elements, _bg), header, footer in zip(raw, headers, footers):
        excluded = set()
        for band in (header, footer):
            if band is not None:
                excluded.update(id(e) for e in band.elements)
        bodies.append([e for e in elements if id(e) not in excluded])

    tops = [min(e.rect.y0 for e in body) for body in bodies if body]
    lefts = [min(e.rect.x0 for e in body if e.kind == "text") for body in bodies if any(e.kind == "text" for e in body)]
    gaps = [h - max(e.rect.y1 for e in body) for body, h in zip(bodies, heights) if body]
    side = max(min(lefts), 18.0) if lefts else 36.0
    top_margin = min(tops) if tops else 36.0
    # The fullest page shows the real bottom margin; a document of short pages
    # falls back to its side/top margin, which is usually the same size.
    bottom_margin = min(min(gaps) if gaps else side, max(side, top_margin, 18.0))

    out: list[Frame] = []
    for page, body, (_elements_, background), footer in zip(doc, bodies, raw, footers):
        limit = page.rect.height - bottom_margin
        if footer is not None:
            limit = min(limit, footer.top - 4)
        if body:
            limit = max(limit, max(e.rect.y1 for e in body))
        out.append(
            Frame(
                body=body,
                background_image=background,
                top=min(e.rect.y0 for e in body) if body else None,
                limit=limit,
            )
        )
    return out


def page_background(page: fitz.Page) -> str:
    """Colour of a full-page background fill, for the live editor overlay."""
    area = page.rect.width * page.rect.height
    for path in page.get_drawings():
        fill = path.get("fill")
        if fill and fitz.Rect(path["rect"]).get_area() >= 0.9 * area:
            r, g, b = (max(0, min(255, round(c * 255))) for c in fill[:3])
            return "#{0:02x}{1:02x}{2:02x}".format(r, g, b)
    return "#ffffff"


# --------------------------------------------------------------------------- #
# Strips
# --------------------------------------------------------------------------- #
@dataclass
class Strip:
    src: fitz.Document
    top: float                    # content extent in source coordinates
    bottom: float
    gap: float                    # whitespace above, from the previous strip
    width: float
    pad_top: float = _PAD
    pad_bottom: float = _PAD
    links: list[dict] = field(default_factory=list)
    # The band whose objects the strip carries (its glyphs' full font boxes).
    keep_top: float = 0.0
    keep_bottom: float = 0.0
    # How far its paths reach before clipping; clearing must cover that.
    art_top: float = 0.0
    art_bottom: float = 0.0

    @property
    def height(self) -> float:
        return self.bottom - self.top


def _strips(groups: list[Group], src: fitz.Document, width: float, prev_bottom: float | None) -> list[Strip]:
    src_links = src[0].get_links()
    claimed: set[int] = set()
    strips: list[Strip] = []
    for no, group in enumerate(groups):
        gap = group.top - prev_bottom if prev_bottom is not None else 0.0
        below = groups[no + 1].top - group.bottom if no + 1 < len(groups) else 2 * _PAD
        strip = Strip(
            src=src,
            top=group.top,
            bottom=group.bottom,
            gap=gap,
            width=width,
            pad_top=min(_PAD, max(gap, 0.0) / 2) if prev_bottom is not None else _PAD,
            pad_bottom=min(_PAD, max(below, 0.0) / 2),
        )
        extents = [e.extent or e.rect for e in group.elements]
        strip.keep_top = min([strip.top - strip.pad_top] + [r.y0 for r in extents])
        strip.keep_bottom = max([strip.bottom + strip.pad_bottom] + [r.y1 for r in extents])
        outlines = [e.extent for e in group.elements if e.kind == "drawing" and e.extent is not None]
        strip.art_top = min([strip.top - strip.pad_top] + [r.y0 for r in outlines])
        strip.art_bottom = max([strip.bottom + strip.pad_bottom] + [r.y1 for r in outlines])
        for link_no, link in enumerate(src_links):
            centre = (link["from"].y0 + link["from"].y1) / 2
            if link_no not in claimed and group.top - _PAD <= centre <= group.bottom + _PAD:
                claimed.add(link_no)
                strip.links.append(link)
        strips.append(strip)
        prev_bottom = group.bottom
    return strips


def _place(page: fitz.Page, strip: Strip, top: float) -> None:
    clip = fitz.Rect(0, strip.top - strip.pad_top, strip.width, strip.bottom + strip.pad_bottom)
    dy = top - strip.top
    source = _trimmed(strip)
    try:
        page.show_pdf_page(clip + (0, dy, 0, dy), source, 0, clip=clip)
    finally:
        source.close()
    _restore_links(page, strip.links, dy)


def _trimmed(strip: Strip) -> fitz.Document:
    """A copy of the strip's source page holding only the strip's own objects.

    The clip alone would hide the rest, but it would still be there: every
    strip would carry the whole page, and content moved again by a later edit
    would nest whole pages inside whole pages until the document crawls.
    Backgrounds are dropped too; the page keeps its own, which stay put.
    """
    doc = fitz.open()
    doc.insert_pdf(strip.src, from_page=0, to_page=0, links=False, annots=False)
    page = doc[0]
    r = page.rect
    # Strips placed by earlier edits that lie outside the band are removed
    # outright; redaction would hollow them out but keep calling them.
    keep = fitz.Rect(r.x0, strip.keep_top, r.x1, strip.keep_bottom)
    contents = page.get_contents()
    stream = b"".join(doc.xref_stream(xref) for xref in contents)
    far = [name for name, rect in _placed_strips(doc, page, stream) if not rect.intersects(keep)]
    if far:
        calls = re.compile(r"q\s*/(?:{0})\s+Do\s*Q".format("|".join(map(re.escape, far))).encode())
        for xref in contents:
            doc.update_stream(xref, calls.sub(b"", doc.xref_stream(xref)))
        for name in far:
            doc.xref_set_key(page.xref, "Resources/XObject/" + name, "null")
    for rect in (fitz.Rect(r.x0, r.y0, r.x1, strip.keep_top), fitz.Rect(r.x0, strip.keep_bottom, r.x1, r.y1)):
        if rect.height > 0:
            page.add_redact_annot(rect)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_REMOVE,
        graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )
    return doc


_REFERENCE_RE = re.compile(r"/([^\s/<>\[\]()]+)\s*(\d+)\s+0\s+R")
_NUMBER_RE = re.compile(r"-?\d*\.?\d+(?:[eE]-?\d+)?")


def _placed_strips(doc: fitz.Document, page: fitz.Page, stream: bytes) -> list[tuple[str, fitz.Rect]]:
    """The strips ``show_pdf_page`` put on ``page``, by name, with where each shows.

    Such a strip is a form with a BBox and Matrix that only calls the source
    page's form, and the page calls it bare (``q /Name Do Q``) after its own
    content, so the visible area is the BBox mapped by the Matrix. Matching on
    that shape rather than on names matters: redaction renames forms.
    """
    kind, value = doc.xref_get_key(page.xref, "Resources/XObject")
    if kind != "dict":
        return []
    out = []
    for name, xref in _REFERENCE_RE.findall(value):
        xref = int(xref)
        if not re.search(rb"q\s*/" + re.escape(name.encode()) + rb"\s+Do\s*Q", stream):
            continue
        inner_kind, inner = doc.xref_get_key(xref, "Resources/XObject")
        if inner_kind != "dict" or len(_REFERENCE_RE.findall(inner)) != 1:
            continue
        bbox = [float(v) for v in _NUMBER_RE.findall(doc.xref_get_key(xref, "BBox")[1])]
        matrix = [float(v) for v in _NUMBER_RE.findall(doc.xref_get_key(xref, "Matrix")[1])]
        if len(bbox) != 4:
            continue
        rect = fitz.Rect(bbox) * (fitz.Matrix(*matrix) if len(matrix) == 6 else fitz.Identity)
        out.append((name, rect * page.transformation_matrix))
    return out


def _restore_links(page: fitz.Page, links: list[dict], dy: float = 0.0) -> None:
    for link in links:
        moved = {k: v for k, v in link.items() if k not in ("xref", "id")}
        moved["from"] = link["from"] + (0, dy, 0, dy)
        try:
            page.insert_link(moved)
        except Exception:
            pass


def _clear(page: fitz.Page, rect: fitz.Rect, background_image: bool) -> None:
    """Remove every object inside ``rect``; backgrounds that extend past it stay.

    Redaction also deletes the link annotations it covers; ``_place`` puts
    them back with the content they belong to.
    """
    page.add_redact_annot(rect)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE if background_image else fitz.PDF_REDACT_IMAGE_REMOVE,
        graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )


def _clear_strips(page: fitz.Page, strips: list[Strip], background_image: bool) -> None:
    """Clear where ``strips`` were, before they are drawn again elsewhere.

    A rule is often a large box clipped down to a hairline, and redaction only
    removes a path it covers whole, so line art gets a second, taller pass.
    Text is cleared by the tight band alone, which keeps it from reaching
    glyphs that sit just outside it.
    """
    width = page.rect.width
    band = fitz.Rect(0, strips[0].top - strips[0].pad_top, width, strips[-1].bottom + strips[-1].pad_bottom)
    _clear(page, band, background_image)
    art = fitz.Rect(0, min(s.art_top for s in strips), width, max(s.art_bottom for s in strips))
    if art.y0 < band.y0 - 0.01 or art.y1 > band.y1 + 0.01:
        page.add_redact_annot(art)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
            text=fitz.PDF_REDACT_TEXT_NONE,
        )


def _layout(queue: list[Strip], first_top: float, limit: float) -> tuple[list[tuple[Strip, float]], list[Strip]]:
    """Stack strips from ``first_top``; return what fits and what carries over."""
    placements: list[tuple[Strip, float]] = []
    cursor = first_top
    for no, strip in enumerate(queue):
        top = first_top if no == 0 else cursor + strip.gap
        if no > 0 and top + strip.height > limit + 0.5:
            carry = queue[no:]
            # Keep with next: a heading sits closer to what follows it than to
            # what precedes it, so never strand it at the bottom of a page.
            while len(placements) > 1:
                last, _top = placements[-1]
                is_heading = last.height <= _HEADING_MAX_HEIGHT and carry[0].gap < 0.6 * last.gap
                if not is_heading:
                    break
                placements.pop()
                carry.insert(0, last)
            return placements, carry
        placements.append((strip, top))
        cursor = top + strip.height
    return placements, []


# --------------------------------------------------------------------------- #
# Rendering the new text
# --------------------------------------------------------------------------- #
_HYPHENATED_RE = re.compile(r"(\S*\w[-‐]\w\S*)")


def _escape(text: str, keep_hyphenated: bool) -> str:
    if not keep_hyphenated:
        return html.escape(text, quote=False)
    parts = _HYPHENATED_RE.split(text)
    out = []
    for no, part in enumerate(parts):
        escaped = html.escape(part, quote=False)
        # Odd indices are the captured hyphenated words.
        out.append('<span style="white-space: nowrap">{0}</span>'.format(escaped) if no % 2 else escaped)
    return "".join(out)


def _face_rules(library: fontsvc.FontLibrary, font: str, style: textsvc.TextStyle) -> list[str]:
    """``font-family`` / ``font-weight`` / ``font-style`` for one face.

    A real bold/italic face carries its own style; asking the layout engine
    for bold on top of it would embolden it a second time. A regular face
    standing in for bold is emboldened, so the weight still reads right.
    """
    record = library.record_for(font)
    has_face = record is not None and record.embeddable
    weight = "bold" if style.bold and not (has_face and record.bold) else "normal"
    slant = "italic" if style.italic and not (has_face and record.italic) else "normal"
    return [
        "font-family: {0}".format(library.font_stack(font)),
        "font-weight: {0}".format(weight),
        "font-style: {0}".format(slant),
    ]


def _borrow_glyphs(text: str, font: str, style, library, keep_hyphenated: bool) -> tuple[str, set[str]]:
    """Escape ``text``, drawing characters the subset lacks from a sibling face.

    Returns the markup and the characters no document face could draw.
    """
    missing = library.missing_glyphs(font, text)
    if not missing:
        return _escape(text, keep_hyphenated), set()
    unresolved: set[str] = set()
    out, plain = [], ""
    for char in text:
        if char not in missing:
            plain += char
            continue
        sibling = library.sibling_with(font, char)
        if sibling is not None:
            rules = _face_rules(library, sibling, style)
        else:
            # Named explicitly: left inside the embedded face's text, the
            # character would be drawn with the subset's empty glyph.
            unresolved.add(char)
            rules = [
                "font-family: {0}".format(library.generic_family(font)),
                "font-weight: {0}".format("bold" if style.bold else "normal"),
                "font-style: {0}".format("italic" if style.italic else "normal"),
            ]
        out.append(_escape(plain, keep_hyphenated))
        plain = ""
        rules = html.escape("; ".join(rules), quote=True)
        out.append('<span style="{0}">{1}</span>'.format(rules, html.escape(char, quote=False)))
    out.append(_escape(plain, keep_hyphenated))
    return "".join(out), unresolved


def _run_html(
    run: dict, base: textsvc.TextStyle, library: fontsvc.FontLibrary, keep_hyphenated: bool = False
) -> tuple[str, set[str]]:
    """One styled ``<span>``, plus the characters drawn in a fallback font."""
    style = textsvc.TextStyle.from_payload(run, base)
    font = library.variant(style.font, bold=style.bold, italic=style.italic)
    family, weight, slant = _face_rules(library, font, style)
    decorations = [d for d, on in (("underline", style.underline), ("line-through", style.strike)) if on]
    rules = [
        family,
        "font-size: {0:.4f}px".format(style.size),
        "color: {0}".format(style.color or "#000000"),
        weight,
        slant,
    ]
    if decorations:
        rules.append("text-decoration: {0}".format(" ".join(decorations)))
    gap = run.get("spaceWidth")
    if gap and run.get("text") == " ":
        # A space of exact width: the font size that makes one space glyph that
        # wide, with a zero line height so it cannot move the baseline.
        rules[1] = "font-size: {0:.4f}px".format(gap / library.space_advance(font))
        rules.append("line-height: 0px")
    text, unresolved = _borrow_glyphs(run.get("text", ""), font, style, library, keep_hyphenated)
    text = text.replace("\n", "<br/>")
    # The font stack carries double quotes, so the attribute must be escaped.
    return '<span style="{0}">{1}</span>'.format(html.escape("; ".join(rules), quote=True), text), unresolved


def _item_html(
    runs: list[dict], base, library, indent: float, keep_hyphenated: bool = False
) -> tuple[str, set[str]]:
    """A paragraph item as HTML, plus characters only a fallback font could draw."""
    spans, unresolved = [], set()
    for run in runs:
        markup, missing = _run_html(run, base, library, keep_hyphenated)
        spans.append(markup)
        unresolved |= missing
    indent_css = "text-indent: {0:.3f}px;".format(indent) if abs(indent) > 0.05 else ""
    return '<div id="pdfe" style="{0}">{1}</div>'.format(indent_css, "".join(spans)), unresolved


def _baselines(page: fitz.Page, after: float) -> list[float]:
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if span["text"].strip() and span["origin"][1] > after:
                    out.append(span["origin"][1])
    return out


# --------------------------------------------------------------------------- #
# The edit
# --------------------------------------------------------------------------- #
class _Flow:
    def __init__(self, session: DocumentSession, library: fontsvc.FontLibrary) -> None:
        self.session = session
        self.doc = session.doc
        self.library = library
        self.snapshots: dict[int, fitz.Document] = {}
        self.changed: set[int] = set()
        self.added = 0
        self.warnings: list[str] = []
        self.missing: set[str] = set()

    def snapshot(self, pno: int) -> fitz.Document:
        """The page as it was before this edit touched it."""
        if pno not in self.snapshots:
            snap = fitz.open()
            snap.insert_pdf(self.doc, from_page=pno, to_page=pno)
            self.snapshots[pno] = snap
        return self.snapshots[pno]

    # ------------------------------------------------------------------ render
    def render(
        self,
        para: parasvc.Paragraph,
        items: list[list[dict]],
        base: textsvc.TextStyle,
        lift: float = 0.0,
        marker_moves: bool = False,
    ) -> fitz.Document:
        """Lay ``items`` out from the old first baseline, raised by ``lift``.

        When the paragraph moves, the original marker is erased and the first
        item gets a freshly drawn one like every other item.
        """
        page = self.doc[para.page]
        width, height = page.rect.width, page.rect.height
        canvas = fitz.open()
        target = canvas.new_page(width=width, height=min(14400.0, height * 6))
        css = textsvc.build_css(base, self.library, line_box_px=para.pitch)
        x0, x1 = self._wrap_box(para, base, css, width)
        baseline = para.first_baseline - lift
        for no, runs in enumerate(items):
            has_text = any(run.get("text", "").strip() for run in runs)
            if not has_text:
                baseline += para.pitch + para.item_gap
                continue
            indent = para.first_indent if para.align in ("left", "justify") else 0.0
            body, unresolved = _item_html(runs, base, self.library, indent, para.keep_hyphenated)
            self.missing |= unresolved

            probe = self._probe(body, css, x0, x1, width)
            top = baseline - (probe[0]["origin"][1] if probe else 0.0)
            spare, _scale = target.insert_htmlbox(
                fitz.Rect(x0, top, x1, target.rect.y1 - 1),
                body,
                css=css,
                archive=self.library.archive,
                scale_low=1,
            )
            if spare < 0:
                raise DocumentError("This paragraph is too long to lay out on one page.")
            if para.marker is not None and (no > 0 or marker_moves):
                # Enter made a new list item: give it the same bullet glyph.
                self._draw_marker(target, para.marker, baseline, width)
            lines = _baselines(target, top - 0.01)
            last = max(lines) if lines else baseline
            baseline = last + para.pitch + para.item_gap
        return canvas

    def _draw_marker(self, target: fitz.Page, marker: parasvc.Marker, baseline: float, width: float) -> None:
        """Draw a list marker in its original font, size and colour at ``baseline``.

        Numbered markers repeat the original number; renumbering a list is
        left to the user, as in most PDF editors.
        """
        style = textsvc.TextStyle.from_span(marker.span) if marker.span else textsvc.TextStyle()
        style.align = "left"
        css = textsvc.build_css(style, self.library, line_box_px=None)
        body, _missing = _item_html([{"text": marker.text}], style, self.library, 0.0)
        probe = self._probe(body, css, 0.0, width, width)
        if not probe:
            return
        inset, offset = probe[0]["origin"][0], probe[0]["origin"][1]
        x0 = marker.bbox.x0 - inset
        target.insert_htmlbox(
            fitz.Rect(x0, baseline - offset, x0 + marker.bbox.width * 3 + 20, baseline - offset + 200),
            body,
            css=css,
            archive=self.library.archive,
            scale_low=1,
        )

    def _probe(self, body: str, css: str, x0: float, x1: float, width: float) -> list[dict]:
        """Lay ``body`` out in a throwaway box at y=0 and report its lines.

        Measuring the layout engine instead of predicting it from font metrics
        is what makes baselines and wrap points hold for any font.
        """
        probe = fitz.open()
        page = probe.new_page(width=width, height=4000)
        page.insert_htmlbox(fitz.Rect(x0, 0, x1, 4000), body, css=css, archive=self.library.archive, scale_low=1)
        lines = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                spans = [s for s in line["spans"] if s["text"].strip()]
                if spans:
                    lines.append({"bbox": fitz.Rect(line["bbox"]), "origin": spans[0]["origin"]})
        probe.close()
        return sorted(lines, key=lambda l: (round(l["origin"][1], 1), l["origin"][0]))

    def _wrap_box(self, para: parasvc.Paragraph, base: textsvc.TextStyle, css: str, width: float) -> tuple[float, float]:
        """The box to hand the layout engine so it wraps where the original did.

        The engine sets text a hair wider or narrower than the program that
        made the PDF (kerning differs), so the paragraph's widest original line
        is laid out once and the box is scaled by the measured ratio. It also
        insets text by a fixed margin, which is taken back off both sides.
        """
        no, original = para.widest_line()
        body, _missing = _item_html(para.runs(only_line=no), base, self.library, 0.0)
        # Measured left-aligned whatever the paragraph's alignment, so the
        # line starts at the box edge and the inset can be read off directly.
        left = textsvc.TextStyle(**{**base.__dict__, "align": "left"})
        lines = self._probe(body, textsvc.build_css(left, self.library, line_box_px=para.pitch), 0.0, width * 4, width * 4)
        inset, ratio = 0.0, 1.0
        if lines:
            first = lines[0]
            inset = first["origin"][0]
            row = [l for l in lines if abs(l["origin"][1] - first["origin"][1]) < 0.5]
            engine = max(l["bbox"].x1 for l in row) - first["origin"][0]
            if original > 20 and engine > 0:
                ratio = min(max(engine / original, 0.95), 1.05)
        # A little slack so a line exactly as long as the box still fits.
        span = (para.box_x1 - para.box_x0) * ratio + 0.2
        if para.align == "right":
            return para.box_x1 - span - inset, para.box_x1 + inset
        if para.align == "center":
            centre = (para.box_x0 + para.box_x1) / 2
            return centre - span / 2 - inset, centre + span / 2 + inset
        return para.box_x0 - inset, para.box_x0 + span + inset

    # -------------------------------------------------------------------- flow
    def run(
        self,
        para: parasvc.Paragraph,
        items: list[list[dict]],
        base: textsvc.TextStyle,
        reflow: bool,
        lift: float = 0.0,
    ) -> None:
        doc = self.doc
        pno = para.page
        page = doc[pno]
        width = page.rect.width
        layout = frames(doc)
        frame = layout[pno]
        snap = self.snapshot(pno)
        has_text = [any(run.get("text", "").strip() for run in item) for item in items]
        deleting = not any(has_text)
        lift = min(max(lift, 0.0), liftable(_elements(page)[0], para)) if reflow else 0.0
        # Blank items before the text, or a lift, move the first line; its
        # bullet has to go with it.
        marker_moves = (
            para.marker is not None and not deleting and (lift > 0.01 or not has_text[0])
        )

        rows: list[Strip] = []
        if not deleting:
            canvas = self.render(para, items, base, lift, marker_moves)
            rows = _strips(_groups(_elements(canvas[0], page.rect.get_area())[0]), canvas, width, None)
            if not rows:
                raise DocumentError("The new text could not be laid out; nothing was changed.")

        # Everything that starts below the paragraph moves; what sits beside it
        # (a bullet, a date at the right margin) stays put.
        own = _own_rects(para, with_marker=deleting or marker_moves)
        old_top = min(r.y0 for r in own)
        old_bottom = max(r.y1 for r in own)
        if para.marker is not None:
            old_bottom = max(old_bottom, para.marker.bbox.y1)
        body = [e for e in frame.body if not _is_own(e, own)]
        region_top = old_bottom
        while True:
            reaching = [e.rect.y1 for e in body if e.rect.y0 < region_top - 0.5 and e.rect.y1 > region_top]
            if not reaching:
                break
            region_top = max(reaching)
        if region_top > old_bottom + 0.5:
            self.warnings.append("Objects beside this paragraph were left where they are.")
        moving = [e for e in body if e.rect.y0 >= region_top - 0.5]
        below = _strips(_groups(moving), snap, width, old_bottom)

        erase = para.erase_rects()
        if (deleting or marker_moves) and para.marker is not None:
            erase.append(fitz.Rect(para.marker.bbox))
        # Erasing the old glyphs also deletes links on them (a URL in a contact
        # line); they go back once the new text is drawn.
        own_links = [
            link for link in snap[0].get_links()
            if not deleting and any(fitz.Rect(link["from"]).intersects(rect) for rect in own)
        ]
        textsvc.erase_rects(page, erase)
        self.changed.add(pno)

        if not reflow:
            for strip in rows:
                _place(page, strip, strip.top)
            _restore_links(page, own_links)
            return

        if rows:
            last_baseline = max(_baselines(canvas[0], -1.0), default=None)
            if below and last_baseline is not None:
                # What follows keeps its distance from the last baseline, as in
                # a word processor, whatever descenders the new last line has.
                below[0].gap = last_baseline + (below[0].top - para.last_baseline) - rows[-1].bottom
            queue, first_top = rows + below, rows[0].top
        else:
            if below:
                below[0].gap = 0.0
            queue, first_top = below, old_top - lift
        placements, carry = _layout(queue, first_top, frame.limit)

        moved_below = any(s.src is snap and abs(top - s.top) > 0.01 for s, top in placements) or any(
            s.src is snap for s in carry
        )
        if below and moved_below:
            _clear_strips(page, below, frame.background_image)
        for strip, top in placements:
            if strip.src is not snap or moved_below:
                _place(page, strip, top)
        _restore_links(page, own_links)

        gaps = [s.gap for s in below if s.gap > 0]
        block_gap = statistics.median(gaps) if gaps else para.pitch * 0.5
        default_top = min((f.top for f in layout if f.top is not None), default=36.0)
        self._cascade(carry, pno + 1, layout, block_gap, default_top)

    def _cascade(self, carry: list[Strip], pno: int, layout: list[Frame], block_gap: float, default_top: float) -> None:
        """Push overflow onto the following pages, adding pages at the end."""
        while carry:
            if pno < len(layout):
                frame = layout[pno]
                snap = self.snapshot(pno)
                page = self.doc[pno]
                own = _strips(_groups(frame.body), snap, page.rect.width, None)
                first_top = frame.top if frame.top is not None else default_top
                limit, background = frame.limit, frame.background_image
            else:
                if self.added >= _MAX_NEW_PAGES:
                    raise DocumentError("The text would need too many new pages.")
                page = self._append_page(pno - 1)
                own = []
                first_top = default_top
                limit = layout[-1].limit
                background = layout[-1].background_image
            if own:
                own[0].gap = block_gap
            placements, carry = _layout(carry + own, first_top, limit)
            if own:
                _clear_strips(page, own, background)
            for strip, top in placements:
                _place(page, strip, top)
            self.changed.add(pno)
            pno += 1

    def _append_page(self, template: int) -> fitz.Page:
        """A new last page that keeps the template's background and nothing else."""
        source = self.snapshot(template)
        self.doc.insert_pdf(source, from_page=0, to_page=0)
        page = self.doc[-1]
        for widget in list(page.widgets() or []):
            page.delete_widget(widget)
        for xref in [annot.xref for annot in page.annots() or []]:
            annot = page.load_annot(xref)
            if annot is not None:
                page.delete_annot(annot)
        for link in page.get_links():
            page.delete_link(link)
        area = page.rect.width * page.rect.height
        background_image = any(
            fitz.Rect(i["bbox"]).get_area() >= _BACKGROUND_SHARE * area for i in _image_info(page)
        )
        _clear(page, page.rect + (0.5, 0.5, -0.5, -0.5), background_image)
        self.added += 1
        return page


def _own_rects(para: parasvc.Paragraph, with_marker: bool) -> list[fitz.Rect]:
    own = [fitz.Rect(line.bbox) for line in para.lines]
    if with_marker and para.marker is not None:
        own.append(fitz.Rect(para.marker.bbox))
    return own


def liftable(elements: list[Element], para: parasvc.Paragraph) -> float:
    """How far ``para`` can move up: Backspace at its start removes space above.

    It may rise until its first line sits one line pitch below the text above
    it, or just clear of a rule or image. Nothing moves when something stands
    beside it, which would be left behind.
    """
    own = _own_rects(para, with_marker=True)
    mine = [e for e in elements if _is_own(e, own)]
    if not mine:
        return 0.0
    top = min(e.rect.y0 for e in mine)
    bottom = max(e.rect.y1 for e in mine)
    others = [e for e in elements if not any(e is m for m in mine)]
    if any(e.rect.y0 < bottom - 0.5 and e.rect.y1 > top + 0.5 for e in others):
        return 0.0
    above = [e for e in others if e.rect.y1 <= top + 0.5]
    if not above:
        return 0.0
    room = min(
        para.first_baseline - e.baseline - para.pitch if e.baseline is not None else top - e.rect.y1 - 2.0
        for e in above
    )
    return max(0.0, math.floor(room * 100) / 100)


def _is_own(element: Element, own: list[fitz.Rect]) -> bool:
    if element.kind != "text":
        return False
    area = element.rect.get_area() or 1.0
    return any((element.rect & rect).get_area() >= 0.6 * area for rect in own)


def _normalise(items: list[list[dict]]) -> list[list[dict]]:
    out = [[dict(run) for run in item if run.get("text")] for item in items]
    while out and not any(run["text"].strip() for run in out[-1]):
        out.pop()
    return out


def edit_paragraph(
    session: DocumentSession,
    pno: int,
    paragraph_id: str,
    items: list[list[dict]],
    *,
    align: str | None = None,
    reflow: bool = True,
    lift: float = 0.0,
) -> dict:
    """Replace a paragraph with ``items`` (one list of styled runs per paragraph).

    ``lift`` moves the paragraph up into the space above it, as Backspace at
    the start of a paragraph does in a word processor.
    """
    with session.lock:
        doc = session.doc
        if pno < 0 or pno >= doc.page_count:
            raise DocumentError("Page {0} is out of range.".format(pno + 1))
        page = doc[pno]
        if page.rotation:
            raise DocumentError("Paragraph editing needs an unrotated page. Rotate it back to 0° first.")
        pending = [p.number + 1 for p in doc if any(True for _ in p.annots(types=[fitz.PDF_ANNOT_REDACT]))]
        if pending:
            raise DocumentError(
                "Apply or clear the pending redaction marks first (page {0}).".format(pending[0])
            )

        index = textsvc.build_index(session, pno)
        para = parasvc.find(parasvc.build(index, page), paragraph_id)
        if para is None:
            raise DocumentError("This paragraph has changed. Reload the page and try again.")

        library = fontsvc.build_library(session)
        first_chars = para.editable_chars(0)
        anchor = next(
            (s for s in para.first.spans if first_chars and s.span_id == first_chars[0].span_id),
            para.first.spans[0],
        )
        base = textsvc.TextStyle.from_span(anchor)
        base.align = align or para.align

        flow = _Flow(session, library)
        session.checkpoint()
        try:
            flow.run(para, _normalise(items), base, reflow, lift)
        except Exception:
            session.rollback()
            raise
        finally:
            for snap in flow.snapshots.values():
                snap.close()

        warnings = list(flow.warnings)
        if flow.missing:
            warnings.append(
                "The document's embedded font has no glyph for {0}; a similar font was used for "
                "{1}.".format(" ".join(sorted(flow.missing)), "it" if len(flow.missing) == 1 else "them")
            )
        if flow.added:
            warnings.append(
                "Added {0} page{1} for the text that no longer fits.".format(flow.added, "" if flow.added == 1 else "s")
            )
        # Redaction leaves MuPDF's per-page link caches stale; reopening from
        # our own bytes (object numbers unchanged) clears them for later calls.
        session.reload()
        session.touch()
        return {
            "applied": 1,
            "pagesChanged": sorted(flow.changed),
            "pagesAdded": flow.added,
            "warnings": warnings,
        }
