"""Conversion endpoints, both directions."""
from __future__ import annotations

import io
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from app.core.session import DocumentError, store
from app.routers.documents import get_session, summarize
from app.services import convert as convsvc
from app.services import pages as pagesvc

router = APIRouter(prefix="/api/convert", tags=["convert"])


def _guard(fn):
    try:
        return fn()
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/capabilities")
def capabilities():
    return convsvc.capabilities()


@router.post("/to-pdf")
async def to_pdf(files: list[UploadFile] = File(...), open_after: bool = Form(default=True)):
    """Convert one or more files to PDF. Several images become one document."""
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    payloads = [(await f.read(), f.filename or "file") for f in files]
    image_exts = convsvc.IMAGE_INPUTS

    if len(payloads) > 1 and all(
        ("." + name.rsplit(".", 1)[-1].lower()) in image_exts for _d, name in payloads
    ):
        data = _guard(lambda: convsvc.images_to_pdf(payloads))
        filename = "images.pdf"
    elif len(payloads) == 1:
        blob, name = payloads[0]
        data = _guard(lambda: convsvc.to_pdf(blob, name))
        filename = name.rsplit(".", 1)[0] + ".pdf"
    else:
        # Mixed batch: convert each and merge.
        import fitz

        merged = fitz.open()
        for blob, name in payloads:
            part = _guard(lambda b=blob, n=name: convsvc.to_pdf(b, n))
            with fitz.open(stream=part, filetype="pdf") as src:
                merged.insert_pdf(src)
        data = merged.tobytes(garbage=3, deflate=True)
        merged.close()
        filename = "converted.pdf"

    if open_after:
        session = _guard(lambda: store.open(data, filename))
        return {"document": summarize(session)}

    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(filename))},
    )


@router.post("/html-to-pdf")
async def html_to_pdf(html: str = Form(...), open_after: bool = Form(default=True)):
    data = _guard(lambda: convsvc.html_to_pdf(html))
    if open_after:
        return {"document": summarize(_guard(lambda: store.open(data, "page.pdf")))}
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=\"page.pdf\""},
    )


@router.post("/text-to-pdf")
async def text_to_pdf(
    text: str = Form(...),
    font_size: float = Form(default=11.0),
    page_size: str = Form(default="a4"),
    open_after: bool = Form(default=True),
):
    data = _guard(lambda: convsvc.text_to_pdf(text, font_size=font_size, page_size=page_size))
    if open_after:
        return {"document": summarize(_guard(lambda: store.open(data, "text.pdf")))}
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=\"text.pdf\""},
    )


@router.get("/{doc_id}/export")
def export(
    doc_id: str,
    format: str = Query(...),
    pages: str | None = Query(default=None),
    dpi: int = Query(default=200, ge=36, le=600),
):
    """PDF -> Word / Excel / PowerPoint / images / TXT / HTML / CSV."""
    session = get_session(doc_id)
    selection = None
    if pages:
        selection = _guard(lambda: pagesvc.parse_page_spec(pages, session.doc.page_count))

    data, filename, mime = _guard(
        lambda: convsvc.export(session, format, pages=selection, dpi=dpi)
    )
    return StreamingResponse(
        io.BytesIO(data),
        media_type=mime,
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''{0}".format(quote(filename)),
            "Content-Length": str(len(data)),
        },
    )
