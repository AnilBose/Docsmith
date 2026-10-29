"""Paragraph editing and Word-style reflow.

Run with:  .venv/Scripts/python.exe tests/test_paragraphs.py

The sample mimics an HTML-to-PDF résumé: a tinted page background, coloured
heading bands, bullets drawn as separate glyphs beside wrapped text, a page
number footer, a link, and a second page filled to the bottom margin.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.core.session import DocumentError, store  # noqa: E402
from app.services import fonts as fontsvc  # noqa: E402
from app.services import paragraphs as parasvc  # noqa: E402
from app.services import reflow as reflowsvc  # noqa: E402
from app.services import text as textsvc  # noqa: E402

PASSES: list[str] = []
FAILURES: list[str] = []

SIZE = 9.4
PITCH = 13.75
LEFT, BULLET_X, TEXT_X, RIGHT = 30.0, 37.5, 47.0, 565.0
BACKGROUND = (1.0, 0.99, 0.96)
BAND = (0.76, 0.81, 0.90)
LOREM = (
    "Delivered a reliable platform for clinics so practitioners and clients can manage "
    "appointments, forms and messages in one place while administrators keep full control "
    "of permissions, billing and reporting across every location"
).split()


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSES.append(name)
        print("  PASS  {0}".format(name))
    else:
        FAILURES.append("{0} :: {1}".format(name, detail))
        print("  FAIL  {0}  {1}".format(name, detail))


# --------------------------------------------------------------------------- #
# Sample document
# --------------------------------------------------------------------------- #
def wrap(words: list[str], width: float) -> list[str]:
    lines, current = [], ""
    for word in words:
        trial = (current + " " + word).strip()
        if fitz.get_text_length(trial, fontname="helv", fontsize=SIZE) <= width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def new_page(doc: fitz.Document, number: int) -> fitz.Page:
    page = doc.new_page(width=595, height=842)
    page.draw_rect(page.rect, color=None, fill=BACKGROUND)
    page.insert_text((290, 825), str(number), fontname="helv", fontsize=8)   # footer
    return page


def heading(page: fitz.Page, y: float, title: str) -> float:
    """Band + title; returns the baseline of the next line."""
    page.draw_rect(fitz.Rect(LEFT, y, RIGHT, y + 19), color=None, fill=BAND)
    page.insert_text((LEFT + 2, y + 13.5), title, fontname="hebo", fontsize=9.8)
    return y + 19 + 14.5


LABELS = iter("Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November "
              "Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu".split())


def bullet(page: fitz.Page, baseline: float, words: list[str]) -> float:
    """A bullet item; returns the baseline after it (item gap included).

    Each item starts with its own label (Alpha, Bravo, ...) so tests can find it.
    """
    words = [next(LABELS)] + words
    page.insert_text((BULLET_X, baseline), "•", fontname="helv", fontsize=SIZE)
    for no, line in enumerate(wrap(words, RIGHT - TEXT_X)):
        page.insert_text((TEXT_X, baseline + no * PITCH), line, fontname="helv", fontsize=SIZE)
        last = baseline + no * PITCH
    return last + PITCH + 2.5


def build_sample() -> bytes:
    global LABELS
    LABELS = iter("Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November "
                  "Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu "
                  "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve".split())
    doc = fitz.open()
    page = new_page(doc, 1)
    page.insert_text((LEFT, 50), "Jane Example", fontname="hebo", fontsize=18)
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(LEFT, 60, 200, 72), "uri": "https://example.com"})
    page.insert_text((LEFT, 70), "example.com", fontname="helv", fontsize=8.6)
    y = heading(page, 90, "EXPERIENCE")
    y = bullet(page, y, LOREM[:24])
    y = bullet(page, y, LOREM[:12])
    y = bullet(page, y, LOREM)
    y = heading(page, y + 6, "PROJECTS")
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(TEXT_X, y - 9, 200, y + 2), "uri": "https://project.example"})
    for _ in range(4):
        y = bullet(page, y, LOREM[:20])

    page = new_page(doc, 2)
    y = heading(page, 28, "MORE PROJECTS")
    # Filled to the bottom margin, so any growth must flow onto a new page.
    while y < 735:
        y = bullet(page, y, LOREM[:22])
    y = heading(page, y + 6, "LANGUAGES")
    page.insert_text((LEFT, y), "English, Malayalam, Hindi", fontname="helv", fontsize=SIZE)
    return doc.tobytes()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def paragraphs(session, pno: int) -> list[parasvc.Paragraph]:
    return parasvc.build(textsvc.build_index(session, pno), session.doc[pno])


def find(session, pno: int, prefix: str) -> parasvc.Paragraph:
    return next(p for p in paragraphs(session, pno) if p.plain_text().startswith(prefix))


def baseline_of(session, pno: int, word: str) -> float | None:
    """Baseline of the first span containing ``word`` (bullet glyphs ignored)."""
    for block in session.doc[pno].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if span["text"].lstrip("•· ").startswith(word):
                    return span["origin"][1]
    return None


def bullets(session, pno: int) -> int:
    text = session.doc[pno].get_text()
    return text.count("•") + text.count("·")


def rows(session, pno: int) -> list[tuple[float, str]]:
    """Each visual row as (bottom, its words left to right).

    Words, not extracted lines: a bullet and its text may come out as one line
    or two depending on how they were drawn, which does not change the page.
    """
    grouped: list[tuple[float, list]] = []
    for x0, _y0, _x1, y1, word, *_ in sorted(session.doc[pno].get_text("words"), key=lambda w: w[3]):
        for bottom, words in grouped:
            if abs(bottom - y1) <= 1.0:
                words.append((x0, word))
                break
        else:
            grouped.append((y1, [(x0, word)]))
    return sorted((round(bottom, 1), " ".join(w for _x, w in sorted(words))) for bottom, words in grouped)


def has_background(page: fitz.Page) -> bool:
    return any(
        d.get("fill") and fitz.Rect(d["rect"]).get_area() >= 0.9 * page.rect.get_area()
        for d in page.get_drawings()
    )


def fresh():
    return store.open(build_sample(), "sample.pdf")


# --------------------------------------------------------------------------- #
def same_name_faces() -> None:
    """pypdf writes every face of a family as plain "Inter": regular and bold
    must still be told apart, or an edit redraws regular text with the bold
    subset (bold, wider, and missing every letter bold text never used)."""
    regular, bold = r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\arialbd.ttf"
    if not (os.path.exists(regular) and os.path.exists(bold)):
        print("  SKIP  needs Arial regular and bold from C:\\Windows\\Fonts")
        return
    doc = fitz.open()
    page = doc.new_page()
    page.insert_font(fontname="F1", fontfile=regular)
    page.insert_font(fontname="F2", fontfile=bold)
    lead = "Regular words then "
    page.insert_text((72, 100), lead, fontname="F1", fontsize=11)
    page.insert_text((72 + fitz.Font(fontfile=regular).text_length(lead, 11), 100), "boldword", fontname="F2", fontsize=11)
    for xref in [f[0] for f in page.get_fonts(full=True)]:
        doc.xref_set_key(xref, "BaseFont", "/Arial")
        descendant = doc.xref_get_key(xref, "DescendantFonts")[1]
        if descendant.startswith("["):
            doc.xref_set_key(int(descendant.strip("[]").split()[0]), "BaseFont", "/Arial")
    session = store.open(doc.tobytes(), "same-name.pdf")

    library = fontsvc.build_library(session)
    faces = [r for r in library.by_family.values() if r.embeddable and fontsvc.family_stem(r.basefont) == "arial"]
    check("both same-named faces are kept", len(faces) == 2, str([(r.basefont, r.bold) for r in faces]))
    para = paragraphs(session, 0)[0]
    runs = parasvc.serialize(para, library)["runs"]
    check("regular and bold runs point at different faces",
          len({r["fontId"] for r in runs}) == 2, str([(r["text"], r["fontId"]) for r in runs]))

    reflowsvc.edit_paragraph(session, 0, para.id, [para.runs()])
    spans = [s for b in session.doc[0].get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]]
    plain = next((s for s in spans if "Regular" in s["text"]), None)
    heavy = next((s for s in spans if "boldword" in s["text"]), None)
    check("regular text stays regular after an edit", plain is not None and not plain["flags"] & 16,
          str(plain and (plain["font"], plain["flags"])))
    check("bold text stays bold after an edit", heavy is not None and bool(heavy["flags"] & 16),
          str(heavy and (heavy["font"], heavy["flags"])))


def main() -> int:
    print("\n[1] Paragraph detection")
    session = fresh()
    paras = paragraphs(session, 0)
    first = find(session, 0, "Alpha")
    check("wrapped bullet is one paragraph", len(first.lines) == 2, str(len(first.lines)))
    check("bullet glyph attached as marker", first.marker is not None and first.marker.text in "•·",
          repr(first.marker))
    check("line pitch measured", abs(first.pitch - PITCH) < 0.05, str(first.pitch))
    check("wrap box covers the longest line", first.box_x1 >= max(l.x1 for l in first.lines), str(first.box_x1))
    check("item gap between bullets measured", abs(first.item_gap - 2.5) < 0.2, str(first.item_gap))
    check("headings are separate paragraphs", any(p.plain_text() == "EXPERIENCE" for p in paras))
    check("ids are in reading order", [p.id for p in paras] == ["p0g{0}".format(n) for n in range(len(paras))])
    layout = textsvc.serialize_layout(session, 0)
    check("page background detected", reflowsvc.page_background(session.doc[0]) != "#ffffff")
    check("layout still serialises", bool(layout["spans"]))
    frames = reflowsvc.frames(session.doc)
    check("page-number footer excluded from the body", frames[1].limit < 815, str(frames[1].limit))

    print("\n[2] Unchanged paragraphs re-render identically")
    for pno in (0, 1):
        before = rows(session, pno)
        for para_no in range(len(paragraphs(session, pno))):
            para = paragraphs(session, pno)[para_no]
            reflowsvc.edit_paragraph(session, pno, para.id, [para.runs()])
        after = rows(session, pno)
        same_lines = [t for _y, t in before] == [t for _y, t in after]
        drift = max(abs(a[0] - b[0]) for a, b in zip(before, after)) if same_lines else -1
        check("page {0}: every line keeps its words".format(pno + 1), same_lines,
              str(set(before) ^ set(after))[:200])
        check("page {0}: every baseline within 0.2pt".format(pno + 1), 0 <= drift <= 0.2, str(drift))
    check("no page added by no-op edits", session.doc.page_count == 2, str(session.doc.page_count))

    print("\n[3] Growing a paragraph pushes the content below down")
    session = fresh()
    para = find(session, 0, "Alpha")
    heading_before = baseline_of(session, 0, "PROJECTS")
    footer_before = baseline_of(session, 0, "1")
    link_before = [l["from"].y0 for l in session.doc[0].get_links() if l.get("uri") == "https://project.example"][0]
    runs = para.runs()
    runs[-1]["text"] += (" and it now carries a much longer extra sentence that certainly needs"
                         " a whole new line of its own to fit in here.")
    result = reflowsvc.edit_paragraph(session, 0, para.id, [runs])
    grown = find(session, 0, "Alpha")
    check("paragraph gained a line", len(grown.lines) == 3, str(len(grown.lines)))
    check("first baseline unchanged", abs(grown.first_baseline - para.first_baseline) < 0.1)
    moved = baseline_of(session, 0, "PROJECTS") - heading_before
    check("heading below moved down exactly one line", abs(moved - PITCH) < 0.2, str(moved))
    check("footer stayed put", abs(baseline_of(session, 0, "1") - footer_before) < 0.01)
    link_after = [l["from"].y0 for l in session.doc[0].get_links() if l.get("uri") == "https://project.example"]
    check("link moved with its text", link_after and abs(link_after[0] - link_before - PITCH) < 0.2, str(link_after))
    check("only page 1 changed", result["pagesChanged"] == [0], str(result))
    check("moved text is still real text", "PROJECTS" in session.doc[0].get_text())

    print("\n[4] Overflow flows onto a new page, like a word processor")
    session = fresh()
    para = paragraphs(session, 1)[2]
    runs = para.runs()
    runs[-1]["text"] += " " + " ".join(LOREM * 2)
    result = reflowsvc.edit_paragraph(session, 1, para.id, [runs])
    check("a page was added", session.doc.page_count == 3 and result["pagesAdded"] == 1, str(result))
    third = session.doc[2]
    text3 = third.get_text()
    check("overflow landed on the new page", "English, Malayalam, Hindi" in text3)
    check("heading kept with its content", "LANGUAGES" in text3 and "LANGUAGES" not in session.doc[1].get_text())
    check("new page keeps the background", has_background(third))
    check("page number not copied to the new page", "2" not in text3.split())
    check("page 2 stays within its bottom margin",
          max(w[3] for w in session.doc[1].get_text("words") if w[4] != "2") <= reflowsvc.frames(session.doc)[1].limit + 1)
    first_on_3 = min(w[1] for w in third.get_text("words"))
    check("overflow starts at the top margin", 20 < first_on_3 < 40, str(first_on_3))

    print("\n[5] Enter adds a list item with its own bullet")
    session = fresh()
    para = find(session, 0, "Bravo")
    bullets_before = bullets(session, 0)
    charlie_before = baseline_of(session, 0, "Charlie")
    reflowsvc.edit_paragraph(session, 0, para.id, [para.runs(), [{"text": "Newitem typed after pressing Enter."}]])
    check("one more bullet glyph", bullets(session, 0) == bullets_before + 1,
          "{0} -> {1}".format(bullets_before, bullets(session, 0)))
    new_item = baseline_of(session, 0, "Newitem")
    expected = para.last_baseline + PITCH + para.item_gap
    check("new item spaced like its siblings", new_item is not None and abs(new_item - expected) < 0.3,
          "{0} vs {1}".format(new_item, expected))
    shift = baseline_of(session, 0, "Charlie") - charlie_before
    check("next item pushed down by one item", abs(shift - (PITCH + para.item_gap)) < 0.3, str(shift))

    print("\n[6] Deleting a paragraph pulls the content up")
    session = fresh()
    para = find(session, 0, "Bravo")
    bullets_before = bullets(session, 0)
    reflowsvc.edit_paragraph(session, 0, para.id, [[]])
    check("its bullet is gone too", bullets(session, 0) == bullets_before - 1,
          "{0} -> {1}".format(bullets_before, bullets(session, 0)))
    check("its text is gone", "Bravo" not in session.doc[0].get_text())
    pulled = baseline_of(session, 0, "Charlie")
    check("next item moved into its place", pulled is not None and abs(pulled - para.first_baseline) < 0.3,
          "{0} vs {1}".format(pulled, para.first_baseline))

    print("\n[7] Backspace at the start removes blank space above")
    session = fresh()
    para = find(session, 0, "Bravo")
    step = PITCH + para.item_gap
    reflowsvc.edit_paragraph(session, 0, para.id, [para.runs(), [], [], [], [{"text": "Typedafter blank lines."}]])
    typed = find(session, 0, "Typedafter")
    gap_before = typed.first_baseline - para.last_baseline
    check("blank items left blank space", abs(gap_before - 4 * step) < 0.5, str(gap_before))
    elements = reflowsvc.page_elements(session.doc[0])
    space = reflowsvc.liftable(elements, typed)
    check("that space is reported as removable", space >= 3 * step - 0.5, "{0} vs {1}".format(space, 3 * step))
    charlie_before = baseline_of(session, 0, "Charlie")
    bullets_before = bullets(session, 0)
    reflowsvc.edit_paragraph(session, 0, typed.id, [typed.runs()], lift=3 * step)
    lifted = baseline_of(session, 0, "Typedafter")
    check("paragraph moved up into the space", lifted is not None and abs(lifted - para.last_baseline - step) < 0.5,
          "{0} vs {1}".format(lifted, para.last_baseline + step))
    pulled = charlie_before - baseline_of(session, 0, "Charlie")
    check("content below moved up with it", abs(pulled - 3 * step) < 0.5, str(pulled))
    check("its bullet moved, not duplicated", bullets(session, 0) == bullets_before,
          "{0} -> {1}".format(bullets_before, bullets(session, 0)))
    again = find(session, 0, "Typedafter")
    reflowsvc.edit_paragraph(session, 0, again.id, [again.runs()], lift=500)
    floor = baseline_of(session, 0, "Typedafter") - para.last_baseline
    check("lift stops a line below the text above", floor > SIZE and floor <= step + 0.5, str(floor))
    top = paragraphs(session, 0)[0]
    check("nothing above means nothing to remove",
          reflowsvc.liftable(reflowsvc.page_elements(session.doc[0]), top) == 0.0)

    print("\n[8] Faces that share one name")
    same_name_faces()

    print("\n[9] Styling, undo and safety")
    session = fresh()
    para = find(session, 0, "Bravo")
    reflowsvc.edit_paragraph(session, 0, para.id, [[{"text": "Boldstart", "bold": True}, {"text": " then regular text."}]])
    spans = [s for b in session.doc[0].get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]]
    bold = next((s for s in spans if "Boldstart" in s["text"]), None)
    check("bold run is bold", bold is not None and bool(bold["flags"] & 16 or "Bold" in bold["font"]), str(bold and bold["font"]))
    original = build_sample()
    session = store.open(original, "sample.pdf")
    para = paragraphs(session, 1)[2]
    reflowsvc.edit_paragraph(session, 1, para.id, [[{"text": " ".join(LOREM * 3)}]])
    session.undo()
    check("undo restores the page count", session.doc.page_count == 2)
    check("undo restores the text", "LANGUAGES" in session.doc[1].get_text())
    try:
        reflowsvc.edit_paragraph(session, 0, "p0g999", [[{"text": "x"}]])
        check("unknown paragraph rejected", False)
    except DocumentError:
        check("unknown paragraph rejected", True)
    pages_before = session.doc.page_count
    try:
        reflowsvc.edit_paragraph(session, 0, paragraphs(session, 0)[0].id, [[{"text": "x" * 6000}]])
    except DocumentError:
        pass
    check("a failed edit leaves the document intact", session.doc.page_count == pages_before
          and "EXPERIENCE" in session.doc[0].get_text())

    print("\n" + "=" * 62)
    print("PASSED {0}   FAILED {1}".format(len(PASSES), len(FAILURES)))
    print("=" * 62)
    for failure in FAILURES:
        print("  - " + failure)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
