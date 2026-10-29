"""Paragraph detection on top of the character index.

A PDF stores positioned lines, not paragraphs. To edit a paragraph the way a
word processor does, we rebuild them:

*   Consecutive lines belong to one paragraph only when the break between them
    was a *soft wrap*: same size, same left edge, regular line pitch, and the
    next line's first word would not have fitted on the previous line. Anything
    else is a hard break and starts a new paragraph. This is what keeps an
    unedited paragraph re-rendering with exactly the same line breaks.
*   Bullets and list numbers are recognised whether they are separate objects
    beside the text (the common case) or the first characters of the line, and
    are kept out of the editable text so they never get re-wrapped.
*   Each paragraph records its line pitch, alignment, first-line indent and the
    right edge it may wrap to, which the reflow engine uses to re-lay it out.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

import fitz

from app.services import fonts as fontsvc
from app.services import text as textsvc

# "·" is how a bullet drawn with a standard PDF font often extracts.
_BULLET_GLYPHS = "•·◦▪▫‣⁃∙●○■□►▸➢➤✓✔◆◇*"
# A list marker at the start of a line: a bullet glyph, a dash, or "1." / "1)".
_INLINE_MARKER_RE = re.compile(
    r"^(\s*(?:[" + re.escape(_BULLET_GLYPHS) + r"]|[-–](?=\s)|\(?\d{1,3}[.)])\s+)"
)
_MARKER_ONLY_RE = re.compile(
    r"^\s*(?:[" + re.escape(_BULLET_GLYPHS) + r"\-–]|\(?\d{1,3}[.)])\s*$"
)
# How closely the left edges of wrapped lines must agree, in points.
_ALIGN_TOLERANCE = 1.0
# The column edge found on the page is where the furthest line *ends*; the
# program that made the PDF wrapped a little inside it.
_WRAP_MARGIN = 0.4


@dataclass
class Line:
    id: str
    block_id: str
    spans: list[textsvc.Span]
    chars: list[textsvc.Char]
    text: str
    bbox: fitz.Rect
    baseline: float
    size: float

    @property
    def x0(self) -> float:
        return self.bbox.x0

    @property
    def x1(self) -> float:
        return self.bbox.x1


@dataclass
class Marker:
    text: str
    bbox: fitz.Rect
    inline: bool                  # True when the marker shares the text's first span
    span: textsvc.Span | None = None   # its font, size and colour


@dataclass
class Paragraph:
    id: str
    page: int
    lines: list[Line]
    first_char: int = 0           # chars of line 0 that belong to an inline marker
    marker: Marker | None = None
    pitch: float = 0.0
    align: str = "left"
    box_x0: float = 0.0           # left edge continuation lines wrap back to
    box_x1: float = 0.0           # right edge the text may wrap at
    first_indent: float = 0.0     # first line offset from box_x0
    item_gap: float = 0.0         # extra space between sibling paragraphs (filled in later)
    space_width: float = 0.0
    # The program that made the PDF moved "portfolio-anil-bose" to the next
    # line whole, even though "portfolio-" would have fitted: it never breaks
    # at hyphens, so the renderer must not either.
    keep_hyphenated: bool = False
    _pitch_known: bool = field(default=False, repr=False)

    # ---------------------------------------------------------------- geometry
    @property
    def first(self) -> Line:
        return self.lines[0]

    @property
    def last(self) -> Line:
        return self.lines[-1]

    @property
    def first_baseline(self) -> float:
        return self.first.baseline

    @property
    def last_baseline(self) -> float:
        return self.last.baseline

    @property
    def size(self) -> float:
        return self.first.size

    @property
    def first_text_x0(self) -> float:
        chars = self.editable_chars(0)
        return chars[0].bbox.x0 if chars else self.first.x0

    @property
    def bbox(self) -> fitz.Rect:
        out = fitz.Rect(self.lines[0].bbox)
        for line in self.lines[1:]:
            out |= line.bbox
        if self.marker is not None:
            out |= self.marker.bbox
        return out

    def editable_chars(self, line_no: int) -> list[textsvc.Char]:
        chars = self.lines[line_no].chars
        if line_no == 0:
            chars = chars[self.first_char:]
        # Leading spaces never carry meaning once the line is re-wrapped.
        start = 0
        while start < len(chars) and chars[start].ch.isspace():
            start += 1
        return chars[start:]

    @property
    def span_ids(self) -> list[str]:
        return [s.span_id for line in self.lines for s in line.spans]

    def erase_rects(self) -> list[fitz.Rect]:
        """Glyph boxes of the editable text, one per span segment."""
        rects: list[fitz.Rect] = []
        for no in range(len(self.lines)):
            current: fitz.Rect | None = None
            current_span = None
            for char in self.editable_chars(no):
                if char.bbox.is_empty:
                    continue
                if char.span_id != current_span and current is not None:
                    rects.append(current)
                    current = None
                current_span = char.span_id
                current = fitz.Rect(char.bbox) if current is None else current | char.bbox
            if current is not None:
                rects.append(current)
        return rects

    # ------------------------------------------------------------------ content
    def widest_line(self) -> tuple[int, float]:
        """Index and width of the longest line, measured from its first editable glyph."""
        best, width = 0, 0.0
        for no, line in enumerate(self.lines):
            chars = [c for c in self.editable_chars(no) if not c.bbox.is_empty]
            while chars and chars[-1].ch.isspace():
                chars.pop()
            if chars and chars[-1].bbox.x1 - chars[0].bbox.x0 > width:
                best, width = no, chars[-1].bbox.x1 - chars[0].bbox.x0
        return best, width

    def runs(self, only_line: int | None = None) -> list[dict]:
        """The paragraph as styled runs, soft wraps joined back into spaces."""
        runs: list[dict] = []
        natural = self.space_width or 0.28 * self.size

        def style_of(span: textsvc.Span) -> dict:
            bold, italic = fontsvc.guess_style(span.font, span.flags)
            return {
                "font": span.font,
                "size": round(span.size, 3),
                "color": textsvc.rgb_to_hex(span.color),
                "bold": bold,
                "italic": italic,
            }

        def push(text: str, span: textsvc.Span) -> None:
            if not text:
                return
            style = style_of(span)
            if runs and "spaceWidth" not in runs[-1] and all(runs[-1][k] == v for k, v in style.items()):
                runs[-1]["text"] += text
            else:
                runs.append({"text": text, **style})

        def push_space(width: float, span: textsvc.Span) -> None:
            # A gap wider than a space (items laid out with a fixed gap, as
            # HTML-to-PDF tools do) keeps its exact width as a sized space.
            runs.append({"text": " ", **style_of(span), "spaceWidth": round(width, 3)})

        for no, line in enumerate(self.lines):
            if only_line is not None and no != only_line:
                continue
            chars = self.editable_chars(no)
            if no > 0 and runs:
                tail = runs[-1]["text"]
                if tail and not tail[-1].isspace() and not tail.endswith(("-", "‐")):
                    runs[-1]["text"] += " "
            previous: textsvc.Char | None = None
            for no_char, char in enumerate(chars):
                span = _span_of(line, char.span_id)
                if span is None:
                    continue
                following = chars[no_char + 1] if no_char + 1 < len(chars) else None
                if char.ch == " " and following is not None:
                    effective = following.bbox.x0 - char.bbox.x0
                    if effective - natural > max(0.6, 0.25 * natural):
                        push_space(effective, span)
                        previous = char
                        continue
                elif (
                    previous is not None
                    and not previous.ch.isspace()
                    and not char.ch.isspace()
                    and char.bbox.x0 - previous.bbox.x1 > 0.22 * max(span.size, 1)
                ):
                    # Words positioned apart without any space glyph.
                    push_space(char.bbox.x0 - previous.bbox.x1, span)
                push(char.ch, span)
                previous = char
        if runs:
            runs[-1]["text"] = runs[-1]["text"].rstrip()
            if not runs[-1]["text"]:
                runs.pop()
        return runs

    def plain_text(self) -> str:
        return "".join(run["text"] for run in self.runs())


def _span_of(line: Line, span_id: str) -> textsvc.Span | None:
    for span in line.spans:
        if span.span_id == span_id:
            return span
    return None


# --------------------------------------------------------------------------- #
# Building
# --------------------------------------------------------------------------- #
def _lines(index: textsvc.PageIndex) -> list[Line]:
    grouped: dict[str, list[textsvc.Span]] = {}
    order: list[str] = []
    for span in index.span_list():
        if span.line_id not in grouped:
            grouped[span.line_id] = []
            order.append(span.line_id)
        grouped[span.line_id].append(span)

    lines: list[Line] = []
    for line_id in order:
        spans = grouped[line_id]
        chars = [c for s in spans for c in index.chars[s.char_start:s.char_end]]
        text = "".join(c.ch for c in chars)
        if not text.strip():
            continue
        bbox = fitz.Rect(spans[0].bbox)
        for span in spans[1:]:
            bbox |= span.bbox
        dominant = max(spans, key=lambda s: len(s.text.strip()))
        size = dominant.size or 1.0
        # Vertical or rotated runs are left to the single-run editor.
        if bbox.height > 2.5 * size and bbox.width < 1.5 * size:
            continue
        lines.append(
            Line(
                id=line_id,
                block_id=spans[0].block_id,
                spans=spans,
                chars=chars,
                text=text,
                bbox=bbox,
                baseline=float(dominant.origin[1]),
                size=size,
            )
        )
    return lines


def _is_marker_line(line: Line) -> bool:
    return bool(_MARKER_ONLY_RE.match(line.text)) and line.bbox.width <= 3.5 * line.size


def _inline_marker_length(line: Line) -> int:
    match = _INLINE_MARKER_RE.match(line.text)
    if not match or len(match.group(1)) >= len(line.text.rstrip()):
        return 0
    return len(match.group(1))


def _first_word_width(line: Line, skip: int = 0) -> float:
    chars = line.chars[skip:]
    start = 0
    while start < len(chars) and chars[start].ch.isspace():
        start += 1
    end = start
    while end < len(chars) and not chars[end].ch.isspace():
        end += 1
    if end <= start:
        return 0.0
    return chars[end - 1].bbox.x1 - chars[start].bbox.x0


def _hyphen_prefix_width(line: Line) -> float:
    """Width of the first word up to its first inner hyphen ("portfolio-" of
    "portfolio-anil-bose"), or infinity when the word has none."""
    chars = line.chars
    start = 0
    while start < len(chars) and chars[start].ch.isspace():
        start += 1
    end = start
    while end < len(chars) and not chars[end].ch.isspace():
        end += 1
    for no in range(start + 1, end - 1):
        if chars[no].ch in "-‐":
            return chars[no].bbox.x1 - chars[start].bbox.x0
    return float("inf")


def _space_width(lines: list[Line]) -> float:
    widths = [c.bbox.width for line in lines for c in line.chars if c.ch == " " and c.bbox.width > 0]
    if widths:
        return statistics.median(widths)
    return 0.28 * (lines[0].size if lines else 10)


def _overlaps_row(a: fitz.Rect, b: fitz.Rect) -> bool:
    overlap = min(a.y1, b.y1) - max(a.y0, b.y0)
    return overlap > 0.4 * min(a.height, b.height)


def _right_limit(lines: list[Line], all_lines: list[Line], skip: set[str]) -> float:
    """How far right a paragraph made of ``lines`` may wrap.

    The column's right edge is the furthest any line starting in the same
    column reaches. Something sitting to the right on the same row (a date in
    a résumé, say) caps it, so a longer line never runs into it.
    """
    left = min(line.x0 for line in lines)
    reach = max(line.x1 for line in lines)
    size = lines[0].size
    limit = reach
    for other in all_lines:
        if other.x0 >= left - 3 * size and other.x0 < reach and other.x1 > left:
            limit = max(limit, other.x1)
    for line in lines:
        for other in all_lines:
            if other.id in skip:
                continue
            if other.x0 >= line.x1 - 0.5 and _overlaps_row(line.bbox, other.bbox):
                limit = min(limit, other.x0 - 0.6 * size)
    return max(limit, reach)


def _continues(para: Paragraph, line: Line, limit: float, has_marker: bool) -> bool:
    last = para.last
    size = last.size
    if has_marker or _inline_marker_length(line):
        return False
    if abs(line.size - size) > 0.12 * size:
        return False
    step = line.baseline - last.baseline
    if step < 0.9 * size or step > 2.2 * size:
        return False
    if len(para.lines) >= 2 and abs(step - para.pitch) > 0.12 * para.pitch:
        return False
    # Wrapped lines start at exactly the same x; a ragged left edge means
    # separately positioned lines (right-aligned dates, table cells).
    if len(para.lines) >= 2:
        if abs(line.x0 - para.box_x0) > _ALIGN_TOLERANCE:
            return False
    else:
        indent = para.first_text_x0 - line.x0
        if not (abs(indent) <= _ALIGN_TOLERANCE or 0 < indent <= 4 * size):
            return False
    # Soft wrap only if the next line's first word could not have fitted.
    room = limit - _WRAP_MARGIN - (last.x1 + para.space_width)
    return _first_word_width(line) > room


def build(index: textsvc.PageIndex, page: fitz.Page) -> list[Paragraph]:
    """Every editable paragraph on the page, in reading order."""
    lines = _lines(index)
    markers = [line for line in lines if _is_marker_line(line)]
    marker_ids = {m.id for m in markers}
    text_lines = [line for line in lines if line.id not in marker_ids]

    def marker_for(line: Line, text_x0: float) -> Line | None:
        for marker in markers:
            if (
                abs(marker.baseline - line.baseline) <= 0.35 * line.size
                and marker.x1 <= text_x0 + 0.5
                and text_x0 - marker.x1 < 4 * line.size
            ):
                return marker
        return None

    # Link each line to the nearest line directly above it (overlapping
    # horizontally). Working from geometry rather than content-stream order
    # keeps detection stable after edits and correct for multi-column pages.
    ordered = sorted(text_lines, key=lambda l: (l.baseline, l.x0))
    above: dict[str, Line] = {}
    below: dict[str, Line] = {}
    for no, lower in enumerate(ordered):
        nearest = None
        for upper in ordered[:no]:
            if upper.baseline < lower.baseline - 0.3 * lower.size and _overlaps_column(upper, lower):
                if nearest is None or upper.baseline > nearest.baseline:
                    nearest = upper
        if nearest is not None:
            above[lower.id] = nearest
            current_below = below.get(nearest.id)
            if current_below is None or lower.baseline < current_below.baseline:
                below[nearest.id] = lower

    paragraphs: list[Paragraph] = []
    owner: dict[str, Paragraph] = {}
    for line in ordered:
        skip = _inline_marker_length(line)
        text_x0 = line.chars[skip].bbox.x0 if skip < len(line.chars) else line.x0
        separate_marker = marker_for(line, text_x0)
        upper = above.get(line.id)
        current = owner.get(upper.id) if upper is not None else None
        if current is not None and current.last is upper and below.get(upper.id) is line:
            limit = _right_limit(current.lines, text_lines, {l.id for l in current.lines})
            if _continues(current, line, limit, separate_marker is not None):
                current.lines.append(line)
                owner[line.id] = current
                steps = [b.baseline - a.baseline for a, b in zip(current.lines, current.lines[1:])]
                current.pitch = statistics.median(steps)
                current._pitch_known = True
                current.box_x0 = statistics.median(l.x0 for l in current.lines[1:])
                continue
        current = Paragraph(id="", page=index.page, lines=[line], first_char=skip)
        owner[line.id] = current
        current.space_width = _space_width([line])
        current.box_x0 = text_x0
        if skip:
            marker_chars = line.chars[:skip]
            box = fitz.Rect(marker_chars[0].bbox)
            for c in marker_chars[1:]:
                if not c.ch.isspace():
                    box |= c.bbox
            marker_span = _span_of(line, next(c.span_id for c in marker_chars if not c.ch.isspace()))
            current.marker = Marker(text=line.text[:skip].strip(), bbox=box, inline=True, span=marker_span)
        elif separate_marker is not None:
            current.marker = Marker(
                text=separate_marker.text.strip(),
                bbox=fitz.Rect(separate_marker.bbox),
                inline=False,
                span=separate_marker.spans[0],
            )
        paragraphs.append(current)

    # Reading order, then stable ids for this document version.
    paragraphs.sort(key=lambda p: (round(p.first_baseline, 1), p.first.x0))
    for no, para in enumerate(paragraphs):
        para.id = "p{0}g{1}".format(index.page, no)
    _finish(paragraphs, text_lines, page)
    return paragraphs


def _overlaps_column(upper: Line, lower: Line) -> bool:
    return min(upper.x1, lower.x1) - max(upper.x0, lower.x0) > 0


def _finish(paragraphs: list[Paragraph], text_lines: list[Line], page: fitz.Page) -> None:
    """Pitch, alignment, wrap box and sibling spacing for every paragraph."""
    known = [p for p in paragraphs if p._pitch_known]
    left_margin = min((line.x0 for line in text_lines), default=0.0)
    width = page.rect.width

    for para in paragraphs:
        size = para.size
        if not para._pitch_known:
            similar = [p.pitch for p in known if abs(p.size - size) <= 0.08 * size]
            para.pitch = statistics.median(similar) if similar else size * 1.2
        own = {line.id for line in para.lines}
        limit = _right_limit(para.lines, text_lines, own)
        para.space_width = _space_width(para.lines)

        if len(para.lines) >= 2:
            # Wrap where the original wrapped: past the longest line, short of
            # where any word pushed to the next line would have ended.
            longest = max(line.x1 for line in para.lines)
            pushed = min(
                upper.x1 + para.space_width + _first_word_width(lower)
                for upper, lower in zip(para.lines, para.lines[1:])
            )
            low, high = longest + 0.5, pushed - 0.5
            target = limit - _WRAP_MARGIN
            para.box_x1 = min(max(target, low), high) if high > low else (longest + pushed) / 2
            para.first_indent = para.first_text_x0 - para.box_x0
            para.keep_hyphenated = any(
                upper.x1 + para.space_width + _hyphen_prefix_width(lower) <= para.box_x1
                for upper, lower in zip(para.lines, para.lines[1:])
            )
            non_last = para.lines[:-1]
            flush = all(abs(line.x1 - limit) <= 1.2 for line in non_last)
            stretched = _space_width(non_last) > 1.15 * _space_width(para.lines[-1:])
            para.align = "justify" if flush and (len(non_last) >= 2 or stretched) else "left"
            continue

        line = para.first
        centre = (para.first_text_x0 + line.x1) / 2
        if line.x0 > width * 0.45 and abs(line.x1 - limit) <= 1.5:
            # Right-aligned (a date at the margin): grow leftwards.
            left_limit = left_margin
            for other in text_lines:
                if other.id != line.id and other.x1 <= line.x0 + 0.5 and _overlaps_row(line.bbox, other.bbox):
                    left_limit = max(left_limit, other.x1 + 0.6 * size)
            para.align = "right"
            para.box_x0 = min(left_limit, para.first_text_x0)
            para.box_x1 = line.x1
        elif abs(centre - width / 2) <= 3 and para.first_text_x0 > width * 0.2:
            half = min(centre - left_margin, limit - centre)
            para.align = "center"
            para.box_x0 = centre - half
            para.box_x1 = centre + half
        else:
            para.align = "left"
            para.box_x0 = para.first_text_x0
            para.box_x1 = max(limit - _WRAP_MARGIN, line.x1 + 0.5)
        para.first_indent = 0.0

    # Space between list items / sibling paragraphs, so a new item made with
    # Enter sits exactly as far below as the existing ones do.
    for no, para in enumerate(paragraphs):
        para.item_gap = _sibling_gap(para, paragraphs[no + 1:]) or _sibling_gap(
            para, list(reversed(paragraphs[:no])), above=True
        ) or 0.0


def _sibling_gap(para: Paragraph, candidates: list[Paragraph], above: bool = False) -> float | None:
    """Gap to the nearest neighbouring paragraph, if it is the same kind."""
    for other in candidates:
        # Something on the same rows (a date beside a heading) is not a neighbour.
        if para.first_baseline - 0.5 * para.size <= other.first_baseline <= para.last_baseline + 0.5 * para.size:
            continue
        if (other.marker is None) != (para.marker is None):
            return None
        if abs(other.box_x0 - para.box_x0) > 1.0 or abs(other.size - para.size) > 0.08 * para.size:
            return None
        upper, lower = (other, para) if above else (para, other)
        gap = lower.first_baseline - (upper.last_baseline + para.pitch)
        if -0.5 <= gap <= 2.5 * para.pitch:
            return max(gap, 0.0)
        return None
    return None


def find(paragraphs: list[Paragraph], paragraph_id: str) -> Paragraph | None:
    return next((p for p in paragraphs if p.id == paragraph_id), None)


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #
def serialize(para: Paragraph, library: fontsvc.FontLibrary | None = None) -> dict:
    size = para.size
    ascender = para.first.spans[0].ascender if para.first.spans else 0.9
    descender = para.first.spans[0].descender if para.first.spans else -0.2
    natural = (ascender - descender) * size
    top = para.first_baseline - ascender * size - (para.pitch - natural) / 2
    bottom = top + para.pitch * len(para.lines)
    runs = []
    for run in para.runs():
        # fontId names the exact face (Inter-Bold); familyId groups faces so the
        # browser can switch between regular and bold of the same family. Some
        # files give every face the same name, so the face is resolved by style.
        face = library.variant(run["font"], bold=bool(run.get("bold")), italic=bool(run.get("italic"))) if library else run["font"]
        runs.append({
            **run,
            "fontId": fontsvc.css_family_for(face),
            "familyId": fontsvc.family_stem(run["font"]) or "font",
        })
    marker = None
    if para.marker is not None:
        b = para.marker.bbox
        marker = {"text": para.marker.text, "bbox": [b.x0, b.y0, b.x1, b.y1], "inline": para.marker.inline}
    b = para.bbox
    return {
        "id": para.id,
        "spanIds": para.span_ids,
        "bbox": [b.x0, b.y0, b.x1, b.y1],
        "box": [para.box_x0, top, para.box_x1, bottom],
        "firstIndent": para.first_indent,
        "firstBaseline": para.first_baseline,
        "lineHeight": para.pitch,
        "lineCount": len(para.lines),
        "align": para.align,
        "itemGap": para.item_gap,
        "marker": marker,
        "runs": runs,
    }
