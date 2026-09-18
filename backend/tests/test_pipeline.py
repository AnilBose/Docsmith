"""End-to-end checks for the editing pipeline.

Run with:  .venv/Scripts/python.exe -m pytest tests -q
or simply: .venv/Scripts/python.exe tests/test_pipeline.py
"""
from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402
from PIL import Image  # noqa: E402

from app.core.session import store  # noqa: E402
from app.services import fonts as fontsvc  # noqa: E402
from app.services import images as imgsvc  # noqa: E402
from app.services import pages as pagesvc  # noqa: E402
from app.services import redaction as redsvc  # noqa: E402
from app.services import security as secsvc  # noqa: E402
from app.services import text as textsvc  # noqa: E402

PASSES: list[str] = []
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSES.append(name)
        print("  PASS  {0}".format(name))
    else:
        FAILURES.append("{0} :: {1}".format(name, detail))
        print("  FAIL  {0}  {1}".format(name, detail))


# --------------------------------------------------------------------------- #
def build_sample() -> bytes:
    """A document with varied typography, a photo and sensitive strings."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.insert_text((72, 100), "Quarterly Report", fontname="hebo", fontsize=24,
                     color=(0.05, 0.15, 0.45))
    page.insert_text((72, 140), "Prepared by the finance team", fontname="tiit",
                     fontsize=12, color=(0.35, 0.35, 0.35))
    page.insert_text((72, 190), "Revenue grew by 14 percent this quarter.",
                     fontname="helv", fontsize=11)
    page.insert_text((72, 212), "Contact: jane.doe@example.com or +1 415 555 0134.",
                     fontname="helv", fontsize=11)
    page.insert_text((72, 234), "Reference SSN 123-45-6789 must not be published.",
                     fontname="helv", fontsize=11)
    page.insert_text((72, 256), "The recieve of goods was delayed.",
                     fontname="helv", fontsize=11)

    # A deterministic photo-like image so we can prove it survives text edits.
    swatch = Image.new("RGB", (240, 160))
    swatch.putdata([
        ((x * 7) % 256, (y * 11) % 256, (x * y) % 256)
        for y in range(160) for x in range(240)
    ])
    buffer = io.BytesIO()
    swatch.save(buffer, format="PNG")
    page.insert_image(fitz.Rect(320, 320, 560, 480), stream=buffer.getvalue())

    # Vector art, to confirm redaction of text leaves drawings alone.
    page.draw_rect(fitz.Rect(72, 320, 280, 420), color=(0.8, 0.2, 0.2), width=2)

    doc.new_page(width=595, height=842).insert_text(
        (72, 100), "Second page body text.", fontname="helv", fontsize=11
    )

    data = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return data


def image_digest(session) -> list[tuple[int, int, bytes]]:
    """Fingerprint every stored image stream so we can prove it is untouched."""
    out = []
    for pno in range(session.doc.page_count):
        for info in session.doc[pno].get_images(full=True):
            try:
                stored = session.doc.extract_image(info[0])
                out.append((pno, len(stored["image"]), stored["image"][:64]))
            except Exception:
                continue
    return sorted(out)


# --------------------------------------------------------------------------- #
def main() -> int:
    sample = build_sample()
    session = store.open(sample, "sample.pdf")
    print("\n[1] Open and inspect")
    check("opens with 2 pages", session.doc.page_count == 2, str(session.doc.page_count))

    layout = textsvc.serialize_layout(session, 0)
    check("layout returns spans", len(layout["spans"]) >= 6, str(len(layout["spans"])))
    titles = [s for s in layout["spans"] if "Quarterly" in s["text"]]
    check("title span found", bool(titles))
    if titles:
        title = titles[0]
        check("title size is 24", abs(title["size"] - 24) < 0.6, str(title["size"]))
        check("title is bold", title["bold"] is True, str(title))
        check("title colour read back", title["color"].startswith("#"), title["color"])

    print("\n[2] Font library")
    library = fontsvc.build_library(session)
    check("fonts discovered", len(library.records) >= 3, str(len(library.records)))
    families = fontsvc.available_families(session)
    check("font picker populated", len(families) >= 3, str(len(families)))

    print("\n[3] Edit existing text, preserving everything else")
    before_images = image_digest(session)
    before_drawings = len(session.doc[0].get_drawings())
    target = titles[0]
    result = textsvc.apply_edits(session, [{
        "page": 0,
        "action": "replace",
        "spanIds": [target["id"]],
        "text": "Annual Report",
        "style": {"color": "#8b0000", "size": 24, "bold": True, "align": "left"},
    }])
    check("edit applied", result["applied"] == 1, str(result))

    page_text = session.doc[0].get_text("text")
    check("new text present", "Annual Report" in page_text)
    check("old text gone", "Quarterly Report" not in page_text)
    check("other text intact", "Revenue grew by 14 percent" in page_text)
    check("images byte-identical after text edit",
          image_digest(session) == before_images, "image streams changed")
    check("vector art intact after text edit",
          len(session.doc[0].get_drawings()) >= before_drawings,
          "{0} -> {1}".format(before_drawings, len(session.doc[0].get_drawings())))

    new_layout = textsvc.serialize_layout(session, 0)
    edited = [s for s in new_layout["spans"] if "Annual" in s["text"]]
    check("edited span keeps size", bool(edited) and abs(edited[0]["size"] - 24) < 1.5,
          str(edited[0]["size"]) if edited else "missing")
    check("edited span keeps colour", bool(edited) and edited[0]["color"] == "#8b0000",
          edited[0]["color"] if edited else "missing")

    print("\n[4] Undo / redo")
    check("can undo", session.can_undo)
    session.undo()
    check("undo restores original text", "Quarterly Report" in session.doc[0].get_text("text"))
    session.redo()
    check("redo re-applies edit", "Annual Report" in session.doc[0].get_text("text"))

    print("\n[5] Search and replace")
    hits = textsvc.search(session, "Revenue")
    check("search finds a hit", len(hits) == 1, str(len(hits)))
    check("search returns rects", bool(hits and hits[0]["rects"]))
    regex_hits = textsvc.search(session, r"\d+ percent", regex=True)
    check("regex search works", len(regex_hits) == 1, str(len(regex_hits)))
    rep = textsvc.replace(session, "14 percent", "22 percent")
    check("replace applied", rep["replaced"] == 1, str(rep))
    check("replacement visible", "22 percent" in session.doc[0].get_text("text"))
    check("original gone", "14 percent" not in session.doc[0].get_text("text"))

    print("\n[6] Add and delete text")
    textsvc.apply_edits(session, [{
        "page": 1,
        "action": "insert",
        "rect": [72, 200, 500, 260],
        "text": "Inserted paragraph with custom styling.",
        "style": {"size": 13, "color": "#006400", "italic": True,
                  "align": "center", "lineHeight": 1.4, "letterSpacing": 0.5},
    }])
    check("text inserted", "Inserted paragraph" in session.doc[1].get_text("text"))

    layout1 = textsvc.serialize_layout(session, 1)
    victims = [s["id"] for s in layout1["spans"] if "Second page" in s["text"]]
    textsvc.apply_edits(session, [{"page": 1, "action": "delete", "spanIds": victims}])
    check("text deleted", "Second page body text" not in session.doc[1].get_text("text"))
    check("neighbour text survived deletion",
          "Inserted paragraph" in session.doc[1].get_text("text"))

    print("\n[7] Capitalisation")
    check("upper", textsvc.change_case("hello world", "upper") == "HELLO WORLD")
    check("title", textsvc.change_case("hello world", "title") == "Hello World")
    check("sentence", textsvc.change_case("hello. there", "sentence").startswith("Hello."))

    print("\n[8] Images")
    listed = imgsvc.list_images(session, 0)
    check("image listed", len(listed) == 1, str(len(listed)))
    xref = listed[0]["xref"]
    original_box = listed[0]["bbox"]

    moved = imgsvc.transform_image(session, 0, xref, rect=[300, 300, 540, 460])
    check("move keeps stream (no recompression)", moved["recompressed"] is False, str(moved))
    check("move changed the box", moved["bbox"][0] != original_box[0])

    listed = imgsvc.list_images(session, 0)
    rotated = imgsvc.transform_image(session, 0, listed[0]["xref"], rotate=90)
    check("rotate reports recompression", rotated["recompressed"] is True)

    listed = imgsvc.list_images(session, 0)
    cropped = imgsvc.transform_image(
        session, 0, listed[0]["xref"], crop=[0.25, 0.25, 0.75, 0.75], flip_h=True, opacity=0.6
    )
    check("crop produced a smaller raster", cropped["pixelSize"][0] < 240, str(cropped["pixelSize"]))

    listed = imgsvc.list_images(session, 0)
    blob, ext = imgsvc.extract(session, listed[0]["xref"])
    check("image extracted", len(blob) > 100 and ext in {"png", "jpeg", "jpg"}, ext)

    thumb = imgsvc.render_thumbnail(session, listed[0]["xref"])
    check("thumbnail rendered", thumb.startswith(b"\x89PNG"))

    imgsvc.delete_image(session, 0, listed[0]["xref"])
    check("image deleted", len(imgsvc.list_images(session, 0)) == 0)
    check("text survived image delete", "Annual Report" in session.doc[0].get_text("text"))

    print("\n[9] Page operations")
    pagesvc.add_blank(session)
    check("blank added", session.doc.page_count == 3, str(session.doc.page_count))
    pagesvc.duplicate_pages(session, [0])
    check("page duplicated", session.doc.page_count == 4, str(session.doc.page_count))
    pagesvc.rotate_pages(session, [0], 90)
    check("page rotated", session.doc[0].rotation == 90, str(session.doc[0].rotation))
    pagesvc.reorder(session, [3, 2, 1, 0])
    check("reorder kept page count", session.doc.page_count == 4)
    pagesvc.delete_pages(session, [3])
    check("page deleted", session.doc.page_count == 3, str(session.doc.page_count))

    check("page spec 1-2", pagesvc.parse_page_spec("1-2", 5) == [0, 1])
    check("page spec 1,3", pagesvc.parse_page_spec("1,3", 5) == [0, 2])
    check("page spec 4-", pagesvc.parse_page_spec("4-", 5) == [3, 4])

    extracted = pagesvc.extract_pages(session, [0, 1])
    check("pages extracted to new doc", extracted.doc.page_count == 2)

    parts = pagesvc.split(session, every=2)
    check("split into parts", len(parts) == 2, str(len(parts)))

    merged = pagesvc.merge([session, extracted])
    check("merge page count",
          merged.doc.page_count == session.doc.page_count + 2,
          str(merged.doc.page_count))

    other = store.open(build_sample(), "other.pdf")
    pagesvc.insert_from(session, other, at=0, pages=[1])
    check("insert from another PDF", session.doc.page_count == 4, str(session.doc.page_count))

    before_src, before_dst = other.doc.page_count, session.doc.page_count
    pagesvc.move_between(other, session, [0])
    check("move between documents",
          other.doc.page_count == before_src - 1 and session.doc.page_count == before_dst + 1,
          "{0}/{1}".format(other.doc.page_count, session.doc.page_count))

    pagesvc.add_cover(session, title="Cover", subtitle="2026")
    check("cover added", "Cover" in session.doc[0].get_text("text"))
    pagesvc.add_page_numbers(session, template="Page {n} of {total}")
    check("page numbers added", "Page 1 of" in session.doc[0].get_text("text"))

    print("\n[10] Annotations")
    from app.services import annotations as annsvc

    ann_doc = store.open(build_sample(), "ann.pdf")
    hit = textsvc.search(ann_doc, "Revenue")[0]
    highlight = annsvc.add_markup(ann_doc, 0, "highlight", hit["rects"], color="#ffe14d")
    check("highlight created", highlight["type"] == "Highlight", highlight["type"])
    annsvc.add_markup(ann_doc, 0, "underline", hit["rects"])
    annsvc.add_markup(ann_doc, 0, "strikeout", hit["rects"])
    note = annsvc.add_note(ann_doc, 0, [400, 120], "Check this figure.")
    check("note created", note["contents"] == "Check this figure.")
    check("annotations listed", len(annsvc.list_annotations(ann_doc, 0)) == 4,
          str(len(annsvc.list_annotations(ann_doc, 0))))
    annsvc.delete_annotation(ann_doc, 0, note["xref"])
    check("annotation deleted", len(annsvc.list_annotations(ann_doc, 0)) == 3)

    print("\n[11] Redaction")
    red = store.open(build_sample(), "red.pdf")
    findings = redsvc.detect(red, ["email", "ssn"])
    kinds = {f["kind"] for f in findings}
    check("email detected", "email" in kinds, str(kinds))
    check("ssn detected", "ssn" in kinds, str(kinds))
    check("email text correct",
          any("jane.doe@example.com" in f["text"] for f in findings),
          str([f["text"] for f in findings]))

    redsvc.mark(red, findings)
    check("marks staged", len(redsvc.list_marks(red)) == len(findings))
    redsvc.apply(red)
    check("marks consumed", len(redsvc.list_marks(red)) == 0)

    remaining = red.doc[0].get_text("text")
    check("email removed from content", "jane.doe@example.com" not in remaining)
    check("ssn removed from content", "123-45-6789" not in remaining)
    check("unrelated text kept", "Revenue grew" in remaining)

    raw = red.serialize()
    check("email absent from raw file bytes", b"jane.doe@example.com" not in raw)
    verdict = redsvc.verify(red, ["jane.doe@example.com", "123-45-6789"])
    check("verify reports clean", verdict["clean"] is True, str(verdict))

    area_doc = store.open(build_sample(), "area.pdf")
    redsvc.redact_area(area_doc, 0, [60, 180, 540, 200])
    check("area redaction removed the line",
          "Revenue grew" not in area_doc.doc[0].get_text("text"))

    print("\n[12] Search-and-redact")
    sr = store.open(build_sample(), "sr.pdf")
    matches = redsvc.find_text(sr, "finance team")
    check("search-and-redact found match", len(matches) == 1, str(len(matches)))
    redsvc.mark(sr, matches)
    redsvc.apply(sr)
    check("phrase redacted", "finance team" not in sr.doc[0].get_text("text"))

    print("\n[13] Encryption and permissions")
    sec = store.open(build_sample(), "sec.pdf")
    perms = secsvc.PermissionSet.from_payload(
        {"copyContent": False, "printDocument": False, "modifyContent": False}
    )
    encrypted = secsvc.encrypt(
        sec, open_password="s3cret!", owner_password="0wner!", permissions=perms
    )
    check("encrypted output produced", encrypted.startswith(b"%PDF"))

    probe = fitz.open(stream=encrypted, filetype="pdf")
    check("encrypted file needs a password", bool(probe.needs_pass) is True)
    check("wrong password rejected", probe.authenticate("nope") == 0)
    check("correct password accepted", probe.authenticate("s3cret!") > 0)
    check("copy permission denied", not bool(probe.permissions & (1 << 4)),
          str(probe.permissions))
    check("print permission denied", not bool(probe.permissions & (1 << 2)),
          str(probe.permissions))
    probe.close()

    plain = secsvc.remove_password(encrypted, "s3cret!")
    reopened = fitz.open(stream=plain, filetype="pdf")
    check("password removed", bool(reopened.needs_pass) is False)
    reopened.close()

    try:
        secsvc.encrypt(sec, open_password="abc")
        check("short password rejected", False, "no error raised")
    except Exception as exc:
        check("short password rejected", "at least" in str(exc), str(exc))

    print("\n[14] Spell check")
    from app.services import spell as spellsvc

    sp = store.open(build_sample(), "sp.pdf")
    try:
        issues = spellsvc.check(sp, pages=[0], language="en")
        words = {i["word"].lower() for i in issues}
        check("misspelling detected", "recieve" in words, str(sorted(words))[:200])
        suggestion = next(
            (i["suggestions"] for i in issues if i["word"].lower() == "recieve"), []
        )
        check("suggestion offered", "receive" in suggestion, str(suggestion))
    except Exception as exc:
        check("spell check ran", False, str(exc))

    print("\n[15] Export")
    from app.services import convert as convsvc

    ex = store.open(build_sample(), "ex.pdf")
    txt, name, mime = convsvc.export(ex, "txt")
    check("txt export", b"Quarterly Report" in txt and name.endswith(".txt"), name)
    html, name, _ = convsvc.export(ex, "html")
    check("html export", b"<html" in html.lower() and name.endswith(".html"), name)
    png, name, mime = convsvc.export(ex, "png", pages=[0])
    check("png export", png.startswith(b"\x89PNG") and mime == "image/png", mime)
    zipped, name, mime = convsvc.export(ex, "png")
    check("multi-page png export is a zip", mime == "application/zip", mime)

    pdf_from_text = convsvc.text_to_pdf("Hello from plain text.\nSecond line.")
    check("text -> pdf", pdf_from_text.startswith(b"%PDF"))
    tp = fitz.open(stream=pdf_from_text, filetype="pdf")
    check("text -> pdf content", "Hello from plain text." in tp[0].get_text("text"))
    tp.close()

    swatch = Image.new("RGB", (120, 90), (10, 120, 200))
    buf = io.BytesIO()
    swatch.save(buf, format="PNG")
    img_pdf = convsvc.images_to_pdf([(buf.getvalue(), "a.png"), (buf.getvalue(), "b.png")])
    ip = fitz.open(stream=img_pdf, filetype="pdf")
    check("images -> pdf", ip.page_count == 2, str(ip.page_count))
    ip.close()

    caps = convsvc.capabilities()
    check("capabilities reported", "toPdf" in caps and "fromPdf" in caps)

    print("\n[16] Hardening")
    js_doc = fitz.open()
    js_page = js_doc.new_page()
    js_page.insert_text((72, 72), "hello")
    js_bytes = js_doc.tobytes()
    js_doc.close()
    hardened = store.open(js_bytes, "js.pdf")
    catalog = hardened.doc.pdf_catalog()
    check("OpenAction cleared",
          hardened.doc.xref_get_key(catalog, "OpenAction")[0] in {"null", "xnone"},
          str(hardened.doc.xref_get_key(catalog, "OpenAction")))

    sanitized = secsvc.sanitize(hardened)
    check("sanitize ran", sanitized["metadataCleared"] is True)

    print("\n" + "=" * 62)
    print("PASSED {0}   FAILED {1}".format(len(PASSES), len(FAILURES)))
    if FAILURES:
        print("-" * 62)
        for failure in FAILURES:
            print("  " + failure)
    print("=" * 62)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
