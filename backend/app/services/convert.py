"""Conversion in and out of PDF.

Everything runs locally. Office formats go through a headless LibreOffice
started with a throwaway profile and no network stack; HTML goes through
WeasyPrint with a URL fetcher that refuses every remote scheme, so a malicious
document cannot turn a conversion into an outbound request (SSRF).
"""
from __future__ import annotations

import csv
import io
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Sequence

import fitz

from app.config import settings
from app.core.session import DocumentError, DocumentSession

SOFFICE_TIMEOUT = int(os.getenv("PDFE_SOFFICE_TIMEOUT", "180"))

OFFICE_INPUTS = {
    ".doc", ".docx", ".odt", ".rtf",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
}
IMAGE_INPUTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"}
TEXT_INPUTS = {".txt", ".md", ".log"}
HTML_INPUTS = {".html", ".htm", ".xhtml"}


# --------------------------------------------------------------------------- #
# TO PDF
# --------------------------------------------------------------------------- #
def to_pdf(data: bytes, filename: str) -> bytes:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return data
    if suffix in OFFICE_INPUTS:
        return office_to_pdf(data, suffix)
    if suffix in IMAGE_INPUTS:
        return images_to_pdf([(data, filename)])
    if suffix in HTML_INPUTS:
        return html_to_pdf(data.decode("utf-8", errors="replace"))
    if suffix in TEXT_INPUTS or not suffix:
        return text_to_pdf(data.decode("utf-8", errors="replace"))
    raise DocumentError("Cannot convert '{0}' to PDF.".format(suffix or filename))


def office_to_pdf(data: bytes, suffix: str) -> bytes:
    """Word / Excel / PowerPoint -> PDF via headless LibreOffice."""
    binary = settings.soffice
    if not binary:
        raise DocumentError(
            "LibreOffice was not found. Install it (libreoffice.org) to convert "
            "Word, Excel and PowerPoint files, or set PDFE_SOFFICE to its path."
        )

    workdir = Path(tempfile.mkdtemp(prefix="pdfe-office-", dir=settings.scratch_dir))
    profile = workdir / "profile"
    source = workdir / ("input" + suffix)
    try:
        source.write_bytes(data)
        result = subprocess.run(
            [
                binary,
                "-env:UserInstallation=file:///{0}".format(
                    str(profile).replace("\\", "/").lstrip("/")
                ),
                "--headless",
                "--invisible",
                "--nologo",
                "--nolockcheck",
                "--norestore",
                "--nodefault",
                "--convert-to",
                "pdf:writer_pdf_Export" if suffix in {".doc", ".docx", ".odt", ".rtf"} else "pdf",
                "--outdir",
                str(workdir),
                str(source),
            ],
            capture_output=True,
            timeout=SOFFICE_TIMEOUT,
            check=False,
        )
        produced = workdir / "input.pdf"
        if not produced.exists():
            detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace")[:400]
            raise DocumentError("LibreOffice could not convert that file. {0}".format(detail))
        return produced.read_bytes()
    except subprocess.TimeoutExpired as exc:
        raise DocumentError("The conversion timed out after {0}s.".format(SOFFICE_TIMEOUT)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def images_to_pdf(
    items: Sequence[tuple[bytes, str]],
    *,
    page_size: str = "fit",
    margin: float = 0.0,
) -> bytes:
    """One image per page. ``fit`` sizes each page to its image."""
    if not items:
        raise DocumentError("No images were supplied.")
    doc = fitz.open()
    presets = {"a4": (595.28, 841.89), "letter": (612.0, 792.0), "legal": (612.0, 1008.0)}

    for data, name in items:
        try:
            img = fitz.open(stream=data, filetype=Path(name).suffix.lstrip(".") or "png")
            rect = img[0].rect
            pdf_bytes = img.convert_to_pdf()
            img.close()
        except Exception as exc:
            raise DocumentError("'{0}' is not a readable image: {1}".format(name, exc)) from exc

        src = fitz.open("pdf", pdf_bytes)
        if page_size == "fit":
            page = doc.new_page(width=rect.width + margin * 2, height=rect.height + margin * 2)
            target = fitz.Rect(margin, margin, margin + rect.width, margin + rect.height)
        else:
            pw, ph = presets.get(page_size, presets["a4"])
            page = doc.new_page(width=pw, height=ph)
            avail = fitz.Rect(margin, margin, pw - margin, ph - margin)
            scale = min(avail.width / rect.width, avail.height / rect.height)
            w, h = rect.width * scale, rect.height * scale
            cx, cy = pw / 2, ph / 2
            target = fitz.Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
        page.show_pdf_page(target, src, 0)
        src.close()

    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out


def text_to_pdf(
    text: str,
    *,
    font_size: float = 11.0,
    font: str = "helv",
    page_size: str = "a4",
    margin: float = 56.0,
) -> bytes:
    import html as _html

    presets = {"a4": (595.28, 841.89), "letter": (612.0, 792.0), "legal": (612.0, 1008.0)}
    width, height = presets.get(page_size, presets["a4"])
    doc = fitz.open()
    css = (
        "#body {{ font-family: {0}; font-size: {1}px; line-height: 1.45; "
        "white-space: pre-wrap; margin: 0; }}"
    ).format("monospace" if font in {"courier", "mono"} else "sans-serif", font_size)

    remaining = _html.escape(text).replace("\n", "<br/>")
    guard = 0
    while remaining and guard < 5000:
        page = doc.new_page(width=width, height=height)
        box = fitz.Rect(margin, margin, width - margin, height - margin)
        spare, _ = page.insert_htmlbox(
            box, '<div id="body">{0}</div>'.format(remaining), css=css
        )
        if spare >= 0:
            break
        # Split roughly in half by line count and retry the remainder.
        lines = remaining.split("<br/>")
        if len(lines) < 2:
            break
        keep = max(1, int(len(lines) * (box.height / (box.height + abs(spare)))))
        doc.delete_page(doc.page_count - 1)
        page = doc.new_page(width=width, height=height)
        page.insert_htmlbox(
            box, '<div id="body">{0}</div>'.format("<br/>".join(lines[:keep])), css=css
        )
        remaining = "<br/>".join(lines[keep:])
        guard += 1

    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out


_SCRIPT_RE = re.compile(
    r"<\s*(script|iframe|object|embed|applet)\b.*?<\s*/\s*\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_SELF_CLOSING_RE = re.compile(
    r"<\s*(script|iframe|object|embed|applet|link)\b[^>]*/?>", re.IGNORECASE
)
_EVENT_ATTR_RE = re.compile(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)


def sanitize_html(html_text: str) -> str:
    """Strip anything executable or externally-loaded before rendering.

    HTML arriving here can come from an untrusted file, and both renderers can
    be talked into fetching URLs. Removing scripts, frames and event handlers
    up front means a converted page can never act as a request forgery.
    """
    cleaned = _SCRIPT_RE.sub("", html_text)
    cleaned = _SELF_CLOSING_RE.sub("", cleaned)
    cleaned = _EVENT_ATTR_RE.sub("", cleaned)
    return cleaned


def _blocked_fetcher(url: str):
    """WeasyPrint URL fetcher that permits only inline data: URIs."""
    if url.startswith("data:"):
        from weasyprint.urls import default_url_fetcher

        return default_url_fetcher(url)
    raise DocumentError(
        "This HTML references an external resource ({0}). Remote fetching is "
        "disabled; inline your CSS and images as data: URIs.".format(url[:80])
    )


def _html_to_pdf_weasyprint(html_text: str, base_url: str | None) -> bytes:
    from weasyprint import HTML

    return HTML(
        string=html_text, base_url=base_url, url_fetcher=_blocked_fetcher
    ).write_pdf()


def _html_to_pdf_story(html_text: str, *, page_size: str = "a4", margin: float = 42.0) -> bytes:
    """Fallback renderer built on PyMuPDF's Story engine.

    It supports a practical subset of HTML and CSS -- headings, paragraphs,
    lists, tables, spans, fonts, colours, alignment -- and needs no native
    libraries, so it works on a clean Windows install where WeasyPrint's GTK
    stack is absent.
    """
    buffer = io.BytesIO()
    mediabox = fitz.paper_rect(page_size)
    frame = mediabox + (margin, margin, -margin, -margin)

    story = fitz.Story(html=html_text)
    writer = fitz.DocumentWriter(buffer)
    more, guard = 1, 0
    while more and guard < 2000:
        device = writer.begin_page(mediabox)
        more, _filled = story.place(frame)
        story.draw(device)
        writer.end_page()
        guard += 1
    writer.close()

    data = buffer.getvalue()
    if not data.startswith(b"%PDF"):
        raise DocumentError("The HTML produced no printable content.")
    return data


def html_to_pdf(html_text: str, *, base_url: str | None = None) -> bytes:
    """HTML -> PDF. Uses WeasyPrint for full CSS when it is installed."""
    cleaned = sanitize_html(html_text)
    errors: list[str] = []

    try:
        return _html_to_pdf_weasyprint(cleaned, base_url)
    except DocumentError:
        raise                       # an external-resource refusal is deliberate
    except Exception as exc:
        errors.append("WeasyPrint: {0}".format(str(exc).splitlines()[0][:120]))

    try:
        return _html_to_pdf_story(cleaned)
    except DocumentError:
        raise
    except Exception as exc:
        errors.append("Story renderer: {0}".format(str(exc)[:120]))

    raise DocumentError("HTML conversion failed. " + "; ".join(errors))


def html_renderer() -> str:
    """Which HTML engine this installation will actually use."""
    try:
        import weasyprint  # noqa: F401

        return "weasyprint"
    except Exception:
        return "pymupdf-story"


# --------------------------------------------------------------------------- #
# FROM PDF
# --------------------------------------------------------------------------- #
def to_images(
    session: DocumentSession,
    *,
    fmt: str = "png",
    dpi: int = 200,
    pages: Sequence[int] | None = None,
) -> tuple[bytes, str, str]:
    """Render pages. A single page returns the image; several return a ZIP."""
    fmt = fmt.lower()
    if fmt not in {"png", "jpg", "jpeg", "webp"}:
        raise DocumentError("Unsupported image format '{0}'.".format(fmt))
    dpi = max(36, min(dpi, 600))
    targets = list(pages) if pages is not None else list(range(session.doc.page_count))
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    stem = Path(session.filename).stem

    rendered: list[tuple[str, bytes]] = []
    for pno in targets:
        pix = session.doc[pno].get_pixmap(matrix=matrix, alpha=(fmt == "png"))
        if fmt in {"jpg", "jpeg"}:
            data = pix.tobytes("jpg", jpg_quality=95)
        else:
            data = pix.tobytes(fmt)
        rendered.append(("{0}-p{1}.{2}".format(stem, pno + 1, fmt), data))

    if len(rendered) == 1:
        name, data = rendered[0]
        mime = {"png": "image/png", "webp": "image/webp"}.get(fmt, "image/jpeg")
        return data, name, mime

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in rendered:
            archive.writestr(name, data)
    return buffer.getvalue(), "{0}-images.zip".format(stem), "application/zip"


def to_text(session: DocumentSession, pages: Sequence[int] | None = None) -> bytes:
    targets = list(pages) if pages is not None else list(range(session.doc.page_count))
    chunks = []
    for pno in targets:
        chunks.append(session.doc[pno].get_text("text"))
    return "\n\f\n".join(chunks).encode("utf-8")


def to_html(session: DocumentSession, pages: Sequence[int] | None = None) -> bytes:
    targets = list(pages) if pages is not None else list(range(session.doc.page_count))
    body = []
    for pno in targets:
        page_html = session.doc[pno].get_text("html")
        body.append('<section class="pdf-page" data-page="{0}">{1}</section>'.format(pno + 1, page_html))
    title = Path(session.filename).stem
    document = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<title>{0}</title><style>"
        ".pdf-page{{position:relative;margin:0 auto 24px;border:1px solid #ddd;"
        "background:#fff;overflow:hidden}}body{{background:#f3f3f3;margin:0;padding:24px}}"
        "</style></head><body>{1}</body></html>"
    ).format(title, "".join(body))
    return document.encode("utf-8")


def to_docx(session: DocumentSession, pages: Sequence[int] | None = None) -> bytes:
    """PDF -> Word using pdf2docx, which rebuilds paragraphs, styles and tables."""
    try:
        from pdf2docx import Converter
    except Exception as exc:
        raise DocumentError("pdf2docx is not installed: {0}".format(exc)) from exc

    workdir = Path(tempfile.mkdtemp(prefix="pdfe-docx-", dir=settings.scratch_dir))
    src = workdir / "in.pdf"
    dst = workdir / "out.docx"
    try:
        src.write_bytes(session.serialize())
        converter = Converter(str(src))
        try:
            if pages is not None:
                converter.convert(str(dst), pages=list(pages))
            else:
                converter.convert(str(dst))
        finally:
            converter.close()
        if not dst.exists():
            raise DocumentError("Word conversion produced no output.")
        return dst.read_bytes()
    except DocumentError:
        raise
    except Exception as exc:
        raise DocumentError("Word conversion failed: {0}".format(exc)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _extract_tables(session: DocumentSession, pages: Sequence[int] | None):
    """Yield ``(page_number, table_rows)`` for every detected table."""
    try:
        import pdfplumber
    except Exception as exc:
        raise DocumentError("pdfplumber is not installed: {0}".format(exc)) from exc

    data = session.serialize()
    targets = set(pages) if pages is not None else None
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for pno, page in enumerate(pdf.pages):
            if targets is not None and pno not in targets:
                continue
            tables = page.extract_tables() or []
            if tables:
                for table in tables:
                    yield pno, table
            else:
                # No ruled table: fall back to the page's text lines.
                text = page.extract_text() or ""
                rows = [[line] for line in text.splitlines() if line.strip()]
                if rows:
                    yield pno, rows


def to_xlsx(session: DocumentSession, pages: Sequence[int] | None = None) -> bytes:
    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise DocumentError("openpyxl is not installed: {0}".format(exc)) from exc

    workbook = Workbook()
    workbook.remove(workbook.active)
    counts: dict[int, int] = {}
    any_table = False

    for pno, table in _extract_tables(session, pages):
        counts[pno] = counts.get(pno, 0) + 1
        title = "P{0}" .format(pno + 1) if counts[pno] == 1 else "P{0}_{1}".format(pno + 1, counts[pno])
        sheet = workbook.create_sheet(title[:31])
        for row in table:
            sheet.append([_cell(v) for v in row])
        any_table = True

    if not any_table:
        sheet = workbook.create_sheet("Text")
        for pno in (pages if pages is not None else range(session.doc.page_count)):
            for line in session.doc[pno].get_text("text").splitlines():
                sheet.append([line])

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def to_csv(session: DocumentSession, pages: Sequence[int] | None = None) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    wrote = False
    for pno, table in _extract_tables(session, pages):
        if wrote:
            writer.writerow([])
        writer.writerow(["# page {0}".format(pno + 1)])
        for row in table:
            writer.writerow([_cell(v) for v in row])
        wrote = True
    if not wrote:
        writer.writerow(["page", "text"])
        for pno in (pages if pages is not None else range(session.doc.page_count)):
            for line in session.doc[pno].get_text("text").splitlines():
                writer.writerow([pno + 1, line])
    return buffer.getvalue().encode("utf-8-sig")


def _cell(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").strip()


def to_pptx(session: DocumentSession, *, dpi: int = 150, pages: Sequence[int] | None = None) -> bytes:
    """PDF -> PowerPoint: each page becomes a full-bleed slide image.

    A faithful vector-to-shape rebuild is not attempted; page images keep the
    layout exactly, which is what this conversion is normally wanted for.
    """
    try:
        from pptx import Presentation
        from pptx.util import Emu
    except Exception as exc:
        raise DocumentError("python-pptx is not installed: {0}".format(exc)) from exc

    targets = list(pages) if pages is not None else list(range(session.doc.page_count))
    if not targets:
        raise DocumentError("No pages selected.")

    first = session.doc[targets[0]].rect
    presentation = Presentation()
    presentation.slide_width = Emu(int(first.width / 72 * 914400))
    presentation.slide_height = Emu(int(first.height / 72 * 914400))
    blank = presentation.slide_layouts[6]
    matrix = fitz.Matrix(dpi / 72, dpi / 72)

    for pno in targets:
        page = session.doc[pno]
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        slide = presentation.slides.add_slide(blank)
        slide.shapes.add_picture(
            io.BytesIO(pix.tobytes("png")),
            0,
            0,
            width=Emu(int(page.rect.width / 72 * 914400)),
            height=Emu(int(page.rect.height / 72 * 914400)),
        )

    buffer = io.BytesIO()
    presentation.save(buffer)
    return buffer.getvalue()


EXPORTERS = {
    "txt": ("text/plain", ".txt"),
    "html": ("text/html", ".html"),
    "csv": ("text/csv", ".csv"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
}


def export(session: DocumentSession, fmt: str, *, pages: Sequence[int] | None = None, dpi: int = 200):
    fmt = fmt.lower()
    stem = Path(session.filename).stem

    if fmt in {"png", "jpg", "jpeg", "webp"}:
        return to_images(session, fmt=fmt, dpi=dpi, pages=pages)

    if fmt not in EXPORTERS:
        raise DocumentError("Unsupported export format '{0}'.".format(fmt))

    mime, suffix = EXPORTERS[fmt]
    builders = {
        "txt": lambda: to_text(session, pages),
        "html": lambda: to_html(session, pages),
        "csv": lambda: to_csv(session, pages),
        "docx": lambda: to_docx(session, pages),
        "xlsx": lambda: to_xlsx(session, pages),
        "pptx": lambda: to_pptx(session, dpi=dpi, pages=pages),
    }
    return builders[fmt](), stem + suffix, mime


def capabilities() -> dict:
    """What this installation can actually do right now."""
    has_office = settings.soffice is not None
    try:
        import pdf2docx  # noqa: F401
        has_docx = True
    except Exception:
        has_docx = False
    try:
        import pdfplumber  # noqa: F401
        has_tables = True
    except Exception:
        has_tables = False
    try:
        import pptx  # noqa: F401
        has_pptx = True
    except Exception:
        has_pptx = False

    return {
        "toPdf": {
            "word": has_office, "excel": has_office, "powerpoint": has_office,
            "images": True, "html": True, "text": True,
        },
        "fromPdf": {
            "word": has_docx, "excel": has_tables, "powerpoint": has_pptx,
            "images": True, "text": True, "html": True, "csv": has_tables,
        },
        "libreOffice": settings.soffice,
        "htmlRenderer": html_renderer(),
    }
